import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatWithMessages, Message } from '@aim/shared';
import { REFLECTION_JSON_SCHEMA } from '@aim/shared';
import { MemoryStore } from '../memory-store.js';
import { Reflector, buildTranscript, needsTitle } from '../reflector.js';
import { FakeRunner, errResult, okResult, settingsOf, textResult } from './fakes.js';
import { openTestDb, type TestDb } from './test-db.js';

const msg = (role: Message['role'], text: string, tools: string[] = []): Message => ({
  id: `m_${Math.random().toString(16).slice(2)}`,
  chatId: 'c1',
  role,
  createdAt: Date.now(),
  content: [{ type: 'text', text }, ...tools.map((name) => ({ type: 'tool_use' as const, id: name, name, input: {} }))],
});

const chatOf = (title: string, messages: Message[]): ChatWithMessages => ({
  id: 'c1',
  title,
  createdAt: 1,
  updatedAt: 1,
  status: 'done',
  origin: 'user',
  messages,
  tasks: [],
  agents: [],
});

describe('Reflector', () => {
  let db: TestDb;
  let memory: MemoryStore;
  beforeEach(() => {
    db = openTestDb();
    memory = new MemoryStore(db);
  });
  afterEach(() => db.close());

  const turn = [
    msg('user', 'Please always use Edge instead of Chrome when you open websites for me, and clear my Outlook inbox every morning.'),
    msg('assistant', 'Understood. I will use Microsoft Edge for browsing and clear the Outlook inbox each morning. I opened Edge and archived 12 newsletters.', ['mcp__aim__browser_open_tab', 'mcp__aim__browser_click']),
  ];

  it('extracts memories with the haiku model and proposes a title for untitled chats', async () => {
    const runner = new FakeRunner(() =>
      okResult({
        memories: [
          { key: 'preferred_browser', value: 'Use Microsoft Edge, not Chrome', kind: 'preference', confidence: 0.95 },
          { key: 'inbox_routine', value: 'Clear the Outlook inbox every morning', kind: 'procedure', confidence: 0.8 },
          { key: 'guess', value: 'maybe likes cats', kind: 'fact', confidence: 0.1 },
          { key: '', value: 'no key', kind: 'fact', confidence: 0.9 },
        ],
        chatTitle: 'Browser preference and inbox routine',
      }),
    );
    const r = new Reflector({ runner, memory, settings: settingsOf() });
    const res = await r.reflect(chatOf('New chat', turn), turn);

    expect(runner.calls).toHaveLength(1);
    const { prompt, opts } = runner.calls[0];
    expect(opts.model).toBe('haiku');
    expect(opts.jsonSchema).toBe(REFLECTION_JSON_SCHEMA);
    expect(opts.timeoutMs).toBe(90000);
    expect(prompt).toContain('User: Please always use Edge');
    expect(prompt).toContain('AIM used tools: browser_open_tab, browser_click');
    expect(prompt).toContain('chatTitle');

    expect(res.memories.map((m) => m.key)).toEqual(['preferred_browser', 'inbox_routine']);
    expect(res.memories[0].source).toBe('reflection');
    expect(res.chatTitle).toBe('Browser preference and inbox routine');
    expect(memory.count()).toBe(2);
    expect(memory.recall('edge')[0]?.key).toBe('preferred_browser');
  });

  it('does not ask for a title when the chat already has a real one', async () => {
    const runner = new FakeRunner(() => okResult({ memories: [], chatTitle: 'Ignored' }));
    const res = await new Reflector({ runner, memory, settings: settingsOf() }).reflect(chatOf('Inbox automation', turn), turn);
    expect(runner.calls[0].prompt).not.toContain('chatTitle');
    expect(res.chatTitle).toBeUndefined();
    expect(needsTitle(chatOf('Please always use Edge instead…', turn))).toBe(true); // derived from first message
    expect(needsTitle(chatOf('Inbox automation', turn))).toBe(false);
  });

  it('skips when disabled, when there is no assistant message, or when the turn is tiny', async () => {
    const runner = new FakeRunner(() => okResult({ memories: [{ key: 'k', value: 'v', kind: 'fact', confidence: 1 }] }));
    const off = new Reflector({ runner, memory, settings: settingsOf({ reflectionEnabled: false }) });
    expect(await off.reflect(chatOf('New chat', turn), turn)).toEqual({ memories: [] });
    const on = new Reflector({ runner, memory, settings: settingsOf() });
    expect(await on.reflect(chatOf('New chat', turn), [turn[0]])).toEqual({ memories: [] });
    const tiny = [msg('user', 'hi'), msg('assistant', 'Hello.')];
    expect(await on.reflect(chatOf('New chat', tiny), tiny)).toEqual({ memories: [] });
    expect(runner.calls).toHaveLength(0);
    expect(memory.count()).toBe(0);
  });

  it('tolerates runner errors, garbage output and JSON in text', async () => {
    const bad = new Reflector({ runner: new FakeRunner(() => errResult('timeout')), memory, settings: settingsOf() });
    expect(await bad.reflect(chatOf('New chat', turn), turn)).toEqual({ memories: [] });
    const garbage = new Reflector({ runner: new FakeRunner(() => textResult('nothing to see')), memory, settings: settingsOf() });
    expect(await garbage.reflect(chatOf('New chat', turn), turn)).toEqual({ memories: [] });
    const text = new Reflector({
      runner: new FakeRunner(() => textResult('{"memories":[{"key":"os","value":"Windows 11","kind":"fact","confidence":0.7}]}')),
      memory,
      settings: settingsOf(),
    });
    const res = await text.reflect(chatOf('New chat', turn), turn);
    expect(res.memories.map((m) => m.key)).toEqual(['os']);
  });

  it('buildTranscript truncates long turns to about 8000 chars', () => {
    const long = [msg('user', 'a'.repeat(6000)), msg('assistant', 'b'.repeat(6000))];
    const t = buildTranscript(long);
    expect(t.chars).toBe(12000);
    expect(t.text.length).toBeLessThanOrEqual(8100);
    expect(t.text).toContain('omitted');
    expect(t.text.startsWith('User: aaa')).toBe(true);
    expect(t.text.endsWith('bbb')).toBe(true);
  });
});

import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { ChatStore, toFtsQuery } from '../chat-store.js';
import { hasMessageFts, openDatabase } from '../db.js';
import { makeTmpDir, quietLogs } from './helpers.js';

describe('ChatStore', () => {
  let db: Database.Database;
  let store: ChatStore;

  beforeEach(() => {
    const dir = makeTmpDir();
    quietLogs(dir);
    db = openDatabase(path.join(dir, 'aim.db'));
    store = new ChatStore(db);
  });
  afterEach(() => db.close());

  it('opens idempotently with WAL and FTS', () => {
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(hasMessageFts(db)).toBe(true);
    const again = openDatabase(db.name);
    expect(again.prepare('SELECT value FROM meta WHERE key = ?').get('chat_schema_version')).toEqual({ value: '1' });
    again.close();
  });

  it('creates, lists, updates and deletes chats', () => {
    const c = store.createChat({ title: '  ' });
    expect(c.title).toBe('New chat');
    expect(c.origin).toBe('user');
    expect(store.listChats()).toHaveLength(1);
    const u = store.updateChat(c.id, { title: 'Renamed', pinned: true, sessionId: 'sess-1' });
    expect(u.title).toBe('Renamed');
    const got = store.getChat(c.id)!;
    expect(got.pinned).toBe(true);
    expect(got.sessionId).toBe('sess-1');
    expect(got.messages).toEqual([]);
    store.updateChat(c.id, { archived: true });
    expect(store.listChats()).toHaveLength(0);
    expect(store.listChats({ includeArchived: true })).toHaveLength(1);
    store.deleteChat(c.id);
    expect(store.getChat(c.id)).toBeNull();
    expect(() => store.updateChat(c.id, { title: 'x' })).toThrow(/not found/);
  });

  it('persists messages with JSON content and preview, cascades on delete', () => {
    const c = store.createChat({ title: 'Msgs' });
    store.appendMessage({ id: 'm1', chatId: c.id, role: 'user', content: [{ type: 'text', text: 'Hello there' }], createdAt: 1 });
    store.appendMessage({
      id: 'm2',
      chatId: c.id,
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'mcp__aim__screen_capture', input: {}, result: { ok: true, summary: 'screen_capture → 1920×1080' } }],
      createdAt: 2,
      usage: { costUsd: 0.01 },
    });
    const got = store.getChat(c.id)!;
    expect(got.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(got.messages[1].usage).toEqual({ costUsd: 0.01 });
    expect((got.messages[1].content[0] as { result: unknown }).result).toEqual({ ok: true, summary: 'screen_capture → 1920×1080' });
    expect(got.lastMessagePreview).toBe('screen_capture');

    store.updateMessage({ ...got.messages[1], content: [{ type: 'text', text: 'Final answer' }] });
    expect(store.getChat(c.id)!.lastMessagePreview).toBe('Final answer');
    // updateMessage on an unknown id inserts
    store.updateMessage({ id: 'm3', chatId: c.id, role: 'assistant', content: [{ type: 'text', text: 'late' }], createdAt: 3 });
    expect(store.getMessages(c.id)).toHaveLength(3);

    store.deleteChat(c.id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM messages_fts').get()).toEqual({ n: 0 });
  });

  it('stores tasks and computes progress', () => {
    const c = store.createChat({ title: 'Tasks' });
    const now = Date.now();
    store.setTasks(c.id, [
      { id: '', chatId: c.id, title: 'A', state: 'done', order: 0, createdAt: now, updatedAt: now },
      { id: '', chatId: c.id, title: 'B', state: 'in_progress', order: 1, createdAt: now, updatedAt: now, detail: 'opening' },
      { id: '', chatId: c.id, title: 'C', state: 'pending', order: 2, createdAt: now, updatedAt: now },
    ]);
    const tasks = store.getTasks(c.id);
    expect(tasks.map((t) => t.title)).toEqual(['A', 'B', 'C']);
    expect(tasks[1].detail).toBe('opening');
    expect(tasks.every((t) => t.id.startsWith('task_'))).toBe(true);
    const listed = store.listChats()[0];
    expect(listed.progress).toMatchObject({ total: 3, done: 1, inProgress: 1, ratio: 0.5, label: '1 / 3 — B' });
    expect(store.getChat(c.id)!.tasks).toHaveLength(3);
    store.setTasks(c.id, []);
    expect(store.getTasks(c.id)).toEqual([]);
  });

  it('upserts agents', () => {
    const c = store.createChat({ title: 'Agents' });
    store.upsertAgent({ id: 'a1', chatId: c.id, role: 'researcher', name: 'Researcher', state: 'spawning', startedAt: 1, task: 'look' });
    store.upsertAgent({ id: 'a1', chatId: c.id, role: 'researcher', name: 'Researcher', state: 'done', startedAt: 1, endedAt: 5, lastActivity: 'WebSearch' });
    const agents = store.getAgents(c.id);
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ state: 'done', endedAt: 5, lastActivity: 'WebSearch' });
    expect(agents[0].task).toBeUndefined();
  });

  it('searches titles and message text (FTS)', () => {
    const a = store.createChat({ title: 'Quarterly report' });
    const b = store.createChat({ title: 'Other' });
    store.appendMessage({ id: 'm1', chatId: b.id, role: 'user', content: [{ type: 'text', text: 'Please book a dentist appointment' }], createdAt: 1 });
    expect(store.search('quarterly').map((c) => c.id)).toEqual([a.id]);
    expect(store.search('dentist').map((c) => c.id)).toEqual([b.id]);
    expect(store.search('denti').map((c) => c.id)).toEqual([b.id]); // prefix
    expect(store.search('"weird" AND (query')).toEqual([]); // no throw on odd input
    expect(store.search('   ')).toEqual([]);
    expect(toFtsQuery('hello wor*ld "x"')).toBe('"hello"* "world"* "x"*');
  });

  it('falls back to LIKE search when FTS is unavailable', () => {
    db.exec('DROP TRIGGER messages_fts_ai; DROP TRIGGER messages_fts_ad; DROP TRIGGER messages_fts_au; DROP TABLE messages_fts;');
    const plain = new ChatStore(db);
    const c = plain.createChat({ title: 'Plain' });
    plain.appendMessage({ id: 'm1', chatId: c.id, role: 'user', content: [{ type: 'text', text: 'find the invoice from 2024' }], createdAt: 1 });
    expect(plain.search('invoice').map((x) => x.id)).toEqual([c.id]);
    expect(plain.search('100%')).toEqual([]);
  });
});

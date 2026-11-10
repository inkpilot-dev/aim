import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import type { ChatStreamEvent, ChatWithMessages, Message, Settings, ToolUseBlock } from '@aim/shared';
import { ChatService, NO_ANSWER_TEXT } from '../chat-service.js';
import { ChatStore } from '../chat-store.js';
import { openDatabase } from '../db.js';
import { fakeBridge, makeTmpDir, quietLogs, testSettings, waitFor } from './helpers.js';

const dir = makeTmpDir();
quietLogs(dir);

describe('ChatService (end-to-end with fake CLI)', () => {
  let db: Database.Database;
  let store: ChatStore;
  let svc: ChatService;
  let events: ChatStreamEvent[];
  let settings: Settings;
  let completed: { chat: ChatWithMessages; turn: Message[] }[];
  let mcpCalls: string[];

  beforeEach(() => {
    db = openDatabase(path.join(dir, `svc-${Math.random().toString(36).slice(2)}.db`));
    store = new ChatStore(db);
    events = [];
    completed = [];
    mcpCalls = [];
    settings = testSettings();
    svc = new ChatService({
      store,
      cli: fakeBridge(),
      settings: () => settings,
      buildMcpConfig: (chatId) => {
        mcpCalls.push(chatId);
        return JSON.stringify({ mcpServers: { aim: { command: 'node', args: ['x'] } } });
      },
      memoryDigest: async () => 'User prefers Edge.',
      behaviorDigest: async () => 'Active in VS Code.',
      extensionConnected: () => true,
      onTurnComplete: (chat, turn) => {
        completed.push({ chat, turn });
      },
    });
    svc.on((e) => events.push(e));
  });
  afterEach(() => {
    svc.dispose();
    db.close();
  });

  const statusOf = (chatId: string) => store.getChatSummary(chatId)?.status;
  const idle = (chatId: string) => waitFor(() => !svc.isBusy(chatId) && statusOf(chatId) !== 'thinking' && statusOf(chatId) !== 'working', 15_000, 'turn end');

  it('runs a turn: user message → streamed text → result → persisted', async () => {
    const chat = svc.createChat({ cwd: dir });
    expect(chat.title).toBe('New chat');
    await svc.sendMessage({ chatId: chat.id, text: 'Hello AIM, please summarise my day in detail and more words here than fit', attachments: [{ kind: 'image', name: 's.png', mediaType: 'image/png', dataBase64: 'AAAA' }] });
    expect(svc.isBusy(chat.id)).toBe(true);
    await idle(chat.id);

    const titled = events.find((e) => e.type === 'title') as { title: string };
    expect(titled.title.length).toBeLessThanOrEqual(60);
    expect(titled.title.startsWith('Hello AIM')).toBe(true);

    const types = events.map((e) => e.type);
    expect(types).toContain('message.start');
    expect(types).toContain('message.delta');
    expect(types).toContain('message.end');
    const statuses = events.filter((e) => e.type === 'status').map((e) => (e as { status: string }).status);
    expect(statuses[0]).toBe('thinking');
    expect(statuses.at(-1)).toBe('idle');

    const deltas = events.filter((e): e is Extract<ChatStreamEvent, { type: 'message.delta' }> => e.type === 'message.delta').map((e) => e.delta.text).join('');
    expect(deltas).toBe('Echo: Hello AIM, please summarise my day in detail and more words here than fit [1 image(s)]');

    const full = store.getChat(chat.id)!;
    expect(full.messages).toHaveLength(2);
    expect(full.messages[0].role).toBe('user');
    expect(full.messages[0].content.map((b) => b.type)).toEqual(['text', 'image']);
    const assistant = full.messages[1];
    expect(assistant.role).toBe('assistant');
    expect(assistant.content).toEqual([{ type: 'text', text: deltas }]);
    expect(assistant.usage).toMatchObject({ costUsd: 0.002, inputTokens: 20, outputTokens: 7 });
    expect(full.sessionId).toMatch(/[0-9a-f-]{36}/);
    expect(full.status).toBe('idle');
    expect(completed).toHaveLength(1);
    expect(completed[0].turn.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(mcpCalls).toEqual([chat.id]);
    expect(events.some((e) => e.type === 'chat.updated')).toBe(true);
  }, 20_000);

  it('attaches tool results (with image thumbnails) to tool_use blocks', async () => {
    const chat = svc.createChat({ cwd: dir });
    await svc.sendMessage({ chatId: chat.id, text: 'TOOL please' });
    await idle(chat.id);
    const assistant = store.getChat(chat.id)!.messages[1];
    const tool = assistant.content.find((b): b is ToolUseBlock => b.type === 'tool_use')!;
    expect(tool.name).toBe('mcp__aim__screen_capture');
    expect(tool.result).toMatchObject({ ok: true, summary: 'screen_capture → 1920×1080', imageBase64: 'iVBORw0KGgo=' });
    expect(assistant.content.at(-1)).toEqual({ type: 'text', text: 'Screenshot taken.' });
    const blockEvents = events.filter((e) => e.type === 'message.block');
    expect(blockEvents.length).toBeGreaterThanOrEqual(2);
    const statuses = events.filter((e) => e.type === 'status').map((e) => (e as { status: string }).status);
    expect(statuses).toContain('working');
  }, 20_000);

  it('merges the real CLI event order without duplicating text or tool blocks', async () => {
    const chat = svc.createChat({ cwd: dir });
    await svc.sendMessage({ chatId: chat.id, text: 'REALORDER weather' });
    await idle(chat.id);
    const assistant = store.getChat(chat.id)!.messages[1];
    expect(assistant.content.map((b) => b.type)).toEqual(['text', 'tool_use', 'text']);
    expect(assistant.content[0]).toEqual({ type: 'text', text: 'Loading the search tool.' });
    const tool = assistant.content[1] as ToolUseBlock;
    expect(tool.id).toBe('tu_ts1');
    expect(tool.input).toEqual({ query: 'select:WebSearch' });
    expect(tool.result?.ok).toBe(true);
    expect(tool.result?.summary).toMatch(/WebSearch/);
    expect(assistant.content[2]).toEqual({ type: 'text', text: 'It is 24 °C and sunny.' });
    const deltas = events.filter((e): e is Extract<ChatStreamEvent, { type: 'message.delta' }> => e.type === 'message.delta' && e.chatId === chat.id);
    // The late delta for the finalised first block must not have been applied.
    expect(deltas.map((d) => d.delta.text).filter(Boolean)).toEqual(['Loading the ', 'It is 24 °C and sunny.']);
  }, 20_000);

  it('mirrors sub-agents and resumes the session on the next turn', async () => {
    const chat = svc.createChat({ cwd: dir });
    await svc.sendMessage({ chatId: chat.id, text: 'AGENT work' });
    await idle(chat.id);
    const agents = svc.getAgents(chat.id);
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ role: 'researcher', state: 'done', task: 'Find docs', lastActivity: 'WebSearch "docs"' });
    expect(events.filter((e) => e.type === 'agents').length).toBeGreaterThanOrEqual(2);
    const sid = store.getChatSummary(chat.id)!.sessionId;

    await svc.sendMessage({ chatId: chat.id, text: 'second' });
    await idle(chat.id);
    const msgs = store.getChat(chat.id)!.messages;
    expect(msgs).toHaveLength(4);
    expect(msgs[3].content[0]).toEqual({ type: 'text', text: 'Echo: second [resumed]' });
    expect(store.getChatSummary(chat.id)!.sessionId).toBe(sid);
  }, 20_000);

  it('self-heals a failed turn and recovers', async () => {
    const chat = svc.createChat({ cwd: dir });
    await svc.sendMessage({ chatId: chat.id, text: 'FAIL this' });
    await idle(chat.id);
    const heal = events.filter((e): e is Extract<ChatStreamEvent, { type: 'self_heal' }> => e.type === 'self_heal');
    expect(heal).toHaveLength(1);
    expect(heal[0]).toMatchObject({ attempt: 1, max: 2 });
    expect(heal[0].error).toContain('Tool exploded');
    expect(events.some((e) => e.type === 'error')).toBe(false);
    const msgs = store.getChat(chat.id)!.messages;
    expect(msgs).toHaveLength(3); // user, failed assistant (with status block), repaired assistant
    expect(msgs[1].content.some((b) => b.type === 'status' && b.text.startsWith('Self-repair attempt 1/2'))).toBe(true);
    expect(msgs[2].content).toEqual([{ type: 'text', text: 'Recovered' }]);
    expect(statusOf(chat.id)).toBe('idle');
    expect(completed).toHaveLength(1);
    expect(completed[0].turn).toHaveLength(3);
  }, 20_000);

  it('gives up after max attempts: error event + waiting_user', async () => {
    settings = testSettings({ maxSelfHealAttempts: 0 });
    const chat = svc.createChat({ cwd: dir });
    await svc.sendMessage({ chatId: chat.id, text: 'CRASH' });
    await idle(chat.id);
    const err = events.find((e): e is Extract<ChatStreamEvent, { type: 'error' }> => e.type === 'error')!;
    expect(err.error).toMatch(/exit code 3/);
    expect(err.recoverable).toBe(false);
    expect(statusOf(chat.id)).toBe('waiting_user');
    expect(events.filter((e) => e.type === 'self_heal')).toHaveLength(0);
    expect(completed).toHaveLength(0);
  }, 20_000);

  it('queues messages while a turn is running', async () => {
    const chat = svc.createChat({ cwd: dir });
    await svc.sendMessage({ chatId: chat.id, text: 'one' });
    await svc.sendMessage({ chatId: chat.id, text: 'two' });
    expect(svc.isBusy(chat.id)).toBe(true);
    await waitFor(() => store.getChat(chat.id)!.messages.length === 4 && !svc.isBusy(chat.id), 15_000, 'both turns');
    const msgs = store.getChat(chat.id)!.messages;
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    const texts = msgs.filter((m) => m.role === 'assistant').map((m) => (m.content[0] as { text: string }).text);
    expect(texts).toEqual(['Echo: one', 'Echo: two [resumed]']);
  }, 20_000);

  it('stop() aborts the turn and leaves the chat idle', async () => {
    const chat = svc.createChat({ cwd: dir });
    await svc.sendMessage({ chatId: chat.id, text: 'SLOW' });
    await new Promise((r) => setTimeout(r, 150));
    await svc.stop(chat.id);
    expect(svc.isBusy(chat.id)).toBe(false);
    expect(statusOf(chat.id)).toBe('idle');
    const assistant = store.getChat(chat.id)!.messages[1];
    expect(assistant.content.some((b) => b.type === 'status' && /Stopped/.test(b.text))).toBe(true);
    expect(events.some((e) => e.type === 'error')).toBe(false);
  }, 20_000);

  it('stop() during turn set-up spawns nothing', async () => {
    const chat = svc.createChat({ cwd: dir });
    await svc.sendMessage({ chatId: chat.id, text: 'SLOW' });
    await svc.stop(chat.id); // before the system prompt finished building
    expect(svc.isBusy(chat.id)).toBe(false);
    expect(statusOf(chat.id)).toBe('idle');
    await new Promise((r) => setTimeout(r, 100));
    expect(statusOf(chat.id)).toBe('idle');
  }, 20_000);

  it('tasks, progress and ask_user callbacks', async () => {
    const chat = svc.createChat({ cwd: dir });
    const p = svc.setTasks(chat.id, [{ title: 'Open Edge' }, { title: 'Log in', state: 'in_progress' }, { title: 'Export' }]);
    expect(p).toMatchObject({ total: 3, done: 0, inProgress: 1 });
    const p2 = svc.updateTask(chat.id, { index: 1 }, { state: 'done' });
    expect(p2.done).toBe(1);
    const p3 = svc.updateTask(chat.id, { title: 'export' }, { state: 'in_progress', detail: 'CSV' });
    expect(p3.label).toBe('1 / 3 — Export');
    expect(store.getTasks(chat.id)[2].detail).toBe('CSV');
    expect(() => svc.updateTask(chat.id, { index: 9 }, { state: 'done' })).toThrow(/not found/);
    const taskEvents = events.filter((e) => e.type === 'tasks');
    expect(taskEvents).toHaveLength(3);
    expect(store.listChats()[0].progress?.total).toBe(3);

    const answerP = svc.askUser(chat.id, 'Which account?', ['Work', 'Personal']);
    const ask = events.find((e): e is Extract<ChatStreamEvent, { type: 'ask_user' }> => e.type === 'ask_user')!;
    expect(ask.question).toBe('Which account?');
    expect(statusOf(chat.id)).toBe('waiting_user');
    svc.answerQuestion(chat.id, ask.requestId, 'Work');
    expect(await answerP).toBe('Work');
    expect(events.some((e) => e.type === 'ask_user.resolved')).toBe(true);
    svc.answerQuestion(chat.id, 'unknown', 'ignored'); // no throw

    const timed = await svc.askUser(chat.id, 'Still there?', undefined, 1_000);
    expect(timed).toBe(NO_ANSWER_TEXT);
  }, 20_000);

  it('spawnWorker returns the worker result', async () => {
    const chat = svc.createChat({ cwd: dir });
    const r = await svc.spawnWorker(chat.id, { role: 'researcher', name: 'Scout', task: 'look around' });
    expect(r.ok).toBe(true);
    expect(r.result).toContain('look around');
    expect(svc.getAgents(chat.id)[0]).toMatchObject({ name: 'Scout', state: 'done' });
    await expect(svc.spawnWorker('nope', { role: 'coder', name: 'x', task: 'y' })).rejects.toThrow(/not found/);
  }, 20_000);

  it('chat management helpers', () => {
    const chat = svc.createChat({ title: 'Manage' });
    svc.renameChat(chat.id, 'Renamed');
    svc.setPinned(chat.id, true);
    svc.setArchived(chat.id, true);
    expect(store.getChatSummary(chat.id)).toMatchObject({ title: 'Renamed', pinned: true, archived: true });
    expect(svc.listChats()).toHaveLength(0);
    expect(svc.search('Renamed')).toHaveLength(1);
    svc.deleteChat(chat.id);
    expect(svc.getChat(chat.id)).toBeNull();
    expect(events.some((e) => e.type === 'chat.deleted')).toBe(true);
  });
});

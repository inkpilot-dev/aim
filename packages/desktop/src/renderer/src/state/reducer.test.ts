import { describe, expect, it } from 'vitest';
import type { Chat, ChatWithMessages, Message } from '@aim/shared';
import { initialState, reducer, type UiState } from './reducer';

const NOW = 1_700_000_000_000;

function chat(id: string, extra: Partial<Chat> = {}): Chat {
  return { id, title: id, createdAt: NOW, updatedAt: NOW, status: 'idle', origin: 'user', ...extra };
}

function full(id: string, messages: Message[] = []): ChatWithMessages {
  return { ...chat(id), messages, tasks: [], agents: [] };
}

function withCurrent(id = 'c1', messages: Message[] = []): UiState {
  let s = reducer(initialState, { type: 'chats.set', chats: [chat('c1'), chat('c2')] });
  s = reducer(s, { type: 'chat.select', chatId: id });
  s = reducer(s, { type: 'chat.loaded', chat: full(id, messages) });
  return s;
}

describe('reducer: chat selection and metadata', () => {
  it('selects and loads a chat', () => {
    const s = withCurrent();
    expect(s.currentChatId).toBe('c1');
    expect(s.current?.id).toBe('c1');
    expect(s.currentLoading).toBe(false);
  });

  it('ignores a load for a chat that is no longer selected', () => {
    let s = reducer(initialState, { type: 'chat.select', chatId: 'c1' });
    s = reducer(s, { type: 'chat.select', chatId: 'c2' });
    s = reducer(s, { type: 'chat.loaded', chat: full('c1') });
    expect(s.current).toBeNull();
    expect(s.currentLoading).toBe(true);
  });

  it('keeps streamed messages that the persisted copy does not have yet', () => {
    let s = reducer(initialState, { type: 'chat.select', chatId: 'c1' });
    s = reducer(s, { type: 'chat.loaded', chat: full('c1') });
    const streamed: Message = { id: 'a1', chatId: 'c1', role: 'assistant', content: [{ type: 'text', text: 'x' }], createdAt: NOW + 5 };
    const local: Message = { id: 'local-9', chatId: 'c1', role: 'user', content: [{ type: 'text', text: 'q' }], createdAt: NOW + 1 };
    s = reducer(s, { type: 'message.local', message: local });
    s = reducer(s, { type: 'chatEvent', event: { type: 'message.start', chatId: 'c1', message: streamed } });
    const persistedUser: Message = { ...local, id: 'u1' };
    s = reducer(s, { type: 'chat.loaded', chat: full('c1', [persistedUser]) });
    expect(s.current!.messages.map((m) => m.id)).toEqual(['u1', 'a1']);
  });

  it('merges chat.updated metadata without touching messages', () => {
    const m: Message = { id: 'm1', chatId: 'c1', role: 'user', content: [{ type: 'text', text: 'hi' }], createdAt: NOW };
    let s = withCurrent('c1', [m]);
    s = reducer(s, { type: 'chatEvent', event: { type: 'chat.updated', chat: chat('c1', { title: 'Renamed', pinned: true, updatedAt: NOW + 1 }) } });
    expect(s.current?.title).toBe('Renamed');
    expect(s.current?.pinned).toBe(true);
    expect(s.current?.messages).toEqual([m]);
    expect(s.chats.find((c) => c.id === 'c1')?.title).toBe('Renamed');
  });

  it('removes a deleted chat and clears the view when it was open', () => {
    let s = withCurrent('c1');
    s = reducer(s, { type: 'chatEvent', event: { type: 'chat.deleted', chatId: 'c1' } });
    expect(s.currentChatId).toBeNull();
    expect(s.current).toBeNull();
    expect(s.chats.map((c) => c.id)).toEqual(['c2']);
  });

  it('applies status, title and tasks events to list and current chat', () => {
    let s = withCurrent('c1');
    s = reducer(s, { type: 'chatEvent', event: { type: 'status', chatId: 'c1', status: 'working' } });
    s = reducer(s, { type: 'chatEvent', event: { type: 'title', chatId: 'c2', title: 'Other' } });
    const progress = { total: 2, done: 1, failed: 0, inProgress: 1, ratio: 0.75, label: '1 / 2 — x' };
    s = reducer(s, { type: 'chatEvent', event: { type: 'tasks', chatId: 'c1', tasks: [], progress } });
    expect(s.current?.status).toBe('working');
    expect(s.chats.find((c) => c.id === 'c2')?.title).toBe('Other');
    expect(s.current?.progress).toEqual(progress);
    expect(s.chats.find((c) => c.id === 'c1')?.progress).toEqual(progress);
  });
});

describe('reducer: streaming', () => {
  const start: Message = { id: 'a1', chatId: 'c1', role: 'assistant', content: [], createdAt: NOW };

  it('builds a message from start, deltas, blocks and end', () => {
    let s = withCurrent();
    s = reducer(s, { type: 'chatEvent', event: { type: 'message.start', chatId: 'c1', message: start } });
    s = reducer(s, { type: 'chatEvent', event: { type: 'message.delta', chatId: 'c1', messageId: 'a1', blockIndex: 0, delta: { text: 'Hel' } } });
    s = reducer(s, { type: 'chatEvent', event: { type: 'message.delta', chatId: 'c1', messageId: 'a1', blockIndex: 0, delta: { text: 'lo' } } });
    s = reducer(s, {
      type: 'chatEvent',
      event: { type: 'message.block', chatId: 'c1', messageId: 'a1', blockIndex: 1, block: { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } } },
    });
    s = reducer(s, {
      type: 'chatEvent',
      event: { type: 'message.block', chatId: 'c1', messageId: 'a1', blockIndex: 1, block: { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' }, result: { ok: true, summary: '3 files' } } },
    });
    s = reducer(s, { type: 'chatEvent', event: { type: 'message.delta', chatId: 'c1', messageId: 'a1', blockIndex: 2, delta: { thinking: 'hmm' } } });
    const m = s.current!.messages[0];
    expect(m.content[0]).toEqual({ type: 'text', text: 'Hello' });
    expect(m.content[1]).toMatchObject({ type: 'tool_use', result: { ok: true, summary: '3 files' } });
    expect(m.content[2]).toEqual({ type: 'thinking', text: 'hmm' });

    const final: Message = { ...start, content: [{ type: 'text', text: 'Hello!' }], usage: { costUsd: 0.01 } };
    s = reducer(s, { type: 'chatEvent', event: { type: 'message.end', chatId: 'c1', message: final } });
    expect(s.current!.messages).toEqual([final]);
    expect(s.chats.find((c) => c.id === 'c1')?.lastMessagePreview).toBe('Hello!');
  });

  it('ignores partialJson deltas and deltas for other chats', () => {
    let s = withCurrent();
    s = reducer(s, { type: 'chatEvent', event: { type: 'message.start', chatId: 'c1', message: start } });
    const before = s;
    s = reducer(s, { type: 'chatEvent', event: { type: 'message.delta', chatId: 'c1', messageId: 'a1', blockIndex: 0, delta: { partialJson: '{"a":' } } });
    expect(s).toBe(before);
    s = reducer(s, { type: 'chatEvent', event: { type: 'message.delta', chatId: 'c2', messageId: 'zz', blockIndex: 0, delta: { text: 'x' } } });
    expect(s.current!.messages).toHaveLength(1);
  });

  it('creates a message when a delta arrives before its start event', () => {
    let s = withCurrent();
    s = reducer(s, { type: 'chatEvent', event: { type: 'message.delta', chatId: 'c1', messageId: 'late', blockIndex: 0, delta: { text: 'x' } } });
    expect(s.current!.messages[0]).toMatchObject({ id: 'late', role: 'assistant', content: [{ type: 'text', text: 'x' }] });
  });

  it('replaces an optimistic local user message with the backend echo', () => {
    let s = withCurrent();
    const local: Message = { id: 'local-1', chatId: 'c1', role: 'user', content: [{ type: 'text', text: 'do it' }], createdAt: NOW };
    s = reducer(s, { type: 'message.local', message: local });
    const echo: Message = { ...local, id: 'u1' };
    s = reducer(s, { type: 'chatEvent', event: { type: 'message.start', chatId: 'c1', message: echo } });
    s = reducer(s, { type: 'chatEvent', event: { type: 'message.end', chatId: 'c1', message: echo } });
    expect(s.current!.messages.map((m) => m.id)).toEqual(['u1']);
  });

  it('tracks questions per chat and clears them on resolve', () => {
    let s = withCurrent();
    s = reducer(s, { type: 'chatEvent', event: { type: 'ask_user', chatId: 'c2', requestId: 'q1', question: 'Which?', options: ['a', 'b'] } });
    s = reducer(s, { type: 'chatEvent', event: { type: 'ask_user', chatId: 'c2', requestId: 'q1', question: 'Which?' } });
    expect(s.questions).toHaveLength(1);
    expect(s.questions[0].chatId).toBe('c2');
    s = reducer(s, { type: 'chat.select', chatId: 'c2' });
    expect(s.questions).toHaveLength(1);
    s = reducer(s, { type: 'chatEvent', event: { type: 'ask_user.resolved', chatId: 'c2', requestId: 'q1' } });
    expect(s.questions).toHaveLength(0);
  });

  it('records self-heal and error notices for the open chat only', () => {
    let s = withCurrent();
    s = reducer(s, { type: 'chatEvent', event: { type: 'self_heal', chatId: 'c1', attempt: 1, max: 3, error: 'boom' } });
    s = reducer(s, { type: 'chatEvent', event: { type: 'error', chatId: 'c2', error: 'other', recoverable: false } });
    expect(s.notices).toHaveLength(1);
    expect(s.notices[0].text).toContain('1 of 3');
    s = reducer(s, { type: 'notices.clear' });
    expect(s.notices).toHaveLength(0);
  });
});

describe('reducer: global events', () => {
  it('handles toasts, health, settings and version bumps', () => {
    let s = initialState;
    s = reducer(s, { type: 'globalEvent', event: { type: 'toast', level: 'info', title: 'Hi' } });
    expect(s.toasts).toHaveLength(1);
    s = reducer(s, { type: 'toast.remove', id: s.toasts[0].id });
    expect(s.toasts).toHaveLength(0);
    s = reducer(s, { type: 'globalEvent', event: { type: 'memory.updated', count: 3 } });
    s = reducer(s, { type: 'globalEvent', event: { type: 'goals.updated', goals: [] } });
    s = reducer(s, { type: 'globalEvent', event: { type: 'directives.updated', directives: [] } });
    expect(s.memoryVersion).toBe(1);
    expect(s.goalsVersion).toBe(2);
  });

  it('caps toasts at five', () => {
    let s = initialState;
    for (let i = 0; i < 7; i++) s = reducer(s, { type: 'globalEvent', event: { type: 'toast', level: 'info', title: String(i) } });
    expect(s.toasts).toHaveLength(5);
    expect(s.toasts[0].title).toBe('2');
  });
});

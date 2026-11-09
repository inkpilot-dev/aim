import type {
  AppHealth,
  Chat,
  ChatStreamEvent,
  ChatWithMessages,
  ContentBlock,
  GlobalEvent,
  Message,
  Settings,
  UpdateStatus,
} from '@aim/shared';

export type View = 'chats' | 'goals' | 'memory' | 'settings';

export interface PendingQuestion {
  chatId: string;
  requestId: string;
  question: string;
  options?: string[];
}

export interface Notice {
  id: string;
  kind: 'self_heal' | 'error' | 'info';
  text: string;
  at: number;
}

export interface Toast {
  id: string;
  level: 'info' | 'success' | 'warning' | 'error';
  title: string;
  body?: string;
}

export interface UiState {
  view: View;
  chats: Chat[];
  currentChatId: string | null;
  current: ChatWithMessages | null;
  currentLoading: boolean;
  questions: PendingQuestion[];
  notices: Notice[];
  settings: Settings | null;
  health: AppHealth | null;
  update: UpdateStatus | null;
  toasts: Toast[];
  sidebarCollapsed: boolean;
  agentsPanelOpen: boolean;
  /** Bumped on learning events so views can refetch. */
  goalsVersion: number;
  memoryVersion: number;
}

export type Action =
  | { type: 'view'; view: View }
  | { type: 'chats.set'; chats: Chat[] }
  | { type: 'chat.select'; chatId: string | null }
  | { type: 'chat.loading'; chatId: string }
  | { type: 'chat.loaded'; chat: ChatWithMessages }
  | { type: 'chat.loadFailed'; chatId: string }
  | { type: 'chat.upsert'; chat: Chat }
  | { type: 'chat.patch'; chatId: string; patch: Partial<Chat> }
  | { type: 'chat.remove'; chatId: string }
  | { type: 'message.local'; message: Message }
  | { type: 'settings.set'; settings: Settings }
  | { type: 'health.set'; health: AppHealth }
  | { type: 'toast.add'; toast: Toast }
  | { type: 'toast.remove'; id: string }
  | { type: 'sidebar.toggle' }
  | { type: 'sidebar.set'; collapsed: boolean }
  | { type: 'agents.toggle' }
  | { type: 'notices.clear' }
  | { type: 'chatEvent'; event: ChatStreamEvent }
  | { type: 'globalEvent'; event: GlobalEvent };

export const initialState: UiState = {
  view: 'chats',
  chats: [],
  currentChatId: null,
  current: null,
  currentLoading: false,
  questions: [],
  notices: [],
  settings: null,
  health: null,
  update: null,
  toasts: [],
  sidebarCollapsed: false,
  agentsPanelOpen: false,
  goalsVersion: 0,
  memoryVersion: 0,
};

let noticeSeq = 0;
export function nextId(prefix: string): string {
  noticeSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${noticeSeq}`;
}

const META_KEYS: (keyof Chat)[] = [
  'title',
  'updatedAt',
  'status',
  'sessionId',
  'cwd',
  'pinned',
  'archived',
  'origin',
  'goalId',
  'lastMessagePreview',
  'progress',
];

function pickMeta(chat: Chat): Partial<Chat> {
  const out: Partial<Chat> = {};
  for (const k of META_KEYS) {
    if (chat[k] !== undefined) (out as Record<string, unknown>)[k] = chat[k];
  }
  return out;
}

function upsertChat(chats: Chat[], chat: Chat): Chat[] {
  const idx = chats.findIndex((c) => c.id === chat.id);
  if (idx === -1) return [chat, ...chats];
  const next = chats.slice();
  next[idx] = { ...next[idx], ...chat };
  return next;
}

function patchChat(chats: Chat[], chatId: string, patch: Partial<Chat>): Chat[] {
  let changed = false;
  const next = chats.map((c) => {
    if (c.id !== chatId) return c;
    changed = true;
    return { ...c, ...patch };
  });
  return changed ? next : chats;
}

export function reducer(state: UiState, action: Action): UiState {
  switch (action.type) {
    case 'view':
      return state.view === action.view ? state : { ...state, view: action.view };
    case 'chats.set':
      return { ...state, chats: action.chats };
    case 'chat.select':
      if (action.chatId === state.currentChatId) return { ...state, view: 'chats' };
      return {
        ...state,
        view: 'chats',
        currentChatId: action.chatId,
        current: null,
        currentLoading: action.chatId !== null,
        notices: [],
      };
    case 'chat.loading':
      return state.currentChatId === action.chatId ? { ...state, currentLoading: true } : state;
    case 'chat.loaded': {
      if (state.currentChatId !== action.chat.id) return state;
      // Keep messages that streamed in while loading and are not yet in the persisted copy.
      let chat = action.chat;
      if (state.current && state.current.id === chat.id) {
        const known = new Set(chat.messages.map((m) => m.id));
        const extra = state.current.messages.filter((m) => !known.has(m.id) && !m.id.startsWith('local-'));
        if (extra.length) chat = { ...chat, messages: [...chat.messages, ...extra].sort((a, b) => a.createdAt - b.createdAt) };
      }
      return {
        ...state,
        current: chat,
        currentLoading: false,
        chats: upsertChat(state.chats, stripMessages(chat)),
      };
    }
    case 'chat.loadFailed':
      return state.currentChatId === action.chatId ? { ...state, currentLoading: false } : state;
    case 'chat.upsert':
      return { ...state, chats: upsertChat(state.chats, action.chat) };
    case 'chat.patch': {
      const chats = patchChat(state.chats, action.chatId, action.patch);
      const current = state.current && state.current.id === action.chatId ? { ...state.current, ...action.patch } : state.current;
      return { ...state, chats, current };
    }
    case 'chat.remove': {
      const chats = state.chats.filter((c) => c.id !== action.chatId);
      if (state.currentChatId === action.chatId) {
        return { ...state, chats, currentChatId: null, current: null, currentLoading: false, questions: state.questions.filter((q) => q.chatId !== action.chatId), notices: [] };
      }
      return { ...state, chats, questions: state.questions.filter((q) => q.chatId !== action.chatId) };
    }
    case 'message.local': {
      if (!state.current || state.current.id !== action.message.chatId) return state;
      return {
        ...state,
        current: { ...state.current, messages: [...state.current.messages, action.message] },
      };
    }
    case 'settings.set':
      return { ...state, settings: action.settings };
    case 'health.set':
      return { ...state, health: action.health };
    case 'toast.add':
      return { ...state, toasts: [...state.toasts, action.toast].slice(-5) };
    case 'toast.remove':
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) };
    case 'sidebar.toggle':
      return { ...state, sidebarCollapsed: !state.sidebarCollapsed };
    case 'sidebar.set':
      return { ...state, sidebarCollapsed: action.collapsed };
    case 'agents.toggle':
      return { ...state, agentsPanelOpen: !state.agentsPanelOpen };
    case 'notices.clear':
      return state.notices.length ? { ...state, notices: [] } : state;
    case 'chatEvent':
      return applyChatEvent(state, action.event);
    case 'globalEvent':
      return applyGlobalEvent(state, action.event);
    default:
      return state;
  }
}

function stripMessages(chat: ChatWithMessages): Chat {
  const { messages: _m, tasks: _t, agents: _a, ...rest } = chat;
  return rest;
}

function replaceMessage(messages: Message[], message: Message): Message[] {
  const idx = messages.findIndex((m) => m.id === message.id);
  if (idx !== -1) {
    const next = messages.slice();
    next[idx] = message;
    return next;
  }
  return [...messages, message];
}

/** Drop an optimistic local user message that the backend has now echoed. */
function dropLocalEcho(messages: Message[], incoming: Message): Message[] {
  if (incoming.role !== 'user') return messages;
  const incomingText = textOf(incoming.content);
  const idx = messages.findIndex((m) => m.id.startsWith('local-') && m.role === 'user' && textOf(m.content) === incomingText);
  if (idx === -1) return messages;
  return messages.filter((_, i) => i !== idx);
}

export function textOf(content: ContentBlock[]): string {
  return content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

function updateMessage(messages: Message[], messageId: string, fn: (m: Message) => Message): Message[] {
  const idx = messages.findIndex((m) => m.id === messageId);
  if (idx === -1) return messages;
  const updated = fn(messages[idx]);
  if (updated === messages[idx]) return messages;
  const next = messages.slice();
  next[idx] = updated;
  return next;
}

export function applyChatEvent(state: UiState, e: ChatStreamEvent): UiState {
  // Events that are not scoped to the current chat but affect the list.
  switch (e.type) {
    case 'chat.updated': {
      const chats = upsertChat(state.chats, e.chat);
      const current = state.current && state.current.id === e.chat.id ? { ...state.current, ...pickMeta(e.chat) } : state.current;
      return { ...state, chats, current };
    }
    case 'chat.deleted':
      return reducer(state, { type: 'chat.remove', chatId: e.chatId });
    case 'title': {
      const chats = patchChat(state.chats, e.chatId, { title: e.title });
      const current = state.current && state.current.id === e.chatId ? { ...state.current, title: e.title } : state.current;
      return { ...state, chats, current };
    }
    case 'status': {
      const chats = patchChat(state.chats, e.chatId, { status: e.status });
      const current = state.current && state.current.id === e.chatId ? { ...state.current, status: e.status } : state.current;
      // A settled turn (idle/done) means any self-repair succeeded; drop the transient repair notices.
      const settled = e.status === 'idle' || e.status === 'done';
      const notices = settled && state.current?.id === e.chatId ? state.notices.filter((n) => n.kind !== 'self_heal') : state.notices;
      return { ...state, chats, current, notices };
    }
    case 'ask_user': {
      if (state.questions.some((q) => q.requestId === e.requestId)) return state;
      return { ...state, questions: [...state.questions, { chatId: e.chatId, requestId: e.requestId, question: e.question, options: e.options }] };
    }
    case 'ask_user.resolved':
      return { ...state, questions: state.questions.filter((q) => q.requestId !== e.requestId) };
    case 'tasks': {
      const chats = patchChat(state.chats, e.chatId, { progress: e.progress });
      const current =
        state.current && state.current.id === e.chatId ? { ...state.current, tasks: e.tasks, progress: e.progress } : state.current;
      return { ...state, chats, current };
    }
    default:
      break;
  }

  const cur = state.current;
  if (!cur || cur.id !== e.chatId) {
    // Not the open chat: a few events still bump list metadata.
    if (e.type === 'message.end') {
      const preview = textOf(e.message.content).slice(0, 120);
      return { ...state, chats: patchChat(state.chats, e.chatId, { updatedAt: e.message.createdAt, ...(preview ? { lastMessagePreview: preview } : {}) }) };
    }
    return state;
  }

  switch (e.type) {
    case 'message.start': {
      const messages = replaceMessage(dropLocalEcho(cur.messages, e.message), e.message);
      return { ...state, current: { ...cur, messages } };
    }
    case 'message.delta': {
      const known = cur.messages.some((m) => m.id === e.messageId);
      const messages = updateMessage(cur.messages, e.messageId, (m) => {
        const content = m.content.slice();
        const existing = content[e.blockIndex];
        if (e.delta.text !== undefined) {
          if (existing && existing.type === 'text') content[e.blockIndex] = { ...existing, text: existing.text + e.delta.text };
          else if (!existing) content[e.blockIndex] = { type: 'text', text: e.delta.text };
          else return m; // delta for a non-text block: wait for the block event
        } else if (e.delta.thinking !== undefined) {
          if (existing && existing.type === 'thinking') content[e.blockIndex] = { ...existing, text: existing.text + e.delta.thinking };
          else if (!existing) content[e.blockIndex] = { type: 'thinking', text: e.delta.thinking };
          else return m;
        } else {
          // partialJson for tool inputs: the final block event carries the full input.
          return m;
        }
        return { ...m, content };
      });
      if (messages === cur.messages) {
        if (known) return state; // nothing to apply (e.g. partialJson)
        // Delta for an unknown message: start one so nothing is lost.
        const block: ContentBlock | null =
          e.delta.text !== undefined ? { type: 'text', text: e.delta.text } : e.delta.thinking !== undefined ? { type: 'thinking', text: e.delta.thinking } : null;
        if (!block) return state;
        const content: ContentBlock[] = [];
        content[e.blockIndex] = block;
        const msg: Message = { id: e.messageId, chatId: e.chatId, role: 'assistant', content, createdAt: Date.now() };
        return { ...state, current: { ...cur, messages: [...cur.messages, msg] } };
      }
      return { ...state, current: { ...cur, messages } };
    }
    case 'message.block': {
      let messages = updateMessage(cur.messages, e.messageId, (m) => {
        const content = m.content.slice();
        content[e.blockIndex] = e.block;
        return { ...m, content };
      });
      if (messages === cur.messages) {
        const content: ContentBlock[] = [];
        content[e.blockIndex] = e.block;
        messages = [...cur.messages, { id: e.messageId, chatId: e.chatId, role: 'assistant', content, createdAt: Date.now() }];
      }
      return { ...state, current: { ...cur, messages } };
    }
    case 'message.end': {
      const messages = replaceMessage(dropLocalEcho(cur.messages, e.message), e.message);
      const preview = textOf(e.message.content).slice(0, 120);
      return {
        ...state,
        current: { ...cur, messages, updatedAt: e.message.createdAt },
        chats: patchChat(state.chats, e.chatId, { updatedAt: e.message.createdAt, ...(preview ? { lastMessagePreview: preview } : {}) }),
      };
    }
    case 'agents':
      return { ...state, current: { ...cur, agents: e.agents } };
    case 'error':
      return {
        ...state,
        notices: [...state.notices, { id: nextId('n'), kind: 'error' as const, text: e.recoverable ? `${e.error} — retrying.` : e.error, at: Date.now() }].slice(-6),
      };
    case 'self_heal':
      return {
        ...state,
        notices: [
          ...state.notices,
          { id: nextId('n'), kind: 'self_heal' as const, text: `Self-repair attempt ${e.attempt} of ${e.max}: ${e.error}`, at: Date.now() },
        ].slice(-6),
      };
    default:
      return state;
  }
}

export function applyGlobalEvent(state: UiState, e: GlobalEvent): UiState {
  switch (e.type) {
    case 'health':
      return { ...state, health: e.health, update: e.health.update ?? state.update };
    case 'update':
      return { ...state, update: e.status };
    case 'settings':
      return { ...state, settings: e.settings };
    case 'toast':
      return reducer(state, { type: 'toast.add', toast: { id: nextId('t'), level: e.level, title: e.title, body: e.body } });
    case 'goals.plan':
    case 'goals.updated':
    case 'directives.updated':
      return { ...state, goalsVersion: state.goalsVersion + 1 };
    case 'memory.updated':
      return { ...state, memoryVersion: state.memoryVersion + 1 };
    default:
      return state;
  }
}

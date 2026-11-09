/**
 * ChatStore — SQLite persistence for chats, messages, tasks and agents.
 * All methods are synchronous and small (better-sqlite3); the service layer keeps them off hot paths.
 */
import type Database from 'better-sqlite3';
import { computeProgress, newId } from '@aim/shared';
import type { AgentInfo, Chat, ChatTask, ChatWithMessages, ContentBlock, Message, TurnUsage } from '@aim/shared';
import { hasMessageFts } from './db.js';

interface ChatRow {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  status: Chat['status'];
  session_id: string | null;
  cwd: string | null;
  pinned: number;
  archived: number;
  origin: Chat['origin'];
  goal_id: string | null;
  last_message_preview: string | null;
}
interface MessageRow {
  id: string;
  chat_id: string;
  role: Message['role'];
  content: string;
  text: string;
  created_at: number;
  agent_id: string | null;
  usage: string | null;
}
interface TaskRow {
  id: string;
  chat_id: string;
  title: string;
  state: ChatTask['state'];
  agent_id: string | null;
  ord: number;
  created_at: number;
  updated_at: number;
  detail: string | null;
}
interface AgentRow {
  id: string;
  chat_id: string;
  role: AgentInfo['role'];
  name: string;
  state: AgentInfo['state'];
  task: string | null;
  started_at: number;
  ended_at: number | null;
  session_id: string | null;
  last_activity: string | null;
  parent_agent_id: string | null;
}

export const DEFAULT_CHAT_TITLE = 'New chat';
const PREVIEW_MAX = 140;

/** Plain text of a message (text blocks + tool names), used for FTS and previews. */
export function messagePlainText(content: ContentBlock[]): string {
  const parts: string[] = [];
  for (const b of content) {
    if (b.type === 'text') parts.push(b.text);
    else if (b.type === 'tool_use') parts.push(b.name.replace(/^mcp__aim__/, ''));
  }
  return parts.join('\n').trim();
}

function rowToChat(r: ChatRow): Chat {
  const chat: Chat = {
    id: r.id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    status: r.status,
    origin: r.origin,
    pinned: r.pinned === 1,
    archived: r.archived === 1,
  };
  if (r.session_id) chat.sessionId = r.session_id;
  if (r.cwd) chat.cwd = r.cwd;
  if (r.goal_id) chat.goalId = r.goal_id;
  if (r.last_message_preview) chat.lastMessagePreview = r.last_message_preview;
  return chat;
}

function safeJson<T>(s: string | null, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function rowToMessage(r: MessageRow): Message {
  const m: Message = {
    id: r.id,
    chatId: r.chat_id,
    role: r.role,
    content: safeJson<ContentBlock[]>(r.content, []),
    createdAt: r.created_at,
  };
  if (r.agent_id) m.agentId = r.agent_id;
  const usage = safeJson<TurnUsage | null>(r.usage, null);
  if (usage) m.usage = usage;
  return m;
}

function rowToTask(r: TaskRow): ChatTask {
  const t: ChatTask = {
    id: r.id,
    chatId: r.chat_id,
    title: r.title,
    state: r.state,
    order: r.ord,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (r.agent_id) t.agentId = r.agent_id;
  if (r.detail) t.detail = r.detail;
  return t;
}

function rowToAgent(r: AgentRow): AgentInfo {
  const a: AgentInfo = {
    id: r.id,
    chatId: r.chat_id,
    role: r.role,
    name: r.name,
    state: r.state,
    startedAt: r.started_at,
  };
  if (r.task) a.task = r.task;
  if (r.ended_at != null) a.endedAt = r.ended_at;
  if (r.session_id) a.sessionId = r.session_id;
  if (r.last_activity) a.lastActivity = r.last_activity;
  if (r.parent_agent_id) a.parentAgentId = r.parent_agent_id;
  return a;
}

/** Turns a free-text query into a safe FTS5 MATCH expression: every token quoted, prefix-matched. */
export function toFtsQuery(query: string): string {
  const tokens = query
    .split(/\s+/)
    .map((t) => t.replace(/["*]/g, '').trim())
    .filter(Boolean);
  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t}"*`).join(' ');
}

export class ChatStore {
  private readonly fts: boolean;

  constructor(private readonly db: Database.Database) {
    this.fts = hasMessageFts(db);
  }

  // ─── chats ───

  listChats(opts?: { includeArchived?: boolean }): Chat[] {
    const where = opts?.includeArchived ? '' : 'WHERE archived = 0';
    const rows = this.db.prepare(`SELECT * FROM chats ${where} ORDER BY pinned DESC, updated_at DESC`).all() as ChatRow[];
    const chats = rows.map(rowToChat);
    this.attachProgress(chats);
    return chats;
  }

  getChat(id: string): ChatWithMessages | null {
    const row = this.db.prepare('SELECT * FROM chats WHERE id = ?').get(id) as ChatRow | undefined;
    if (!row) return null;
    const chat = rowToChat(row);
    const messages = (this.db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at, rowid').all(id) as MessageRow[]).map(rowToMessage);
    const tasks = this.getTasks(id);
    const agents = this.getAgents(id);
    chat.progress = computeProgress(tasks);
    return { ...chat, messages, tasks, agents };
  }

  /** Lightweight variant without messages (for event payloads). */
  getChatSummary(id: string): Chat | null {
    const row = this.db.prepare('SELECT * FROM chats WHERE id = ?').get(id) as ChatRow | undefined;
    if (!row) return null;
    const chat = rowToChat(row);
    chat.progress = computeProgress(this.getTasks(id));
    return chat;
  }

  createChat(input: Partial<Chat> & { title?: string }): Chat {
    const now = Date.now();
    const chat: Chat = {
      id: input.id ?? newId('chat'),
      title: input.title?.trim() || DEFAULT_CHAT_TITLE,
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
      status: input.status ?? 'idle',
      origin: input.origin ?? 'user',
      pinned: input.pinned ?? false,
      archived: input.archived ?? false,
    };
    if (input.sessionId) chat.sessionId = input.sessionId;
    if (input.cwd) chat.cwd = input.cwd;
    if (input.goalId) chat.goalId = input.goalId;
    if (input.lastMessagePreview) chat.lastMessagePreview = input.lastMessagePreview;
    this.db
      .prepare(
        `INSERT INTO chats (id, title, created_at, updated_at, status, session_id, cwd, pinned, archived, origin, goal_id, last_message_preview)
         VALUES (@id, @title, @created_at, @updated_at, @status, @session_id, @cwd, @pinned, @archived, @origin, @goal_id, @last_message_preview)`,
      )
      .run({
        id: chat.id,
        title: chat.title,
        created_at: chat.createdAt,
        updated_at: chat.updatedAt,
        status: chat.status,
        session_id: chat.sessionId ?? null,
        cwd: chat.cwd ?? null,
        pinned: chat.pinned ? 1 : 0,
        archived: chat.archived ? 1 : 0,
        origin: chat.origin,
        goal_id: chat.goalId ?? null,
        last_message_preview: chat.lastMessagePreview ?? null,
      });
    chat.progress = computeProgress([]);
    return chat;
  }

  updateChat(id: string, patch: Partial<Chat>): Chat {
    const existing = this.db.prepare('SELECT * FROM chats WHERE id = ?').get(id) as ChatRow | undefined;
    if (!existing) throw new Error(`Chat not found: ${id}`);
    const cur = rowToChat(existing);
    const next: Chat = { ...cur, ...patch, id, updatedAt: patch.updatedAt ?? Date.now() };
    this.db
      .prepare(
        `UPDATE chats SET title = @title, updated_at = @updated_at, status = @status, session_id = @session_id, cwd = @cwd,
          pinned = @pinned, archived = @archived, origin = @origin, goal_id = @goal_id, last_message_preview = @last_message_preview
         WHERE id = @id`,
      )
      .run({
        id,
        title: next.title,
        updated_at: next.updatedAt,
        status: next.status,
        session_id: next.sessionId ?? null,
        cwd: next.cwd ?? null,
        pinned: next.pinned ? 1 : 0,
        archived: next.archived ? 1 : 0,
        origin: next.origin,
        goal_id: next.goalId ?? null,
        last_message_preview: next.lastMessagePreview ?? null,
      });
    next.progress = computeProgress(this.getTasks(id));
    return next;
  }

  deleteChat(id: string): void {
    // Cascades to messages/tasks/agents; the FTS trigger removes index rows.
    this.db.prepare('DELETE FROM chats WHERE id = ?').run(id);
  }

  // ─── messages ───

  appendMessage(m: Message): void {
    const text = messagePlainText(m.content);
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO messages (id, chat_id, role, content, text, created_at, agent_id, usage)
           VALUES (@id, @chat_id, @role, @content, @text, @created_at, @agent_id, @usage)`,
        )
        .run({
          id: m.id,
          chat_id: m.chatId,
          role: m.role,
          content: JSON.stringify(m.content),
          text,
          created_at: m.createdAt,
          agent_id: m.agentId ?? null,
          usage: m.usage ? JSON.stringify(m.usage) : null,
        });
      this.db
        .prepare('UPDATE chats SET updated_at = ?, last_message_preview = ? WHERE id = ?')
        .run(Math.max(m.createdAt, Date.now()), preview(text), m.chatId);
    });
    tx();
  }

  updateMessage(m: Message): void {
    const text = messagePlainText(m.content);
    const info = this.db
      .prepare(`UPDATE messages SET content = @content, text = @text, agent_id = @agent_id, usage = @usage WHERE id = @id`)
      .run({
        id: m.id,
        content: JSON.stringify(m.content),
        text,
        agent_id: m.agentId ?? null,
        usage: m.usage ? JSON.stringify(m.usage) : null,
      });
    if (info.changes === 0) {
      this.appendMessage(m);
      return;
    }
    if (text) {
      // Only refresh the preview when this is the latest message of the chat.
      const last = this.db.prepare('SELECT id FROM messages WHERE chat_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(m.chatId) as
        | { id: string }
        | undefined;
      if (last?.id === m.id) {
        this.db.prepare('UPDATE chats SET last_message_preview = ? WHERE id = ?').run(preview(text), m.chatId);
      }
    }
  }

  getMessages(chatId: string): Message[] {
    return (this.db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at, rowid').all(chatId) as MessageRow[]).map(rowToMessage);
  }

  // ─── tasks ───

  setTasks(chatId: string, tasks: ChatTask[]): void {
    const now = Date.now();
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM tasks WHERE chat_id = ?').run(chatId);
      const ins = this.db.prepare(
        `INSERT INTO tasks (id, chat_id, title, state, agent_id, ord, created_at, updated_at, detail)
         VALUES (@id, @chat_id, @title, @state, @agent_id, @ord, @created_at, @updated_at, @detail)`,
      );
      tasks.forEach((t, i) => {
        ins.run({
          id: t.id || newId('task'),
          chat_id: chatId,
          title: t.title,
          state: t.state ?? 'pending',
          agent_id: t.agentId ?? null,
          ord: t.order ?? i,
          created_at: t.createdAt ?? now,
          updated_at: t.updatedAt ?? now,
          detail: t.detail ?? null,
        });
      });
      this.db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(now, chatId);
    });
    tx();
  }

  getTasks(chatId: string): ChatTask[] {
    return (this.db.prepare('SELECT * FROM tasks WHERE chat_id = ? ORDER BY ord, created_at').all(chatId) as TaskRow[]).map(rowToTask);
  }

  // ─── agents ───

  upsertAgent(a: AgentInfo): void {
    this.db
      .prepare(
        `INSERT INTO agents (id, chat_id, role, name, state, task, started_at, ended_at, session_id, last_activity, parent_agent_id)
         VALUES (@id, @chat_id, @role, @name, @state, @task, @started_at, @ended_at, @session_id, @last_activity, @parent_agent_id)
         ON CONFLICT(id) DO UPDATE SET role = excluded.role, name = excluded.name, state = excluded.state, task = excluded.task,
           ended_at = excluded.ended_at, session_id = excluded.session_id, last_activity = excluded.last_activity,
           parent_agent_id = excluded.parent_agent_id`,
      )
      .run({
        id: a.id,
        chat_id: a.chatId,
        role: a.role,
        name: a.name,
        state: a.state,
        task: a.task ?? null,
        started_at: a.startedAt,
        ended_at: a.endedAt ?? null,
        session_id: a.sessionId ?? null,
        last_activity: a.lastActivity ?? null,
        parent_agent_id: a.parentAgentId ?? null,
      });
  }

  getAgents(chatId: string): AgentInfo[] {
    return (this.db.prepare('SELECT * FROM agents WHERE chat_id = ? ORDER BY started_at').all(chatId) as AgentRow[]).map(rowToAgent);
  }

  // ─── search ───

  /** Full-text search over message text and chat titles. Returns chats ordered by recency. */
  search(query: string): Chat[] {
    const q = query.trim();
    if (!q) return [];
    const ids = new Set<string>();
    const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    for (const r of this.db.prepare(`SELECT id FROM chats WHERE title LIKE ? ESCAPE '\\'`).all(like) as { id: string }[]) ids.add(r.id);

    let usedFts = false;
    if (this.fts) {
      const match = toFtsQuery(q);
      if (match) {
        try {
          const rows = this.db.prepare('SELECT DISTINCT chat_id FROM messages_fts WHERE messages_fts MATCH ?').all(match) as { chat_id: string }[];
          for (const r of rows) ids.add(r.chat_id);
          usedFts = true;
        } catch {
          usedFts = false; // malformed MATCH → LIKE fallback below
        }
      }
    }
    if (!usedFts) {
      const rows = this.db.prepare(`SELECT DISTINCT chat_id FROM messages WHERE text LIKE ? ESCAPE '\\'`).all(like) as { chat_id: string }[];
      for (const r of rows) ids.add(r.chat_id);
    }
    if (ids.size === 0) return [];
    const placeholders = [...ids].map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT * FROM chats WHERE id IN (${placeholders}) ORDER BY updated_at DESC`).all(...ids) as ChatRow[];
    const chats = rows.map(rowToChat);
    this.attachProgress(chats);
    return chats;
  }

  // ─── helpers ───

  private attachProgress(chats: Chat[]): void {
    if (chats.length === 0) return;
    const byChat = new Map<string, ChatTask[]>();
    for (const row of this.db.prepare('SELECT * FROM tasks ORDER BY ord').all() as TaskRow[]) {
      const list = byChat.get(row.chat_id) ?? [];
      list.push(rowToTask(row));
      byChat.set(row.chat_id, list);
    }
    for (const c of chats) c.progress = computeProgress(byChat.get(c.id) ?? []);
  }
}

function preview(text: string): string | null {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > PREVIEW_MAX ? `${t.slice(0, PREVIEW_MAX - 1)}…` : t;
}

/** Chat / conversation model persisted by the ChatStore and rendered by the UI. */

export type ChatStatus = 'idle' | 'thinking' | 'working' | 'waiting_user' | 'error' | 'done';

export type MessageRole = 'user' | 'assistant' | 'system';

export interface TextBlock { type: 'text'; text: string }
export interface ImageBlock { type: 'image'; mediaType: string; dataBase64: string; alt?: string }
export interface ToolUseBlock {
  type: 'tool_use';
  id: string; // tool_use_id from the model
  name: string; // e.g. mcp__aim__screen_capture, Bash, Read
  input: unknown;
  /** Set once the result arrives. */
  result?: ToolResultSummary;
  /** Which agent produced it; undefined = the main AIM agent. */
  agentId?: string;
}
export interface ToolResultSummary {
  ok: boolean;
  /** Short, human-readable summary for the UI (never the full payload). */
  summary: string;
  durationMs?: number;
  /** For image-producing tools (screenshots) — a thumbnail. */
  imageBase64?: string;
  error?: string;
}
export interface ThinkingBlock { type: 'thinking'; text: string }
export interface StatusBlock { type: 'status'; text: string } // e.g. "Self-repair attempt 1/3"

export type ContentBlock = TextBlock | ImageBlock | ToolUseBlock | ThinkingBlock | StatusBlock;

export interface Message {
  id: string;
  chatId: string;
  role: MessageRole;
  content: ContentBlock[];
  createdAt: number; // epoch ms
  /** Sub-agent that authored this message, if any. */
  agentId?: string;
  /** Token/cost info from the CLI result event, for the assistant's final message of a turn. */
  usage?: TurnUsage;
}

export interface TurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  durationMs?: number;
  numTurns?: number;
}

export type TaskState = 'pending' | 'in_progress' | 'done' | 'failed' | 'skipped';

/** A unit of work inside a chat. The progress ring = done / total. */
export interface ChatTask {
  id: string;
  chatId: string;
  title: string;
  state: TaskState;
  /** Agent assigned to it, if the orchestrator delegated. */
  agentId?: string;
  order: number;
  createdAt: number;
  updatedAt: number;
  detail?: string;
}

export interface ChatProgress {
  total: number;
  done: number;
  failed: number;
  inProgress: number;
  /** 0..1 — what the ring shows. Includes partial credit for in-progress tasks. */
  ratio: number;
  /** Short label shown under the ring, e.g. "3 / 7 — Opening Edge". */
  label: string;
}

export type AgentRole =
  | 'orchestrator'
  | 'planner'
  | 'browser_operator'
  | 'desktop_operator'
  | 'researcher'
  | 'coder'
  | 'verifier'
  | 'reflector'
  | 'goal_planner';

export type AgentState = 'spawning' | 'running' | 'waiting' | 'done' | 'failed' | 'cancelled';

export interface AgentInfo {
  id: string;
  chatId: string;
  role: AgentRole;
  name: string; // display name, e.g. "Browser Operator"
  state: AgentState;
  task?: string; // one-liner of what it was asked to do
  startedAt: number;
  endedAt?: number;
  /** Claude session id for this agent's CLI process (resumable). */
  sessionId?: string;
  lastActivity?: string;
  parentAgentId?: string;
}

export interface Chat {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  status: ChatStatus;
  /** Claude Code session id backing this chat (for --resume). */
  sessionId?: string;
  /** Working directory the CLI runs in for this chat. */
  cwd?: string;
  pinned?: boolean;
  archived?: boolean;
  /** 'user' = created by the user; 'goal' = created by AIM's daily goal planner; 'system' = internal. */
  origin: 'user' | 'goal' | 'system';
  goalId?: string;
  lastMessagePreview?: string;
  progress?: ChatProgress;
}

export interface ChatWithMessages extends Chat {
  messages: Message[];
  tasks: ChatTask[];
  agents: AgentInfo[];
}

/** Attachments the user can send with a prompt. */
export interface Attachment {
  kind: 'image' | 'file' | 'screenshot';
  name: string;
  mediaType: string;
  dataBase64?: string; // images
  path?: string; // files on disk
}

export interface SendMessageInput {
  chatId: string;
  text: string;
  attachments?: Attachment[];
}

export function computeProgress(tasks: ChatTask[]): ChatProgress {
  const total = tasks.length;
  const done = tasks.filter((t) => t.state === 'done' || t.state === 'skipped').length;
  const failed = tasks.filter((t) => t.state === 'failed').length;
  const inProgress = tasks.filter((t) => t.state === 'in_progress').length;
  const ratio = total === 0 ? 0 : Math.min(1, (done + failed + inProgress * 0.5) / total);
  const current = tasks.find((t) => t.state === 'in_progress');
  const label =
    total === 0
      ? ''
      : current
        ? `${done} / ${total} — ${current.title}`
        : done + failed === total
          ? failed
            ? `${done} / ${total} done, ${failed} failed`
            : 'Complete'
          : `${done} / ${total}`;
  return { total, done, failed, inProgress, ratio, label };
}

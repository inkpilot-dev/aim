# @aim/core public API (contract between the core agent, the learning agent and the desktop main agent)

All classes are ESM TypeScript, exported from `@aim/core` (`packages/core/src/index.ts`, which also re-exports `./learning/index.js`).
Dependencies on Electron are forbidden in core. Anything OS/Electron-specific is injected through the interfaces below.

```ts
import type Database from 'better-sqlite3';
import type { Chat, ChatWithMessages, Message, ChatTask, AgentInfo, ChatProgress, Attachment, Settings,
  ChatStreamEvent, GlobalEvent, CliEvent, MemoryEntry, BehaviorSample, BehaviorSummary, Directive, Goal, DailyPlan,
  ToolResult, CliHealth } from '@aim/shared';

// ─── logging ───
export function createLogger(scope: string): Logger;            // console + file; configure once:
export function configureLogging(opts: { dir: string; level?: 'debug'|'info'|'warn'|'error' }): void;
export interface Logger { debug(...a: unknown[]): void; info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void; child(scope: string): Logger }

// ─── database ───
export function openDatabase(filePath: string): Database.Database; // enables WAL, runs ALL migrations (chat + learning tables). Owned by core agent; learning agent adds its migration SQL in src/learning/schema.ts exported as `LEARNING_SCHEMA_SQL: string[]` which openDatabase executes.

// ─── CLI bridge (core agent) ───
export interface CliRunOptions {
  cwd: string;
  sessionId?: string;            // resume
  model?: string; effort?: string; maxBudgetUsd?: number;
  appendSystemPrompt?: string;
  agentsJson?: string;           // --agents
  mcpConfigJson?: string;        // --mcp-config, with --strict-mcp-config
  addDirs?: string[];
  env?: Record<string,string>;
  jsonSchema?: object;           // structured output (one-shot)
  abortSignal?: AbortSignal;
  timeoutMs?: number;
}
export interface CliTurnHandle {
  readonly pid: number | undefined;
  readonly sessionId: Promise<string>;       // resolves on system/init
  send(input: { text: string; images?: { mediaType: string; dataBase64: string }[] }): void; // writes a CliUserInput line
  end(): void;                                // close stdin → CLI finishes the turn and exits
  abort(): void;                              // SIGTERM/kill
  readonly done: Promise<CliRunResult>;       // resolves on `result` event or exit
  on(event: 'event', cb: (e: CliEvent) => void): () => void;
  on(event: 'stderr', cb: (line: string) => void): () => void;
}
export interface CliRunResult { ok: boolean; sessionId?: string; resultText?: string; structured?: unknown; isError: boolean; errorMessage?: string; costUsd?: number; durationMs?: number; numTurns?: number; exitCode: number | null }
export class ClaudeCliBridge {
  constructor(opts: { cliPath?: string; log?: Logger });
  static detect(explicitPath?: string): Promise<CliHealth>;      // find `claude` on PATH / common install dirs (npm global, %APPDATA%\npm, ~/.local/bin, /opt/homebrew/bin, native installer ~/.claude/local/claude), get --version
  start(opts: CliRunOptions): CliTurnHandle;                       // spawns `claude -p ... --input-format stream-json`
  runOnce(prompt: string, opts: CliRunOptions): Promise<CliRunResult>; // text/json one-shot (`claude -p "<prompt>" --output-format json [--json-schema]`), used by Reflector / GoalPlanner
}
export interface OneShotRunner { runOnce(prompt: string, opts: CliRunOptions): Promise<CliRunResult> } // what learning depends on

// ─── stores (core agent) ───
export class ChatStore {           // SQLite: chats, messages, tasks, agents (+ FTS on messages for search)
  constructor(db: Database.Database);
  listChats(opts?: { includeArchived?: boolean }): Chat[];
  getChat(id: string): ChatWithMessages | null;
  createChat(input: Partial<Chat> & { title?: string }): Chat;
  updateChat(id: string, patch: Partial<Chat>): Chat;
  deleteChat(id: string): void;
  appendMessage(m: Message): void; updateMessage(m: Message): void;
  setTasks(chatId: string, tasks: ChatTask[]): void; getTasks(chatId: string): ChatTask[];
  upsertAgent(a: AgentInfo): void; getAgents(chatId: string): AgentInfo[];
  search(query: string): Chat[];
}

// ─── the service the desktop main process drives (core agent) ───
export interface ChatServiceDeps {
  store: ChatStore;
  cli: ClaudeCliBridge;
  settings: () => Settings;                               // live getter
  buildMcpConfig: (chatId: string) => string;             // desktop supplies (tools-mcp path, hub url/token)
  memoryDigest: () => Promise<string>;                    // learning supplies; '' when disabled
  behaviorDigest?: () => Promise<string>;
  onTurnComplete?: (chat: ChatWithMessages, turnMessages: Message[]) => void | Promise<void>; // Reflector hook
  log?: Logger;
}
export class ChatService {
  constructor(deps: ChatServiceDeps);
  on(cb: (e: ChatStreamEvent) => void): () => void;      // every UI event
  listChats(): Chat[]; getChat(id: string): ChatWithMessages | null;
  createChat(input?: { title?: string; cwd?: string; origin?: Chat['origin']; goalId?: string }): Chat;
  renameChat(id: string, title: string): void; deleteChat(id: string): void; setPinned(id: string, v: boolean): void; setArchived(id: string, v: boolean): void;
  search(q: string): Chat[];
  sendMessage(input: { chatId: string; text: string; attachments?: Attachment[] }): Promise<void>; // starts a turn (queues if one is running)
  stop(chatId: string): Promise<void>;
  // called by the desktop ToolRouter for tasks_*/ask_user/agents_status tools:
  setTasks(chatId: string, tasks: { title: string; state?: ChatTask['state']; detail?: string }[]): ChatProgress;
  updateTask(chatId: string, sel: { index?: number; title?: string }, patch: { state: ChatTask['state']; detail?: string }): ChatProgress;
  askUser(chatId: string, question: string, options?: string[], timeoutMs?: number): Promise<string>; // emits ask_user, resolves on answerQuestion
  answerQuestion(chatId: string, requestId: string, answer: string): void;
  getAgents(chatId: string): AgentInfo[];
  /** Run a sub-task in a separate CLI process (worker agent) and return its result text. */
  spawnWorker(chatId: string, spec: { role: AgentRole; name: string; task: string; cwd?: string }): Promise<{ agentId: string; result: string; ok: boolean }>;
  isBusy(chatId: string): boolean;
  dispose(): void;
}

// ─── prompts (core agent) ───
export function buildSystemPrompt(ctx: { memoryDigest: string; behaviorDigest?: string; platform: string; now: Date; extensionConnected: boolean; userName?: string }): string;
export function buildAgentsJson(): string; // planner, browser_operator, desktop_operator, researcher, coder, verifier definitions for --agents

// ─── learning (learning agent) — src/learning/index.ts ───
export const LEARNING_SCHEMA_SQL: string[];
export class MemoryStore { constructor(db); remember(e: Pick<MemoryEntry,'key'|'value'|'kind'> & Partial<MemoryEntry>): MemoryEntry; recall(query: string, limit?: number): MemoryEntry[]; forget(key: string): boolean; list(): MemoryEntry[]; digest(maxChars?: number): string; count(): number }
export interface ActiveWindowProvider { getActiveWindow(): Promise<{ app: string; title: string; pid?: number } | null>; isIdle?(): Promise<boolean> }
export class BehaviorObserver { constructor(opts: { db; provider: ActiveWindowProvider; sampleMs?: number; log?: Logger }); start(): void; stop(): void; recordBrowserActivity(e: { url: string; title: string; kind: string }): void; summary(days?: number): BehaviorSummary; sampleCount(): number; digest(): string }
export class DirectiveStore { constructor(db); list(): Directive[]; add(text: string, priority?: 1|2|3): Directive; update(id, patch): Directive; remove(id): void }
export class GoalStore { constructor(db); list(opts?: { date?: string; includeDone?: boolean }): Goal[]; upsert(g: Goal): Goal; update(id: string, patch: Partial<Goal>): Goal; get(id): Goal | null; planForDate(date: string): DailyPlan | null; savePlan(p: DailyPlan): void }
export class GoalPlanner { constructor(opts: { runner: OneShotRunner; directives: DirectiveStore; goals: GoalStore; memory: MemoryStore; observer?: BehaviorObserver; settings: () => Settings; log?: Logger }); planToday(force?: boolean): Promise<DailyPlan>; }
export class GoalRunner { constructor(opts: { goals: GoalStore; chats: ChatService; settings: () => Settings; log?: Logger }); runGoal(goalId: string): Promise<{ chatId: string }>; runPending(date?: string): Promise<void>; }
export class Scheduler { constructor(opts: { planner: GoalPlanner; runner: GoalRunner; settings: () => Settings; log?: Logger }); start(): void; stop(): void; onPlan(cb: (p: DailyPlan) => void): () => void; }
export class Reflector { constructor(opts: { runner: OneShotRunner; memory: MemoryStore; settings: () => Settings; log?: Logger }); reflect(chat: ChatWithMessages, turnMessages: Message[]): Promise<{ memories: MemoryEntry[]; chatTitle?: string }> }
```

Rules
- `ChatService` must never block the Electron main thread: CLI I/O is async; SQLite calls are small and synchronous (fine).
- `ChatService.sendMessage` must: persist the user message → emit `message.start`; build system prompt (incl. memory digest); start a CLI turn (resume `chat.sessionId`); translate `CliEvent`s into `ChatStreamEvent`s (streaming text deltas; tool_use blocks with result summaries; sub-agent `AgentInfo`); on result → persist assistant message, set status, call `onTurnComplete`; on error → `SelfHealer` (≤ `maxSelfHealAttempts` re-prompts with the error) before emitting `error` and status `waiting_user`.
- Tool-call summaries in the UI are short: e.g. `screen_capture → 1920×1080`, `browser_click e12 "Sign in"`.

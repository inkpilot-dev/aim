/** Electron IPC contract between the renderer (React UI) and main. Exposed on window.aim by the preload. */
import type { Attachment, Chat, ChatProgress, ChatWithMessages, Message, ChatTask, AgentInfo, ChatStatus } from './chat.js';
import type { Settings } from './settings.js';
import type { Directive, Goal, DailyPlan, MemoryEntry, BehaviorSummary } from './learning.js';

export interface CliHealth {
  found: boolean;
  path?: string;
  version?: string;
  /** Logged in / has usable auth (we run `claude -p "ping"` cheaply or inspect config). */
  authenticated?: boolean;
  error?: string;
}

export interface ExtensionHealth {
  connected: boolean;
  browser?: string;
  version?: string;
  tabs?: number;
  lastSeen?: number;
}

export interface HubHealth {
  listening: boolean;
  port: number;
  url: string;
  token: string;
}

export type UpdateState =
  | 'unsupported' // development build (not packaged)
  | 'disabled' // turned off in Settings or no repository configured
  | 'idle'
  | 'checking'
  | 'available'
  | 'not_available'
  | 'downloading'
  | 'downloaded'
  | 'error';

export interface UpdateStatus {
  state: UpdateState;
  currentVersion: string;
  latestVersion?: string;
  /** Download progress 0..100 while downloading. */
  percent?: number;
  bytesPerSecond?: number;
  releaseNotes?: string;
  releaseDate?: string;
  /** "owner/repo" the updater is pointed at, when known. */
  repo?: string;
  checkedAt?: number;
  error?: string;
  /** Human-readable explanation for disabled/unsupported states. */
  message?: string;
  /** Set when the update cannot be applied automatically (source build): open this page to download the installer. */
  releaseUrl?: string;
  manual?: boolean;
}

export interface AppHealth {
  cli: CliHealth;
  extension: ExtensionHealth;
  hub: HubHealth;
  observer: { enabled: boolean; samples: number };
  version: string;
  platform: string;
  /** Useful on-disk locations (shown in Settings). */
  paths?: { userData: string; logs: string; extensionDir: string; docsDir: string };
  /** Self-update status (GitHub Releases). */
  update?: UpdateStatus;
  /** Display name of the signed-in OS user (for greetings). */
  userName?: string;
}

/** Streaming delta events main → renderer for a chat. */
export type ChatStreamEvent =
  | { type: 'status'; chatId: string; status: ChatStatus }
  | { type: 'message.start'; chatId: string; message: Message }
  | { type: 'message.delta'; chatId: string; messageId: string; blockIndex: number; delta: { text?: string; thinking?: string; partialJson?: string } }
  | { type: 'message.block'; chatId: string; messageId: string; blockIndex: number; block: Message['content'][number] }
  | { type: 'message.end'; chatId: string; message: Message }
  | { type: 'tasks'; chatId: string; tasks: ChatTask[]; progress: ChatProgress }
  | { type: 'agents'; chatId: string; agents: AgentInfo[] }
  | { type: 'ask_user'; chatId: string; requestId: string; question: string; options?: string[] }
  | { type: 'ask_user.resolved'; chatId: string; requestId: string }
  | { type: 'error'; chatId: string; error: string; recoverable: boolean }
  | { type: 'title'; chatId: string; title: string }
  | { type: 'chat.updated'; chat: Chat }
  | { type: 'chat.deleted'; chatId: string }
  | { type: 'self_heal'; chatId: string; attempt: number; max: number; error: string };

export type GlobalEvent =
  | { type: 'health'; health: AppHealth }
  | { type: 'goals.plan'; plan: DailyPlan }
  | { type: 'goals.updated'; goals: Goal[] }
  | { type: 'directives.updated'; directives: Directive[] }
  | { type: 'memory.updated'; count: number }
  | { type: 'toast'; level: 'info' | 'success' | 'warning' | 'error'; title: string; body?: string }
  | { type: 'settings'; settings: Settings }
  | { type: 'update'; status: UpdateStatus };

/** The API the preload exposes as `window.aim`. */
export interface AimApi {
  // chats
  listChats(): Promise<Chat[]>;
  getChat(chatId: string): Promise<ChatWithMessages | null>;
  createChat(input?: { title?: string; cwd?: string }): Promise<Chat>;
  renameChat(chatId: string, title: string): Promise<void>;
  deleteChat(chatId: string): Promise<void>;
  pinChat(chatId: string, pinned: boolean): Promise<void>;
  archiveChat(chatId: string, archived: boolean): Promise<void>;
  sendMessage(input: { chatId: string; text: string; attachments?: Attachment[] }): Promise<void>;
  stopChat(chatId: string): Promise<void>;
  answerQuestion(chatId: string, requestId: string, answer: string): Promise<void>;
  searchChats(query: string): Promise<Chat[]>;
  // screen helpers for the UI (attach a screenshot)
  captureScreenshot(): Promise<Attachment>;
  // settings & health
  getSettings(): Promise<Settings>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  getHealth(): Promise<AppHealth>;
  detectCli(): Promise<CliHealth>;
  // self-update (GitHub Releases)
  checkForUpdates(): Promise<UpdateStatus>;
  downloadUpdate(): Promise<UpdateStatus>;
  /** Quits and installs a downloaded update. */
  installUpdate(): Promise<void>;
  // learning
  listMemories(query?: string): Promise<MemoryEntry[]>;
  deleteMemory(key: string): Promise<void>;
  upsertMemory(entry: Pick<MemoryEntry, 'key' | 'value' | 'kind'>): Promise<void>;
  getBehaviorSummary(days?: number): Promise<BehaviorSummary>;
  // goals
  listDirectives(): Promise<Directive[]>;
  addDirective(text: string, priority?: 1 | 2 | 3): Promise<Directive>;
  updateDirective(id: string, patch: Partial<Pick<Directive, 'text' | 'active' | 'priority'>>): Promise<void>;
  deleteDirective(id: string): Promise<void>;
  listGoals(opts?: { date?: string; includeDone?: boolean }): Promise<Goal[]>;
  planGoalsNow(): Promise<DailyPlan>;
  /** Create a goal yourself. Goals for today start right away when auto-run is on. */
  addGoal(input: { title: string; rationale?: string; date?: string; priority?: 1 | 2 | 3 }): Promise<Goal>;
  /** Delete a goal (stops it first when it is running). */
  deleteGoal(goalId: string): Promise<void>;
  runGoal(goalId: string): Promise<{ chatId: string }>;
  // window
  minimize(): void;
  maximize(): void;
  close(): void;
  openExternal(url: string): Promise<void>;
  openPath(path: string): Promise<void>;
  // events
  onChatEvent(cb: (e: ChatStreamEvent) => void): () => void;
  onGlobalEvent(cb: (e: GlobalEvent) => void): () => void;
}

/** IPC channel names (invoke/handle). Keep in sync with AimApi method names. */
export const IPC = {
  chats_list: 'aim:chats:list',
  chats_get: 'aim:chats:get',
  chats_create: 'aim:chats:create',
  chats_rename: 'aim:chats:rename',
  chats_delete: 'aim:chats:delete',
  chats_pin: 'aim:chats:pin',
  chats_archive: 'aim:chats:archive',
  chats_send: 'aim:chats:send',
  chats_stop: 'aim:chats:stop',
  chats_answer: 'aim:chats:answer',
  chats_search: 'aim:chats:search',
  screen_capture: 'aim:screen:capture',
  settings_get: 'aim:settings:get',
  settings_update: 'aim:settings:update',
  health_get: 'aim:health:get',
  cli_detect: 'aim:cli:detect',
  update_check: 'aim:update:check',
  update_download: 'aim:update:download',
  update_install: 'aim:update:install',
  memory_list: 'aim:memory:list',
  memory_delete: 'aim:memory:delete',
  memory_upsert: 'aim:memory:upsert',
  behavior_summary: 'aim:behavior:summary',
  directives_list: 'aim:directives:list',
  directives_add: 'aim:directives:add',
  directives_update: 'aim:directives:update',
  directives_delete: 'aim:directives:delete',
  goals_list: 'aim:goals:list',
  goals_plan: 'aim:goals:plan',
  goals_run: 'aim:goals:run',
  goals_add: 'aim:goals:add',
  goals_delete: 'aim:goals:delete',
  window_minimize: 'aim:window:minimize',
  window_maximize: 'aim:window:maximize',
  window_close: 'aim:window:close',
  shell_openExternal: 'aim:shell:openExternal',
  shell_openPath: 'aim:shell:openPath',
  // main → renderer (send)
  event_chat: 'aim:event:chat',
  event_global: 'aim:event:global',
} as const;

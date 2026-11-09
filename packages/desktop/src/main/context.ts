/** Shared application context passed between bootstrap, IPC and tools. */
import type Database from 'better-sqlite3';
import type * as Core from '@aim/core';
import type { HubServer } from './hub/hub-server.js';
import type { CursorOverlay } from './overlay/cursor-overlay.js';
import type { SettingsStore } from './settings.js';
import type { MainWindow } from './window.js';
import type { ToolRouter } from './tools/tool-router.js';
import type { HealthMonitor } from './health.js';
import type { UpdateService } from './updater.js';
import type { ActiveWindowProvider } from './active-window.js';

export interface CoreServices {
  db: Database.Database;
  chatStore: Core.ChatStore;
  cli: Core.ClaudeCliBridge;
  chatService: Core.ChatService;
  memory: Core.MemoryStore;
  observer: Core.BehaviorObserver;
  directives: Core.DirectiveStore;
  goals: Core.GoalStore;
  planner: Core.GoalPlanner;
  goalRunner: Core.GoalRunner;
  scheduler: Core.Scheduler;
  reflector: Core.Reflector;
}

export interface AppPaths {
  userData: string;
  db: string;
  logs: string;
  settings: string;
  assets: string;
  /** Unpacked browser extension folder the user loads into Edge/Chrome. */
  extensionDir: string;
  /** Markdown docs folder (docs/EXTENSION.md etc.). */
  docsDir: string;
}

export interface AppContext {
  paths: AppPaths;
  settings: SettingsStore;
  hub: HubServer;
  overlay: CursorOverlay;
  mainWindow: MainWindow;
  activeWindow: ActiveWindowProvider;
  /** The loaded @aim/core module (null when it failed to load). */
  core: typeof Core | null;
  services: CoreServices | null;
  router: ToolRouter | null;
  health: HealthMonitor | null;
  updater: UpdateService | null;
  /** Set when the core failed to construct; the UI shows a health page. */
  startupError?: string;
  observerPaused: boolean;
  log: Core.Logger | ConsoleLogger;
}

export interface ConsoleLogger {
  debug(...a: unknown[]): void;
  info(...a: unknown[]): void;
  warn(...a: unknown[]): void;
  error(...a: unknown[]): void;
  child(scope: string): ConsoleLogger;
}

export function consoleLogger(scope: string): ConsoleLogger {
  const p = `[${scope}]`;
  return {
    debug: (...a) => console.debug(p, ...a),
    info: (...a) => console.info(p, ...a),
    warn: (...a) => console.warn(p, ...a),
    error: (...a) => console.error(p, ...a),
    child: (s) => consoleLogger(`${scope}:${s}`),
  };
}

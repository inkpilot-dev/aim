/**
 * Structural dependency interfaces for the learning layer.
 *
 * The learning layer is written in parallel with the rest of @aim/core, so it never imports the
 * concrete `ChatService`, `ClaudeCliBridge` or `Logger` classes. Instead it depends on the minimal
 * shapes below, which the real classes satisfy structurally (see docs/CORE_API.md).
 */
import type { Chat, ChatStreamEvent } from '@aim/shared';

// ─── logging ───

export interface LoggerLike {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** Logger used when none is injected. */
export const noopLogger: LoggerLike = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Prefix every log line with `[scope]`. */
export function scopedLogger(base: LoggerLike | undefined, scope: string): LoggerLike {
  const b = base ?? noopLogger;
  const tag = `[${scope}]`;
  return {
    debug: (...a) => b.debug(tag, ...a),
    info: (...a) => b.info(tag, ...a),
    warn: (...a) => b.warn(tag, ...a),
    error: (...a) => b.error(tag, ...a),
  };
}

// ─── sqlite ───

/** The subset of a better-sqlite3 `Database` the learning stores use (also satisfied by `node:sqlite`). */
export interface SqliteRunResult {
  changes: number | bigint;
  lastInsertRowid?: number | bigint;
}
export interface SqliteStatement {
  run(...params: unknown[]): SqliteRunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
export interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): unknown;
}

// ─── one-shot CLI runner ───

/** Mirrors `CliRunOptions` from @aim/core. */
export interface CliRunOptionsLike {
  cwd: string;
  sessionId?: string;
  model?: string;
  effort?: string;
  maxBudgetUsd?: number;
  appendSystemPrompt?: string;
  agentsJson?: string;
  mcpConfigJson?: string;
  addDirs?: string[];
  env?: Record<string, string>;
  jsonSchema?: object;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
}

/** Mirrors `CliRunResult` from @aim/core. */
export interface CliRunResultLike {
  ok: boolean;
  sessionId?: string;
  resultText?: string;
  structured?: unknown;
  isError: boolean;
  errorMessage?: string;
  costUsd?: number;
  durationMs?: number;
  numTurns?: number;
  exitCode: number | null;
}

/** What GoalPlanner and Reflector need from the CLI bridge (`ClaudeCliBridge.runOnce`). */
export interface OneShotRunnerLike {
  runOnce(prompt: string, opts: CliRunOptionsLike): Promise<CliRunResultLike>;
}

// ─── chat service ───

/** What GoalRunner needs from `ChatService`. */
export interface ChatServiceLike {
  createChat(input?: { title?: string; cwd?: string; origin?: Chat['origin']; goalId?: string }): Chat;
  sendMessage(input: { chatId: string; text: string }): Promise<void>;
  on(cb: (e: ChatStreamEvent) => void): () => void;
}

// ─── OS integration ───

/** Supplied by the desktop main process (active-win / PowerShell / Electron powerMonitor). */
export interface ActiveWindowProvider {
  getActiveWindow(): Promise<{ app: string; title: string; pid?: number } | null>;
  /** Optional: true when the user has been idle (no input) for a while. */
  isIdle?(): Promise<boolean>;
}

// ─── helpers shared by the learning modules ───

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Extract a JSON object from a one-shot CLI result: prefers `structured`, otherwise finds the first
 * `{ … }` block in `resultText` (tolerating ``` fences and prose around it). Returns null when nothing parses.
 */
export function extractJsonObject(result: CliRunResultLike | null | undefined): Record<string, unknown> | null {
  if (!result) return null;
  if (result.structured && typeof result.structured === 'object' && !Array.isArray(result.structured)) {
    return result.structured as Record<string, unknown>;
  }
  if (typeof result.structured === 'string') {
    const fromString = parseJsonLoose(result.structured);
    if (fromString) return fromString;
  }
  if (typeof result.resultText === 'string') return parseJsonLoose(result.resultText);
  return null;
}

function parseJsonLoose(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const candidates = [cleaned];
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(cleaned.slice(first, last + 1));
  for (const c of candidates) {
    try {
      const v: unknown = JSON.parse(c);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      // try next candidate
    }
  }
  return null;
}

export function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}
export function asNumber(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

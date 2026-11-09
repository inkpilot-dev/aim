/**
 * Minimal scoped logger: writes to the console and appends to `<dir>/aim.log`.
 * The file is rotated (renamed to `aim.log.1`) once it exceeds 5 MB.
 * File writes are queued and asynchronous so logging never blocks the Electron main thread.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(...a: unknown[]): void;
  info(...a: unknown[]): void;
  warn(...a: unknown[]): void;
  error(...a: unknown[]): void;
  child(scope: string): Logger;
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
export const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
export const LOG_FILE_NAME = 'aim.log';

interface LogState {
  dir?: string;
  level: LogLevel;
  /** Current size of aim.log in bytes (tracked locally to avoid a stat per line). */
  size: number;
  /** Serialises file appends. */
  queue: Promise<void>;
  /** Console output can be silenced (tests). */
  console: boolean;
}

const state: LogState = { level: 'info', size: 0, queue: Promise.resolve(), console: true };

/**
 * Configure the global logging sink. Safe to call more than once (e.g. when the log directory changes).
 * `dir` is created when missing.
 */
export function configureLogging(opts: { dir: string; level?: LogLevel; console?: boolean }): void {
  state.level = opts.level ?? state.level;
  if (opts.console !== undefined) state.console = opts.console;
  try {
    fs.mkdirSync(opts.dir, { recursive: true });
    state.dir = opts.dir;
    const file = path.join(opts.dir, LOG_FILE_NAME);
    state.size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  } catch (err) {
    state.dir = undefined;
    // Last resort: the console still works.
    console.error('[aim/logger] cannot configure log directory', opts.dir, err);
  }
}

/** Current log file path, or undefined when file logging is not configured. */
export function getLogFilePath(): string | undefined {
  return state.dir ? path.join(state.dir, LOG_FILE_NAME) : undefined;
}

function formatArg(a: unknown): string {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.stack ?? `${a.name}: ${a.message}`;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

function appendToFile(line: string): void {
  const dir = state.dir;
  if (!dir) return;
  const file = path.join(dir, LOG_FILE_NAME);
  const bytes = Buffer.byteLength(line, 'utf8');
  state.queue = state.queue
    .then(async () => {
      if (state.size + bytes > LOG_ROTATE_BYTES) {
        // Rotate: keep exactly one previous generation.
        try {
          await fsp.rename(file, `${file}.1`);
        } catch {
          /* file may not exist yet — nothing to rotate */
        }
        state.size = 0;
      }
      await fsp.appendFile(file, line, 'utf8');
      state.size += bytes;
    })
    .catch((err: unknown) => {
      // Never let a logging failure propagate; report once to the console.
      console.error('[aim/logger] write failed', err);
    });
}

function write(scope: string, level: LogLevel, args: unknown[]): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[state.level]) return;
  const ts = new Date().toISOString();
  const text = args.map(formatArg).join(' ');
  const line = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${text}\n`;
  if (state.console) {
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : level === 'debug' ? console.debug : console.log;
    fn(`[${scope}]`, ...args);
  }
  appendToFile(line);
}

export function createLogger(scope: string): Logger {
  return {
    debug: (...a) => write(scope, 'debug', a),
    info: (...a) => write(scope, 'info', a),
    warn: (...a) => write(scope, 'warn', a),
    error: (...a) => write(scope, 'error', a),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}

/** Waits for queued file writes — used by tests and on shutdown. */
export function flushLogs(): Promise<void> {
  return state.queue;
}

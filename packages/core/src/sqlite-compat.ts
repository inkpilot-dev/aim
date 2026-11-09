/**
 * SQLite driver loader with a fallback.
 *
 * Primary driver: better-sqlite3 (native). If its binary cannot be loaded — the classic Electron / Node
 * ABI mismatch after an incomplete rebuild — we fall back to Node's built-in `node:sqlite`
 * (available in Node ≥ 22.13 and in Electron ≥ 37) wrapped in an adapter that exposes the subset of the
 * better-sqlite3 API the A.I.M. stores use: prepare().run/get/all, exec, pragma, transaction, close, name.
 * This keeps the app running when the native module is broken instead of crashing at startup.
 */
import { createRequire } from 'node:module';
import type Database from 'better-sqlite3';
import { createLogger } from './logger.js';

const log = createLogger('core:sqlite');
const require = createRequire(import.meta.url);

export type SqliteDatabase = Database.Database;

interface NodeSqliteStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
interface NodeSqliteDatabaseSync {
  prepare(sql: string): NodeSqliteStatement;
  exec(sql: string): void;
  close(): void;
}

function normalizeParams(params: unknown[]): unknown[] {
  // better-sqlite3 accepts booleans and undefined; node:sqlite does not.
  return params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));
}

class NodeSqliteAdapterStatement {
  constructor(private readonly stmt: NodeSqliteStatement) {}
  run(...params: unknown[]) {
    const r = this.stmt.run(...normalizeParams(params));
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }
  get(...params: unknown[]) {
    return this.stmt.get(...normalizeParams(params));
  }
  all(...params: unknown[]) {
    return this.stmt.all(...normalizeParams(params));
  }
  *iterate(...params: unknown[]) {
    yield* this.stmt.all(...normalizeParams(params));
  }
  pluck() { return this; }
  raw() { return this; }
}

class NodeSqliteAdapter {
  readonly name: string;
  readonly memory: boolean;
  readonly readonly = false;
  readonly open = true;
  inTransaction = false;
  private readonly db: NodeSqliteDatabaseSync;
  private depth = 0;
  constructor(filePath: string) {
    const mod = require('node:sqlite') as { DatabaseSync: new (p: string) => NodeSqliteDatabaseSync };
    this.db = new mod.DatabaseSync(filePath);
    this.name = filePath;
    this.memory = filePath === ':memory:';
  }
  prepare(sql: string) {
    return new NodeSqliteAdapterStatement(this.db.prepare(sql));
  }
  exec(sql: string) {
    this.db.exec(sql);
    return this;
  }
  pragma(sql: string, opts?: { simple?: boolean }) {
    const rows = this.db.prepare(`PRAGMA ${sql}`).all() as Record<string, unknown>[];
    if (opts?.simple) {
      const first = rows[0];
      return first ? Object.values(first)[0] : undefined;
    }
    return rows;
  }
  transaction<F extends (...args: never[]) => unknown>(fn: F): F {
    const wrapped = ((...args: Parameters<F>) => {
      const outer = this.depth === 0;
      if (outer) this.db.exec('BEGIN');
      else this.db.exec(`SAVEPOINT sp${this.depth}`);
      this.depth++;
      this.inTransaction = true;
      try {
        const out = fn(...args);
        this.depth--;
        if (outer) this.db.exec('COMMIT');
        else this.db.exec(`RELEASE sp${this.depth}`);
        this.inTransaction = this.depth > 0;
        return out;
      } catch (err) {
        this.depth--;
        if (outer) this.db.exec('ROLLBACK');
        else this.db.exec(`ROLLBACK TO sp${this.depth}`);
        this.inTransaction = this.depth > 0;
        throw err;
      }
    }) as unknown as F & { deferred: F; immediate: F; exclusive: F };
    wrapped.deferred = wrapped;
    wrapped.immediate = wrapped;
    wrapped.exclusive = wrapped;
    return wrapped;
  }
  close() {
    this.db.close();
    return this;
  }
}

export type SqliteDriver = 'better-sqlite3' | 'node:sqlite';
let chosen: SqliteDriver | undefined;

/** Which driver `openSqlite` ended up using (after the first call). */
export function sqliteDriver(): SqliteDriver | undefined {
  return chosen;
}

/** Opens a database with better-sqlite3, falling back to node:sqlite when the native module cannot load. */
export function openSqlite(filePath: string, opts: { forceDriver?: SqliteDriver } = {}): SqliteDatabase {
  const force = opts.forceDriver ?? (process.env.AIM_SQLITE_DRIVER as SqliteDriver | undefined);
  if (force !== 'node:sqlite') {
    try {
      const Better = require('better-sqlite3') as typeof Database;
      const db = new Better(filePath);
      chosen = 'better-sqlite3';
      return db;
    } catch (err) {
      if (force === 'better-sqlite3') throw err;
      log.warn('better-sqlite3 unavailable, falling back to node:sqlite:', err instanceof Error ? err.message.split('\n')[0] : err);
    }
  }
  const adapter = new NodeSqliteAdapter(filePath);
  chosen = 'node:sqlite';
  return adapter as unknown as SqliteDatabase;
}

/**
 * Opens a throw-away SQLite database for tests and applies LEARNING_SCHEMA_SQL.
 *
 * Prefers better-sqlite3. In this repository that module is compiled for Electron's ABI, so when
 * it fails to load under plain Node we retry with `AIM_SQLITE_NATIVE_BINDING` (a path to a Node
 * build of better_sqlite3.node) and finally fall back to the structurally compatible `node:sqlite`.
 * Set AIM_SQLITE_DRIVER=node to force the fallback.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { SqliteDb } from '../deps.js';
import { LEARNING_SCHEMA_SQL } from '../schema.js';

const require = createRequire(import.meta.url);

export interface TestDb extends SqliteDb {
  close(): void;
  readonly driver: 'better-sqlite3' | 'node:sqlite';
  readonly file: string;
}

export function openTestDb(): TestDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-learning-'));
  const file = path.join(dir, 'test.sqlite');
  const db = openDriver(file);
  for (const sql of LEARNING_SCHEMA_SQL) db.exec(sql);
  // Idempotency check — running the schema twice must not throw.
  for (const sql of LEARNING_SCHEMA_SQL) db.exec(sql);
  const close = () => {
    try {
      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  return { prepare: (s) => db.prepare(s), exec: (s) => db.exec(s), close, driver: db.driver, file };
}

interface Driver {
  prepare: SqliteDb['prepare'];
  exec: SqliteDb['exec'];
  close(): void;
  driver: TestDb['driver'];
}

function openDriver(file: string): Driver {
  type BetterSqlite = new (file: string, opts?: { nativeBinding?: string }) => SqliteDb & { close(): void };
  let Database: BetterSqlite | null = null;
  if (process.env.AIM_SQLITE_DRIVER !== 'node') {
    try {
      Database = require('better-sqlite3') as BetterSqlite;
    } catch {
      Database = null;
    }
  }
  if (Database) {
    const attempts: ({ nativeBinding?: string } | undefined)[] = [undefined];
    if (process.env.AIM_SQLITE_NATIVE_BINDING) attempts.push({ nativeBinding: process.env.AIM_SQLITE_NATIVE_BINDING });
    for (const opts of attempts) {
      try {
        const db = new Database(file, opts);
        return { prepare: (s) => db.prepare(s), exec: (s) => db.exec(s), close: () => db.close(), driver: 'better-sqlite3' };
      } catch {
        // try the next option
      }
    }
  }
  const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (file: string) => SqliteDb & { close(): void } };
  const db = new DatabaseSync(file);
  return { prepare: (s) => db.prepare(s), exec: (s) => db.exec(s), close: () => db.close(), driver: 'node:sqlite' };
}

/**
 * SQLite bootstrap. `openDatabase` opens (creating when needed) the database, enables WAL + foreign keys,
 * applies the versioned chat schema migrations and then every statement of LEARNING_SCHEMA_SQL
 * (owned by the learning layer). Everything is idempotent — calling it on an existing database is a no-op.
 */
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openSqlite, sqliteDriver } from './sqlite-compat.js';
import { LEARNING_SCHEMA_SQL } from './learning/index.js';
import { createLogger } from './logger.js';

const log = createLogger('core:db');

/**
 * Chat-side migrations. Index = version - 1. Append new entries; never edit shipped ones.
 * Columns use snake_case; the ChatStore maps them to the camelCase types in @aim/shared.
 */
export const CHAT_MIGRATIONS: string[][] = [
  // v1 — initial schema
  [
    `CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'idle',
      session_id TEXT,
      cwd TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      origin TEXT NOT NULL DEFAULT 'user',
      goal_id TEXT,
      last_message_preview TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_chats_updated ON chats(updated_at DESC)`,
    `CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      agent_id TEXT,
      usage TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at)`,
    `CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      agent_id TEXT,
      ord INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      detail TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_chat ON tasks(chat_id, ord)`,
    `CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      name TEXT NOT NULL,
      state TEXT NOT NULL,
      task TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      session_id TEXT,
      last_activity TEXT,
      parent_agent_id TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_agents_chat ON agents(chat_id, started_at)`,
  ],
];

/**
 * Full-text index on message text. Kept in sync by triggers so the store never has to think about it.
 * Created outside the versioned migrations because FTS5 may be unavailable in some SQLite builds;
 * the ChatStore detects its absence and falls back to LIKE.
 */
const FTS_SQL = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, message_id UNINDEXED, chat_id UNINDEXED)`,
  `CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
     INSERT INTO messages_fts(text, message_id, chat_id) VALUES (new.text, new.id, new.chat_id);
   END`,
  `CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
     DELETE FROM messages_fts WHERE message_id = old.id;
   END`,
  `CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE OF text ON messages BEGIN
     DELETE FROM messages_fts WHERE message_id = old.id;
     INSERT INTO messages_fts(text, message_id, chat_id) VALUES (new.text, new.id, new.chat_id);
   END`,
];

export const META_KEY_CHAT_SCHEMA = 'chat_schema_version';
export const META_KEY_FTS = 'messages_fts';

function getMeta(db: Database.Database, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}
function setMeta(db: Database.Database, key: string, value: string): void {
  db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

/** Opens the database, applies pragmas and all migrations. `:memory:` is accepted (tests). */
export function openDatabase(filePath: string): Database.Database {
  if (filePath !== ':memory:') {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }
  const db = openSqlite(filePath);
  log.info(`sqlite driver: ${sqliteDriver()}`);
  try {
    db.pragma('journal_mode = WAL');
  } catch (err) {
    // In-memory databases cannot use WAL; harmless.
    log.debug('WAL not enabled', err);
  }
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);

  // Versioned chat migrations.
  const current = Number(getMeta(db, META_KEY_CHAT_SCHEMA) ?? '0');
  const apply = db.transaction(() => {
    for (let v = current; v < CHAT_MIGRATIONS.length; v++) {
      for (const sql of CHAT_MIGRATIONS[v]) db.exec(sql);
      setMeta(db, META_KEY_CHAT_SCHEMA, String(v + 1));
    }
  });
  apply();

  // FTS5 (optional).
  if (getMeta(db, META_KEY_FTS) !== '0') {
    try {
      for (const sql of FTS_SQL) db.exec(sql);
      setMeta(db, META_KEY_FTS, '1');
    } catch (err) {
      log.warn('FTS5 unavailable — message search falls back to LIKE', err);
      setMeta(db, META_KEY_FTS, '0');
    }
  }

  // Learning-layer schema (owned by src/learning). Each statement must be idempotent.
  for (const sql of LEARNING_SCHEMA_SQL) {
    try {
      db.exec(sql);
    } catch (err) {
      log.error('learning schema statement failed', err, sql.slice(0, 120));
    }
  }
  return db;
}

/** True when the FTS5 message index exists in this database. */
export function hasMessageFts(db: Database.Database): boolean {
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'`).get();
  return !!row;
}

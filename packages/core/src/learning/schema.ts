/**
 * SQLite schema for the self-learning layer. Every statement is idempotent so `openDatabase` can run
 * them on every launch. The FTS5 virtual table lives in `LEARNING_FTS_SQL` and is created separately
 * by `ensureLearningFts()` so that a SQLite build without FTS5 degrades to LIKE search instead of
 * failing the whole migration.
 */
import type { SqliteDb } from './deps.js';

export const LEARNING_SCHEMA_SQL: string[] = [
  `CREATE TABLE IF NOT EXISTS memories (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'fact',
    confidence REAL NOT NULL DEFAULT 0.6,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    hits INTEGER NOT NULL DEFAULT 1,
    source TEXT NOT NULL DEFAULT 'aim'
  )`,
  `CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at)`,

  `CREATE TABLE IF NOT EXISTS behavior_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    app TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    url TEXT,
    host TEXT,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    idle INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_behavior_ts ON behavior_samples(ts)`,
  `CREATE INDEX IF NOT EXISTS idx_behavior_host ON behavior_samples(host)`,

  `CREATE TABLE IF NOT EXISTS directives (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    priority INTEGER NOT NULL DEFAULT 2,
    last_pursued_at INTEGER
  )`,

  `CREATE TABLE IF NOT EXISTS goals (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    title TEXT NOT NULL,
    rationale TEXT NOT NULL DEFAULT '',
    directive_id TEXT,
    status TEXT NOT NULL DEFAULT 'planned',
    priority INTEGER NOT NULL DEFAULT 2,
    effort TEXT NOT NULL DEFAULT 'medium',
    chat_id TEXT,
    notes TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    scheduled_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_goals_date ON goals(date)`,
  `CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status)`,

  `CREATE TABLE IF NOT EXISTS daily_plans (
    date TEXT PRIMARY KEY,
    summary TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  )`,
];

/**
 * FTS5 index over memories, kept in sync with triggers. A plain (non external-content) FTS table is
 * used on purpose: it survives VACUUM (which may renumber rowids of tables with a TEXT primary key)
 * and keeps the delete path trivial.
 */
export const LEARNING_FTS_SQL: string[] = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(key, value, tokenize = 'unicode61')`,
  `CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories BEGIN
     INSERT INTO memories_fts(key, value) VALUES (new.key, new.value);
   END`,
  `CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories BEGIN
     DELETE FROM memories_fts WHERE key = old.key;
   END`,
  `CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE ON memories BEGIN
     DELETE FROM memories_fts WHERE key = old.key;
     INSERT INTO memories_fts(key, value) VALUES (new.key, new.value);
   END`,
];

/**
 * Create the FTS5 table + triggers if the SQLite build supports FTS5. Returns true when full-text
 * search is available. Never throws.
 */
export function ensureLearningFts(db: SqliteDb): boolean {
  try {
    for (const sql of LEARNING_FTS_SQL) db.exec(sql);
    // Backfill rows inserted while the index did not exist (e.g. first upgrade).
    const memCount = countOf(db, 'memories');
    const ftsCount = countOf(db, 'memories_fts');
    if (memCount !== ftsCount) {
      db.exec('DELETE FROM memories_fts');
      db.exec('INSERT INTO memories_fts(key, value) SELECT key, value FROM memories');
    }
    return true;
  } catch {
    return false;
  }
}

function countOf(db: SqliteDb, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

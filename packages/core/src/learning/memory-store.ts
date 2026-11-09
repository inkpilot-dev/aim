import type { MemoryEntry, MemoryKind } from '@aim/shared';
import type { SqliteDb } from './deps.js';
import { clamp01 } from './deps.js';
import { ensureLearningFts } from './schema.js';

interface MemoryRow {
  key: string;
  value: string;
  kind: string;
  confidence: number;
  created_at: number;
  updated_at: number;
  hits: number;
  source: string;
}

const KINDS: readonly MemoryKind[] = ['preference', 'fact', 'lesson', 'procedure', 'goal_feedback'];
const KIND_LABEL: Record<MemoryKind, string> = {
  preference: 'Preferences',
  procedure: 'Procedures that worked',
  fact: 'Facts',
  lesson: 'Lessons learned',
  goal_feedback: 'Goal feedback',
};
const SOURCES: readonly MemoryEntry['source'][] = ['user', 'aim', 'reflection', 'observer'];

const DAY_MS = 86_400_000;
/** Confidence bump applied each time a memory is reinforced. */
const REINFORCE_BUMP = 0.05;

export interface MemoryStoreOptions {
  /** Injectable clock (tests). */
  now?: () => number;
}

/**
 * Long-term memory: keyed facts/preferences/lessons with reinforcement counts, full-text recall and a
 * prompt-sized digest.
 */
export class MemoryStore {
  private readonly db: SqliteDb;
  private readonly now: () => number;
  /** True when the FTS5 index is available; otherwise recall() falls back to LIKE. */
  readonly ftsEnabled: boolean;

  constructor(db: SqliteDb, opts: MemoryStoreOptions = {}) {
    this.db = db;
    this.now = opts.now ?? (() => Date.now());
    this.ftsEnabled = ensureLearningFts(db);
  }

  /** Insert or reinforce a memory. Reinforcement increments `hits`, keeps the newest value and raises confidence slightly. */
  remember(e: Pick<MemoryEntry, 'key' | 'value' | 'kind'> & Partial<MemoryEntry>): MemoryEntry {
    const key = normalizeKey(e.key);
    if (!key) throw new Error('Memory key must not be empty');
    const value = String(e.value ?? '').trim();
    if (!value) throw new Error('Memory value must not be empty');
    const kind = normalizeKind(e.kind);
    const source = SOURCES.includes(e.source as MemoryEntry['source']) ? (e.source as MemoryEntry['source']) : 'aim';
    const now = this.now();
    const existing = this.get(key);

    let entry: MemoryEntry;
    if (existing) {
      const base = Math.max(existing.confidence, typeof e.confidence === 'number' ? clamp01(e.confidence) : 0);
      entry = {
        key,
        value,
        kind,
        confidence: clamp01(base + REINFORCE_BUMP),
        createdAt: existing.createdAt,
        updatedAt: now,
        hits: existing.hits + 1,
        source,
      };
      this.db
        .prepare(
          `UPDATE memories SET value = ?, kind = ?, confidence = ?, updated_at = ?, hits = ?, source = ? WHERE key = ?`,
        )
        .run(entry.value, entry.kind, entry.confidence, entry.updatedAt, entry.hits, entry.source, key);
    } else {
      entry = {
        key,
        value,
        kind,
        confidence: typeof e.confidence === 'number' ? clamp01(e.confidence) : 0.6,
        createdAt: typeof e.createdAt === 'number' ? e.createdAt : now,
        updatedAt: now,
        hits: typeof e.hits === 'number' && e.hits > 0 ? Math.floor(e.hits) : 1,
        source,
      };
      this.db
        .prepare(
          `INSERT INTO memories (key, value, kind, confidence, created_at, updated_at, hits, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(key, entry.value, entry.kind, entry.confidence, entry.createdAt, entry.updatedAt, entry.hits, entry.source);
    }
    return entry;
  }

  get(key: string): MemoryEntry | null {
    const row = this.db.prepare('SELECT * FROM memories WHERE key = ?').get(normalizeKey(key)) as MemoryRow | undefined;
    return row ? rowToEntry(row) : null;
  }

  /** Keyword search ranked by match score × confidence × recency (with a small reinforcement boost). */
  recall(query: string, limit = 10): MemoryEntry[] {
    const tokens = tokenize(query);
    if (tokens.length === 0) return this.rankAll().slice(0, Math.max(0, limit));
    const now = this.now();
    let scored: { entry: MemoryEntry; match: number }[] = [];
    if (this.ftsEnabled) scored = this.recallFts(tokens);
    if (scored.length === 0) scored = this.recallLike(tokens);
    return scored
      .map(({ entry, match }) => ({ entry, score: match * Math.max(0.05, entry.confidence) * recencyFactor(entry.updatedAt, now) * hitsBoost(entry.hits) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(0, limit))
      .map((s) => s.entry);
  }

  forget(key: string): boolean {
    const res = this.db.prepare('DELETE FROM memories WHERE key = ?').run(normalizeKey(key));
    return Number(res.changes) > 0;
  }

  list(): MemoryEntry[] {
    const rows = this.db.prepare('SELECT * FROM memories ORDER BY updated_at DESC').all() as MemoryRow[];
    return rows.map(rowToEntry);
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }

  /**
   * Markdown digest for the system prompt: bullets grouped by kind, most useful first, truncated to `maxChars`.
   * Returns '' when there are no memories.
   */
  digest(maxChars = 6000): string {
    const ranked = this.rankAll();
    if (ranked.length === 0) return '';
    const groups = new Map<MemoryKind, MemoryEntry[]>();
    for (const m of ranked) {
      const list = groups.get(m.kind) ?? [];
      list.push(m);
      groups.set(m.kind, list);
    }
    const order: MemoryKind[] = ['preference', 'procedure', 'fact', 'lesson', 'goal_feedback'];
    const lines: string[] = [];
    for (const kind of order) {
      const items = groups.get(kind);
      if (!items || items.length === 0) continue;
      lines.push(`### ${KIND_LABEL[kind]}`);
      for (const m of items) lines.push(`- **${m.key}**: ${singleLine(m.value)}`);
      lines.push('');
    }
    let out = '';
    let used = 0;
    let omitted = 0;
    let truncated = false;
    for (const line of lines) {
      if (truncated) {
        if (line.startsWith('- ')) omitted++;
        continue;
      }
      const add = line + '\n';
      if (used + add.length > maxChars - 40) {
        truncated = true;
        if (line.startsWith('- ')) omitted++;
        continue;
      }
      out += add;
      used += add.length;
    }
    if (truncated && omitted > 0) out += `- …and ${omitted} more memories.\n`;
    return out.trimEnd();
  }

  // ─── internals ───

  private rankAll(): MemoryEntry[] {
    const now = this.now();
    return this.list()
      .map((entry) => ({ entry, score: hitsBoost(entry.hits) * Math.max(0.05, entry.confidence) * recencyFactor(entry.updatedAt, now) }))
      .sort((a, b) => b.score - a.score)
      .map((s) => s.entry);
  }

  private recallFts(tokens: string[]): { entry: MemoryEntry; match: number }[] {
    const match = tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' OR ');
    try {
      const rows = this.db
        .prepare(
          `SELECT m.*, bm25(memories_fts) AS rank FROM memories_fts f JOIN memories m ON m.key = f.key WHERE memories_fts MATCH ? ORDER BY rank LIMIT 200`,
        )
        .all(match) as (MemoryRow & { rank: number })[];
      // bm25 is negative; more negative = better. Normalize to a positive score.
      return rows.map((r) => ({ entry: rowToEntry(r), match: Math.max(0.01, -Number(r.rank)) }));
    } catch {
      return [];
    }
  }

  private recallLike(tokens: string[]): { entry: MemoryEntry; match: number }[] {
    const where = tokens.map(() => '(lower(key) LIKE ? OR lower(value) LIKE ?)').join(' OR ');
    const params: string[] = [];
    for (const t of tokens) params.push(`%${t}%`, `%${t}%`);
    const rows = this.db.prepare(`SELECT * FROM memories WHERE ${where} LIMIT 500`).all(...params) as MemoryRow[];
    return rows.map((r) => {
      const key = r.key.toLowerCase();
      const value = r.value.toLowerCase();
      let match = 0;
      for (const t of tokens) {
        if (key.includes(t)) match += 2;
        if (value.includes(t)) match += 1;
      }
      return { entry: rowToEntry(r), match: Math.max(0.01, match) };
    });
  }
}

// ─── helpers ───

export function normalizeKey(key: string): string {
  return String(key ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 120);
}

function normalizeKind(kind: unknown): MemoryKind {
  return KINDS.includes(kind as MemoryKind) ? (kind as MemoryKind) : 'fact';
}

function rowToEntry(r: MemoryRow): MemoryEntry {
  return {
    key: r.key,
    value: r.value,
    kind: normalizeKind(r.kind),
    confidence: Number(r.confidence),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    hits: Number(r.hits),
    source: SOURCES.includes(r.source as MemoryEntry['source']) ? (r.source as MemoryEntry['source']) : 'aim',
  };
}

function tokenize(q: string): string[] {
  return Array.from(
    new Set(
      String(q ?? '')
        .toLowerCase()
        .split(/[^\p{L}\p{N}_]+/u)
        .map((t) => t.trim())
        .filter((t) => t.length >= 2),
    ),
  ).slice(0, 12);
}

/** 1.0 for fresh memories decaying towards 0.4 over a few months. */
function recencyFactor(updatedAt: number, now: number): number {
  const ageDays = Math.max(0, (now - updatedAt) / DAY_MS);
  return 0.4 + 0.6 * Math.exp(-ageDays / 45);
}

function hitsBoost(hits: number): number {
  return 1 + Math.log1p(Math.max(0, hits - 1)) * 0.5;
}

function singleLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

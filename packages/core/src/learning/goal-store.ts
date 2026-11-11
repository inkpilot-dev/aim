import type { DailyPlan, Goal, GoalStatus } from '@aim/shared';
import type { SqliteDb } from './deps.js';
import { normalizePriority } from './directive-store.js';

interface GoalRow {
  id: string;
  date: string;
  title: string;
  rationale: string;
  directive_id: string | null;
  status: string;
  priority: number;
  effort: string;
  chat_id: string | null;
  notes: string | null;
  created_at: number;
  updated_at: number;
  scheduled_at: number | null;
  origin?: string | null;
}
interface PlanRow {
  date: string;
  summary: string;
  created_at: number;
}

const STATUSES: readonly GoalStatus[] = ['planned', 'in_progress', 'done', 'failed', 'deferred'];
const EFFORTS: readonly Goal['effort'][] = ['small', 'medium', 'large'];

/** Goals (keyed by id, indexed by date) and the per-day plan summary. */
export class GoalStore {
  constructor(private readonly db: SqliteDb) {
    // Databases created before goals had an origin get the column added in place.
    try {
      const cols = this.db.prepare('PRAGMA table_info(goals)').all() as { name: string }[];
      if (cols.length && !cols.some((c) => c.name === 'origin')) this.db.exec('ALTER TABLE goals ADD COLUMN origin TEXT');
    } catch {
      /* table missing or read-only: origin is simply not persisted */
    }
  }

  /**
   * List goals, optionally for one date. `includeDone` (default true) — when false, goals with status
   * done/failed are omitted. Ordered by date desc, priority, scheduledAt, createdAt.
   */
  list(opts: { date?: string; includeDone?: boolean } = {}): Goal[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.date) {
      where.push('date = ?');
      params.push(opts.date);
    }
    if (opts.includeDone === false) where.push(`status NOT IN ('done', 'failed')`);
    const sql = `SELECT * FROM goals ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY date DESC, priority ASC, COALESCE(scheduled_at, created_at) ASC, created_at ASC`;
    return (this.db.prepare(sql).all(...params) as GoalRow[]).map(rowToGoal);
  }

  get(id: string): Goal | null {
    const row = this.db.prepare('SELECT * FROM goals WHERE id = ?').get(id) as GoalRow | undefined;
    return row ? rowToGoal(row) : null;
  }

  upsert(g: Goal): Goal {
    const goal = normalizeGoal(g);
    this.db
      .prepare(
        `INSERT INTO goals (id, date, title, rationale, directive_id, status, priority, effort, chat_id, notes, created_at, updated_at, scheduled_at, origin)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET date = excluded.date, title = excluded.title, rationale = excluded.rationale,
           directive_id = excluded.directive_id, status = excluded.status, priority = excluded.priority, effort = excluded.effort,
           chat_id = excluded.chat_id, notes = excluded.notes, created_at = excluded.created_at, updated_at = excluded.updated_at,
           scheduled_at = excluded.scheduled_at, origin = COALESCE(excluded.origin, goals.origin)`,
      )
      .run(
        goal.id,
        goal.date,
        goal.title,
        goal.rationale,
        goal.directiveId ?? null,
        goal.status,
        goal.priority,
        goal.effort,
        goal.chatId ?? null,
        goal.notes ?? null,
        goal.createdAt,
        goal.updatedAt,
        goal.scheduledAt ?? null,
        goal.origin ?? null,
      );
    return goal;
  }

  update(id: string, patch: Partial<Goal>): Goal {
    const existing = this.get(id);
    if (!existing) throw new Error(`Goal not found: ${id}`);
    const merged: Goal = { ...existing, ...stripUndefined(patch), id, updatedAt: Date.now() };
    // Allow explicitly clearing optional fields with `undefined` present in the patch.
    for (const k of ['directiveId', 'chatId', 'notes', 'scheduledAt'] as const) {
      if (k in patch && patch[k] === undefined) delete merged[k];
    }
    return this.upsert(merged);
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM goals WHERE id = ?').run(id);
  }

  planForDate(date: string): DailyPlan | null {
    const row = this.db.prepare('SELECT * FROM daily_plans WHERE date = ?').get(date) as PlanRow | undefined;
    if (!row) return null;
    return { date: row.date, summary: row.summary, createdAt: Number(row.created_at), goals: this.list({ date }) };
  }

  /** Store the plan summary and upsert all of its goals (atomically). */
  savePlan(p: DailyPlan): void {
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `INSERT INTO daily_plans (date, summary, created_at) VALUES (?, ?, ?)
           ON CONFLICT(date) DO UPDATE SET summary = excluded.summary, created_at = excluded.created_at`,
        )
        .run(p.date, p.summary ?? '', p.createdAt || Date.now());
      for (const g of p.goals) this.upsert({ ...g, date: g.date || p.date });
      this.db.exec('COMMIT');
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // ignore
      }
      throw e;
    }
  }

  /** Dates that have a plan, newest first. */
  planDates(limit = 30): string[] {
    const rows = this.db.prepare('SELECT date FROM daily_plans ORDER BY date DESC LIMIT ?').all(limit) as { date: string }[];
    return rows.map((r) => r.date);
  }
}

export function normalizeStatus(s: unknown): GoalStatus {
  return STATUSES.includes(s as GoalStatus) ? (s as GoalStatus) : 'planned';
}
export function normalizeEffort(e: unknown): Goal['effort'] {
  return EFFORTS.includes(e as Goal['effort']) ? (e as Goal['effort']) : 'medium';
}

function normalizeGoal(g: Goal): Goal {
  const now = Date.now();
  const goal: Goal = {
    id: g.id,
    date: g.date,
    title: String(g.title ?? '').trim() || 'Untitled goal',
    rationale: String(g.rationale ?? ''),
    status: normalizeStatus(g.status),
    priority: normalizePriority(g.priority),
    effort: normalizeEffort(g.effort),
    createdAt: Number(g.createdAt) || now,
    updatedAt: Number(g.updatedAt) || now,
  };
  if (g.directiveId) goal.directiveId = g.directiveId;
  if (g.chatId) goal.chatId = g.chatId;
  if (g.notes) goal.notes = g.notes;
  if (typeof g.scheduledAt === 'number') goal.scheduledAt = g.scheduledAt;
  if (g.origin === 'user' || g.origin === 'aim') goal.origin = g.origin;
  return goal;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

function rowToGoal(r: GoalRow): Goal {
  const g: Goal = {
    id: r.id,
    date: r.date,
    title: r.title,
    rationale: r.rationale ?? '',
    status: normalizeStatus(r.status),
    priority: normalizePriority(r.priority),
    effort: normalizeEffort(r.effort),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
  if (r.directive_id) g.directiveId = r.directive_id;
  if (r.chat_id) g.chatId = r.chat_id;
  if (r.notes) g.notes = r.notes;
  if (r.scheduled_at !== null && r.scheduled_at !== undefined) g.scheduledAt = Number(r.scheduled_at);
  if (r.origin === 'user' || r.origin === 'aim') g.origin = r.origin;
  return g;
}

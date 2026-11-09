import type { Directive } from '@aim/shared';
import { newId } from '@aim/shared';
import type { SqliteDb } from './deps.js';

interface DirectiveRow {
  id: string;
  text: string;
  created_at: number;
  active: number;
  priority: number;
  last_pursued_at: number | null;
}

export type DirectivePriority = Directive['priority'];

/** Standing instructions from the user ("Keep my inbox at zero"). */
export class DirectiveStore {
  constructor(private readonly db: SqliteDb) {}

  /** All directives: active first, then by priority (1 = highest), then oldest first. */
  list(): Directive[] {
    const rows = this.db
      .prepare('SELECT * FROM directives ORDER BY active DESC, priority ASC, created_at ASC')
      .all() as DirectiveRow[];
    return rows.map(rowToDirective);
  }

  listActive(): Directive[] {
    return this.list().filter((d) => d.active);
  }

  get(id: string): Directive | null {
    const row = this.db.prepare('SELECT * FROM directives WHERE id = ?').get(id) as DirectiveRow | undefined;
    return row ? rowToDirective(row) : null;
  }

  add(text: string, priority: DirectivePriority = 2): Directive {
    const t = String(text ?? '').trim();
    if (!t) throw new Error('Directive text must not be empty');
    const d: Directive = { id: newId('dir'), text: t, createdAt: Date.now(), active: true, priority: normalizePriority(priority) };
    this.db
      .prepare('INSERT INTO directives (id, text, created_at, active, priority, last_pursued_at) VALUES (?, ?, ?, 1, ?, NULL)')
      .run(d.id, d.text, d.createdAt, d.priority);
    return d;
  }

  update(id: string, patch: Partial<Omit<Directive, 'id'>>): Directive {
    const existing = this.get(id);
    if (!existing) throw new Error(`Directive not found: ${id}`);
    const next: Directive = {
      ...existing,
      ...(patch.text !== undefined ? { text: String(patch.text).trim() || existing.text } : {}),
      ...(patch.active !== undefined ? { active: Boolean(patch.active) } : {}),
      ...(patch.priority !== undefined ? { priority: normalizePriority(patch.priority) } : {}),
      ...(patch.createdAt !== undefined ? { createdAt: patch.createdAt } : {}),
    };
    if ('lastPursuedAt' in patch) {
      if (patch.lastPursuedAt === undefined) delete next.lastPursuedAt;
      else next.lastPursuedAt = patch.lastPursuedAt;
    }
    this.db
      .prepare('UPDATE directives SET text = ?, created_at = ?, active = ?, priority = ?, last_pursued_at = ? WHERE id = ?')
      .run(next.text, next.createdAt, next.active ? 1 : 0, next.priority, next.lastPursuedAt ?? null, id);
    return next;
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM directives WHERE id = ?').run(id);
  }
}

export function normalizePriority(p: unknown): DirectivePriority {
  const n = Math.round(Number(p));
  if (n <= 1) return 1;
  if (n >= 3) return 3;
  return 2;
}

function rowToDirective(r: DirectiveRow): Directive {
  const d: Directive = {
    id: r.id,
    text: r.text,
    createdAt: Number(r.created_at),
    active: Number(r.active) === 1,
    priority: normalizePriority(r.priority),
  };
  if (r.last_pursued_at !== null && r.last_pursued_at !== undefined) d.lastPursuedAt = Number(r.last_pursued_at);
  return d;
}

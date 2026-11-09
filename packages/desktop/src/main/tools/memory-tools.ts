/** memory_* / behavior_summary / goals_list / goals_update → learning stores (from @aim/core). */
import type { BehaviorObserver, DirectiveStore, GoalStore, MemoryStore } from '@aim/core';
import type { Goal, MemoryKind } from '@aim/shared';
import type { ToolImpl } from './tool-router.js';

export interface MemoryToolDeps {
  memory: () => MemoryStore | null;
  observer: () => BehaviorObserver | null;
  directives: () => DirectiveStore | null;
  goals: () => GoalStore | null;
  onMemoryChanged?: () => void;
  onGoalsChanged?: () => void;
}

const KINDS: MemoryKind[] = ['preference', 'fact', 'lesson', 'procedure', 'goal_feedback'];
const GOAL_STATUS: Goal['status'][] = ['planned', 'in_progress', 'done', 'failed', 'deferred'];
const UNAVAILABLE = 'Memory is unavailable (core failed to start).';

export function createMemoryTools(deps: MemoryToolDeps): Record<string, ToolImpl> {
  const memory_remember: ToolImpl = async (args) => {
    const m = deps.memory();
    if (!m) return { ok: false, error: UNAVAILABLE };
    const key = String(args['key'] ?? '').trim().toLowerCase().replace(/\s+/g, '_').slice(0, 80);
    const value = String(args['value'] ?? '').trim();
    if (!key || !value) return { ok: false, error: 'key and value are required.' };
    const kind = KINDS.includes(args['kind'] as MemoryKind) ? (args['kind'] as MemoryKind) : 'fact';
    const confidence = typeof args['confidence'] === 'number' ? Math.min(1, Math.max(0, args['confidence'] as number)) : 0.8;
    const entry = m.remember({ key, value, kind, confidence, source: 'aim' });
    deps.onMemoryChanged?.();
    return { ok: true, text: `Remembered ${kind} "${entry.key}".`, data: entry };
  };

  const memory_recall: ToolImpl = async (args) => {
    const m = deps.memory();
    if (!m) return { ok: false, error: UNAVAILABLE };
    const query = String(args['query'] ?? '').trim();
    const limit = typeof args['limit'] === 'number' ? Math.min(100, Math.max(1, args['limit'] as number)) : 20;
    const entries = m.recall(query, limit);
    if (!entries.length) return { ok: true, text: `No memories match "${query}".`, data: { entries } };
    const text = entries.map((e) => `- [${e.kind}] ${e.key}: ${e.value} (learned ${new Date(e.updatedAt).toISOString().slice(0, 10)}, confidence ${e.confidence})`).join('\n');
    return { ok: true, text, data: { entries } };
  };

  const memory_forget: ToolImpl = async (args) => {
    const m = deps.memory();
    if (!m) return { ok: false, error: UNAVAILABLE };
    const key = String(args['key'] ?? '').trim();
    const removed = m.forget(key);
    if (removed) deps.onMemoryChanged?.();
    return removed ? { ok: true, text: `Forgot "${key}".` } : { ok: false, error: `No memory with key "${key}".` };
  };

  const behavior_summary: ToolImpl = async (args) => {
    const o = deps.observer();
    if (!o) return { ok: false, error: 'Behaviour observer is unavailable.' };
    const days = typeof args['days'] === 'number' ? Math.min(90, Math.max(1, Math.round(args['days'] as number))) : 7;
    const s = o.summary(days);
    const hours = Math.round(s.totalActiveMs / 36000) / 100;
    const text = [
      `Last ${s.days} day(s): ${hours} h of observed activity.`,
      s.topApps.length ? `Top apps: ${s.topApps.slice(0, 8).map((a) => `${a.app} (${Math.round(a.share * 100)}%)`).join(', ')}.` : 'No app samples yet.',
      s.topSites.length ? `Top sites: ${s.topSites.slice(0, 8).map((a) => `${a.host} (${Math.round(a.share * 100)}%)`).join(', ')}.` : '',
      s.routines.length ? `Routines:\n${s.routines.map((r) => `- ${r}`).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    return { ok: true, text, data: s };
  };

  const goals_list: ToolImpl = async (args) => {
    const d = deps.directives();
    const g = deps.goals();
    if (!d || !g) return { ok: false, error: 'Goals are unavailable (core failed to start).' };
    const directives = d.list();
    const goals = g.list({ includeDone: args['includeDone'] === true });
    const text = [
      directives.length ? `Directives:\n${directives.map((x) => `- [P${x.priority}${x.active ? '' : ', inactive'}] ${x.text} (${x.id})`).join('\n')}` : 'No standing directives.',
      goals.length ? `Goals:\n${goals.map((x) => `- ${x.date} [${x.status}] ${x.title} (${x.id}, P${x.priority}, ${x.effort})${x.notes ? ` — ${x.notes}` : ''}`).join('\n')}` : 'No goals.',
    ].join('\n\n');
    return { ok: true, text, data: { directives, goals } };
  };

  const goals_update: ToolImpl = async (args) => {
    const g = deps.goals();
    if (!g) return { ok: false, error: 'Goals are unavailable (core failed to start).' };
    const goalId = String(args['goalId'] ?? '');
    const status = args['status'] as Goal['status'];
    if (!GOAL_STATUS.includes(status)) return { ok: false, error: `status must be one of ${GOAL_STATUS.join(', ')}.` };
    if (!g.get(goalId)) return { ok: false, error: `No goal with id "${goalId}".` };
    const goal = g.update(goalId, { status, notes: typeof args['notes'] === 'string' ? (args['notes'] as string) : undefined, updatedAt: Date.now() });
    deps.onGoalsChanged?.();
    return { ok: true, text: `Goal "${goal.title}" is now ${goal.status}.`, data: goal };
  };

  return { memory_remember, memory_recall, memory_forget, behavior_summary, goals_list, goals_update };
}

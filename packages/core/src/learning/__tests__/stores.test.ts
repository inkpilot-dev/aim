import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Goal } from '@aim/shared';
import { DirectiveStore } from '../directive-store.js';
import { GoalStore } from '../goal-store.js';
import { openTestDb, type TestDb } from './test-db.js';

describe('DirectiveStore', () => {
  let db: TestDb;
  beforeEach(() => {
    db = openTestDb();
  });
  afterEach(() => db.close());

  it('CRUD', () => {
    const s = new DirectiveStore(db);
    const a = s.add('Keep my inbox at zero', 1);
    const b = s.add('Find ML internships weekly');
    expect(b.priority).toBe(2);
    expect(s.list().map((d) => d.id)).toEqual([a.id, b.id]);
    const u = s.update(b.id, { active: false, priority: 3, lastPursuedAt: 123 });
    expect(u).toMatchObject({ active: false, priority: 3, lastPursuedAt: 123 });
    expect(s.get(b.id)).toMatchObject({ active: false, priority: 3, lastPursuedAt: 123 });
    expect(s.listActive().map((d) => d.id)).toEqual([a.id]);
    expect(s.list()[0].id).toBe(a.id); // active first
    const cleared = s.update(b.id, { lastPursuedAt: undefined });
    expect(cleared.lastPursuedAt).toBeUndefined();
    s.remove(a.id);
    expect(s.get(a.id)).toBeNull();
    expect(() => s.update('nope', { text: 'x' })).toThrow(/not found/);
    expect(() => s.add('   ')).toThrow();
  });
});

describe('GoalStore', () => {
  let db: TestDb;
  beforeEach(() => {
    db = openTestDb();
  });
  afterEach(() => db.close());

  const mk = (over: Partial<Goal>): Goal => ({
    id: over.id ?? `g_${Math.random().toString(16).slice(2)}`,
    date: '2026-11-09',
    title: 'Do a thing',
    rationale: 'because',
    status: 'planned',
    priority: 2,
    effort: 'small',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  });

  it('upsert / get / update / list ordering and filters', () => {
    const s = new GoalStore(db);
    const a = s.upsert(mk({ id: 'a', priority: 2 }));
    s.upsert(mk({ id: 'b', priority: 1, directiveId: 'dir_1' }));
    s.upsert(mk({ id: 'c', priority: 3, status: 'done', date: '2026-11-08' }));
    expect(s.get('a')).toEqual(a);
    expect(s.list({ date: '2026-11-09' }).map((g) => g.id)).toEqual(['b', 'a']);
    expect(s.list().map((g) => g.id)).toEqual(['b', 'a', 'c']);
    expect(s.list({ includeDone: false }).map((g) => g.id)).toEqual(['b', 'a']);
    const u = s.update('a', { status: 'in_progress', chatId: 'chat_1', notes: 'started' });
    expect(u).toMatchObject({ status: 'in_progress', chatId: 'chat_1', notes: 'started' });
    expect(u.updatedAt).toBeGreaterThan(1);
    expect(s.get('b')?.directiveId).toBe('dir_1');
    const cleared = s.update('a', { chatId: undefined });
    expect(cleared.chatId).toBeUndefined();
    expect(() => s.update('zz', {})).toThrow(/not found/);
    s.remove('a');
    expect(s.get('a')).toBeNull();
  });

  it('savePlan / planForDate', () => {
    const s = new GoalStore(db);
    expect(s.planForDate('2026-11-09')).toBeNull();
    s.savePlan({ date: '2026-11-09', summary: 'A good day', createdAt: 5, goals: [mk({ id: 'p1' }), mk({ id: 'p2', priority: 1 })] });
    const plan = s.planForDate('2026-11-09');
    expect(plan).not.toBeNull();
    expect(plan?.summary).toBe('A good day');
    expect(plan?.goals.map((g) => g.id)).toEqual(['p2', 'p1']);
    // overwrite summary, keep goals
    s.savePlan({ date: '2026-11-09', summary: 'Revised', createdAt: 6, goals: [] });
    expect(s.planForDate('2026-11-09')?.summary).toBe('Revised');
    expect(s.planForDate('2026-11-09')?.goals.length).toBe(2);
    expect(s.planDates()).toEqual(['2026-11-09']);
  });
});

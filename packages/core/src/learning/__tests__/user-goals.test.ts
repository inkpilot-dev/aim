import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { todayISO, type Goal } from '@aim/shared';
import { BehaviorObserver } from '../behavior-observer.js';
import { DirectiveStore } from '../directive-store.js';
import { GoalPlanner } from '../goal-planner.js';
import { GoalRunner } from '../goal-runner.js';
import { GoalStore } from '../goal-store.js';
import { MemoryStore } from '../memory-store.js';
import { FakeChatService, FakeRunner, okResult, settingsOf } from './fakes.js';
import { openTestDb, type TestDb } from './test-db.js';

const mk = (over: Partial<Goal> & Pick<Goal, 'id' | 'date' | 'title'>): Goal => ({ rationale: '', status: 'planned', priority: 2, effort: 'medium', createdAt: 1, updatedAt: 1, ...over });

describe('user-created goals', () => {
  let db: TestDb;
  let goals: GoalStore;
  beforeEach(() => {
    db = openTestDb();
    goals = new GoalStore(db);
  });
  afterEach(() => db.close());

  it('stores who created a goal, keeps it on update, and deletes goals', () => {
    goals.upsert(mk({ id: 'u1', date: '2026-11-11', title: 'Mine', origin: 'user' }));
    goals.upsert(mk({ id: 'a1', date: '2026-11-11', title: 'Planned', origin: 'aim' }));
    goals.update('u1', { status: 'in_progress' });
    expect(goals.get('u1')?.origin).toBe('user');
    expect(goals.get('a1')?.origin).toBe('aim');
    goals.remove('u1');
    expect(goals.get('u1')).toBeNull();
    expect(goals.list({ date: '2026-11-11' }).map((g) => g.id)).toEqual(['a1']);
  });

  it('adds the origin column to databases created before it existed', () => {
    const old = openTestDb();
    try {
      old.exec('DROP TABLE goals');
      old.exec(`CREATE TABLE goals (id TEXT PRIMARY KEY, date TEXT NOT NULL, title TEXT NOT NULL, rationale TEXT NOT NULL DEFAULT '', directive_id TEXT,
        status TEXT NOT NULL DEFAULT 'planned', priority INTEGER NOT NULL DEFAULT 2, effort TEXT NOT NULL DEFAULT 'medium', chat_id TEXT, notes TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, scheduled_at INTEGER)`);
      const store = new GoalStore(old);
      store.upsert(mk({ id: 'x', date: '2026-11-11', title: 'After upgrade', origin: 'user' }));
      expect(store.get('x')?.origin).toBe('user');
    } finally {
      old.close();
    }
  });

  it('re-planning the day keeps the user’s goals and tells the planner about them', async () => {
    const now = new Date(2026, 10, 11, 9, 0, 0);
    const today = todayISO(now);
    const directives = new DirectiveStore(db);
    const memory = new MemoryStore(db);
    goals.savePlan({ date: today, summary: 'first', createdAt: 1, goals: [mk({ id: 'aimOld', date: today, title: 'Old A.I.M. goal', origin: 'aim' })] });
    goals.upsert(mk({ id: 'mine', date: today, title: 'Apply to three internships', origin: 'user' }));
    const runner = new FakeRunner(() => okResult({ summary: 'new plan', goals: [{ title: 'Fresh goal', rationale: 'r', priority: 2, effort: 'small' }] }));
    const planner = new GoalPlanner({ runner, directives, goals, memory, observer: new BehaviorObserver({ db, provider: { getActiveWindow: async () => null } }), settings: settingsOf(), now: () => now });
    await planner.planToday(true);
    expect(goals.get('mine')?.status).toBe('planned');
    expect(goals.get('aimOld')?.status).toBe('deferred');
    expect(runner.calls[0].prompt).toContain('Apply to three internships');
    const fresh = goals.list({ date: today }).find((g) => g.title === 'Fresh goal');
    expect(fresh?.origin).toBe('aim');
  });

  it('runs a goal added while other goals are already running', async () => {
    const today = todayISO();
    const chats = new FakeChatService();
    const runner = new GoalRunner({ goals, chats, settings: settingsOf() });
    goals.upsert(mk({ id: 'first', date: today, title: 'First', priority: 1 }));
    // Add a second goal as soon as the first one starts.
    chats.script.push((chatId) => {
      goals.upsert(mk({ id: 'added', date: today, title: 'Added mid-run', origin: 'user' }));
      return [
        { type: 'status', chatId, status: 'working' },
        { type: 'status', chatId, status: 'done' },
      ];
    });
    await runner.runPending(today);
    expect(goals.get('first')?.status).toBe('done');
    expect(goals.get('added')?.status).toBe('done');
    expect(chats.sent.map((s) => s.text.includes('a goal the user set'))).toEqual([false, true]);
  });
});

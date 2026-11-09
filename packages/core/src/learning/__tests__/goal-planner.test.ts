import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DAILY_PLAN_JSON_SCHEMA, todayISO } from '@aim/shared';
import { BehaviorObserver } from '../behavior-observer.js';
import { DirectiveStore } from '../directive-store.js';
import { GoalPlanner } from '../goal-planner.js';
import { GoalStore } from '../goal-store.js';
import { MemoryStore } from '../memory-store.js';
import { CollectingLogger, FakeRunner, errResult, okResult, settingsOf, textResult } from './fakes.js';
import { openTestDb, type TestDb } from './test-db.js';

describe('GoalPlanner', () => {
  let db: TestDb;
  let directives: DirectiveStore;
  let goals: GoalStore;
  let memory: MemoryStore;
  const now = new Date(2026, 10, 9, 8, 0, 0);
  const today = todayISO(now);

  beforeEach(() => {
    db = openTestDb();
    directives = new DirectiveStore(db);
    goals = new GoalStore(db);
    memory = new MemoryStore(db);
  });
  afterEach(() => db.close());

  function planner(runner: FakeRunner, log = new CollectingLogger()) {
    return new GoalPlanner({
      runner,
      directives,
      goals,
      memory,
      observer: new BehaviorObserver({ db, provider: { getActiveWindow: async () => null } }),
      settings: settingsOf({ model: 'sonnet' }),
      log,
      now: () => now,
    });
  }

  it('builds a prompt with directives, memory, behaviour and yesterday, then saves the structured plan', async () => {
    const d = directives.add('Keep my inbox at zero', 1);
    memory.remember({ key: 'preferred_browser', value: 'Edge', kind: 'preference' });
    goals.upsert({ id: 'y1', date: '2026-11-08', title: 'Yesterday goal', rationale: '', status: 'failed', priority: 2, effort: 'small', createdAt: 1, updatedAt: 1, notes: 'site down' });

    const runner = new FakeRunner(() =>
      okResult({
        summary: 'Focus on email.',
        goals: [
          { title: 'Archive newsletters', rationale: 'Inbox zero', directiveId: d.id, priority: 2, effort: 'small' },
          { title: 'Reply to recruiter', rationale: 'Pending', priority: 1, effort: 'medium', directiveId: 'dir_unknown' },
          { title: 'Archive newsletters', rationale: 'duplicate', priority: 3, effort: 'small' },
          { title: '', rationale: 'no title', priority: 1, effort: 'small' },
        ],
      }),
    );
    const p = planner(runner);
    const plan = await p.planToday();

    expect(runner.calls).toHaveLength(1);
    const { prompt, opts } = runner.calls[0];
    expect(opts.jsonSchema).toBe(DAILY_PLAN_JSON_SCHEMA);
    expect(opts.model).toBe('sonnet');
    expect(opts.timeoutMs).toBe(180000);
    expect(prompt).toContain(d.id);
    expect(prompt).toContain('Keep my inbox at zero');
    expect(prompt).toContain('preferred_browser');
    expect(prompt).toContain('[failed] Yesterday goal — site down');
    expect(prompt).toMatch(/payments/i);

    expect(plan.date).toBe(today);
    expect(plan.summary).toBe('Focus on email.');
    expect(plan.goals).toHaveLength(2);
    expect(plan.goals[0].title).toBe('Reply to recruiter'); // priority 1 first
    expect(plan.goals[0].directiveId).toBeUndefined(); // unknown directive dropped
    expect(plan.goals[1].directiveId).toBe(d.id);
    expect(plan.goals.every((g) => g.status === 'planned' && g.date === today && g.id)).toBe(true);
    expect(plan.goals[1].scheduledAt!).toBeGreaterThan(plan.goals[0].scheduledAt!);
    expect(directives.get(d.id)?.lastPursuedAt).toBe(now.getTime());
    expect(goals.planForDate(today)?.goals).toHaveLength(2);

    // Cached: no second CLI call without force.
    const again = await p.planToday();
    expect(runner.calls).toHaveLength(1);
    expect(again.goals).toHaveLength(2);
    expect(p.existingPlan()).not.toBeNull();

    // Force re-plan: old planned goals are deferred.
    await p.planToday(true);
    expect(runner.calls).toHaveLength(2);
    const all = goals.list({ date: today });
    expect(all.filter((g) => g.status === 'deferred')).toHaveLength(2);
    expect(all.filter((g) => g.status === 'planned')).toHaveLength(2);
  });

  it('falls back to JSON embedded in resultText', async () => {
    const runner = new FakeRunner(() =>
      textResult('Here is the plan:\n```json\n{"summary":"S","goals":[{"title":"Tidy downloads","rationale":"r","priority":"2","effort":"huge"}]}\n```'),
    );
    const plan = await planner(runner).planToday();
    expect(plan.goals).toHaveLength(1);
    expect(plan.goals[0].effort).toBe('medium');
    expect(plan.goals[0].priority).toBe(2);
  });

  it('returns an empty plan (without throwing or saving) when the runner fails or returns garbage', async () => {
    const log = new CollectingLogger();
    const plan = await planner(new FakeRunner(() => errResult('claude not found')), log).planToday();
    expect(plan.goals).toEqual([]);
    expect(plan.summary).toMatch(/failed.*claude not found/i);
    expect(goals.planForDate(today)).toBeNull();
    expect(log.text()).toMatch(/error: .*planning failed/);

    const garbage = await planner(new FakeRunner(() => textResult('I cannot do that, sorry.'))).planToday();
    expect(garbage.goals).toEqual([]);
    expect(garbage.summary).toMatch(/not valid JSON/);

    const thrown = await planner(
      new FakeRunner(() => {
        throw new Error('spawn EACCES');
      }),
    ).planToday();
    expect(thrown.goals).toEqual([]);
    expect(thrown.summary).toContain('spawn EACCES');
  });
});

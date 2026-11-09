import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Goal } from '@aim/shared';
import { DirectiveStore } from '../directive-store.js';
import { GoalRunner } from '../goal-runner.js';
import { GoalStore } from '../goal-store.js';
import { FakeChatService, settingsOf } from './fakes.js';
import { openTestDb, type TestDb } from './test-db.js';

describe('GoalRunner', () => {
  let db: TestDb;
  let goals: GoalStore;
  let directives: DirectiveStore;
  let chats: FakeChatService;

  const mk = (over: Partial<Goal>): Goal =>
    goals.upsert({
      id: over.id ?? `g_${Math.random().toString(16).slice(2)}`,
      date: '2026-11-09',
      title: 'Archive newsletters',
      rationale: 'Inbox zero',
      status: 'planned',
      priority: 2,
      effort: 'small',
      createdAt: 1,
      updatedAt: 1,
      ...over,
    });

  beforeEach(() => {
    db = openTestDb();
    goals = new GoalStore(db);
    directives = new DirectiveStore(db);
    chats = new FakeChatService();
  });
  afterEach(() => db.close());

  it('runs a goal in a new goal chat and marks it done when the chat finishes', async () => {
    const d = directives.add('Keep my inbox at zero', 1);
    const g = mk({ id: 'g1', directiveId: d.id });
    const runner = new GoalRunner({ goals, chats, directives, settings: settingsOf({ defaultCwd: 'C:\\work' }) });
    const { chatId } = await runner.runGoal(g.id);

    expect(chats.chats[0]).toMatchObject({ id: chatId, title: 'Goal — Archive newsletters', origin: 'goal', goalId: 'g1', cwd: 'C:\\work' });
    expect(chats.sent).toHaveLength(1);
    const text = chats.sent[0].text;
    expect(text).toContain('Archive newsletters');
    expect(text).toContain('Inbox zero');
    expect(text).toContain('Keep my inbox at zero');
    expect(text).toContain('tasks_set');
    expect(text).toContain('goals_update');
    expect(text).toContain('g1');
    const after = goals.get('g1')!;
    expect(after.status).toBe('done');
    expect(after.chatId).toBe(chatId);
    expect(chats.listenerCount).toBe(0); // unsubscribed
  });

  it('marks failed on error, deferred on waiting_user, and respects a model-set status', async () => {
    mk({ id: 'err' });
    mk({ id: 'wait' });
    mk({ id: 'model' });
    chats.script.push((id) => [{ type: 'status', chatId: id, status: 'working' }, { type: 'status', chatId: id, status: 'error' }]);
    chats.script.push((id) => [{ type: 'status', chatId: id, status: 'waiting_user' }]);
    const runner = new GoalRunner({ goals, chats, settings: settingsOf() });
    await runner.runGoal('err');
    expect(goals.get('err')?.status).toBe('failed');
    await runner.runGoal('wait');
    expect(goals.get('wait')?.status).toBe('deferred');

    // The model updates the goal through goals_update before the chat ends → runner leaves it alone.
    chats.script.push((id) => {
      goals.update('model', { status: 'failed', notes: 'site unreachable' });
      return [{ type: 'status', chatId: id, status: 'done' }];
    });
    await runner.runGoal('model');
    expect(goals.get('model')).toMatchObject({ status: 'failed', notes: 'site unreachable' });
  });

  it('ignores events from other chats and idle before the turn started; times out', async () => {
    mk({ id: 'slow' });
    chats.script.push((id) => [
      { type: 'status', chatId: 'someone_else', status: 'done' },
      { type: 'status', chatId: id, status: 'idle' }, // before start → ignored
    ]);
    const runner = new GoalRunner({ goals, chats, settings: settingsOf(), goalTimeoutMs: 60 });
    await runner.runGoal('slow');
    expect(goals.get('slow')).toMatchObject({ status: 'failed' });
    expect(goals.get('slow')?.notes).toMatch(/Timed out/);
  });

  it('marks failed when sendMessage rejects, and throws for unknown goals', async () => {
    mk({ id: 'nosend' });
    chats.failSend = true;
    const runner = new GoalRunner({ goals, chats, settings: settingsOf() });
    await runner.runGoal('nosend');
    expect(goals.get('nosend')?.status).toBe('failed');
    await expect(runner.runGoal('missing')).rejects.toThrow(/not found/);
  });

  it('runPending runs planned goals sequentially by priority and skips non-planned ones', async () => {
    mk({ id: 'p2', priority: 2 });
    mk({ id: 'p1', priority: 1 });
    mk({ id: 'done', status: 'done' });
    mk({ id: 'other', date: '2026-11-08' });
    const runner = new GoalRunner({ goals, chats, settings: settingsOf() });
    const first = runner.runPending('2026-11-09');
    expect(runner.isRunning).toBe(true);
    expect(runner.runPending('2026-11-09')).toBe(first); // de-duplicated
    await first;
    expect(chats.sent).toHaveLength(2);
    expect(chats.chats.map((c) => c.goalId)).toEqual(['p1', 'p2']);
    expect(goals.get('p1')?.status).toBe('done');
    expect(goals.get('p2')?.status).toBe('done');
    expect(goals.get('done')?.chatId).toBeUndefined();
    expect(goals.get('other')?.status).toBe('planned');
  });
});

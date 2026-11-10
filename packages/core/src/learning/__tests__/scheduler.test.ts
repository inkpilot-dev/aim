import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DailyPlan } from '@aim/shared';
import { Scheduler, cronFromTime, isPastTime, parseHHmm } from '../scheduler.js';
import type { GoalPlanner } from '../goal-planner.js';
import type { GoalRunner } from '../goal-runner.js';
import { CollectingLogger, settingsOf } from './fakes.js';

describe('cronFromTime', () => {
  it('converts HH:mm into a daily cron expression', () => {
    expect(cronFromTime('08:00')).toBe('0 8 * * *');
    expect(cronFromTime('19:45')).toBe('45 19 * * *');
    expect(cronFromTime('7:05')).toBe('5 7 * * *');
    expect(cronFromTime('0:00')).toBe('0 0 * * *');
  });
  it('falls back to the default time for malformed input', () => {
    expect(cronFromTime('')).toBe('0 8 * * *');
    expect(cronFromTime('25:00')).toBe('0 8 * * *');
    expect(cronFromTime('nope')).toBe('0 8 * * *');
    expect(parseHHmm('12:60')).toBeNull();
  });
  it('isPastTime compares against the same day', () => {
    expect(isPastTime('08:00', new Date(2026, 0, 1, 9, 0))).toBe(true);
    expect(isPastTime('08:00', new Date(2026, 0, 1, 8, 0))).toBe(true);
    expect(isPastTime('08:00', new Date(2026, 0, 1, 7, 59))).toBe(false);
  });
});

describe('Scheduler', () => {
  afterEach(() => vi.useRealTimers());

  function fakes(planExists: boolean) {
    const plan: DailyPlan = { date: '2026-11-09', summary: 's', createdAt: 1, goals: [{ id: 'g', date: '2026-11-09', title: 't', rationale: '', status: 'planned', priority: 1, effort: 'small', createdAt: 1, updatedAt: 1 }] };
    const planner = { planToday: vi.fn(async () => plan), existingPlan: vi.fn(() => (planExists ? plan : null)) } as unknown as GoalPlanner;
    const runner = { runPending: vi.fn(async () => undefined) } as unknown as GoalRunner;
    return { plan, planner, runner };
  }

  it('catches up on start when today has no plan and the time passed; runs goals when autoRunGoals', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 9, 10, 0, 0));
    const { plan, planner, runner } = fakes(false);
    const log = new CollectingLogger();
    const s = new Scheduler({ planner, runner, settings: settingsOf({ dailyGoalsTime: '08:00' }), log, catchUpDelayMs: 50, pollMs: 1000 });
    const seen: DailyPlan[] = [];
    s.onPlan((p) => seen.push(p));
    s.start();
    expect(s.started).toBe(true);
    await vi.advanceTimersByTimeAsync(60);
    expect(planner.planToday).toHaveBeenCalledTimes(1);
    expect(runner.runPending).toHaveBeenCalledWith('2026-11-09');
    expect(seen).toEqual([plan]);
    expect(log.text()).toContain('0 8 * * *');
    s.stop();
    expect(s.started).toBe(false);
  });

  it('on start: runs the planned goals of an existing plan, plans even before the scheduled time, and stays idle when disabled', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 9, 10, 0, 0));
    // Existing plan with a planned goal → no re-plan, but the goal runs.
    const a = fakes(true);
    const s1 = new Scheduler({ planner: a.planner, runner: a.runner, settings: settingsOf({ dailyGoalsTime: '08:00' }), catchUpDelayMs: 10 });
    s1.start();
    await vi.advanceTimersByTimeAsync(20);
    expect(a.planner.planToday).not.toHaveBeenCalled();
    expect(a.runner.runPending).toHaveBeenCalledWith('2026-11-09');
    s1.stop();

    // No plan yet and the scheduled time is still ahead → plan now anyway (A.I.M. is independent from launch).
    const b = fakes(false);
    const s2 = new Scheduler({ planner: b.planner, runner: b.runner, settings: settingsOf({ dailyGoalsTime: '23:00' }), catchUpDelayMs: 10 });
    s2.start();
    await vi.advanceTimersByTimeAsync(20);
    expect(b.planner.planToday).toHaveBeenCalledTimes(1);
    s2.stop();

    // Daily goals disabled → nothing happens.
    const c = fakes(false);
    const s3 = new Scheduler({ planner: c.planner, runner: c.runner, settings: settingsOf({ dailyGoalsTime: '08:00', dailyGoalsEnabled: false }), catchUpDelayMs: 10 });
    s3.start();
    await vi.advanceTimersByTimeAsync(20);
    expect(c.planner.planToday).not.toHaveBeenCalled();
    expect(c.runner.runPending).not.toHaveBeenCalled();
    s3.stop();
  });

  it('runDaily plans without running goals when autoRunGoals is off, and never throws', async () => {
    const { planner, runner } = fakes(false);
    const s = new Scheduler({ planner, runner, settings: settingsOf({ autoRunGoals: false }) });
    await s.runDaily();
    expect(planner.planToday).toHaveBeenCalledTimes(1);
    expect(runner.runPending).not.toHaveBeenCalled();

    const log = new CollectingLogger();
    const broken = { planToday: vi.fn(async () => { throw new Error('kaboom'); }), existingPlan: () => null } as unknown as GoalPlanner;
    const s2 = new Scheduler({ planner: broken, runner, settings: settingsOf(), log });
    await expect(s2.runDaily()).resolves.toBeUndefined();
    expect(log.text()).toContain('kaboom');
  });

  it('reschedules when the configured time changes', async () => {
    vi.useFakeTimers();
    let time = '08:00';
    const { planner, runner } = fakes(true);
    const log = new CollectingLogger();
    const s = new Scheduler({ planner, runner, settings: () => ({ ...settingsOf()(), dailyGoalsTime: time }), log, pollMs: 100, catchUpDelayMs: 10_000 });
    s.start();
    time = '09:30';
    await vi.advanceTimersByTimeAsync(150);
    expect(log.text()).toContain('30 9 * * *');
    s.stop();
  });
});

import type { DailyPlan, Settings } from '@aim/shared';
import { DEFAULT_DAILY_GOALS_TIME, todayISO } from '@aim/shared';
import cron from 'node-cron';
import type { LoggerLike } from './deps.js';
import { errorMessage, scopedLogger } from './deps.js';
import type { GoalPlanner } from './goal-planner.js';
import type { GoalRunner } from './goal-runner.js';

export interface SchedulerOptions {
  planner: GoalPlanner;
  runner: GoalRunner;
  settings: () => Settings;
  log?: LoggerLike;
  /** How often the settings are polled for a changed time (default 60 s). */
  pollMs?: number;
  /** Delay before the launch catch-up check (default 60 s). */
  catchUpDelayMs?: number;
  /** Injectable clock (tests). */
  now?: () => Date;
}

interface CronJob {
  stop(): void | Promise<void>;
  destroy?(): void | Promise<void>;
}

/** Parse "HH:mm" → { h, m }; null when malformed. */
export function parseHHmm(time: string): { h: number; m: number } | null {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(time ?? ''));
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return { h, m: min };
}

/** "08:00" → "0 8 * * *". Falls back to DEFAULT_DAILY_GOALS_TIME when malformed. */
export function cronFromTime(time: string): string {
  const t = parseHHmm(time) ?? parseHHmm(DEFAULT_DAILY_GOALS_TIME) ?? { h: 8, m: 0 };
  return `${t.m} ${t.h} * * *`;
}

/** True when `now` is at or after HH:mm on the same day. */
export function isPastTime(time: string, now = new Date()): boolean {
  const t = parseHHmm(time) ?? parseHHmm(DEFAULT_DAILY_GOALS_TIME) ?? { h: 8, m: 0 };
  return now.getHours() * 60 + now.getMinutes() >= t.h * 60 + t.m;
}

/** Fires the daily plan (and optionally the goal run) at `settings.dailyGoalsTime`, with a launch catch-up. */
export class Scheduler {
  private readonly o: SchedulerOptions;
  private readonly log: LoggerLike;
  private readonly now: () => Date;
  private job: CronJob | null = null;
  private scheduledTime = '';
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private catchUpTimer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private readonly listeners = new Set<(p: DailyPlan) => void>();

  constructor(opts: SchedulerOptions) {
    this.o = opts;
    this.log = scopedLogger(opts.log, 'scheduler');
    this.now = opts.now ?? (() => new Date());
  }

  get started(): boolean {
    return this.pollTimer !== null;
  }

  start(): void {
    if (this.pollTimer) return;
    this.reschedule();
    this.pollTimer = setInterval(() => {
      try {
        if (this.o.settings().dailyGoalsTime !== this.scheduledTime) this.reschedule();
      } catch (e) {
        this.log.warn('poll failed', errorMessage(e));
      }
    }, this.o.pollMs ?? 60_000);
    unref(this.pollTimer);

    this.catchUpTimer = setTimeout(() => {
      this.catchUpTimer = null;
      void this.catchUp();
    }, this.o.catchUpDelayMs ?? 60_000);
    unref(this.catchUpTimer);
    this.log.info('started');
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.catchUpTimer) clearTimeout(this.catchUpTimer);
    this.catchUpTimer = null;
    this.destroyJob();
    this.scheduledTime = '';
  }

  onPlan(cb: (p: DailyPlan) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** (Re)create the cron job from the current settings. Safe to call at any time. */
  reschedule(): void {
    let time = DEFAULT_DAILY_GOALS_TIME;
    try {
      time = this.o.settings().dailyGoalsTime || DEFAULT_DAILY_GOALS_TIME;
    } catch (e) {
      this.log.warn('settings unavailable', errorMessage(e));
    }
    this.destroyJob();
    const expr = cronFromTime(time);
    try {
      this.job = cron.schedule(expr, () => {
        void this.runDaily('cron');
      }) as unknown as CronJob;
      this.scheduledTime = time;
      this.log.info(`daily planning scheduled at ${time} (${expr})`);
    } catch (e) {
      this.job = null;
      this.log.error('cron schedule failed', errorMessage(e));
    }
  }

  /** The full daily flow: plan → notify → (optionally) run goals. Never throws. */
  runDaily(reason = 'manual'): Promise<void> {
    if (this.running) return this.running;
    const p = this.doRunDaily(reason).finally(() => {
      this.running = null;
    });
    this.running = p;
    return p;
  }

  private async doRunDaily(reason: string): Promise<void> {
    try {
      const settings = this.o.settings();
      if (!settings.dailyGoalsEnabled) {
        this.log.info(`skipped (${reason}): daily goals disabled`);
        return;
      }
      this.log.info(`daily flow (${reason})`);
      const plan = await this.o.planner.planToday();
      for (const cb of this.listeners) {
        try {
          cb(plan);
        } catch (e) {
          this.log.warn('onPlan listener failed', errorMessage(e));
        }
      }
      if (this.o.settings().autoRunGoals && plan.goals.some((g) => g.status === 'planned')) {
        await this.o.runner.runPending(plan.date);
      }
    } catch (e) {
      this.log.error('daily flow failed', errorMessage(e));
    }
  }

  /** On launch: if today has no plan and the planning time already passed, run the flow once. */
  private async catchUp(): Promise<void> {
    try {
      const settings = this.o.settings();
      if (!settings.dailyGoalsEnabled) return;
      const now = this.now();
      // Independent operation: when A.I.M. starts, make sure today has a plan and that planned goals run,
      // whatever the clock says. The scheduled time still re-plans each day.
      const existing = this.o.planner.existingPlan(todayISO(now));
      if (!existing) {
        await this.runDaily('startup');
        return;
      }
      if (settings.autoRunGoals && existing.goals.some((g) => g.status === 'planned')) {
        this.log.info('startup: running planned goals');
        await this.o.runner.runPending(existing.date);
      }
    } catch (e) {
      this.log.error('catch-up failed', errorMessage(e));
    }
  }

  private destroyJob(): void {
    const job = this.job;
    this.job = null;
    if (!job) return;
    try {
      void job.stop();
      void job.destroy?.();
    } catch (e) {
      this.log.warn('job destroy failed', errorMessage(e));
    }
  }
}

function unref(t: unknown): void {
  (t as { unref?: () => void }).unref?.();
}

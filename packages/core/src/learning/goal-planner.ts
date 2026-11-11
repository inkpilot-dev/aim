import os from 'node:os';
import type { DailyPlan, Directive, Goal, Settings } from '@aim/shared';
import { DAILY_PLAN_JSON_SCHEMA, newId, todayISO } from '@aim/shared';
import type { BehaviorObserver } from './behavior-observer.js';
import type { LoggerLike, OneShotRunnerLike } from './deps.js';
import { asNumber, asString, errorMessage, extractJsonObject, scopedLogger } from './deps.js';
import type { DirectiveStore } from './directive-store.js';
import { normalizePriority } from './directive-store.js';
import type { GoalStore } from './goal-store.js';
import { normalizeEffort } from './goal-store.js';
import type { MemoryStore } from './memory-store.js';

export interface GoalPlannerOptions {
  runner: OneShotRunnerLike;
  directives: DirectiveStore;
  goals: GoalStore;
  memory: MemoryStore;
  observer?: BehaviorObserver;
  settings: () => Settings;
  log?: LoggerLike;
  /** Injectable clock (tests). */
  now?: () => Date;
}

const MAX_GOALS = 7;
const PLAN_TIMEOUT_MS = 180_000;
/** Gap between consecutive goals' scheduledAt. */
const STAGGER_MS = 15 * 60_000;

/** Plans AIM's day: directives + memory + behaviour + yesterday's outcomes → structured DailyPlan. */
export class GoalPlanner {
  private readonly o: GoalPlannerOptions;
  private readonly log: LoggerLike;
  private readonly now: () => Date;
  private inFlight: Promise<DailyPlan> | null = null;

  constructor(opts: GoalPlannerOptions) {
    this.o = opts;
    this.log = scopedLogger(opts.log, 'goal-planner');
    this.now = opts.now ?? (() => new Date());
  }

  /** The stored plan for a date (default today), or null. */
  existingPlan(date = todayISO(this.now())): DailyPlan | null {
    return this.o.goals.planForDate(date);
  }

  /**
   * Return today's plan, creating it with the CLI when missing (or when `force`). Never throws: on
   * failure a plan with zero goals and an explanatory summary is returned (and not persisted, so the
   * next trigger retries).
   */
  planToday(force = false): Promise<DailyPlan> {
    if (this.inFlight) return this.inFlight;
    const p = this.doPlan(force).finally(() => {
      this.inFlight = null;
    });
    this.inFlight = p;
    return p;
  }

  private async doPlan(force: boolean): Promise<DailyPlan> {
    const nowDate = this.now();
    const date = todayISO(nowDate);
    try {
      const existing = this.o.goals.planForDate(date);
      if (existing && !force) return existing;

      const directives = this.o.directives.listActive();
      const prompt = this.buildPrompt(date, nowDate, directives);
      const settings = this.o.settings();
      this.log.info(`planning ${date} (${directives.length} directives, force=${force})`);

      const result = await this.o.runner.runOnce(prompt, {
        cwd: os.homedir(),
        jsonSchema: DAILY_PLAN_JSON_SCHEMA,
        model: settings.model || undefined,
        timeoutMs: PLAN_TIMEOUT_MS,
      });
      if (!result.ok || result.isError) {
        throw new Error(result.errorMessage || `CLI returned an error (exit ${result.exitCode ?? 'n/a'})`);
      }
      const parsed = extractJsonObject(result);
      if (!parsed) throw new Error('Planner output was not valid JSON');

      const goals = this.toGoals(parsed, date, nowDate, directives);
      const summary = asString(parsed.summary).trim() || (goals.length ? `${goals.length} goals planned for ${date}.` : 'No goals planned.');
      const plan: DailyPlan = { date, goals, summary, createdAt: nowDate.getTime() };

      if (existing) {
        // Re-plan: retire goals that never started so they do not run twice.
        for (const g of existing.goals) {
          if (g.status === 'planned' && g.origin !== 'user') this.o.goals.update(g.id, { status: 'deferred', notes: 'Superseded by a new plan.' });
        }
      }
      this.o.goals.savePlan(plan);
      const pursued = new Set(goals.map((g) => g.directiveId).filter((x): x is string => Boolean(x)));
      for (const id of pursued) {
        try {
          this.o.directives.update(id, { lastPursuedAt: nowDate.getTime() });
        } catch (e) {
          this.log.warn('directive update failed', id, errorMessage(e));
        }
      }
      this.log.info(`planned ${goals.length} goals for ${date}`);
      return this.o.goals.planForDate(date) ?? plan;
    } catch (e) {
      const msg = errorMessage(e);
      this.log.error('planning failed', msg);
      return { date, goals: [], summary: `Daily planning failed: ${msg}`, createdAt: nowDate.getTime() };
    }
  }

  // ─── prompt ───

  buildPrompt(date: string, nowDate: Date, directives: Directive[]): string {
    const yesterday = new Date(nowDate.getTime() - 86_400_000);
    const yGoals = this.o.goals.list({ date: todayISO(yesterday) });
    const memoryDigest = safe(() => this.o.memory.digest(3500), this.log);
    const behaviorDigest = this.o.observer ? safe(() => this.o.observer!.digest(), this.log) : '';
    const weekday = nowDate.toLocaleDateString('en-US', { weekday: 'long' });

    const lines: string[] = [];
    lines.push(
      'You are A.I.M. (Artificial Intelligence Management), a self-directed desktop assistant planning your own working day for the user.',
      `Today is ${weekday}, ${date}. Produce a short, concrete plan of goals you will execute autonomously on the user's computer.`,
      '',
      '## Standing directives from the user (pursue these; reference them by id in directiveId)',
    );
    if (directives.length === 0) lines.push('(none — plan light-touch goals that help the user based on memory and behaviour)');
    for (const d of directives) {
      const last = d.lastPursuedAt ? ` — last pursued ${todayISO(new Date(d.lastPursuedAt))}` : ' — never pursued yet';
      lines.push(`- [${d.id}] (priority ${d.priority}) ${d.text}${last}`);
    }
    lines.push('', '## What you remember about the user');
    lines.push(memoryDigest || '(no memories yet)');
    lines.push('', '## Observed behaviour');
    lines.push(behaviorDigest || '(no behaviour data yet)');
    const userGoals = this.o.goals.list({ date }).filter((g) => g.origin === 'user' && g.status !== 'done');
    lines.push('', '## Goals the user set for today (already scheduled; do not duplicate them)');
    if (userGoals.length === 0) lines.push('(none)');
    for (const g of userGoals) lines.push(`- [${g.status}] ${g.title}`);
    lines.push('', "## Yesterday's goals");
    if (yGoals.length === 0) lines.push('(none)');
    for (const g of yGoals) lines.push(`- [${g.status}] ${g.title}${g.notes ? ` — ${singleLine(g.notes)}` : ''}`);
    lines.push(
      '',
      '## Rules',
      `- Plan between 3 and ${MAX_GOALS} goals. Each must be concrete, verifiable and achievable in one sitting with your tools (browser automation, desktop control, files, shell).`,
      '- Never plan anything involving payments, purchases, card details or money transfers; never plan destructive actions.',
      '- Prefer goals that advance the directives above; one goal per directive is usually enough. Retry or follow up on goals that failed yesterday when still relevant.',
      '- Include at most one "learn/improve" goal (research, organising, tidying your memory) and only if it is genuinely useful.',
      '- Order goals by priority (1 = do first). Use effort "small" | "medium" | "large".',
      '- Write titles as imperative sentences (e.g. "Clear the inbox down to zero") and rationales in one or two sentences.',
      '- Respond only with the JSON object described by the schema: { "summary": string, "goals": [{ "title", "rationale", "directiveId"?, "priority", "effort" }] }.',
    );
    return lines.join('\n');
  }

  // ─── parsing ───

  private toGoals(parsed: Record<string, unknown>, date: string, nowDate: Date, directives: Directive[]): Goal[] {
    const raw = Array.isArray(parsed.goals) ? parsed.goals : [];
    const known = new Set(directives.map((d) => d.id));
    const goals: Goal[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const r = item as Record<string, unknown>;
      const title = asString(r.title).replace(/\s+/g, ' ').trim().slice(0, 200);
      if (!title) continue;
      const dedupe = title.toLowerCase();
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      const directiveId = asString(r.directiveId).trim();
      const g: Goal = {
        id: newId('goal'),
        date,
        title,
        rationale: asString(r.rationale).trim().slice(0, 1000),
        status: 'planned',
        origin: 'aim',
        priority: normalizePriority(asNumber(r.priority, 2)),
        effort: normalizeEffort(r.effort),
        createdAt: nowDate.getTime(),
        updatedAt: nowDate.getTime(),
      };
      if (directiveId && known.has(directiveId)) g.directiveId = directiveId;
      goals.push(g);
      if (goals.length >= MAX_GOALS) break;
    }
    goals.sort((a, b) => a.priority - b.priority);
    goals.forEach((g, i) => {
      g.scheduledAt = nowDate.getTime() + 60_000 + i * STAGGER_MS;
    });
    return goals;
  }
}

function safe(fn: () => string, log: LoggerLike): string {
  try {
    return fn();
  } catch (e) {
    log.warn('digest failed', errorMessage(e));
    return '';
  }
}

function singleLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 200);
}

import type { ChatStatus, ChatStreamEvent, Goal, Settings } from '@aim/shared';
import { todayISO } from '@aim/shared';
import type { ChatServiceLike, LoggerLike } from './deps.js';
import { errorMessage, scopedLogger } from './deps.js';
import type { DirectiveStore } from './directive-store.js';
import type { GoalStore } from './goal-store.js';

export interface GoalRunnerOptions {
  goals: GoalStore;
  chats: ChatServiceLike;
  settings: () => Settings;
  /** Optional: lets the runner quote the directive text in the goal prompt. */
  directives?: DirectiveStore;
  log?: LoggerLike;
  /** Max time a single goal chat may run before it is marked failed (default 2 h). */
  goalTimeoutMs?: number;
}

const DEFAULT_GOAL_TIMEOUT_MS = 2 * 60 * 60_000;
type Outcome = ChatStatus | 'timeout' | 'send_failed';

/** Executes planned goals one at a time, each in its own chat (`origin: 'goal'`). */
export class GoalRunner {
  private readonly o: GoalRunnerOptions;
  private readonly log: LoggerLike;
  private readonly timeoutMs: number;
  private pending: Promise<void> | null = null;
  private cancelRequested = false;

  constructor(opts: GoalRunnerOptions) {
    this.o = opts;
    this.log = scopedLogger(opts.log, 'goal-runner');
    this.timeoutMs = opts.goalTimeoutMs ?? DEFAULT_GOAL_TIMEOUT_MS;
  }

  get isRunning(): boolean {
    return this.pending !== null;
  }

  /** Stop after the goal currently running; goals still planned stay planned. */
  cancelPending(): void {
    this.cancelRequested = true;
  }

  /**
   * Run one goal in a new chat and resolve once the chat reaches a terminal status. Throws only when
   * the goal does not exist; every other failure is recorded on the goal.
   */
  async runGoal(goalId: string): Promise<{ chatId: string }> {
    const goal = this.o.goals.get(goalId);
    if (!goal) throw new Error(`Goal not found: ${goalId}`);
    const settings = this.o.settings();

    const createInput: Parameters<ChatServiceLike['createChat']>[0] = { title: `Goal — ${goal.title}`, origin: 'goal', goalId: goal.id };
    if (settings.defaultCwd) createInput.cwd = settings.defaultCwd;
    const chat = this.o.chats.createChat(createInput);
    const chatId = chat.id;
    this.o.goals.update(goal.id, { status: 'in_progress', chatId });
    this.log.info(`running goal "${goal.title}" in chat ${chatId}`);

    const outcome = await new Promise<Outcome>((resolve) => {
      let settled = false;
      let started = false;
      let unsub: () => void = () => undefined;
      const finish = (o: Outcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          unsub();
        } catch {
          // ignore
        }
        resolve(o);
      };
      const timer = setTimeout(() => finish('timeout'), this.timeoutMs);
      (timer as { unref?: () => void }).unref?.();

      unsub = this.o.chats.on((e: ChatStreamEvent) => {
        const id = 'chatId' in e ? e.chatId : e.type === 'chat.updated' ? e.chat.id : undefined;
        if (id !== chatId) return;
        if (e.type === 'message.start' || e.type === 'message.delta' || e.type === 'tasks') started = true;
        if (e.type === 'status') {
          if (e.status === 'thinking' || e.status === 'working') started = true;
          else if (e.status === 'done' || e.status === 'error' || e.status === 'waiting_user') finish(e.status);
          else if (e.status === 'idle' && started) finish('idle');
        } else if (e.type === 'error' && !e.recoverable) {
          finish('error');
        } else if (e.type === 'chat.deleted') {
          finish('error');
        }
      });

      this.o.chats.sendMessage({ chatId, text: this.buildMessage(goal) }).catch((err: unknown) => {
        this.log.error('sendMessage failed', errorMessage(err));
        finish('send_failed');
      });
    });

    this.applyOutcome(goal.id, outcome);
    return { chatId };
  }

  /** Run every goal still `planned` for the date, sequentially by priority. Never throws. */
  runPending(date = todayISO()): Promise<void> {
    if (this.pending) return this.pending;
    this.cancelRequested = false;
    const p = this.doRunPending(date).finally(() => {
      this.pending = null;
    });
    this.pending = p;
    return p;
  }

  private async doRunPending(date: string): Promise<void> {
    // Re-read after every goal so goals added while running (by the user or by A.I.M.) are picked up too.
    const attempted = new Set<string>();
    for (;;) {
      if (this.cancelRequested) break;
      const next = this.o.goals
        .list({ date })
        .filter((g) => g.status === 'planned' && !attempted.has(g.id))
        .sort((a, b) => a.priority - b.priority || (a.scheduledAt ?? 0) - (b.scheduledAt ?? 0))[0];
      if (!next) break;
      attempted.add(next.id);
      try {
        await this.runGoal(next.id);
      } catch (e) {
        this.log.error('goal run failed', next.id, errorMessage(e));
      }
    }
    this.log.info(`${attempted.size} goal(s) run for ${date}`);
  }

  // ─── internals ───

  private applyOutcome(goalId: string, outcome: Outcome): void {
    const current = this.o.goals.get(goalId);
    if (!current) return;
    if (current.status !== 'in_progress') {
      this.log.info(`goal ${goalId} already ${current.status} (set by the model)`);
      return;
    }
    const patch: Partial<Goal> = {};
    switch (outcome) {
      case 'done':
      case 'idle':
        patch.status = 'done';
        break;
      case 'waiting_user':
        patch.status = 'deferred';
        patch.notes = 'Paused: AIM needs input from the user. Continue in the goal chat.';
        break;
      case 'timeout':
        patch.status = 'failed';
        patch.notes = `Timed out after ${Math.round(this.timeoutMs / 60_000)} minutes.`;
        break;
      case 'send_failed':
        patch.status = 'failed';
        patch.notes = 'Could not start the goal chat.';
        break;
      default:
        patch.status = 'failed';
        patch.notes = current.notes ?? 'The goal chat ended with an error.';
    }
    try {
      this.o.goals.update(goalId, patch);
    } catch (e) {
      this.log.warn('goal update failed', errorMessage(e));
    }
    this.log.info(`goal ${goalId} → ${patch.status} (${outcome})`);
  }

  buildMessage(goal: Goal): string {
    const directive = goal.directiveId && this.o.directives ? this.o.directives.get(goal.directiveId) : null;
    const lines = [
      goal.origin === 'user' ? `This chat executes a goal the user set for you (goal id: ${goal.id}).` : `This chat executes one of today's planned goals (goal id: ${goal.id}).`,
      '',
      `## Goal`,
      goal.title,
      '',
      `## Why`,
      goal.rationale || '(no rationale recorded)',
    ];
    if (directive) lines.push('', `## Standing directive it serves`, directive.text);
    lines.push(
      '',
      '## Instructions',
      '1. Call `tasks_set` first with the concrete steps you will take, and keep the tasks updated as you work.',
      '2. Work autonomously with the browser, desktop and file tools. Prefer browser tools when the user is active in another app.',
      '3. Never perform payments or purchases, never enter card details, never take destructive actions.',
      `4. When finished, call \`goals_update\` with goalId "${goal.id}" and status "done" (or "failed"/"deferred") plus a one-line note of the outcome, then stop.`,
      '5. Only ask the user something if you truly cannot proceed; otherwise finish without interaction.',
    );
    return lines.join('\n');
  }
}

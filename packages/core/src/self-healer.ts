/**
 * SelfHealer — classifies failures of a chat turn and produces the re-prompt used to recover.
 * Attempts are counted per chat and reset when a turn succeeds.
 */
import type { CliRunResult } from './cli-bridge.js';
import { createLogger, type Logger } from './logger.js';

export type HealErrorKind = 'cli_crash' | 'tool_error' | 'max_turns' | 'auth' | 'extension_disconnected' | 'unknown';

export interface ClassifiedError {
  kind: HealErrorKind;
  message: string;
  /** Whether a retry can plausibly help. */
  retryable: boolean;
}

export interface SelfHealerOptions {
  /** Live getter so the setting can change at runtime. */
  maxAttempts: () => number;
  log?: Logger;
}

const AUTH_RE = /(not logged in|unauthori[sz]ed|invalid api key|authentication|please run \/login|login required|401|expired token|oauth)/i;
const EXT_RE = /(extension (is )?(not connected|disconnected|offline)|browser extension|no extension|NotConnected|-32002)/i;
const MAX_TURNS_RE = /(max(imum)? (number of )?turns|error_max_turns)/i;
const CRASH_RE = /(exited \(|exit code|signal SIG|without a result|Failed to start Claude CLI|spawn .* ENOENT|timed out)/i;
const TOOL_RE = /(tool (call|use|error|failed)|ok=false|"ok":false|ToolFailed|-32020)/i;

function errMessage(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const r = err as { errorMessage?: unknown; message?: unknown; error?: unknown };
    for (const v of [r.errorMessage, r.message, r.error]) if (typeof v === 'string' && v) return v;
    try {
      return JSON.stringify(err);
    } catch {
      /* fallthrough */
    }
  }
  return String(err);
}

export class SelfHealer {
  private readonly attempts = new Map<string, number>();
  private readonly log: Logger;

  constructor(private readonly opts: SelfHealerOptions) {
    this.log = opts.log ?? createLogger('core:heal');
  }

  /** Classifies any error-ish value: a CliRunResult, Error, string or an object with a message. */
  classify(err: unknown): ClassifiedError {
    const message = errMessage(err).trim() || 'Unknown error';
    const result = err && typeof err === 'object' && 'isError' in err ? (err as CliRunResult) : undefined;

    if (AUTH_RE.test(message)) return { kind: 'auth', message, retryable: false };
    if (EXT_RE.test(message)) return { kind: 'extension_disconnected', message, retryable: true };
    if (MAX_TURNS_RE.test(message)) return { kind: 'max_turns', message, retryable: true };
    if (result && result.exitCode !== null && result.exitCode !== 0 && !result.resultText) return { kind: 'cli_crash', message, retryable: true };
    if (CRASH_RE.test(message)) return { kind: 'cli_crash', message, retryable: true };
    if (TOOL_RE.test(message)) return { kind: 'tool_error', message, retryable: true };
    return { kind: 'unknown', message, retryable: true };
  }

  attemptsFor(chatId: string): number {
    return this.attempts.get(chatId) ?? 0;
  }

  /** True when another automatic repair attempt is allowed for this chat and error kind. */
  shouldRetry(chatId: string, err: unknown): boolean {
    const c = this.classify(err);
    if (!c.retryable) return false;
    const max = Math.max(0, this.opts.maxAttempts());
    return this.attemptsFor(chatId) < max;
  }

  /** Registers an attempt and returns its 1-based number. */
  nextAttempt(chatId: string): number {
    const n = this.attemptsFor(chatId) + 1;
    this.attempts.set(chatId, n);
    this.log.info(`self-heal attempt ${n} for chat ${chatId}`);
    return n;
  }

  /** Clears the counter (call when a turn completes successfully or the chat is stopped). */
  reset(chatId: string): void {
    this.attempts.delete(chatId);
  }

  maxAttempts(): number {
    return Math.max(0, this.opts.maxAttempts());
  }

  /** The user message sent to the (resumed) session to recover from the error. */
  buildRepairPrompt(err: unknown, attempt: number): string {
    const c = this.classify(err);
    const max = this.maxAttempts();
    const head = `Self-repair attempt ${attempt} of ${max}. The previous attempt failed with: ${c.message}`;
    const guidance: Record<HealErrorKind, string> = {
      cli_crash:
        'The session was interrupted before it finished. Review the task list (mcp__aim__tasks_set / tasks_update state), determine which step was in progress, verify the current state with the appropriate tool (browser_snapshot or screen_capture) and continue from there. Do not repeat steps that are already done.',
      tool_error:
        'A tool returned an error. Read the error, check preconditions (correct tab id, element ref still valid, window focused, file exists), take a fresh snapshot or screenshot, and retry with a corrected approach. If the same tool fails again, use a different tool to achieve the step.',
      max_turns:
        'The turn limit was reached. Summarise what is already done, update the task list, then continue efficiently with fewer, larger steps. Avoid repeated snapshots of unchanged pages.',
      extension_disconnected:
        'The browser extension is not connected. Call mcp__aim__browser_status; if offline, launch the browser with mcp__aim__app_launch ("msedge" or "chrome"), wait a few seconds with mcp__aim__browser_wait or a short pause, and check again. If it remains offline, continue with desktop tools and tell the user to enable the A.I.M. extension.',
      auth: 'The Claude CLI is not authenticated. Stop and tell the user to run `claude /login` in a terminal.',
      unknown:
        'Diagnose the cause from the message above, verify the current state before acting, and continue the task with a corrected approach. Keep the task list updated.',
    };
    return `${head}\n\n${guidance[c.kind]}\n\nContinue the original task now. If this cannot be resolved after this attempt, explain precisely what blocks you and use mcp__aim__ask_user if the user must decide.`;
  }
}

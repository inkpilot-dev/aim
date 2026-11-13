/**
 * Keeps the main window from ever sitting on a blank screen.
 *
 * The window is shown on 'ready-to-show', which fires after the first paint of the page, so a renderer
 * that crashes, hangs, or throws while React mounts leaves an empty dark window. This guard watches for
 * all of those and recovers in steps:
 *   1. reload the interface;
 *   2. reload in safe mode (?safe=1: saved interface state is cleared, the app opens on the home screen);
 *   3. show a built-in recovery screen with the error, the log location and repair actions.
 * A failure counter resets once the interface has stayed up for a while.
 *
 * Signals: 'render-process-gone', 'unresponsive', main-frame 'did-fail-load', and a readiness
 * handshake: the renderer sends IPC.renderer_ready after its first successful render. No handshake
 * within READY_TIMEOUT_MS of the page finishing loading counts as a failure.
 */
import type { BrowserWindow } from 'electron';

export type RecoveryAction = 'reload' | 'safe' | 'reset' | 'software' | 'logs' | 'quit';

export interface RendererGuardDeps {
  /** Loads the interface; safe=true appends ?safe=1. */
  load: (opts: { safe: boolean }) => Promise<void>;
  /** Shows the built-in recovery page. */
  showRecovery: (reason: string, details: string) => void;
  log: { info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void };
  now?: () => number;
  readyTimeoutMs?: number;
  unresponsiveMs?: number;
  stableMs?: number;
}

export const READY_TIMEOUT_MS = 15_000;
const UNRESPONSIVE_MS = 10_000;
const STABLE_MS = 60_000;

export class RendererGuard {
  private failures = 0;
  private readyTimer: NodeJS.Timeout | null = null;
  private hangTimer: NodeJS.Timeout | null = null;
  private stableTimer: NodeJS.Timeout | null = null;
  private recovering = false;
  private onRecoveryPage = false;
  /** Recent renderer errors (console errors, uncaught exceptions), newest last. */
  readonly recentErrors: string[] = [];

  constructor(private readonly d: RendererGuardDeps) {}

  /** Wire the guard to a window's webContents. */
  attach(win: BrowserWindow): void {
    const wc = win.webContents;
    wc.on('render-process-gone', (_e, details) => this.fail(`The interface process stopped (${details.reason}, exit code ${details.exitCode}).`));
    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (!isMainFrame || code === -3 /* aborted: superseded by another navigation */) return;
      this.fail(`The interface failed to load: ${desc} (${code}) ${url}`);
    });
    wc.on('unresponsive', () => {
      this.clear('hang');
      this.hangTimer = setTimeout(() => this.fail('The interface stopped responding.'), this.d.unresponsiveMs ?? UNRESPONSIVE_MS);
    });
    wc.on('responsive', () => this.clear('hang'));
    wc.on('did-finish-load', () => {
      const url = wc.getURL();
      this.onRecoveryPage = url.startsWith('data:');
      if (this.onRecoveryPage) return;
      this.clear('ready');
      this.readyTimer = setTimeout(() => this.fail('The interface loaded but did not finish starting.'), this.d.readyTimeoutMs ?? READY_TIMEOUT_MS);
    });
    wc.on('console-message', (e) => {
      const p = e as unknown as { level?: string; message?: string; sourceId?: string; lineNumber?: number };
      if (p.level === 'error') this.recordError(`console: ${p.message ?? ''}${p.sourceId ? ` (${p.sourceId}:${p.lineNumber ?? 0})` : ''}`);
    });
  }

  /** The renderer rendered successfully. */
  ready(): void {
    this.clear('ready');
    this.recovering = false;
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.stableTimer = setTimeout(() => {
      this.failures = 0;
    }, this.d.stableMs ?? STABLE_MS);
    this.stableTimer.unref?.();
  }

  /** An error reported by the renderer (uncaught error, unhandled rejection, error boundary). */
  recordError(text: string): void {
    const line = text.slice(0, 2000);
    this.recentErrors.push(line);
    if (this.recentErrors.length > 20) this.recentErrors.shift();
    this.d.log.error(`renderer: ${line}`);
  }

  get failureCount(): number {
    return this.failures;
  }

  /** Something went wrong: escalate through reload → safe mode → recovery page. */
  fail(reason: string): void {
    if (this.onRecoveryPage) return;
    this.clear('ready');
    this.clear('hang');
    if (this.recovering && this.failures >= 3) return;
    this.failures++;
    this.recovering = true;
    this.d.log.warn(`interface failure ${this.failures}: ${reason}`);
    if (this.failures === 1) {
      void this.d.load({ safe: false });
    } else if (this.failures === 2) {
      void this.d.load({ safe: true });
    } else {
      this.onRecoveryPage = true;
      this.d.showRecovery(reason, this.recentErrors.slice(-8).join('\n') || '(no error details were reported)');
    }
  }

  /** Called when the user picks a recovery action that reloads the interface. */
  retry(): void {
    this.failures = 0;
    this.recovering = false;
    this.onRecoveryPage = false;
  }

  dispose(): void {
    this.clear('ready');
    this.clear('hang');
    if (this.stableTimer) clearTimeout(this.stableTimer);
  }

  private clear(which: 'ready' | 'hang'): void {
    if (which === 'ready' && this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    if (which === 'hang' && this.hangTimer) {
      clearTimeout(this.hangTimer);
      this.hangTimer = null;
    }
  }
}

/** Parses a recovery-page link (https://aim.recover/<action>) into an action. */
export function recoveryActionFromUrl(url: string): RecoveryAction | null {
  const m = /^https:\/\/aim\.recover\/(reload|safe|reset|software|logs|quit)\b/.exec(url);
  return m ? (m[1] as RecoveryAction) : null;
}

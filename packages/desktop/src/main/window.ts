/** Main window: frameless, hidden title bar (overlay on Windows), hide-to-tray on close. */
import path from 'node:path';
import { BrowserWindow, app, shell } from 'electron';
import { APP_NAME, COLORS } from '@aim/shared';
import { RendererGuard, recoveryActionFromUrl, type RecoveryAction } from './renderer-guard.js';

export interface MainWindowOptions {
  preloadPath: string;
  rendererDir: string;
  iconPath?: string;
  startMinimized?: boolean;
  log?: { debug(...a: unknown[]): void; info?(...a: unknown[]): void; warn(...a: unknown[]): void; error?(...a: unknown[]): void };
  /** Where the logs live (shown on the recovery screen). */
  logsDir?: string;
  /** Recovery actions that need the rest of the app (open logs, switch to software rendering, quit). */
  onRecoveryAction?: (action: RecoveryAction) => void;
  /** True when hardware acceleration has been turned off. */
  softwareRendering?: boolean;
}

export class MainWindow {
  private win: BrowserWindow | null = null;
  private quitting = false;
  private healthHtml: string | null = null;
  readonly guard: RendererGuard;

  constructor(private readonly opts: MainWindowOptions) {
    const log = {
      info: (...a: unknown[]) => (opts.log?.info ?? opts.log?.debug)?.(...a),
      warn: (...a: unknown[]) => opts.log?.warn(...a),
      error: (...a: unknown[]) => (opts.log?.error ?? opts.log?.warn)?.(...a),
    };
    this.guard = new RendererGuard({
      load: (o) => this.loadRenderer(o),
      showRecovery: (reason, details) => this.showRecoveryPage(reason, details),
      log,
    });
  }

  get browserWindow(): BrowserWindow | null {
    return this.win && !this.win.isDestroyed() ? this.win : null;
  }

  setQuitting(v: boolean): void {
    this.quitting = v;
  }

  create(): BrowserWindow {
    if (this.browserWindow) return this.browserWindow;
    const isWin = process.platform === 'win32';
    const win = new BrowserWindow({
      width: 1200,
      height: 800,
      minWidth: 860,
      minHeight: 600,
      show: false,
      frame: false,
      titleBarStyle: 'hidden',
      ...(isWin ? { titleBarOverlay: { color: COLORS.black, symbolColor: COLORS.text, height: 36 } } : {}),
      ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 12, y: 12 } } : {}),
      backgroundColor: COLORS.black,
      title: APP_NAME,
      icon: this.opts.iconPath,
      autoHideMenuBar: true,
      webPreferences: {
        preload: this.opts.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: true,
        devTools: !app.isPackaged || process.env['AIM_DEVTOOLS'] === '1',
      },
    });
    win.setMenuBarVisibility(false);
    win.once('ready-to-show', () => {
      if (!this.opts.startMinimized) win.show();
    });
    win.on('close', (e) => {
      if (!this.quitting) {
        e.preventDefault();
        win.hide();
      }
    });
    win.on('closed', () => {
      this.win = null;
    });
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    this.guard.attach(win);
    win.webContents.on('will-navigate', (e, url) => {
      const action = recoveryActionFromUrl(url);
      if (action) {
        e.preventDefault();
        this.runRecoveryAction(action);
        return;
      }
      const current = win.webContents.getURL();
      if (url !== current && !url.startsWith('file:') && !url.startsWith(process.env['ELECTRON_RENDERER_URL'] ?? 'about:blank')) {
        e.preventDefault();
        if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
      }
    });
    this.win = win;
    void this.loadRenderer();
    return win;
  }

  private async loadRenderer(opts: { safe: boolean } = { safe: false }): Promise<void> {
    const win = this.browserWindow;
    if (!win) return;
    try {
      if (this.healthHtml) {
        await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(this.healthHtml)}`);
        return;
      }
      if (opts.safe) {
        // Saved interface state (last chat, view) may be what breaks start-up; drop it.
        await win.webContents.session.clearStorageData({ storages: ['localstorage'] }).catch(() => undefined);
      }
      const devUrl = process.env['ELECTRON_RENDERER_URL'];
      if (!app.isPackaged && devUrl) await win.loadURL(opts.safe ? `${devUrl}${devUrl.includes('?') ? '&' : '?'}safe=1` : devUrl);
      else await win.loadFile(path.join(this.opts.rendererDir, 'index.html'), opts.safe ? { query: { safe: '1' } } : undefined);
    } catch (err) {
      // did-fail-load reports the same failure to the guard, which escalates; nothing else to do here.
      this.opts.log?.warn(`renderer load failed: ${(err as Error).message}`);
    }
  }

  /** The built-in recovery screen: what happened, where the logs are, and ways out. */
  showRecoveryPage(reason: string, details: string): void {
    const win = this.browserWindow ?? this.create();
    const html = recoveryPage(reason, details, this.opts.logsDir, !!this.opts.softwareRendering);
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => undefined);
    if (!win.isVisible()) win.show();
  }

  private runRecoveryAction(action: RecoveryAction): void {
    this.opts.log?.warn(`recovery action: ${action}`);
    if (action === 'reload' || action === 'safe' || action === 'reset') {
      this.guard.retry();
      if (action === 'reset') {
        const win = this.browserWindow;
        void win?.webContents.session
          .clearStorageData({ storages: ['localstorage', 'indexdb', 'cachestorage', 'serviceworkers'] })
          .catch(() => undefined)
          .finally(() => void this.loadRenderer({ safe: true }));
        void win?.webContents.session.clearCache().catch(() => undefined);
        return;
      }
      void this.loadRenderer({ safe: action === 'safe' });
      return;
    }
    this.opts.onRecoveryAction?.(action);
  }

  /** Replace the UI with a minimal built-in page describing a fatal startup problem. */
  showHealthPage(message: string, details?: string): void {
    this.healthHtml = healthPage(message, details);
    const win = this.browserWindow ?? this.create();
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(this.healthHtml)}`).catch(() => undefined);
    if (!win.isVisible()) win.show();
  }

  show(): void {
    const win = this.browserWindow ?? this.create();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  hide(): void {
    this.browserWindow?.hide();
  }

  toggle(): void {
    const win = this.browserWindow;
    if (win && win.isVisible() && win.isFocused()) win.hide();
    else this.show();
  }

  send(channel: string, payload: unknown): void {
    const win = this.browserWindow;
    if (win) win.webContents.send(channel, payload);
  }

  destroy(): void {
    this.quitting = true;
    const w = this.win;
    this.win = null;
    if (w && !w.isDestroyed()) w.destroy();
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

function recoveryPage(reason: string, details: string, logsDir: string | undefined, software: boolean): string {
  const btn = (action: string, label: string, primary = false) =>
    `<a class="btn${primary ? ' primary' : ''}" href="https://aim.recover/${action}">${esc(label)}</a>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${APP_NAME}</title><style>
body{margin:0;background:${COLORS.black};color:${COLORS.text};font:14px/1.55 "Segoe UI",system-ui,sans-serif;height:100vh;display:flex;align-items:center;justify-content:center}
.drag{position:fixed;left:0;right:0;top:0;height:36px;-webkit-app-region:drag}
main{max-width:660px;padding:32px 34px;background:${COLORS.surface};border:1px solid ${COLORS.border};border-radius:14px}
h1{font:600 20px/1.3 Georgia,serif;margin:0 0 6px}
p{margin:8px 0;color:${COLORS.textMuted}}
pre{white-space:pre-wrap;word-break:break-word;background:${COLORS.surfaceRaised};padding:12px;border-radius:8px;color:${COLORS.text};font:12px/1.5 Consolas,monospace;max-height:200px;overflow:auto;user-select:text}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px}
.btn{display:inline-flex;align-items:center;height:34px;padding:0 14px;border-radius:8px;border:1px solid ${COLORS.border};color:${COLORS.text};text-decoration:none;font-weight:500}
.btn:hover{background:${COLORS.surfaceRaised}}
.btn.primary{background:${COLORS.teal};border-color:transparent;color:#06201d}
code{color:${COLORS.tealBright}}
</style></head><body><div class="drag"></div><main>
<h1>${APP_NAME} hit a problem showing its window</h1>
<p>${esc(reason)} A.I.M. tried reloading and safe mode first. Your chats, goals and memory are safe; they are stored separately.</p>
<pre>${esc(details)}</pre>
<p>Details are written to <code>${esc(logsDir ? path.join(logsDir, 'aim.log') : 'logs/aim.log')}</code>.</p>
<div class="actions">
${btn('reload', 'Try again', true)}
${btn('reset', 'Reset the interface and try again')}
${software ? '' : btn('software', 'Restart without graphics acceleration')}
${btn('logs', 'Open the logs folder')}
${btn('quit', 'Quit A.I.M.')}
</div>
</main></body></html>`;
}

function healthPage(message: string, details?: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${APP_NAME}</title><style>
body{margin:0;background:${COLORS.black};color:${COLORS.text};font:14px/1.5 "Segoe UI",system-ui,sans-serif;-webkit-app-region:drag;height:100vh;display:flex;align-items:center;justify-content:center}
main{-webkit-app-region:no-drag;max-width:640px;padding:32px;background:${COLORS.surface};border:1px solid ${COLORS.border};border-radius:12px}
h1{font-size:18px;margin:0 0 8px;color:${COLORS.teal}} p{margin:8px 0;color:${COLORS.textMuted}} pre{white-space:pre-wrap;background:${COLORS.surfaceRaised};padding:12px;border-radius:8px;color:${COLORS.text};font-size:12px;max-height:280px;overflow:auto}
code{color:${COLORS.tealBright}}
</style></head><body><main>
<h1>${APP_NAME} could not start completely</h1>
<p>${esc(message)}</p>
${details ? `<pre>${esc(details)}</pre>` : ''}
<p>Check that the Claude Code CLI is installed (<code>claude --version</code>) and that the application has write access to its data folder. Logs are in the <code>logs</code> folder of the application data directory. Restart ${APP_NAME} after fixing the problem.</p>
</main></body></html>`;
}

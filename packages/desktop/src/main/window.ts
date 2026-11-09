/** Main window: frameless, hidden title bar (overlay on Windows), hide-to-tray on close. */
import path from 'node:path';
import { BrowserWindow, app, shell } from 'electron';
import { APP_NAME, COLORS } from '@aim/shared';

export interface MainWindowOptions {
  preloadPath: string;
  rendererDir: string;
  iconPath?: string;
  startMinimized?: boolean;
  log?: { debug(...a: unknown[]): void; warn(...a: unknown[]): void };
}

export class MainWindow {
  private win: BrowserWindow | null = null;
  private quitting = false;
  private healthHtml: string | null = null;

  constructor(private readonly opts: MainWindowOptions) {}

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
    win.webContents.on('will-navigate', (e, url) => {
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

  private async loadRenderer(): Promise<void> {
    const win = this.browserWindow;
    if (!win) return;
    try {
      if (this.healthHtml) {
        await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(this.healthHtml)}`);
        return;
      }
      const devUrl = process.env['ELECTRON_RENDERER_URL'];
      if (!app.isPackaged && devUrl) await win.loadURL(devUrl);
      else await win.loadFile(path.join(this.opts.rendererDir, 'index.html'));
    } catch (err) {
      this.opts.log?.warn(`renderer load failed: ${(err as Error).message}`);
      this.showHealthPage(`The user interface failed to load: ${(err as Error).message}`);
    }
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

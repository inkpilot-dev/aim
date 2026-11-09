/**
 * CursorOverlay — a transparent, click-through, always-on-top window that draws A.I.M.'s teal
 * cursor on the display containing (x, y) while desktop input tools run. Pure HTML in a data: URL
 * (no renderer build needed). Disabled when settings.desktopCursorOverlay is false.
 */
import { BrowserWindow, screen, type Display } from 'electron';
import { COLORS, type Settings } from '@aim/shared';

export interface CursorOverlayOptions {
  settings: () => Settings;
  log?: { debug(...a: unknown[]): void; warn(...a: unknown[]): void };
  /** Auto-hide after this idle period (ms). */
  idleMs?: number;
}

function overlayHtml(color: string): string {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:transparent;overflow:hidden;width:100%;height:100%;pointer-events:none;user-select:none}
#c{position:absolute;left:0;top:0;width:36px;height:44px;transform:translate(-4px,-3px);transition:left 80ms linear,top 80ms linear,opacity 180ms ease;opacity:0;filter:drop-shadow(0 0 6px ${color}aa) drop-shadow(0 2px 3px rgba(0,0,0,.55))}
#c.on{opacity:1}
#tag{position:absolute;left:26px;top:30px;font:600 11px/1 system-ui,Segoe UI,sans-serif;color:#fff;background:${color};padding:3px 6px;border-radius:4px;letter-spacing:.3px;white-space:nowrap}
#ring{position:absolute;left:0;top:0;width:34px;height:34px;border:2px solid ${color};border-radius:50%;transform:translate(-50%,-50%) scale(.2);opacity:0;pointer-events:none}
#ring.pulse{animation:pulse 420ms ease-out}
@keyframes pulse{0%{transform:translate(-50%,-50%) scale(.2);opacity:.9}100%{transform:translate(-50%,-50%) scale(1.6);opacity:0}}
</style></head><body>
<div id="ring"></div>
<div id="c">
<svg width="30" height="38" viewBox="0 0 30 38" xmlns="http://www.w3.org/2000/svg">
<path d="M3 2 L3 30 L10 23 L15 35 L20 33 L15 21 L25 21 Z" fill="${color}" stroke="#ffffff" stroke-width="2.2" stroke-linejoin="round"/>
</svg>
<div id="tag">AIM</div>
</div>
<script>
const c=document.getElementById('c');const ring=document.getElementById('ring');
window.moveTo=function(x,y){c.style.left=x+'px';c.style.top=y+'px';c.classList.add('on');};
window.hideCursor=function(){c.classList.remove('on');};
window.pulse=function(x,y){ring.style.left=x+'px';ring.style.top=y+'px';ring.classList.remove('pulse');void ring.offsetWidth;ring.classList.add('pulse');};
window.setColor=function(col){c.querySelector('path').setAttribute('fill',col);document.getElementById('tag').style.background=col;ring.style.borderColor=col;};
</script></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

export class CursorOverlay {
  private win: BrowserWindow | null = null;
  private display: Display | null = null;
  private hideTimer: NodeJS.Timeout | null = null;
  private loaded: Promise<void> | null = null;
  private color: string;
  private destroyed = false;

  constructor(private readonly opts: CursorOverlayOptions) {
    this.color = opts.settings().cursorColor || COLORS.teal;
  }

  get enabled(): boolean {
    return !!this.opts.settings().desktopCursorOverlay && !this.destroyed;
  }

  private ensureWindow(display: Display): Promise<void> {
    if (this.win && !this.win.isDestroyed() && this.display?.id === display.id && this.loaded) return this.loaded;
    this.disposeWindow();
    const b = display.bounds;
    const win = new BrowserWindow({
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      hasShadow: false,
      show: false,
      backgroundColor: '#00000000',
      title: 'A.I.M. cursor',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    win.setIgnoreMouseEvents(true, { forward: true });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.setMenu(null);
    this.win = win;
    this.display = display;
    this.loaded = win.loadURL(overlayHtml(this.color)).catch((err) => this.opts.log?.warn(`overlay load failed: ${(err as Error).message}`));
    return this.loaded;
  }

  private disposeWindow(): void {
    const w = this.win;
    this.win = null;
    this.display = null;
    this.loaded = null;
    if (w && !w.isDestroyed()) {
      try {
        w.destroy();
      } catch {
        /* ignore */
      }
    }
  }

  private async exec(js: string): Promise<void> {
    if (!this.win || this.win.isDestroyed()) return;
    try {
      await this.win.webContents.executeJavaScript(js, true);
    } catch (err) {
      this.opts.log?.debug(`overlay js failed: ${(err as Error).message}`);
    }
  }

  /** Show the cursor at screen coordinates (DIP). Re-creates the window when the display changes. */
  async show(x: number, y: number): Promise<void> {
    if (!this.enabled) return;
    try {
      const settingsColor = this.opts.settings().cursorColor || COLORS.teal;
      const display = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) });
      await this.ensureWindow(display);
      if (settingsColor !== this.color) {
        this.color = settingsColor;
        await this.exec(`setColor(${JSON.stringify(this.color)})`);
      }
      const win = this.win;
      if (!win || win.isDestroyed()) return;
      if (!win.isVisible()) win.showInactive();
      await this.exec(`moveTo(${Math.round(x - display.bounds.x)}, ${Math.round(y - display.bounds.y)})`);
      this.armHide();
    } catch (err) {
      this.opts.log?.warn(`overlay show failed: ${(err as Error).message}`);
    }
  }

  async moveTo(x: number, y: number): Promise<void> {
    return this.show(x, y);
  }

  /** Short click animation at (x, y). */
  async pulse(x: number, y: number): Promise<void> {
    if (!this.enabled || !this.display) return;
    await this.exec(`pulse(${Math.round(x - this.display.bounds.x)}, ${Math.round(y - this.display.bounds.y)})`);
    this.armHide();
  }

  private armHide(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => void this.hide(), this.opts.idleMs ?? 1_500);
  }

  /** Keep the overlay alive while a tool is working (resets the idle timer). */
  touch(): void {
    if (this.win && !this.win.isDestroyed() && this.win.isVisible()) this.armHide();
  }

  async hide(): Promise<void> {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
    if (!this.win || this.win.isDestroyed()) return;
    await this.exec('hideCursor()');
    setTimeout(() => {
      if (this.win && !this.win.isDestroyed() && !this.hideTimer) this.win.hide();
    }, 200);
  }

  dispose(): void {
    this.destroyed = true;
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
    this.disposeWindow();
  }
}

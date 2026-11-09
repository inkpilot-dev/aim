/** System tray icon and menu. */
import fs from 'node:fs';
import { Menu, Tray, nativeImage, type NativeImage } from 'electron';
import { APP_NAME, COLORS } from '@aim/shared';

export interface TrayActions {
  openWindow(): void;
  planGoals(): void;
  toggleObserver(): void;
  isObserverPaused(): boolean;
  quit(): void;
}

/** 16×16 teal square with a dark border, used when assets/icons/tray.png is missing. */
export function fallbackTrayImage(color = COLORS.teal): NativeImage {
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const edge = x === 0 || y === 0 || x === size - 1 || y === size - 1;
      const inset = x < 2 || y < 2 || x > size - 3 || y > size - 3;
      // BGRA for Electron's createFromBitmap
      buf[i] = edge ? 0x0d : inset ? Math.round(b * 0.6) : b;
      buf[i + 1] = edge ? 0x0b : inset ? Math.round(g * 0.6) : g;
      buf[i + 2] = edge ? 0x0b : inset ? Math.round(r * 0.6) : r;
      buf[i + 3] = 255;
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

export function loadTrayImage(candidates: string[]): NativeImage {
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) {
        const img = nativeImage.createFromPath(p);
        if (!img.isEmpty()) return img;
      }
    } catch {
      /* try next */
    }
  }
  return fallbackTrayImage();
}

export class AppTray {
  private tray: Tray | null = null;
  constructor(private readonly actions: TrayActions, private readonly iconCandidates: string[], private readonly log?: { warn(...a: unknown[]): void }) {}

  create(): void {
    if (this.tray) return;
    try {
      const img = loadTrayImage(this.iconCandidates);
      if (process.platform === 'darwin') img.setTemplateImage(true);
      this.tray = new Tray(img);
      this.tray.setToolTip(APP_NAME);
      this.tray.on('click', () => this.actions.openWindow());
      this.tray.on('double-click', () => this.actions.openWindow());
      this.refresh();
    } catch (err) {
      this.log?.warn(`tray unavailable: ${(err as Error).message}`);
    }
  }

  refresh(): void {
    if (!this.tray) return;
    const menu = Menu.buildFromTemplate([
      { label: `Open ${APP_NAME}`, click: () => this.actions.openWindow() },
      { label: "Plan today's goals", click: () => this.actions.planGoals() },
      { label: this.actions.isObserverPaused() ? 'Resume observer' : 'Pause observer', click: () => this.actions.toggleObserver() },
      { type: 'separator' },
      { label: 'Quit', click: () => this.actions.quit() },
    ]);
    this.tray.setContextMenu(menu);
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }
}

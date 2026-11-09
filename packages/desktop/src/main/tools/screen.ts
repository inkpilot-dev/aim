/**
 * screen_* tools: Electron desktopCapturer for screenshots, screen.getAllDisplays for geometry,
 * nut-js for the mouse position. screen_find_text has no OCR engine (none ships with nut-js' free
 * tier and we avoid heavy native OCR deps); when the active window is a browser tab with the
 * extension connected we answer from the page snapshot, otherwise we say so honestly.
 */
import { desktopCapturer, nativeImage, screen as escreen, type Display } from 'electron';
import type { ToolResult } from '@aim/shared';
import type { ToolImpl } from './tool-router.js';
import { loadNut, withTimeout, type ActiveWindowProvider } from '../active-window.js';
import type { HubServer } from '../hub/hub-server.js';

export interface ScreenToolDeps {
  activeWindow: ActiveWindowProvider;
  hub: HubServer;
  log?: { debug(...a: unknown[]): void; warn(...a: unknown[]): void };
}

interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Displays ordered so index 0 is the primary display. */
export function orderedDisplays(): Display[] {
  const all = escreen.getAllDisplays();
  const primary = escreen.getPrimaryDisplay();
  return [primary, ...all.filter((d) => d.id !== primary.id)];
}

/**
 * nut-js reports/accepts coordinates in physical pixels on most setups, Electron uses DIP.
 * Detect once by comparing the primary display widths.
 */
let coordSpaceCache: { space: 'dip' | 'physical'; at: number } | null = null;
export async function detectCoordinateSpace(): Promise<'dip' | 'physical'> {
  if (coordSpaceCache && Date.now() - coordSpaceCache.at < 60_000) return coordSpaceCache.space;
  let space: 'dip' | 'physical' = 'dip';
  try {
    const nut = await loadNut();
    const primary = escreen.getPrimaryDisplay();
    if (nut && primary.scaleFactor !== 1) {
      const w = await withTimeout(nut.screen.width(), 1000, 'screen.width');
      space = Math.abs(w - primary.bounds.width) < 2 ? 'dip' : 'physical';
    }
  } catch {
    /* keep dip */
  }
  coordSpaceCache = { space, at: Date.now() };
  return space;
}

/** Convert DIP (Electron) → tool/mouse coordinate space. */
export async function dipToScreen(x: number, y: number): Promise<{ x: number; y: number }> {
  const space = await detectCoordinateSpace();
  if (space === 'dip') return { x, y };
  const d = escreen.getDisplayNearestPoint({ x, y });
  return { x: Math.round(d.bounds.x * d.scaleFactor + (x - d.bounds.x) * d.scaleFactor), y: Math.round(d.bounds.y * d.scaleFactor + (y - d.bounds.y) * d.scaleFactor) };
}
/** Convert tool/mouse coordinates → DIP (for the overlay window, which is positioned in DIP). */
export async function screenToDip(x: number, y: number): Promise<{ x: number; y: number }> {
  const space = await detectCoordinateSpace();
  if (space === 'dip') return { x, y };
  // find the display whose physical bounds contain the point
  for (const d of escreen.getAllDisplays()) {
    const px = d.bounds.x * d.scaleFactor;
    const py = d.bounds.y * d.scaleFactor;
    const pw = d.bounds.width * d.scaleFactor;
    const ph = d.bounds.height * d.scaleFactor;
    if (x >= px && x < px + pw && y >= py && y < py + ph) {
      return { x: Math.round(d.bounds.x + (x - px) / d.scaleFactor), y: Math.round(d.bounds.y + (y - py) / d.scaleFactor) };
    }
  }
  const p = escreen.getPrimaryDisplay();
  return { x: Math.round(x / p.scaleFactor), y: Math.round(y / p.scaleFactor) };
}

async function captureDisplay(display: Display, scale: number): Promise<{ png: Buffer; width: number; height: number }> {
  const physW = Math.round(display.bounds.width * display.scaleFactor);
  const physH = Math.round(display.bounds.height * display.scaleFactor);
  const thumbnailSize = { width: Math.max(1, Math.round(physW * scale)), height: Math.max(1, Math.round(physH * scale)) };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize, fetchWindowIcons: false });
  if (!sources.length) throw new Error('No screen sources available (screen recording permission may be required).');
  let source = sources.find((s) => s.display_id === String(display.id));
  if (!source) {
    const idx = orderedDisplays().findIndex((d) => d.id === display.id);
    source = sources[idx] ?? sources[0];
  }
  const img = source!.thumbnail;
  if (img.isEmpty()) throw new Error('Screen capture returned an empty image.');
  const size = img.getSize();
  return { png: img.toPNG(), width: size.width, height: size.height };
}

function parseRegion(v: unknown): Region | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  const n = (k: string) => Number(r[k]);
  if ([n('x'), n('y'), n('width'), n('height')].some((x) => !Number.isFinite(x))) return null;
  if (n('width') <= 0 || n('height') <= 0) return null;
  return { x: n('x'), y: n('y'), width: n('width'), height: n('height') };
}

export function createScreenTools(deps: ScreenToolDeps): Record<string, ToolImpl> {
  const screen_capture: ToolImpl = async (args) => {
    const displays = orderedDisplays();
    const region = parseRegion(args['region']);
    let display: Display;
    if (region) {
      const space = await detectCoordinateSpace();
      const dip = space === 'physical' ? await screenToDip(region.x, region.y) : { x: region.x, y: region.y };
      display = escreen.getDisplayNearestPoint(dip);
    } else {
      const idx = Number.isInteger(args['display']) ? (args['display'] as number) : 0;
      const d = displays[idx];
      if (!d) return { ok: false, error: `Display index ${idx} does not exist. ${displays.length} display(s) available.` };
      display = d;
    }
    let scale = typeof args['scale'] === 'number' && Number.isFinite(args['scale']) ? Math.min(1, Math.max(0.1, args['scale'] as number)) : region ? 1 : 0.5;
    const space = await detectCoordinateSpace();

    if (!region) {
      const shot = await captureDisplay(display, scale);
      const physW = Math.round(display.bounds.width * display.scaleFactor);
      const factor = physW / shot.width; // image px → physical px
      const toScreen = space === 'physical' ? factor : factor / display.scaleFactor; // image px → tool coordinates
      const originX = space === 'physical' ? Math.round(display.bounds.x * display.scaleFactor) : display.bounds.x;
      const originY = space === 'physical' ? Math.round(display.bounds.y * display.scaleFactor) : display.bounds.y;
      const text = [
        `Screenshot of display ${displays.findIndex((d) => d.id === display.id)} (${display.bounds.width}×${display.bounds.height} DIP, scale factor ${display.scaleFactor}).`,
        `Image is ${shot.width}×${shot.height} px. To convert an image coordinate to screen coordinates for mouse tools: screen_x = ${originX} + image_x × ${toScreen.toFixed(3)}, screen_y = ${originY} + image_y × ${toScreen.toFixed(3)}.`,
      ].join(' ');
      return {
        ok: true,
        text,
        data: { display: { id: display.id, bounds: display.bounds, scaleFactor: display.scaleFactor }, image: { width: shot.width, height: shot.height }, imageToScreenFactor: toScreen, screenOrigin: { x: originX, y: originY } },
        images: [{ mediaType: 'image/png', dataBase64: shot.png.toString('base64') }],
      };
    }

    // Region: capture at full resolution then crop (region given in tool coordinates).
    const full = await captureDisplay(display, 1);
    const physOriginX = display.bounds.x * display.scaleFactor;
    const physOriginY = display.bounds.y * display.scaleFactor;
    const toPhys = space === 'physical' ? 1 : display.scaleFactor;
    const crop = {
      x: Math.max(0, Math.round(region.x * toPhys - physOriginX)),
      y: Math.max(0, Math.round(region.y * toPhys - physOriginY)),
      width: Math.max(1, Math.round(region.width * toPhys)),
      height: Math.max(1, Math.round(region.height * toPhys)),
    };
    crop.width = Math.min(crop.width, full.width - crop.x);
    crop.height = Math.min(crop.height, full.height - crop.y);
    if (crop.width <= 0 || crop.height <= 0) return { ok: false, error: 'Region lies outside the display.' };
    let img = nativeImage.createFromBuffer(full.png).crop(crop);
    if (scale < 1) img = img.resize({ width: Math.max(1, Math.round(crop.width * scale)) });
    const size = img.getSize();
    const factor = crop.width / size.width / toPhys;
    return {
      ok: true,
      text: `Screenshot of region x=${region.x} y=${region.y} ${region.width}×${region.height}. Image is ${size.width}×${size.height} px; screen_x = ${region.x} + image_x × ${factor.toFixed(3)}, screen_y = ${region.y} + image_y × ${factor.toFixed(3)}.`,
      data: { region, image: size, imageToScreenFactor: factor },
      images: [{ mediaType: 'image/png', dataBase64: img.toPNG().toString('base64') }],
    };
  };

  const screen_info: ToolImpl = async () => {
    const displays = orderedDisplays();
    const primary = escreen.getPrimaryDisplay();
    const space = await detectCoordinateSpace();
    let mouse: { x: number; y: number } | null = null;
    try {
      const nut = await loadNut();
      if (nut) {
        const p = await withTimeout(nut.mouse.getPosition(), 1000, 'mouse.getPosition');
        mouse = { x: p.x, y: p.y };
      }
    } catch (err) {
      deps.log?.debug(`mouse position failed: ${(err as Error).message}`);
    }
    if (!mouse) {
      const p = escreen.getCursorScreenPoint();
      mouse = space === 'physical' ? await dipToScreen(p.x, p.y) : p;
    }
    const active = await deps.activeWindow.getActiveWindow();
    const list = displays.map((d, i) => ({
      index: i,
      id: d.id,
      primary: d.id === primary.id,
      bounds: d.bounds,
      workArea: d.workArea,
      scaleFactor: d.scaleFactor,
      physicalSize: { width: Math.round(d.bounds.width * d.scaleFactor), height: Math.round(d.bounds.height * d.scaleFactor) },
      rotation: d.rotation,
    }));
    const text = [
      `${displays.length} display(s). Coordinates for mouse tools are in ${space === 'physical' ? 'physical pixels' : 'device-independent pixels (same as display bounds)'}.`,
      ...list.map((d) => `  [${d.index}] ${d.primary ? 'primary ' : ''}${d.bounds.width}×${d.bounds.height} at (${d.bounds.x},${d.bounds.y}) scale ${d.scaleFactor}`),
      `Mouse at (${mouse.x}, ${mouse.y}).`,
      active ? `Active window: "${active.title}" (${active.app}${active.pid ? `, pid ${active.pid}` : ''}).` : 'Active window: unknown.',
    ].join('\n');
    return { ok: true, text, data: { displays: list, coordinateSpace: space, mouse, activeWindow: active, extensionConnected: deps.hub.extensionConnected } };
  };

  const BROWSER_TITLE = /microsoft\s*edge|google chrome|chromium|brave|mozilla firefox|opera|vivaldi/i;

  const screen_find_text: ToolImpl = async (args) => {
    const query = typeof args['query'] === 'string' ? (args['query'] as string).toLowerCase() : '';
    const active = await deps.activeWindow.getActiveWindow();
    const inBrowser = !!active && (BROWSER_TITLE.test(active.title) || /msedge|chrome|firefox|brave|opera|vivaldi/i.test(active.app));
    if (inBrowser && deps.hub.extensionConnected) {
      try {
        const tabs = await deps.hub.extCall('ext.tabs.list', {}, 10_000);
        const tab = tabs.tabs.find((t) => t.active && active && t.title && active.title.includes(t.title)) ?? tabs.tabs.find((t) => t.active);
        if (tab) {
          const snap = await deps.hub.extCall('ext.page.snapshot', { tabId: tab.tabId, includeText: false, maxElements: 600, filter: query || undefined }, 20_000);
          const matches = snap.elements
            .filter((e) => e.box && e.visible && (!query || `${e.name} ${e.value ?? ''}`.toLowerCase().includes(query)))
            .map((e) => ({ text: e.name || e.value || '', ref: e.ref, role: e.role, x: e.box!.x, y: e.box!.y, width: e.box!.width, height: e.box!.height, confidence: 1 }));
          return {
            ok: true,
            text: `No OCR engine is available; these ${matches.length} match(es) come from the page snapshot of the active browser tab ${tab.tabId} ("${tab.title}"). Coordinates are viewport CSS pixels relative to the page, not screen pixels; prefer browser_click with the ref.`,
            data: { source: 'extension_snapshot', tabId: tab.tabId, matches },
          };
        }
      } catch (err) {
        deps.log?.debug(`screen_find_text via extension failed: ${(err as Error).message}`);
      }
    }
    const res: ToolResult = {
      ok: false,
      error:
        'OCR is unavailable in this build (no OCR engine is bundled). Use screen_capture and read the image to locate text, then click with mouse_click; or, in the browser, use browser_snapshot which returns element refs and labels.',
    };
    return res;
  };

  return { screen_capture, screen_info, screen_find_text };
}

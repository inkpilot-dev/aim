/**
 * Desktop input tools via nut-js: mouse_move / mouse_click / mouse_drag / mouse_scroll /
 * keyboard_type / keyboard_press. Every call shows the teal CursorOverlay first.
 */
import { clipboard } from 'electron';
import { Button, Key, Point, type Point as NutPoint } from '@nut-tree-fork/shared';
import type { ToolImpl } from './tool-router.js';
import { loadNut, withTimeout } from '../active-window.js';
import type { CursorOverlay } from '../overlay/cursor-overlay.js';
import { modifierKeys, parseKeyCombo } from './key-combo.js';
import { screenToDip } from './screen.js';

export interface InputToolDeps {
  overlay: CursorOverlay;
  log?: { debug(...a: unknown[]): void; warn(...a: unknown[]): void };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const isMac = process.platform === 'darwin';

async function nutOrThrow() {
  const nut = await loadNut();
  if (!nut) throw new Error('Desktop input is unavailable: the native input module (nut-js) failed to load on this system.');
  return nut;
}

let configured = false;
function configure(nut: Awaited<ReturnType<typeof nutOrThrow>>): void {
  if (configured) return;
  configured = true;
  nut.mouse.config.autoDelayMs = 20;
  nut.mouse.config.mouseSpeed = 2400;
  nut.keyboard.config.autoDelayMs = 10;
}

function int(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined;
}

function buttonOf(v: unknown): Button {
  return v === 'right' ? Button.RIGHT : v === 'middle' ? Button.MIDDLE : Button.LEFT;
}

export function createInputTools(deps: InputToolDeps): Record<string, ToolImpl> {
  async function showOverlay(x: number, y: number): Promise<void> {
    try {
      const dip = await screenToDip(x, y);
      await deps.overlay.show(dip.x, dip.y);
    } catch (err) {
      deps.log?.debug(`overlay failed: ${(err as Error).message}`);
    }
  }

  async function moveTo(nut: Awaited<ReturnType<typeof nutOrThrow>>, x: number, y: number, smooth: boolean): Promise<void> {
    const target: NutPoint = new Point(x, y);
    await showOverlay(x, y);
    if (smooth) {
      await withTimeout(nut.mouse.move(nut.straightTo(target)), 10_000, 'mouse.move');
    } else {
      await withTimeout(nut.mouse.setPosition(target), 3_000, 'mouse.setPosition');
    }
    await showOverlay(x, y);
  }

  async function currentPos(nut: Awaited<ReturnType<typeof nutOrThrow>>): Promise<{ x: number; y: number }> {
    const p = await withTimeout(nut.mouse.getPosition(), 2_000, 'mouse.getPosition');
    return { x: p.x, y: p.y };
  }

  const mouse_move: ToolImpl = async (args) => {
    const nut = await nutOrThrow();
    configure(nut);
    const x = int(args['x']);
    const y = int(args['y']);
    if (x === undefined || y === undefined) return { ok: false, error: 'x and y must be integers.' };
    await moveTo(nut, x, y, args['smooth'] !== false);
    return { ok: true, text: `Cursor moved to (${x}, ${y}).`, data: { x, y } };
  };

  const mouse_click: ToolImpl = async (args) => {
    const nut = await nutOrThrow();
    configure(nut);
    let x = int(args['x']);
    let y = int(args['y']);
    if (x === undefined || y === undefined) {
      const p = await currentPos(nut);
      x = p.x;
      y = p.y;
    } else {
      await moveTo(nut, x, y, true);
    }
    const button = buttonOf(args['button']);
    const clicks = Math.min(3, Math.max(1, int(args['clicks']) ?? 1));
    const mods = modifierKeys(args['modifiers']);
    await showOverlay(x, y);
    if (mods.length) await nut.keyboard.pressKey(...mods);
    try {
      if (clicks === 2) await withTimeout(nut.mouse.doubleClick(button), 5_000, 'doubleClick');
      else {
        for (let i = 0; i < clicks; i++) {
          await withTimeout(nut.mouse.click(button), 5_000, 'click');
          if (i < clicks - 1) await sleep(60);
        }
      }
    } finally {
      if (mods.length) await nut.keyboard.releaseKey(...mods);
    }
    void deps.overlay.pulse(...(Object.values(await screenToDip(x, y)) as [number, number]));
    const label = `${args['button'] ?? 'left'}${clicks === 2 ? ' double' : clicks === 3 ? ' triple' : ''} click at (${x}, ${y})${mods.length ? ` with ${(args['modifiers'] as string[]).join('+')}` : ''}`;
    return { ok: true, text: `${label[0]!.toUpperCase()}${label.slice(1)}.`, data: { x, y, button: args['button'] ?? 'left', clicks } };
  };

  const mouse_drag: ToolImpl = async (args) => {
    const nut = await nutOrThrow();
    configure(nut);
    const fromX = int(args['fromX']);
    const fromY = int(args['fromY']);
    const toX = int(args['toX']);
    const toY = int(args['toY']);
    if ([fromX, fromY, toX, toY].some((v) => v === undefined)) return { ok: false, error: 'fromX, fromY, toX, toY must be integers.' };
    const durationMs = Math.min(5_000, Math.max(50, int(args['durationMs']) ?? 400));
    await moveTo(nut, fromX!, fromY!, true);
    const prevSpeed = nut.mouse.config.mouseSpeed;
    const dist = Math.hypot(toX! - fromX!, toY! - fromY!);
    nut.mouse.config.mouseSpeed = Math.max(200, (dist / durationMs) * 1000);
    try {
      await nut.mouse.pressButton(Button.LEFT);
      await sleep(80);
      await withTimeout(nut.mouse.move(nut.straightTo(new Point(toX!, toY!))), 15_000, 'drag move');
      await showOverlay(toX!, toY!);
      await sleep(80);
    } finally {
      await nut.mouse.releaseButton(Button.LEFT).catch(() => undefined);
      nut.mouse.config.mouseSpeed = prevSpeed;
    }
    return { ok: true, text: `Dragged from (${fromX}, ${fromY}) to (${toX}, ${toY}).` };
  };

  const mouse_scroll: ToolImpl = async (args) => {
    const nut = await nutOrThrow();
    configure(nut);
    const x = int(args['x']);
    const y = int(args['y']);
    if (x !== undefined && y !== undefined) await moveTo(nut, x, y, false);
    else {
      const p = await currentPos(nut);
      await showOverlay(p.x, p.y);
    }
    const deltaX = int(args['deltaX']) ?? 0;
    const deltaY = int(args['deltaY']) ?? 300;
    const stepsY = Math.max(1, Math.round(Math.abs(deltaY) / 100));
    const stepsX = Math.max(1, Math.round(Math.abs(deltaX) / 100));
    if (deltaY > 0) await withTimeout(nut.mouse.scrollDown(stepsY), 5_000, 'scroll');
    else if (deltaY < 0) await withTimeout(nut.mouse.scrollUp(stepsY), 5_000, 'scroll');
    if (deltaX > 0) await withTimeout(nut.mouse.scrollRight(stepsX), 5_000, 'scroll');
    else if (deltaX < 0) await withTimeout(nut.mouse.scrollLeft(stepsX), 5_000, 'scroll');
    return { ok: true, text: `Scrolled ${deltaY !== 0 ? `${deltaY > 0 ? 'down' : 'up'} ${Math.abs(deltaY)}` : ''}${deltaX !== 0 ? ` ${deltaX > 0 ? 'right' : 'left'} ${Math.abs(deltaX)}` : ''}.`.replace(/\s+\./, '.') };
  };

  const keyboard_type: ToolImpl = async (args) => {
    const nut = await nutOrThrow();
    configure(nut);
    const text = String(args['text'] ?? '');
    if (!text) return { ok: false, error: 'text is empty.' };
    const perChar = int(args['perCharDelayMs']) ?? 0;
    try {
      const p = await currentPos(nut);
      await showOverlay(p.x, p.y);
    } catch {
      /* overlay is cosmetic */
    }
    // eslint-disable-next-line no-control-regex
    const simple = /^[\x20-\x7E\r\n\t]*$/.test(text) && text.length <= 200 && !/[\r\n\t]/.test(text);
    if (simple || perChar > 0) {
      const prev = nut.keyboard.config.autoDelayMs;
      if (perChar > 0) nut.keyboard.config.autoDelayMs = Math.min(500, perChar);
      try {
        if (simple) await withTimeout(nut.keyboard.type(text), 60_000, 'keyboard.type');
        else {
          for (const line of text.split(/\r?\n/).entries()) {
            if (line[0] > 0) await nut.keyboard.type(Key.Enter);
            if (line[1]) await nut.keyboard.type(line[1]);
          }
        }
      } finally {
        nut.keyboard.config.autoDelayMs = prev;
      }
      return { ok: true, text: `Typed ${text.length} character(s).` };
    }
    // Long or non-ASCII text: paste through the clipboard, then restore it.
    const previous = clipboard.readText();
    clipboard.writeText(text);
    try {
      await sleep(60);
      const mod = isMac ? Key.LeftCmd : Key.LeftControl;
      await nut.keyboard.pressKey(mod, Key.V);
      await nut.keyboard.releaseKey(mod, Key.V);
      await sleep(Math.min(1_500, 150 + text.length / 10));
    } finally {
      try {
        clipboard.writeText(previous);
      } catch {
        /* ignore */
      }
    }
    return { ok: true, text: `Pasted ${text.length} character(s) via the clipboard (clipboard restored).` };
  };

  const keyboard_press: ToolImpl = async (args) => {
    const nut = await nutOrThrow();
    configure(nut);
    const combo = String(args['combo'] ?? '');
    let parsed;
    try {
      parsed = parseKeyCombo(combo);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    const repeat = Math.min(50, Math.max(1, int(args['repeat']) ?? 1));
    try {
      const p = await currentPos(nut);
      await showOverlay(p.x, p.y);
    } catch {
      /* cosmetic */
    }
    const all = [...parsed.modifiers, ...parsed.keys];
    for (let i = 0; i < repeat; i++) {
      await withTimeout(nut.keyboard.pressKey(...all), 5_000, 'pressKey');
      await withTimeout(nut.keyboard.releaseKey(...[...all].reverse()), 5_000, 'releaseKey');
      if (i < repeat - 1) await sleep(40);
    }
    return { ok: true, text: `Pressed ${parsed.tokens.join('+')}${repeat > 1 ? ` ×${repeat}` : ''}.` };
  };

  return { mouse_move, mouse_click, mouse_drag, mouse_scroll, keyboard_type, keyboard_press };
}

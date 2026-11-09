/**
 * Parse key combinations such as "ctrl+shift+t", "alt+tab", "win", "enter" into nut-js Key enums.
 * Pure; the Key enum is imported from @nut-tree-fork/shared (no native code).
 */
import { Key } from '@nut-tree-fork/shared';

export interface ParsedCombo {
  modifiers: Key[];
  keys: Key[];
  /** Normalised tokens for logging. */
  tokens: string[];
}

const isMac = process.platform === 'darwin';

const MODIFIERS: Record<string, Key> = {
  ctrl: Key.LeftControl,
  control: Key.LeftControl,
  alt: Key.LeftAlt,
  option: Key.LeftAlt,
  opt: Key.LeftAlt,
  shift: Key.LeftShift,
  win: isMac ? Key.LeftCmd : Key.LeftSuper,
  windows: isMac ? Key.LeftCmd : Key.LeftSuper,
  super: Key.LeftSuper,
  meta: isMac ? Key.LeftCmd : Key.LeftSuper,
  cmd: isMac ? Key.LeftCmd : Key.LeftControl,
  command: isMac ? Key.LeftCmd : Key.LeftControl,
  /** "cmdorctrl" — cross-platform primary modifier. */
  cmdorctrl: isMac ? Key.LeftCmd : Key.LeftControl,
  commandorcontrol: isMac ? Key.LeftCmd : Key.LeftControl,
};

const NAMED: Record<string, Key> = {
  enter: Key.Enter,
  return: Key.Return,
  esc: Key.Escape,
  escape: Key.Escape,
  tab: Key.Tab,
  space: Key.Space,
  spacebar: Key.Space,
  backspace: Key.Backspace,
  delete: Key.Delete,
  del: Key.Delete,
  insert: Key.Insert,
  ins: Key.Insert,
  up: Key.Up,
  arrowup: Key.Up,
  down: Key.Down,
  arrowdown: Key.Down,
  left: Key.Left,
  arrowleft: Key.Left,
  right: Key.Right,
  arrowright: Key.Right,
  home: Key.Home,
  end: Key.End,
  pageup: Key.PageUp,
  pgup: Key.PageUp,
  pagedown: Key.PageDown,
  pgdn: Key.PageDown,
  capslock: Key.CapsLock,
  numlock: Key.NumLock,
  scrolllock: Key.ScrollLock,
  printscreen: Key.Print,
  print: Key.Print,
  pause: Key.Pause,
  menu: Key.Menu,
  contextmenu: Key.Menu,
  '-': Key.Minus,
  minus: Key.Minus,
  '=': Key.Equal,
  equal: Key.Equal,
  equals: Key.Equal,
  '[': Key.LeftBracket,
  ']': Key.RightBracket,
  '\\': Key.Backslash,
  ';': Key.Semicolon,
  semicolon: Key.Semicolon,
  "'": Key.Quote,
  quote: Key.Quote,
  ',': Key.Comma,
  comma: Key.Comma,
  '.': Key.Period,
  period: Key.Period,
  '/': Key.Slash,
  slash: Key.Slash,
  '`': Key.Grave,
  grave: Key.Grave,
  backtick: Key.Grave,
  plus: Key.Add,
  volumeup: Key.AudioVolUp,
  volumedown: Key.AudioVolDown,
  mute: Key.AudioMute,
  playpause: Key.AudioPlay,
};

const LETTERS: Record<string, Key> = {
  a: Key.A, b: Key.B, c: Key.C, d: Key.D, e: Key.E, f: Key.F, g: Key.G, h: Key.H, i: Key.I, j: Key.J, k: Key.K, l: Key.L, m: Key.M,
  n: Key.N, o: Key.O, p: Key.P, q: Key.Q, r: Key.R, s: Key.S, t: Key.T, u: Key.U, v: Key.V, w: Key.W, x: Key.X, y: Key.Y, z: Key.Z,
};
const DIGITS: Key[] = [Key.Num0, Key.Num1, Key.Num2, Key.Num3, Key.Num4, Key.Num5, Key.Num6, Key.Num7, Key.Num8, Key.Num9];
const FKEYS: Key[] = [
  Key.F1, Key.F2, Key.F3, Key.F4, Key.F5, Key.F6, Key.F7, Key.F8, Key.F9, Key.F10, Key.F11, Key.F12,
  Key.F13, Key.F14, Key.F15, Key.F16, Key.F17, Key.F18, Key.F19, Key.F20, Key.F21, Key.F22, Key.F23, Key.F24,
];

export function keyFromToken(raw: string): Key | undefined {
  const t = raw.trim().toLowerCase();
  if (!t) return undefined;
  if (t in MODIFIERS) return MODIFIERS[t];
  if (t in NAMED) return NAMED[t];
  if (t.length === 1 && t in LETTERS) return LETTERS[t];
  if (/^[0-9]$/.test(t)) return DIGITS[Number(t)];
  const f = /^f([1-9]|1[0-9]|2[0-4])$/.exec(t);
  if (f) return FKEYS[Number(f[1]) - 1];
  const np = /^(?:numpad|num)([0-9])$/.exec(t);
  if (np) {
    const pad = [Key.NumPad0, Key.NumPad1, Key.NumPad2, Key.NumPad3, Key.NumPad4, Key.NumPad5, Key.NumPad6, Key.NumPad7, Key.NumPad8, Key.NumPad9];
    return pad[Number(np[1])];
  }
  return undefined;
}

export function isModifierToken(raw: string): boolean {
  return raw.trim().toLowerCase() in MODIFIERS;
}

/**
 * Parse "ctrl+shift+t". A trailing "+" (e.g. "ctrl++") means the plus key. Throws on unknown tokens.
 */
export function parseKeyCombo(combo: string): ParsedCombo {
  if (typeof combo !== 'string' || !combo.trim()) throw new Error('Empty key combination');
  const src = combo.trim();
  const tokens: string[] = [];
  let buf = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if ((ch === '+' || ch === ' ') && buf) {
      tokens.push(buf);
      buf = '';
      continue;
    }
    if (ch === '+' && !buf) {
      // literal plus key, e.g. "ctrl++" or lone "+"
      if (src[i + 1] === '+' || i === src.length - 1 || tokens.length) {
        tokens.push('plus');
        if (src[i + 1] === '+') i++;
        continue;
      }
    }
    if (ch === ' ' && !buf) continue;
    buf += ch;
  }
  if (buf) tokens.push(buf);
  const modifiers: Key[] = [];
  const keys: Key[] = [];
  const norm: string[] = [];
  for (const tok of tokens) {
    const key = keyFromToken(tok);
    if (key === undefined) throw new Error(`Unknown key "${tok}" in combination "${combo}"`);
    norm.push(tok.toLowerCase());
    if (isModifierToken(tok)) modifiers.push(key);
    else keys.push(key);
  }
  return { modifiers, keys, tokens: norm };
}

/** Modifier names used by mouse_click → Key enums. */
export function modifierKeys(names: unknown): Key[] {
  if (!Array.isArray(names)) return [];
  const out: Key[] = [];
  for (const n of names) {
    const k = typeof n === 'string' ? MODIFIERS[n.toLowerCase()] : undefined;
    if (k !== undefined) out.push(k);
  }
  return out;
}

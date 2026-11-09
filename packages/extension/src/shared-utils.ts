/**
 * Pure helpers shared by the background service worker, the content script and the popup.
 * Nothing in this file touches `chrome.*`, `window` or `document`, so it can be unit-tested
 * in plain Node (vitest without jsdom). DOM-dependent code lives in content.ts and only
 * feeds data into these functions.
 */
import { EXT_DEFAULT_RECONNECT_MS, EXT_MAX_RECONNECT_MS, HUB_DEFAULT_PORT, type RpcMessage } from '@aim/shared';

// ---------------------------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------------------------

/** Collapse runs of whitespace (including newlines) into single spaces and trim. */
export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Truncate to `max` characters, appending an ellipsis character when something was cut. */
export function truncate(s: string, max: number): string {
  if (max <= 0) return '';
  if (s.length <= max) return s;
  if (max === 1) return '…';
  return s.slice(0, max - 1).trimEnd() + '…';
}

/** Hostname of a URL ("" when the URL cannot be parsed). */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** Mask a value (passwords) while preserving its length signal. */
export function maskValue(value: string): string {
  if (!value) return '';
  return '•'.repeat(Math.min(value.length, 12));
}

/** True for URLs the browser does not let extensions script (chrome://, edge://, web stores). */
export function isRestrictedUrl(url: string | undefined): boolean {
  if (!url) return true;
  if (/^(chrome|edge|chrome-extension|extension|devtools|about|view-source|file|data|javascript):/i.test(url)) return true;
  const host = hostOf(url);
  return /(^|\.)(chromewebstore\.google\.com|chrome\.google\.com|microsoftedge\.microsoft\.com)$/i.test(host);
}

/** Normalise a user-typed URL: add https:// when a scheme is missing. */
export function normalizeUrl(input: string): string {
  const s = input.trim();
  if (!s) return s;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s;
  if (s.startsWith('//')) return `https:${s}`;
  return `https://${s}`;
}

// ---------------------------------------------------------------------------------------------
// Browser identification
// ---------------------------------------------------------------------------------------------

export interface BrowserInfo { name: 'edge' | 'chrome' | 'brave' | 'opera' | 'vivaldi' | 'chromium' | 'unknown'; version: string }

/** Identify the browser from a user-agent string. Edge is detected via its "Edg/" token. */
export function browserFromUA(ua: string): BrowserInfo {
  const pick = (re: RegExp): string | undefined => ua.match(re)?.[1];
  const edge = pick(/\bEdg(?:e|A|iOS)?\/([\d.]+)/);
  if (edge) return { name: 'edge', version: edge };
  const opera = pick(/\bOPR\/([\d.]+)/);
  if (opera) return { name: 'opera', version: opera };
  const vivaldi = pick(/\bVivaldi\/([\d.]+)/);
  if (vivaldi) return { name: 'vivaldi', version: vivaldi };
  const chrome = pick(/(?:Headless)?Chrome\/([\d.]+)/);
  if (chrome) return { name: 'chrome', version: chrome };
  const chromium = pick(/\bChromium\/([\d.]+)/);
  if (chromium) return { name: 'chromium', version: chromium };
  return { name: 'unknown', version: '' };
}

/** Identify the browser from `navigator.userAgentData.brands` when available. */
export function browserFromBrands(brands: ReadonlyArray<{ brand: string; version: string }> | undefined): BrowserInfo | undefined {
  if (!brands || brands.length === 0) return undefined;
  const find = (re: RegExp) => brands.find((b) => re.test(b.brand));
  const edge = find(/Microsoft Edge/i);
  if (edge) return { name: 'edge', version: edge.version };
  const brave = find(/Brave/i);
  if (brave) return { name: 'brave', version: brave.version };
  const opera = find(/Opera/i);
  if (opera) return { name: 'opera', version: opera.version };
  const chrome = find(/Google Chrome/i);
  if (chrome) return { name: 'chrome', version: chrome.version };
  const chromium = find(/Chromium/i);
  if (chromium) return { name: 'chromium', version: chromium.version };
  return undefined;
}

/** Human-readable browser label for the popup. */
export function browserLabel(info: BrowserInfo): string {
  const names: Record<BrowserInfo['name'], string> = {
    edge: 'Microsoft Edge',
    chrome: 'Google Chrome',
    brave: 'Brave',
    opera: 'Opera',
    vivaldi: 'Vivaldi',
    chromium: 'Chromium',
    unknown: 'Unknown browser',
  };
  return info.version ? `${names[info.name]} ${info.version.split('.')[0]}` : names[info.name];
}

// ---------------------------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------------------------

export interface KeyCombo {
  key: string;
  code: string;
  keyCode: number;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

const KEY_ALIASES: Record<string, string> = {
  esc: 'Escape',
  escape: 'Escape',
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  space: ' ',
  spacebar: ' ',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  insert: 'Insert',
  capslock: 'CapsLock',
};

const KEY_CODES: Record<string, number> = {
  Escape: 27,
  Enter: 13,
  Tab: 9,
  ' ': 32,
  Backspace: 8,
  Delete: 46,
  ArrowUp: 38,
  ArrowDown: 40,
  ArrowLeft: 37,
  ArrowRight: 39,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34,
  Insert: 45,
  CapsLock: 20,
};

function codeForKey(key: string): string {
  if (key === ' ') return 'Space';
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  if (/^F([1-9]|1[0-2])$/.test(key)) return key;
  return key;
}

function keyCodeFor(key: string): number {
  if (KEY_CODES[key] !== undefined) return KEY_CODES[key];
  if (/^[a-z]$/i.test(key)) return key.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(key)) return key.charCodeAt(0);
  const f = key.match(/^F([1-9]|1[0-2])$/);
  if (f) return 111 + Number(f[1]);
  return 0;
}

/**
 * Parse a key combination such as "Control+Shift+a", "Enter", "Escape", "ctrl+k" into
 * a KeyboardEvent initialiser. Modifier names: Control/Ctrl, Shift, Alt/Option, Meta/Cmd/Command/Win.
 */
export function parseKeyCombo(combo: string): KeyCombo {
  const parts = combo.split('+').map((p) => p.trim()).filter((p, i, arr) => p.length > 0 || (i === arr.length - 1 && combo.endsWith('+')));
  // A trailing "+" means the literal plus key (e.g. "Control++").
  if (combo.trim().endsWith('+') && parts[parts.length - 1] !== '+') parts.push('+');
  const result: KeyCombo = { key: '', code: '', keyCode: 0, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false };
  for (const raw of parts) {
    const lower = raw.toLowerCase();
    if (lower === 'control' || lower === 'ctrl') result.ctrlKey = true;
    else if (lower === 'shift') result.shiftKey = true;
    else if (lower === 'alt' || lower === 'option') result.altKey = true;
    else if (lower === 'meta' || lower === 'cmd' || lower === 'command' || lower === 'win' || lower === 'super') result.metaKey = true;
    else {
      let key = KEY_ALIASES[lower] ?? raw;
      if (/^f([1-9]|1[0-2])$/i.test(key)) key = key.toUpperCase();
      // Single letters follow the shift state so `Shift+a` produces "A".
      if (/^[a-z]$/i.test(key)) key = result.shiftKey ? key.toUpperCase() : key.toLowerCase();
      result.key = key;
    }
  }
  if (!result.key) {
    // Modifier-only combos: report the last modifier as the key.
    if (result.metaKey) result.key = 'Meta';
    else if (result.altKey) result.key = 'Alt';
    else if (result.shiftKey) result.key = 'Shift';
    else if (result.ctrlKey) result.key = 'Control';
  }
  result.code = codeForKey(result.key);
  result.keyCode = keyCodeFor(result.key);
  return result;
}

// ---------------------------------------------------------------------------------------------
// Accessibility helpers (pure)
// ---------------------------------------------------------------------------------------------

export interface NameSources {
  ariaLabel?: string | null;
  labelledBy?: string | null;
  label?: string | null;
  placeholder?: string | null;
  title?: string | null;
  alt?: string | null;
  value?: string | null;
  text?: string | null;
}

/**
 * Compute an accessible name from already-extracted sources, in ARIA priority order:
 * aria-labelledby, aria-label, <label>, placeholder, title, alt, button value, inner text.
 */
export function accessibleNameFrom(src: NameSources, max = 80): string {
  const order = [src.labelledBy, src.ariaLabel, src.label, src.placeholder, src.title, src.alt, src.value, src.text];
  for (const candidate of order) {
    if (candidate) {
      const clean = collapseWhitespace(candidate);
      if (clean) return truncate(clean, max);
    }
  }
  return '';
}

const INPUT_ROLES: Record<string, string> = {
  button: 'button',
  submit: 'button',
  reset: 'button',
  image: 'button',
  checkbox: 'checkbox',
  radio: 'radio',
  range: 'slider',
  number: 'spinbutton',
  search: 'searchbox',
  file: 'button',
  color: 'button',
  date: 'textbox',
  'datetime-local': 'textbox',
  month: 'textbox',
  week: 'textbox',
  time: 'textbox',
};

/** Implicit ARIA role for an element described by tag / input type / explicit role attribute. */
export function roleFor(tag: string, opts: { type?: string | null; role?: string | null; href?: boolean; contentEditable?: boolean; level?: number } = {}): string {
  const explicit = opts.role?.trim().split(/\s+/)[0];
  if (explicit) return explicit.toLowerCase();
  const t = tag.toLowerCase();
  switch (t) {
    case 'a':
    case 'area':
      return opts.href ? 'link' : 'generic';
    case 'button':
      return 'button';
    case 'input': {
      const type = (opts.type ?? 'text').toLowerCase();
      if (type === 'hidden') return 'hidden';
      return INPUT_ROLES[type] ?? 'textbox';
    }
    case 'select':
      return 'combobox';
    case 'textarea':
      return 'textbox';
    case 'summary':
      return 'button';
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return 'heading';
    case 'nav':
      return 'navigation';
    case 'main':
      return 'main';
    case 'header':
      return 'banner';
    case 'footer':
      return 'contentinfo';
    case 'aside':
      return 'complementary';
    case 'form':
      return 'form';
    case 'img':
      return 'img';
    case 'details':
      return 'group';
    case 'option':
      return 'option';
    default:
      if (opts.contentEditable) return 'textbox';
      return 'generic';
  }
}

/** Does a snapshot element match a free-text filter (case-insensitive on role, name, value, href)? */
export function matchesFilter(el: { role: string; name: string; value?: string; href?: string; tag: string }, filter: string | undefined): boolean {
  if (!filter) return true;
  const f = filter.trim().toLowerCase();
  if (!f) return true;
  return [el.role, el.name, el.value ?? '', el.href ?? '', el.tag].some((v) => v.toLowerCase().includes(f));
}

// ---------------------------------------------------------------------------------------------
// Readability (pure part)
// ---------------------------------------------------------------------------------------------

/** Score a text block for "main content" likelihood: length, sentence punctuation, link density. */
export function contentScore(text: string, linkTextLength: number): number {
  const clean = collapseWhitespace(text);
  if (clean.length < 40) return 0;
  const punctuation = (clean.match(/[.,;:!?]/g) ?? []).length;
  const linkDensity = Math.min(1, linkTextLength / Math.max(1, clean.length));
  return (clean.length + punctuation * 20) * (1 - linkDensity * 0.8);
}

/** Normalise extracted text: trim lines, collapse blank runs, cap the total length. */
export function tidyText(raw: string, maxChars: number): { text: string; truncated: boolean } {
  const lines = raw
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim());
  const out: string[] = [];
  let blank = 0;
  for (const line of lines) {
    if (!line) {
      blank++;
      if (blank <= 1 && out.length) out.push('');
      continue;
    }
    blank = 0;
    out.push(line);
  }
  let text = out.join('\n').trim();
  let truncated = false;
  if (text.length > maxChars) {
    text = text.slice(0, maxChars).trimEnd();
    truncated = true;
  }
  return { text, truncated };
}

// ---------------------------------------------------------------------------------------------
// Ref registry — stable element identifiers across snapshots
// ---------------------------------------------------------------------------------------------

/**
 * Assigns "e1", "e2", ... to objects (DOM elements in practice) and resolves them back.
 * WeakMap + WeakRef so removed elements can be garbage-collected. Generic so it is testable
 * with plain objects.
 */
export class RefRegistry<T extends object> {
  private readonly byObject = new WeakMap<T, string>();
  private readonly byRef = new Map<string, WeakRef<T>>();
  private counter = 0;

  constructor(private readonly prefix = 'e') {}

  refFor(obj: T): string {
    const existing = this.byObject.get(obj);
    if (existing) return existing;
    this.counter++;
    const ref = `${this.prefix}${this.counter}`;
    this.byObject.set(obj, ref);
    this.byRef.set(ref, new WeakRef(obj));
    return ref;
  }

  resolve(ref: string): T | undefined {
    const weak = this.byRef.get(ref);
    if (!weak) return undefined;
    const obj = weak.deref();
    if (!obj) this.byRef.delete(ref);
    return obj;
  }

  get size(): number {
    return this.byRef.size;
  }

  /** Drop refs whose targets were collected or fail `isAlive`. */
  prune(isAlive?: (obj: T) => boolean): void {
    for (const [ref, weak] of this.byRef) {
      const obj = weak.deref();
      if (!obj || (isAlive && !isAlive(obj))) this.byRef.delete(ref);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Connection helpers
// ---------------------------------------------------------------------------------------------

/** Exponential backoff schedule: 2 s, 4 s, 8 s, 16 s, 30 s, 30 s ... (attempt is 0-based). */
export function backoffDelay(attempt: number, base = EXT_DEFAULT_RECONNECT_MS, max = EXT_MAX_RECONNECT_MS): number {
  const a = Math.max(0, Math.floor(attempt));
  return Math.min(max, base * 2 ** a);
}

/** Add ±jitter (fraction, default 15%) to a delay so reconnecting clients spread out. */
export function withJitter(ms: number, fraction = 0.15, random: () => number = Math.random): number {
  const spread = ms * fraction;
  return Math.round(ms - spread + random() * spread * 2);
}

/** Validate and normalise a port number; falls back to the default for garbage. */
export function normalizePort(input: unknown, fallback = HUB_DEFAULT_PORT): number {
  const n = typeof input === 'string' ? Number(input.trim()) : typeof input === 'number' ? input : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 65535) return fallback;
  return n;
}

/** Build the hub WebSocket URL for a port. */
export function hubUrl(port: number, host: string, path: string): string {
  return `ws://${host}:${port}${path}`;
}

/** Decode one WebSocket text frame into an RPC message, or undefined for garbage. */
export function parseRpcFrame(data: unknown): RpcMessage | undefined {
  if (typeof data !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(data);
    if (!parsed || typeof parsed !== 'object' || (parsed as { jsonrpc?: unknown }).jsonrpc !== '2.0') return undefined;
    return parsed as RpcMessage;
  } catch {
    return undefined;
  }
}

/** Encode an RPC message for the wire. */
export function encodeRpcFrame(message: RpcMessage): string {
  return JSON.stringify(message);
}

/** Human-readable explanation of a WebSocket close code from the hub. */
export function describeClose(code: number, reason: string): string {
  if (code === 4001) return 'Pairing token rejected by A.I.M. Copy the current token from A.I.M. Settings.';
  if (code === 1000) return reason ? `Connection closed: ${reason}` : 'Connection closed by A.I.M.';
  if (code === 1006) return 'A.I.M. is not reachable. Make sure the A.I.M. desktop app is running.';
  if (code === 1001) return 'A.I.M. is shutting down or restarting.';
  return reason ? `Connection closed (${code}): ${reason}` : `Connection closed (code ${code}).`;
}

// ---------------------------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------------------------

/** Clamp a number into [min, max]. */
export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** Promise that resolves after `ms`. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Race a promise against a timeout. Rejects with an Error carrying `.timeout = true`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`${label} timed out after ${Math.round(ms / 1000)} s`) as Error & { timeout: boolean };
      err.timeout = true;
      reject(err);
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Message of an unknown error value. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/** Per-key throttle: returns true when an event for `key` may fire (at most once per `intervalMs`). */
export class KeyedThrottle {
  private readonly last = new Map<string | number, number>();
  constructor(private readonly intervalMs: number) {}
  allow(key: string | number, now = Date.now()): boolean {
    const prev = this.last.get(key) ?? -Infinity;
    if (now - prev < this.intervalMs) return false;
    this.last.set(key, now);
    if (this.last.size > 2000) {
      for (const [k, t] of this.last) if (now - t > this.intervalMs * 10) this.last.delete(k);
    }
    return true;
  }
  forget(key: string | number): void {
    this.last.delete(key);
  }
}

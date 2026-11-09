/**
 * A.I.M. Browser Bridge — content script (ISOLATED world, main frame only).
 *
 * Serves the `ext.page.*` / `ext.cursor.*` subset on behalf of the background worker: DOM snapshots
 * with stable refs, realistic clicks/typing guarded by the payment policy, readable text, waiting,
 * and the teal A.I.M. cursor overlay (rendered only while this tab is visible).
 */
import {
  COLORS,
  PAYMENT_BLOCK_MESSAGE,
  RpcErrorCode,
  guardClick,
  guardType,
  type ExtParams,
  type ExtResult,
  type ExtSnapshot,
  type ExtSnapshotElement,
  type ExtTarget,
} from '@aim/shared';
import type { ContentResponse, FromContentMessage, PageMethod, ToContentMessage } from './messages.js';
import {
  KeyedThrottle,
  RefRegistry,
  accessibleNameFrom,
  clamp,
  collapseWhitespace,
  errorMessage,
  matchesFilter,
  maskValue,
  parseKeyCombo,
  roleFor,
  sleep,
  tidyText,
  truncate,
} from './shared-utils.js';

declare global {
  interface Window {
    /**
     * Set by the running instance. `alive()` turns false once the extension that injected it was
     * reloaded; `dispose()` detaches the instance (used by diagnostics and the e2e harness).
     */
    __aimContent?: { alive: () => boolean; dispose: () => void };
  }
}

const SNAPSHOT_DEFAULT_MAX = 400;
const TEXT_DEFAULT_MAX = 15_000;
const CURSOR_AUTOHIDE_MS = 2_000;
const CURSOR_MOVE_MS = 250;

class PageError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------------------------
// Element discovery
// ---------------------------------------------------------------------------------------------

const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  '[role="button"]',
  '[role="link"]',
  '[role="textbox"]',
  '[role="searchbox"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="option"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="tab"]',
  '[role="switch"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[contenteditable]:not([contenteditable="false"])',
  '[onclick]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const STRUCTURE_SELECTOR = ['h1', 'h2', 'h3', 'main', 'nav', 'form', '[role="main"]', '[role="navigation"]', '[role="dialog"]', '[role="alertdialog"]', '[role="alert"]', '[role="search"]', '[role="heading"]'].join(',');

const CANDIDATE_SELECTOR = `${INTERACTIVE_SELECTOR},${STRUCTURE_SELECTOR}`;

const SKIP_TEXT_SELECTOR = 'script,style,noscript,template,svg,canvas,video,audio,iframe,object,embed,[aria-hidden="true"],[hidden]';
const CHROME_SELECTOR = 'nav,footer,header,aside,[role="navigation"],[role="banner"],[role="contentinfo"],[role="complementary"]';
const BLOCK_TAGS = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DETAILS', 'DIALOG', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TR', 'TD', 'TH', 'UL', 'BR', 'LABEL', 'OPTION', 'SUMMARY', 'TBODY', 'THEAD']);

const refs = new RefRegistry<Element>('e');

/** Walk the composed tree (document + open shadow roots) in document order, yielding elements. */
function* walkElements(root: Node, depth = 0): Generator<Element> {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let node = walker.nextNode();
  while (node) {
    const el = node as Element;
    yield el;
    if (el.shadowRoot && depth < 8) yield* walkElements(el.shadowRoot, depth + 1);
    node = walker.nextNode();
  }
}

/** Query a selector across the document and open shadow roots. */
function deepQuerySelector(selector: string, root: ParentNode = document): Element | null {
  const direct = root.querySelector(selector);
  if (direct) return direct;
  for (const el of walkElements(root as Node)) {
    if (el.shadowRoot) {
      const hit = el.shadowRoot.querySelector(selector);
      if (hit) return hit;
    }
  }
  return null;
}

function isRendered(el: Element): boolean {
  if (!el.isConnected) return false;
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 && rect.height <= 0) return false;
  return true;
}

function inViewport(rect: DOMRect): boolean {
  return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
}

function textOfIds(ids: string | null, root: Document | ShadowRoot): string {
  if (!ids) return '';
  return ids
    .split(/\s+/)
    .map((id) => root.getElementById?.(id)?.textContent ?? document.getElementById(id)?.textContent ?? '')
    .join(' ');
}

function ownText(el: Element): string {
  if (el instanceof HTMLElement) {
    const t = el.innerText;
    if (t) return t;
  }
  return el.textContent ?? '';
}

function labelFor(el: Element): string {
  const control = el as HTMLInputElement;
  if ('labels' in control && control.labels && control.labels.length > 0) {
    return Array.from(control.labels)
      .map((l) => l.textContent ?? '')
      .join(' ');
  }
  const wrapping = el.closest('label');
  if (wrapping) {
    // Label text minus the control's own value.
    return wrapping.textContent ?? '';
  }
  return '';
}

function accessibleName(el: Element, role: string): string {
  const root = el.getRootNode() as Document | ShadowRoot;
  const isLandmark = ['main', 'navigation', 'form', 'dialog', 'alertdialog', 'alert', 'search', 'region', 'banner', 'contentinfo', 'complementary', 'listbox'].includes(role);
  const isControl = el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement;
  const img = el.querySelector('img[alt], svg[aria-label], [role="img"][aria-label]');
  const inputValueAsName = el instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(el.type) ? el.value : undefined;
  return accessibleNameFrom({
    labelledBy: textOfIds(el.getAttribute('aria-labelledby'), root),
    ariaLabel: el.getAttribute('aria-label'),
    label: isControl || el.getAttribute('role') ? labelFor(el) : undefined,
    placeholder: el.getAttribute('placeholder'),
    title: el.getAttribute('title'),
    alt: el.getAttribute('alt') ?? img?.getAttribute('alt') ?? img?.getAttribute('aria-label'),
    value: inputValueAsName,
    text: isLandmark || isControl ? undefined : ownText(el),
  });
}

function elementValue(el: Element): string | undefined {
  if (el instanceof HTMLInputElement) {
    if (el.type === 'password') return maskValue(el.value);
    if (el.type === 'checkbox' || el.type === 'radio') return undefined;
    if (el.type === 'file') return el.files && el.files.length ? `${el.files.length} file(s)` : '';
    return truncate(el.value, 200);
  }
  if (el instanceof HTMLTextAreaElement) return truncate(el.value, 200);
  if (el instanceof HTMLSelectElement) {
    const opt = el.selectedOptions[0];
    return opt ? truncate(opt.label || opt.textContent || opt.value, 200) : '';
  }
  if ((el as HTMLElement).isContentEditable) return truncate(collapseWhitespace(el.textContent ?? ''), 200);
  const ariaValue = el.getAttribute('aria-valuenow') ?? el.getAttribute('aria-valuetext');
  if (ariaValue) return ariaValue;
  return undefined;
}

function describeElement(el: Element): ExtSnapshotElement | undefined {
  const tag = el.tagName.toLowerCase();
  if (el instanceof HTMLInputElement && el.type === 'hidden') return undefined;
  if (el.closest('template')) return undefined;
  const role = roleFor(tag, {
    type: el.getAttribute('type'),
    role: el.getAttribute('role'),
    href: el.hasAttribute('href'),
    contentEditable: (el as HTMLElement).isContentEditable,
  });
  if (role === 'hidden') return undefined;
  const rect = el.getBoundingClientRect();
  const rendered = isRendered(el);
  const name = accessibleName(el, role);
  const item: ExtSnapshotElement = {
    ref: refs.refFor(el),
    role,
    name,
    tag,
    visible: rendered,
  };
  const value = elementValue(el);
  if (value !== undefined && value !== '') item.value = value;
  if (el instanceof HTMLAnchorElement && el.href) item.href = truncate(el.href, 500);
  const disabled = (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true';
  if (disabled) item.disabled = true;
  if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) item.checked = el.checked;
  else if (el.hasAttribute('aria-checked')) item.checked = el.getAttribute('aria-checked') === 'true';
  else if (el.hasAttribute('aria-pressed')) item.checked = el.getAttribute('aria-pressed') === 'true';
  if (rendered) {
    item.box = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
  }
  const extra: Record<string, string | number | boolean> = {};
  if (rendered) extra.inViewport = inViewport(rect);
  const headingLevel = /^h([1-6])$/.exec(tag)?.[1] ?? el.getAttribute('aria-level');
  if (role === 'heading' && headingLevel) extra.level = Number(headingLevel);
  if (el instanceof HTMLInputElement) extra.type = el.type;
  if (el.hasAttribute('required') || el.getAttribute('aria-required') === 'true') extra.required = true;
  if (el.hasAttribute('aria-expanded')) extra.expanded = el.getAttribute('aria-expanded') === 'true';
  if (el.hasAttribute('aria-selected')) extra.selected = el.getAttribute('aria-selected') === 'true';
  if (el instanceof HTMLAnchorElement && el.target === '_blank') extra.newTab = true;
  if (el.hasAttribute('autocomplete')) extra.autocomplete = el.getAttribute('autocomplete') ?? '';
  if (el.id) extra.id = el.id;
  if (Object.keys(extra).length) item.extra = extra;
  return item;
}

function snapshot(params: ExtParams<'ext.page.snapshot'>): ExtSnapshot {
  const max = clamp(Number(params.maxElements ?? SNAPSHOT_DEFAULT_MAX) || SNAPSHOT_DEFAULT_MAX, 1, 2000);
  const described: ExtSnapshotElement[] = [];
  let scanned = 0;
  for (const el of walkElements(document.documentElement)) {
    scanned++;
    if (scanned > 50_000) break;
    if (!el.matches(CANDIDATE_SELECTOR)) continue;
    const item = describeElement(el);
    if (!item) continue;
    if (!matchesFilter(item, params.filter)) continue;
    described.push(item);
  }
  refs.prune((el) => el.isConnected);
  let elements = described;
  let truncated = false;
  if (described.length > max) {
    truncated = true;
    const rank = (e: ExtSnapshotElement) => (e.visible && e.extra?.inViewport ? 0 : e.visible ? 1 : 2);
    const indexed = described.map((e, i) => ({ e, i }));
    indexed.sort((a, b) => rank(a.e) - rank(b.e) || a.i - b.i);
    elements = indexed
      .slice(0, max)
      .sort((a, b) => a.i - b.i)
      .map((x) => x.e);
  }
  const result: ExtSnapshot = {
    url: location.href,
    title: document.title,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: Math.round(window.scrollX),
      scrollY: Math.round(window.scrollY),
      pageHeight: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
    },
    elements,
  };
  if (truncated) result.truncated = true;
  if (params.includeText) {
    const { text, truncated: textTruncated } = readableText(undefined, TEXT_DEFAULT_MAX, false);
    result.text = text;
    if (textTruncated) result.truncated = true;
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Readable text
// ---------------------------------------------------------------------------------------------

function mainContentRoot(): Element {
  const preferred = document.querySelector('main, [role="main"], article');
  if (preferred && (preferred.textContent ?? '').trim().length > 200) return preferred;
  return document.body ?? document.documentElement;
}

interface ReadResult { text: string; links: { text: string; href: string }[]; truncated: boolean }

function readableText(root: Element | undefined, maxChars: number, collectLinks: boolean): ReadResult {
  const start = root ?? mainContentRoot();
  const stripChrome = !root; // only when reading the whole page
  const parts: string[] = [];
  const links: { text: string; href: string }[] = [];
  const seenLinks = new Set<string>();
  let length = 0;
  const budget = maxChars * 1.3;

  const visit = (node: Node): boolean => {
    if (length > budget) return false;
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.nodeValue ?? '';
      if (text.trim()) {
        parts.push(text);
        length += text.length;
      }
      return true;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return true;
    const el = node as Element;
    if (el.matches(SKIP_TEXT_SELECTOR)) return true;
    if (stripChrome && el !== start && el.matches(CHROME_SELECTOR)) return true;
    if (el instanceof HTMLElement) {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return true;
    }
    const tag = el.tagName;
    const block = BLOCK_TAGS.has(tag) || (el instanceof HTMLElement && /^(block|list-item|table|flex|grid)/.test(getComputedStyle(el).display));
    if (block) parts.push('\n');
    const heading = /^H([1-6])$/.exec(tag);
    if (heading) parts.push('#'.repeat(Number(heading[1])) + ' ');
    if (tag === 'LI') parts.push('- ');
    if (tag === 'BR') parts.push('\n');
    if (el instanceof HTMLInputElement && el.type !== 'hidden' && el.type !== 'password' && el.value) parts.push(`[${el.value}]`);
    if (el instanceof HTMLTextAreaElement && el.value) parts.push(`[${el.value}]`);
    if (tag === 'IMG') {
      const alt = el.getAttribute('alt');
      if (alt) parts.push(`[image: ${alt}]`);
    }
    if (collectLinks && el instanceof HTMLAnchorElement && el.href && !el.href.startsWith('javascript:')) {
      const text = collapseWhitespace(el.textContent ?? '') || el.getAttribute('aria-label') || el.title;
      if (text && !seenLinks.has(el.href) && links.length < 200) {
        seenLinks.add(el.href);
        links.push({ text: truncate(text, 120), href: el.href });
      }
    }
    const children = el.shadowRoot ? [...el.shadowRoot.childNodes, ...el.childNodes] : el.childNodes;
    for (const child of Array.from(children)) if (!visit(child)) return false;
    if (block) parts.push('\n');
    if (tag === 'TD' || tag === 'TH') parts.push('\t');
    return true;
  };
  visit(start);
  const tidy = tidyText(parts.join(''), maxChars);
  return { text: tidy.text, links, truncated: tidy.truncated };
}

// ---------------------------------------------------------------------------------------------
// Targets & guards
// ---------------------------------------------------------------------------------------------

function resolveTarget(target: ExtTarget | undefined, required = true): Element | undefined {
  if (!target || (!target.ref && !target.selector)) {
    if (required) throw new PageError(RpcErrorCode.InvalidParams, 'A target is required: pass {ref} from ext.page.snapshot or {selector}.');
    return undefined;
  }
  if (target.ref) {
    const el = refs.resolve(target.ref);
    if (!el || !el.isConnected) throw new PageError(RpcErrorCode.InvalidParams, `Element ${target.ref} is no longer on the page. Take a new ext.page.snapshot and use a fresh ref.`);
    return el;
  }
  let el: Element | null = null;
  try {
    el = deepQuerySelector(target.selector!);
  } catch {
    throw new PageError(RpcErrorCode.InvalidParams, `Invalid CSS selector: ${target.selector}`);
  }
  if (!el) throw new PageError(RpcErrorCode.InvalidParams, `No element matches selector "${target.selector}".`);
  return el;
}

function fieldMeta(el: Element): { name?: string; id?: string; autocomplete?: string; placeholder?: string; label?: string; type?: string } {
  const input = el as HTMLInputElement;
  return {
    name: input.name || el.getAttribute('name') || undefined,
    id: el.id || undefined,
    autocomplete: el.getAttribute('autocomplete') || undefined,
    placeholder: el.getAttribute('placeholder') || undefined,
    label: collapseWhitespace(labelFor(el) || el.getAttribute('aria-label') || ''),
    type: el.getAttribute('type') || undefined,
  };
}

function notifyBlocked(reason: string): void {
  sendToBackground({ kind: 'aim.blocked', reason });
}

function assertClickAllowed(el: Element): void {
  const role = roleFor(el.tagName, { role: el.getAttribute('role'), type: el.getAttribute('type'), href: el.hasAttribute('href') });
  const label = collapseWhitespace([accessibleName(el, role), ownText(el), (el as HTMLInputElement).value ?? ''].filter(Boolean).join(' '));
  const field = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement ? fieldMeta(el) : undefined;
  const verdict = guardClick({ url: location.href, label: truncate(label, 80), field });
  if (verdict.blocked) {
    notifyBlocked(verdict.reason ?? 'payment action');
    throw new PageError(RpcErrorCode.PolicyBlocked, PAYMENT_BLOCK_MESSAGE, { reason: verdict.reason, signal: verdict.signal });
  }
}

function assertTypeAllowed(el: Element, text: string): void {
  const verdict = guardType({ url: location.href, text, field: fieldMeta(el) });
  if (verdict.blocked) {
    notifyBlocked(verdict.reason ?? 'payment input');
    throw new PageError(RpcErrorCode.PolicyBlocked, PAYMENT_BLOCK_MESSAGE, { reason: verdict.reason, signal: verdict.signal });
  }
}

// ---------------------------------------------------------------------------------------------
// Cursor overlay
// ---------------------------------------------------------------------------------------------

class CursorOverlay {
  private host?: HTMLElement;
  private arrow?: HTMLElement;
  private shown = false;
  private x = 0;
  private y = 0;
  private hideTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    document.addEventListener('visibilitychange', () => this.render());
  }

  private ensure(): HTMLElement {
    if (this.host && this.host.isConnected) return this.arrow!;
    const host = document.createElement('aim-cursor');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483647;display:none;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        .arrow{position:fixed;left:0;top:0;transform:translate(0px,0px);transition:transform ${CURSOR_MOVE_MS}ms cubic-bezier(.2,.8,.2,1),opacity .15s ease;will-change:transform;opacity:1;filter:drop-shadow(0 0 6px ${COLORS.teal}99) drop-shadow(0 2px 3px rgba(0,0,0,.45));}
        .arrow svg{display:block;width:26px;height:30px;overflow:visible}
        .tag{position:absolute;left:20px;top:22px;font:600 10px/1 system-ui,-apple-system,"Segoe UI",sans-serif;letter-spacing:.06em;color:#fff;background:${COLORS.teal};border:1px solid rgba(255,255,255,.85);border-radius:4px;padding:3px 5px;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,.4)}
      </style>
      <div class="arrow">
        <svg viewBox="0 0 24 28" xmlns="http://www.w3.org/2000/svg">
          <path d="M3 2 L3 21 L8 16.5 L11.5 24 L15 22.5 L11.5 15 L18 15 Z" fill="${COLORS.teal}" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/>
        </svg>
        <span class="tag">A.I.M.</span>
      </div>`;
    (document.documentElement ?? document.body).appendChild(host);
    this.host = host;
    this.arrow = shadow.querySelector('.arrow') as HTMLElement;
    this.arrow.style.transform = `translate(${this.x}px, ${this.y}px)`;
    return this.arrow;
  }

  private render(): void {
    const visible = this.shown && document.visibilityState === 'visible';
    if (!visible) {
      if (this.host) this.host.style.display = 'none';
      return;
    }
    const arrow = this.ensure();
    this.host!.style.display = 'block';
    arrow.style.transform = `translate(${this.x}px, ${this.y}px)`;
  }

  show(x?: number, y?: number): void {
    if (typeof x === 'number' && typeof y === 'number') {
      this.x = x;
      this.y = y;
    } else if (!this.shown) {
      this.x = Math.round(window.innerWidth / 2);
      this.y = Math.round(window.innerHeight / 2);
    }
    this.shown = true;
    this.clearAutoHide();
    this.render();
  }

  hide(): void {
    this.shown = false;
    this.clearAutoHide();
    this.render();
  }

  async moveTo(x: number, y: number, durationMs = CURSOR_MOVE_MS): Promise<void> {
    this.x = clamp(x, 0, window.innerWidth);
    this.y = clamp(y, 0, window.innerHeight);
    const wasShown = this.shown;
    this.shown = true;
    if (document.visibilityState === 'visible') {
      const arrow = this.ensure();
      this.host!.style.display = 'block';
      arrow.style.transitionDuration = `${Math.max(0, durationMs)}ms, 150ms`;
      if (!wasShown) {
        // Start from the previous logical position without animating the appearance.
        void arrow.offsetWidth;
      }
      arrow.style.transform = `translate(${this.x}px, ${this.y}px)`;
      await sleep(Math.max(0, durationMs));
    }
  }

  /** Show for an action, then hide automatically after a quiet period. */
  touch(): void {
    this.clearAutoHide();
    this.hideTimer = setTimeout(() => this.hide(), CURSOR_AUTOHIDE_MS);
  }

  private clearAutoHide(): void {
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = undefined;
    }
  }
}

const cursor = new CursorOverlay();

// ---------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------

function centerOf(el: Element): { x: number; y: number } {
  const rect = el.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function mouseInit(x: number, y: number, button: number, detail: number): MouseEventInit & PointerEventInit {
  return {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX: x,
    clientY: y,
    screenX: x + window.screenX,
    screenY: y + window.screenY,
    button,
    buttons: button === 0 ? 1 : button === 2 ? 2 : 4,
    detail,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
  };
}

function dispatchPointerSequence(el: Element, x: number, y: number, button: number, detail: number): boolean {
  const init = mouseInit(x, y, button, detail);
  el.dispatchEvent(new PointerEvent('pointerover', init));
  el.dispatchEvent(new MouseEvent('mouseover', init));
  el.dispatchEvent(new PointerEvent('pointermove', init));
  el.dispatchEvent(new MouseEvent('mousemove', init));
  const down = el.dispatchEvent(new PointerEvent('pointerdown', init));
  const mouseDown = el.dispatchEvent(new MouseEvent('mousedown', init));
  if (down && mouseDown) focusElement(el);
  el.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }));
  el.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }));
  return down && mouseDown;
}

function focusElement(el: Element): void {
  if (el instanceof HTMLElement || el instanceof SVGElement) {
    try {
      el.focus({ preventScroll: true });
    } catch {
      /* ignore */
    }
  }
}

async function click(params: ExtParams<'ext.page.click'>): Promise<ExtResult<'ext.page.click'>> {
  const el = resolveTarget(params.target)!;
  assertClickAllowed(el);
  const hrefBefore = location.href;
  let unloading = false;
  const onUnload = () => {
    unloading = true;
  };
  window.addEventListener('pagehide', onUnload, { once: true });
  window.addEventListener('beforeunload', onUnload, { once: true });
  try {
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior });
    await sleep(30);
    const { x, y } = centerOf(el);
    await cursor.moveTo(x, y, CURSOR_MOVE_MS);
    cursor.touch();
    const button = params.button === 'right' ? 2 : params.button === 'middle' ? 1 : 0;
    const anchor = el instanceof HTMLAnchorElement ? el : el.closest<HTMLAnchorElement>('a[href]');
    const clicks = params.double ? 2 : 1;
    for (let i = 1; i <= clicks; i++) {
      dispatchPointerSequence(el, x, y, button, i);
      if (button === 0) {
        if (anchor && anchor.target === '_blank' && i === clicks) {
          // Let the browser perform the default action for new-tab links.
          anchor.click();
        } else {
          el.dispatchEvent(new PointerEvent('click', mouseInit(x, y, 0, i)));
        }
      } else if (button === 2) {
        el.dispatchEvent(new MouseEvent('contextmenu', mouseInit(x, y, 2, i)));
      } else {
        el.dispatchEvent(new MouseEvent('auxclick', mouseInit(x, y, 1, i)));
      }
    }
    if (params.double) el.dispatchEvent(new MouseEvent('dblclick', mouseInit(x, y, button, 2)));
    await sleep(300);
    const navigated = unloading || location.href !== hrefBefore;
    return navigated ? { ok: true, navigated: true } : { ok: true };
  } finally {
    window.removeEventListener('pagehide', onUnload);
    window.removeEventListener('beforeunload', onUnload);
  }
}

function nativeSetValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

function fireInput(el: Element, data: string, inputType = 'insertText'): void {
  el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, composed: true, data, inputType }));
  el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data, inputType }));
}

function fireChange(el: Element): void {
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function isTextInput(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
  if (el instanceof HTMLTextAreaElement) return true;
  if (!(el instanceof HTMLInputElement)) return false;
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image', 'range', 'color', 'hidden'].includes(el.type);
}

function editableTarget(target: ExtTarget | undefined): Element {
  const el = resolveTarget(target, false);
  if (el) return el;
  const active = deepActiveElement();
  if (!active || active === document.body || active === document.documentElement) {
    throw new PageError(RpcErrorCode.InvalidParams, 'No input is focused. Pass a target ({ref} or {selector}) or click an input first.');
  }
  return active;
}

function deepActiveElement(): Element | null {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}

async function type(params: ExtParams<'ext.page.type'>): Promise<ExtResult<'ext.page.type'>> {
  const el = editableTarget(params.target);
  const text = String(params.text ?? '');
  assertTypeAllowed(el, text);
  if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) throw new PageError(RpcErrorCode.InvalidParams, 'This is a checkbox/radio; use ext.page.click.');
  if (el instanceof HTMLSelectElement) throw new PageError(RpcErrorCode.InvalidParams, 'This is a <select>; use ext.page.select.');
  if ((el as HTMLInputElement).disabled || el.getAttribute('aria-disabled') === 'true') throw new PageError(RpcErrorCode.ToolFailed, 'The field is disabled.');
  if ((el as HTMLInputElement).readOnly) throw new PageError(RpcErrorCode.ToolFailed, 'The field is read-only.');

  el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior });
  const { x, y } = centerOf(el);
  await cursor.moveTo(x, y, CURSOR_MOVE_MS);
  cursor.touch();
  focusElement(el);

  if (isTextInput(el)) {
    const next = params.append ? el.value + text : text;
    if (!params.append) {
      try {
        el.select();
      } catch {
        /* some input types (email, number) do not support select() */
      }
    }
    nativeSetValue(el, next);
    fireInput(el, text);
    fireChange(el);
    try {
      const end = el.value.length;
      el.setSelectionRange(end, end);
    } catch {
      /* unsupported for this input type */
    }
  } else if ((el as HTMLElement).isContentEditable) {
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(el);
      if (params.append) range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    let inserted = false;
    try {
      inserted = document.execCommand('insertText', false, text);
    } catch {
      inserted = false;
    }
    if (!inserted) {
      if (params.append) el.appendChild(document.createTextNode(text));
      else el.textContent = text;
      fireInput(el, text);
    }
  } else {
    throw new PageError(RpcErrorCode.InvalidParams, `Element <${el.tagName.toLowerCase()}> is not editable. Target an input, textarea or contenteditable element.`);
  }

  if (params.pressEnter) {
    await sleep(50);
    pressEnterOn(el);
  }
  return { ok: true };
}

function dispatchKey(el: Element, type: 'keydown' | 'keypress' | 'keyup', combo: ReturnType<typeof parseKeyCombo>): boolean {
  const init: KeyboardEventInit & { keyCode?: number; which?: number } = {
    key: combo.key,
    code: combo.code,
    ctrlKey: combo.ctrlKey,
    shiftKey: combo.shiftKey,
    altKey: combo.altKey,
    metaKey: combo.metaKey,
    bubbles: true,
    cancelable: true,
    composed: true,
    keyCode: combo.keyCode,
    which: combo.keyCode,
  };
  const ev = new KeyboardEvent(type, init);
  // Legacy keyCode/which are read-only on the instance in Chromium; define them for old handlers.
  try {
    Object.defineProperty(ev, 'keyCode', { get: () => combo.keyCode });
    Object.defineProperty(ev, 'which', { get: () => combo.keyCode });
  } catch {
    /* ignore */
  }
  return el.dispatchEvent(ev);
}

/** Enter: keydown/keypress/keyup plus the browser's implicit form submission when appropriate. */
function pressEnterOn(el: Element): void {
  const combo = parseKeyCombo('Enter');
  const proceed = dispatchKey(el, 'keydown', combo);
  if (proceed) dispatchKey(el, 'keypress', combo);
  dispatchKey(el, 'keyup', combo);
  if (!proceed) return;
  const form = (el as HTMLInputElement).form ?? el.closest('form');
  if (form && el instanceof HTMLInputElement && isTextInput(el)) {
    const submitter = form.querySelector<HTMLElement>('button[type="submit"],input[type="submit"],button:not([type]),input[type="image"]');
    if (submitter) {
      assertClickAllowed(submitter);
      submitter.click();
      return;
    }
    const textInputs = Array.from(form.querySelectorAll('input')).filter((i) => isTextInput(i));
    if (textInputs.length === 1) {
      try {
        form.requestSubmit();
      } catch {
        form.submit();
      }
    }
  } else if (el instanceof HTMLButtonElement || el instanceof HTMLAnchorElement || el.getAttribute('role') === 'button') {
    assertClickAllowed(el);
    (el as HTMLElement).click();
  }
}

function focusableElements(): HTMLElement[] {
  const all = Array.from(document.querySelectorAll<HTMLElement>('a[href],button,input,select,textarea,summary,[tabindex],[contenteditable]:not([contenteditable="false"])'));
  return all.filter((el) => {
    if (el.tabIndex < 0) return false;
    if ((el as HTMLInputElement).disabled) return false;
    if (el instanceof HTMLInputElement && el.type === 'hidden') return false;
    return isRendered(el);
  });
}

async function pressKey(params: ExtParams<'ext.page.pressKey'>): Promise<ExtResult<'ext.page.pressKey'>> {
  const combo = parseKeyCombo(String(params.key));
  if (!combo.key) throw new PageError(RpcErrorCode.InvalidParams, `Cannot parse key "${params.key}".`);
  const active = deepActiveElement() ?? document.body;
  cursor.touch();
  if (combo.key === 'Enter' && !combo.ctrlKey && !combo.altKey && !combo.metaKey) {
    pressEnterOn(active);
    return { ok: true };
  }
  const proceed = dispatchKey(active, 'keydown', combo);
  const printable = combo.key.length === 1 && !combo.ctrlKey && !combo.altKey && !combo.metaKey;
  if (proceed && printable) dispatchKey(active, 'keypress', combo);
  if (proceed) {
    if (combo.key === 'Tab') {
      const list = focusableElements();
      const idx = list.indexOf(active as HTMLElement);
      const next = combo.shiftKey ? (idx <= 0 ? list[list.length - 1] : list[idx - 1]) : idx < 0 || idx === list.length - 1 ? list[0] : list[idx + 1];
      if (next) focusElement(next);
    } else if (combo.key === 'Escape') {
      const dialog = active.closest('dialog[open]') as HTMLDialogElement | null;
      if (dialog) {
        try {
          dialog.close();
        } catch {
          /* ignore */
        }
      }
    } else if (printable && isTextInput(active)) {
      assertTypeAllowed(active, combo.key);
      const start = active.selectionStart ?? active.value.length;
      const end = active.selectionEnd ?? active.value.length;
      nativeSetValue(active, active.value.slice(0, start) + combo.key + active.value.slice(end));
      try {
        active.setSelectionRange(start + 1, start + 1);
      } catch {
        /* ignore */
      }
      fireInput(active, combo.key);
    } else if (combo.key === 'Backspace' && isTextInput(active)) {
      const start = active.selectionStart ?? active.value.length;
      const end = active.selectionEnd ?? active.value.length;
      const from = start === end ? Math.max(0, start - 1) : start;
      nativeSetValue(active, active.value.slice(0, from) + active.value.slice(end));
      try {
        active.setSelectionRange(from, from);
      } catch {
        /* ignore */
      }
      fireInput(active, '', 'deleteContentBackward');
    } else if (combo.ctrlKey && combo.key.toLowerCase() === 'a' && isTextInput(active)) {
      try {
        active.select();
      } catch {
        /* ignore */
      }
    } else if (combo.key === ' ' && (active instanceof HTMLButtonElement || active.getAttribute('role') === 'button')) {
      assertClickAllowed(active);
      (active as HTMLElement).click();
    } else if ((combo.key === 'ArrowDown' || combo.key === 'ArrowUp' || combo.key === 'PageDown' || combo.key === 'PageUp') && active === document.body) {
      const step = combo.key.startsWith('Page') ? window.innerHeight * 0.9 : 60;
      window.scrollBy({ top: combo.key.endsWith('Down') ? step : -step, behavior: 'instant' as ScrollBehavior });
    }
  }
  dispatchKey(active, 'keyup', combo);
  return { ok: true };
}

async function select(params: ExtParams<'ext.page.select'>): Promise<ExtResult<'ext.page.select'>> {
  const el = resolveTarget(params.target)!;
  if (!(el instanceof HTMLSelectElement)) {
    throw new PageError(RpcErrorCode.InvalidParams, `Element <${el.tagName.toLowerCase()}> is not a <select>. For custom dropdowns, click to open them and click the option.`);
  }
  assertClickAllowed(el);
  const wanted = String(params.value);
  const options = Array.from(el.options);
  const norm = (s: string) => collapseWhitespace(s).toLowerCase();
  const match =
    options.find((o) => o.value === wanted) ??
    options.find((o) => norm(o.label || o.text) === norm(wanted)) ??
    options.find((o) => norm(o.value) === norm(wanted)) ??
    options.find((o) => norm(o.label || o.text).includes(norm(wanted)));
  if (!match) {
    const available = options.slice(0, 20).map((o) => o.label || o.text || o.value);
    throw new PageError(RpcErrorCode.InvalidParams, `No option matches "${wanted}". Available: ${available.join(' | ')}${options.length > 20 ? ' | …' : ''}`);
  }
  el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
  const { x, y } = centerOf(el);
  await cursor.moveTo(x, y, CURSOR_MOVE_MS);
  cursor.touch();
  focusElement(el);
  el.value = match.value;
  match.selected = true;
  fireInput(el, match.value, 'insertReplacementText');
  fireChange(el);
  return { ok: true, selected: match.label || match.text || match.value };
}

async function scroll(params: ExtParams<'ext.page.scroll'>): Promise<ExtResult<'ext.page.scroll'>> {
  const el = resolveTarget(params.target, false);
  const delta = typeof params.deltaY === 'number' && Number.isFinite(params.deltaY) ? params.deltaY : Math.round(window.innerHeight * 0.8);
  if (el) {
    if (params.intoView || params.deltaY === undefined) {
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior });
    } else {
      const style = getComputedStyle(el);
      const scrollable = /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight;
      if (scrollable) el.scrollBy({ top: delta, behavior: 'instant' as ScrollBehavior });
      else window.scrollBy({ top: delta, behavior: 'instant' as ScrollBehavior });
    }
  } else {
    window.scrollBy({ top: delta, behavior: 'instant' as ScrollBehavior });
  }
  await sleep(60);
  return { ok: true, scrollY: Math.round(window.scrollY) };
}

async function read(params: ExtParams<'ext.page.read'>): Promise<ExtResult<'ext.page.read'>> {
  const root = resolveTarget(params.target, false);
  const maxChars = clamp(Number(params.maxChars ?? TEXT_DEFAULT_MAX) || TEXT_DEFAULT_MAX, 100, 200_000);
  const { text, links, truncated } = readableText(root, maxChars, params.includeLinks === true);
  const result: ExtResult<'ext.page.read'> = { title: document.title, url: location.href, text };
  if (params.includeLinks) result.links = links;
  if (truncated) result.truncated = true;
  return result;
}

async function wait(params: ExtParams<'ext.page.wait'>): Promise<ExtResult<'ext.page.wait'>> {
  const timeoutMs = clamp(Number(params.timeoutMs ?? 10_000) || 10_000, 100, 60_000);
  const selector = typeof params.selector === 'string' && params.selector ? params.selector : undefined;
  const text = typeof params.text === 'string' && params.text ? params.text.toLowerCase() : undefined;
  if (!selector && !text) {
    await sleep(clamp(Number(params.ms ?? 0) || 0, 0, 60_000));
    return { ok: true };
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (selector) {
      try {
        const el = deepQuerySelector(selector);
        if (el && isRendered(el)) return { ok: true, matched: `selector:${selector}` };
      } catch {
        throw new PageError(RpcErrorCode.InvalidParams, `Invalid CSS selector: ${selector}`);
      }
    }
    if (text && (document.body?.innerText ?? '').toLowerCase().includes(text)) return { ok: true, matched: `text:${params.text}` };
    if (Date.now() >= deadline) {
      const what = [selector && `selector "${selector}"`, text && `text "${params.text}"`].filter(Boolean).join(' or ');
      throw new PageError(RpcErrorCode.Timeout, `Timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}.`);
    }
    await sleep(100);
  }
}

// ---------------------------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------------------------

type PageHandler<M extends PageMethod> = (params: ExtParams<M>) => Promise<ExtResult<M>>;

const pageHandlers: { [M in PageMethod]: PageHandler<M> } = {
  'ext.page.snapshot': async (p) => snapshot(p),
  'ext.page.click': click,
  'ext.page.type': type,
  'ext.page.select': select,
  'ext.page.pressKey': pressKey,
  'ext.page.scroll': scroll,
  'ext.page.read': read,
  'ext.page.wait': wait,
  'ext.cursor.show': async (p) => {
    cursor.show(p.x, p.y);
    return { ok: true };
  },
  'ext.cursor.hide': async () => {
    cursor.hide();
    return { ok: true };
  },
  'ext.cursor.move': async (p) => {
    await cursor.moveTo(Number(p.x) || 0, Number(p.y) || 0, typeof p.durationMs === 'number' ? p.durationMs : CURSOR_MOVE_MS);
    return { ok: true };
  },
};

async function handle(message: ToContentMessage): Promise<ContentResponse> {
  if (message.kind === 'aim.ping') return { ok: true, result: { ok: true } as never };
  const handler = pageHandlers[message.method] as PageHandler<PageMethod> | undefined;
  if (!handler) return { ok: false, code: RpcErrorCode.MethodNotFound, message: `Unknown page method ${String(message.method)}` };
  try {
    const result = await handler((message.params ?? {}) as ExtParams<PageMethod>);
    return { ok: true, result };
  } catch (e) {
    if (e instanceof PageError) return { ok: false, code: e.code, message: e.message, data: e.data };
    return { ok: false, code: RpcErrorCode.ToolFailed, message: errorMessage(e) };
  }
}

function sendToBackground(message: FromContentMessage): void {
  try {
    if (!chrome.runtime?.id) return; // extension reloaded; this script instance is orphaned
    void chrome.runtime.sendMessage(message).catch(() => undefined);
  } catch {
    /* orphaned context */
  }
}

// ---------------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------------

function boot(): void {
  // A previous instance may still be present: either live (declared script + explicit injection
  // racing) or orphaned after an extension reload (its chrome.runtime.id is gone). Only the live
  // case is a duplicate.
  const previous = window.__aimContent;
  if (previous) {
    let alive = false;
    try {
      alive = previous.alive();
    } catch {
      alive = false;
    }
    if (alive) return;
  }
  let disposed = false;
  const onMessage = (raw: unknown, _sender: chrome.runtime.MessageSender, sendResponse: (r: ContentResponse) => void): boolean => {
    const message = raw as ToContentMessage | undefined;
    if (!message || typeof message !== 'object' || (message.kind !== 'aim.ping' && message.kind !== 'aim.page')) return false;
    if (message.kind === 'aim.ping') {
      sendResponse({ ok: true, result: { ok: true } as never });
      return false;
    }
    handle(message).then(sendResponse, (e) => sendResponse({ ok: false, code: RpcErrorCode.InternalError, message: errorMessage(e) }));
    return true; // async response
  };
  window.__aimContent = {
    alive: () => {
      if (disposed) return false;
      try {
        return typeof chrome !== 'undefined' && !!chrome.runtime?.id;
      } catch {
        return false;
      }
    },
    dispose: () => {
      disposed = true;
      try {
        chrome.runtime.onMessage.removeListener(onMessage);
      } catch {
        /* orphaned */
      }
      cursor.hide();
    },
  };
  if (window !== window.top) return; // main frame only (manifest also sets all_frames:false)

  chrome.runtime.onMessage.addListener(onMessage);

  const activityThrottle = new KeyedThrottle(2_000);
  const activity = (kind: 'focus' | 'blur' | 'visit') => {
    if (!activityThrottle.allow(kind)) return;
    sendToBackground({ kind: 'aim.activity', activity: kind, url: location.href, title: document.title });
  };
  window.addEventListener('focus', () => activity('focus'));
  window.addEventListener('blur', () => activity('blur'));
  window.addEventListener('pageshow', () => activity('visit'));
  document.addEventListener('visibilitychange', () => activity(document.visibilityState === 'visible' ? 'focus' : 'blur'));
  if (document.visibilityState === 'visible') activity('visit');
}

boot();

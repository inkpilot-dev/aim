/**
 * browser_* tools → relayed to the A.I.M. extension through HubServer.extCall.
 * Keeps the last snapshot per tab so the payment guard can look up a ref's label cheaply.
 */
import { RpcErrorCode, type ExtSnapshot, type ExtSnapshotElement, type ExtTabInfo, type ExtTarget, type ToolResult } from '@aim/shared';
import type { ToolImpl } from './tool-router.js';
import type { ClickTargetInfo, PolicyContext } from './policy.js';
import type { HubServer } from '../hub/hub-server.js';

export interface BrowserToolDeps {
  hub: HubServer;
  log?: { debug(...a: unknown[]): void; warn(...a: unknown[]): void };
  /** Called once when the extension is missing so the caller may try to launch the browser. */
  onNotConnected?: () => void;
}

export const EXT_NOT_CONNECTED =
  'A.I.M. browser extension is not connected. Open Microsoft Edge (or Chrome) with the A.I.M. extension installed and paired; see Settings → Extension. Desktop tools (screen_capture, mouse_*, keyboard_*) still work.';

export class SnapshotCache {
  private byTab = new Map<number, { at: number; snap: ExtSnapshot }>();
  set(tabId: number, snap: ExtSnapshot): void {
    this.byTab.set(tabId, { at: Date.now(), snap });
    if (this.byTab.size > 32) {
      const oldest = [...this.byTab.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) this.byTab.delete(oldest[0]);
    }
  }
  get(tabId: number): ExtSnapshot | undefined {
    return this.byTab.get(tabId)?.snap;
  }
  url(tabId: number): string | undefined {
    return this.byTab.get(tabId)?.snap.url;
  }
  setUrl(tabId: number, url: string): void {
    const e = this.byTab.get(tabId);
    if (e) e.snap.url = url;
  }
  find(tabId: number, target: ExtTarget): ExtSnapshotElement | undefined {
    const snap = this.get(tabId);
    if (!snap) return undefined;
    if (target.ref) return snap.elements.find((e) => e.ref === target.ref);
    if (target.selector) {
      const m = /#([\w-]+)/.exec(target.selector);
      if (m) return snap.elements.find((e) => e.extra?.['id'] === m[1]);
    }
    return undefined;
  }
  delete(tabId: number): void {
    this.byTab.delete(tabId);
  }
}

function elementLine(e: ExtSnapshotElement): string {
  const flags: string[] = [];
  if (e.disabled) flags.push('disabled');
  if (e.checked !== undefined) flags.push(e.checked ? 'checked' : 'unchecked');
  if (!e.visible) flags.push('hidden');
  const level = e.extra?.['level'];
  const role = e.role === 'heading' && level ? `heading h${level}` : e.role;
  let line = `${e.ref} [${role}] "${(e.name || '').replace(/\s+/g, ' ').slice(0, 120)}"`;
  if (e.value) line += ` value="${String(e.value).slice(0, 80)}"`;
  if (e.href) line += ` → ${e.href.slice(0, 120)}`;
  if (flags.length) line += ` (${flags.join(', ')})`;
  return line;
}

export function formatSnapshot(snap: ExtSnapshot, tabId: number): string {
  const head = `Tab ${tabId}: "${snap.title}" ${snap.url}\nViewport ${snap.viewport.width}×${snap.viewport.height}, scrolled to y=${snap.viewport.scrollY} of ${snap.viewport.pageHeight}. ${snap.elements.length} element(s)${snap.truncated ? ' (truncated)' : ''}.`;
  const lines = snap.elements.map(elementLine);
  const text = snap.text ? `\n\n--- Visible text ---\n${snap.text}` : '';
  return `${head}\n${lines.join('\n')}${text}`;
}

function toTarget(args: Record<string, unknown>): ExtTarget | undefined {
  const ref = typeof args['ref'] === 'string' && args['ref'] ? (args['ref'] as string) : undefined;
  const selector = typeof args['selector'] === 'string' && args['selector'] ? (args['selector'] as string) : undefined;
  return ref || selector ? { ref, selector } : undefined;
}

function tabIdOf(args: Record<string, unknown>): number | null {
  const v = args['tabId'];
  return typeof v === 'number' && Number.isInteger(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null;
}

function tabLine(t: ExtTabInfo): string {
  return `${t.active ? '* ' : '  '}tab ${t.tabId} (window ${t.windowId}) "${t.title}" ${t.url}${t.audible ? ' [audible]' : ''}${t.openedByAim ? ' [opened by AIM]' : ''}`;
}

export function createBrowserTools(deps: BrowserToolDeps): { impls: Record<string, ToolImpl>; policy: PolicyContext; cache: SnapshotCache } {
  const cache = new SnapshotCache();
  const { hub } = deps;

  const notConnected = (): ToolResult => {
    deps.onNotConnected?.();
    return { ok: false, error: EXT_NOT_CONNECTED, errorCode: RpcErrorCode.NotConnected };
  };

  /** Wrap a tool body: connection check + error normalisation. */
  const ext =
    (fn: (args: Record<string, unknown>, tabId: number | null) => Promise<ToolResult>, needsTab = true): ToolImpl =>
    async (args) => {
      if (!hub.extensionConnected) return notConnected();
      const tabId = tabIdOf(args);
      if (needsTab && tabId === null) return { ok: false, error: 'tabId (integer) is required. Call browser_tabs to list tabs.' };
      // Make A.I.M.'s presence visible: the teal cursor appears on the tab for any action, including
      // read-only ones, and fades a few seconds after the last one. Visible only while the user views that tab.
      if (tabId !== null) void hub.extCall('ext.cursor.show', { tabId }, 3_000).catch(() => undefined);
      try {
        return await fn(args, tabId);
      } catch (err) {
        const e = err as Error & { code?: number };
        if (e.code === RpcErrorCode.NotConnected) return notConnected();
        return { ok: false, error: `Browser action failed: ${e.message}`, errorCode: typeof e.code === 'number' ? e.code : RpcErrorCode.ToolFailed };
      }
    };

  hub.on('ext.event', (ev: { type: string; tabId?: number; url?: string }) => {
    if (ev.type === 'tab.removed' && typeof ev.tabId === 'number') cache.delete(ev.tabId);
    if (ev.type === 'page.navigated' && typeof ev.tabId === 'number' && ev.url) cache.setUrl(ev.tabId, ev.url);
  });

  const impls: Record<string, ToolImpl> = {
    browser_status: async () => {
      if (!hub.extensionConnected) {
        return { ok: true, text: `Extension not connected. ${EXT_NOT_CONNECTED}`, data: { ...hub.extensionHealth(), connected: false } };
      }
      try {
        const s = await hub.extCall('ext.status', {}, 8_000);
        return { ok: true, text: `Extension connected: ${s.browser} ${s.version} (extension ${s.extensionVersion}), ${s.windows} window(s), ${s.tabs} tab(s).`, data: { connected: true, ...s } };
      } catch (err) {
        return { ok: true, text: `Extension socket is open but did not answer (${(err as Error).message}).`, data: { ...hub.extensionHealth(), connected: true } };
      }
    },

    browser_tabs: ext(async () => {
      const r = await hub.extCall('ext.tabs.list', {}, 10_000);
      for (const t of r.tabs) if (t.url) cache.setUrl(t.tabId, t.url);
      return { ok: true, text: r.tabs.length ? `${r.tabs.length} tab(s) (* = active):\n${r.tabs.map(tabLine).join('\n')}` : 'No tabs open.', data: r };
    }, false),

    browser_open_tab: ext(async (args) => {
      const url = String(args['url'] ?? '');
      if (!/^https?:\/\//i.test(url) && !/^(about|chrome|edge|file):/i.test(url)) return { ok: false, error: 'url must be an http(s) URL.' };
      const r = await hub.extCall('ext.tabs.create', { url, active: args['active'] === true, windowId: typeof args['windowId'] === 'number' ? (args['windowId'] as number) : undefined }, 20_000);
      return { ok: true, text: `Opened tab ${r.tab.tabId} (${args['active'] === true ? 'active' : 'background'}): ${r.tab.url || url}`, data: r.tab };
    }, false),

    browser_navigate: ext(async (args, tabId) => {
      const url = String(args['url'] ?? '');
      const special = url.toLowerCase();
      if (special === 'back' || special === 'forward' || special === 'reload') {
        const code = special === 'back' ? 'history.back(); true' : special === 'forward' ? 'history.forward(); true' : 'location.reload(); true';
        await hub.extCall('ext.page.evaluate', { tabId: tabId!, code }, 10_000);
        await hub.extCall('ext.page.wait', { tabId: tabId!, timeoutMs: 15_000 }, 20_000).catch(() => undefined);
        const tabs = await hub.extCall('ext.tabs.list', {}, 10_000).catch(() => null);
        const tab = tabs?.tabs.find((t) => t.tabId === tabId);
        if (tab) cache.setUrl(tabId!, tab.url);
        return { ok: true, text: `Navigated ${special} in tab ${tabId}${tab ? `: now at ${tab.url}` : ''}.`, data: tab ?? { tabId } };
      }
      const target = /^[a-z]+:\/\//i.test(url) ? url : `https://${url}`;
      const r = await hub.extCall('ext.tabs.navigate', { tabId: tabId!, url: target, waitForLoad: true }, 45_000);
      cache.delete(tabId!);
      return { ok: true, text: `Tab ${tabId} navigated to ${r.tab.url || target} ("${r.tab.title}").`, data: r.tab };
    }),

    browser_close_tab: ext(async (_args, tabId) => {
      await hub.extCall('ext.tabs.close', { tabId: tabId! }, 10_000);
      cache.delete(tabId!);
      return { ok: true, text: `Closed tab ${tabId}.` };
    }),

    browser_activate_tab: ext(async (_args, tabId) => {
      const r = await hub.extCall('ext.tabs.activate', { tabId: tabId! }, 10_000);
      return { ok: true, text: `Tab ${tabId} is now active: "${r.tab.title}".`, data: r.tab };
    }),

    browser_snapshot: ext(async (args, tabId) => {
      const snap = await hub.extCall(
        'ext.page.snapshot',
        {
          tabId: tabId!,
          maxElements: typeof args['maxElements'] === 'number' ? (args['maxElements'] as number) : 400,
          includeText: args['includeText'] !== false,
          filter: typeof args['filter'] === 'string' && args['filter'] ? (args['filter'] as string) : undefined,
        },
        30_000,
      );
      cache.set(tabId!, snap);
      return { ok: true, text: formatSnapshot(snap, tabId!), data: { url: snap.url, title: snap.title, viewport: snap.viewport, count: snap.elements.length, truncated: snap.truncated } };
    }),

    browser_click: ext(async (args, tabId) => {
      const target = toTarget(args);
      if (!target) return { ok: false, error: 'Provide ref (from browser_snapshot) or selector.' };
      const button = args['button'] === 'right' || args['button'] === 'middle' ? (args['button'] as 'right' | 'middle') : 'left';
      const r = await hub.extCall('ext.page.click', { tabId: tabId!, target, button, double: args['double'] === true }, 30_000);
      const el = cache.find(tabId!, target);
      const label = el ? ` "${el.name}"` : '';
      return { ok: true, text: `Clicked ${target.ref ?? target.selector}${label}${r.navigated ? ' (page navigated; take a new snapshot)' : ''}.`, data: r };
    }),

    browser_type: ext(async (args, tabId) => {
      const text = String(args['text'] ?? '');
      const target = toTarget(args);
      const r = await hub.extCall('ext.page.type', { tabId: tabId!, target, text, append: args['append'] === true, pressEnter: args['pressEnter'] === true }, 30_000);
      return { ok: true, text: `Typed ${text.length} character(s)${target ? ` into ${target.ref ?? target.selector}` : ''}${args['pressEnter'] === true ? ' and pressed Enter' : ''}.`, data: r };
    }),

    browser_select: ext(async (args, tabId) => {
      const target = toTarget(args);
      if (!target) return { ok: false, error: 'Provide ref or selector.' };
      const r = await hub.extCall('ext.page.select', { tabId: tabId!, target, value: String(args['value'] ?? '') }, 15_000);
      return { ok: true, text: `Selected "${r.selected}" in ${target.ref ?? target.selector}.`, data: r };
    }),

    browser_press_key: ext(async (args, tabId) => {
      const key = String(args['key'] ?? '');
      await hub.extCall('ext.page.pressKey', { tabId: tabId!, key }, 15_000);
      return { ok: true, text: `Pressed ${key} in tab ${tabId}.` };
    }),

    browser_scroll: ext(async (args, tabId) => {
      const target = toTarget(args);
      const r = await hub.extCall('ext.page.scroll', { tabId: tabId!, target, deltaY: typeof args['deltaY'] === 'number' ? (args['deltaY'] as number) : 600, intoView: args['intoView'] === true }, 15_000);
      return { ok: true, text: `Scrolled; page is now at y=${r.scrollY}.`, data: r };
    }),

    browser_read: ext(async (args, tabId) => {
      const target = toTarget(args);
      const r = await hub.extCall('ext.page.read', { tabId: tabId!, target, includeLinks: args['includeLinks'] === true, maxChars: typeof args['maxChars'] === 'number' ? (args['maxChars'] as number) : 20_000 }, 30_000);
      cache.setUrl(tabId!, r.url);
      const links = r.links?.length ? `\n\n--- Links (${r.links.length}) ---\n${r.links.map((l) => `- ${l.text || '(no text)'} → ${l.href}`).join('\n')}` : '';
      return { ok: true, text: `"${r.title}" ${r.url}${r.truncated ? ' (truncated)' : ''}\n\n${r.text}${links}`, data: { title: r.title, url: r.url, chars: r.text.length, truncated: r.truncated } };
    }),

    browser_screenshot: ext(async (_args, tabId) => {
      const r = await hub.extCall('ext.page.screenshot', { tabId: tabId! }, 20_000);
      return { ok: true, text: `Screenshot of tab ${tabId}.`, images: [{ mediaType: r.mediaType || 'image/png', dataBase64: r.dataBase64 }] };
    }),

    browser_evaluate: ext(async (args, tabId) => {
      const r = await hub.extCall('ext.page.evaluate', { tabId: tabId!, code: String(args['code'] ?? '') }, 30_000);
      const value = r.value;
      const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? 'undefined';
      return { ok: true, text: text.length > 50_000 ? `${text.slice(0, 50_000)}\n…(truncated)` : text, data: { value } };
    }),

    browser_wait: ext(async (args, tabId) => {
      const timeoutMs = typeof args['timeoutMs'] === 'number' ? (args['timeoutMs'] as number) : 15_000;
      const r = await hub.extCall(
        'ext.page.wait',
        { tabId: tabId!, selector: typeof args['selector'] === 'string' ? (args['selector'] as string) : undefined, text: typeof args['text'] === 'string' ? (args['text'] as string) : undefined, timeoutMs, ms: typeof args['ms'] === 'number' ? (args['ms'] as number) : undefined },
        timeoutMs + 10_000,
      );
      return { ok: true, text: r.matched ? `Condition met: ${r.matched}.` : 'Wait finished.', data: r };
    }),
  };

  const policy: PolicyContext = {
    lookupTarget: (tabId, target): ClickTargetInfo | null => {
      const el = cache.find(tabId, target);
      const url = cache.url(tabId);
      if (!el) return url ? { url } : null;
      const x = el.extra ?? {};
      return {
        label: el.name,
        url,
        field: { name: str(x['name']), id: str(x['id']), autocomplete: str(x['autocomplete']), placeholder: str(x['placeholder']), label: el.name, type: str(x['type']) ?? (el.role === 'textbox' ? 'text' : undefined) },
      };
    },
    tabUrl: (tabId) => cache.url(tabId),
  };

  return { impls, policy, cache };
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

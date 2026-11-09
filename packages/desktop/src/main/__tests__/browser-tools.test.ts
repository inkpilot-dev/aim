import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { RpcErrorCode, type ExtSnapshot } from '@aim/shared';
import { EXT_NOT_CONNECTED, SnapshotCache, createBrowserTools, formatSnapshot } from '../tools/browser.js';
import type { HubServer } from '../hub/hub-server.js';
import { ToolRouter } from '../tools/tool-router.js';

const snap: ExtSnapshot = {
  url: 'https://shop.example/cart',
  title: 'Cart',
  viewport: { width: 1200, height: 800, scrollX: 0, scrollY: 0, pageHeight: 2400 },
  elements: [
    { ref: 'e1', role: 'heading', name: 'Your cart', tag: 'h1', visible: true, extra: { level: 1 } },
    { ref: 'e2', role: 'button', name: 'Place your order', tag: 'button', visible: true },
    { ref: 'e3', role: 'textbox', name: 'Card number', tag: 'input', visible: true, extra: { autocomplete: 'cc-number', id: 'cc' } },
    { ref: 'e4', role: 'link', name: 'Continue shopping', tag: 'a', href: 'https://shop.example/', visible: true },
    { ref: 'e5', role: 'checkbox', name: 'Gift', tag: 'input', visible: true, checked: false },
  ],
  text: 'Your cart has 2 items.',
};

function fakeHub(connected = true) {
  const hub = new EventEmitter() as EventEmitter & { extensionConnected: boolean; extCall: ReturnType<typeof vi.fn>; extensionHealth: () => unknown };
  hub.extensionConnected = connected;
  hub.extensionHealth = () => ({ connected });
  hub.extCall = vi.fn(async (method: string, params: Record<string, unknown>) => {
    switch (method) {
      case 'ext.page.snapshot':
        return snap;
      case 'ext.tabs.list':
        return { tabs: [{ tabId: 7, windowId: 1, index: 0, title: 'Cart', url: snap.url, active: true }] };
      case 'ext.page.click':
        return { ok: true };
      case 'ext.page.type':
        return { ok: true };
      case 'ext.page.read':
        return { title: 'Cart', url: snap.url, text: 'hello', links: [{ text: 'x', href: 'https://x' }] };
      case 'ext.page.screenshot':
        return { mediaType: 'image/jpeg', dataBase64: 'QUJD' };
      case 'ext.tabs.create':
        return { tab: { tabId: 9, windowId: 1, index: 1, title: '', url: params['url'], active: !!params['active'] } };
      default:
        throw Object.assign(new Error(`unhandled ${method}`), { code: -1 });
    }
  });
  return hub as unknown as HubServer & { extCall: ReturnType<typeof vi.fn> };
}

describe('browser tools', () => {
  it('formats snapshots compactly', () => {
    const text = formatSnapshot(snap, 7);
    expect(text).toContain('e1 [heading h1] "Your cart"');
    expect(text).toContain('e2 [button] "Place your order"');
    expect(text).toContain('e4 [link] "Continue shopping" → https://shop.example/');
    expect(text).toContain('(unchecked)');
    expect(text).toContain('Your cart has 2 items.');
  });
  it('SnapshotCache finds refs and #id selectors', () => {
    const c = new SnapshotCache();
    c.set(7, snap);
    expect(c.find(7, { ref: 'e2' })?.name).toBe('Place your order');
    expect(c.find(7, { selector: '#cc' })?.ref).toBe('e3');
    expect(c.url(7)).toBe(snap.url);
    c.delete(7);
    expect(c.get(7)).toBeUndefined();
  });
  it('returns the not-connected error when the extension is offline', async () => {
    const hub = fakeHub(false);
    const onMissing = vi.fn();
    const { impls } = createBrowserTools({ hub, onNotConnected: onMissing });
    const r = await impls['browser_tabs']!({}, { tool: { name: 'browser_tabs' } as never });
    expect(r).toMatchObject({ ok: false, errorCode: RpcErrorCode.NotConnected });
    expect(r.error).toBe(EXT_NOT_CONNECTED);
    expect(onMissing).toHaveBeenCalled();
    const st = await impls['browser_status']!({}, { tool: { name: 'browser_status' } as never });
    expect(st.ok).toBe(true);
    expect((st.data as { connected: boolean }).connected).toBe(false);
  });
  it('relays calls, caches snapshots and feeds the payment guard', async () => {
    const hub = fakeHub(true);
    const { impls, policy } = createBrowserTools({ hub });
    const router = new ToolRouter({ impls, policy });
    const s = await router.call({ name: 'browser_snapshot', args: { tabId: 7 } });
    expect(s.ok).toBe(true);
    expect(s.text).toContain('e2 [button]');
    expect(hub.extCall).toHaveBeenCalledWith('ext.page.snapshot', expect.objectContaining({ tabId: 7, includeText: true, maxElements: 400 }), expect.any(Number));

    // payment button → blocked by hub-side guard using the cached snapshot label
    const click = await router.call({ name: 'browser_click', args: { tabId: 7, ref: 'e2' } });
    expect(click.errorCode).toBe(RpcErrorCode.PolicyBlocked);
    // card field → blocked
    const type = await router.call({ name: 'browser_type', args: { tabId: 7, ref: 'e3', text: 'hello' } });
    expect(type.errorCode).toBe(RpcErrorCode.PolicyBlocked);
    // harmless link → allowed and relayed
    const ok = await router.call({ name: 'browser_click', args: { tabId: 7, ref: 'e4' } });
    expect(ok.ok).toBe(true);
    expect(ok.text).toContain('"Continue shopping"');
    expect(hub.extCall).toHaveBeenCalledWith('ext.page.click', { tabId: 7, target: { ref: 'e4', selector: undefined }, button: 'left', double: false }, expect.any(Number));

    const read = await router.call({ name: 'browser_read', args: { tabId: 7, includeLinks: true } });
    expect(read.text).toContain('--- Links (1) ---');
    const shot = await router.call({ name: 'browser_screenshot', args: { tabId: 7 } });
    expect(shot.images?.[0]).toEqual({ mediaType: 'image/jpeg', dataBase64: 'QUJD' });
    const tab = await router.call({ name: 'browser_open_tab', args: { url: 'https://example.com' } });
    expect(tab.ok).toBe(true);
    expect(hub.extCall).toHaveBeenCalledWith('ext.tabs.create', { url: 'https://example.com', active: false, windowId: undefined }, expect.any(Number));
    const blockedTab = await router.call({ name: 'browser_open_tab', args: { url: 'https://example.com/checkout' } });
    expect(blockedTab.errorCode).toBe(RpcErrorCode.PolicyBlocked);
    // extension error → ToolResult, never a throw
    const bad = await router.call({ name: 'browser_close_tab', args: { tabId: 7 } });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('unhandled ext.tabs.close');
  });
});

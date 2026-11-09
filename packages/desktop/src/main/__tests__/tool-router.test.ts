import { describe, expect, it, vi } from 'vitest';
import { AIM_TOOLS, PAYMENT_BLOCK_MESSAGE, RpcErrorCode } from '@aim/shared';
import { ToolRouter } from '../tools/tool-router.js';
import { checkPolicy, guardEvaluate } from '../tools/policy.js';

function router(extra: Partial<ConstructorParameters<typeof ToolRouter>[0]> = {}) {
  const impls: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const t of AIM_TOOLS) impls[t.name] = vi.fn(async (args: Record<string, unknown>) => ({ ok: true, data: { tool: t.name, args } }));
  const r = new ToolRouter({ impls, ...extra });
  return { r, impls };
}

describe('ToolRouter', () => {
  it('dispatches to the implementation with chatId context', async () => {
    const { r, impls } = router();
    const res = await r.call({ name: 'screen_info', args: {}, chatId: 'c1' });
    expect(res.ok).toBe(true);
    expect(impls['screen_info']).toHaveBeenCalledTimes(1);
    expect(impls['screen_info']!.mock.calls[0]![1]).toMatchObject({ chatId: 'c1', tool: { name: 'screen_info' } });
  });
  it('rejects unknown tools and missing required args without throwing', async () => {
    const { r } = router();
    expect((await r.call({ name: 'nope', args: {} })).errorCode).toBe(RpcErrorCode.MethodNotFound);
    const miss = await r.call({ name: 'mouse_move', args: { x: 1 } });
    expect(miss.ok).toBe(false);
    expect(miss.error).toContain('y');
    expect(miss.errorCode).toBe(RpcErrorCode.InvalidParams);
  });
  it('converts thrown errors into ToolResult', async () => {
    const { r, impls } = router();
    impls['window_list']!.mockRejectedValueOnce(new Error('boom'));
    const res = await r.call({ name: 'window_list', args: {} });
    expect(res).toMatchObject({ ok: false, errorCode: RpcErrorCode.ToolFailed });
    expect(res.error).toContain('boom');
    impls['window_list']!.mockImplementationOnce(() => {
      throw new TypeError('sync boom');
    });
    expect((await r.call({ name: 'window_list', args: {} })).error).toContain('sync boom');
  });
  it('blocks payment navigation, card typing and payment clicks via the guard', async () => {
    const lookupTarget = vi.fn(async (_tabId: number, t: { ref?: string }) => (t.ref === 'e9' ? { label: 'Place your order', url: 'https://shop.example/cart' } : { label: 'Add to cart', url: 'https://shop.example/cart' }));
    const { r, impls } = router({ policy: { lookupTarget } });
    const nav = await r.call({ name: 'browser_navigate', args: { tabId: 1, url: 'https://shop.example.com/checkout' } });
    expect(nav).toMatchObject({ ok: false, errorCode: RpcErrorCode.PolicyBlocked });
    expect(nav.error).toContain(PAYMENT_BLOCK_MESSAGE);
    expect(impls['browser_navigate']).not.toHaveBeenCalled();

    expect((await r.call({ name: 'browser_navigate', args: { tabId: 1, url: 'back' } })).ok).toBe(true);
    expect((await r.call({ name: 'browser_open_tab', args: { url: 'https://en.wikipedia.org/wiki/Checkout' } })).ok).toBe(true);

    const typed = await r.call({ name: 'keyboard_type', args: { text: 'card 4242 4242 4242 4242' } });
    expect(typed.errorCode).toBe(RpcErrorCode.PolicyBlocked);
    expect((await r.call({ name: 'keyboard_type', args: { text: 'hello world' } })).ok).toBe(true);

    const click = await r.call({ name: 'browser_click', args: { tabId: 3, ref: 'e9' } });
    expect(click.errorCode).toBe(RpcErrorCode.PolicyBlocked);
    expect(lookupTarget).toHaveBeenCalledWith(3, { ref: 'e9', selector: undefined });
    expect((await r.call({ name: 'browser_click', args: { tabId: 3, ref: 'e2' } })).ok).toBe(true);

    const bt = await r.call({ name: 'browser_type', args: { tabId: 3, ref: 'e2', text: '4111111111111111' } });
    expect(bt.errorCode).toBe(RpcErrorCode.PolicyBlocked);
  });
  it('blocks browser_evaluate heuristically', async () => {
    const { r } = router({ policy: { tabUrl: async () => 'https://shop.example/checkout' } });
    const ev = await r.call({ name: 'browser_evaluate', args: { tabId: 1, code: "document.querySelector('form').submit()" } });
    expect(ev.errorCode).toBe(RpcErrorCode.PolicyBlocked);
    const ok = await r.call({ name: 'browser_evaluate', args: { tabId: 1, code: 'document.title' } });
    expect(ok.ok).toBe(true);
  });
  it('reports missing implementations and times out slow tools', async () => {
    const r = new ToolRouter({ impls: { screen_info: () => new Promise(() => undefined) }, timeoutMs: 50 });
    expect(r.missingImplementations()).toContain('mouse_move');
    const res = await r.call({ name: 'screen_info', args: {} });
    expect(res).toMatchObject({ ok: false, errorCode: RpcErrorCode.Timeout });
    expect((await r.call({ name: 'mouse_move', args: { x: 0, y: 0 } })).ok).toBe(false);
  });
});

describe('policy helpers', () => {
  it('guardEvaluate catches payment URL references and card-field writes', () => {
    expect(guardEvaluate("fetch('https://checkout.stripe.com/pay/x')").blocked).toBe(true);
    expect(guardEvaluate("document.querySelector('[autocomplete=cc-number]').value='4242'").blocked).toBe(true);
    expect(guardEvaluate("document.querySelector('button').click()", 'https://example.com/products').blocked).toBe(false);
    expect(guardEvaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Pay now').click()").blocked).toBe(true);
  });
  it('checkPolicy survives a failing lookup', async () => {
    const v = await checkPolicy('browser_click', { tabId: 1, ref: 'e1' }, { lookupTarget: () => Promise.reject(new Error('x')) });
    expect(v.blocked).toBe(false);
    const t = await checkPolicy('browser_type', { tabId: 1, ref: 'e1', text: '4242424242424242' }, { lookupTarget: () => Promise.reject(new Error('x')) });
    expect(t.blocked).toBe(true);
  });
});

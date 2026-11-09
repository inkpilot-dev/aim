import { describe, expect, it } from 'vitest';
import { EXT_MAX_RECONNECT_MS, RpcErrorCode, rpcRequest, rpcSuccess } from '@aim/shared';
import {
  KeyedThrottle,
  RefRegistry,
  accessibleNameFrom,
  backoffDelay,
  browserFromBrands,
  browserFromUA,
  browserLabel,
  collapseWhitespace,
  contentScore,
  describeClose,
  encodeRpcFrame,
  hostOf,
  hubUrl,
  isRestrictedUrl,
  maskValue,
  matchesFilter,
  normalizePort,
  normalizeUrl,
  parseKeyCombo,
  parseRpcFrame,
  roleFor,
  tidyText,
  truncate,
  withJitter,
  withTimeout,
} from './shared-utils.js';

describe('text helpers', () => {
  it('collapses whitespace', () => {
    expect(collapseWhitespace('  a \n\t b  ')).toBe('a b');
  });
  it('truncates with an ellipsis', () => {
    expect(truncate('hello', 10)).toBe('hello');
    expect(truncate('hello world', 6)).toBe('hello…');
    expect(truncate('abc', 0)).toBe('');
  });
  it('extracts hosts', () => {
    expect(hostOf('https://shop.example.com/checkout?x=1')).toBe('shop.example.com');
    expect(hostOf('not a url')).toBe('');
  });
  it('masks values', () => {
    expect(maskValue('secret')).toBe('••••••');
    expect(maskValue('')).toBe('');
    expect(maskValue('x'.repeat(40)).length).toBe(12);
  });
  it('normalises URLs', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com');
    expect(normalizeUrl('http://a.b')).toBe('http://a.b');
    expect(normalizeUrl('about:blank')).toBe('about:blank');
  });
  it('detects restricted URLs', () => {
    expect(isRestrictedUrl('chrome://extensions')).toBe(true);
    expect(isRestrictedUrl('edge://settings')).toBe(true);
    expect(isRestrictedUrl('https://chromewebstore.google.com/detail/x')).toBe(true);
    expect(isRestrictedUrl('https://microsoftedge.microsoft.com/addons')).toBe(true);
    expect(isRestrictedUrl('https://example.com')).toBe(false);
    expect(isRestrictedUrl(undefined)).toBe(true);
  });
});

describe('browser identification', () => {
  const edgeUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.56';
  const chromeUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.70 Safari/537.36';
  it('detects Edge via Edg/', () => {
    expect(browserFromUA(edgeUA)).toEqual({ name: 'edge', version: '130.0.2849.56' });
  });
  it('detects Chrome (including headless builds)', () => {
    expect(browserFromUA(chromeUA)).toEqual({ name: 'chrome', version: '130.0.6723.70' });
    expect(browserFromUA('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.8010.12 Safari/537.36')).toEqual({ name: 'chrome', version: '153.0.8010.12' });
  });
  it('detects from brands', () => {
    expect(browserFromBrands([{ brand: 'Chromium', version: '130' }, { brand: 'Microsoft Edge', version: '130' }])?.name).toBe('edge');
    expect(browserFromBrands([{ brand: 'Chromium', version: '130' }, { brand: 'Google Chrome', version: '130' }])?.name).toBe('chrome');
    expect(browserFromBrands([])).toBeUndefined();
  });
  it('labels browsers', () => {
    expect(browserLabel({ name: 'edge', version: '130.0.1' })).toBe('Microsoft Edge 130');
    expect(browserLabel({ name: 'unknown', version: '' })).toBe('Unknown browser');
  });
});

describe('parseKeyCombo', () => {
  it('parses modifiers and letters', () => {
    const c = parseKeyCombo('Control+Shift+a');
    expect(c).toMatchObject({ key: 'A', code: 'KeyA', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, keyCode: 65 });
  });
  it('parses named keys and aliases', () => {
    expect(parseKeyCombo('Enter')).toMatchObject({ key: 'Enter', code: 'Enter', keyCode: 13 });
    expect(parseKeyCombo('esc')).toMatchObject({ key: 'Escape', keyCode: 27 });
    expect(parseKeyCombo('ctrl+k')).toMatchObject({ key: 'k', ctrlKey: true, code: 'KeyK' });
    expect(parseKeyCombo('Cmd+ArrowDown')).toMatchObject({ key: 'ArrowDown', metaKey: true, keyCode: 40 });
    expect(parseKeyCombo('space')).toMatchObject({ key: ' ', code: 'Space', keyCode: 32 });
    expect(parseKeyCombo('F5')).toMatchObject({ key: 'F5', code: 'F5', keyCode: 116 });
    expect(parseKeyCombo('Alt+Tab')).toMatchObject({ key: 'Tab', altKey: true, keyCode: 9 });
  });
  it('handles digits and modifier-only combos', () => {
    expect(parseKeyCombo('Control+1')).toMatchObject({ key: '1', code: 'Digit1', keyCode: 49 });
    expect(parseKeyCombo('Shift')).toMatchObject({ key: 'Shift', shiftKey: true });
  });
});

describe('accessibility helpers', () => {
  it('follows ARIA name priority', () => {
    expect(accessibleNameFrom({ ariaLabel: 'Search', text: 'Go' })).toBe('Search');
    expect(accessibleNameFrom({ labelledBy: ' Billing  address ', ariaLabel: 'x' })).toBe('Billing address');
    expect(accessibleNameFrom({ placeholder: 'Email', text: '' })).toBe('Email');
    expect(accessibleNameFrom({ text: 'x'.repeat(100) }).length).toBe(80);
    expect(accessibleNameFrom({})).toBe('');
  });
  it('maps roles', () => {
    expect(roleFor('a', { href: true })).toBe('link');
    expect(roleFor('a', { href: false })).toBe('generic');
    expect(roleFor('input', { type: 'checkbox' })).toBe('checkbox');
    expect(roleFor('input', { type: 'submit' })).toBe('button');
    expect(roleFor('input', { type: 'hidden' })).toBe('hidden');
    expect(roleFor('input', {})).toBe('textbox');
    expect(roleFor('select')).toBe('combobox');
    expect(roleFor('h2')).toBe('heading');
    expect(roleFor('div', { role: 'button' })).toBe('button');
    expect(roleFor('div', { contentEditable: true })).toBe('textbox');
  });
  it('filters snapshot elements', () => {
    const el = { role: 'button', name: 'Pay now', tag: 'button' };
    expect(matchesFilter(el, 'pay')).toBe(true);
    expect(matchesFilter(el, 'BUTTON')).toBe(true);
    expect(matchesFilter(el, 'link')).toBe(false);
    expect(matchesFilter(el, undefined)).toBe(true);
  });
});

describe('readability helpers', () => {
  it('scores content blocks', () => {
    const prose = 'This is a paragraph of real text. It has sentences, punctuation, and enough length to matter for scoring.';
    expect(contentScore(prose, 0)).toBeGreaterThan(contentScore(prose, prose.length));
    expect(contentScore('short', 0)).toBe(0);
  });
  it('tidies text', () => {
    const { text, truncated } = tidyText('  Title \n\n\n\n  body   line \n\n', 1000);
    expect(text).toBe('Title\n\nbody line');
    expect(truncated).toBe(false);
    expect(tidyText('a'.repeat(50), 10)).toEqual({ text: 'a'.repeat(10), truncated: true });
  });
});

describe('RefRegistry', () => {
  it('assigns stable refs and resolves them', () => {
    const reg = new RefRegistry<object>();
    const a = {};
    const b = {};
    expect(reg.refFor(a)).toBe('e1');
    expect(reg.refFor(b)).toBe('e2');
    expect(reg.refFor(a)).toBe('e1');
    expect(reg.resolve('e2')).toBe(b);
    expect(reg.resolve('e99')).toBeUndefined();
    expect(reg.size).toBe(2);
    reg.prune((o) => o !== b);
    expect(reg.resolve('e2')).toBeUndefined();
    expect(reg.size).toBe(1);
  });
});

describe('connection helpers', () => {
  it('backs off exponentially and caps at 30 s', () => {
    expect([0, 1, 2, 3, 4, 10].map((a) => backoffDelay(a))).toEqual([2000, 4000, 8000, 16000, 30000, EXT_MAX_RECONNECT_MS]);
  });
  it('applies bounded jitter', () => {
    expect(withJitter(1000, 0.15, () => 0)).toBe(850);
    expect(withJitter(1000, 0.15, () => 1)).toBe(1150);
    expect(withJitter(1000, 0.15, () => 0.5)).toBe(1000);
  });
  it('normalises ports', () => {
    expect(normalizePort('47821')).toBe(47821);
    expect(normalizePort(' 8080 ')).toBe(8080);
    expect(normalizePort('abc')).toBe(47821);
    expect(normalizePort(70000)).toBe(47821);
    expect(normalizePort(0)).toBe(47821);
  });
  it('builds hub URLs', () => {
    expect(hubUrl(47821, '127.0.0.1', '/aim/ext')).toBe('ws://127.0.0.1:47821/aim/ext');
  });
  it('frames RPC messages', () => {
    const req = rpcRequest('hub.hello', { token: 't' }, 'id1');
    const parsed = parseRpcFrame(encodeRpcFrame(req));
    expect(parsed).toEqual(req);
    expect(parseRpcFrame(encodeRpcFrame(rpcSuccess('id1', { ok: true })))).toEqual({ jsonrpc: '2.0', id: 'id1', result: { ok: true } });
    expect(parseRpcFrame('not json')).toBeUndefined();
    expect(parseRpcFrame('{"foo":1}')).toBeUndefined();
    expect(parseRpcFrame(new ArrayBuffer(2))).toBeUndefined();
  });
  it('describes close codes', () => {
    expect(describeClose(4001, '')).toMatch(/token rejected/i);
    expect(describeClose(1006, '')).toMatch(/not reachable/i);
    expect(describeClose(1000, 'bye')).toContain('bye');
    expect(describeClose(4999, '')).toContain('4999');
  });
  it('times out promises', async () => {
    await expect(withTimeout(new Promise(() => undefined), 10, 'thing')).rejects.toMatchObject({ timeout: true, message: expect.stringContaining('thing') });
    await expect(withTimeout(Promise.resolve(5), 10)).resolves.toBe(5);
  });
  it('throttles per key', () => {
    const t = new KeyedThrottle(2000);
    expect(t.allow('a', 1000)).toBe(true);
    expect(t.allow('a', 2500)).toBe(false);
    expect(t.allow('b', 2500)).toBe(true);
    expect(t.allow('a', 3000)).toBe(true);
  });
  it('exposes the policy error code used by the content script', () => {
    expect(RpcErrorCode.PolicyBlocked).toBe(-32010);
  });
});

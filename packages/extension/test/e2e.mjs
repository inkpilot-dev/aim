#!/usr/bin/env node
/**
 * End-to-end smoke test for the A.I.M. Browser Bridge.
 *
 * Loads dist/ into a headless Chromium (Playwright), runs a fake Hub (WebSocket server on
 * 127.0.0.1:47821 by default) and a tiny HTTP server for the fixture pages, then drives the
 * extension with real `ext.*` requests and asserts the responses — including the payment guard.
 *
 *   node test/e2e.mjs
 * Environment: AIM_E2E_BROWSER=/path/to/chrome (default /usr/bin/google-chrome if present),
 *              AIM_E2E_PORT=47821, AIM_E2E_HEADED=1 to watch.
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const repoRoot = join(pkgRoot, '..', '..');
const dist = join(pkgRoot, 'dist');
const require = createRequire(import.meta.url);

function resolveModule(name, extraPaths) {
  const candidates = [repoRoot, pkgRoot, ...extraPaths];
  for (const base of candidates) {
    try {
      return require(require.resolve(name, { paths: [base] }));
    } catch {
      /* try next */
    }
  }
  throw new Error(`Cannot find module "${name}". Install it at the repo root (pnpm add -w -D ${name}).`);
}

const { WebSocketServer } = resolveModule('ws', []);
const { chromium } = resolveModule('playwright', ['/opt/node-tools/node_modules', '/usr/lib/node_modules', '/usr/local/lib/node_modules']);

const TOKEN = 'e2e-pairing-token-0123';
const WRONG_TOKEN = 'wrong-token';
const WANT_PORT = Number(process.env.AIM_E2E_PORT || 47821);

// ---------------------------------------------------------------------------------------------
// Fixture HTTP server
// ---------------------------------------------------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
const http = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let file = url.pathname === '/' ? '/page.html' : url.pathname;
  if (url.pathname === '/search') file = '/page.html';
  const path = join(here, 'fixtures', file);
  if (!existsSync(path)) {
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end('<title>Not found</title><main><h1>Not found</h1></main>');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
  res.end(readFileSync(path));
});
await new Promise((r) => http.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${http.address().port}`;

// ---------------------------------------------------------------------------------------------
// Fake Hub
// ---------------------------------------------------------------------------------------------
class FakeHub {
  constructor() {
    this.events = [];
    this.hellos = [];
    this.pending = new Map();
    this.socket = undefined;
    this.counter = 0;
    this.waiters = [];
    this.pingsFromExtension = 0;
  }
  async listen(port) {
    this.port = port;
    this.wss = await new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ host: '127.0.0.1', port, path: '/aim/ext' });
      wss.once('listening', () => resolve(wss));
      wss.once('error', reject);
    });
    this.port = this.wss.address().port;
    this.wss.on('connection', (ws) => this.onConnection(ws));
  }
  onConnection(ws) {
    let authed = false;
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data));
      if (!authed) {
        if (msg.method !== 'hub.hello' || msg.id === undefined) {
          ws.close(4000, 'hello required');
          return;
        }
        this.hellos.push(msg.params);
        if (msg.params.token !== TOKEN) {
          ws.close(4001, 'bad token');
          return;
        }
        authed = true;
        this.socket = ws;
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: true, hubVersion: 'e2e', serverTime: Date.now() } }));
        for (const w of this.waiters.splice(0)) w();
        return;
      }
      if (msg.method === 'hub.ping' && msg.id !== undefined) {
        this.pingsFromExtension++;
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: true } }));
        return;
      }
      if (msg.method === 'ext.event') {
        this.events.push(msg.params);
        return;
      }
      if (msg.id !== undefined && !msg.method) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          p.resolve(msg);
        }
      }
    });
    ws.on('close', () => {
      if (this.socket === ws) this.socket = undefined;
    });
  }
  waitForExtension(timeoutMs = 20_000) {
    if (this.socket?.readyState === 1) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('extension did not connect in time')), timeoutMs);
      this.waiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }
  /** Send an ext.* request; resolves with the raw response ({result} or {error}). */
  raw(method, params, timeoutMs = 20_000) {
    const id = `h${++this.counter}`;
    return new Promise((resolve, reject) => {
      if (!this.socket) return reject(new Error('extension not connected'));
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }
  async call(method, params, timeoutMs) {
    const res = await this.raw(method, params, timeoutMs);
    if (res.error) throw Object.assign(new Error(`${method} failed: ${res.error.message}`), { rpc: res.error });
    return res.result;
  }
  async expectError(method, params, code) {
    const res = await this.raw(method, params);
    assert.ok(res.error, `${method} should have failed`);
    if (code !== undefined) assert.equal(res.error.code, code, `${method} error code (${res.error.message})`);
    return res.error;
  }
  async close() {
    if (!this.wss) return;
    const wss = this.wss;
    this.wss = undefined;
    for (const c of wss.clients) c.terminate(); // ws's close() waits for clients otherwise
    await Promise.race([new Promise((r) => wss.close(r)), sleep(3000)]);
  }
}

const hub = new FakeHub();
try {
  await hub.listen(WANT_PORT);
} catch (e) {
  console.warn(`Port ${WANT_PORT} is busy (${e.code}); using a random port.`);
  await hub.listen(0);
}
console.log(`fake hub on ws://127.0.0.1:${hub.port}/aim/ext, fixtures at ${base}`);

// ---------------------------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------------------------
const profile = mkdtempSync(join(tmpdir(), 'aim-e2e-'));
const executablePath = process.env.AIM_E2E_BROWSER || (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined);
const headed = process.env.AIM_E2E_HEADED === '1';
const context = await chromium.launchPersistentContext(profile, {
  headless: !headed,
  executablePath,
  viewport: { width: 1200, height: 800 },
  args: [...(headed ? [] : ['--headless=new']), `--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--no-sandbox', '--no-first-run'],
});

const startedAt = Date.now();
let failures = 0;
let passed = 0;
async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${name}\n       ${e.stack ?? e}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, timeoutMs, what) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await pred()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const evalIn = (tabId, code) => hub.call('ext.page.evaluate', { tabId, code }).then((r) => r.value);

try {
  const getSw = async () => {
    let [w] = context.serviceWorkers();
    if (!w) w = await context.waitForEvent('serviceworker', { timeout: 20_000 });
    return w;
  };
  let sw = await getSw();
  console.log('service worker:', sw.url());
  const swEval = async (fn, arg) => {
    try {
      return await sw.evaluate(fn, arg);
    } catch (e) {
      if (!/closed/i.test(String(e))) throw e;
      sw = await getSw(); // Chromium restarted the worker; re-acquire the handle
      return sw.evaluate(fn, arg);
    }
  };

  // --- Pairing ----------------------------------------------------------------------------------
  await step('rejected token surfaces a clear reason (hub closes with 4001)', async () => {
    await swEval(async ({ port, token }) => chrome.storage.local.set({ hubPort: port, hubToken: token }), { port: hub.port, token: WRONG_TOKEN });
    await waitFor(() => hub.hellos.length >= 1, 10_000, 'first hello');
    await waitFor(async () => /token rejected/i.test(await swEval(() => globalThis.__aim.hub.reason)), 10_000, 'rejection reason');
  });

  await step('correct token pairs: hub.hello carries client/browser/version', async () => {
    await swEval(async (token) => chrome.storage.local.set({ hubToken: token }), TOKEN);
    await hub.waitForExtension();
    const hello = hub.hellos[hub.hellos.length - 1];
    assert.equal(hello.client, 'extension');
    assert.equal(hello.token, TOKEN);
    assert.ok(['chrome', 'chromium', 'edge'].includes(hello.browser), `browser ${hello.browser}`);
    assert.match(hello.version, /ext\/0\.1\.0/);
    assert.equal(await swEval(() => globalThis.__aim.hub.state), 'connected');
  });

  await step('ext.status reports browser and counts', async () => {
    const s = await hub.call('ext.status', {});
    assert.equal(s.extensionVersion, '0.1.0');
    assert.ok(['chrome', 'chromium', 'edge'].includes(s.browser));
    assert.match(s.version, /^\d+/);
    assert.ok(s.windows >= 1 && s.tabs >= 1);
  });

  await step('unknown method → MethodNotFound', async () => {
    await hub.expectError('ext.nope', {}, -32601);
  });

  // --- Tabs ------------------------------------------------------------------------------------
  let tabId;
  await step('ext.tabs.create opens a background tab and tracks it', async () => {
    const { tab } = await hub.call('ext.tabs.create', { url: `${base}/page.html` });
    tabId = tab.tabId;
    assert.equal(tab.active, false);
    assert.equal(tab.openedByAim, true);
    assert.equal(tab.status, 'complete');
    assert.equal(tab.title, 'A.I.M. Fixture Shop');
    const { tabs } = await hub.call('ext.tabs.list', {});
    assert.ok(tabs.some((t) => t.tabId === tabId && t.openedByAim));
  });

  await step('ext.tabs.create to a checkout URL is blocked by policy', async () => {
    const err = await hub.expectError('ext.tabs.create', { url: 'https://shop.example.com/checkout' }, -32010);
    assert.match(err.message, /Blocked by A\.I\.M\. policy/);
    await waitFor(() => hub.events.some((e) => e.type === 'policy.blocked'), 3000, 'policy.blocked event');
  });

  await step('ext.tabs.navigate to a payment URL is blocked; invalid tab is InvalidParams', async () => {
    await hub.expectError('ext.tabs.navigate', { tabId, url: 'https://shop.example.com/pay/' }, -32010);
    await hub.expectError('ext.tabs.navigate', { tabId: 999999, url: `${base}/page.html` }, -32602);
  });

  // --- Snapshot ----------------------------------------------------------------------------------
  let snap;
  await step('ext.page.snapshot lists interactive elements with stable refs and readable text', async () => {
    snap = await hub.call('ext.page.snapshot', { tabId, includeText: true });
    assert.equal(snap.title, 'A.I.M. Fixture Shop');
    assert.ok(snap.elements.length > 10, `elements ${snap.elements.length}`);
    const byName = (n) => snap.elements.find((e) => e.name === n);
    assert.ok(byName('Search') && byName('Search').role === 'button', 'Search button');
    assert.ok(byName('Pay now')?.role === 'button', 'Pay now button');
    assert.equal(byName('Search products')?.role, 'searchbox');
    assert.equal(byName('Card number')?.extra?.autocomplete, 'cc-number');
    const pw = byName('Password');
    assert.equal(pw.value, '•••••••', 'password masked');
    const heading = snap.elements.find((e) => e.role === 'heading' && e.name === 'Fixture Shop');
    assert.equal(heading.extra.level, 1);
    const help = byName('Help');
    assert.equal(help.role, 'link');
    assert.match(help.href, /\/help$/);
    assert.equal(help.extra.newTab, true);
    assert.equal(byName('Appears later')?.visible, false, 'display:none link reported as not visible');
    assert.match(snap.text, /Welcome to the fixture shop/);
    assert.ok(!snap.text.includes('Footer text'), 'footer stripped');
    assert.ok(snap.viewport.pageHeight > 1600);
    const again = await hub.call('ext.page.snapshot', { tabId, filter: 'button', maxElements: 3 });
    assert.equal(again.elements.length, 3);
    assert.equal(again.truncated, true);
    assert.ok(again.elements.every((e) => e.role === 'button' || e.tag === 'button'));
    const payAgain = again.elements.find((e) => e.name === 'Pay now') ?? (await hub.call('ext.page.snapshot', { tabId, filter: 'Pay now' })).elements[0];
    assert.equal(payAgain.ref, byName('Pay now').ref, 'refs stable across snapshots');
  });

  // --- Payment guard ------------------------------------------------------------------------------
  await step('clicking "Pay now" is blocked and nothing happens on the page', async () => {
    const before = hub.events.filter((e) => e.type === 'policy.blocked').length;
    const err = await hub.expectError('ext.page.click', { tabId, target: { ref: snap.elements.find((e) => e.name === 'Pay now').ref } }, -32010);
    assert.match(err.message, /Blocked by A\.I\.M\. policy/);
    assert.equal(await evalIn(tabId, "document.getElementById('payResult').textContent"), '');
    await waitFor(() => hub.events.filter((e) => e.type === 'policy.blocked').length > before, 3000, 'policy.blocked event');
    const ev = hub.events.filter((e) => e.type === 'policy.blocked').pop();
    assert.equal(ev.tabId, tabId);
  });

  await step('typing into a cc-number field is blocked; typing a card number anywhere is blocked', async () => {
    await hub.expectError('ext.page.type', { tabId, target: { selector: '#cc' }, text: '4111' }, -32010);
    assert.equal(await evalIn(tabId, "document.getElementById('cc').value"), '');
    await hub.expectError('ext.page.type', { tabId, target: { selector: '#q' }, text: '4242 4242 4242 4242' }, -32010);
    assert.equal(await evalIn(tabId, "document.getElementById('q').value"), '');
  });

  // --- Actions ------------------------------------------------------------------------------------
  await step('ext.page.type with pressEnter submits the search form', async () => {
    const q = snap.elements.find((e) => e.name === 'Search products');
    await hub.call('ext.page.type', { tabId, target: { ref: q.ref }, text: 'blue widgets', pressEnter: true });
    assert.equal(await evalIn(tabId, "document.getElementById('searchResult').textContent"), 'Searched for: blue widgets');
    await hub.call('ext.page.type', { tabId, target: { selector: '#q' }, text: ' now', append: true });
    assert.equal(await evalIn(tabId, "document.getElementById('q').value"), 'blue widgets now');
  });

  await step('ext.page.click fires realistic events; double click counts twice', async () => {
    await hub.call('ext.page.click', { tabId, target: { selector: '#counterBtn' } });
    assert.equal(await evalIn(tabId, "document.getElementById('count').textContent"), '1');
    await hub.call('ext.page.click', { tabId, target: { selector: '#counterBtn' }, double: true });
    assert.equal(await evalIn(tabId, "document.getElementById('count').textContent"), '3');
    const r = await hub.call('ext.page.click', { tabId, target: { ref: snap.elements.find((e) => e.name === 'Search').ref } });
    assert.equal(r.ok, true);
  });

  await step('ext.page.click toggles a checkbox; snapshot reports checked', async () => {
    await hub.call('ext.page.click', { tabId, target: { selector: '#terms' } });
    const s2 = await hub.call('ext.page.snapshot', { tabId, filter: 'checkbox' });
    assert.equal(s2.elements[0].checked, true);
  });

  await step('ext.page.select matches by label and by value', async () => {
    const r = await hub.call('ext.page.select', { tabId, target: { selector: '#country' }, value: 'France' });
    assert.equal(r.selected, 'France');
    assert.equal(await evalIn(tabId, "document.getElementById('country').value"), 'fr');
    const r2 = await hub.call('ext.page.select', { tabId, target: { selector: '#country' }, value: 'gb' });
    assert.equal(r2.selected, 'United Kingdom');
    const err = await hub.expectError('ext.page.select', { tabId, target: { selector: '#country' }, value: 'Mars' }, -32602);
    assert.match(err.message, /Available/);
  });

  await step('ext.page.type into contenteditable', async () => {
    await hub.call('ext.page.type', { tabId, target: { selector: '#editor' }, text: 'Hello notes' });
    assert.equal(await evalIn(tabId, "document.getElementById('editor').textContent"), 'Hello notes');
  });

  await step('ext.page.pressKey Escape reaches page handlers; Control+a parses', async () => {
    await hub.call('ext.page.pressKey', { tabId, key: 'Escape' });
    assert.equal(await evalIn(tabId, "document.getElementById('intro').dataset.escaped"), '1');
    await hub.call('ext.page.pressKey', { tabId, key: 'Control+a' });
  });

  await step('ext.page.scroll scrolls the window and into view', async () => {
    const r = await hub.call('ext.page.scroll', { tabId, deltaY: 500 });
    assert.ok(r.scrollY >= 400, `scrollY ${r.scrollY}`);
    const r2 = await hub.call('ext.page.scroll', { tabId, target: { selector: '#bottom' }, intoView: true });
    assert.ok(r2.scrollY > r.scrollY);
  });

  await step('ext.page.read returns readable text and links, without site chrome', async () => {
    const r = await hub.call('ext.page.read', { tabId, includeLinks: true });
    assert.match(r.text, /^# Fixture Shop/m);
    assert.match(r.text, /Welcome to the fixture shop/);
    assert.ok(!r.text.includes('Footer text'));
    assert.ok(r.links.some((l) => /#top$/.test(l.href) && l.text === 'Back to top'), JSON.stringify(r.links));
    assert.ok(!r.links.some((l) => l.text === 'Products'), 'navigation links are not part of the main content');
    const scoped = await hub.call('ext.page.read', { tabId, target: { selector: '#intro' }, maxChars: 120 });
    assert.equal(scoped.truncated, true);
    assert.equal(scoped.text.length, 120);
  });

  await step('ext.page.wait for selector/text and timeout', async () => {
    await hub.call('ext.tabs.navigate', { tabId, url: 'reload' }, 30_000);
    const r = await hub.call('ext.page.wait', { tabId, selector: '#late-link', timeoutMs: 5000 });
    assert.match(r.matched, /late-link/);
    const r2 = await hub.call('ext.page.wait', { tabId, text: 'fixture shop' });
    assert.match(r2.matched, /^text:/);
    const err = await hub.expectError('ext.page.wait', { tabId, text: 'this text never appears', timeoutMs: 400 }, -32003);
    assert.match(err.message, /Timed out/);
    const t = Date.now();
    await hub.call('ext.page.wait', { tabId, ms: 300 });
    assert.ok(Date.now() - t >= 280);
  });

  await step('ext.page.evaluate runs in the page (values, promises, errors)', async () => {
    assert.equal(await evalIn(tabId, '1 + 1'), 2);
    assert.equal(await evalIn(tabId, 'document.title'), 'A.I.M. Fixture Shop');
    assert.equal(await evalIn(tabId, 'Promise.resolve(7)'), 7);
    assert.deepEqual(await evalIn(tabId, '({a: [1, "x"]})'), { a: [1, 'x'] });
    assert.equal(await evalIn(tabId, 'undefined'), null);
    const err = await hub.expectError('ext.page.evaluate', { tabId, code: 'throw new Error("boom")' }, -32020);
    assert.match(err.message, /boom/);
  });

  // --- Cursor + visibility -------------------------------------------------------------------------
  await step('cursor overlay is not rendered in a hidden tab, rendered once the tab is active', async () => {
    await hub.call('ext.cursor.show', { tabId, x: 100, y: 100 });
    const visibility = await evalIn(tabId, 'document.visibilityState');
    if (visibility === 'hidden') {
      const hiddenState = await evalIn(tabId, "(() => { const h = document.querySelector('aim-cursor'); return h ? getComputedStyle(h).display : 'absent'; })()");
      assert.ok(hiddenState === 'absent' || hiddenState === 'none', `overlay hidden state: ${hiddenState}`);
    } else {
      console.log('       (headless Chromium reports background tabs as visible; hidden-state rule not verifiable here)');
    }
    const { tab } = await hub.call('ext.tabs.activate', { tabId });
    assert.equal(tab.active, true);
    await waitFor(async () => (await evalIn(tabId, 'document.visibilityState')) === 'visible', 5000, 'tab visible');
    await hub.call('ext.cursor.show', { tabId, x: 120, y: 140 });
    await hub.call('ext.cursor.move', { tabId, x: 300, y: 200, durationMs: 100 });
    const shown = await evalIn(tabId, "(() => { const h = document.querySelector('aim-cursor'); if (!h) return 'absent'; const a = h.shadowRoot.querySelector('.arrow'); return getComputedStyle(h).display + '|' + a.style.transform + '|' + h.shadowRoot.textContent.includes('A.I.M.'); })()");
    assert.equal(shown, 'block|translate(300px, 200px)|true');
    await hub.call('ext.cursor.hide', { tabId });
    assert.equal(await evalIn(tabId, "getComputedStyle(document.querySelector('aim-cursor')).display"), 'none');
  });

  await step('ext.page.screenshot works on the active tab (and refuses background tabs)', async () => {
    await hub.call('ext.tabs.activate', { tabId });
    const shot = await hub.call('ext.page.screenshot', { tabId });
    assert.equal(shot.mediaType, 'image/png');
    assert.ok(shot.dataBase64.length > 1000);
    assert.equal(Buffer.from(shot.dataBase64, 'base64').subarray(1, 4).toString('ascii'), 'PNG');
    const { tab: other } = await hub.call('ext.tabs.create', { url: `${base}/second.html`, active: false });
    const err = await hub.expectError('ext.page.screenshot', { tabId: other.tabId }, -32020);
    assert.match(err.message, /background/);
    await hub.call('ext.tabs.close', { tabId: other.tabId });
  });

  // --- Navigation ------------------------------------------------------------------------------------
  await step('click that navigates reports navigated=true; back/forward/reload work', async () => {
    const r = await hub.call('ext.page.click', { tabId, target: { selector: '#navigateBtn' } });
    assert.equal(r.navigated, true);
    await waitFor(async () => (await hub.call('ext.tabs.list', {})).tabs.find((t) => t.tabId === tabId)?.url.endsWith('/second.html'), 10_000, 'second page');
    const r2 = await hub.call('ext.page.read', { tabId });
    assert.match(r2.text, /You navigated here/);
    const back = await hub.call('ext.tabs.navigate', { tabId, url: 'back' }, 30_000);
    assert.match(back.tab.url, /page\.html$/);
    const fwd = await hub.call('ext.tabs.navigate', { tabId, url: 'forward' }, 30_000);
    assert.match(fwd.tab.url, /second\.html$/);
    const nav = await hub.call('ext.tabs.navigate', { tabId, url: `${base}/page.html` }, 30_000);
    assert.equal(nav.tab.title, 'A.I.M. Fixture Shop');
    assert.ok(hub.events.some((e) => e.type === 'page.navigated' && e.tabId === tabId && e.url.endsWith('/second.html')), 'page.navigated event');
    assert.ok(hub.events.some((e) => e.type === 'tab.updated' && e.tab.tabId === tabId), 'tab.updated event');
    assert.ok(hub.events.some((e) => e.type === 'tab.activated' && e.tabId === tabId), 'tab.activated event');
  });

  await step('content script is (re)injected when the page has none (orphaned or pre-install tab)', async () => {
    const page = await context.newPage();
    await page.goto(`${base}/second.html`);
    const id = (await hub.call('ext.tabs.list', {})).tabs.find((t) => t.url.endsWith('/second.html') && t.tabId !== tabId).tabId;
    // Orphan the declared content script (what an extension reload does to every open tab).
    // chrome.runtime.reload() itself disables command-line-loaded extensions in headless Chromium.
    const disposed = await swEval(
      async (tabId) => {
        const [r] = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const inst = window.__aimContent;
            if (!inst) return 'absent';
            inst.dispose();
            return inst.alive() ? 'still alive' : 'disposed';
          },
        });
        return r.result;
      },
      id,
    );
    assert.equal(disposed, 'disposed');
    const r = await hub.call('ext.page.read', { tabId: id });
    assert.match(r.text, /Second page/);
    const s2 = await hub.call('ext.page.snapshot', { tabId: id });
    assert.ok(s2.elements.some((e) => e.role === 'link' && e.name === 'Back'));
    await page.close();
  });

  await step('restricted pages fail with a clear message', async () => {
    const page = await context.newPage();
    await page.goto('chrome://version/');
    const id = (await hub.call('ext.tabs.list', {})).tabs.find((t) => t.url.startsWith('chrome://version')).tabId;
    const err = await hub.expectError('ext.page.snapshot', { tabId: id }, -32020);
    assert.match(err.message, /cannot be automated/);
    await page.close();
  });

  await step('ext.page.* on a closed tab fails cleanly; close removes tracking and emits tab.removed', async () => {
    const { tab } = await hub.call('ext.tabs.create', { url: `${base}/second.html` });
    await hub.call('ext.tabs.close', { tabId: tab.tabId });
    await hub.expectError('ext.tabs.close', { tabId: tab.tabId }, -32602);
    await hub.expectError('ext.page.snapshot', { tabId: tab.tabId }, -32602);
    await waitFor(() => hub.events.some((e) => e.type === 'tab.removed' && e.tabId === tab.tabId), 3000, 'tab.removed');
    const { tabs } = await hub.call('ext.tabs.list', {});
    assert.ok(!tabs.some((t) => t.tabId === tab.tabId));
  });

  await step('user.activity events arrive from the page', async () => {
    await waitFor(() => hub.events.some((e) => e.type === 'user.activity' && e.kind === 'visit'), 5000, 'user.activity visit');
  });

  // --- Popup ---------------------------------------------------------------------------------------
  await step('popup shows connected state and A.I.M. tab count', async () => {
    const extId = new URL(sw.url()).host;
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.waitForFunction(() => document.getElementById('statusText')?.textContent === 'Connected to A.I.M.', null, { timeout: 5000 });
    assert.equal(await popup.inputValue('#port'), String(hub.port));
    assert.equal(await popup.inputValue('#token'), TOKEN);
    assert.equal(await popup.textContent('#aimTabs'), '1');
    await popup.click('#test');
    await popup.waitForFunction(() => /Connected to A\.I\.M\./.test(document.getElementById('testResult')?.textContent ?? ''), null, { timeout: 5000 });
    await popup.click('#closeTabs');
    await popup.waitForFunction(() => document.getElementById('aimTabs')?.textContent === '0', null, { timeout: 5000 });
    const { tabs } = await hub.call('ext.tabs.list', {});
    assert.ok(!tabs.some((t) => t.tabId === tabId), 'AIM tab closed from popup');
    await popup.close();
  });

  // --- Hub restart -----------------------------------------------------------------------------------
  await step('extension reconnects after the hub restarts', async () => {
    const hellosBefore = hub.hellos.length;
    await hub.close();
    await waitFor(async () => (await swEval(() => globalThis.__aim.hub.state)) !== 'connected', 5000, 'disconnect noticed');
    await sleep(500);
    for (let i = 0; ; i++) {
      try {
        await hub.listen(hub.port);
        break;
      } catch (e) {
        if (i >= 20) throw e;
        await sleep(250);
      }
    }
    await hub.waitForExtension(15_000);
    assert.ok(hub.hellos.length > hellosBefore);
    const s = await hub.call('ext.status', {});
    assert.equal(s.extensionVersion, '0.1.0');
  });
} finally {
  console.log(`\n${passed} passed, ${failures} failed in ${Math.round((Date.now() - startedAt) / 1000)} s; keepalive pings seen: ${hub.pingsFromExtension}; hellos: ${hub.hellos.length}; events: ${hub.events.length}`);
  await Promise.race([context.close().catch(() => undefined), sleep(10_000)]);
  await hub.close().catch(() => undefined);
  http.close();
  rmSync(profile, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}

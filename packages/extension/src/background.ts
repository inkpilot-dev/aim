/**
 * A.I.M. Browser Bridge — MV3 background service worker.
 *
 * Connects (as a WebSocket client) to the A.I.M. desktop app ("Hub") at ws://127.0.0.1:<port>/aim/ext,
 * authenticates with `hub.hello`, then serves `ext.*` requests (tabs, page actions, cursor) and
 * streams `ext.event` notifications back. See @aim/shared/extension.ts for the protocol.
 */
import {
  EXT_EVENT_METHOD,
  HUB_DEFAULT_PORT,
  HUB_HOST,
  HUB_PATH_EXTENSION,
  PAYMENT_BLOCK_MESSAGE,
  RpcError,
  RpcErrorCode,
  guardNavigate,
  isRpcRequest,
  isRpcResponse,
  rpcFailure,
  rpcNotification,
  rpcRequest,
  rpcSuccess,
  type ExtEvent,
  type ExtMethod,
  type ExtParams,
  type ExtResult,
  type ExtTabInfo,
  type HubHelloParams,
  type HubHelloResult,
  type RpcId,
  type RpcMessage,
  type RpcRequest, AIM_TAB_GROUP_TITLE, AIM_TAB_GROUP_COLOR } from '@aim/shared';
import {
  PAGE_METHODS,
  SESSION_KEYS,
  STORAGE_KEYS,
  type ConnectionState,
  type ContentResponse,
  type FromContentMessage,
  type FromPopupMessage,
  type PageMethod,
  type StatusReport,
  type TestResult,
  type ToContentMessage,
} from './messages.js';
import {
  KeyedThrottle,
  backoffDelay,
  browserFromBrands,
  browserFromUA,
  describeClose,
  encodeRpcFrame,
  errorMessage,
  hubUrl,
  isRestrictedUrl,
  normalizePort,
  normalizeUrl,
  parseRpcFrame,
  sleep,
  withJitter,
  withTimeout,
} from './shared-utils.js';

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

const ALARM_NAME = 'aim-keepalive';
const ALARM_PERIOD_MIN = 0.5; // 30 s — the smallest period Chrome allows for extension alarms
const PING_INTERVAL_MS = 20_000;
const PING_TIMEOUT_MS = 10_000;
const HELLO_TIMEOUT_MS = 6_000;
const NAVIGATE_TIMEOUT_MS = 30_000;
const CREATE_LOAD_WAIT_MS = 15_000;
const CONTENT_CALL_TIMEOUT_MS = 15_000;
const SNAPSHOT_TIMEOUT_MS = 25_000;
const HANDLER_SAFETY_TIMEOUT_MS = 90_000;
const MAX_WAIT_MS = 60_000;

const log = (...args: unknown[]) => console.log('[aim]', ...args);
const warn = (...args: unknown[]) => console.warn('[aim]', ...args);

// ---------------------------------------------------------------------------------------------
// Configuration (chrome.storage.local, written by the popup)
// ---------------------------------------------------------------------------------------------

interface HubConfig { port: number; token: string }

async function readConfig(): Promise<HubConfig> {
  try {
    const stored = await chrome.storage.local.get([STORAGE_KEYS.port, STORAGE_KEYS.token]);
    return {
      port: normalizePort(stored[STORAGE_KEYS.port], HUB_DEFAULT_PORT),
      token: typeof stored[STORAGE_KEYS.token] === 'string' ? (stored[STORAGE_KEYS.token] as string).trim() : '',
    };
  } catch (e) {
    warn('storage read failed', e);
    return { port: HUB_DEFAULT_PORT, token: '' };
  }
}

// ---------------------------------------------------------------------------------------------
// Browser identification
// ---------------------------------------------------------------------------------------------

function identifyBrowser(): { name: string; version: string } {
  const nav = navigator as Navigator & { userAgentData?: { brands?: { brand: string; version: string }[] } };
  const fromBrands = browserFromBrands(nav.userAgentData?.brands);
  const fromUA = browserFromUA(navigator.userAgent);
  // Brands give a reliable name; the UA gives a full version string.
  if (fromBrands) return { name: fromBrands.name, version: fromUA.version || fromBrands.version };
  return { name: fromUA.name, version: fromUA.version };
}

const BROWSER = identifyBrowser();
const EXTENSION_VERSION = chrome.runtime.getManifest().version;
const CONTENT_SCRIPT_FILES: string[] = chrome.runtime.getManifest().content_scripts?.[0]?.js ?? ['content.js'];

// ---------------------------------------------------------------------------------------------
// Tabs opened by A.I.M. (persisted in storage.session so a worker restart keeps them)
// ---------------------------------------------------------------------------------------------

const aimTabs = new Set<number>();
let aimTabsLoaded: Promise<void> | undefined;

function loadAimTabs(): Promise<void> {
  if (!aimTabsLoaded) {
    aimTabsLoaded = (async () => {
      try {
        const stored = await chrome.storage.session.get(SESSION_KEYS.aimTabs);
        const ids = stored[SESSION_KEYS.aimTabs];
        if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'number') aimTabs.add(id);
        // Drop tabs that no longer exist.
        const existing = new Set((await chrome.tabs.query({})).map((t) => t.id));
        for (const id of [...aimTabs]) if (!existing.has(id)) aimTabs.delete(id);
      } catch (e) {
        warn('session storage unavailable', e);
      }
    })();
  }
  return aimTabsLoaded;
}

async function persistAimTabs(): Promise<void> {
  try {
    await chrome.storage.session.set({ [SESSION_KEYS.aimTabs]: [...aimTabs] });
  } catch {
    /* session storage may be unavailable in very old browsers; the in-memory set still works */
  }
}

// ---------------------------------------------------------------------------------------------
// Hub client
// ---------------------------------------------------------------------------------------------

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

class HubClient {
  state: ConnectionState = 'disconnected';
  reason = 'Not connected yet.';
  hubVersion?: string;
  lastConnectedAt?: number;
  private ws?: WebSocket;
  private attempt = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private pingTimer?: ReturnType<typeof setInterval>;
  private missedPings = 0;
  private readonly pending = new Map<RpcId, Pending>();
  private connectPromise?: Promise<void>;
  private generation = 0;
  /** Called for every `ext.*` request from the hub. */
  onRequest?: (req: RpcRequest) => Promise<unknown>;
  /** Called whenever the state changes (popup refresh). */
  onStateChange?: () => void;

  get connected(): boolean {
    return this.state === 'connected' && this.ws?.readyState === WebSocket.OPEN;
  }

  /** Connect now unless already connected/connecting. Resolves when the attempt finished (either way). */
  connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.doConnect().finally(() => {
      this.connectPromise = undefined;
    });
    return this.connectPromise;
  }

  /** Drop the current socket (if any) and connect immediately with a fresh backoff. */
  reconnectNow(): Promise<void> {
    this.attempt = 0;
    this.clearReconnectTimer();
    this.teardownSocket('Reconnecting.');
    return this.connect();
  }

  private async doConnect(): Promise<void> {
    this.clearReconnectTimer();
    const cfg = await readConfig();
    if (!cfg.token) {
      this.setState('disconnected', 'Pairing token not set. Open the A.I.M. Browser Bridge popup and paste the token shown in A.I.M. Settings.');
      return; // storage.onChanged / the alarm will try again
    }
    const url = hubUrl(cfg.port, HUB_HOST, HUB_PATH_EXTENSION);
    this.setState('connecting', `Connecting to A.I.M. on port ${cfg.port}.`);
    const gen = ++this.generation;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      this.setState('disconnected', `Cannot open a connection to ${url}: ${errorMessage(e)}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    let closedReason: string | undefined;

    const opened = new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error(`A.I.M. is not reachable on port ${cfg.port}. Make sure the A.I.M. desktop app is running and that the port matches A.I.M. Settings.`));
      ws.onclose = (ev) => {
        closedReason = describeClose(ev.code, ev.reason);
        reject(new Error(closedReason));
      };
    });

    ws.onmessage = (ev) => this.handleFrame(ev.data, gen);

    try {
      await withTimeout(opened, HELLO_TIMEOUT_MS, 'Connecting to A.I.M.');
      // Install the steady-state handlers before the handshake so a close during hello is caught.
      ws.onclose = (ev) => this.handleClose(gen, ev.code, ev.reason);
      ws.onerror = () => {
        /* onclose follows */
      };
      const hello: HubHelloParams = { token: cfg.token, client: 'extension', browser: BROWSER.name, version: `${BROWSER.name}/${BROWSER.version} ext/${EXTENSION_VERSION}` };
      const result = (await this.request('hub.hello', hello, HELLO_TIMEOUT_MS)) as Partial<HubHelloResult> | undefined;
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) throw new Error(closedReason ?? 'Connection closed during pairing.');
      this.hubVersion = result?.hubVersion;
      this.attempt = 0;
      this.missedPings = 0;
      this.lastConnectedAt = Date.now();
      this.setState('connected', `Connected to A.I.M. on port ${cfg.port}.`);
      this.startPings();
      log('connected to hub', url);
    } catch (e) {
      const msg =
        e instanceof RpcError
          ? `Pairing rejected by A.I.M. (${e.message}). Copy the current token from A.I.M. Settings and save it again.`
          : (closedReason ?? errorMessage(e));
      if (this.ws === ws) {
        this.ws = undefined;
        try {
          ws.onclose = null;
          ws.close();
        } catch {
          /* ignore */
        }
      }
      this.rejectAllPending(new Error(msg));
      this.setState('disconnected', msg);
      this.scheduleReconnect();
    }
  }

  private handleClose(gen: number, code: number, reason: string): void {
    if (gen !== this.generation) return;
    const msg = describeClose(code, reason);
    warn('hub connection closed', code, reason);
    this.ws = undefined;
    this.stopPings();
    this.rejectAllPending(new Error(msg));
    this.setState('disconnected', msg);
    this.scheduleReconnect();
  }

  private teardownSocket(reason: string): void {
    const ws = this.ws;
    this.ws = undefined;
    this.generation++;
    this.stopPings();
    this.rejectAllPending(new Error(reason));
    if (ws) {
      try {
        ws.onclose = null;
        ws.onerror = null;
        ws.onmessage = null;
        ws.close(1000, reason);
      } catch {
        /* ignore */
      }
    }
    if (this.state !== 'disconnected') this.setState('disconnected', reason);
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    const delay = withJitter(backoffDelay(this.attempt));
    this.attempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private startPings(): void {
    this.stopPings();
    this.pingTimer = setInterval(() => void this.ping(), PING_INTERVAL_MS);
  }

  private stopPings(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
  }

  /** Keepalive ping. Two consecutive misses drop the socket so reconnection can begin. */
  async ping(): Promise<void> {
    if (!this.connected) return;
    try {
      await this.request('hub.ping', {}, PING_TIMEOUT_MS);
      this.missedPings = 0;
    } catch (e) {
      if (e instanceof RpcError) {
        // The hub answered (even with an error such as MethodNotFound) — the link is alive.
        this.missedPings = 0;
        return;
      }
      this.missedPings++;
      warn('ping failed', errorMessage(e), 'missed', this.missedPings);
      if (this.missedPings >= 2) {
        this.teardownSocket('A.I.M. stopped responding; reconnecting.');
        this.scheduleReconnect();
      }
    }
  }

  private setState(state: ConnectionState, reason: string): void {
    this.state = state;
    this.reason = reason;
    this.onStateChange?.();
  }

  private rejectAllPending(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  send(message: RpcMessage): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(encodeRpcFrame(message));
      return true;
    } catch (e) {
      warn('send failed', e);
      return false;
    }
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const req = rpcRequest(method, params);
    return new Promise<unknown>((resolve, reject) => {
      if (!this.send(req)) {
        reject(new Error('Not connected to A.I.M.'));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(req.id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(req.id, { resolve, reject, timer });
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.connected) return;
    this.send(rpcNotification(method, params));
  }

  private handleFrame(data: unknown, gen: number): void {
    if (gen !== this.generation) return;
    const msg = parseRpcFrame(data);
    if (!msg) {
      warn('ignoring malformed frame');
      return;
    }
    if (isRpcResponse(msg)) {
      const p = this.pending.get(msg.id as RpcId);
      if (!p) return;
      this.pending.delete(msg.id as RpcId);
      clearTimeout(p.timer);
      if ('error' in msg) p.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data));
      else p.resolve(msg.result);
      return;
    }
    if (isRpcRequest(msg)) {
      void this.serveRequest(msg);
      return;
    }
    // Notifications from the hub are informational; nothing to do.
  }

  private async serveRequest(req: RpcRequest): Promise<void> {
    let response: RpcMessage;
    try {
      if (req.method === 'hub.ping') {
        response = rpcSuccess(req.id, { ok: true, time: Date.now() });
      } else if (!this.onRequest) {
        response = rpcFailure(req.id, { code: RpcErrorCode.InternalError, message: 'Extension not ready.' });
      } else {
        const result = await withTimeout(this.onRequest(req), HANDLER_SAFETY_TIMEOUT_MS, req.method);
        response = rpcSuccess(req.id, result);
      }
    } catch (e) {
      response = rpcFailure(req.id, toRpcErrorObject(e));
    }
    this.send(response);
  }
}

function toRpcErrorObject(e: unknown): { code: number; message: string; data?: unknown } {
  if (e instanceof RpcError) return e.toObject();
  const msg = errorMessage(e);
  if ((e as { timeout?: boolean })?.timeout) return { code: RpcErrorCode.Timeout, message: msg };
  return { code: RpcErrorCode.ToolFailed, message: msg };
}

const hub = new HubClient();

function emit(event: ExtEvent): void {
  hub.notify(EXT_EVENT_METHOD, event);
}

// ---------------------------------------------------------------------------------------------
// Tab helpers
// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// The "A.I.M." tab group: every tab A.I.M. opens is collected there, one group per window.
// ---------------------------------------------------------------------------------------------

const aimGroupIds = new Set<number>();
let groupQueue: Promise<unknown> = Promise.resolve();

function tabGroupsAvailable(): boolean {
  return typeof chrome.tabGroups?.query === 'function' && typeof chrome.tabs.group === 'function';
}

async function refreshAimGroups(): Promise<void> {
  if (!tabGroupsAvailable()) return;
  try {
    const groups = await chrome.tabGroups.query({ title: AIM_TAB_GROUP_TITLE });
    aimGroupIds.clear();
    for (const g of groups) aimGroupIds.add(g.id);
  } catch {
    /* keep the last known set */
  }
}

/** Moves a tab into this window's "A.I.M." group, creating the group when needed. Never throws. */
function addToAimGroup(tabId: number, windowId: number): Promise<number | undefined> {
  // Serialised so two tabs opened at once end up in one group rather than two.
  const run = async (): Promise<number | undefined> => {
    if (!tabGroupsAvailable()) return undefined;
    try {
      const existing = (await chrome.tabGroups.query({ windowId, title: AIM_TAB_GROUP_TITLE }))[0];
      if (existing) {
        await chrome.tabs.group({ groupId: existing.id, tabIds: [tabId] });
        aimGroupIds.add(existing.id);
        return existing.id;
      }
      const groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId } });
      await chrome.tabGroups.update(groupId, { title: AIM_TAB_GROUP_TITLE, color: AIM_TAB_GROUP_COLOR, collapsed: false });
      aimGroupIds.add(groupId);
      return groupId;
    } catch (e) {
      console.warn('[aim] could not place tab in the A.I.M. group:', errorMessage(e));
      return undefined;
    }
  };
  const p = groupQueue.then(run, run);
  groupQueue = p.catch(() => undefined);
  return p;
}

function toTabInfo(tab: chrome.tabs.Tab): ExtTabInfo {
  const info: ExtTabInfo = {
    tabId: tab.id ?? -1,
    windowId: tab.windowId,
    index: tab.index,
    title: tab.title ?? '',
    url: tab.url ?? tab.pendingUrl ?? '',
    active: tab.active,
    status: tab.status,
  };
  if (tab.audible) info.audible = true;
  if (tab.id !== undefined && aimTabs.has(tab.id)) info.openedByAim = true;
  const groupId = (tab as { groupId?: number }).groupId;
  if (typeof groupId === 'number' && groupId >= 0) {
    info.groupId = groupId;
    if (aimGroupIds.has(groupId)) info.inAimGroup = true;
  }
  return info;
}

async function getTab(tabId: number): Promise<chrome.tabs.Tab> {
  if (typeof tabId !== 'number' || !Number.isInteger(tabId)) throw new RpcError(RpcErrorCode.InvalidParams, 'tabId must be an integer.');
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    throw new RpcError(RpcErrorCode.InvalidParams, `Tab ${tabId} does not exist (it may have been closed). Use ext.tabs.list to find open tabs.`);
  }
}

/** Window for new tabs: the last focused normal window; falls back to any normal window. Never creates one. */
async function defaultWindowId(): Promise<number | undefined> {
  try {
    const w = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    if (w?.id !== undefined && w.id !== chrome.windows.WINDOW_ID_NONE) return w.id;
  } catch {
    /* fall through */
  }
  try {
    const all = await chrome.windows.getAll({ windowTypes: ['normal'] });
    const candidate = all.find((w) => w.focused) ?? all.find((w) => w.state !== 'minimized') ?? all[0];
    return candidate?.id;
  } catch {
    return undefined;
  }
}

/**
 * Wait until a tab finishes loading. Resolves with the tab; rejects with Timeout.
 * Handles tabs that are already complete and navigations that never start (same-document).
 */
function waitForTabComplete(tabId: number, timeoutMs: number): Promise<chrome.tabs.Tab> {
  return new Promise<chrome.tabs.Tab>((resolve, reject) => {
    let done = false;
    let sawLoading = false;
    const started = Date.now();
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      clearInterval(poll);
      clearTimeout(timer);
      fn();
    };
    const onUpdated = (id: number, change: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => {
      if (id !== tabId) return;
      if (change.status === 'loading') sawLoading = true;
      if (change.status === 'complete') finish(() => resolve(tab));
    };
    const onRemoved = (id: number) => {
      if (id === tabId) finish(() => reject(new RpcError(RpcErrorCode.ToolFailed, `Tab ${tabId} was closed while loading.`)));
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    const poll = setInterval(() => {
      chrome.tabs.get(tabId).then(
        (tab) => {
          if (tab.status === 'loading') sawLoading = true;
          else if (tab.status === 'complete' && (sawLoading || Date.now() - started > 1200)) finish(() => resolve(tab));
        },
        () => finish(() => reject(new RpcError(RpcErrorCode.ToolFailed, `Tab ${tabId} disappeared while loading.`))),
      );
    }, 400);
    const timer = setTimeout(() => {
      finish(() => {
        const err = new RpcError(RpcErrorCode.Timeout, `The page in tab ${tabId} did not finish loading within ${Math.round(timeoutMs / 1000)} s. It may still be usable; try ext.page.snapshot.`);
        reject(err);
      });
    }, timeoutMs);
  });
}

/**
 * Per-tab URL history kept by the extension. Chromium skips history entries created without user
 * activation (synthetic clicks never have it), so chrome.tabs.goBack/goForward can fail after
 * A.I.M. navigated a page; this record lets "back"/"forward" fall back to an explicit navigation.
 */
interface TabHistory { urls: string[]; index: number }
const tabHistory = new Map<number, TabHistory>();

function recordNavigation(tabId: number, url: string): void {
  const h = tabHistory.get(tabId) ?? { urls: [], index: -1 };
  if (h.urls[h.index] === url) return;
  if (h.index > 0 && h.urls[h.index - 1] === url) h.index--;
  else if (h.index < h.urls.length - 1 && h.urls[h.index + 1] === url) h.index++;
  else {
    h.urls = h.urls.slice(0, h.index + 1);
    h.urls.push(url);
    if (h.urls.length > 50) h.urls.shift();
    h.index = h.urls.length - 1;
  }
  tabHistory.set(tabId, h);
}

function historyNeighbour(tabId: number, direction: 'back' | 'forward'): string | undefined {
  const h = tabHistory.get(tabId);
  if (!h) return undefined;
  const target = direction === 'back' ? h.index - 1 : h.index + 1;
  return h.urls[target];
}

async function historyStep(tabId: number, direction: 'back' | 'forward'): Promise<void> {
  try {
    if (direction === 'back') await chrome.tabs.goBack(tabId);
    else await chrome.tabs.goForward(tabId);
  } catch (e) {
    const fallback = historyNeighbour(tabId, direction);
    if (!fallback) {
      throw new RpcError(RpcErrorCode.ToolFailed, `Cannot go ${direction}: there is no such page in this tab's history.`);
    }
    warn(`${direction} via browser history failed (${errorMessage(e)}); navigating to ${fallback}`);
    await chrome.tabs.update(tabId, { url: fallback });
  }
}

function assertAllowedNavigation(url: string, tabId: number): void {
  const verdict = guardNavigate(url);
  if (verdict.blocked) {
    emit({ type: 'policy.blocked', tabId, reason: verdict.reason ?? 'Payment page' });
    throw new RpcError(RpcErrorCode.PolicyBlocked, PAYMENT_BLOCK_MESSAGE, { reason: verdict.reason, url });
  }
}

// ---------------------------------------------------------------------------------------------
// Content-script bridge
// ---------------------------------------------------------------------------------------------

function contentError(e: unknown): RpcError {
  const msg = errorMessage(e);
  if (/Receiving end does not exist|Could not establish connection/i.test(msg)) return new RpcError(RpcErrorCode.ToolFailed, 'The A.I.M. content script is not running in this tab.');
  if (/message port closed|message channel closed/i.test(msg)) return new RpcError(RpcErrorCode.ToolFailed, 'The page navigated or closed before it could respond.');
  if (/No tab with id/i.test(msg)) return new RpcError(RpcErrorCode.InvalidParams, 'The tab no longer exists.');
  if (/Cannot access|chrome:\/\/|edge:\/\/|extensions gallery|cannot be scripted/i.test(msg)) return new RpcError(RpcErrorCode.ToolFailed, 'This page cannot be automated (browser-internal page or extension store).');
  if (/showing error page/i.test(msg)) return new RpcError(RpcErrorCode.ToolFailed, 'The tab is showing a browser error page (the site could not be loaded).');
  return new RpcError(RpcErrorCode.ToolFailed, msg);
}

async function pingContent(tabId: number): Promise<boolean> {
  try {
    const r = (await chrome.tabs.sendMessage(tabId, { kind: 'aim.ping' } satisfies ToContentMessage)) as ContentResponse | undefined;
    return !!r && r.ok === true;
  } catch {
    return false;
  }
}

/** Make sure the content script is present (tabs opened before install, or pages that lost it). */
async function ensureContentScript(tabId: number): Promise<void> {
  const tab = await getTab(tabId);
  if (isRestrictedUrl(tab.url ?? tab.pendingUrl)) {
    throw new RpcError(RpcErrorCode.ToolFailed, `This page (${tab.url ?? 'unknown URL'}) cannot be automated: browser-internal pages, extension stores and file/data URLs are off limits to extensions.`);
  }
  if (tab.status === 'loading') {
    // Give a freshly navigated page a moment; the declared content script will arrive at document_idle.
    try {
      await waitForTabComplete(tabId, 8_000);
    } catch {
      /* proceed anyway; we may still be able to inject */
    }
  }
  if (await pingContent(tabId)) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_SCRIPT_FILES });
  } catch (e) {
    throw contentError(e);
  }
  for (let i = 0; i < 20; i++) {
    if (await pingContent(tabId)) return;
    await sleep(100);
  }
  throw new RpcError(RpcErrorCode.ToolFailed, 'The page did not accept the A.I.M. content script (it may be blocked by the site or still loading).');
}

async function callContent<M extends PageMethod>(tabId: number, method: M, params: ExtParams<M>, timeoutMs = CONTENT_CALL_TIMEOUT_MS): Promise<ExtResult<M>> {
  await ensureContentScript(tabId);
  const message: ToContentMessage = { kind: 'aim.page', method, params };
  let response: ContentResponse<M> | undefined;
  try {
    response = (await withTimeout(chrome.tabs.sendMessage(tabId, message), timeoutMs, method)) as ContentResponse<M> | undefined;
  } catch (e) {
    if ((e as { timeout?: boolean })?.timeout) throw new RpcError(RpcErrorCode.Timeout, errorMessage(e));
    throw contentError(e);
  }
  if (!response) throw new RpcError(RpcErrorCode.ToolFailed, 'The page returned no response.');
  if (!response.ok) {
    if (response.code === RpcErrorCode.PolicyBlocked) emit({ type: 'policy.blocked', tabId, reason: String((response.data as { reason?: string } | undefined)?.reason ?? response.message) });
    throw new RpcError(response.code, response.message, response.data);
  }
  return response.result;
}

/** Page actions that may unload the page: a closed message port means the navigation happened. */
async function callContentMayNavigate<M extends 'ext.page.click' | 'ext.page.type' | 'ext.page.pressKey'>(tabId: number, method: M, params: ExtParams<M>): Promise<ExtResult<M>> {
  try {
    return await callContent(tabId, method, params);
  } catch (e) {
    if (e instanceof RpcError && /navigated or closed before it could respond/.test(e.message)) {
      const stillThere = await chrome.tabs.get(tabId).then(() => true, () => false);
      if (stillThere) return (method === 'ext.page.click' ? { ok: true, navigated: true } : { ok: true }) as ExtResult<M>;
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------
// ext.* handlers
// ---------------------------------------------------------------------------------------------

type Handler<M extends ExtMethod> = (params: ExtParams<M>) => Promise<ExtResult<M>>;
type Handlers = { [M in ExtMethod]: Handler<M> };

function requireTabId(params: { tabId?: unknown }): number {
  if (typeof params?.tabId !== 'number' || !Number.isInteger(params.tabId)) throw new RpcError(RpcErrorCode.InvalidParams, 'tabId (integer) is required.');
  return params.tabId;
}

const handlers: Handlers = {
  async 'ext.status'() {
    const [windows, tabs] = await Promise.all([chrome.windows.getAll({ windowTypes: ['normal'] }).catch(() => []), chrome.tabs.query({}).catch(() => [])]);
    return { browser: BROWSER.name, version: BROWSER.version, extensionVersion: EXTENSION_VERSION, windows: windows.length, tabs: tabs.length };
  },

  async 'ext.tabs.list'() {
    await loadAimTabs();
    await refreshAimGroups();
    const tabs = await chrome.tabs.query({});
    return { tabs: tabs.filter((t) => t.id !== undefined).map(toTabInfo) };
  },

  async 'ext.tabs.create'(params) {
    if (typeof params?.url !== 'string' || !params.url.trim()) throw new RpcError(RpcErrorCode.InvalidParams, 'url is required.');
    const url = normalizeUrl(params.url);
    assertAllowedNavigation(url, -1);
    await loadAimTabs();
    const windowId = params.windowId ?? (await defaultWindowId());
    const createProps: chrome.tabs.CreateProperties = { url, active: params.active === true };
    if (windowId !== undefined) createProps.windowId = windowId;
    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.create(createProps);
    } catch (e) {
      const msg = errorMessage(e);
      if (params.windowId !== undefined && /No window with id/i.test(msg)) throw new RpcError(RpcErrorCode.InvalidParams, `Window ${params.windowId} does not exist.`);
      throw new RpcError(RpcErrorCode.ToolFailed, `Could not open a tab: ${msg}. A normal browser window must be open.`);
    }
    const newTabId = tab.id;
    if (newTabId !== undefined) {
      aimTabs.add(newTabId);
      void persistAimTabs();
      await addToAimGroup(newTabId, tab.windowId);
      try {
        tab = await waitForTabComplete(newTabId, CREATE_LOAD_WAIT_MS);
      } catch {
        tab = await chrome.tabs.get(newTabId).catch(() => tab);
      }
    }
    return { tab: toTabInfo(tab) };
  },

  async 'ext.tabs.navigate'(params) {
    const tabId = requireTabId(params);
    if (typeof params.url !== 'string' || !params.url.trim()) throw new RpcError(RpcErrorCode.InvalidParams, 'url is required ("back", "forward", "reload" or an address).');
    await loadAimTabs();
    await getTab(tabId);
    const command = params.url.trim().toLowerCase();
    try {
      if (command === 'back' || command === 'forward') await historyStep(tabId, command);
      else if (command === 'reload') await chrome.tabs.reload(tabId);
      else {
        const url = normalizeUrl(params.url);
        assertAllowedNavigation(url, tabId);
        await chrome.tabs.update(tabId, { url });
      }
    } catch (e) {
      if (e instanceof RpcError) throw e;
      throw new RpcError(RpcErrorCode.ToolFailed, `Navigation failed: ${errorMessage(e)}`);
    }
    if (params.waitForLoad === false) return { tab: toTabInfo(await getTab(tabId)) };
    try {
      const tab = await waitForTabComplete(tabId, NAVIGATE_TIMEOUT_MS);
      return { tab: toTabInfo(tab) };
    } catch (e) {
      if (e instanceof RpcError && e.code === RpcErrorCode.Timeout) {
        const tab = await chrome.tabs.get(tabId).catch(() => undefined);
        throw new RpcError(e.code, e.message, tab ? { tab: toTabInfo(tab) } : undefined);
      }
      throw e;
    }
  },

  async 'ext.tabs.close'(params) {
    const tabId = requireTabId(params);
    await getTab(tabId);
    try {
      await chrome.tabs.remove(tabId);
    } catch (e) {
      throw new RpcError(RpcErrorCode.ToolFailed, `Could not close tab ${tabId}: ${errorMessage(e)}`);
    }
    aimTabs.delete(tabId);
    void persistAimTabs();
    return { ok: true };
  },

  async 'ext.tabs.activate'(params) {
    const tabId = requireTabId(params);
    await loadAimTabs();
    await getTab(tabId);
    try {
      const tab = await chrome.tabs.update(tabId, { active: true });
      return { tab: toTabInfo(tab ?? (await getTab(tabId))) };
    } catch (e) {
      throw new RpcError(RpcErrorCode.ToolFailed, `Could not activate tab ${tabId}: ${errorMessage(e)}`);
    }
  },

  async 'ext.page.snapshot'(params) {
    const tabId = requireTabId(params);
    return callContent(tabId, 'ext.page.snapshot', params, SNAPSHOT_TIMEOUT_MS);
  },

  async 'ext.page.click'(params) {
    const tabId = requireTabId(params);
    if (!params.target || (typeof params.target.ref !== 'string' && typeof params.target.selector !== 'string')) throw new RpcError(RpcErrorCode.InvalidParams, 'target.ref or target.selector is required.');
    return callContentMayNavigate(tabId, 'ext.page.click', params);
  },

  async 'ext.page.type'(params) {
    const tabId = requireTabId(params);
    if (typeof params.text !== 'string') throw new RpcError(RpcErrorCode.InvalidParams, 'text (string) is required.');
    return callContentMayNavigate(tabId, 'ext.page.type', params);
  },

  async 'ext.page.select'(params) {
    const tabId = requireTabId(params);
    if (!params.target) throw new RpcError(RpcErrorCode.InvalidParams, 'target is required.');
    if (typeof params.value !== 'string') throw new RpcError(RpcErrorCode.InvalidParams, 'value (string) is required.');
    return callContent(tabId, 'ext.page.select', params);
  },

  async 'ext.page.pressKey'(params) {
    const tabId = requireTabId(params);
    if (typeof params.key !== 'string' || !params.key.trim()) throw new RpcError(RpcErrorCode.InvalidParams, 'key is required (e.g. "Enter", "Escape", "Control+a").');
    return callContentMayNavigate(tabId, 'ext.page.pressKey', params);
  },

  async 'ext.page.scroll'(params) {
    const tabId = requireTabId(params);
    return callContent(tabId, 'ext.page.scroll', params);
  },

  async 'ext.page.read'(params) {
    const tabId = requireTabId(params);
    return callContent(tabId, 'ext.page.read', params, SNAPSHOT_TIMEOUT_MS);
  },

  async 'ext.page.screenshot'(params) {
    const tabId = requireTabId(params);
    const tab = await getTab(tabId);
    if (!tab.active) {
      throw new RpcError(
        RpcErrorCode.ToolFailed,
        `Tab ${tabId} is in the background; the browser only captures the active tab of a window. Use ext.page.snapshot (no screenshot needed) or ext.tabs.activate first.`,
      );
    }
    try {
      const win = await chrome.windows.get(tab.windowId);
      if (win.state === 'minimized') throw new RpcError(RpcErrorCode.ToolFailed, 'The window is minimised; the browser cannot capture a minimised window.');
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      const comma = dataUrl.indexOf(',');
      const header = dataUrl.slice(0, comma);
      const mediaType = header.match(/^data:([^;]+)/)?.[1] ?? 'image/png';
      return { mediaType, dataBase64: dataUrl.slice(comma + 1) };
    } catch (e) {
      if (e instanceof RpcError) throw e;
      throw new RpcError(RpcErrorCode.ToolFailed, `Screenshot failed: ${errorMessage(e)}`);
    }
  },

  async 'ext.page.evaluate'(params) {
    const tabId = requireTabId(params);
    if (typeof params.code !== 'string') throw new RpcError(RpcErrorCode.InvalidParams, 'code (string) is required.');
    const tab = await getTab(tabId);
    if (isRestrictedUrl(tab.url ?? tab.pendingUrl)) throw new RpcError(RpcErrorCode.ToolFailed, 'This page cannot be scripted by extensions.');
    let results: chrome.scripting.InjectionResult[];
    try {
      results = await withTimeout(
        chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: (code: string) => {
            try {
              // Indirect eval runs in the page's global scope (MAIN world), not the extension's.
              const value: unknown = (0, eval)(code);
              return Promise.resolve(value).then(
                (v) => ({ value: v === undefined ? null : v }),
                (err: unknown) => ({ error: String(err instanceof Error ? err.message : err) }),
              );
            } catch (err) {
              return { error: String(err instanceof Error ? `${err.name}: ${err.message}` : err) };
            }
          },
          args: [params.code],
        }),
        CONTENT_CALL_TIMEOUT_MS,
        'ext.page.evaluate',
      );
    } catch (e) {
      if ((e as { timeout?: boolean })?.timeout) throw new RpcError(RpcErrorCode.Timeout, errorMessage(e));
      throw contentError(e);
    }
    const outcome = results?.[0]?.result as { value?: unknown; error?: string } | undefined;
    if (!outcome) throw new RpcError(RpcErrorCode.ToolFailed, 'The page returned no result (the value may not be serialisable, or the frame was replaced).');
    if (outcome.error !== undefined) {
      const hint = /unsafe-eval|Content Security Policy|Refused to evaluate/i.test(outcome.error)
        ? ' The page\'s Content Security Policy forbids evaluating code strings; use ext.page.snapshot / ext.page.read instead.'
        : '';
      throw new RpcError(RpcErrorCode.ToolFailed, `Evaluation failed: ${outcome.error}.${hint}`);
    }
    return { value: outcome.value };
  },

  async 'ext.page.wait'(params) {
    const tabId = requireTabId(params);
    const hasCondition = (typeof params.selector === 'string' && params.selector.length > 0) || (typeof params.text === 'string' && params.text.length > 0);
    if (!hasCondition) {
      const ms = Math.min(MAX_WAIT_MS, Math.max(0, Number(params.ms ?? params.timeoutMs ?? 0)));
      await getTab(tabId);
      await sleep(ms);
      return { ok: true };
    }
    const timeoutMs = Math.min(MAX_WAIT_MS, Math.max(100, Number(params.timeoutMs ?? 10_000)));
    return callContent(tabId, 'ext.page.wait', { ...params, timeoutMs }, timeoutMs + 5_000);
  },

  async 'ext.cursor.show'(params) {
    return callContent(requireTabId(params), 'ext.cursor.show', params);
  },
  async 'ext.cursor.hide'(params) {
    return callContent(requireTabId(params), 'ext.cursor.hide', params);
  },
  async 'ext.cursor.move'(params) {
    return callContent(requireTabId(params), 'ext.cursor.move', params);
  },

  async 'ext.reload'() {
    // Answer first, then reload from disk. For an unpacked extension this picks up the newer files the
    // A.I.M. app installed during its own update; the worker reconnects to the hub on start.
    setTimeout(() => {
      try {
        chrome.runtime.reload();
      } catch (e) {
        console.warn('[aim] reload failed:', errorMessage(e));
      }
    }, 400);
    return { ok: true as const, version: EXTENSION_VERSION };
  },
};

hub.onRequest = async (req) => {
  const method = req.method as ExtMethod;
  const handler = handlers[method] as Handler<ExtMethod> | undefined;
  if (!handler || !method.startsWith('ext.')) throw new RpcError(RpcErrorCode.MethodNotFound, `Unknown method ${req.method}`);
  const params = (req.params ?? {}) as ExtParams<ExtMethod>;
  if (typeof params !== 'object') throw new RpcError(RpcErrorCode.InvalidParams, 'params must be an object.');
  try {
    return await handler(params);
  } catch (e) {
    if (e instanceof RpcError) throw e;
    throw new RpcError(RpcErrorCode.ToolFailed, errorMessage(e));
  }
};

// Sanity: every PAGE_METHOD must have a handler (compile-time via Handlers; runtime check for safety).
for (const m of PAGE_METHODS) if (!(m in handlers)) warn('missing handler for', m);

// ---------------------------------------------------------------------------------------------
// Browser events → ext.event
// ---------------------------------------------------------------------------------------------

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.status === undefined && change.title === undefined && change.url === undefined && change.audible === undefined) return;
  if (!hub.connected) return;
  emit({ type: 'tab.updated', tab: toTabInfo({ ...tab, id: tabId }) });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabHistory.delete(tabId);
  if (aimTabs.delete(tabId)) void persistAimTabs();
  emit({ type: 'tab.removed', tabId });
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  emit({ type: 'tab.activated', tabId, windowId });
});

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  recordNavigation(details.tabId, details.url);
  emit({ type: 'page.navigated', tabId: details.tabId, url: details.url });
});

const activityThrottle = new KeyedThrottle(2_000);

// ---------------------------------------------------------------------------------------------
// Internal messages (content script + popup)
// ---------------------------------------------------------------------------------------------

async function statusReport(): Promise<StatusReport> {
  const cfg = await readConfig();
  await loadAimTabs();
  return {
    state: hub.state,
    reason: hub.reason,
    port: cfg.port,
    hasToken: !!cfg.token,
    browser: BROWSER.name,
    browserVersion: BROWSER.version,
    extensionVersion: EXTENSION_VERSION,
    aimTabCount: aimTabs.size,
    hubVersion: hub.hubVersion,
    lastConnectedAt: hub.lastConnectedAt,
  };
}

async function testConnection(): Promise<TestResult> {
  if (hub.connected) {
    try {
      await hub.request('hub.ping', {}, 4_000);
      return { ok: true, message: `Connected to A.I.M.${hub.hubVersion ? ` (hub version ${hub.hubVersion})` : ''}. Round trip succeeded.` };
    } catch (e) {
      if (e instanceof RpcError) return { ok: true, message: 'Connected to A.I.M. (the hub does not answer pings, but the link is open).' };
      return { ok: false, message: `Connected, but A.I.M. did not answer: ${errorMessage(e)}` };
    }
  }
  await hub.reconnectNow();
  if (hub.connected) return { ok: true, message: `Connected to A.I.M.${hub.hubVersion ? ` (hub version ${hub.hubVersion})` : ''}.` };
  return { ok: false, message: hub.reason };
}

async function closeAimTabs(): Promise<{ closed: number }> {
  await loadAimTabs();
  const ids = [...aimTabs];
  let closed = 0;
  for (const id of ids) {
    try {
      await chrome.tabs.remove(id);
      closed++;
    } catch {
      /* already gone */
    }
    aimTabs.delete(id);
  }
  await persistAimTabs();
  return { closed };
}

chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  const msg = raw as FromContentMessage | FromPopupMessage | undefined;
  if (!msg || typeof msg !== 'object' || typeof (msg as { kind?: unknown }).kind !== 'string') return false;
  const respond = (p: Promise<unknown>) => {
    p.then(
      (v) => sendResponse({ ok: true, result: v }),
      (e) => sendResponse({ ok: false, message: errorMessage(e) }),
    );
    return true;
  };
  switch (msg.kind) {
    case 'aim.activity': {
      const tabId = sender.tab?.id;
      if (tabId === undefined || !activityThrottle.allow(`${tabId}:${msg.activity}`)) return false;
      emit({ type: 'user.activity', tabId, url: msg.url || sender.tab?.url || '', title: msg.title || sender.tab?.title || '', kind: msg.activity });
      return false;
    }
    case 'aim.blocked': {
      const tabId = sender.tab?.id;
      if (tabId !== undefined) emit({ type: 'policy.blocked', tabId, reason: msg.reason });
      return false;
    }
    case 'popup.status':
      return respond(statusReport());
    case 'popup.save': {
      const port = normalizePort(msg.port, HUB_DEFAULT_PORT);
      const token = typeof msg.token === 'string' ? msg.token.trim() : '';
      return respond(
        chrome.storage.local
          .set({ [STORAGE_KEYS.port]: port, [STORAGE_KEYS.token]: token })
          .then(() => hub.reconnectNow())
          .then(() => statusReport()),
      );
    }
    case 'popup.test':
      return respond(testConnection());
    case 'popup.closeAimTabs':
      return respond(closeAimTabs());
    default:
      return false;
  }
});

// Reconnect when the popup changes the port or token (also catches edits from another window).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (STORAGE_KEYS.port in changes || STORAGE_KEYS.token in changes) {
    log('configuration changed; reconnecting');
    void hub.reconnectNow();
  }
});

// ---------------------------------------------------------------------------------------------
// Lifecycle & keepalive
// ---------------------------------------------------------------------------------------------

function ensureAlarm(): void {
  chrome.alarms.get(ALARM_NAME).then(
    (existing) => {
      if (!existing) void chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MIN });
    },
    () => void chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MIN }),
  );
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  if (hub.connected) void hub.ping();
  else void hub.connect();
});

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  void hub.connect();
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  void hub.connect();
});

// Long-lived ports from pages/popup keep the worker alive a little longer while they are open.
chrome.runtime.onConnect.addListener((port) => {
  port.onDisconnect.addListener(() => {
    /* nothing to clean up */
  });
});

// Every wake-up of the worker (including after idle suspension) re-establishes the link.
ensureAlarm();
void loadAimTabs();
void hub.connect();

// Exposed for diagnostics (service-worker console / e2e harness).
(globalThis as unknown as { __aim: unknown }).__aim = { hub, handlers, aimTabs, BROWSER };

/**
 * Extension protocol — between the Hub (Electron main) and the A.I.M. browser extension
 * (MV3 service worker). Same JSON-RPC envelope. The Hub is the WebSocket SERVER; the
 * extension connects to ws://127.0.0.1:<port>/aim/ext and sends `hub.hello` first.
 *
 * Direction Hub → Extension: requests below (`ext.*`). Extension → Hub: `hub.hello`,
 * `ext.event` notifications, and responses.
 */

export interface ExtTabInfo {
  tabId: number;
  windowId: number;
  index: number;
  title: string;
  url: string;
  active: boolean;
  audible?: boolean;
  status?: 'loading' | 'complete' | string;
  /** True when AIM opened this tab (tracked by the extension). */
  openedByAim?: boolean;
  /** True when the tab sits in the browser's "A.I.M." tab group. */
  inAimGroup?: boolean;
  /** Browser tab group id, when the tab is in any group. */
  groupId?: number;
}

/** Tabs A.I.M. opens are collected in a browser tab group with this title and colour. */
export const AIM_TAB_GROUP_TITLE = 'A.I.M.';
export const AIM_TAB_GROUP_COLOR = 'cyan';

export interface ExtSnapshotElement {
  ref: string; // "e12" — stable for the lifetime of the page
  role: string; // button, link, textbox, checkbox, combobox, heading, ...
  name: string; // accessible name / label / text
  value?: string;
  href?: string;
  tag: string;
  visible: boolean;
  disabled?: boolean;
  checked?: boolean;
  /** Viewport-relative bounding box (CSS px). */
  box?: { x: number; y: number; width: number; height: number };
  /** Heading level or input type etc. */
  extra?: Record<string, string | number | boolean>;
}

export interface ExtSnapshot {
  url: string;
  title: string;
  viewport: { width: number; height: number; scrollX: number; scrollY: number; pageHeight: number };
  elements: ExtSnapshotElement[];
  /** Visible text content, lightly structured, when includeText. */
  text?: string;
  truncated?: boolean;
}

export interface ExtTarget { ref?: string; selector?: string }

export type ExtMethodMap = {
  'ext.status': { params: Record<string, never>; result: { browser: string; version: string; extensionVersion: string; windows: number; tabs: number } };
  'ext.tabs.list': { params: Record<string, never>; result: { tabs: ExtTabInfo[] } };
  'ext.tabs.create': { params: { url: string; active?: boolean; windowId?: number }; result: { tab: ExtTabInfo } };
  'ext.tabs.navigate': { params: { tabId: number; url: string; waitForLoad?: boolean }; result: { tab: ExtTabInfo } };
  'ext.tabs.close': { params: { tabId: number }; result: { ok: true } };
  'ext.tabs.activate': { params: { tabId: number }; result: { tab: ExtTabInfo } };
  'ext.page.snapshot': { params: { tabId: number; maxElements?: number; includeText?: boolean; filter?: string }; result: ExtSnapshot };
  'ext.page.click': { params: { tabId: number; target: ExtTarget; button?: 'left' | 'right' | 'middle'; double?: boolean }; result: { ok: true; navigated?: boolean } };
  'ext.page.type': { params: { tabId: number; target?: ExtTarget; text: string; append?: boolean; pressEnter?: boolean }; result: { ok: true } };
  'ext.page.select': { params: { tabId: number; target: ExtTarget; value: string }; result: { ok: true; selected: string } };
  'ext.page.pressKey': { params: { tabId: number; key: string }; result: { ok: true } };
  'ext.page.scroll': { params: { tabId: number; target?: ExtTarget; deltaY?: number; intoView?: boolean }; result: { ok: true; scrollY: number } };
  'ext.page.read': { params: { tabId: number; target?: ExtTarget; includeLinks?: boolean; maxChars?: number }; result: { title: string; url: string; text: string; links?: { text: string; href: string }[]; truncated?: boolean } };
  'ext.page.screenshot': { params: { tabId: number }; result: { mediaType: string; dataBase64: string } };
  'ext.page.evaluate': { params: { tabId: number; code: string }; result: { value: unknown } };
  'ext.page.wait': { params: { tabId: number; selector?: string; text?: string; timeoutMs?: number; ms?: number }; result: { ok: true; matched?: string } };
  /** Teal AIM cursor overlay in the page (content script). Visible only when the tab is visible. */
  'ext.cursor.show': { params: { tabId: number; x?: number; y?: number }; result: { ok: true } };
  'ext.cursor.hide': { params: { tabId: number }; result: { ok: true } };
  'ext.cursor.move': { params: { tabId: number; x: number; y: number; durationMs?: number }; result: { ok: true } };
  /** Reload the extension from disk (sent by the app when it ships a newer extension than the one running). */
  'ext.reload': { params: { reason?: string }; result: { ok: true; version: string } };
};

export type ExtMethod = keyof ExtMethodMap;
export type ExtParams<M extends ExtMethod> = ExtMethodMap[M]['params'];
export type ExtResult<M extends ExtMethod> = ExtMethodMap[M]['result'];

/** Extension → Hub notifications. */
export type ExtEvent =
  | { type: 'tab.updated'; tab: ExtTabInfo }
  | { type: 'tab.removed'; tabId: number }
  | { type: 'tab.activated'; tabId: number; windowId: number }
  | { type: 'page.navigated'; tabId: number; url: string }
  | { type: 'policy.blocked'; tabId: number; reason: string } // extension-side payment guard fired
  | { type: 'user.activity'; tabId: number; url: string; title: string; kind: 'focus' | 'blur' | 'visit' }; // behaviour observer input

export const EXT_EVENT_METHOD = 'ext.event';
export const EXT_DEFAULT_RECONNECT_MS = 2_000;
export const EXT_MAX_RECONNECT_MS = 30_000;

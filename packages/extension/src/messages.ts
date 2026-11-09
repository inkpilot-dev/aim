/**
 * Internal messages between the extension's own parts (background ⇄ content script ⇄ popup).
 * These never leave the browser. The Hub protocol itself is in @aim/shared/extension.ts.
 */
import type { ExtMethod, ExtParams, ExtResult } from '@aim/shared';

/** Methods the content script implements (everything `ext.page.*` except screenshot/evaluate, plus cursor). */
export type PageMethod =
  | 'ext.page.snapshot'
  | 'ext.page.click'
  | 'ext.page.type'
  | 'ext.page.select'
  | 'ext.page.pressKey'
  | 'ext.page.scroll'
  | 'ext.page.read'
  | 'ext.page.wait'
  | 'ext.cursor.show'
  | 'ext.cursor.hide'
  | 'ext.cursor.move';

export const PAGE_METHODS: ReadonlySet<string> = new Set<PageMethod>([
  'ext.page.snapshot',
  'ext.page.click',
  'ext.page.type',
  'ext.page.select',
  'ext.page.pressKey',
  'ext.page.scroll',
  'ext.page.read',
  'ext.page.wait',
  'ext.cursor.show',
  'ext.cursor.hide',
  'ext.cursor.move',
]);

/** Background → content. */
export type ToContentMessage =
  | { kind: 'aim.ping' }
  | { kind: 'aim.page'; method: PageMethod; params: ExtParams<PageMethod> };

/** Content → background. */
export type FromContentMessage =
  | { kind: 'aim.activity'; activity: 'focus' | 'blur' | 'visit'; url: string; title: string }
  | { kind: 'aim.blocked'; reason: string };

/** Popup → background. */
export type FromPopupMessage =
  | { kind: 'popup.status' }
  | { kind: 'popup.save'; port: number; token: string }
  | { kind: 'popup.test' }
  | { kind: 'popup.closeAimTabs' };

export type ContentResponse<M extends ExtMethod = ExtMethod> =
  | { ok: true; result: ExtResult<M> }
  | { ok: false; code: number; message: string; data?: unknown };

export type ConnectionState = 'disconnected' | 'connecting' | 'connected';

export interface StatusReport {
  state: ConnectionState;
  /** Why we are disconnected (formal, user-facing). */
  reason?: string;
  port: number;
  hasToken: boolean;
  browser: string;
  browserVersion: string;
  extensionVersion: string;
  aimTabCount: number;
  hubVersion?: string;
  lastConnectedAt?: number;
}

export interface TestResult { ok: boolean; message: string }

/** Keys in chrome.storage.local. */
export const STORAGE_KEYS = {
  port: 'hubPort',
  token: 'hubToken',
} as const;

/** Keys in chrome.storage.session. */
export const SESSION_KEYS = {
  aimTabs: 'aimTabIds',
} as const;

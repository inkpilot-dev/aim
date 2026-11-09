/**
 * PaymentGuard integration for the Hub. Pure (no Electron) so it is unit-testable.
 * The extension applies the same checks again in the page; this is the first line.
 */
import {
  PAYMENT_BLOCK_MESSAGE,
  RpcErrorCode,
  containsCardNumber,
  guardClick,
  guardNavigate,
  guardType,
  isPaymentAction,
  isPaymentUrl,
  type GuardVerdict,
  type ToolResult,
} from '@aim/shared';

export interface ClickTargetInfo {
  /** Accessible name / label of the element the ref points to. */
  label?: string;
  /** Page URL of the tab. */
  url?: string;
  field?: { name?: string; id?: string; autocomplete?: string; placeholder?: string; label?: string; type?: string };
}

export interface PolicyContext {
  /** Best-effort lookup of a snapshot element by tab + ref/selector (from the last browser_snapshot). */
  lookupTarget?: (tabId: number, target: { ref?: string; selector?: string }) => Promise<ClickTargetInfo | null> | ClickTargetInfo | null;
  /** Best-effort: current URL of a tab. */
  tabUrl?: (tabId: number) => Promise<string | undefined> | string | undefined;
}

const CC_FIELD_IN_CODE = /cc-number|cardnumber|card-number|card_number|cvv|cvc|creditcard|credit-card|securitycode|expiry|exp-date/i;
const SUBMIT_IN_CODE = /\.submit\s*\(|requestSubmit\s*\(|\.click\s*\(|dispatchEvent\s*\(|fetch\s*\(|XMLHttpRequest|sendBeacon/i;

/** Heuristic guard for browser_evaluate code. */
export function guardEvaluate(code: string, pageUrl?: string): GuardVerdict {
  if (!code) return { blocked: false };
  const urls = code.match(/https?:\/\/[^\s'"`)]+/gi) ?? [];
  for (const u of urls) {
    const v = isPaymentUrl(u);
    if (v.blocked) return { ...v, reason: `Script references a payment URL: ${v.reason}` };
  }
  if (CC_FIELD_IN_CODE.test(code) && /\.value\s*=|setAttribute\s*\(\s*['"]value|\.submit\s*\(/i.test(code)) {
    return { blocked: true, signal: 'payment_field', reason: 'Script writes to or submits a payment card field' };
  }
  if (pageUrl && isPaymentUrl(pageUrl).blocked && SUBMIT_IN_CODE.test(code)) {
    return { blocked: true, signal: 'payment_action', reason: 'Script would submit or click on a payment page' };
  }
  const quoted = code.match(/['"`]([^'"`]{3,80})['"`]/g) ?? [];
  for (const q of quoted) {
    const label = q.slice(1, -1);
    if (SUBMIT_IN_CODE.test(code) && isPaymentAction(label).blocked) {
      return { blocked: true, signal: 'payment_action', reason: `Script targets a payment action ("${label.slice(0, 40)}")` };
    }
  }
  return { blocked: false };
}

/** Run the policy for a tool call. Returns a verdict; `blocked:false` means proceed. */
export async function checkPolicy(name: string, args: Record<string, unknown>, ctx: PolicyContext = {}): Promise<GuardVerdict> {
  try {
    switch (name) {
      case 'browser_navigate': {
        const url = String(args['url'] ?? '');
        if (/^(back|forward|reload)$/i.test(url)) return { blocked: false };
        return guardNavigate(url);
      }
      case 'browser_open_tab':
        return guardNavigate(String(args['url'] ?? ''));
      case 'browser_click': {
        const tabId = Number(args['tabId']);
        const target = { ref: args['ref'] as string | undefined, selector: args['selector'] as string | undefined };
        const info = (await ctx.lookupTarget?.(tabId, target)) ?? null;
        const url = info?.url ?? (await ctx.tabUrl?.(tabId));
        return guardClick({ url, label: info?.label, field: info?.field });
      }
      case 'browser_type': {
        const tabId = Number(args['tabId']);
        const target = { ref: args['ref'] as string | undefined, selector: args['selector'] as string | undefined };
        const info = target.ref || target.selector ? ((await ctx.lookupTarget?.(tabId, target)) ?? null) : null;
        const url = info?.url ?? (await ctx.tabUrl?.(tabId));
        return guardType({ url, text: String(args['text'] ?? ''), field: info?.field });
      }
      case 'browser_select': {
        const tabId = Number(args['tabId']);
        const url = await ctx.tabUrl?.(tabId);
        const u = isPaymentUrl(url ?? '');
        return u.blocked ? { ...u, reason: `Refusing to act on a payment page: ${u.reason}` } : { blocked: false };
      }
      case 'keyboard_type':
        return containsCardNumber(String(args['text'] ?? ''));
      case 'clipboard':
        return args['action'] === 'write' ? containsCardNumber(String(args['text'] ?? '')) : { blocked: false };
      case 'browser_evaluate': {
        const tabId = Number(args['tabId']);
        const url = await ctx.tabUrl?.(tabId);
        return guardEvaluate(String(args['code'] ?? ''), url);
      }
      default:
        return { blocked: false };
    }
  } catch (err) {
    // A failing lookup must never disable the guard for the strong signals; be conservative only on strong ones.
    if (name === 'keyboard_type') return containsCardNumber(String(args['text'] ?? ''));
    if (name === 'browser_type') return guardType({ text: String(args['text'] ?? '') });
    if (name === 'browser_navigate' || name === 'browser_open_tab') return guardNavigate(String(args['url'] ?? ''));
    return { blocked: false, reason: `policy lookup failed: ${(err as Error).message}` };
  }
}

export function blockedResult(verdict: GuardVerdict): ToolResult {
  return {
    ok: false,
    errorCode: RpcErrorCode.PolicyBlocked,
    error: `${PAYMENT_BLOCK_MESSAGE}${verdict.reason ? ` Reason: ${verdict.reason}.` : ''}`,
    data: { blocked: true, signal: verdict.signal, reason: verdict.reason },
  };
}

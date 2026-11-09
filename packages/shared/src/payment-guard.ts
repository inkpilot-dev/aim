/**
 * Payment guard — the ONE hard limit. Pure functions so both the Hub (Node) and the extension
 * (browser) can run the same checks. AIM may browse shops, compare prices, fill carts; it must
 * never complete a purchase, enter card details, or confirm a payment.
 */

export interface GuardVerdict {
  blocked: boolean;
  reason?: string;
  /** Which signal fired. */
  signal?: 'url' | 'card_number' | 'payment_field' | 'payment_action' | 'cvv' | 'crypto';
}

const PAYMENT_URL_PATTERNS: RegExp[] = [
  /\/checkout(\/|\?|#|$)/i,
  /\/payments?(\/|\?|#|$)/i,
  /\/pay(\/|\?|#|$)/i,
  /\/billing(\/|\?|#|$)/i,
  /\/purchase(\/|\?|#|$)/i,
  /\/buy(\/|\?|#|$)/i,
  /\/order\/(confirm|review|place|submit)/i,
  /\/place-?order/i,
  /\/subscribe(\/|\?|$)/i,
  /\/upgrade(\/|\?|$)/i,
  /\/donate(\/|\?|$)/i,
  /\/cart\/checkout/i,
  /(^|\.)pay\.google\.com/i,
  /(^|\.)paypal\.com\/(checkoutnow|webapps\/hermes|signin\?.*checkout)/i,
  /(^|\.)checkout\.stripe\.com/i,
  /(^|\.)buy\.stripe\.com/i,
  /(^|\.)checkout\.shopify\.com/i,
  /(^|\.)pay\.amazon\./i,
  /(^|\.)secure\.checkout/i,
  /(^|\.)klarna\.com\/(checkout|pay)/i,
  /(^|\.)afterpay\.com\/checkout/i,
  /(^|\.)venmo\.com\/(pay|checkout)/i,
  /(^|\.)cash\.app\/pay/i,
  /(^|\.)roblox\.com\/(upgrades|robux|premium|payment)/i,
  /(^|\.)store\.steampowered\.com\/(checkout|cart\/checkout)/i,
  /(^|\.)apple\.com\/shop\/(checkout|bag)/i,
  /(^|\.)microsoft\.com\/.*\/(checkout|cart)/i,
];

/** Actions (button labels) that complete a payment. Case-insensitive, whole-ish words. */
const PAYMENT_ACTION_PATTERNS: RegExp[] = [
  /\b(place|submit|complete|confirm)\s+(your\s+|my\s+|the\s+)?(order|purchase|payment)\b/i,
  /\bpay\s*(now|\$|€|£|[0-9])/i,
  /\bbuy\s*(now|it\s*now|with\s+1[- ]click)\b/i,
  /\b1[- ]click\b.*\b(buy|order)\b/i,
  /\bcheck\s*out\s*(now|securely)?$/i,
  /\bproceed\s+to\s+(checkout|payment)\b/i,
  /\bconfirm\s+(and\s+)?pay\b/i,
  /\bsubscribe\s*(now|&\s*pay)?$/i,
  /\bstart\s+(free\s+)?trial\b/i,
  /\bupgrade\s+(now|plan)\b/i,
  /\bdonate\s*(now|\$)/i,
  /\bpurchase\b/i,
  /\bbuy\s+robux\b/i,
  /\bget\s+premium\b/i,
  /\badd\s+payment\s+method\b/i,
  /\bsave\s+card\b/i,
];

const CARD_FIELD_PATTERNS: RegExp[] = [
  /cc-number|cc-exp|cc-csc|cc-name|cardnumber|card-number|card_number|creditcard|credit-card|cardcvc|cvv|cvc|securitycode|security-code|expiry|exp-date|expdate/i,
  /\b(iban|routing[-_ ]?number|account[-_ ]?number)\b/i,
];

const SAFE_HOST_PATTERNS: RegExp[] = [/(^|\.)wikipedia\.org$/i, /(^|\.)wiktionary\.org$/i, /(^|\.)github\.com$/i, /(^|\.)stackoverflow\.com$/i, /(^|\.)developer\.mozilla\.org$/i, /(^|\.)docs\.stripe\.com$/i, /(^|\.)developer\.paypal\.com$/i, /^(www\.)?google\.com$/i, /^(www\.)?bing\.com$/i, /^(www\.)?duckduckgo\.com$/i];

export function isPaymentUrl(url: string): GuardVerdict {
  if (!url) return { blocked: false };
  let host = '';
  try {
    host = new URL(url.includes('://') ? url : `https://${url}`).hostname;
  } catch {
    host = '';
  }
  if (host && SAFE_HOST_PATTERNS.some((re) => re.test(host))) return { blocked: false };
  // Host-anchored patterns are tested against the bare hostname as well as the full URL, so
  // "https://pay.google.com/" (no "www." prefix) is caught just like "https://www.pay.google.com/".
  for (const re of PAYMENT_URL_PATTERNS) {
    if (re.test(url) || (host && re.test(host))) return { blocked: true, reason: `URL looks like a payment/checkout page (${re.source})`, signal: 'url' };
  }
  return { blocked: false };
}

/** Luhn check on a digit string. */
export function luhnValid(digits: string): boolean {
  if (!/^\d{12,19}$/.test(digits)) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/** Does text contain something that looks like a real card number? */
export function containsCardNumber(text: string): GuardVerdict {
  if (!text) return { blocked: false };
  const candidates = text.match(/(?:\d[ -]?){12,19}/g) ?? [];
  for (const c of candidates) {
    const digits = c.replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) {
      return { blocked: true, reason: 'Text contains what looks like a payment card number', signal: 'card_number' };
    }
  }
  // 3–4 digit CVV typed into something explicitly named cvv is caught by field checks; here only numbers.
  return { blocked: false };
}

/** Field metadata (name/id/autocomplete/placeholder/label) that identifies a payment input. */
export function isPaymentField(meta: { name?: string; id?: string; autocomplete?: string; placeholder?: string; label?: string; type?: string }): GuardVerdict {
  const hay = [meta.name, meta.id, meta.autocomplete, meta.placeholder, meta.label].filter(Boolean).join(' ');
  for (const re of CARD_FIELD_PATTERNS) {
    if (re.test(hay)) return { blocked: true, reason: `Input looks like a payment field (${hay.slice(0, 60)})`, signal: 'payment_field' };
  }
  return { blocked: false };
}

/** Button / link text that would complete a payment. */
export function isPaymentAction(label: string): GuardVerdict {
  if (!label) return { blocked: false };
  const l = label.trim().replace(/\s+/g, ' ');
  if (l.length > 80) return { blocked: false }; // long paragraphs are not buttons
  for (const re of PAYMENT_ACTION_PATTERNS) {
    if (re.test(l)) return { blocked: true, reason: `Action "${l.slice(0, 50)}" would complete a payment`, signal: 'payment_action' };
  }
  return { blocked: false };
}

/** Combined check for a click target. */
export function guardClick(opts: { url?: string; label?: string; field?: Parameters<typeof isPaymentField>[0] }): GuardVerdict {
  const a = isPaymentAction(opts.label ?? '');
  if (a.blocked) return a;
  if (opts.field) {
    const f = isPaymentField(opts.field);
    if (f.blocked) return f;
  }
  // Clicking around a payment URL is allowed (to read), but any action on a checkout URL is not.
  const u = isPaymentUrl(opts.url ?? '');
  if (u.blocked && opts.label) return { ...u, reason: `Refusing to act on a payment page: ${u.reason}` };
  return { blocked: false };
}

/** Combined check for typing. */
export function guardType(opts: { url?: string; text: string; field?: Parameters<typeof isPaymentField>[0] }): GuardVerdict {
  const c = containsCardNumber(opts.text);
  if (c.blocked) return c;
  if (opts.field) {
    const f = isPaymentField(opts.field);
    if (f.blocked) return f;
  }
  const u = isPaymentUrl(opts.url ?? '');
  if (u.blocked) return { ...u, reason: `Refusing to type on a payment page: ${u.reason}` };
  return { blocked: false };
}

/** Navigation check: we block navigating INTO checkout/payment flows. */
export function guardNavigate(url: string): GuardVerdict {
  return isPaymentUrl(url);
}

export const PAYMENT_BLOCK_MESSAGE =
  'Blocked by A.I.M. policy: payments and purchases are never performed automatically. I can take you to the point before payment and hand over.';

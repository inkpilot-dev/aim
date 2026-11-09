import { describe, it, expect } from 'vitest';
import { isPaymentUrl, containsCardNumber, isPaymentAction, isPaymentField, guardClick, guardType, luhnValid } from '../payment-guard.js';
import { computeProgress } from '../chat.js';

describe('payment guard', () => {
  it('blocks checkout URLs', () => {
    expect(isPaymentUrl('https://shop.example.com/checkout').blocked).toBe(true);
    expect(isPaymentUrl('https://checkout.stripe.com/c/pay/cs_test').blocked).toBe(true);
    expect(isPaymentUrl('https://www.roblox.com/upgrades/robux').blocked).toBe(true);
    expect(isPaymentUrl('https://pay.google.com/').blocked).toBe(true);
    expect(isPaymentUrl('https://checkout.shopify.com/12345/checkouts/abc').blocked).toBe(true);
    expect(isPaymentUrl('https://www.amazon.com/dp/B000').blocked).toBe(false);
    expect(isPaymentUrl('https://en.wikipedia.org/wiki/Payment').blocked).toBe(false);
  });
  it('detects card numbers via Luhn', () => {
    expect(luhnValid('4242424242424242')).toBe(true);
    expect(luhnValid('4242424242424241')).toBe(false);
    expect(containsCardNumber('my card is 4242 4242 4242 4242 thanks').blocked).toBe(true);
    expect(containsCardNumber('call me at 555 123 4567').blocked).toBe(false);
    expect(containsCardNumber('order id 1234567890123').blocked).toBe(false);
  });
  it('detects payment actions', () => {
    expect(isPaymentAction('Place your order').blocked).toBe(true);
    expect(isPaymentAction('Pay now').blocked).toBe(true);
    expect(isPaymentAction('Buy Robux').blocked).toBe(true);
    expect(isPaymentAction('Add to cart').blocked).toBe(false);
    expect(isPaymentAction('Search').blocked).toBe(false);
  });
  it('detects payment fields', () => {
    expect(isPaymentField({ autocomplete: 'cc-number' }).blocked).toBe(true);
    expect(isPaymentField({ name: 'cvv' }).blocked).toBe(true);
    expect(isPaymentField({ name: 'email' }).blocked).toBe(false);
  });
  it('combined guards', () => {
    expect(guardClick({ url: 'https://x.com/checkout', label: 'Continue' }).blocked).toBe(true);
    expect(guardClick({ url: 'https://x.com/cart', label: 'Continue' }).blocked).toBe(false);
    expect(guardType({ url: 'https://x.com/search', text: 'hello' }).blocked).toBe(false);
    expect(guardType({ url: 'https://x.com/search', text: '4242424242424242' }).blocked).toBe(true);
  });
});

describe('progress', () => {
  it('computes ratio and label', () => {
    const now = Date.now();
    const mk = (title: string, state: 'pending' | 'in_progress' | 'done' | 'failed' | 'skipped', order: number) => ({ id: String(order), chatId: 'c', title, state, order, createdAt: now, updatedAt: now });
    const p = computeProgress([mk('a', 'done', 0), mk('b', 'in_progress', 1), mk('c', 'pending', 2), mk('d', 'pending', 3)]);
    expect(p.total).toBe(4);
    expect(p.done).toBe(1);
    expect(p.ratio).toBeCloseTo(0.375);
    expect(p.label).toBe('1 / 4 — b');
    expect(computeProgress([]).ratio).toBe(0);
  });
});

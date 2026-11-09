import { describe, expect, it } from 'vitest';
import { formatDayLabel, formatDuration, formatDurationShort, formatHours, formatRelative, formatTokens, parseIsoDate, toIsoDate, truncate } from './format';

describe('format', () => {
  it('formats durations', () => {
    expect(formatDuration(420)).toBe('420 ms');
    expect(formatDuration(3200)).toBe('3.2 s');
    expect(formatDuration(45_000)).toBe('45 s');
    expect(formatDuration(125_000)).toBe('2 min 5 s');
    expect(formatDuration(2 * 3_600_000)).toBe('2 h');
    expect(formatDuration(undefined)).toBe('');
    expect(formatDuration(-5)).toBe('');
  });

  it('formats short durations', () => {
    expect(formatDurationShort(830)).toBe('830ms');
    expect(formatDurationShort(5020)).toBe('5.0s');
    expect(formatDurationShort(84_000)).toBe('1m 24s');
  });

  it('round-trips iso dates in local time', () => {
    const d = new Date(2026, 0, 5, 23, 59).getTime();
    expect(toIsoDate(d)).toBe('2026-01-05');
    expect(parseIsoDate('2026-01-05').getDate()).toBe(5);
  });

  it('labels today and yesterday', () => {
    const now = new Date(2026, 10, 9, 10).getTime();
    expect(formatDayLabel('2026-11-09', now)).toBe('Today');
    expect(formatDayLabel('2026-11-08', now)).toBe('Yesterday');
    expect(formatDayLabel('2026-11-01', now)).not.toMatch(/Today|Yesterday/);
  });

  it('formats relative times', () => {
    const now = 10_000_000_000;
    expect(formatRelative(now - 10_000, now)).toBe('just now');
    expect(formatRelative(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(formatRelative(now - 3 * 3_600_000, now)).toBe('3 h ago');
    expect(formatRelative(now - 24 * 3_600_000, now)).toBe('yesterday');
    expect(formatRelative(now - 3 * 24 * 3_600_000, now)).toBe('3 days ago');
  });

  it('formats hours, tokens and truncation', () => {
    expect(formatHours(30 * 60_000)).toBe('30 min');
    expect(formatHours(2.5 * 3_600_000)).toBe('2.5 h');
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(2130)).toBe('2.1k');
    expect(formatTokens(45_000)).toBe('45k');
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(truncate('abc', 4)).toBe('abc');
  });
});

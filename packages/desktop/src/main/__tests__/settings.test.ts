import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SETTINGS } from '@aim/shared';
import { SettingsStore } from '../settings.js';

const dirs: string[] = [];
function tmpFile(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-settings-'));
  dirs.push(d);
  return path.join(d, 'settings.json');
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('SettingsStore', () => {
  it('creates defaults with a generated token and persists them', () => {
    const file = tmpFile();
    const s = new SettingsStore(file);
    expect(s.get().hubPort).toBe(DEFAULT_SETTINGS.hubPort);
    expect(s.get().hubToken).toMatch(/^[0-9a-f]{48}$/);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(onDisk.hubToken).toBe(s.get().hubToken);
    const again = new SettingsStore(file);
    expect(again.get().hubToken).toBe(s.get().hubToken);
  });
  it('merges stored values over defaults, sanitises bad values and notifies listeners', () => {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify({ hubPort: 12, theme: 'neon', model: 'opus', paymentGuard: false }));
    const s = new SettingsStore(file);
    expect(s.get().hubPort).toBe(DEFAULT_SETTINGS.hubPort);
    expect(s.get().theme).toBe('dark');
    expect(s.get().model).toBe('opus');
    expect(s.get().paymentGuard).toBe(true);
    const seen: unknown[] = [];
    const off = s.onChange((_n, patch) => seen.push(patch));
    const next = s.update({ model: 'sonnet', paymentGuard: false as unknown as true });
    expect(next.model).toBe('sonnet');
    expect(next.paymentGuard).toBe(true);
    expect(seen).toEqual([{ model: 'sonnet' }]);
    off();
    s.update({ effort: 'high' });
    expect(seen.length).toBe(1);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).effort).toBe('high');
  });
  it('survives a corrupt file', () => {
    const file = tmpFile();
    fs.writeFileSync(file, '{not json');
    const s = new SettingsStore(file);
    expect(s.get().toggleShortcut).toBe(DEFAULT_SETTINGS.toggleShortcut);
  });
});

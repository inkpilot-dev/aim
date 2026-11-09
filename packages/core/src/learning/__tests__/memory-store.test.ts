import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../memory-store.js';
import { openTestDb, type TestDb } from './test-db.js';

describe('MemoryStore', () => {
  let db: TestDb;
  let now = 1_700_000_000_000;
  let store: MemoryStore;

  beforeEach(() => {
    db = openTestDb();
    now = 1_700_000_000_000;
    store = new MemoryStore(db, { now: () => now });
  });
  afterEach(() => db.close());

  it('upserts by key and reinforces on repeat', () => {
    const a = store.remember({ key: 'preferred_browser', value: 'Edge', kind: 'preference', confidence: 0.6, source: 'user' });
    expect(a.hits).toBe(1);
    expect(a.confidence).toBeCloseTo(0.6);
    now += 1000;
    const b = store.remember({ key: 'preferred_browser', value: 'Microsoft Edge', kind: 'preference' });
    expect(b.hits).toBe(2);
    expect(b.value).toBe('Microsoft Edge'); // newest value wins
    expect(b.confidence).toBeGreaterThan(a.confidence);
    expect(b.confidence).toBeLessThanOrEqual(1);
    expect(b.createdAt).toBe(a.createdAt);
    expect(b.updatedAt).toBe(now);
    expect(store.count()).toBe(1);
    expect(store.get('preferred_browser')?.hits).toBe(2);
  });

  it('caps confidence at 1 and normalizes unknown kinds', () => {
    store.remember({ key: 'k', value: 'v', kind: 'fact', confidence: 0.99 });
    const e = store.remember({ key: 'k', value: 'v', kind: 'nonsense' as never });
    expect(e.confidence).toBe(1);
    expect(e.kind).toBe('fact');
  });

  it('recalls by keyword ranked by relevance × confidence × recency', () => {
    store.remember({ key: 'roblox_account', value: 'The user plays Roblox in the evenings on roblox.com', kind: 'fact', confidence: 0.9 });
    store.remember({ key: 'inbox_rule', value: 'Prefers inbox zero; archive newsletters', kind: 'preference', confidence: 0.8 });
    store.remember({ key: 'old_roblox_note', value: 'Roblox update broke the launcher once', kind: 'lesson', confidence: 0.2, createdAt: now - 200 * 86_400_000 });
    // make the old one actually old
    db.prepare('UPDATE memories SET updated_at = ? WHERE key = ?').run(now - 200 * 86_400_000, 'old_roblox_note');

    const hits = store.recall('roblox');
    expect(hits.map((h) => h.key)).toEqual(['roblox_account', 'old_roblox_note']);
    expect(store.recall('inbox newsletters')[0]?.key).toBe('inbox_rule');
    expect(store.recall('zzzznothing')).toEqual([]);
    expect(store.recall('').length).toBe(3); // empty query → ranked list
  });

  it('forget, list and count', () => {
    store.remember({ key: 'a', value: 'alpha', kind: 'fact' });
    store.remember({ key: 'b', value: 'bravo', kind: 'fact' });
    expect(store.list().length).toBe(2);
    expect(store.forget('a')).toBe(true);
    expect(store.forget('a')).toBe(false);
    expect(store.count()).toBe(1);
    expect(store.recall('alpha')).toEqual([]);
    expect(store.recall('bravo').map((m) => m.key)).toEqual(['b']);
  });

  it('digest groups by kind, most useful first, and truncates', () => {
    store.remember({ key: 'pref_1', value: 'Likes dark mode', kind: 'preference' });
    store.remember({ key: 'fact_1', value: 'Works at Contoso', kind: 'fact' });
    store.remember({ key: 'fact_2', value: 'Uses a Surface laptop', kind: 'fact' });
    store.remember({ key: 'fact_2', value: 'Uses a Surface laptop', kind: 'fact' }); // reinforce → first in group
    const d = store.digest();
    expect(d).toContain('### Preferences');
    expect(d).toContain('### Facts');
    expect(d.indexOf('### Preferences')).toBeLessThan(d.indexOf('### Facts'));
    expect(d.indexOf('fact_2')).toBeLessThan(d.indexOf('fact_1'));
    expect(d).toContain('- **pref_1**: Likes dark mode');

    for (let i = 0; i < 200; i++) store.remember({ key: `bulk_${i}`, value: 'x'.repeat(80), kind: 'lesson' });
    const small = store.digest(1500);
    expect(small.length).toBeLessThanOrEqual(1500);
    expect(small).toMatch(/more memories/);
    expect(new MemoryStore(openTestDb()).digest()).toBe('');
  });
});

describe('test driver', () => {
  it('reports which sqlite driver backs the tests', () => {
    const db = openTestDb();
    process.stderr.write(`[learning tests] sqlite driver: ${db.driver}\n`);
    expect(['better-sqlite3', 'node:sqlite']).toContain(db.driver);
    if (process.env.AIM_SQLITE_NATIVE_BINDING) expect(db.driver).toBe('better-sqlite3');
    expect(new MemoryStore(db).ftsEnabled).toBe(true);
    db.close();
  });
});

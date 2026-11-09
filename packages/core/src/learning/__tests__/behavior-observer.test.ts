import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BehaviorObserver, hostOf } from '../behavior-observer.js';
import { openTestDb, type TestDb } from './test-db.js';

type Win = { app: string; title: string } | null;

describe('BehaviorObserver', () => {
  let db: TestDb;
  beforeEach(() => {
    db = openTestDb();
  });
  afterEach(() => db.close());

  /** Observer whose provider replays `windows` and whose clock is controlled by the test. */
  function makeObserver(windows: Win[], start: number, sampleMs = 5000) {
    let now = start;
    let i = 0;
    const provider = { getActiveWindow: async () => windows[Math.min(i++, windows.length - 1)] };
    const obs = new BehaviorObserver({ db, provider, sampleMs, now: () => now });
    return { obs, advance: (ms: number) => (now += ms) };
  }

  it('coalesces consecutive identical app+title samples into one row', async () => {
    const { obs, advance } = makeObserver(
      [
        { app: 'msedge.exe', title: 'Roblox' },
        { app: 'msedge.exe', title: 'Roblox' },
        { app: 'msedge.exe', title: 'Roblox' },
        { app: 'Code.exe', title: 'aim' },
        { app: 'msedge.exe', title: 'Roblox' },
      ],
      new Date(2026, 10, 9, 19, 0, 0).getTime(),
    );
    for (let k = 0; k < 5; k++) {
      await obs.tick();
      advance(5000);
    }
    expect(obs.sampleCount()).toBe(3);
    const rows = db.prepare('SELECT app, title, duration_ms FROM behavior_samples ORDER BY id').all() as { app: string; title: string; duration_ms: number }[];
    expect(rows[0]).toMatchObject({ app: 'msedge', title: 'Roblox', duration_ms: 15000 });
    expect(rows[1]).toMatchObject({ app: 'Code', duration_ms: 5000 });
  });

  it('skips idle periods and null windows', async () => {
    let idle = true;
    const obs = new BehaviorObserver({
      db,
      provider: { getActiveWindow: async () => ({ app: 'x', title: 'y' }), isIdle: async () => idle },
      sampleMs: 5000,
    });
    await obs.tick();
    expect(obs.sampleCount()).toBe(0);
    idle = false;
    await obs.tick();
    expect(obs.sampleCount()).toBe(1);
  });

  it('never throws when the provider fails', async () => {
    const obs = new BehaviorObserver({
      db,
      provider: {
        getActiveWindow: async () => {
          throw new Error('boom');
        },
      },
    });
    await expect(obs.tick()).resolves.toBeUndefined();
    expect(() => obs.recordBrowserActivity({ url: 'https://a.b', title: 't', kind: 'x' })).not.toThrow();
  });

  it('records browser activity with host and builds a summary (shares ≈ 1, routines present)', async () => {
    const base = new Date(2026, 10, 2, 19, 0, 0).getTime(); // Monday 19:00 local
    const seq: Win[] = [
      { app: 'msedge.exe', title: 'Roblox' },
      { app: 'msedge.exe', title: 'Roblox' },
      { app: 'msedge.exe', title: 'Roblox' },
      { app: 'Code.exe', title: 'aim' },
    ];
    for (let day = 0; day < 7; day++) {
      const { obs, advance } = makeObserver(seq, base + day * 86_400_000, 60_000);
      obs.recordBrowserActivity({ url: 'https://www.roblox.com/games', title: 'Roblox', kind: 'tab_activated' });
      for (let k = 0; k < 4; k++) {
        await obs.tick();
        advance(60_000);
      }
      obs.recordBrowserActivity({ url: 'https://github.com/aim', title: 'GitHub', kind: 'navigation' });
    }
    const end = base + 6 * 86_400_000 + 3 * 3_600_000;
    const reader = new BehaviorObserver({ db, provider: { getActiveWindow: async () => null }, now: () => end });
    const s = reader.summary(7);

    expect(s.totalActiveMs).toBeGreaterThan(0);
    expect(s.topApps.reduce((a, b) => a + b.share, 0)).toBeCloseTo(1, 5);
    expect(s.topSites.reduce((a, b) => a + b.share, 0)).toBeCloseTo(1, 5);
    expect(s.topApps[0].app).toBe('msedge');
    expect(s.topSites[0].host).toBe('roblox.com');
    expect(s.topSites.map((x) => x.host)).toContain('github.com');
    expect(s.activeHours).toHaveLength(24);
    expect(s.activeHours[19]).toBeGreaterThan(0);
    expect(s.routines.length).toBeGreaterThan(0);
    const text = s.routines.join('\n');
    expect(text).toMatch(/Usually active 19:00/);
    expect(text).toMatch(/Most used app: msedge \(75%\)/);
    expect(text).toMatch(/Opens msedge → roblox\.com most evenings/);
    expect(s.lastSeen?.url).toBe('https://github.com/aim');

    const digest = reader.digest();
    expect(digest.length).toBeGreaterThan(0);
    expect(digest.length).toBeLessThanOrEqual(1200);
    expect(digest).toContain('roblox.com');
    expect(digest).toContain('Routines:');
  });

  it('returns an empty summary and digest without data', () => {
    const obs = new BehaviorObserver({ db, provider: { getActiveWindow: async () => null } });
    const s = obs.summary();
    expect(s.totalActiveMs).toBe(0);
    expect(s.routines).toEqual([]);
    expect(obs.digest()).toBe('');
  });

  it('prunes old samples on start and stops cleanly', () => {
    const now = Date.now();
    db.prepare('INSERT INTO behavior_samples (ts, app, title, duration_ms) VALUES (?, ?, ?, ?)').run(now - 100 * 86_400_000, 'old', '', 1000);
    db.prepare('INSERT INTO behavior_samples (ts, app, title, duration_ms) VALUES (?, ?, ?, ?)').run(now - 1000, 'new', '', 1000);
    const obs = new BehaviorObserver({ db, provider: { getActiveWindow: async () => null }, sampleMs: 60_000 });
    obs.start();
    expect(obs.running).toBe(true);
    obs.start(); // idempotent
    expect(obs.sampleCount()).toBe(1);
    obs.stop();
    expect(obs.running).toBe(false);
  });

  it('hostOf strips www and rejects non-http urls', () => {
    expect(hostOf('https://www.Roblox.com/x')).toBe('roblox.com');
    expect(hostOf('chrome://newtab')).toBe('');
    expect(hostOf('not a url')).toBe('');
  });
});

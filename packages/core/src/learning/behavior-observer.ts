import type { BehaviorSample, BehaviorSummary } from '@aim/shared';
import { OBSERVER_SAMPLE_MS } from '@aim/shared';
import type { ActiveWindowProvider, LoggerLike, SqliteDb } from './deps.js';
import { errorMessage, scopedLogger } from './deps.js';

interface SampleRow {
  id: number;
  ts: number;
  app: string;
  title: string;
  url: string | null;
  host: string | null;
  duration_ms: number;
  idle: number;
}

export interface BehaviorObserverOptions {
  db: SqliteDb;
  provider: ActiveWindowProvider;
  /** Sampling interval in ms (default OBSERVER_SAMPLE_MS). */
  sampleMs?: number;
  log?: LoggerLike;
  /** Samples older than this are deleted on start() (default 90). */
  pruneDays?: number;
  /** Injectable clock (tests). */
  now?: () => number;
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** Longest span a single browser row may represent without a fresh event. */
const MAX_BROWSER_SPAN_MS = 15 * 60_000;
const BROWSER_APPS = new Set(['msedge', 'chrome', 'firefox', 'brave', 'opera', 'safari', 'vivaldi', 'arc', 'chromium', 'edge']);
const TOP_N = 8;

interface OpenSpan {
  id: number;
  app: string;
  title: string;
  ts: number;
}
interface BrowserSpan extends OpenSpan {
  host: string;
}

/**
 * Samples the active window and browser activity into `behavior_samples` and derives a
 * {@link BehaviorSummary} (top apps/sites, active hours, natural-language routines).
 */
export class BehaviorObserver {
  private readonly db: SqliteDb;
  private readonly provider: ActiveWindowProvider;
  private readonly sampleMs: number;
  private readonly pruneDays: number;
  private readonly log: LoggerLike;
  private readonly now: () => number;

  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private lastTickAt = 0;
  private current: OpenSpan | null = null;
  private browser: BrowserSpan | null = null;

  constructor(opts: BehaviorObserverOptions) {
    this.db = opts.db;
    this.provider = opts.provider;
    this.sampleMs = Math.max(500, opts.sampleMs ?? OBSERVER_SAMPLE_MS);
    this.pruneDays = opts.pruneDays ?? 90;
    this.log = scopedLogger(opts.log, 'observer');
    this.now = opts.now ?? (() => Date.now());
  }

  get running(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer) return;
    try {
      this.prune();
    } catch (e) {
      this.log.warn('prune failed', errorMessage(e));
    }
    this.lastTickAt = this.now();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.sampleMs);
    const t = this.timer as { unref?: () => void };
    t.unref?.();
    this.log.info(`started (every ${this.sampleMs} ms)`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.current = null;
    this.browser = null;
  }

  /** One sampling step. Public so hosts/tests can drive it without timers. Never throws. */
  async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const now = this.now();
      // Elapsed since the previous tick, capped so a laptop sleep does not inflate a span.
      const elapsed = this.lastTickAt ? Math.min(Math.max(0, now - this.lastTickAt), this.sampleMs * 3) : this.sampleMs;
      this.lastTickAt = now;

      if (this.provider.isIdle) {
        const idle = await this.provider.isIdle();
        if (idle) {
          this.current = null;
          return;
        }
      }
      const win = await this.provider.getActiveWindow();
      if (!win || !win.app) {
        this.current = null;
        return;
      }
      const app = normalizeApp(win.app);
      const title = normalizeTitle(win.title);

      if (this.current && this.current.app === app && this.current.title === title) {
        this.db.prepare('UPDATE behavior_samples SET duration_ms = duration_ms + ? WHERE id = ?').run(elapsed, this.current.id);
      } else {
        const res = this.db
          .prepare('INSERT INTO behavior_samples (ts, app, title, url, host, duration_ms, idle) VALUES (?, ?, ?, NULL, NULL, ?, 0)')
          .run(now, app, title, this.sampleMs);
        this.current = { id: Number(res.lastInsertRowid ?? 0), app, title, ts: now };
      }

      // Keep the open browser span growing while a browser is the active window.
      if (this.browser && BROWSER_APPS.has(app)) {
        const dur = Math.min(now - this.browser.ts, MAX_BROWSER_SPAN_MS);
        this.db.prepare('UPDATE behavior_samples SET duration_ms = ? WHERE id = ?').run(Math.max(dur, this.sampleMs), this.browser.id);
      }
    } catch (e) {
      this.log.warn('tick failed', errorMessage(e));
    } finally {
      this.inFlight = false;
    }
  }

  /** Record browser activity reported by the extension (tab activated / navigated / focused). Never throws. */
  recordBrowserActivity(e: { url: string; title: string; kind: string }): void {
    try {
      const host = hostOf(e.url);
      if (!host) return;
      const now = this.now();
      const title = normalizeTitle(e.title);
      if (this.browser && this.browser.host === host && this.browser.title === title) {
        const dur = Math.min(now - this.browser.ts, MAX_BROWSER_SPAN_MS);
        this.db.prepare('UPDATE behavior_samples SET duration_ms = ? WHERE id = ?').run(Math.max(dur, 1000), this.browser.id);
        return;
      }
      if (this.browser) {
        // Close the previous span at this event.
        const dur = Math.min(now - this.browser.ts, MAX_BROWSER_SPAN_MS);
        this.db.prepare('UPDATE behavior_samples SET duration_ms = MAX(duration_ms, ?) WHERE id = ?').run(dur, this.browser.id);
      }
      const res = this.db
        .prepare('INSERT INTO behavior_samples (ts, app, title, url, host, duration_ms, idle) VALUES (?, ?, ?, ?, ?, ?, 0)')
        .run(now, 'browser', title, String(e.url).slice(0, 2000), host, 1000);
      this.browser = { id: Number(res.lastInsertRowid ?? 0), app: 'browser', title, ts: now, host };
    } catch (err) {
      this.log.warn('recordBrowserActivity failed', errorMessage(err));
    }
  }

  sampleCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM behavior_samples').get() as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }

  /** Delete samples older than `pruneDays`. Returns the number of rows removed. */
  prune(): number {
    const cutoff = this.now() - this.pruneDays * DAY_MS;
    const res = this.db.prepare('DELETE FROM behavior_samples WHERE ts < ?').run(cutoff);
    return Number(res.changes);
  }

  summary(days = 7): BehaviorSummary {
    const now = this.now();
    const since = now - Math.max(1, days) * DAY_MS;
    const rows = this.db
      .prepare('SELECT * FROM behavior_samples WHERE ts >= ? AND idle = 0 ORDER BY ts ASC')
      .all(since) as SampleRow[];

    const appMs = new Map<string, number>();
    const hostMs = new Map<string, number>();
    const hours = new Array<number>(24).fill(0);
    const hostByPeriod = new Map<string, number[]>(); // host -> [morning, afternoon, evening, night]
    const dayMs = new Map<string, number>(); // yyyy-mm-dd -> active ms
    let totalActiveMs = 0;
    let last: SampleRow | undefined;

    for (const r of rows) {
      const dur = Math.max(0, Number(r.duration_ms));
      const d = new Date(Number(r.ts));
      last = r;
      if (r.url) {
        if (r.host) {
          hostMs.set(r.host, (hostMs.get(r.host) ?? 0) + dur);
          const p = hostByPeriod.get(r.host) ?? [0, 0, 0, 0];
          p[periodIndex(d.getHours())] += dur;
          hostByPeriod.set(r.host, p);
        }
        continue; // browser rows do not count towards app time (the window sampler already does)
      }
      totalActiveMs += dur;
      appMs.set(r.app, (appMs.get(r.app) ?? 0) + dur);
      hours[d.getHours()] += dur;
      const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
      dayMs.set(key, (dayMs.get(key) ?? 0) + dur);
    }

    // Without a window sampler (e.g. provider unavailable) fall back to browsing time for hours/days.
    const siteTotal = Array.from(hostMs.values()).reduce((a, b) => a + b, 0);
    if (totalActiveMs === 0 && siteTotal > 0) {
      for (const r of rows) {
        if (!r.url) continue;
        const d = new Date(Number(r.ts));
        hours[d.getHours()] += Number(r.duration_ms);
        const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
        dayMs.set(key, (dayMs.get(key) ?? 0) + Number(r.duration_ms));
      }
    }

    const topApps = Array.from(appMs.entries())
      .map(([app, ms]) => ({ app, ms, share: totalActiveMs > 0 ? ms / totalActiveMs : 0 }))
      .sort((a, b) => b.ms - a.ms)
      .slice(0, TOP_N);
    const topSites = Array.from(hostMs.entries())
      .map(([host, ms]) => ({ host, ms, share: siteTotal > 0 ? ms / siteTotal : 0 }))
      .sort((a, b) => b.ms - a.ms)
      .slice(0, TOP_N);

    const routines = deriveRoutines({ topApps, topSites, hours, hostByPeriod, dayMs, totalActiveMs: totalActiveMs || siteTotal });

    const summary: BehaviorSummary = { days, totalActiveMs, topApps, topSites, activeHours: hours, routines };
    if (last) summary.lastSeen = rowToSample(last);
    return summary;
  }

  /** Compact text (≤ 1200 chars) for prompts. '' when nothing has been observed. */
  digest(): string {
    const s = this.summary(7);
    if (s.totalActiveMs === 0 && s.topSites.length === 0) return '';
    const parts: string[] = [];
    const hoursPerDay = s.totalActiveMs / HOUR_MS / Math.max(1, s.days);
    parts.push(`Observed behaviour (last ${s.days} days): about ${hoursPerDay.toFixed(1)} h of active computer use per day.`);
    if (s.topApps.length) parts.push(`Top apps: ${s.topApps.slice(0, 5).map((a) => `${a.app} (${pct(a.share)})`).join(', ')}.`);
    if (s.topSites.length) parts.push(`Top sites: ${s.topSites.slice(0, 5).map((a) => `${a.host} (${pct(a.share)})`).join(', ')}.`);
    if (s.routines.length) parts.push('Routines:\n' + s.routines.map((r) => `- ${r}`).join('\n'));
    const text = parts.join('\n');
    return text.length > 1200 ? text.slice(0, 1197) + '…' : text;
  }
}

// ─── routine derivation ───

interface RoutineInput {
  topApps: BehaviorSummary['topApps'];
  topSites: BehaviorSummary['topSites'];
  hours: number[];
  hostByPeriod: Map<string, number[]>;
  dayMs: Map<string, number>;
  totalActiveMs: number;
}

const PERIODS = ['morning', 'afternoon', 'evening', 'night'] as const;

function periodIndex(hour: number): number {
  if (hour >= 5 && hour < 12) return 0;
  if (hour >= 12 && hour < 17) return 1;
  if (hour >= 17 && hour < 22) return 2;
  return 3;
}

export function deriveRoutines(input: RoutineInput): string[] {
  const out: string[] = [];
  const { topApps, topSites, hours, hostByPeriod, dayMs, totalActiveMs } = input;
  if (totalActiveMs <= 0) return out;

  // Active window of the day: longest contiguous run of hours above 30 % of the busiest hour (wrapping midnight).
  const max = Math.max(...hours);
  if (max > 0) {
    const threshold = max * 0.3;
    const active = hours.map((h) => h >= threshold);
    let best: { start: number; len: number } | null = null;
    for (let start = 0; start < 24; start++) {
      if (!active[start] || active[(start + 23) % 24]) continue; // only begin at the start of a run
      let len = 0;
      while (len < 24 && active[(start + len) % 24]) len++;
      if (!best || len > best.len) best = { start, len };
    }
    if (!best && active.every(Boolean)) best = { start: 0, len: 24 };
    if (best) {
      const end = (best.start + best.len) % 24;
      out.push(best.len >= 24 ? 'Active at all hours of the day' : `Usually active ${hh(best.start)}–${hh(end)}`);
    }
  }

  if (topApps.length > 0) {
    const a = topApps[0];
    out.push(`Most used app: ${a.app} (${pct(a.share)})`);
  }

  if (topSites.length > 0) {
    const s = topSites[0];
    const periods = hostByPeriod.get(s.host) ?? [0, 0, 0, 0];
    const total = periods.reduce((x, y) => x + y, 0);
    let pi = 0;
    for (let i = 1; i < 4; i++) if (periods[i] > periods[pi]) pi = i;
    const dominant = total > 0 && periods[pi] / total >= 0.45;
    const browserApp = topApps.find((x) => BROWSER_APPS.has(x.app))?.app;
    const when = dominant ? `most ${PERIODS[pi]}s` : 'throughout the day';
    out.push(browserApp ? `Opens ${browserApp} → ${s.host} ${when}` : `Visits ${s.host} ${when} (${pct(s.share)} of browsing)`);
    if (topSites.length > 1) {
      out.push(`Other frequent sites: ${topSites.slice(1, 4).map((x) => x.host).join(', ')}`);
    }
  }

  // Weekday vs weekend.
  if (dayMs.size >= 4) {
    let wk = 0;
    let wkDays = 0;
    let we = 0;
    let weDays = 0;
    for (const [key, ms] of dayMs) {
      const [y, m, d] = key.split('-').map(Number);
      const dow = new Date(y, m - 1, d).getDay();
      if (dow === 0 || dow === 6) {
        we += ms;
        weDays++;
      } else {
        wk += ms;
        wkDays++;
      }
    }
    if (wkDays > 0 && weDays > 0) {
      const avgWk = wk / wkDays;
      const avgWe = we / weDays;
      if (avgWe > avgWk * 1.5) out.push('More active on weekends than on weekdays');
      else if (avgWk > avgWe * 1.5) out.push('More active on weekdays than on weekends');
    }
  }

  if (dayMs.size > 0) {
    const perDay = totalActiveMs / dayMs.size / HOUR_MS;
    out.push(`Typically about ${perDay.toFixed(1)} h of active use on days the computer is used (${dayMs.size} day${dayMs.size === 1 ? '' : 's'} observed)`);
  }
  return out;
}

// ─── helpers ───

export function normalizeApp(app: string): string {
  return String(app ?? '')
    .trim()
    .replace(/\.exe$/i, '')
    .slice(0, 80);
}

function normalizeTitle(title: string): string {
  return String(title ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/** Hostname of an http(s) URL without a leading "www." — '' for anything else. */
export function hostOf(url: string): string {
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

function rowToSample(r: SampleRow): BehaviorSample {
  const s: BehaviorSample = { ts: Number(r.ts), app: r.app, title: r.title, durationMs: Number(r.duration_ms) };
  if (r.url) s.url = r.url;
  if (r.idle) s.idle = true;
  return s;
}

function hh(h: number): string {
  return `${String(h % 24).padStart(2, '0')}:00`;
}

function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}

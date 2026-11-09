/**
 * Settings persisted as JSON in <userData>/settings.json, merged over DEFAULT_SETTINGS.
 * The hub pairing token is generated on first run. No Electron dependency (testable).
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SETTINGS, type Settings } from '@aim/shared';

export type SettingsListener = (settings: Settings, patch: Partial<Settings>) => void;

export function generateHubToken(): string {
  return randomBytes(24).toString('hex');
}

export class SettingsStore {
  private current: Settings;
  private listeners = new Set<SettingsListener>();

  constructor(private readonly filePath: string, private readonly log?: { warn(...a: unknown[]): void; info(...a: unknown[]): void }) {
    this.current = this.load();
  }

  private load(): Settings {
    let stored: Partial<Settings> = {};
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') stored = parsed as Partial<Settings>;
      }
    } catch (err) {
      this.log?.warn(`settings.json unreadable, using defaults: ${(err as Error).message}`);
    }
    const merged = sanitize({ ...DEFAULT_SETTINGS, ...stored });
    let dirty = false;
    if (!merged.hubToken) {
      merged.hubToken = generateHubToken();
      dirty = true;
      this.log?.info('generated a new hub pairing token');
    }
    if (dirty || !fs.existsSync(this.filePath)) this.persist(merged);
    return merged;
  }

  private persist(s: Settings): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      this.log?.warn(`failed to persist settings: ${(err as Error).message}`);
    }
  }

  get(): Settings {
    return this.current;
  }

  /** Live getter for services that need `() => Settings`. */
  readonly getter = (): Settings => this.current;

  update(patch: Partial<Settings>): Settings {
    const clean: Partial<Settings> = { ...patch };
    delete (clean as Record<string, unknown>)['paymentGuard']; // immutable
    const next = sanitize({ ...this.current, ...clean });
    if (!next.hubToken) next.hubToken = this.current.hubToken || generateHubToken();
    this.current = next;
    this.persist(next);
    for (const l of this.listeners) {
      try {
        l(next, clean);
      } catch (err) {
        this.log?.warn(`settings listener failed: ${(err as Error).message}`);
      }
    }
    return next;
  }

  regenerateToken(): Settings {
    return this.update({ hubToken: generateHubToken() });
  }

  onChange(cb: SettingsListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}

function sanitize(s: Settings): Settings {
  const out: Settings = { ...s, paymentGuard: true };
  if (!Number.isInteger(out.hubPort) || out.hubPort < 1024 || out.hubPort > 65535) out.hubPort = DEFAULT_SETTINGS.hubPort;
  if (!/^\d{2}:\d{2}$/.test(out.dailyGoalsTime)) out.dailyGoalsTime = DEFAULT_SETTINGS.dailyGoalsTime;
  if (!Array.isArray(out.additionalDirs)) out.additionalDirs = [];
  if (typeof out.toggleShortcut !== 'string' || !out.toggleShortcut) out.toggleShortcut = DEFAULT_SETTINGS.toggleShortcut;
  if (!/^#[0-9a-f]{6}$/i.test(out.cursorColor ?? '')) out.cursorColor = DEFAULT_SETTINGS.cursorColor;
  if (!['dark', 'light', 'system'].includes(out.theme)) out.theme = 'dark';
  if (!['', 'low', 'medium', 'high', 'xhigh', 'max'].includes(out.effort)) out.effort = '';
  out.maxSelfHealAttempts = clampInt(out.maxSelfHealAttempts, 0, 10, DEFAULT_SETTINGS.maxSelfHealAttempts);
  out.maxParallelAgents = clampInt(out.maxParallelAgents, 1, 16, DEFAULT_SETTINGS.maxParallelAgents);
  if (typeof out.maxBudgetUsdPerTurn !== 'number' || !Number.isFinite(out.maxBudgetUsdPerTurn) || out.maxBudgetUsdPerTurn < 0) out.maxBudgetUsdPerTurn = 0;
  return out;
}

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return dflt;
  return Math.min(max, Math.max(min, Math.round(v)));
}

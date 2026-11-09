/** AppHealth aggregation with a cached CLI probe. */
import os from 'node:os';
import type { AppHealth, CliHealth } from '@aim/shared';
import type { HubServer } from './hub/hub-server.js';
import type { SettingsStore } from './settings.js';

export interface HealthDeps {
  settings: SettingsStore;
  hub: HubServer;
  detectCli: (explicitPath?: string) => Promise<CliHealth>;
  observerSamples: () => number;
  version: string;
  platform?: string;
  cliCacheMs?: number;
  paths?: () => NonNullable<AppHealth['paths']>;
  update?: () => AppHealth['update'];
}

export class HealthMonitor {
  private cliCache: { at: number; value: CliHealth; path: string } | null = null;
  private inflight: Promise<CliHealth> | null = null;
  private lastJson = '';

  constructor(private readonly deps: HealthDeps) {}

  async cli(force = false): Promise<CliHealth> {
    const path = this.deps.settings.get().claudeCliPath;
    const ttl = this.deps.cliCacheMs ?? 60_000;
    if (!force && this.cliCache && this.cliCache.path === path && Date.now() - this.cliCache.at < ttl) return this.cliCache.value;
    if (this.inflight) return this.inflight;
    this.inflight = this.deps
      .detectCli(path || undefined)
      .catch((err): CliHealth => ({ found: false, error: `CLI detection failed: ${(err as Error).message}` }))
      .then((value) => {
        this.cliCache = { at: Date.now(), value, path };
        this.inflight = null;
        return value;
      });
    return this.inflight;
  }

  invalidateCli(): void {
    this.cliCache = null;
  }

  async get(forceCli = false): Promise<AppHealth> {
    const s = this.deps.settings.get();
    const hub = this.deps.hub;
    return {
      cli: await this.cli(forceCli),
      extension: hub.extensionHealth(),
      hub: { listening: hub.listening, port: hub.actualPort || s.hubPort, url: hub.extensionUrl, token: s.hubToken },
      observer: { enabled: s.observerEnabled, samples: safe(() => this.deps.observerSamples(), 0) },
      version: this.deps.version,
      platform: this.deps.platform ?? process.platform,
      paths: this.deps.paths ? safe(() => this.deps.paths!(), undefined) : undefined,
      update: this.deps.update ? safe(() => this.deps.update!(), undefined) : undefined,
      userName: safe(() => displayUserName(), undefined),
    };
  }

  /** Returns the health only when it changed since the last call (for periodic pushes). */
  async getIfChanged(): Promise<AppHealth | null> {
    const h = await this.get();
    const json = JSON.stringify({ ...h, extension: { ...h.extension, lastSeen: undefined } });
    if (json === this.lastJson) return null;
    this.lastJson = json;
    return h;
  }
}

/** "samuel.sortland" / "ssortland" → "Samuel" when the name is clearly separable, else the login name capitalised. */
export function displayUserName(raw = os.userInfo().username): string | undefined {
  const name = (raw ?? '').trim();
  if (!name) return undefined;
  const first = name.split(/[._\-\s]+/).filter(Boolean)[0] ?? name;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

function safe<T>(fn: () => T, dflt: T): T {
  try {
    return fn();
  } catch {
    return dflt;
  }
}

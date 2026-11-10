/**
 * Self-update through GitHub Releases, powered by electron-updater.
 *
 * Release artefacts are produced by `electron-builder --publish always` (see .github/workflows/release.yml):
 * the NSIS installer plus `latest.yml` (and blockmaps for differential downloads) are attached to a GitHub
 * Release. At runtime electron-updater reads `latest.yml` from the newest release of the configured repository,
 * compares versions, downloads the installer in the background and installs it when the app quits (or at once
 * when the user clicks "Restart and update").
 *
 * The repository defaults to the one baked in at build time (app-update.yml, derived from the git remote) and can
 * be overridden in Settings ("owner/repo" or a github.com URL). Private repositories work with a personal access
 * token, stored only in the local settings file.
 */
import { DEFAULT_UPDATE_REPO, type Settings, type UpdateStatus } from '@aim/shared';
import type { ConsoleLogger } from './context.js';

/** The subset of electron-updater's AppUpdater we use (kept small so tests can inject a fake). */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  logger: unknown;
  setFeedURL(options: { provider: 'github'; owner: string; repo: string; private?: boolean; token?: string }): void;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: string, listener: (...args: never[]) => void): unknown;
}

export interface UpdateServiceDeps {
  settings: () => Settings;
  isPackaged: boolean;
  currentVersion: string;
  onStatus: (status: UpdateStatus) => void;
  log: ConsoleLogger | { info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void; debug(...a: unknown[]): void };
  /** Loads electron-updater lazily (defaults to the real module). Injected in tests. */
  loadUpdater?: () => UpdaterLike;
  /** Repository compiled into the build (from app-update.yml), shown when Settings has none. */
  builtInRepo?: string;
  /** Fetches JSON from a URL (defaults to global fetch). Injected in tests. */
  fetchJson?: (url: string) => Promise<unknown>;
}

const SOURCE_BUILD_MESSAGE = 'Running from source (pnpm dev). Automatic updates work in the installed app; use Check now to find the newest installer.';

/** "1.2.3" vs "1.2.10": 1 when a is newer, -1 when older, 0 when equal. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.replace(/^v/, '').split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'A.I.M.-desktop' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Accepts "owner/repo" or a github.com URL (with or without .git). */
export function parseRepo(input: string): { owner: string; repo: string } | null {
  const s = (input ?? '').trim();
  if (!s) return null;
  const url = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?(?:[#?].*)?$/i);
  const short = s.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  const m = url ?? short;
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

export function formatRepo(r: { owner: string; repo: string } | null): string | undefined {
  return r ? `${r.owner}/${r.repo}` : undefined;
}

interface UpdateInfoLike {
  version?: string;
  releaseNotes?: string | { note?: string | null }[] | null;
  releaseDate?: string;
}

function notesToText(notes: UpdateInfoLike['releaseNotes']): string | undefined {
  if (!notes) return undefined;
  if (typeof notes === 'string') return stripHtml(notes).slice(0, 4000);
  return stripHtml(notes.map((n) => n.note ?? '').join('\n')).slice(0, 4000);
}
function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}

export class UpdateService {
  private status: UpdateStatus;
  private updater: UpdaterLike | null = null;
  private listenersAttached = false;
  private timer: NodeJS.Timeout | null = null;
  private initialTimer: NodeJS.Timeout | null = null;
  private checking: Promise<UpdateStatus> | null = null;

  constructor(private readonly deps: UpdateServiceDeps) {
    this.status = { state: deps.isPackaged ? 'idle' : 'unsupported', currentVersion: deps.currentVersion };
    if (!deps.isPackaged) this.status.message = SOURCE_BUILD_MESSAGE;
    this.applyRepoToStatus();
  }

  getStatus(): UpdateStatus {
    return { ...this.status };
  }

  /** Re-reads Settings: enabled flag, repository, auto-download, prerelease; restarts the schedule. */
  reconfigure(): void {
    this.stop();
    this.applyRepoToStatus();
    if (!this.deps.isPackaged) return;
    const s = this.deps.settings();
    if (!s.updatesEnabled) {
      this.set({ state: 'disabled', message: 'Automatic updates are turned off in Settings.' });
      return;
    }
    if (this.status.state === 'disabled') this.set({ state: 'idle', message: undefined });
    try {
      this.configureUpdater();
    } catch (err) {
      this.set({ state: 'error', error: `Updater configuration failed: ${(err as Error).message}` });
      return;
    }
    this.start();
  }

  /** Starts the periodic schedule (first check after 30 s). */
  start(): void {
    if (!this.deps.isPackaged) return;
    const s = this.deps.settings();
    if (!s.updatesEnabled) {
      this.set({ state: 'disabled', message: 'Automatic updates are turned off in Settings.' });
      return;
    }
    this.stop();
    const hours = Math.max(1, Math.min(168, Number(s.updatesCheckIntervalHours) || 6));
    this.initialTimer = setTimeout(() => void this.check().catch(() => undefined), 30_000);
    this.timer = setInterval(() => void this.check().catch(() => undefined), hours * 3_600_000);
    this.initialTimer.unref?.();
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.initialTimer) clearTimeout(this.initialTimer);
    this.timer = null;
    this.initialTimer = null;
  }

  /** Manual or scheduled check. Never throws; the outcome is in the returned status. */
  async check(): Promise<UpdateStatus> {
    if (this.checking) return this.checking;
    this.checking = this.doCheck().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  private async doCheck(): Promise<UpdateStatus> {
    if (!this.deps.isPackaged) return this.checkSourceBuild();
    const s = this.deps.settings();
    if (!s.updatesEnabled) {
      this.set({ state: 'disabled', message: 'Automatic updates are turned off in Settings.', checkedAt: Date.now() });
      return this.getStatus();
    }
    let updater: UpdaterLike;
    try {
      updater = this.configureUpdater();
    } catch (err) {
      this.set({ state: 'error', error: `Updater configuration failed: ${(err as Error).message}`, checkedAt: Date.now() });
      return this.getStatus();
    }
    if (!this.status.repo) {
      this.set({ state: 'disabled', message: 'No GitHub repository configured for updates. Set "owner/repo" in Settings → Updates.', checkedAt: Date.now() });
      return this.getStatus();
    }
    if (this.status.state === 'downloading' || this.status.state === 'downloaded') return this.getStatus();
    this.set({ state: 'checking', error: undefined });
    try {
      await updater.checkForUpdates();
      // Listeners move the state to available / not_available / downloading.
      if (this.status.state === 'checking') this.set({ state: 'not_available', checkedAt: Date.now() });
    } catch (err) {
      this.set({ state: 'error', error: friendlyError(err), checkedAt: Date.now() });
    }
    return this.getStatus();
  }

  async download(): Promise<UpdateStatus> {
    const updater = this.updater;
    if (!this.deps.isPackaged) return this.getStatus(); // the UI opens releaseUrl instead
    if (!updater) return this.getStatus();
    if (this.status.state !== 'available' && this.status.state !== 'error') return this.getStatus();
    this.set({ state: 'downloading', percent: 0, error: undefined });
    try {
      await updater.downloadUpdate();
    } catch (err) {
      this.set({ state: 'error', error: friendlyError(err) });
    }
    return this.getStatus();
  }

  /** Quit and install a downloaded update. Returns false when nothing is downloaded. */
  install(): boolean {
    if (!this.updater || this.status.state !== 'downloaded') return false;
    this.deps.log.info('installing update', this.status.latestVersion);
    this.updater.quitAndInstall(false, true);
    return true;
  }

  dispose(): void {
    this.stop();
  }

  // ── internals ──

  private applyRepoToStatus(): void {
    const s = this.deps.settings();
    const repo = formatRepo(parseRepo(s.updatesRepo)) ?? this.deps.builtInRepo ?? DEFAULT_UPDATE_REPO;
    this.status.repo = repo;
  }

  /**
   * A source build cannot install updates, but it can tell the user that a newer installer exists:
   * look up the newest GitHub release and point at it.
   */
  private async checkSourceBuild(): Promise<UpdateStatus> {
    this.applyRepoToStatus();
    const repo = this.status.repo;
    if (!repo) {
      this.set({ state: 'unsupported', message: SOURCE_BUILD_MESSAGE, checkedAt: Date.now() });
      return this.getStatus();
    }
    this.set({ state: 'checking', error: undefined });
    try {
      const fetchJson = this.deps.fetchJson ?? defaultFetchJson;
      const rel = (await fetchJson(`https://api.github.com/repos/${repo}/releases/latest`)) as { tag_name?: string; html_url?: string; body?: string; published_at?: string } | null;
      const latest = rel?.tag_name?.replace(/^v/, '');
      const url = rel?.html_url ?? `https://github.com/${repo}/releases/latest`;
      if (!latest) throw new Error('No release found');
      if (compareVersions(latest, this.deps.currentVersion) > 0) {
        this.set({
          state: 'available',
          manual: true,
          latestVersion: latest,
          releaseUrl: url,
          releaseNotes: rel?.body ? rel.body.slice(0, 4000) : undefined,
          releaseDate: rel?.published_at,
          message: `Version ${latest} is available. You are running from source; download the installer to switch to automatic updates.`,
          checkedAt: Date.now(),
          error: undefined,
        });
      } else {
        this.set({ state: 'unsupported', latestVersion: latest, releaseUrl: url, manual: true, message: `${SOURCE_BUILD_MESSAGE} You already have the newest version (${latest}).`, checkedAt: Date.now() });
      }
    } catch (err) {
      this.set({ state: 'unsupported', message: `${SOURCE_BUILD_MESSAGE} (Could not reach GitHub: ${friendlyError(err)})`, checkedAt: Date.now() });
    }
    return this.getStatus();
  }

  private configureUpdater(): UpdaterLike {
    const s = this.deps.settings();
    if (!this.updater) {
      const load = this.deps.loadUpdater ?? defaultLoader;
      this.updater = load();
    }
    const u = this.updater;
    u.autoDownload = !!s.updatesAutoDownload;
    u.autoInstallOnAppQuit = true;
    u.allowPrerelease = !!s.updatesAllowPrerelease;
    u.allowDowngrade = false;
    u.logger = {
      info: (...a: unknown[]) => this.deps.log.debug('[updater]', ...a),
      warn: (...a: unknown[]) => this.deps.log.warn('[updater]', ...a),
      error: (...a: unknown[]) => this.deps.log.error('[updater]', ...a),
      debug: (...a: unknown[]) => this.deps.log.debug('[updater]', ...a),
    };
    const override = parseRepo(s.updatesRepo);
    if (override) {
      const token = s.updatesToken.trim();
      u.setFeedURL({ provider: 'github', owner: override.owner, repo: override.repo, ...(token ? { private: true, token } : {}) });
    }
    this.applyRepoToStatus();
    this.attachListeners(u);
    return u;
  }

  private attachListeners(u: UpdaterLike): void {
    if (this.listenersAttached) return;
    this.listenersAttached = true;
    u.on('checking-for-update', () => this.set({ state: 'checking', error: undefined }));
    u.on('update-available', (info: UpdateInfoLike) => {
      const s = this.deps.settings();
      this.set({
        state: s.updatesAutoDownload ? 'downloading' : 'available',
        latestVersion: info?.version,
        releaseNotes: notesToText(info?.releaseNotes),
        releaseDate: info?.releaseDate,
        percent: s.updatesAutoDownload ? 0 : undefined,
        checkedAt: Date.now(),
        error: undefined,
      });
    });
    u.on('update-not-available', (info: UpdateInfoLike) => this.set({ state: 'not_available', latestVersion: info?.version, checkedAt: Date.now(), percent: undefined }));
    u.on('download-progress', (p: { percent?: number; bytesPerSecond?: number }) =>
      this.set({ state: 'downloading', percent: Math.round((p?.percent ?? 0) * 10) / 10, bytesPerSecond: p?.bytesPerSecond }),
    );
    u.on('update-downloaded', (info: UpdateInfoLike) =>
      this.set({ state: 'downloaded', latestVersion: info?.version ?? this.status.latestVersion, releaseNotes: notesToText(info?.releaseNotes) ?? this.status.releaseNotes, percent: 100 }),
    );
    u.on('error', (err: unknown) => {
      // A failed scheduled check should not look alarming; keep the message short.
      this.set({ state: 'error', error: friendlyError(err), checkedAt: Date.now() });
    });
  }

  private set(patch: Partial<UpdateStatus>): void {
    const next: UpdateStatus = { ...this.status, ...patch };
    const changed = JSON.stringify(next) !== JSON.stringify(this.status);
    this.status = next;
    if (changed) {
      try {
        this.deps.onStatus(this.getStatus());
      } catch (err) {
        this.deps.log.warn('update status listener failed', err);
      }
    }
  }
}

function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/404/.test(msg) || /Cannot find latest\.yml/i.test(msg)) return 'No release with update metadata (latest.yml) was found in the configured repository.';
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|net::ERR/i.test(msg)) return 'GitHub could not be reached. Check your internet connection.';
  if (/401|403/.test(msg)) return 'GitHub refused the request (private repository without a valid token, or rate limit).';
  return msg.split('\n')[0].slice(0, 300);
}

function defaultLoader(): UpdaterLike {
  // Loaded lazily so unit tests and the health page never need electron-updater.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('electron-updater') as { autoUpdater: UpdaterLike };
  return mod.autoUpdater;
}

/** Reads the repository electron-builder baked into the packaged app (resources/app-update.yml). */
export function readBuiltInRepo(resourcesPath: string | undefined, readFile: (p: string) => string): string | undefined {
  if (!resourcesPath) return undefined;
  try {
    const text = readFile(`${resourcesPath}/app-update.yml`);
    const owner = text.match(/^owner:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '');
    const repo = text.match(/^repo:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '');
    return owner && repo ? `${owner}/${repo}` : undefined;
  } catch {
    return undefined;
  }
}

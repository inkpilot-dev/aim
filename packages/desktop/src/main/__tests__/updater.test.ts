import { describe, it, expect, vi } from 'vitest';
import { UpdateService, parseRepo, readBuiltInRepo, type UpdaterLike } from '../updater.js';
import { DEFAULT_SETTINGS, type Settings, type UpdateStatus } from '@aim/shared';

type Listener = (...args: never[]) => void;

function fakeUpdater(behaviour: { onCheck?: (emit: (ev: string, ...a: unknown[]) => void) => Promise<void> } = {}) {
  const listeners = new Map<string, Listener[]>();
  const emit = (ev: string, ...args: unknown[]) => (listeners.get(ev) ?? []).forEach((l) => (l as (...a: unknown[]) => void)(...args));
  const u: UpdaterLike & { feed?: unknown; installed: boolean; downloads: number } = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowPrerelease: false,
    allowDowngrade: true,
    logger: null,
    installed: false,
    downloads: 0,
    setFeedURL(o) {
      this.feed = o;
    },
    async checkForUpdates() {
      emit('checking-for-update');
      if (behaviour.onCheck) await behaviour.onCheck(emit);
      else emit('update-not-available', { version: '0.1.0' });
      return null;
    },
    async downloadUpdate() {
      this.downloads++;
      emit('download-progress', { percent: 50, bytesPerSecond: 1000 });
      emit('update-downloaded', { version: '0.2.0', releaseNotes: '<p>Fixes</p>' });
      return [];
    },
    quitAndInstall() {
      this.installed = true;
    },
    on(ev, l) {
      listeners.set(ev, [...(listeners.get(ev) ?? []), l]);
      return this;
    },
  };
  return { u, emit };
}

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const settingsWith = (patch: Partial<Settings>) => () => ({ ...DEFAULT_SETTINGS, ...patch });

describe('parseRepo', () => {
  it('accepts owner/repo and GitHub URLs', () => {
    expect(parseRepo('acme/aim')).toEqual({ owner: 'acme', repo: 'aim' });
    expect(parseRepo('https://github.com/acme/aim')).toEqual({ owner: 'acme', repo: 'aim' });
    expect(parseRepo('https://github.com/acme/aim.git/')).toEqual({ owner: 'acme', repo: 'aim' });
    expect(parseRepo('github.com/acme/aim#readme')).toEqual({ owner: 'acme', repo: 'aim' });
    expect(parseRepo('')).toBeNull();
    expect(parseRepo('not a repo')).toBeNull();
    expect(parseRepo('https://gitlab.com/acme/aim')).toBeNull();
  });
  it('reads the built-in repository from app-update.yml', () => {
    expect(readBuiltInRepo('/res', () => 'provider: github\nowner: acme\nrepo: aim\n')).toBe('acme/aim');
    expect(readBuiltInRepo('/res', () => { throw new Error('ENOENT'); })).toBeUndefined();
    expect(readBuiltInRepo(undefined, () => '')).toBeUndefined();
  });
});

describe('UpdateService', () => {
  it('reports unsupported in development builds', async () => {
    const statuses: UpdateStatus[] = [];
    const svc = new UpdateService({ settings: settingsWith({}), isPackaged: false, currentVersion: '0.1.0', onStatus: (s) => statuses.push(s), log, loadUpdater: () => fakeUpdater().u, fetchJson: async () => { throw new Error('offline'); } });
    expect(svc.getStatus().state).toBe('unsupported');
    const r = await svc.check();
    expect(r.state).toBe('unsupported');
    expect(r.message).toMatch(/source/i);
  });

  it('source builds point at a newer installer on GitHub', async () => {
    const svc = new UpdateService({ settings: settingsWith({}), isPackaged: false, currentVersion: '0.1.0', onStatus: () => undefined, log, loadUpdater: () => fakeUpdater().u, fetchJson: async () => ({ tag_name: 'v0.1.4', html_url: 'https://github.com/inkpilot-dev/aim/releases/tag/v0.1.4', body: 'Fixes' }) });
    const r = await svc.check();
    expect(r.state).toBe('available');
    expect(r.manual).toBe(true);
    expect(r.latestVersion).toBe('0.1.4');
    expect(r.releaseUrl).toContain('v0.1.4');
    const same = new UpdateService({ settings: settingsWith({}), isPackaged: false, currentVersion: '0.1.4', onStatus: () => undefined, log, loadUpdater: () => fakeUpdater().u, fetchJson: async () => ({ tag_name: 'v0.1.4' }) });
    expect((await same.check()).state).toBe('unsupported');
  });

  it('falls back to the default repository and is disabled when turned off', async () => {
    const svc = new UpdateService({ settings: settingsWith({ updatesRepo: '' }), isPackaged: true, currentVersion: '0.1.0', onStatus: () => undefined, log, loadUpdater: () => fakeUpdater().u });
    const r = await svc.check();
    expect(r.repo).toBe('inkpilot-dev/aim');
    expect(r.state).toBe('not_available');
    const off = new UpdateService({ settings: settingsWith({ updatesEnabled: false, updatesRepo: 'acme/aim' }), isPackaged: true, currentVersion: '0.1.0', onStatus: () => undefined, log, loadUpdater: () => fakeUpdater().u });
    expect((await off.check()).state).toBe('disabled');
  });

  it('uses the built-in repository when settings have none', async () => {
    const { u } = fakeUpdater();
    const svc = new UpdateService({ settings: settingsWith({}), isPackaged: true, currentVersion: '0.1.0', onStatus: () => undefined, log, loadUpdater: () => u, builtInRepo: 'acme/aim' });
    const r = await svc.check();
    expect(r.state).toBe('not_available');
    expect(r.repo).toBe('acme/aim');
    expect(u.feed).toBeUndefined(); // baked-in feed untouched
    expect(u.autoInstallOnAppQuit).toBe(true);
    expect(u.allowDowngrade).toBe(false);
  });

  it('points the feed at the configured repository, with a token for private repos', async () => {
    const { u } = fakeUpdater();
    const svc = new UpdateService({ settings: settingsWith({ updatesRepo: 'https://github.com/acme/aim', updatesToken: 'ghp_x', updatesAllowPrerelease: true }), isPackaged: true, currentVersion: '0.1.0', onStatus: () => undefined, log, loadUpdater: () => u });
    await svc.check();
    expect(u.feed).toEqual({ provider: 'github', owner: 'acme', repo: 'aim', private: true, token: 'ghp_x' });
    expect(u.allowPrerelease).toBe(true);
  });

  it('walks available → downloading → downloaded and installs', async () => {
    const statuses: UpdateStatus[] = [];
    const { u } = fakeUpdater({ onCheck: async (emit) => emit('update-available', { version: '0.2.0', releaseNotes: [{ note: '<b>New</b> things' }], releaseDate: '2026-11-09' }) });
    const svc = new UpdateService({ settings: settingsWith({ updatesRepo: 'acme/aim', updatesAutoDownload: false }), isPackaged: true, currentVersion: '0.1.0', onStatus: (s) => statuses.push(s), log, loadUpdater: () => u });
    const r = await svc.check();
    expect(r.state).toBe('available');
    expect(r.latestVersion).toBe('0.2.0');
    expect(r.releaseNotes).toBe('New things');
    expect(svc.install()).toBe(false);
    const d = await svc.download();
    expect(d.state).toBe('downloaded');
    expect(d.percent).toBe(100);
    expect(u.downloads).toBe(1);
    expect(statuses.some((s) => s.state === 'downloading' && s.percent === 50)).toBe(true);
    expect(svc.install()).toBe(true);
    expect(u.installed).toBe(true);
  });

  it('auto-download mode goes straight to downloading on availability', async () => {
    const { u } = fakeUpdater({ onCheck: async (emit) => emit('update-available', { version: '0.3.0' }) });
    const svc = new UpdateService({ settings: settingsWith({ updatesRepo: 'acme/aim', updatesAutoDownload: true }), isPackaged: true, currentVersion: '0.1.0', onStatus: () => undefined, log, loadUpdater: () => u });
    expect((await svc.check()).state).toBe('downloading');
    expect(u.autoDownload).toBe(true);
  });

  it('turns transport errors into friendly messages and never throws', async () => {
    const { u } = fakeUpdater({ onCheck: async () => { throw new Error('getaddrinfo ENOTFOUND github.com'); } });
    const svc = new UpdateService({ settings: settingsWith({ updatesRepo: 'acme/aim' }), isPackaged: true, currentVersion: '0.1.0', onStatus: () => undefined, log, loadUpdater: () => u });
    const r = await svc.check();
    expect(r.state).toBe('error');
    expect(r.error).toMatch(/internet connection/);
    const { u: u404 } = fakeUpdater({ onCheck: async () => { throw new Error('HttpError: 404 Not Found'); } });
    const svc2 = new UpdateService({ settings: settingsWith({ updatesRepo: 'acme/aim' }), isPackaged: true, currentVersion: '0.1.0', onStatus: () => undefined, log, loadUpdater: () => u404 });
    expect((await svc2.check()).error).toMatch(/latest\.yml/);
  });

  it('reconfigure honours the enabled flag and schedules checks', () => {
    vi.useFakeTimers();
    const { u } = fakeUpdater();
    let enabled = true;
    const svc = new UpdateService({ settings: () => ({ ...DEFAULT_SETTINGS, updatesRepo: 'acme/aim', updatesEnabled: enabled }), isPackaged: true, currentVersion: '0.1.0', onStatus: () => undefined, log, loadUpdater: () => u });
    const spy = vi.spyOn(u, 'checkForUpdates');
    svc.start();
    vi.advanceTimersByTime(31_000);
    expect(spy).toHaveBeenCalledTimes(1);
    enabled = false;
    svc.reconfigure();
    expect(svc.getStatus().state).toBe('disabled');
    vi.advanceTimersByTime(7 * 3_600_000);
    expect(spy).toHaveBeenCalledTimes(1);
    svc.dispose();
    vi.useRealTimers();
  });
});

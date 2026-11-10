/**
 * A.I.M. desktop — Electron main process bootstrap ("Hub").
 * Defensive by design: if @aim/core fails to load or construct, the error is shown in a dialog
 * and the window still opens with a built-in health page; the hub, tray and settings keep working.
 */
import fs from 'node:fs';
import path from 'node:path';
import { BrowserWindow, app, dialog, globalShortcut } from 'electron';
import { APP_ID, APP_NAME, OBSERVER_SAMPLE_MS, type ChatStreamEvent, type DailyPlan, type ExtEvent, type Settings } from '@aim/shared';
import type * as Core from '@aim/core';
import { ActiveWindowProvider } from './active-window.js';
import { consoleLogger, type AppContext, type AppPaths, type CoreServices } from './context.js';
import { HealthMonitor } from './health.js';
import { UpdateService, readBuiltInRepo } from './updater.js';
import { HubServer } from './hub/hub-server.js';
import { emitChat, emitGlobal, registerIpc, toast } from './ipc.js';
import { buildMcpConfig } from './mcp-config.js';
import { CursorOverlay } from './overlay/cursor-overlay.js';
import { SettingsStore } from './settings.js';
import { buildSystemPromptExtras, currentUserName } from './system-prompt-extras.js';
import { createToolRouter } from './tools/index.js';
import { AppTray } from './tray.js';
import { MainWindow } from './window.js';

// ───────────────────────────── single instance ─────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  void main().catch((err) => {
    console.error('[main] fatal during bootstrap', err);
    try {
      dialog.showErrorBox(`${APP_NAME} failed to start`, err instanceof Error ? (err.stack ?? err.message) : String(err));
    } catch {
      /* no display */
    }
    app.exit(1);
  });
}

function computePaths(): AppPaths {
  const userData = app.getPath('userData');
  const assetCandidates = [
    path.join(process.resourcesPath ?? '', 'assets'),
    path.resolve(app.getAppPath(), '..', '..', 'assets'),
    path.resolve(app.getAppPath(), 'assets'),
    path.resolve(process.cwd(), 'assets'),
  ];
  const assets = assetCandidates.find((p) => p && fs.existsSync(path.join(p, 'icons'))) ?? assetCandidates[1]!;
  const firstExisting = (cands: string[], probe: string): string => cands.find((p) => p && fs.existsSync(path.join(p, probe))) ?? cands[0]!;
  // Development: walk up from the app path until the monorepo root (pnpm-workspace.yaml) is found, so the
  // result is right whether Electron was started on packages/desktop or directly on out/main/index.js.
  const findRepoRoot = (): string => {
    let dir = app.getAppPath();
    for (let i = 0; i < 6; i++) {
      if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return path.resolve(app.getAppPath(), '..', '..');
  };
  const repoRoot = app.isPackaged ? '' : findRepoRoot();
  const packagedExt = app.isPackaged ? [path.join(process.resourcesPath ?? '', 'extension')] : [];
  const packagedDocs = app.isPackaged ? [path.join(process.resourcesPath ?? '', 'docs')] : [];
  const extensionDir = firstExisting([...packagedExt, path.join(repoRoot, 'packages', 'extension', 'dist'), path.join(repoRoot, 'packages', 'extension')], 'manifest.json');
  const docsDir = firstExisting([...packagedDocs, path.join(repoRoot, 'docs')], 'EXTENSION.md');
  return { userData, db: path.join(userData, 'aim.db'), logs: path.join(userData, 'logs'), settings: path.join(userData, 'settings.json'), assets, extensionDir, docsDir };
}

async function loadCore(log: { warn(...a: unknown[]): void }): Promise<typeof Core | null> {
  try {
    return (await import('@aim/core')) as typeof Core;
  } catch (err) {
    log.warn(`@aim/core failed to load: ${(err as Error).stack ?? (err as Error).message}`);
    return null;
  }
}

async function main(): Promise<void> {
  app.setAppUserModelId(APP_ID);
  app.setName(APP_NAME);
  // Pin the data directory to <appData>/A.I.M. in dev and packaged builds alike (Electron derives the default
  // from package.json's name, which would scatter data under "@aim/desktop" or "Electron" during development).
  const userDataOverride = process.env['AIM_USER_DATA'];
  app.setPath('userData', userDataOverride && userDataOverride.length > 0 ? userDataOverride : path.join(app.getPath('appData'), APP_NAME));
  await app.whenReady();

  const paths = computePaths();
  fs.mkdirSync(paths.logs, { recursive: true });

  // Core module + logging
  const bootLog = consoleLogger('main');
  const core = await loadCore(bootLog);
  let log: AppContext['log'] = bootLog;
  if (core) {
    try {
      core.configureLogging({ dir: paths.logs, level: process.env['AIM_LOG_LEVEL'] === 'debug' || !app.isPackaged ? 'debug' : 'info' });
      log = core.createLogger('main');
    } catch (err) {
      bootLog.warn(`configureLogging failed: ${(err as Error).message}`);
    }
  }
  log.info(`${APP_NAME} ${app.getVersion()} starting (electron ${process.versions.electron}, ${process.platform})`);
  log.info(`userData: ${paths.userData}`);

  const settings = new SettingsStore(paths.settings, log);

  // Hub
  const hub = new HubServer({ port: settings.get().hubPort, token: () => settings.get().hubToken, log: log.child('hub') });
  let hubError: string | undefined;
  try {
    await hub.start();
  } catch (err) {
    hubError = (err as Error).message;
    log.error(`hub failed to start: ${hubError}`);
  }

  const overlay = new CursorOverlay({ settings: settings.getter, log: log.child('overlay') });
  const activeWindow = new ActiveWindowProvider({ log: log.child('activewin') });
  const preloadPath = path.join(__dirname, '../preload/index.js');
  const rendererDir = path.join(__dirname, '../renderer');
  const iconPath = [path.join(paths.assets, 'icons', process.platform === 'win32' ? 'icon.ico' : 'icon.png'), path.join(paths.assets, 'icons', 'icon-256.png')].find((p) => fs.existsSync(p));
  const mainWindow = new MainWindow({ preloadPath, rendererDir, iconPath, startMinimized: settings.get().startMinimized, log: log.child('window') });

  const ctx: AppContext = { paths, settings, hub, overlay, mainWindow, activeWindow, core, services: null, router: null, health: null, updater: null, observerPaused: false, log };

  // Core services (defensive)
  if (!core) {
    ctx.startupError = 'The A.I.M. core module (@aim/core) could not be loaded. Check the installation and the logs.';
  } else {
    try {
      ctx.services = await buildCoreServices(ctx, core);
    } catch (err) {
      ctx.startupError = (err as Error).stack ?? (err as Error).message;
      log.error(`core construction failed: ${ctx.startupError}`);
    }
  }
  if (hubError) {
    const msg = `The local hub could not listen on 127.0.0.1:${settings.get().hubPort} (${hubError}). Tools and the browser extension are unavailable.`;
    ctx.startupError = ctx.startupError ? `${ctx.startupError}\n\n${msg}` : msg;
  }

  // Tools
  let browserLaunchAttempted = false;
  ctx.router = createToolRouter(ctx, {
    appVersion: app.getVersion(),
    iconPath,
    onMemoryChanged: () => emitGlobal({ type: 'memory.updated', count: ctx.services?.memory.count() ?? 0 }),
    onGoalsChanged: () => emitGlobal({ type: 'goals.updated', goals: ctx.services?.goals.list() ?? [] }),
    onNotify: (title, body) => toast('info', title, body),
    onExtensionMissing: () => {
      if (browserLaunchAttempted) return;
      browserLaunchAttempted = true;
      toast('warning', 'Browser extension not connected', 'Open Edge or Chrome with the A.I.M. extension and pair it in Settings → Extension.');
      void ctx.router?.call({ name: 'app_launch', args: { target: 'browser' } }).catch(() => undefined);
    },
  });
  hub.toolHandler = (p) => ctx.router!.call(p);

  // Health
  ctx.health = new HealthMonitor({
    settings,
    hub,
    version: app.getVersion(),
    paths: () => ({ userData: paths.userData, logs: paths.logs, extensionDir: paths.extensionDir, docsDir: paths.docsDir }),
    update: () => ctx.updater?.getStatus(),
    observerSamples: () => ctx.services?.observer.sampleCount() ?? 0,
    detectCli: async (explicit) => {
      if (!core) return { found: false, error: 'core unavailable' };
      return core.ClaudeCliBridge.detect(explicit);
    },
  });

  // Self-update (GitHub Releases)
  ctx.updater = new UpdateService({
    settings: () => settings.get(),
    isPackaged: app.isPackaged,
    currentVersion: app.getVersion(),
    builtInRepo: readBuiltInRepo(process.resourcesPath, (p) => fs.readFileSync(p, 'utf8')),
    log: log.child('updater'),
    onStatus: (status) => {
      emitGlobal({ type: 'update', status });
      if (status.state === 'downloaded') toast('success', `A.I.M. ${status.latestVersion ?? ''} is ready to install`, 'It installs when you quit, or use Settings → Updates → Restart and update.');
      else if (status.state === 'available' && status.manual) toast('info', `Version ${status.latestVersion ?? ''} is available`, 'You are running from source. Download the installer from Settings → Updates to switch to automatic updates.');
      else if (status.state === 'available') toast('info', `Update ${status.latestVersion ?? ''} available`, 'Download it from Settings → Updates.');
    },
  });
  ctx.updater.start();

  // IPC
  registerIpc(ctx, {
    onSettingsUpdated: (next, patch) => applySettingsPatch(ctx, next, patch, { shortcut: registerShortcut, tray }),
  });

  // Window
  mainWindow.create();
  if (ctx.startupError) {
    log.error(`startup error: ${ctx.startupError}`);
    mainWindow.showHealthPage(`${APP_NAME} started with errors. Some features are unavailable.`, ctx.startupError);
    setTimeout(() => {
      dialog.showMessageBox({ type: 'error', title: APP_NAME, message: `${APP_NAME} started with errors`, detail: ctx.startupError!.slice(0, 2000), buttons: ['OK'] }).catch(() => undefined);
    }, 300);
  }

  // Tray
  const tray = new AppTray(
    {
      openWindow: () => mainWindow.show(),
      planGoals: () => {
        const s = ctx.services;
        if (!s) return toast('error', 'Goal planning unavailable', ctx.startupError);
        mainWindow.show();
        s.planner
          .planToday(true)
          .then((plan) => {
            emitGlobal({ type: 'goals.plan', plan });
            emitGlobal({ type: 'goals.updated', goals: s.goals.list() });
          })
          .catch((err) => toast('error', 'Goal planning failed', (err as Error).message));
      },
      toggleObserver: () => {
        const s = ctx.services;
        if (!s) return;
        ctx.observerPaused = !ctx.observerPaused;
        if (ctx.observerPaused) s.observer.stop();
        else if (settings.get().observerEnabled) s.observer.start();
        tray.refresh();
        toast('info', ctx.observerPaused ? 'Behaviour observer paused' : 'Behaviour observer resumed');
      },
      isObserverPaused: () => ctx.observerPaused || !settings.get().observerEnabled,
      quit: () => app.quit(),
    },
    [path.join(paths.assets, 'icons', process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'), path.join(paths.assets, 'icons', 'icon-16.png')],
    log.child('tray'),
  );
  tray.create();

  // Shortcut + login item
  function registerShortcut(accelerator: string): void {
    globalShortcut.unregisterAll();
    if (!accelerator) return;
    try {
      const ok = globalShortcut.register(accelerator, () => mainWindow.toggle());
      if (!ok) log.warn(`global shortcut ${accelerator} could not be registered (in use?)`);
    } catch (err) {
      log.warn(`global shortcut error: ${(err as Error).message}`);
    }
  }
  registerShortcut(settings.get().toggleShortcut);
  applyLoginItem(settings.get().launchAtLogin, log);

  // Event wiring
  wireEvents(ctx, tray);

  // Start background services
  const s = ctx.services;
  if (s) {
    if (settings.get().observerEnabled) safeCall(() => s.observer.start(), log, 'observer.start');
    safeCall(() => s.scheduler.start(), log, 'scheduler.start');
  }

  // Health push every 5 s when changed
  const healthTimer = setInterval(() => {
    ctx.health
      ?.getIfChanged()
      .then((h) => h && emitGlobal({ type: 'health', health: h }))
      .catch(() => undefined);
  }, 5_000);

  app.on('second-instance', () => mainWindow.show());
  app.on('activate', () => mainWindow.show());
  app.on('window-all-closed', () => {
    /* tray app: keep running */
  });

  let shuttingDown = false;
  app.on('before-quit', (e) => {
    if (shuttingDown) return;
    e.preventDefault();
    shuttingDown = true;
    mainWindow.setQuitting(true);
    clearInterval(healthTimer);
    shutdown(ctx, tray)
      .catch((err) => log.error(`shutdown error: ${(err as Error).message}`))
      .finally(() => app.exit(0));
  });

  log.info('ready');
}

async function buildCoreServices(ctx: AppContext, core: typeof Core): Promise<CoreServices> {
  const { settings, paths, hub, log } = ctx;
  const db = core.openDatabase(paths.db);
  const chatStore = new core.ChatStore(db);

  const detected = await core.ClaudeCliBridge.detect(settings.get().claudeCliPath || undefined).catch(() => ({ found: false }) as Awaited<ReturnType<typeof core.ClaudeCliBridge.detect>>);
  // An explicit path configured in Settings always wins (it may be a command line such as "node wrapper.js");
  // auto-detection only fills the gap when nothing is configured.
  const configured = settings.get().claudeCliPath.trim();
  const cliPath = configured.length > 0 ? configured : detected.found && detected.path ? detected.path : undefined;
  if (!detected.found && configured.length === 0) log.warn('claude CLI not detected; chats will fail until it is installed or configured in Settings');
  const cli = new core.ClaudeCliBridge({ cliPath, log: log.child('cli') });

  const memory = new core.MemoryStore(db);
  const observer = new core.BehaviorObserver({
    db,
    provider: { getActiveWindow: () => ctx.activeWindow.getActiveWindow() },
    sampleMs: OBSERVER_SAMPLE_MS,
    log: log.child('observer'),
  });
  const directives = new core.DirectiveStore(db);
  const goals = new core.GoalStore(db);
  const reflector = new core.Reflector({ runner: cli, memory, settings: settings.getter, log: log.child('reflector') });

  const chatService = new core.ChatService({
    store: chatStore,
    cli,
    settings: settings.getter,
    buildMcpConfig: (chatId) => buildMcpConfig(chatId, { hubToolsUrl: () => hub.toolsUrl, hubToken: () => settings.get().hubToken, isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, log }),
    memoryDigest: async () => safeCall(() => memory.digest(), log, 'memory.digest') ?? '',
    extensionConnected: () => hub.extensionConnected,
    behaviorDigest: async () => {
      const digest = settings.get().observerEnabled ? (safeCall(() => observer.digest(), log, 'observer.digest') ?? '') : '';
      const extras = buildSystemPromptExtras({ extensionConnected: hub.extensionConnected, userName: currentUserName(), settings: settings.get(), hubPort: hub.actualPort });
      return [digest, extras].filter(Boolean).join('\n\n');
    },
    onTurnComplete: async (chat, turnMessages) => {
      if (!settings.get().reflectionEnabled) return;
      try {
        const r = await reflector.reflect(chat, turnMessages);
        if (r.memories.length) {
          emitGlobal({ type: 'memory.updated', count: memory.count() });
          const last = [...turnMessages].reverse().find((m) => m.role === 'assistant');
          // Reflection memories that the model did not already announce through memory_remember.
          const announced = new Set(
            turnMessages.flatMap((m) => m.content.filter((b) => b.type === 'tool_use' && /memory_remember$/.test(b.name)).map((b) => String((b.type === 'tool_use' && (b.input as { key?: string })?.key) ?? ''))),
          );
          const fresh = r.memories.filter((m) => !announced.has(m.key));
          if (last && fresh.length) chatService.addLearnedNote(chat.id, last.id, fresh.map((m) => ({ key: m.key, value: m.value })));
        }
        if (r.chatTitle && (!chat.title || /^new chat$/i.test(chat.title.trim()))) chatService.renameChat(chat.id, r.chatTitle);
      } catch (err) {
        log.warn(`reflection failed: ${(err as Error).message}`);
      }
    },
    log: log.child('chat'),
  });

  const planner = new core.GoalPlanner({ runner: cli, directives, goals, memory, observer, settings: settings.getter, log: log.child('planner') });
  const goalRunner = new core.GoalRunner({ goals, chats: chatService, settings: settings.getter, log: log.child('goals') });
  const scheduler = new core.Scheduler({ planner, runner: goalRunner, settings: settings.getter, log: log.child('scheduler') });

  return { db, chatStore, cli, chatService, memory, observer, directives, goals, planner, goalRunner, scheduler, reflector };
}

function wireEvents(ctx: AppContext, tray: AppTray): void {
  const { hub, services, log } = ctx;
  services?.chatService.on((e: ChatStreamEvent) => {
    emitChat(e);
    if (e.type === 'ask_user' && !ctx.mainWindow.browserWindow?.isVisible()) {
      toast('info', 'A.I.M. has a question', e.question);
    }
  });
  services?.scheduler.onPlan((plan: DailyPlan) => {
    emitGlobal({ type: 'goals.plan', plan });
    emitGlobal({ type: 'goals.updated', goals: services.goals.list() });
    toast('success', "Today's goals are planned", plan.summary);
  });
  hub.on('extension', (st: { connected: boolean; browser?: string }) => {
    ctx.health
      ?.get()
      .then((h) => emitGlobal({ type: 'health', health: h }))
      .catch(() => undefined);
    toast(st.connected ? 'success' : 'warning', st.connected ? `Browser extension connected${st.browser ? ` (${st.browser})` : ''}` : 'Browser extension disconnected');
  });
  hub.on('ext.event', (ev: ExtEvent) => {
    if (ev.type === 'user.activity' && services && !ctx.observerPaused && ctx.settings.get().observerEnabled) {
      safeCall(() => services.observer.recordBrowserActivity({ url: ev.url, title: ev.title, kind: ev.kind }), log, 'recordBrowserActivity');
    }
    if (ev.type === 'policy.blocked') toast('warning', 'Payment step blocked', ev.reason);
  });
  ctx.settings.onChange((s) => {
    tray.refresh();
    void s;
  });
}

function applySettingsPatch(ctx: AppContext, next: Settings, patch: Partial<Settings>, deps: { shortcut: (acc: string) => void; tray: AppTray }): void {
  const { log, services } = ctx;
  if (patch.toggleShortcut !== undefined) deps.shortcut(next.toggleShortcut);
  if (patch.launchAtLogin !== undefined) applyLoginItem(next.launchAtLogin, log);
  if (patch.observerEnabled !== undefined && services) {
    if (next.observerEnabled && !ctx.observerPaused) safeCall(() => services.observer.start(), log, 'observer.start');
    else safeCall(() => services.observer.stop(), log, 'observer.stop');
    deps.tray.refresh();
  }
  if (patch.claudeCliPath !== undefined) {
    ctx.health?.invalidateCli();
    log.info('claude CLI path changed; the new path is used for new CLI processes after restart');
  }
  if (patch.hubPort !== undefined && next.hubPort !== ctx.hub.actualPort) {
    toast('info', 'Hub port change takes effect after restart', `Currently listening on ${ctx.hub.actualPort}.`);
  }
  if (patch.hubToken !== undefined) toast('info', 'Pairing token updated', 'Re-pair the browser extension with the new token.');
  if (
    patch.updatesEnabled !== undefined ||
    patch.updatesRepo !== undefined ||
    patch.updatesAutoDownload !== undefined ||
    patch.updatesAllowPrerelease !== undefined ||
    patch.updatesToken !== undefined ||
    patch.updatesCheckIntervalHours !== undefined
  ) {
    ctx.updater?.reconfigure();
  }
  if (patch.dailyGoalsEnabled !== undefined || patch.dailyGoalsTime !== undefined) {
    if (services) {
      safeCall(() => services.scheduler.stop(), log, 'scheduler.stop');
      safeCall(() => services.scheduler.start(), log, 'scheduler.start');
    }
  }
}

function applyLoginItem(enabled: boolean, log: { warn(...a: unknown[]): void }): void {
  if (!app.isPackaged) return; // do not register the dev electron binary
  try {
    app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true, args: ['--hidden'] });
  } catch (err) {
    log.warn(`setLoginItemSettings failed: ${(err as Error).message}`);
  }
}

async function shutdown(ctx: AppContext, tray: AppTray): Promise<void> {
  const { log, services } = ctx;
  log.info('shutting down');
  ctx.updater?.dispose();
  globalShortcut.unregisterAll();
  safeCall(() => services?.chatService.dispose(), log, 'chatService.dispose');
  safeCall(() => services?.observer.stop(), log, 'observer.stop');
  safeCall(() => services?.scheduler.stop(), log, 'scheduler.stop');
  await ctx.hub.stop().catch((err) => log.warn(`hub.stop failed: ${(err as Error).message}`));
  safeCall(() => ctx.overlay.dispose(), log, 'overlay.dispose');
  safeCall(() => tray.destroy(), log, 'tray.destroy');
  safeCall(() => services?.db.close(), log, 'db.close');
  for (const w of BrowserWindow.getAllWindows()) safeCall(() => w.destroy(), log, 'window.destroy');
  log.info('bye');
}

function safeCall<T>(fn: () => T, log: { warn(...a: unknown[]): void }, label: string): T | undefined {
  try {
    return fn();
  } catch (err) {
    log.warn(`${label} failed: ${(err as Error).message}`);
    return undefined;
  }
}

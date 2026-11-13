/**
 * IPC handlers implementing AimApi (shared/ipc.ts) for the renderer, plus event forwarding
 * (ChatStreamEvent → IPC.event_chat, GlobalEvent → IPC.event_global).
 */
import { BrowserWindow, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { IPC, type AimApi, type Attachment, type ChatStreamEvent, type GlobalEvent, type Settings, newId, todayISO } from '@aim/shared';
import type { AppContext } from './context.js';
import { orderedDisplays } from './tools/screen.js';

export interface IpcHooks {
  onSettingsUpdated?: (settings: Settings, patch: Partial<Settings>) => void;
}

export function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed() && w.title !== 'A.I.M. cursor') {
      try {
        w.webContents.send(channel, payload);
      } catch {
        /* window closing */
      }
    }
  }
}

export function emitGlobal(e: GlobalEvent): void {
  broadcast(IPC.event_global, e);
}
export function emitChat(e: ChatStreamEvent): void {
  broadcast(IPC.event_chat, e);
}
export function toast(level: 'info' | 'success' | 'warning' | 'error', title: string, body?: string): void {
  emitGlobal({ type: 'toast', level, title, body });
}

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

export function registerIpc(ctx: AppContext, hooks: IpcHooks = {}): () => void {
  const log = ctx.log.child('ipc');
  const channels: string[] = [];

  const svc = () => {
    const s = ctx.services?.chatService;
    if (!s) throw new Error(ctx.startupError ? `A.I.M. core is unavailable: ${ctx.startupError}` : 'A.I.M. core is not ready yet.');
    return s;
  };
  const learn = () => {
    const s = ctx.services;
    if (!s) throw new Error(ctx.startupError ? `A.I.M. core is unavailable: ${ctx.startupError}` : 'A.I.M. core is not ready yet.');
    return s;
  };

  const handle = (channel: string, fn: Handler) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        return await fn(event, ...args);
      } catch (err) {
        log.warn(`${channel} failed: ${(err as Error).message}`);
        throw err instanceof Error ? err : new Error(String(err));
      }
    });
    channels.push(channel);
  };

  const str = (v: unknown, name: string): string => {
    if (typeof v !== 'string') throw new Error(`${name} must be a string`);
    return v;
  };

  // chats
  handle(IPC.chats_list, () => svc().listChats());
  handle(IPC.chats_get, (_e, id) => {
    const chat = svc().getChat(str(id, 'chatId'));
    return chat ? limitChatImages(chat) : chat;
  });
  handle(IPC.chats_create, (_e, input) => {
    const i = (input && typeof input === 'object' ? input : {}) as Parameters<AimApi['createChat']>[0];
    const cwd = i?.cwd || ctx.settings.get().defaultCwd || undefined;
    return svc().createChat({ title: i?.title, cwd, origin: 'user' });
  });
  handle(IPC.chats_rename, (_e, id, title) => svc().renameChat(str(id, 'chatId'), str(title, 'title')));
  handle(IPC.chats_delete, (_e, id) => svc().deleteChat(str(id, 'chatId')));
  handle(IPC.chats_pin, (_e, id, pinned) => svc().setPinned(str(id, 'chatId'), !!pinned));
  handle(IPC.chats_archive, (_e, id, archived) => svc().setArchived(str(id, 'chatId'), !!archived));
  handle(IPC.chats_send, async (_e, input) => {
    const i = input as Parameters<AimApi['sendMessage']>[0];
    if (!i || typeof i.chatId !== 'string') throw new Error('sendMessage requires chatId');
    await svc().sendMessage({ chatId: i.chatId, text: typeof i.text === 'string' ? i.text : '', attachments: Array.isArray(i.attachments) ? i.attachments : undefined });
  });
  handle(IPC.chats_stop, (_e, id) => svc().stop(str(id, 'chatId')));
  handle(IPC.chats_answer, (_e, id, requestId, answer) => svc().answerQuestion(str(id, 'chatId'), str(requestId, 'requestId'), typeof answer === 'string' ? answer : String(answer ?? '')));
  handle(IPC.chats_search, (_e, q) => svc().search(str(q, 'query')));

  // screen
  handle(IPC.screen_capture, async (): Promise<Attachment> => {
    const router = ctx.router;
    if (!router) throw new Error('Tools are not ready.');
    const res = await router.call({ name: 'screen_capture', args: { scale: 0.75 } });
    const img = res.images?.[0];
    if (!res.ok || !img) throw new Error(res.error ?? 'Screenshot failed.');
    const d = orderedDisplays()[0];
    return { kind: 'screenshot', name: `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`, mediaType: img.mediaType, dataBase64: img.dataBase64, ...(d ? {} : {}) };
  });

  // settings & health
  handle(IPC.settings_get, () => ctx.settings.get());
  handle(IPC.settings_update, (_e, patch) => {
    const p = (patch && typeof patch === 'object' ? patch : {}) as Partial<Settings>;
    const next = ctx.settings.update(p);
    hooks.onSettingsUpdated?.(next, p);
    emitGlobal({ type: 'settings', settings: next });
    return next;
  });
  handle(IPC.health_get, async () => {
    if (!ctx.health) throw new Error('Health monitor unavailable.');
    return ctx.health.get();
  });
  handle(IPC.cli_detect, async () => {
    if (!ctx.health) throw new Error('Health monitor unavailable.');
    return ctx.health.cli(true);
  });
  handle(IPC.update_check, async () => {
    if (!ctx.updater) throw new Error('Updater unavailable.');
    return ctx.updater.check();
  });
  handle(IPC.update_download, async () => {
    if (!ctx.updater) throw new Error('Updater unavailable.');
    return ctx.updater.download();
  });
  handle(IPC.update_install, async () => {
    if (!ctx.updater) throw new Error('Updater unavailable.');
    if (!ctx.updater.install()) throw new Error('No downloaded update to install yet.');
  });

  // learning
  handle(IPC.memory_list, (_e, q) => {
    const m = learn().memory;
    return typeof q === 'string' && q.trim() ? m.recall(q, 200) : m.list();
  });
  handle(IPC.memory_delete, (_e, key) => {
    learn().memory.forget(str(key, 'key'));
    emitGlobal({ type: 'memory.updated', count: learn().memory.count() });
  });
  handle(IPC.memory_upsert, (_e, entry) => {
    const e = entry as Parameters<AimApi['upsertMemory']>[0];
    if (!e || typeof e.key !== 'string' || typeof e.value !== 'string') throw new Error('upsertMemory requires key and value');
    learn().memory.remember({ key: e.key, value: e.value, kind: e.kind ?? 'fact', source: 'user', confidence: 1 });
    emitGlobal({ type: 'memory.updated', count: learn().memory.count() });
  });
  handle(IPC.behavior_summary, (_e, days) => learn().observer.summary(typeof days === 'number' ? days : 7));

  // goals / directives
  handle(IPC.directives_list, () => learn().directives.list());
  handle(IPC.directives_add, (_e, text, priority) => {
    const d = learn().directives.add(str(text, 'text'), priority === 1 || priority === 2 || priority === 3 ? priority : 2);
    emitGlobal({ type: 'directives.updated', directives: learn().directives.list() });
    return d;
  });
  handle(IPC.directives_update, (_e, id, patch) => {
    learn().directives.update(str(id, 'id'), (patch && typeof patch === 'object' ? patch : {}) as Parameters<AimApi['updateDirective']>[1]);
    emitGlobal({ type: 'directives.updated', directives: learn().directives.list() });
  });
  handle(IPC.directives_delete, (_e, id) => {
    learn().directives.remove(str(id, 'id'));
    emitGlobal({ type: 'directives.updated', directives: learn().directives.list() });
  });
  handle(IPC.goals_list, (_e, opts) => learn().goals.list((opts && typeof opts === 'object' ? opts : undefined) as Parameters<AimApi['listGoals']>[0]));
  handle(IPC.goals_plan, async () => {
    const plan = await learn().planner.planToday(true);
    emitGlobal({ type: 'goals.plan', plan });
    emitGlobal({ type: 'goals.updated', goals: learn().goals.list() });
    return plan;
  });
  handle(IPC.goals_add, (_e, input) => {
    const i = (input && typeof input === 'object' ? input : {}) as { title?: unknown; rationale?: unknown; date?: unknown; priority?: unknown };
    const title = typeof i.title === 'string' ? i.title.trim() : '';
    if (!title) throw new Error('A goal needs a title.');
    const today = todayISO();
    const date = typeof i.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(i.date) ? i.date : today;
    const p = Number(i.priority);
    const now = Date.now();
    const goal = learn().goals.upsert({
      id: newId('goal'),
      date,
      title: title.slice(0, 300),
      rationale: typeof i.rationale === 'string' ? i.rationale.trim().slice(0, 2000) : '',
      status: 'planned',
      priority: (p === 1 || p === 2 || p === 3 ? p : 2) as 1 | 2 | 3,
      effort: 'medium',
      origin: 'user',
      createdAt: now,
      updatedAt: now,
      scheduledAt: now,
    });
    emitGlobal({ type: 'goals.updated', goals: learn().goals.list() });
    // Today's goals start on their own (one at a time, after anything already running).
    if (date === today && ctx.settings.get().autoRunGoals) {
      void learn()
        .goalRunner.runPending(today)
        .then(() => emitGlobal({ type: 'goals.updated', goals: learn().goals.list() }))
        .catch((err: Error) => log.warn(`running goals failed: ${err.message}`));
    }
    return goal;
  });
  handle(IPC.goals_delete, async (_e, goalId) => {
    const id = str(goalId, 'goalId');
    const goal = learn().goals.get(id);
    if (!goal) return;
    if (goal.status === 'in_progress' && goal.chatId && ctx.services?.chatService.isBusy(goal.chatId)) {
      await ctx.services.chatService.stop(goal.chatId).catch(() => undefined);
    }
    learn().goals.remove(id);
    emitGlobal({ type: 'goals.updated', goals: learn().goals.list() });
  });
  handle(IPC.goals_run, async (_e, goalId) => {
    const r = await learn().goalRunner.runGoal(str(goalId, 'goalId'));
    emitGlobal({ type: 'goals.updated', goals: learn().goals.list() });
    return r;
  });

  // window & shell
  handle(IPC.window_minimize, (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
  handle(IPC.window_maximize, (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w) return;
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
  });
  handle(IPC.window_close, (e) => BrowserWindow.fromWebContents(e.sender)?.close());
  handle(IPC.shell_openExternal, async (_e, url) => {
    const u = str(url, 'url');
    if (!/^(https?|mailto):/i.test(u)) throw new Error('Only http(s) and mailto links can be opened.');
    await shell.openExternal(u);
  });
  handle(IPC.shell_openPath, async (_e, p) => {
    const err = await shell.openPath(str(p, 'path'));
    if (err) throw new Error(err);
  });

  return () => {
    for (const c of channels) ipcMain.removeHandler(c);
  };
}

/**
 * Long agent chats can hold dozens of screenshots. Sending all of them to the interface at once can
 * exhaust the renderer's memory (a blank window), so only the newest images up to a byte budget are
 * sent; older tool thumbnails are dropped and older attached images become a short note. The database
 * keeps everything.
 */
export const CHAT_IMAGE_BUDGET_BYTES = 12 * 1024 * 1024;
export function limitChatImages<T extends { messages: { content: unknown[] }[] }>(chat: T, budget = CHAT_IMAGE_BUDGET_BYTES): T {
  let used = 0;
  const messages = chat.messages.map((m) => ({ ...m, content: [...m.content] }));
  for (let mi = messages.length - 1; mi >= 0; mi--) {
    const content = messages[mi]!.content as Record<string, unknown>[];
    for (let bi = content.length - 1; bi >= 0; bi--) {
      const b = content[bi];
      if (!b || typeof b !== 'object') continue;
      if (b['type'] === 'image' && typeof b['dataBase64'] === 'string') {
        const size = (b['dataBase64'] as string).length;
        if (used + size > budget) content[bi] = { type: 'status', text: 'Older image not shown to keep A.I.M. responsive.' };
        else used += size;
      } else if (b['type'] === 'tool_use') {
        const result = b['result'] as Record<string, unknown> | undefined;
        const img = result?.['imageBase64'];
        if (typeof img === 'string') {
          if (used + img.length > budget) content[bi] = { ...b, result: { ...result, imageBase64: undefined } };
          else used += img.length;
        }
      }
    }
  }
  return { ...chat, messages } as T;
}

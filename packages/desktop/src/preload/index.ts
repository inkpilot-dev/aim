/**
 * Preload: exposes `window.aim` (AimApi from @aim/shared) to the renderer through contextBridge.
 * Every method is an ipcRenderer.invoke; event subscriptions return an unsubscribe function.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, type AimApi, type ChatStreamEvent, type GlobalEvent } from '@aim/shared';

function subscribe<T>(channel: string, cb: (e: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: AimApi & { platform: NodeJS.Platform; versions: { electron: string; chrome: string; node: string } } = {
  // chats
  listChats: () => ipcRenderer.invoke(IPC.chats_list),
  getChat: (chatId) => ipcRenderer.invoke(IPC.chats_get, chatId),
  createChat: (input) => ipcRenderer.invoke(IPC.chats_create, input ?? {}),
  renameChat: (chatId, title) => ipcRenderer.invoke(IPC.chats_rename, chatId, title),
  deleteChat: (chatId) => ipcRenderer.invoke(IPC.chats_delete, chatId),
  pinChat: (chatId, pinned) => ipcRenderer.invoke(IPC.chats_pin, chatId, pinned),
  archiveChat: (chatId, archived) => ipcRenderer.invoke(IPC.chats_archive, chatId, archived),
  sendMessage: (input) => ipcRenderer.invoke(IPC.chats_send, input),
  stopChat: (chatId) => ipcRenderer.invoke(IPC.chats_stop, chatId),
  answerQuestion: (chatId, requestId, answer) => ipcRenderer.invoke(IPC.chats_answer, chatId, requestId, answer),
  searchChats: (query) => ipcRenderer.invoke(IPC.chats_search, query),
  // screen
  captureScreenshot: () => ipcRenderer.invoke(IPC.screen_capture),
  // settings & health
  getSettings: () => ipcRenderer.invoke(IPC.settings_get),
  updateSettings: (patch) => ipcRenderer.invoke(IPC.settings_update, patch),
  getHealth: () => ipcRenderer.invoke(IPC.health_get),
  detectCli: () => ipcRenderer.invoke(IPC.cli_detect),
  checkForUpdates: () => ipcRenderer.invoke(IPC.update_check),
  downloadUpdate: () => ipcRenderer.invoke(IPC.update_download),
  installUpdate: () => ipcRenderer.invoke(IPC.update_install),
  // learning
  listMemories: (query) => ipcRenderer.invoke(IPC.memory_list, query),
  deleteMemory: (key) => ipcRenderer.invoke(IPC.memory_delete, key),
  upsertMemory: (entry) => ipcRenderer.invoke(IPC.memory_upsert, entry),
  getBehaviorSummary: (days) => ipcRenderer.invoke(IPC.behavior_summary, days),
  // goals
  listDirectives: () => ipcRenderer.invoke(IPC.directives_list),
  addDirective: (text, priority) => ipcRenderer.invoke(IPC.directives_add, text, priority),
  updateDirective: (id, patch) => ipcRenderer.invoke(IPC.directives_update, id, patch),
  deleteDirective: (id) => ipcRenderer.invoke(IPC.directives_delete, id),
  listGoals: (opts) => ipcRenderer.invoke(IPC.goals_list, opts),
  planGoalsNow: () => ipcRenderer.invoke(IPC.goals_plan),
  runGoal: (goalId) => ipcRenderer.invoke(IPC.goals_run, goalId),
  addGoal: (input) => ipcRenderer.invoke(IPC.goals_add, input),
  deleteGoal: (goalId) => ipcRenderer.invoke(IPC.goals_delete, goalId),
  // window
  minimize: () => void ipcRenderer.invoke(IPC.window_minimize),
  maximize: () => void ipcRenderer.invoke(IPC.window_maximize),
  close: () => void ipcRenderer.invoke(IPC.window_close),
  openExternal: (url) => ipcRenderer.invoke(IPC.shell_openExternal, url),
  openPath: (path) => ipcRenderer.invoke(IPC.shell_openPath, path),
  // events
  onChatEvent: (cb) => subscribe<ChatStreamEvent>(IPC.event_chat, cb),
  onGlobalEvent: (cb) => subscribe<GlobalEvent>(IPC.event_global, cb),
  // extras
  platform: process.platform,
  versions: { electron: process.versions.electron ?? '', chrome: process.versions.chrome ?? '', node: process.versions.node ?? '' },
};

contextBridge.exposeInMainWorld('aim', api);

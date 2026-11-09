import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react';
import type { Attachment, Chat, Message, Settings } from '@aim/shared';
import { initialState, nextId, reducer, type Action, type Toast, type UiState, type View } from './reducer';
import { useChatStream } from './useChatStream';

const PREFS_KEY = 'aim.ui.prefs';

interface Prefs {
  sidebarCollapsed?: boolean;
  lastChatId?: string | null;
  view?: View;
}

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? (JSON.parse(raw) as Prefs) : {};
  } catch {
    return {};
  }
}

function savePrefs(p: Prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...loadPrefs(), ...p }));
  } catch {
    /* ignore */
  }
}

export interface StoreApi {
  state: UiState;
  dispatch: (a: Action) => void;
  setView: (v: View) => void;
  selectChat: (chatId: string | null) => void;
  newChat: () => Promise<void>;
  refreshChats: () => Promise<void>;
  renameChat: (chatId: string, title: string) => Promise<void>;
  pinChat: (chatId: string, pinned: boolean) => Promise<void>;
  archiveChat: (chatId: string, archived: boolean) => Promise<void>;
  deleteChat: (chatId: string) => Promise<void>;
  send: (text: string, attachments?: Attachment[]) => Promise<void>;
  stop: () => Promise<void>;
  answer: (requestId: string, answer: string) => Promise<void>;
  updateSettings: (patch: Partial<Settings>) => Promise<void>;
  refreshHealth: () => Promise<void>;
  toast: (level: Toast['level'], title: string, body?: string) => void;
  toggleSidebar: () => void;
  toggleAgents: () => void;
}

const StoreContext = createContext<StoreApi | null>(null);

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState, (init) => {
    const prefs = loadPrefs();
    return {
      ...init,
      sidebarCollapsed: prefs.sidebarCollapsed ?? false,
      currentChatId: prefs.lastChatId ?? null,
      currentLoading: !!prefs.lastChatId,
      view: prefs.view ?? 'chats',
    };
  });
  const stateRef = useRef(state);
  stateRef.current = state;

  useChatStream(dispatch);

  const toast = useCallback((level: Toast['level'], title: string, body?: string) => {
    dispatch({ type: 'toast.add', toast: { id: nextId('t'), level, title, body } });
  }, []);

  const refreshChats = useCallback(async () => {
    try {
      const chats = await window.aim.listChats();
      dispatch({ type: 'chats.set', chats });
    } catch (e) {
      toast('error', 'Could not load chats', errMessage(e));
    }
  }, [toast]);

  const refreshHealth = useCallback(async () => {
    try {
      dispatch({ type: 'health.set', health: await window.aim.getHealth() });
    } catch {
      /* health is best-effort */
    }
  }, []);

  // Initial load.
  useEffect(() => {
    void refreshChats();
    void refreshHealth();
    window.aim
      .getSettings()
      .then((settings) => dispatch({ type: 'settings.set', settings }))
      .catch((e) => toast('error', 'Could not load settings', errMessage(e)));
    const t = window.setInterval(() => void refreshHealth(), 30_000);
    return () => window.clearInterval(t);
  }, [refreshChats, refreshHealth, toast]);

  // Load the selected chat.
  useEffect(() => {
    const id = state.currentChatId;
    if (!id) return;
    let cancelled = false;
    dispatch({ type: 'chat.loading', chatId: id });
    window.aim
      .getChat(id)
      .then((chat) => {
        if (cancelled) return;
        if (chat) dispatch({ type: 'chat.loaded', chat });
        else {
          dispatch({ type: 'chat.remove', chatId: id });
          savePrefs({ lastChatId: null });
        }
      })
      .catch((e) => {
        if (cancelled) return;
        dispatch({ type: 'chat.loadFailed', chatId: id });
        toast('error', 'Could not open chat', errMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [state.currentChatId, toast]);

  // Persist prefs.
  useEffect(() => {
    savePrefs({ sidebarCollapsed: state.sidebarCollapsed, lastChatId: state.currentChatId, view: state.view });
  }, [state.sidebarCollapsed, state.currentChatId, state.view]);

  // Theme.
  useEffect(() => {
    const theme = state.settings?.theme ?? 'dark';
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const apply = () => {
      const resolved = theme === 'system' ? (mq.matches ? 'light' : 'dark') : theme;
      document.documentElement.setAttribute('data-theme', resolved);
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [state.settings?.theme]);

  const api = useMemo<StoreApi>(() => {
    const setView = (view: View) => dispatch({ type: 'view', view });
    const selectChat = (chatId: string | null) => dispatch({ type: 'chat.select', chatId });
    const withChat = (fn: (chatId: string) => Promise<void>) => async () => {
      const id = stateRef.current.currentChatId;
      if (id) await fn(id);
    };
    return {
      state,
      dispatch,
      setView,
      selectChat,
      toast,
      refreshChats,
      refreshHealth,
      toggleSidebar: () => dispatch({ type: 'sidebar.toggle' }),
      toggleAgents: () => dispatch({ type: 'agents.toggle' }),
      newChat: async () => {
        // Reuse an empty idle chat instead of piling up blanks.
        const s = stateRef.current;
        if (s.current && s.current.messages.length === 0 && s.current.status === 'idle' && s.view === 'chats') return;
        try {
          const cwd = s.settings?.defaultCwd || undefined;
          const chat = await window.aim.createChat(cwd ? { cwd } : undefined);
          dispatch({ type: 'chat.upsert', chat });
          selectChat(chat.id);
          dispatch({ type: 'chat.loaded', chat: { ...chat, messages: [], tasks: [], agents: [] } });
        } catch (e) {
          toast('error', 'Could not create chat', errMessage(e));
        }
      },
      renameChat: async (chatId, title) => {
        const trimmed = title.trim();
        if (!trimmed) return;
        dispatch({ type: 'chat.patch', chatId, patch: { title: trimmed } });
        try {
          await window.aim.renameChat(chatId, trimmed);
        } catch (e) {
          toast('error', 'Rename failed', errMessage(e));
          void refreshChats();
        }
      },
      pinChat: async (chatId, pinned) => {
        dispatch({ type: 'chat.patch', chatId, patch: { pinned } });
        try {
          await window.aim.pinChat(chatId, pinned);
        } catch (e) {
          toast('error', 'Could not update pin', errMessage(e));
          void refreshChats();
        }
      },
      archiveChat: async (chatId, archived) => {
        dispatch({ type: 'chat.patch', chatId, patch: { archived } });
        if (archived && stateRef.current.currentChatId === chatId) selectChat(null);
        try {
          await window.aim.archiveChat(chatId, archived);
        } catch (e) {
          toast('error', 'Could not archive', errMessage(e));
          void refreshChats();
        }
      },
      deleteChat: async (chatId) => {
        dispatch({ type: 'chat.remove', chatId });
        try {
          await window.aim.deleteChat(chatId);
        } catch (e) {
          toast('error', 'Delete failed', errMessage(e));
          void refreshChats();
        }
      },
      send: async (text, attachments) => {
        const s = stateRef.current;
        let chatId = s.currentChatId;
        try {
          if (!chatId) {
            const cwd = s.settings?.defaultCwd || undefined;
            const chat: Chat = await window.aim.createChat(cwd ? { cwd } : undefined);
            dispatch({ type: 'chat.upsert', chat });
            selectChat(chat.id);
            dispatch({ type: 'chat.loaded', chat: { ...chat, messages: [], tasks: [], agents: [] } });
            chatId = chat.id;
          }
          const local: Message = {
            id: `local-${Date.now().toString(36)}`,
            chatId,
            role: 'user',
            content: [
              ...(attachments ?? [])
                .filter((a) => a.dataBase64)
                .map((a) => ({ type: 'image' as const, mediaType: a.mediaType, dataBase64: a.dataBase64!, alt: a.name })),
              { type: 'text' as const, text },
            ],
            createdAt: Date.now(),
          };
          dispatch({ type: 'message.local', message: local });
          dispatch({ type: 'chat.patch', chatId, patch: { status: 'thinking', updatedAt: Date.now() } });
          dispatch({ type: 'notices.clear' });
          await window.aim.sendMessage({ chatId, text, attachments: attachments?.length ? attachments : undefined });
        } catch (e) {
          toast('error', 'Could not send message', errMessage(e));
          if (chatId) dispatch({ type: 'chat.patch', chatId, patch: { status: 'error' } });
        }
      },
      stop: withChat(async (chatId) => {
        try {
          await window.aim.stopChat(chatId);
        } catch (e) {
          toast('error', 'Could not stop', errMessage(e));
        }
      }),
      answer: async (requestId, answer) => {
        const chatId = stateRef.current.currentChatId;
        if (!chatId) return;
        dispatch({ type: 'chatEvent', event: { type: 'ask_user.resolved', chatId, requestId } });
        try {
          await window.aim.answerQuestion(chatId, requestId, answer);
        } catch (e) {
          toast('error', 'Could not send answer', errMessage(e));
        }
      },
      updateSettings: async (patch) => {
        const prev = stateRef.current.settings;
        if (prev) dispatch({ type: 'settings.set', settings: { ...prev, ...patch } });
        try {
          const next = await window.aim.updateSettings(patch);
          dispatch({ type: 'settings.set', settings: next });
        } catch (e) {
          if (prev) dispatch({ type: 'settings.set', settings: prev });
          toast('error', 'Could not save settings', errMessage(e));
        }
      },
    };
  }, [state, toast, refreshChats, refreshHealth]);

  return <StoreContext.Provider value={api}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreApi {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore must be used inside StoreProvider');
  return ctx;
}

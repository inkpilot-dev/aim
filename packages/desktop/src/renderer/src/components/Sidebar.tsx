import type { ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { Chat } from '@aim/shared';
import { useStore } from '../state/store';
import type { View } from '../state/reducer';
import { ChatList } from './ChatList';
import { IconBook, IconBrain, IconChat, IconChevronDown, IconDownload, IconPanelLeft, IconPlus, IconSearch, IconSettings, IconTarget } from './Icons';

const NAV: { view: View; label: string; icon: (p: { size?: number }) => ReactElement }[] = [
  { view: 'chats', label: 'Chats', icon: IconChat },
  { view: 'goals', label: 'Goals', icon: IconTarget },
  { view: 'memory', label: 'Memory', icon: IconBrain },
];

export function Sidebar() {
  const { state, newChat, setView, selectChat, toggleSidebar, toast } = useStore();
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Chat[] | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const accountRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(() => {
      window.aim
        .searchChats(q)
        .then((r) => {
          if (!cancelled) setResults(r);
        })
        .catch(() => {
          if (!cancelled) setResults(state.chats.filter((c) => c.title.toLowerCase().includes(q.toLowerCase())));
        });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [query, state.chats]);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node) && !accountRef.current?.contains(e.target as Node)) setMenu(null);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [menu]);

  const health = state.health;
  const name = health?.userName || 'You';
  const initial = name.charAt(0);
  const cliOk = !!health?.cli.found && health.cli.authenticated !== false;
  const extOk = !!health?.extension.connected;
  const update = state.update ?? health?.update ?? null;
  const updateReady = update?.state === 'downloaded' || update?.state === 'available';

  const openMenu = () => {
    const r = accountRef.current?.getBoundingClientRect();
    if (!r) return;
    setMenu({ x: r.left, y: r.top - 8 });
  };

  const startNewChat = () => {
    if (state.view !== 'chats') setView('chats');
    if (state.currentChatId && state.current && state.current.messages.length === 0) return;
    selectChat(null);
    void newChat();
  };

  return (
    <aside className={`sidebar ${state.sidebarCollapsed ? 'collapsed' : ''}`} aria-hidden={state.sidebarCollapsed}>
      <div className="sidebar-inner">
        <div className="sb-head">
          <button className="icon-btn" onClick={toggleSidebar} aria-label="Hide sidebar" data-tip="Hide sidebar" data-tip-pos="bottom">
            <IconPanelLeft size={16} />
          </button>
          <span className="wordmark">A.I.M.</span>
          <span className="sb-spacer" />
          <button className={`icon-btn ${searchOpen ? 'active' : ''}`} onClick={() => setSearchOpen((o) => !o)} aria-label="Search chats" data-tip="Search" data-tip-pos="bottom">
            <IconSearch size={16} />
          </button>
        </div>

        <button className="sb-new" onClick={startNewChat}>
          <span className="plus-circle">
            <IconPlus size={13} />
          </span>
          New chat
        </button>

        <nav className="sb-nav">
          {NAV.map((n) => (
            <button key={n.view} className={`nav-item ${state.view === n.view ? 'active' : ''}`} onClick={() => setView(n.view)}>
              <n.icon size={16} />
              {n.label}
            </button>
          ))}
        </nav>

        {searchOpen ? (
          <div className="sb-search">
            <IconSearch size={14} />
            <input className="input" autoFocus placeholder="Search your chats" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search chats" />
          </div>
        ) : null}

        <div className="sb-scroll">
          <ChatList chats={results ?? state.chats} searchActive={results !== null} />
        </div>

        <button ref={accountRef} className="sb-account" onClick={() => (menu ? setMenu(null) : openMenu())} aria-haspopup="menu" aria-expanded={!!menu}>
          <span className="avatar">{initial}</span>
          <span className="acc-text">
            <span className="acc-name truncate">{name}</span>
            <span className="acc-sub truncate">{updateReady ? 'Update ready' : cliOk ? 'A.I.M. desktop' : 'Claude CLI not connected'}</span>
          </span>
          <IconChevronDown className="chev" size={14} />
        </button>

        {menu ? (
          <div className="popover" ref={menuRef} role="menu" style={{ left: menu.x, bottom: window.innerHeight - menu.y, minWidth: 260 }}>
            <div className="pop-head">
              {name}
              <span className="acc-sub">Artificial Intelligence Management{health?.version ? ` · v${health.version}` : ''}</span>
            </div>
            <div className="pop-status">
              <span className={`dot ${!health ? '' : cliOk ? 'ok' : 'danger'}`} />
              {!health ? 'Checking Claude CLI…' : cliOk ? `Claude CLI ${health.cli.version ?? ''}`.trim() : health.cli.found ? 'Claude CLI not signed in' : 'Claude CLI not found'}
            </div>
            <div className="pop-status">
              <span className={`dot ${!health ? '' : extOk ? 'ok' : ''}`} />
              {!health ? 'Checking extension…' : extOk ? `Browser extension connected${health.extension.browser ? ` · ${health.extension.browser}` : ''}` : 'Browser extension not connected'}
            </div>
            <div className="cm-sep" />
            <button
              onClick={() => {
                setView('settings');
                setMenu(null);
              }}
            >
              <IconSettings size={15} /> Settings
            </button>
            <button
              onClick={() => {
                const dir = health?.paths?.docsDir;
                if (dir) void window.aim.openPath(`${dir}/USAGE.md`);
                else toast('info', 'Documentation is in the docs folder of the A.I.M. installation.');
                setMenu(null);
              }}
            >
              <IconBook size={15} /> Documentation
            </button>
            <button
              onClick={() => {
                setMenu(null);
                void window.aim
                  .checkForUpdates()
                  .then((s) => {
                    if (s.state === 'available' || s.state === 'downloaded' || s.state === 'downloading') setView('settings');
                    else toast('info', s.state === 'not_available' ? 'A.I.M. is up to date.' : (s.message ?? s.error ?? 'Update check finished.'));
                  })
                  .catch((e) => toast('error', 'Update check failed', e instanceof Error ? e.message : String(e)));
              }}
            >
              <IconDownload size={15} /> {updateReady ? 'Install update' : 'Check for updates'}
            </button>
          </div>
        ) : null}
      </div>
    </aside>
  );
}

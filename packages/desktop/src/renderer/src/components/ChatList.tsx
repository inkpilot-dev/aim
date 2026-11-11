import { useEffect, useRef, useState } from 'react';
import type { Chat, ChatStatus } from '@aim/shared';
import { displayTitle, groupChats, splitChats, type ChatGroup } from '../lib/groupChats';
import { useStore } from '../state/store';
import { ProgressRing } from './ProgressRing';
import { IconArchive, IconChevronRight, IconEdit, IconMore, IconPin, IconTrash } from './Icons';

const STATUS_DOT: Partial<Record<ChatStatus, string>> = {
  waiting_user: 'warning',
  error: 'danger',
};

interface MenuState {
  chatId: string;
  x: number;
  y: number;
  confirmDelete: boolean;
}

export function ChatList({ chats, searchActive }: { chats: Chat[]; searchActive: boolean }) {
  const { state, selectChat, renameChat, pinChat, archiveChat, deleteChat } = useStore();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    window.addEventListener('blur', () => setMenu(null), { once: true });
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [menu]);

  const openMenu = (e: React.MouseEvent, chatId: string) => {
    e.preventDefault();
    e.stopPropagation();
    const x = Math.min(e.clientX, window.innerWidth - 180);
    const y = Math.min(e.clientY, window.innerHeight - 180);
    setMenu({ chatId, x, y, confirmDelete: false });
  };

  const commitRename = () => {
    if (renaming) void renameChat(renaming.id, renaming.value);
    setRenaming(null);
  };

  const { mine, aim } = splitChats(chats);
  const now = Date.now();
  const myGroups = groupChats(mine, now, { includeArchived: true });
  const aimGroups = groupChats(aim, now, { includeArchived: true });
  const aimRunning = aim.filter((c) => c.status === 'thinking' || c.status === 'working').length;
  const menuChat = menu ? chats.find((c) => c.id === menu.chatId) : null;

  const [aimOpen, setAimOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem('aim.ui.aimChatsOpen') !== '0';
    } catch {
      return true;
    }
  });
  const toggleAim = () =>
    setAimOpen((o) => {
      try {
        localStorage.setItem('aim.ui.aimChatsOpen', o ? '0' : '1');
      } catch {
        /* private mode */
      }
      return !o;
    });

  const renderGroups = (groups: ChatGroup[]) =>
    groups.map((g) => (
        <div key={g.key}>
          <div className="chat-group-label">{searchActive && g.key !== 'pinned' ? 'Results' : g.key === 'pinned' ? 'Starred' : g.label}</div>
          {g.chats.map((c) => {
            const active = c.id === state.currentChatId;
            const dot = STATUS_DOT[c.status];
            const active_ = c.status === 'thinking' || c.status === 'working';
            const hasTasks = (c.progress?.total ?? 0) > 0;
            return (
              <div
                key={c.id}
                className={`chat-row ${active ? 'active' : ''} ${menu?.chatId === c.id ? 'menu-open' : ''}`}
                onClick={() => selectChat(c.id)}
                onDoubleClick={() => setRenaming({ id: c.id, value: c.title })}
                onContextMenu={(e) => openMenu(e, c.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') selectChat(c.id);
                }}
              >
                <div className="row-title">
                  {renaming?.id === c.id ? (
                    <input
                      autoFocus
                      value={renaming.value}
                      onChange={(e) => setRenaming({ id: c.id, value: e.target.value })}
                      onBlur={commitRename}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename();
                        if (e.key === 'Escape') setRenaming(null);
                      }}
                      aria-label="Rename chat"
                    />
                  ) : (
                    displayTitle(c)
                  )}
                </div>
                <div className="row-meta">
                  {active_ && hasTasks ? <ProgressRing className="row-status" progress={c.progress} status={c.status} size={14} stroke={2} showLabel={false} /> : null}
                  {active_ && !hasTasks ? <span className="row-status cursor-blink" style={{ margin: 0, width: 6, height: 6 }} /> : null}
                  {dot ? <span className={`row-status dot ${dot}`} /> : null}
                  <button className="icon-btn row-menu" onClick={(e) => openMenu(e, c.id)} aria-label="Chat options">
                    <IconMore size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ))

  if (!chats.length) {
    return <div className="chat-list-empty">{searchActive ? 'No chats match your search.' : 'No chats yet. Start one above.'}</div>;
  }

  return (
    <div className="chat-list">
      {myGroups.length ? renderGroups(myGroups) : aim.length ? <div className="chat-list-empty">{searchActive ? 'None of your chats match.' : 'Your chats appear here.'}</div> : null}
      {aim.length ? (
        <div className="aim-section">
          <button className={`aim-section-head ${aimOpen ? 'open' : ''}`} onClick={toggleAim} aria-expanded={aimOpen}>
            <IconChevronRight className="chev" size={13} />
            <span>Started by A.I.M.</span>
            <span className="faint">{aimRunning ? `${aimRunning} working` : aim.length}</span>
          </button>
          {aimOpen ? renderGroups(aimGroups) : null}
        </div>
      ) : null}
      {menu && menuChat ? (
        <div className="context-menu" ref={menuRef} style={{ left: menu.x, top: menu.y }} role="menu">
          <button
            onClick={() => {
              setRenaming({ id: menuChat.id, value: menuChat.title });
              setMenu(null);
            }}
          >
            <IconEdit size={14} /> Rename
          </button>
          <button
            onClick={() => {
              void pinChat(menuChat.id, !menuChat.pinned);
              setMenu(null);
            }}
          >
            <IconPin size={14} /> {menuChat.pinned ? 'Unstar' : 'Star'}
          </button>
          <button
            onClick={() => {
              void archiveChat(menuChat.id, !menuChat.archived);
              setMenu(null);
            }}
          >
            <IconArchive size={14} /> {menuChat.archived ? 'Unarchive' : 'Archive'}
          </button>
          <div className="cm-sep" />
          {menu.confirmDelete ? (
            <button
              className="danger"
              onClick={() => {
                void deleteChat(menuChat.id);
                setMenu(null);
              }}
            >
              <IconTrash size={14} /> Confirm delete
            </button>
          ) : (
            <button className="danger" onClick={() => setMenu({ ...menu, confirmDelete: true })}>
              <IconTrash size={14} /> Delete
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

import { useEffect, useState } from 'react';
import type { ChatStatus } from '@aim/shared';
import { useStore } from '../state/store';
import { ProgressRing } from './ProgressRing';
import { AgentsPanel } from './AgentsPanel';
import { MessageList } from './MessageList';
import { Composer } from './Composer';
import { AimMark } from './AimMark';
import { IconChevronDown, IconEye, IconFolder, IconGlobe, IconMonitor, IconPanelLeft, IconTarget } from './Icons';

const STATUS_TEXT: Partial<Record<ChatStatus, string>> = {
  thinking: 'Thinking…',
  working: 'Working…',
  waiting_user: 'Waiting for you',
  error: 'Needs attention',
};

const SUGGESTIONS = [
  { icon: IconFolder, title: 'Organise my Downloads', prompt: 'Organise my Downloads folder into sensible subfolders by type and date. Ask before deleting anything.' },
  { icon: IconGlobe, title: 'Research in the background', prompt: 'Research the current state of local LLM inference on consumer GPUs in a background browser tab and summarise the findings with sources.' },
  { icon: IconTarget, title: 'Set a daily goal', prompt: 'Set up a daily goal: every morning, check my inbox for anything urgent and prepare a short briefing.' },
  { icon: IconMonitor, title: 'Read my screen', prompt: 'Take a screenshot of my screen, read the form that is open and tell me what is still missing before I submit it.' },
];

function greeting(name?: string): string {
  const h = new Date().getHours();
  const base = h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  return name ? `${base}, ${name}` : base;
}

export function ChatView() {
  const { state, send, stop, answer, renameChat, toggleAgents, toggleSidebar, setView, toast, updateSettings } = useStore();
  const chat = state.current;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    setEditing(false);
  }, [chat?.id]);

  const showThinking = state.settings?.showThinking ?? false;
  const showActivity = state.settings?.showToolActivity ?? false;
  const status: ChatStatus = chat?.status ?? 'idle';
  const busy = status === 'thinking' || status === 'working';
  const progress = chat?.progress;
  const hasTasks = (progress?.total ?? 0) > 0;
  const statusText = busy && progress?.label ? progress.label.replace(/^\d+\s*\/\s*\d+\s*(—|-)\s*/, '') : STATUS_TEXT[status];
  const runningAgents = chat?.agents.filter((a) => a.state === 'running' || a.state === 'spawning').length ?? 0;
  const isEmpty = !chat || chat.messages.length === 0;
  const modelLabel = state.settings?.model ? `Claude ${state.settings.model.charAt(0).toUpperCase()}${state.settings.model.slice(1)}` : 'Claude';

  const commitTitle = () => {
    if (chat && draft.trim() && draft.trim() !== chat.title) void renameChat(chat.id, draft);
    setEditing(false);
  };

  const composer = (variant: 'home' | 'docked') => (
    <Composer
      variant={variant}
      status={status}
      modelLabel={modelLabel}
      onModelClick={() => setView('settings')}
      onSend={(text, attachments) => void send(text, attachments)}
      onStop={() => void stop()}
      onError={(m) => toast('warning', m)}
      autoFocus
      draftKey={chat?.id ?? 'new'}
    />
  );

  return (
    <>
      <div className={`topbar ${state.sidebarCollapsed ? 'pad-left' : ''}`}>
        {state.sidebarCollapsed ? (
          <button className="icon-btn float-toggle" onClick={toggleSidebar} aria-label="Show sidebar" data-tip="Show sidebar" data-tip-pos="bottom">
            <IconPanelLeft size={16} />
          </button>
        ) : null}
        {chat && !isEmpty ? (
          editing ? (
            <span className="tb-title">
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commitTitle}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitTitle();
                  if (e.key === 'Escape') setEditing(false);
                }}
                aria-label="Chat title"
              />
            </span>
          ) : (
            <button
              className="tb-title"
              onClick={() => {
                setDraft(chat.title);
                setEditing(true);
              }}
              title="Rename"
            >
              <span className="truncate">{chat.title}</span>
              <IconChevronDown size={14} />
            </button>
          )
        ) : null}
        {chat && !isEmpty ? (
          <div className="tb-right">
            {statusText ? <span className="tb-status truncate">{statusText}</span> : null}
            <button
              className="tb-toggle"
              onClick={() => void updateSettings({ showToolActivity: !showActivity })}
              title={showActivity ? 'Collapse tool activity into one line per step' : 'Show every tool call'}
              aria-pressed={showActivity}
            >
              <IconEye size={14} />
              {showActivity ? 'Hide work' : 'Show work'}
            </button>
            {chat.agents.length ? (
              <button className={`tb-agents ${state.agentsPanelOpen ? 'open' : ''}`} onClick={toggleAgents} aria-expanded={state.agentsPanelOpen}>
                {runningAgents ? `${runningAgents} of ${chat.agents.length} agents working` : `${chat.agents.length} agent${chat.agents.length === 1 ? '' : 's'}`}
              </button>
            ) : null}
            {hasTasks ? (
              <span className="ring-with-text" title={progress?.label}>
                <ProgressRing progress={progress} status={status} size={18} stroke={2} showLabel={false} />
                <span>
                  {progress!.done}/{progress!.total}
                </span>
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      {chat && !isEmpty && state.agentsPanelOpen ? <AgentsPanel agents={chat.agents} /> : null}

      {state.currentLoading && !chat ? (
        <div className="home">
          <span className="spinner" />
        </div>
      ) : isEmpty ? (
        <div className="home">
          <div className="home-inner">
            <div className="greeting">
              <AimMark size={30} />
              <span>{greeting(state.health?.userName)}</span>
            </div>
            {composer('home')}
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s.title} className="suggestion" onClick={() => void send(s.prompt)}>
                  <s.icon size={14} />
                  {s.title}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <>
          <MessageList chat={chat} questions={state.questions.filter((q) => q.chatId === chat.id)} notices={state.notices} showThinking={showThinking} showActivity={showActivity} onAnswer={(id, a) => void answer(id, a)} />
          {composer('docked')}
        </>
      )}
    </>
  );
}

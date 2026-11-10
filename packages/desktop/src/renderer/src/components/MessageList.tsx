import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChatWithMessages } from '@aim/shared';
import type { Notice, PendingQuestion } from '../state/reducer';
import { MessageItem } from './MessageItem';
import { AskUserCard } from './AskUserCard';
import { IconAlert, IconArrowDown, IconWrench } from './Icons';

interface Props {
  chat: ChatWithMessages;
  questions: PendingQuestion[];
  notices: Notice[];
  showThinking: boolean;
  activityMode: 'show' | 'collapsed' | 'hidden';
  onAnswer: (requestId: string, answer: string) => void;
}

const NEAR_BOTTOM_PX = 80;

export function MessageList({ chat, questions, notices, showThinking, activityMode, onAnswer }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(true); // following the bottom
  const [showJump, setShowJump] = useState(false);
  const streaming = chat.status === 'thinking' || chat.status === 'working';
  const lastMsg = chat.messages[chat.messages.length - 1];
  const lastLen = lastMsg ? lastMsg.content.reduce((n, b) => n + (b && b.type === 'text' ? b.text.length : 1), 0) : 0;

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    const near = dist < NEAR_BOTTOM_PX;
    setStuck(near);
    setShowJump(!near);
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stuck) el.scrollTop = el.scrollHeight;
  }, [chat.messages.length, lastLen, questions.length, notices.length, stuck, chat.id]);

  // Jump to bottom when switching chats.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      setStuck(true);
      setShowJump(false);
    }
  }, [chat.id]);

  const jump = () => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    setStuck(true);
    setShowJump(false);
  };

  return (
    <div className="message-area">
      <div className="message-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="message-col">
          {chat.messages.map((m, i) => (
            <MessageItem
              key={m.id}
              message={m}
              agents={chat.agents}
              showThinking={showThinking}
              activityMode={activityMode}
              streaming={streaming && i === chat.messages.length - 1 && m.role === 'assistant'}
            />
          ))}
          {notices.map((n) => (
            <div key={n.id} className={`inline-notice ${n.kind === 'error' ? 'error' : n.kind === 'self_heal' ? 'warning' : ''}`}>
              {n.kind === 'error' ? <IconAlert size={13} /> : <IconWrench size={13} />}
              <span className="selectable">{n.text}</span>
            </div>
          ))}
          {questions.map((q) => (
            <AskUserCard key={q.requestId} q={q} onAnswer={(a) => onAnswer(q.requestId, a)} />
          ))}
          {streaming && (!lastMsg || lastMsg.role === 'user') ? (
            <div className="turn assistant">
              <div className="thinking-indicator">
                <span className="cursor-blink" style={{ margin: 0 }} />
                Thinking
              </div>
            </div>
          ) : null}
        </div>
      </div>
      {showJump ? (
        <button className="jump-pill" onClick={jump} aria-label="Jump to latest" data-tip="Jump to latest">
          <IconArrowDown size={14} />
        </button>
      ) : null}
    </div>
  );
}

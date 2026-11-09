import { memo, useState } from 'react';
import type { AgentInfo, ContentBlock, Message } from '@aim/shared';
import { formatCost, formatDurationShort, formatTokens } from '../lib/format';
import { useStore } from '../state/store';
import { Markdown } from './Markdown';
import { ToolUseRow } from './ToolUseRow';
import { ToolGroupRow, groupContent } from './ToolGroupRow';
import { IconAlert, IconCheck, IconChevronRight, IconCopy, IconWrench } from './Icons';

interface Props {
  message: Message;
  agents: AgentInfo[];
  showThinking: boolean;
  streaming: boolean;
}

function ThinkingRow({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`thinking-row ${open ? 'open' : ''}`}>
      <button className="tr-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <IconChevronRight className="tr-chev" size={14} />
        <span>Thought process</span>
        <span className="faint">{text.length > 0 ? `${text.split(/\s+/).length} words` : ''}</span>
      </button>
      {open ? <div className="tr-body selectable">{text}</div> : null}
    </div>
  );
}

function StatusNotice({ text }: { text: string }) {
  return (
    <div className="inline-notice">
      <IconWrench size={13} />
      <span>{text}</span>
    </div>
  );
}

function textOf(content: ContentBlock[]): string {
  return content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => !!b && b.type === 'text')
    .map((b) => b.text)
    .join('\n\n');
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="icon-btn"
      aria-label="Copy"
      data-tip={done ? 'Copied' : 'Copy'}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          window.setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? <IconCheck size={14} /> : <IconCopy size={14} />}
    </button>
  );
}

export const MessageItem = memo(function MessageItem({ message, agents, showThinking, streaming }: Props) {
  const { state } = useStore();
  const agentName = (id?: string) => (id ? agents.find((a) => a.id === id)?.name : undefined);

  if (message.role === 'user') {
    const images = message.content.filter((b): b is Extract<ContentBlock, { type: 'image' }> => b.type === 'image');
    const text = textOf(message.content);
    const initial = (state.health?.userName || 'You').charAt(0);
    return (
      <div className="turn user">
        <span className="avatar">{initial}</span>
        <div className="bubble">
          {images.length ? (
            <div className="bubble-images">
              {images.map((im, i) => (
                <img key={i} src={`data:${im.mediaType};base64,${im.dataBase64}`} alt={im.alt ?? 'attachment'} />
              ))}
            </div>
          ) : null}
          {text}
        </div>
      </div>
    );
  }

  if (message.role === 'system') {
    return (
      <div className="turn system">
        <div className="prose">
          <div className="inline-notice">
            <IconAlert size={13} />
            <div>
              {message.content.map((b, i) =>
                b.type === 'text' ? <Markdown key={i} text={b.text} /> : b.type === 'status' ? <StatusNotice key={i} text={b.text} /> : null,
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  const lastIdx = message.content.length - 1;
  const author = agentName(message.agentId);
  const plain = textOf(message.content);
  const usage = message.usage
    ? [
        message.usage.durationMs != null ? formatDurationShort(message.usage.durationMs) : '',
        message.usage.outputTokens != null ? `${formatTokens(message.usage.outputTokens)} tokens` : '',
        message.usage.costUsd != null ? formatCost(message.usage.costUsd) : '',
      ]
        .filter(Boolean)
        .join(' · ')
    : '';

  return (
    <div className="turn assistant">
      <div className="prose">
        {author ? <div className="agent-label">{author}</div> : null}
        {groupContent(message.content).map((item, i) => {
          if (item.kind === 'group') {
            return <ToolGroupRow key={`g${i}`} blocks={item.blocks} agentName={agentName(item.blocks[0]?.agentId)} />;
          }
          const b = item.block;
          if (!b) return null;
          switch (b.type) {
            case 'text':
              return (
                <div key={i}>
                  <Markdown text={b.text} />
                  {streaming && i === lastIdx ? <span className="cursor-blink" /> : null}
                </div>
              );
            case 'tool_use':
              return <ToolUseRow key={b.id || i} block={b} agentName={agentName(b.agentId)} />;
            case 'thinking':
              return showThinking ? <ThinkingRow key={i} text={b.text} /> : null;
            case 'status':
              return <StatusNotice key={i} text={b.text} />;
            case 'image':
              return <img key={i} className="msg-image" src={`data:${b.mediaType};base64,${b.dataBase64}`} alt={b.alt ?? 'image'} />;
            default:
              return null;
          }
        })}
        {streaming && message.content.length === 0 ? <span className="cursor-blink" /> : null}
      </div>
      {!streaming && plain ? (
        <div className="turn-actions">
          <CopyButton text={plain} />
          {usage ? <span className="usage">{usage}</span> : null}
        </div>
      ) : null}
    </div>
  );
});

import { memo, useState, type ReactNode } from 'react';
import type { AgentInfo, ContentBlock, Message, ToolUseBlock } from '@aim/shared';
import { formatCost, formatDurationShort, formatTokens } from '../lib/format';
import { useSmoothText } from '../lib/useSmoothText';
import { useStore } from '../state/store';
import { Markdown } from './Markdown';
import { ToolUseRow } from './ToolUseRow';
import { ToolGroupRow, groupContent, type RenderItem } from './ToolGroupRow';
import { IconAlert, IconCheck, IconChevronRight, IconCopy, IconWrench } from './Icons';

interface Props {
  message: Message;
  agents: AgentInfo[];
  showThinking: boolean;
  /** Show every tool call; otherwise runs of tool work collapse into one line. */
  showActivity: boolean;
  streaming: boolean;
}

/** Streamed text that types out smoothly. */
function StreamingText({ text, live }: { text: string; live: boolean }) {
  const shown = useSmoothText(text);
  return (
    <div className={live ? 'streaming-text' : undefined}>
      <Markdown text={shown} />
      {live ? <span className="cursor-blink" /> : null}
    </div>
  );
}

function toolBlocksOf(items: RenderItem[]): ToolUseBlock[] {
  const out: ToolUseBlock[] = [];
  for (const it of items) {
    if (it.kind === 'group') out.push(...it.blocks);
    else if (it.block.type === 'tool_use') out.push(it.block);
  }
  return out;
}

/** A run of tool calls / thinking / status blocks collapsed into a single "Worked · N steps" line. */
function ActivityGroup({ items, live, children }: { items: RenderItem[]; live: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const tools = toolBlocksOf(items);
  const steps = tools.length;
  const failed = tools.filter((t) => t.result && !t.result.ok).length;
  const pending = live && tools.some((t) => !t.result);
  const ms = tools.reduce((n, t) => n + (t.result?.durationMs ?? 0), 0);
  const label = pending ? 'Working' : 'Worked';
  const parts = [`${steps} step${steps === 1 ? '' : 's'}`];
  if (ms > 0 && !pending) parts.push(formatDurationShort(ms));
  return (
    <div className={`activity ${open ? 'open' : ''}`}>
      <button className="act-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {pending ? <span className="spinner" /> : <IconChevronRight className="tr-chev" size={14} />}
        <span>
          {label} · {parts.join(' · ')}
        </span>
        {failed ? <span className="act-failed">{failed} failed</span> : null}
      </button>
      {open ? <div className="act-body">{children}</div> : null}
    </div>
  );
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

export const MessageItem = memo(function MessageItem({ message, agents, showThinking, showActivity, streaming }: Props) {
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

  const items = groupContent(message.content).filter((it) => it.kind === 'group' || (it.block && (it.block.type !== 'thinking' || showThinking)));
  const renderItem = (item: RenderItem, i: number, isLast: boolean) => {
    if (item.kind === 'group') return <ToolGroupRow key={`g${i}`} blocks={item.blocks} agentName={agentName(item.blocks[0]?.agentId)} />;
    const b = item.block;
    switch (b.type) {
      case 'text':
        return <StreamingText key={i} text={b.text} live={streaming && isLast} />;
      case 'tool_use':
        return <ToolUseRow key={b.id || i} block={b} agentName={agentName(b.agentId)} />;
      case 'thinking':
        return <ThinkingRow key={i} text={b.text} />;
      case 'status':
        return <StatusNotice key={i} text={b.text} />;
      case 'image':
        return <img key={i} className="msg-image" src={`data:${b.mediaType};base64,${b.dataBase64}`} alt={b.alt ?? 'image'} />;
      default:
        return null;
    }
  };
  // Split into text and runs of "work" (tool calls, thinking, status) so the work can collapse to one line.
  const segments: { kind: 'text' | 'work'; items: { item: RenderItem; index: number }[] }[] = [];
  items.forEach((item, index) => {
    const isWork = item.kind === 'group' || (item.block.type !== 'text' && item.block.type !== 'image');
    const kind = isWork ? 'work' : 'text';
    const last = segments[segments.length - 1];
    if (last && last.kind === kind) last.items.push({ item, index });
    else segments.push({ kind, items: [{ item, index }] });
  });
  const lastIndex = items.length - 1;

  return (
    <div className="turn assistant">
      <div className="prose">
        {author ? <div className="agent-label">{author}</div> : null}
        {segments.map((seg, si) => {
          if (seg.kind === 'text' || showActivity) return seg.items.map(({ item, index }) => renderItem(item, index, index === lastIndex));
          const live = streaming && si === segments.length - 1;
          return (
            <ActivityGroup key={`a${si}`} items={seg.items.map((x) => x.item)} live={live}>
              {seg.items.map(({ item, index }) => renderItem(item, index, false))}
            </ActivityGroup>
          );
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

import { useState } from 'react';
import type { ContentBlock, ToolUseBlock } from '@aim/shared';
import { humanizeToolName } from '../lib/tools';
import { IconChevronRight, IconWrench } from './Icons';
import { ToolUseRow } from './ToolUseRow';

/** Minimum run length of identical tool calls before they collapse into one row. */
export const TOOL_GROUP_MIN = 3;

export type RenderItem = { kind: 'block'; block: ContentBlock } | { kind: 'group'; blocks: ToolUseBlock[] };

/**
 * Collapses runs of >= TOOL_GROUP_MIN consecutive tool_use blocks with the same tool name into a single
 * group item, so e.g. a dozen ToolSearch calls do not swamp the transcript. Other blocks pass through.
 */
export function groupContent(content: ContentBlock[]): RenderItem[] {
  const out: RenderItem[] = [];
  let i = 0;
  while (i < content.length) {
    const b = content[i];
    if (b && b.type === 'tool_use') {
      let j = i + 1;
      while (j < content.length) {
        const n = content[j];
        if (!n || n.type !== 'tool_use' || n.name !== b.name) break;
        j++;
      }
      if (j - i >= TOOL_GROUP_MIN) {
        out.push({ kind: 'group', blocks: content.slice(i, j) as ToolUseBlock[] });
        i = j;
        continue;
      }
    }
    out.push({ kind: 'block', block: b });
    i++;
  }
  return out;
}

export function ToolGroupRow({ blocks, agentName }: { blocks: ToolUseBlock[]; agentName?: string }) {
  const [open, setOpen] = useState(false);
  const first = blocks[0];
  if (!first) return null;
  const name = humanizeToolName(first.name);
  const failed = blocks.filter((b) => b.result && !b.result.ok).length;
  const pending = blocks.filter((b) => !b.result).length;
  const summary = `${blocks.length} calls${failed ? `, ${failed} failed` : ''}${pending ? `, ${pending} running` : ''}`;
  return (
    <div className={`tool-row tool-group ${failed ? 'error' : ''} ${open ? 'open' : ''}`}>
      <button className="tr-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="tr-icon">{pending ? <span className="spinner" /> : <IconWrench size={14} />}</span>
        <span className="tr-name">{name}</span>
        <span className="tr-count">×{blocks.length}</span>
        {agentName ? <span className="tr-agent">{agentName}</span> : null}
        <span className="tr-summary">{summary}</span>
        <IconChevronRight className="tr-chev" size={14} />
      </button>
      {open ? (
        <div className="tr-body tool-group-body">
          {blocks.map((b, i) => (
            <ToolUseRow key={b.id || i} block={b} agentName={agentName} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

import type { ReactElement } from 'react';
import { useState } from 'react';
import type { ToolUseBlock } from '@aim/shared';
import { formatDurationShort } from '../lib/format';
import { formatToolInput, humanizeToolName, summarizeToolInput, toolCategory, type ToolCategory } from '../lib/tools';
import {
  IconChevronRight,
  IconCpu,
  IconFile,
  IconGlobe,
  IconList,
  IconMemory,
  IconMonitor,
  IconMouse,
  IconQuestion,
  IconSearch,
  IconTarget,
  IconTerminal,
  IconUsers,
  IconWindow,
  IconWrench,
} from './Icons';

const CATEGORY_ICON: Record<ToolCategory, (p: { size?: number }) => ReactElement> = {
  screen: IconMonitor,
  browser: IconGlobe,
  input: IconMouse,
  window: IconWindow,
  memory: IconMemory,
  tasks: IconList,
  goals: IconTarget,
  file: IconFile,
  shell: IconTerminal,
  search: IconSearch,
  agent: IconUsers,
  ask: IconQuestion,
  web: IconGlobe,
  other: IconWrench,
};

export function ToolUseRow({ block, agentName }: { block: ToolUseBlock; agentName?: string }) {
  const [open, setOpen] = useState(false);
  const cat = toolCategory(block.name);
  const Icon = CATEGORY_ICON[cat] ?? IconCpu;
  const name = humanizeToolName(block.name);
  const pending = !block.result;
  const error = block.result ? !block.result.ok : false;
  const summary = block.result?.summary || summarizeToolInput(block.input);
  const thumb = block.result?.imageBase64;
  const input = formatToolInput(block.input);

  return (
    <div className={`tool-row ${error ? 'error' : ''} ${open ? 'open' : ''}`}>
      <button className="tr-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="tr-icon">{pending ? <span className="spinner" /> : <Icon size={14} />}</span>
        <span className="tr-name">{name}</span>
        {agentName ? <span className="tr-agent">{agentName}</span> : null}
        <span className="tr-summary">{error ? block.result?.error || summary : summary}</span>
        {thumb ? <img className="tr-thumb" src={`data:image/png;base64,${thumb}`} alt="" /> : null}
        {block.result?.durationMs != null ? <span className="tr-dur">{formatDurationShort(block.result.durationMs)}</span> : null}
        <IconChevronRight className="tr-chev" size={14} />
      </button>
      {open ? (
        <div className="tr-body">
          {input ? (
            <div>
              <div className="tr-label">Input</div>
              <pre className="selectable">{input}</pre>
            </div>
          ) : null}
          {block.result ? (
            <div>
              <div className="tr-label">{block.result.ok ? 'Result' : 'Error'}</div>
              <pre className="selectable">{block.result.ok ? block.result.summary : block.result.error || block.result.summary}</pre>
            </div>
          ) : (
            <div className="muted small">Running…</div>
          )}
          {thumb ? <img className="tr-img" src={`data:image/png;base64,${thumb}`} alt="Tool output" /> : null}
        </div>
      ) : null}
    </div>
  );
}

import { useEffect, useState } from 'react';
import type { AgentInfo, AgentState } from '@aim/shared';
import { formatDurationShort } from '../lib/format';

const STATE_DOT: Record<AgentState, string> = {
  spawning: 'accent pulse',
  running: 'accent pulse',
  waiting: 'warning',
  done: 'success',
  failed: 'danger',
  cancelled: '',
};

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [active]);
  return now;
}

export function AgentsPanel({ agents }: { agents: AgentInfo[] }) {
  const anyRunning = agents.some((a) => a.state === 'running' || a.state === 'spawning' || a.state === 'waiting');
  const now = useNow(anyRunning);
  if (!agents.length) return <div className="agents-panel"><div className="agents-empty">No agents have been delegated to in this chat.</div></div>;
  return (
    <div className="agents-panel">
      {agents.map((a) => (
        <div key={a.id} className="agent-card">
          <div className="ac-head">
            <span className={`dot ${STATE_DOT[a.state]}`} />
            <span className="truncate">{a.name}</span>
            <span className="ac-role">{a.role.replace(/_/g, ' ')}</span>
          </div>
          {a.task ? <div className="ac-task">{a.task}</div> : null}
          <div className="ac-foot">
            <span>{a.state === 'running' && a.lastActivity ? a.lastActivity : a.state}</span>
            <span>{formatDurationShort((a.endedAt ?? now) - a.startedAt)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

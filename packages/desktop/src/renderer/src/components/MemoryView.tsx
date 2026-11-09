import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BehaviorSummary, MemoryEntry, MemoryKind } from '@aim/shared';
import { useStore } from '../state/store';
import { formatDate, formatHours, formatPercent, hourLabel } from '../lib/format';
import { IconPlus, IconSearch, IconTrash } from './Icons';

const KINDS: MemoryKind[] = ['preference', 'fact', 'lesson', 'procedure', 'goal_feedback'];
const KIND_LABEL: Record<MemoryKind, string> = {
  preference: 'Preference',
  fact: 'Fact',
  lesson: 'Lesson',
  procedure: 'Procedure',
  goal_feedback: 'Goal feedback',
};

function Bars({ rows }: { rows: { label: string; ms: number; share: number }[] }) {
  if (!rows.length) return <div className="empty">Nothing observed yet.</div>;
  const max = Math.max(...rows.map((r) => r.ms), 1);
  return (
    <div className="bars">
      {rows.map((r) => (
        <div key={r.label} className="bar-row">
          <span className="bar-label" title={r.label}>
            {r.label}
          </span>
          <span className="bar-track">
            <span style={{ width: `${Math.max(2, (r.ms / max) * 100)}%` }} />
          </span>
          <span className="bar-val">{formatPercent(r.share)}</span>
        </div>
      ))}
    </div>
  );
}

function HeatStrip({ hours }: { hours: number[] }) {
  const max = Math.max(...hours, 1);
  return (
    <div>
      <div className="heat-strip">
        {hours.map((ms, h) => {
          const a = ms / max;
          return (
            <div
              key={h}
              className="heat-cell"
              style={{ background: a > 0 ? `rgba(26, 191, 176, ${0.12 + a * 0.78})` : undefined }}
              data-tip={`${hourLabel(h)}:00 — ${formatHours(ms)}`}
            />
          );
        })}
      </div>
      <div className="heat-labels">
        {hours.map((_, h) => (
          <span key={h}>{h % 6 === 0 ? hourLabel(h) : ''}</span>
        ))}
      </div>
    </div>
  );
}

export function MemoryView() {
  const { state, toast } = useStore();
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<MemoryKind | null>(null);
  const [summary, setSummary] = useState<BehaviorSummary | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<{ key: string; value: string; kind: MemoryKind }>({ key: '', value: '', kind: 'preference' });

  const load = useCallback(async () => {
    try {
      const q = query.trim();
      setEntries(await window.aim.listMemories(q || undefined));
    } catch (e) {
      toast('error', 'Could not load memories', e instanceof Error ? e.message : String(e));
    }
  }, [query, toast]);

  useEffect(() => {
    const t = window.setTimeout(() => void load(), query ? 180 : 0);
    return () => window.clearTimeout(t);
  }, [load, query, state.memoryVersion]);

  useEffect(() => {
    window.aim
      .getBehaviorSummary(7)
      .then(setSummary)
      .catch(() => setSummary(null));
  }, [state.memoryVersion]);

  const visible = useMemo(() => {
    const list = kind ? entries.filter((e) => e.kind === kind) : entries;
    return list.slice().sort((a, b) => b.updatedAt - a.updatedAt);
  }, [entries, kind]);

  const remove = async (key: string) => {
    setEntries((l) => l.filter((e) => e.key !== key));
    try {
      await window.aim.deleteMemory(key);
    } catch (e) {
      toast('error', 'Could not delete memory', e instanceof Error ? e.message : String(e));
      void load();
    }
  };

  const add = async () => {
    const key = draft.key.trim();
    const value = draft.value.trim();
    if (!key || !value) return;
    try {
      await window.aim.upsertMemory({ key, value, kind: draft.kind });
      setDraft({ key: '', value: '', kind: 'preference' });
      setAdding(false);
      await load();
      toast('success', 'Memory saved');
    } catch (e) {
      toast('error', 'Could not save memory', e instanceof Error ? e.message : String(e));
    }
  };

  const counts = useMemo(() => {
    const c: Partial<Record<MemoryKind, number>> = {};
    entries.forEach((e) => (c[e.kind] = (c[e.kind] ?? 0) + 1));
    return c;
  }, [entries]);

  return (
    <div className="view">
      <div className="view-inner">
        <h1 className="view-title">Memory</h1>
        <p className="view-sub">What A.I.M. has learned about you and your work. Memories are added to every conversation's context.</p>

        <section className="section">
          <div className="section-head">
            <span className="section-title">Memories ({entries.length})</span>
            <button className="btn sm" onClick={() => setAdding((a) => !a)}>
              <IconPlus size={13} /> Add memory
            </button>
          </div>
          {adding ? (
            <div className="card" style={{ marginBottom: 10 }}>
              <div className="row" style={{ marginBottom: 8 }}>
                <input className="input selectable" placeholder="Key, e.g. preferred_browser" value={draft.key} onChange={(e) => setDraft({ ...draft, key: e.target.value })} />
                <select className="select" style={{ width: 160 }} value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as MemoryKind })}>
                  {KINDS.map((k) => (
                    <option key={k} value={k}>
                      {KIND_LABEL[k]}
                    </option>
                  ))}
                </select>
              </div>
              <textarea className="textarea selectable" placeholder="What should A.I.M. remember?" value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })} />
              <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
                <button className="btn ghost" onClick={() => setAdding(false)}>
                  Cancel
                </button>
                <button className="btn primary" onClick={() => void add()} disabled={!draft.key.trim() || !draft.value.trim()}>
                  Save
                </button>
              </div>
            </div>
          ) : null}
          <div className="row" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
            <div className="search-box" style={{ flex: '1 1 220px' }}>
              <IconSearch size={14} />
              <input className="input selectable" placeholder="Search memories" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <div className="chips">
              <button className={`chip ${kind === null ? 'active' : ''}`} onClick={() => setKind(null)}>
                All
              </button>
              {KINDS.map((k) => (
                <button key={k} className={`chip ${kind === k ? 'active' : ''}`} onClick={() => setKind(kind === k ? null : k)}>
                  {KIND_LABEL[k]}
                  {counts[k] ? <span className="faint">{counts[k]}</span> : null}
                </button>
              ))}
            </div>
          </div>
          {visible.length ? (
            visible.map((m) => (
              <div key={m.key} className="memory-item">
                <div className="m-main">
                  <div className="m-key">{m.key}</div>
                  <div className="m-value">{m.value}</div>
                  <div className="m-meta">
                    <span className="tag">{KIND_LABEL[m.kind]}</span>
                    <span className="conf" data-tip={`Confidence ${Math.round(m.confidence * 100)}%`}>
                      <span className="conf-bar">
                        <span style={{ width: `${Math.round(m.confidence * 100)}%` }} />
                      </span>
                    </span>
                    <span>
                      {m.hits} hit{m.hits === 1 ? '' : 's'}
                    </span>
                    <span>Learned {formatDate(m.createdAt)}</span>
                    <span>via {m.source}</span>
                  </div>
                </div>
                <button className="icon-btn m-del" onClick={() => void remove(m.key)} aria-label="Delete memory" data-tip="Delete">
                  <IconTrash size={14} />
                </button>
              </div>
            ))
          ) : (
            <div className="empty">{entries.length ? 'No memories of this kind.' : 'No memories yet. A.I.M. learns from completed conversations.'}</div>
          )}
        </section>

        <section className="section">
          <div className="section-head">
            <span className="section-title">Behaviour summary</span>
            <span className="small faint">{summary ? `Last ${summary.days} days` : ''}</span>
          </div>
          {summary ? (
            <div className="card">
              <div className="stat-row">
                <div className="stat">
                  <div className="st-val">{formatHours(summary.totalActiveMs)}</div>
                  <div className="st-label">Active time</div>
                </div>
                <div className="stat">
                  <div className="st-val">{summary.topApps.length}</div>
                  <div className="st-label">Apps used</div>
                </div>
                <div className="stat">
                  <div className="st-val">{summary.topSites.length}</div>
                  <div className="st-label">Sites visited</div>
                </div>
              </div>
              <div className="two-col">
                <div>
                  <div className="section-title" style={{ marginBottom: 8 }}>
                    Top apps
                  </div>
                  <Bars rows={summary.topApps.slice(0, 6).map((a) => ({ label: a.app, ms: a.ms, share: a.share }))} />
                </div>
                <div>
                  <div className="section-title" style={{ marginBottom: 8 }}>
                    Top sites
                  </div>
                  <Bars rows={summary.topSites.slice(0, 6).map((s) => ({ label: s.host, ms: s.ms, share: s.share }))} />
                </div>
              </div>
              <div style={{ marginTop: 18 }}>
                <div className="section-title" style={{ marginBottom: 8 }}>
                  Active hours
                </div>
                <HeatStrip hours={summary.activeHours.length === 24 ? summary.activeHours : new Array<number>(24).fill(0)} />
              </div>
              {summary.routines.length ? (
                <div style={{ marginTop: 18 }}>
                  <div className="section-title" style={{ marginBottom: 6 }}>
                    Routines
                  </div>
                  <ul className="routines selectable">
                    {summary.routines.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="empty">{state.settings?.observerEnabled === false ? 'The behaviour observer is turned off in Settings.' : 'No behaviour data yet.'}</div>
          )}
        </section>
      </div>
    </div>
  );
}

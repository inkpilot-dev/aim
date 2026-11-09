import { useCallback, useEffect, useState } from 'react';
import type { DailyPlan, Directive, Goal, GoalStatus } from '@aim/shared';
import { useStore } from '../state/store';
import { formatDayLabel, toIsoDate } from '../lib/format';
import { IconCheck, IconChat, IconEdit, IconPlay, IconPlus, IconRefresh, IconTrash, IconX } from './Icons';

type Prio = 1 | 2 | 3;

const GOAL_TAG: Record<GoalStatus, string> = {
  planned: '',
  in_progress: 'accent',
  done: 'success',
  failed: 'danger',
  deferred: 'warning',
};

function PrioPicker({ value, onChange }: { value: Prio; onChange: (p: Prio) => void }) {
  return (
    <span className="prio-picker" role="radiogroup" aria-label="Priority">
      {([1, 2, 3] as Prio[]).map((p) => (
        <button key={p} className={`prio ${value === p ? `p${p}` : ''}`} onClick={() => onChange(p)} role="radio" aria-checked={value === p} data-tip={`Priority ${p}`}>
          {p}
        </button>
      ))}
    </span>
  );
}

function DirectiveRow({ d, onUpdate, onDelete }: { d: Directive; onUpdate: (patch: Partial<Pick<Directive, 'text' | 'active' | 'priority'>>) => void; onDelete: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(d.text);
  const [confirm, setConfirm] = useState(false);
  const commit = () => {
    if (text.trim() && text.trim() !== d.text) onUpdate({ text: text.trim() });
    setEditing(false);
  };
  return (
    <div className={`directive ${d.active ? '' : 'inactive'} ${editing ? 'editing' : ''}`}>
      <button className="switch" role="switch" aria-checked={d.active} onClick={() => onUpdate({ active: !d.active })} aria-label="Active" />
      <span className={`prio p${d.priority}`} data-tip={`Priority ${d.priority}`}>
        {d.priority}
      </span>
      <div className="d-text">
        {editing ? (
          <input
            className="input"
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') setEditing(false);
            }}
          />
        ) : (
          d.text
        )}
      </div>
      <div className="d-actions">
        <PrioPicker value={d.priority} onChange={(p) => onUpdate({ priority: p })} />
        <button className="icon-btn" onClick={() => setEditing(true)} aria-label="Edit">
          <IconEdit size={14} />
        </button>
        {confirm ? (
          <>
            <button className="icon-btn" style={{ color: 'var(--danger)' }} onClick={onDelete} aria-label="Confirm delete">
              <IconCheck size={14} />
            </button>
            <button className="icon-btn" onClick={() => setConfirm(false)} aria-label="Cancel">
              <IconX size={14} />
            </button>
          </>
        ) : (
          <button className="icon-btn" onClick={() => setConfirm(true)} aria-label="Delete">
            <IconTrash size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

export function GoalsView() {
  const { state, toast, selectChat } = useStore();
  const [directives, setDirectives] = useState<Directive[]>([]);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [plan, setPlan] = useState<DailyPlan | null>(null);
  const [newText, setNewText] = useState('');
  const [newPrio, setNewPrio] = useState<Prio>(2);
  const [planning, setPlanning] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const today = toIsoDate(Date.now());

  const load = useCallback(async () => {
    try {
      const [d, g] = await Promise.all([window.aim.listDirectives(), window.aim.listGoals({ includeDone: true })]);
      setDirectives(d);
      setGoals(g);
    } catch (e) {
      toast('error', 'Could not load goals', e instanceof Error ? e.message : String(e));
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load, state.goalsVersion]);

  const todays = goals.filter((g) => g.date === today).sort((a, b) => a.priority - b.priority);
  const historyDates = Array.from(new Set(goals.filter((g) => g.date !== today).map((g) => g.date))).sort((a, b) => (a < b ? 1 : -1));

  const addDirective = async () => {
    const t = newText.trim();
    if (!t) return;
    try {
      const d = await window.aim.addDirective(t, newPrio);
      setDirectives((l) => [...l, d]);
      setNewText('');
    } catch (e) {
      toast('error', 'Could not add directive', e instanceof Error ? e.message : String(e));
    }
  };

  const updateDirective = async (id: string, patch: Partial<Pick<Directive, 'text' | 'active' | 'priority'>>) => {
    setDirectives((l) => l.map((d) => (d.id === id ? { ...d, ...patch } : d)));
    try {
      await window.aim.updateDirective(id, patch);
    } catch (e) {
      toast('error', 'Could not update directive', e instanceof Error ? e.message : String(e));
      void load();
    }
  };

  const deleteDirective = async (id: string) => {
    setDirectives((l) => l.filter((d) => d.id !== id));
    try {
      await window.aim.deleteDirective(id);
    } catch (e) {
      toast('error', 'Could not delete directive', e instanceof Error ? e.message : String(e));
      void load();
    }
  };

  const planNow = async () => {
    setPlanning(true);
    try {
      const p = await window.aim.planGoalsNow();
      setPlan(p);
      await load();
      toast('success', 'Plan ready', `${p.goals.length} goal${p.goals.length === 1 ? '' : 's'} planned for today.`);
    } catch (e) {
      toast('error', 'Planning failed', e instanceof Error ? e.message : String(e));
    } finally {
      setPlanning(false);
    }
  };

  const runGoal = async (g: Goal) => {
    setRunning(g.id);
    try {
      const { chatId } = await window.aim.runGoal(g.id);
      selectChat(chatId);
    } catch (e) {
      toast('error', 'Could not run goal', e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(null);
    }
  };

  return (
    <div className="view">
      <div className="view-inner">
        <h1 className="view-title">Goals</h1>
        <p className="view-sub">Standing directives tell A.I.M. what to keep pursuing. Each morning it plans concrete goals from them.</p>

        <section className="section">
          <div className="section-head">
            <span className="section-title">Directives</span>
            <span className="small faint">{directives.filter((d) => d.active).length} active</span>
          </div>
          {directives.length ? (
            directives
              .slice()
              .sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt)
              .map((d) => <DirectiveRow key={d.id} d={d} onUpdate={(p) => void updateDirective(d.id, p)} onDelete={() => void deleteDirective(d.id)} />)
          ) : (
            <div className="empty">No directives yet. Add one below, for example "Keep my inbox at zero".</div>
          )}
          <div className="add-form">
            <PrioPicker value={newPrio} onChange={setNewPrio} />
            <input
              className="input selectable"
              placeholder="Add a directive, e.g. Find ML internships every week"
              value={newText}
              onChange={(e) => setNewText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void addDirective();
              }}
            />
            <button className="btn primary" onClick={() => void addDirective()} disabled={!newText.trim()}>
              <IconPlus size={14} /> Add
            </button>
          </div>
        </section>

        <section className="section">
          <div className="section-head">
            <span className="section-title">Today's plan</span>
            <button className="btn" onClick={() => void planNow()} disabled={planning}>
              {planning ? <span className="spinner" /> : <IconRefresh size={14} />}
              {planning ? 'Planning…' : "Plan today's goals now"}
            </button>
          </div>
          {plan && plan.date === today && plan.summary ? <div className="plan-summary">{plan.summary}</div> : null}
          {todays.length ? (
            todays.map((g) => (
              <div key={g.id} className="goal-card">
                <span className={`prio p${g.priority}`}>{g.priority}</span>
                <div className="g-main">
                  <div className="g-title">{g.title}</div>
                  <div className="g-rationale">{g.rationale}</div>
                  <div className="g-meta">
                    <span className={`tag ${GOAL_TAG[g.status]}`}>{g.status.replace('_', ' ')}</span>
                    <span className="tag">{g.effort}</span>
                    {g.notes ? <span className="small faint truncate">{g.notes}</span> : null}
                  </div>
                </div>
                <div className="g-actions">
                  {g.status === 'planned' || g.status === 'deferred' || g.status === 'failed' ? (
                    <button className="btn sm" onClick={() => void runGoal(g)} disabled={running === g.id}>
                      {running === g.id ? <span className="spinner" /> : <IconPlay size={12} />}
                      Run now
                    </button>
                  ) : null}
                  {g.chatId ? (
                    <button className="btn sm ghost" onClick={() => selectChat(g.chatId!)}>
                      <IconChat size={12} /> Open chat
                    </button>
                  ) : null}
                </div>
              </div>
            ))
          ) : (
            <div className="empty">
              {state.settings?.dailyGoalsEnabled
                ? `No goals planned for today yet. A.I.M. plans daily at ${state.settings.dailyGoalsTime}, or plan now.`
                : 'Daily planning is turned off in Settings. You can still plan manually.'}
            </div>
          )}
        </section>

        {historyDates.length ? (
          <section className="section">
            <div className="section-head">
              <span className="section-title">History</span>
            </div>
            {historyDates.map((date) => (
              <div key={date} className="history-day">
                <div className="hd-date">{formatDayLabel(date)}</div>
                {goals
                  .filter((g) => g.date === date)
                  .map((g) => (
                    <div key={g.id} className="history-goal">
                      <span className={`dot ${GOAL_TAG[g.status] || ''}`} />
                      <span className="grow truncate" style={{ color: 'var(--text)' }}>
                        {g.title}
                      </span>
                      <span className={`tag ${GOAL_TAG[g.status]}`}>{g.status.replace('_', ' ')}</span>
                      {g.chatId ? (
                        <button className="icon-btn" onClick={() => selectChat(g.chatId!)} aria-label="Open chat" data-tip="Open chat">
                          <IconChat size={14} />
                        </button>
                      ) : null}
                    </div>
                  ))}
              </div>
            ))}
          </section>
        ) : null}
      </div>
    </div>
  );
}

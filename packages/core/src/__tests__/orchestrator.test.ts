import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentInfo, CliEvent } from '@aim/shared';
import { ChatStore } from '../chat-store.js';
import { openDatabase } from '../db.js';
import { Orchestrator, roleFromSubagentType } from '../orchestrator.js';
import { fakeBridge, makeTmpDir, quietLogs, testSettings } from './helpers.js';

const dir = makeTmpDir();
quietLogs(dir);

function setup(maxParallelAgents = 2) {
  const db = openDatabase(path.join(dir, `orch-${Math.random().toString(36).slice(2)}.db`));
  const store = new ChatStore(db);
  const chat = store.createChat({ title: 'orch', cwd: dir });
  const updates: AgentInfo[][] = [];
  const orch = new Orchestrator({ store, cli: fakeBridge(), settings: () => testSettings({ maxParallelAgents }), onAgents: (_c, a) => updates.push(a) });
  return { db, store, chat, orch, updates };
}

describe('Orchestrator', () => {
  it('maps subagent types to roles', () => {
    expect(roleFromSubagentType('browser_operator')).toBe('browser_operator');
    expect(roleFromSubagentType('general-purpose')).toBe('researcher');
    expect(roleFromSubagentType('web-scraper')).toBe('browser_operator');
    expect(roleFromSubagentType('code-reviewer')).toBe('verifier');
    expect(roleFromSubagentType(undefined)).toBe('researcher');
  });

  it('mirrors Agent tool_use + parent_tool_use_id events into AgentInfo', () => {
    const { store, chat, orch, updates } = setup();
    const sid = 's';
    const spawn: CliEvent = {
      type: 'assistant',
      session_id: sid,
      parent_tool_use_id: null,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'agent_1', name: 'Agent', input: { subagent_type: 'browser_operator', description: 'Log into portal', prompt: '...' } }] },
    };
    expect(orch.handleCliEvent(chat.id, spawn)).toBe(true);
    let a = orch.getAgents(chat.id);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ id: 'agent_1', role: 'browser_operator', name: 'Browser Operator', state: 'spawning', task: 'Log into portal' });

    const child: CliEvent = {
      type: 'assistant',
      session_id: sid,
      parent_tool_use_id: 'agent_1',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_c', name: 'mcp__aim__browser_click', input: { tabId: 1, ref: 'e3' } }] },
    };
    expect(orch.handleCliEvent(chat.id, child)).toBe(true);
    a = orch.getAgents(chat.id);
    expect(a[0].state).toBe('running');
    expect(a[0].lastActivity).toBe('browser_click e3');

    // Same activity again → no change.
    expect(orch.handleCliEvent(chat.id, child)).toBe(false);

    const finish: CliEvent = { type: 'user', session_id: sid, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'agent_1', content: 'ok' }] } };
    expect(orch.handleCliEvent(chat.id, finish)).toBe(true);
    a = orch.getAgents(chat.id);
    expect(a[0].state).toBe('done');
    expect(a[0].endedAt).toBeTypeOf('number');
    expect(store.getAgents(chat.id)[0].state).toBe('done');
    expect(updates.length).toBe(3);

    // Failed sub-agent
    orch.handleCliEvent(chat.id, {
      type: 'assistant',
      session_id: sid,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'agent_2', name: 'Task', input: { subagent_type: 'coder', description: 'Fix' } }] },
    });
    orch.handleCliEvent(chat.id, { type: 'user', session_id: sid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'agent_2', content: 'err', is_error: true }] } });
    expect(orch.getAgents(chat.id).find((x) => x.id === 'agent_2')?.state).toBe('failed');
  });

  it('cancelAll marks live agents cancelled', () => {
    const { chat, orch } = setup();
    orch.handleCliEvent(chat.id, {
      type: 'assistant',
      session_id: 's',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'agent_x', name: 'Agent', input: { subagent_type: 'planner' } }] },
    });
    orch.cancelAll(chat.id);
    expect(orch.getAgents(chat.id)[0].state).toBe('cancelled');
  });

  it('spawnWorker runs separate CLI processes with a concurrency cap', async () => {
    const { chat, orch, updates } = setup(2);
    const t0 = Date.now();
    const results = await Promise.all([
      orch.spawnWorker(chat.id, { role: 'researcher', name: 'R1', task: 'first' }),
      orch.spawnWorker(chat.id, { role: 'coder', name: 'C1', task: 'second' }),
      orch.spawnWorker(chat.id, { role: 'verifier', name: 'V1', task: 'third' }),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.map((r) => r.result)).toEqual(['Echo: Task from the orchestrator:\n\nfirst', 'Echo: Task from the orchestrator:\n\nsecond', 'Echo: Task from the orchestrator:\n\nthird']);
    const agents = orch.getAgents(chat.id);
    expect(agents).toHaveLength(3);
    expect(agents.every((a) => a.state === 'done' && a.sessionId)).toBe(true);
    // At no point were more than 2 running.
    const maxRunning = Math.max(...updates.map((u) => u.filter((a) => a.state === 'running').length));
    expect(maxRunning).toBeLessThanOrEqual(2);
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(orch.runningWorkers).toBe(0);
  }, 30_000);
});

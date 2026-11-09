/**
 * Orchestrator — mirrors Claude Code's in-process sub-agents (Agent tool + parent_tool_use_id)
 * into AgentInfo records, and runs worker agents as separate CLI processes with a concurrency cap.
 */
import type { AgentInfo, AgentRole, AgentState, ApiContentBlock, ApiToolResultBlock, ApiToolUseBlock, CliEvent, Settings } from '@aim/shared';
import { isCliAssistant, isCliResult, isCliStream, isCliUser, newId } from '@aim/shared';
import type { ChatStore } from './chat-store.js';
import type { ClaudeCliBridge, CliTurnHandle } from './cli-bridge.js';
import { createLogger, type Logger } from './logger.js';
import { buildWorkerSystemPrompt, roleDisplayName } from './prompts.js';
import { summarizeToolUse } from './tool-summaries.js';

export interface OrchestratorDeps {
  store: ChatStore;
  cli: ClaudeCliBridge;
  settings: () => Settings;
  /** Called whenever the agent list of a chat changed. */
  onAgents?: (chatId: string, agents: AgentInfo[]) => void;
  buildMcpConfig?: (chatId: string) => string;
  memoryDigest?: () => Promise<string>;
  log?: Logger;
}

export interface WorkerSpec {
  role: AgentRole;
  name: string;
  task: string;
  cwd?: string;
}

export interface WorkerResult {
  agentId: string;
  result: string;
  ok: boolean;
}

const KNOWN_ROLES: AgentRole[] = ['orchestrator', 'planner', 'browser_operator', 'desktop_operator', 'researcher', 'coder', 'verifier', 'reflector', 'goal_planner'];

/** Maps Claude Code's `subagent_type` to an AIM role. */
export function roleFromSubagentType(t: unknown): AgentRole {
  if (typeof t !== 'string') return 'researcher';
  const s = t.toLowerCase().replace(/-/g, '_');
  if ((KNOWN_ROLES as string[]).includes(s)) return s as AgentRole;
  if (s.includes('browser') || s.includes('web')) return 'browser_operator';
  if (s.includes('desktop') || s.includes('computer')) return 'desktop_operator';
  if (s.includes('plan')) return 'planner';
  if (s.includes('verif') || s.includes('review') || s.includes('test')) return 'verifier';
  if (s.includes('code') || s.includes('dev') || s.includes('engineer')) return 'coder';
  // 'general-purpose', 'Explore', … → researcher
  return 'researcher';
}

function isAgentToolUse(b: ApiContentBlock): b is ApiToolUseBlock {
  return b.type === 'tool_use' && (b.name === 'Agent' || b.name === 'Task');
}

interface WorkerJob {
  chatId: string;
  spec: WorkerSpec;
  agent: AgentInfo;
  resolve: (r: WorkerResult) => void;
}

export class Orchestrator {
  private readonly log: Logger;
  /** Live sub-agent records per chat (mirrors the store, avoids a read per event). */
  private readonly agents = new Map<string, Map<string, AgentInfo>>();
  private readonly queue: WorkerJob[] = [];
  private readonly running = new Map<string, { job: WorkerJob; handle: CliTurnHandle }>();

  constructor(private readonly deps: OrchestratorDeps) {
    this.log = deps.log ?? createLogger('core:orch');
  }

  // ─── in-process sub-agent mirroring ───

  private chatAgents(chatId: string): Map<string, AgentInfo> {
    let m = this.agents.get(chatId);
    if (!m) {
      m = new Map();
      for (const a of this.deps.store.getAgents(chatId)) m.set(a.id, a);
      this.agents.set(chatId, m);
    }
    return m;
  }

  getAgents(chatId: string): AgentInfo[] {
    return [...this.chatAgents(chatId).values()].sort((a, b) => a.startedAt - b.startedAt);
  }

  private save(agent: AgentInfo): void {
    this.chatAgents(agent.chatId).set(agent.id, agent);
    try {
      this.deps.store.upsertAgent(agent);
    } catch (err) {
      this.log.error('upsertAgent failed', err);
    }
  }

  private notify(chatId: string): void {
    try {
      this.deps.onAgents?.(chatId, this.getAgents(chatId));
    } catch (err) {
      this.log.error('onAgents listener threw', err);
    }
  }

  /**
   * Feed every CLI event of a chat turn here. Returns true when the agent list changed.
   *  - assistant tool_use "Agent"/"Task" → new AgentInfo (spawning)
   *  - any event with parent_tool_use_id = X → agent X is running (+ lastActivity)
   *  - user tool_result for X → agent X done/failed
   */
  handleCliEvent(chatId: string, e: CliEvent): boolean {
    let changed = false;
    const now = Date.now();
    const parent = (e as { parent_tool_use_id?: string | null }).parent_tool_use_id;

    if (typeof parent === 'string' && parent) {
      const agent = this.chatAgents(chatId).get(parent) ?? this.createImplicit(chatId, parent, now);
      let activity: string | undefined;
      if (isCliAssistant(e)) {
        for (const b of e.message.content) {
          if (b.type === 'tool_use') activity = summarizeToolUse(b.name, b.input);
          else if (b.type === 'text' && b.text.trim() && !activity) activity = b.text.trim().slice(0, 80);
        }
      }
      if (agent.state === 'spawning' || agent.state === 'waiting') {
        agent.state = 'running';
        changed = true;
      }
      if (activity && activity !== agent.lastActivity) {
        agent.lastActivity = activity;
        changed = true;
      }
      if (changed) this.save(agent);
      // Sub-agent streams and results do not affect the parent's agent list otherwise.
      if (isCliStream(e) || isCliResult(e)) {
        if (changed) this.notify(chatId);
        return changed;
      }
    }

    if (isCliAssistant(e) && !parent) {
      for (const b of e.message.content) {
        if (!isAgentToolUse(b)) continue;
        if (this.chatAgents(chatId).has(b.id)) continue;
        const input = (b.input ?? {}) as { subagent_type?: unknown; description?: unknown; prompt?: unknown; name?: unknown };
        const role = roleFromSubagentType(input.subagent_type);
        const task = typeof input.description === 'string' && input.description ? input.description : typeof input.prompt === 'string' ? input.prompt.slice(0, 120) : undefined;
        const agent: AgentInfo = {
          id: b.id,
          chatId,
          role,
          name: typeof input.name === 'string' && input.name ? input.name : roleDisplayName(role),
          state: 'spawning',
          startedAt: now,
        };
        if (task) agent.task = task;
        this.save(agent);
        changed = true;
      }
    }

    if (isCliUser(e) && Array.isArray(e.message.content)) {
      for (const b of e.message.content) {
        if (b.type !== 'tool_result') continue;
        const agent = this.chatAgents(chatId).get(b.tool_use_id);
        if (!agent || agent.state === 'done' || agent.state === 'failed' || agent.state === 'cancelled') continue;
        agent.state = (b as ApiToolResultBlock).is_error ? 'failed' : 'done';
        agent.endedAt = now;
        this.save(agent);
        changed = true;
      }
    }

    if (changed) this.notify(chatId);
    return changed;
  }

  private createImplicit(chatId: string, toolUseId: string, now: number): AgentInfo {
    // Activity for a sub-agent we never saw spawn (e.g. resumed mid-flight).
    const agent: AgentInfo = { id: toolUseId, chatId, role: 'researcher', name: 'Sub-agent', state: 'running', startedAt: now };
    this.save(agent);
    return agent;
  }

  /** Marks every live agent of a chat as cancelled (turn aborted or process died). */
  cancelAll(chatId: string, state: AgentState = 'cancelled'): void {
    let changed = false;
    const now = Date.now();
    for (const a of this.chatAgents(chatId).values()) {
      if (a.state === 'spawning' || a.state === 'running' || a.state === 'waiting') {
        a.state = state;
        a.endedAt = now;
        this.save(a);
        changed = true;
      }
    }
    for (const [id, r] of this.running) {
      if (r.job.chatId === chatId) {
        r.handle.abort();
        this.running.delete(id);
      }
    }
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const job = this.queue[i];
      if (job.chatId === chatId) {
        this.queue.splice(i, 1);
        job.agent.state = 'cancelled';
        job.agent.endedAt = now;
        this.save(job.agent);
        job.resolve({ agentId: job.agent.id, result: 'Cancelled before start.', ok: false });
        changed = true;
      }
    }
    if (changed) this.notify(chatId);
  }

  forgetChat(chatId: string): void {
    this.cancelAll(chatId);
    this.agents.delete(chatId);
  }

  // ─── worker agents (separate CLI processes) ───

  /** Runs a task in a separate CLI process with a role-specific system prompt. Honours maxParallelAgents. */
  spawnWorker(chatId: string, spec: WorkerSpec): Promise<WorkerResult> {
    const agent: AgentInfo = {
      id: newId('agent'),
      chatId,
      role: spec.role,
      name: spec.name || roleDisplayName(spec.role),
      state: 'spawning',
      task: spec.task.slice(0, 200),
      startedAt: Date.now(),
    };
    this.save(agent);
    this.notify(chatId);
    return new Promise<WorkerResult>((resolve) => {
      this.queue.push({ chatId, spec, agent, resolve });
      this.pump();
    });
  }

  private maxParallel(): number {
    const n = this.deps.settings().maxParallelAgents;
    return Number.isFinite(n) && n > 0 ? n : 1;
  }

  private pump(): void {
    while (this.running.size < this.maxParallel() && this.queue.length > 0) {
      const job = this.queue.shift()!;
      void this.runJob(job);
    }
  }

  private async runJob(job: WorkerJob): Promise<void> {
    const { agent, spec, chatId } = job;
    const settings = this.deps.settings();
    let memoryDigest = '';
    try {
      memoryDigest = (await this.deps.memoryDigest?.()) ?? '';
    } catch (err) {
      this.log.warn('memoryDigest failed', err);
    }
    const chat = this.deps.store.getChatSummary(chatId);
    const cwd = spec.cwd || chat?.cwd || settings.defaultCwd || process.cwd();
    const systemPrompt = buildWorkerSystemPrompt(spec.role, agent.name, { platform: process.platform, now: new Date(), memoryDigest });

    let handle: CliTurnHandle;
    try {
      handle = this.deps.cli.start({
        cwd,
        model: spec.role === 'planner' || spec.role === 'researcher' || spec.role === 'verifier' ? settings.model || 'sonnet' : settings.model || undefined,
        effort: settings.effort || undefined,
        maxBudgetUsd: settings.maxBudgetUsdPerTurn || undefined,
        appendSystemPrompt: systemPrompt,
        mcpConfigJson: this.deps.buildMcpConfig?.(chatId),
        addDirs: settings.additionalDirs?.length ? settings.additionalDirs : undefined,
      });
    } catch (err) {
      this.finishJob(job, { agentId: agent.id, result: `Failed to start worker: ${err instanceof Error ? err.message : String(err)}`, ok: false });
      return;
    }
    this.running.set(agent.id, { job, handle });

    handle.on('event', (e) => {
      if (e.type === 'system' && (e as { subtype?: string }).subtype === 'init') {
        agent.sessionId = (e as { session_id?: string }).session_id;
        agent.state = 'running';
        this.save(agent);
        this.notify(chatId);
      } else if (isCliAssistant(e)) {
        const tu = e.message.content.find((b): b is ApiToolUseBlock => b.type === 'tool_use');
        if (tu) {
          agent.lastActivity = summarizeToolUse(tu.name, tu.input);
          this.save(agent);
          this.notify(chatId);
        }
      }
    });

    handle.send({ text: `Task from the orchestrator:\n\n${spec.task}` });
    handle.end();

    const res = await handle.done;
    this.running.delete(agent.id);
    const text = res.resultText?.trim() || res.errorMessage || (res.ok ? '(no output)' : 'Worker failed without output.');
    this.finishJob(job, { agentId: agent.id, result: text, ok: res.ok });
  }

  private finishJob(job: WorkerJob, result: WorkerResult): void {
    const { agent } = job;
    if (agent.state !== 'cancelled') {
      agent.state = result.ok ? 'done' : 'failed';
      agent.endedAt = Date.now();
      agent.lastActivity = result.result.slice(0, 80);
      this.save(agent);
      this.notify(agent.chatId);
    }
    job.resolve(result);
    this.pump();
  }

  /** Number of worker processes currently running. */
  get runningWorkers(): number {
    return this.running.size;
  }

  dispose(): void {
    for (const [, r] of this.running) r.handle.abort();
    this.running.clear();
    for (const job of this.queue.splice(0)) job.resolve({ agentId: job.agent.id, result: 'Cancelled.', ok: false });
  }
}

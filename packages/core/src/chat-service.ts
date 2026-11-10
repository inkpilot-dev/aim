/**
 * ChatService — the object the Electron main process drives. Owns chat turns:
 * persists messages, runs one CLI process per turn, translates CliEvents into ChatStreamEvents,
 * mirrors sub-agents, self-heals failed turns and answers tool callbacks (tasks_*, ask_user, agents_status).
 */
import os from 'node:os';
import type {
  AgentInfo,
  AgentRole,
  ApiContentBlock,
  ApiToolResultBlock,
  Attachment,
  Chat,
  ChatProgress,
  ChatStatus,
  ChatStreamEvent,
  ChatTask,
  ChatWithMessages,
  CliEvent,
  ContentBlock,
  Message,
  Settings,
  ToolUseBlock,
} from '@aim/shared';
import { computeProgress, isCliAssistant, isCliInit, isCliResult, isCliStream, isCliUser, newId } from '@aim/shared';
import { ChatStore, DEFAULT_CHAT_TITLE } from './chat-store.js';
import type { ClaudeCliBridge, CliRunResult, CliTurnHandle } from './cli-bridge.js';
import { createLogger, type Logger } from './logger.js';
import { Orchestrator } from './orchestrator.js';
import { buildAgentsJson, buildSystemPrompt } from './prompts.js';
import { SelfHealer } from './self-healer.js';
import { summarizeToolResult } from './tool-summaries.js';

export interface ChatServiceDeps {
  store: ChatStore;
  cli: ClaudeCliBridge;
  /** Live settings getter. */
  settings: () => Settings;
  /** Desktop supplies the --mcp-config JSON (tools-mcp path, hub url/token, chat id). */
  buildMcpConfig: (chatId: string) => string;
  /** Learning supplies; '' when disabled. */
  memoryDigest: () => Promise<string>;
  behaviorDigest?: () => Promise<string>;
  /** Reflector hook, called after each successfully completed turn. */
  onTurnComplete?: (chat: ChatWithMessages, turnMessages: Message[]) => void | Promise<void>;
  /** Optional: whether the browser extension is connected right now (feeds the system prompt). */
  extensionConnected?: () => boolean;
  /** Optional hard limit for one CLI turn; none by default. */
  turnTimeoutMs?: number;
  log?: Logger;
}

const TITLE_MAX = 60;
const ASK_USER_DEFAULT_TIMEOUT_MS = 600_000;
export const NO_ANSWER_TEXT = '(no answer — proceed with your best judgement)';
const CANCELLED_ANSWER_TEXT = '(cancelled by the user)';

interface TurnInput {
  text: string;
  images?: { mediaType: string; dataBase64: string }[];
}

interface QueuedTurn extends TurnInput {
  userMessage: Message;
}

interface ActiveTurn {
  chatId: string;
  handle: CliTurnHandle;
  assistant: Message;
  /** Content index where the current API message's blocks start. */
  segmentBase: number;
  /** An API message segment is open once we saw message_start (or an assistant event without one). */
  segmentOpen: boolean;
  apiMessageId?: string;
  /** Streamed block (apiMessageId:index) → index in assistant.content. */
  keyToIdx: Map<string, number>;
  /** Content indices whose text was finalised by a full `assistant` event; late deltas for them are ignored. */
  finalized: Set<number>;
  turnMessages: Message[];
  stopped: boolean;
  /** Whether a `--resume` failure already triggered a fresh-session retry. */
  resumeRetried: boolean;
  dirty: boolean;
}

interface PendingQuestion {
  chatId: string;
  resolve: (answer: string) => void;
  timer: NodeJS.Timeout;
}

export class ChatService {
  private readonly log: Logger;
  private readonly store: ChatStore;
  private readonly listeners = new Set<(e: ChatStreamEvent) => void>();
  private readonly active = new Map<string, ActiveTurn>();
  /** Chats whose turn is being set up (system prompt build) but has no CLI process yet. */
  private readonly starting = new Map<string, { stopped: boolean }>();
  private readonly queue = new Map<string, QueuedTurn[]>();
  private readonly questions = new Map<string, PendingQuestion>();
  private readonly healer: SelfHealer;
  private readonly orchestrator: Orchestrator;
  private disposed = false;

  constructor(private readonly deps: ChatServiceDeps) {
    this.log = deps.log ?? createLogger('core:chat');
    this.store = deps.store;
    this.healer = new SelfHealer({ maxAttempts: () => deps.settings().maxSelfHealAttempts, log: this.log.child('heal') });
    this.orchestrator = new Orchestrator({
      store: deps.store,
      cli: deps.cli,
      settings: deps.settings,
      buildMcpConfig: deps.buildMcpConfig,
      memoryDigest: deps.memoryDigest,
      log: this.log.child('orch'),
      onAgents: (chatId, agents) => this.emit({ type: 'agents', chatId, agents }),
    });
  }

  // ─── events ───

  on(cb: (e: ChatStreamEvent) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private emit(e: ChatStreamEvent): void {
    for (const cb of [...this.listeners]) {
      try {
        cb(e);
      } catch (err) {
        this.log.error('chat event listener threw', err);
      }
    }
  }

  private emitChatUpdated(chatId: string): void {
    const chat = this.store.getChatSummary(chatId);
    if (chat) this.emit({ type: 'chat.updated', chat });
  }

  private setStatus(chatId: string, status: ChatStatus): void {
    try {
      this.store.updateChat(chatId, { status });
    } catch (err) {
      this.log.warn('status update failed (chat deleted?)', err);
      return;
    }
    this.emit({ type: 'status', chatId, status });
    this.emitChatUpdated(chatId);
  }

  // ─── chats ───

  listChats(): Chat[] {
    return this.store.listChats();
  }

  getChat(id: string): ChatWithMessages | null {
    return this.store.getChat(id);
  }

  createChat(input: { title?: string; cwd?: string; origin?: Chat['origin']; goalId?: string } = {}): Chat {
    const settings = this.deps.settings();
    const chat = this.store.createChat({
      title: input.title,
      cwd: input.cwd || settings.defaultCwd || os.homedir(),
      origin: input.origin ?? 'user',
      goalId: input.goalId,
    });
    this.emit({ type: 'chat.updated', chat });
    return chat;
  }

  renameChat(id: string, title: string): void {
    const t = title.trim();
    if (!t) return;
    this.store.updateChat(id, { title: t });
    this.emit({ type: 'title', chatId: id, title: t });
    this.emitChatUpdated(id);
  }

  deleteChat(id: string): void {
    void this.stop(id).catch((err) => this.log.warn('stop before delete failed', err));
    this.orchestrator.forgetChat(id);
    this.healer.reset(id);
    this.queue.delete(id);
    this.store.deleteChat(id);
    this.emit({ type: 'chat.deleted', chatId: id });
  }

  setPinned(id: string, v: boolean): void {
    this.store.updateChat(id, { pinned: v });
    this.emitChatUpdated(id);
  }

  setArchived(id: string, v: boolean): void {
    this.store.updateChat(id, { archived: v });
    this.emitChatUpdated(id);
  }

  search(q: string): Chat[] {
    return this.store.search(q);
  }

  isBusy(chatId: string): boolean {
    return this.active.has(chatId) || this.starting.has(chatId) || (this.queue.get(chatId)?.length ?? 0) > 0;
  }

  getAgents(chatId: string): AgentInfo[] {
    return this.orchestrator.getAgents(chatId);
  }

  // ─── sending ───

  /** Persists the user message and starts a turn, or queues it when a turn is already running. */
  async sendMessage(input: { chatId: string; text: string; attachments?: Attachment[] }): Promise<void> {
    if (this.disposed) throw new Error('ChatService disposed');
    const chat = this.store.getChatSummary(input.chatId);
    if (!chat) throw new Error(`Chat not found: ${input.chatId}`);

    const text = input.text ?? '';
    const content: ContentBlock[] = [];
    const images: { mediaType: string; dataBase64: string }[] = [];
    const fileNotes: string[] = [];
    for (const a of input.attachments ?? []) {
      if ((a.kind === 'image' || a.kind === 'screenshot') && a.dataBase64) {
        content.push({ type: 'image', mediaType: a.mediaType, dataBase64: a.dataBase64, alt: a.name });
        images.push({ mediaType: a.mediaType, dataBase64: a.dataBase64 });
      } else if (a.path) {
        fileNotes.push(`[Attached file: ${a.path}]`);
      }
    }
    const fullText = [text.trim(), ...fileNotes].filter(Boolean).join('\n');
    if (fullText) content.unshift({ type: 'text', text: fullText });
    if (content.length === 0) throw new Error('Empty message');

    const userMessage: Message = { id: newId('msg'), chatId: chat.id, role: 'user', content, createdAt: Date.now() };
    this.store.appendMessage(userMessage);
    this.emit({ type: 'message.start', chatId: chat.id, message: userMessage });
    this.emit({ type: 'message.end', chatId: chat.id, message: userMessage });

    // Auto-title from the first user message.
    if (chat.title === DEFAULT_CHAT_TITLE && text.trim()) {
      const t = text.replace(/\s+/g, ' ').trim();
      const title = t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t;
      this.store.updateChat(chat.id, { title });
      this.emit({ type: 'title', chatId: chat.id, title });
    }
    this.emitChatUpdated(chat.id);

    const turn: QueuedTurn = { text: fullText || '(see attached image)', images: images.length ? images : undefined, userMessage };
    if (this.active.has(chat.id) || this.starting.has(chat.id)) {
      const q = this.queue.get(chat.id) ?? [];
      q.push(turn);
      this.queue.set(chat.id, q);
      this.log.info(`chat ${chat.id}: queued message (${q.length} pending)`);
      return;
    }
    this.startTurn(chat.id, turn, [userMessage]);
  }

  /** Starts a CLI turn; completion is handled asynchronously. */
  private startTurn(chatId: string, input: TurnInput, turnMessages: Message[], opts: { resumeRetried?: boolean } = {}): void {
    this.starting.set(chatId, { stopped: false });
    const run = this.runTurn(chatId, input, turnMessages, opts).catch((err: unknown) => {
      // runTurn handles its own errors; this is a last line of defence.
      this.log.error('runTurn crashed', err);
      this.starting.delete(chatId);
      this.active.delete(chatId);
      this.emit({ type: 'error', chatId, error: err instanceof Error ? err.message : String(err), recoverable: false });
      this.setStatus(chatId, 'waiting_user');
    });
    void run;
  }

  private async buildPrompt(): Promise<string> {
    let memoryDigest = '';
    let behaviorDigest: string | undefined;
    try {
      memoryDigest = await this.deps.memoryDigest();
    } catch (err) {
      this.log.warn('memoryDigest failed', err);
    }
    try {
      behaviorDigest = await this.deps.behaviorDigest?.();
    } catch (err) {
      this.log.warn('behaviorDigest failed', err);
    }
    return buildSystemPrompt({
      memoryDigest,
      behaviorDigest,
      platform: process.platform,
      now: new Date(),
      extensionConnected: this.deps.extensionConnected?.(),
    });
  }

  private async runTurn(chatId: string, input: TurnInput, turnMessages: Message[], opts: { resumeRetried?: boolean }): Promise<void> {
    const chat = this.store.getChatSummary(chatId);
    if (!chat) {
      this.starting.delete(chatId);
      return;
    }
    const settings = this.deps.settings();
    this.setStatus(chatId, 'thinking');

    const assistant: Message = { id: newId('msg'), chatId, role: 'assistant', content: [], createdAt: Date.now() };
    this.store.appendMessage(assistant);
    turnMessages.push(assistant);
    this.emit({ type: 'message.start', chatId, message: assistant });

    const systemPrompt = await this.buildPrompt();
    const starting = this.starting.get(chatId);
    this.starting.delete(chatId);
    if (starting?.stopped || this.disposed) {
      // stop()/dispose() arrived while the prompt was being built: do not spawn anything.
      this.store.updateMessage(assistant);
      this.emit({ type: 'message.end', chatId, message: assistant });
      this.setStatus(chatId, 'idle');
      return;
    }
    const handle = this.deps.cli.start({
      cwd: chat.cwd || settings.defaultCwd || os.homedir(),
      sessionId: chat.sessionId,
      model: settings.model || undefined,
      effort: settings.effort || undefined,
      maxBudgetUsd: settings.maxBudgetUsdPerTurn > 0 ? settings.maxBudgetUsdPerTurn : undefined,
      appendSystemPrompt: systemPrompt,
      agentsJson: buildAgentsJson(),
      mcpConfigJson: this.deps.buildMcpConfig(chatId),
      addDirs: settings.additionalDirs?.length ? settings.additionalDirs : undefined,
      timeoutMs: this.deps.turnTimeoutMs,
    });

    const turn: ActiveTurn = {
      chatId,
      handle,
      assistant,
      segmentBase: 0,
      segmentOpen: false,
      keyToIdx: new Map(),
      finalized: new Set(),
      turnMessages,
      stopped: false,
      resumeRetried: opts.resumeRetried ?? false,
      dirty: false,
    };
    this.active.set(chatId, turn);

    handle.on('event', (e) => {
      try {
        this.onCliEvent(turn, e);
      } catch (err) {
        this.log.error('event handling failed', err);
      }
    });
    handle.on('stderr', (line) => this.log.debug(`[cli ${chatId}] ${line}`));

    handle.send(input);
    handle.end(); // one message per process; the CLI exits after `result`

    const result = await handle.done;
    this.persist(turn, true);
    this.active.delete(chatId);
    await this.finishTurn(turn, input, result);
  }

  // ─── CLI event translation ───

  private onCliEvent(turn: ActiveTurn, e: CliEvent): void {
    const { chatId } = turn;
    if (isCliInit(e)) {
      if (e.session_id) {
        this.store.updateChat(chatId, { sessionId: e.session_id });
        this.emitChatUpdated(chatId);
      }
      return;
    }

    const parent = (e as { parent_tool_use_id?: string | null }).parent_tool_use_id;
    if (typeof parent === 'string' && parent) {
      // Sub-agent activity: mirrored into AgentInfo; sub-agent tool results still attach to the Agent block.
      this.orchestrator.handleCliEvent(chatId, e);
      return;
    }

    if (isCliStream(e)) {
      this.onStreamEvent(turn, e.event as { type: string; [k: string]: unknown });
      return;
    }

    if (isCliAssistant(e)) {
      this.orchestrator.handleCliEvent(chatId, e);
      this.onAssistantMessage(turn, e.message.id, e.message.content);
      return;
    }

    if (isCliUser(e)) {
      this.orchestrator.handleCliEvent(chatId, e);
      const content = e.message.content;
      if (Array.isArray(content)) {
        for (const b of content) if (b.type === 'tool_result') this.attachToolResult(turn, b.tool_use_id, b);
      }
      return;
    }

    if (isCliResult(e)) {
      const usage = e.usage ?? {};
      turn.assistant.usage = {
        inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined,
        outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined,
        costUsd: typeof e.total_cost_usd === 'number' ? e.total_cost_usd : undefined,
        durationMs: typeof e.duration_ms === 'number' ? e.duration_ms : undefined,
        numTurns: typeof e.num_turns === 'number' ? e.num_turns : undefined,
      };
      // If nothing was streamed (e.g. no partial messages), make sure the final text is present.
      if (typeof e.result === 'string' && e.result.trim() && !turn.assistant.content.some((b) => b.type === 'text' && b.text.trim())) {
        const idx = turn.assistant.content.push({ type: 'text', text: e.result }) - 1;
        this.emit({ type: 'message.block', chatId, messageId: turn.assistant.id, blockIndex: idx, block: turn.assistant.content[idx] });
      }
      turn.dirty = true;
    }
  }

  private openSegment(turn: ActiveTurn, apiMessageId: string | undefined): void {
    if (turn.segmentOpen && (apiMessageId === undefined || turn.apiMessageId === undefined || turn.apiMessageId === apiMessageId)) {
      if (apiMessageId && !turn.apiMessageId) turn.apiMessageId = apiMessageId;
      return;
    }
    turn.segmentBase = turn.assistant.content.length;
    turn.segmentOpen = true;
    turn.apiMessageId = apiMessageId;
  }

  private streamKey(turn: ActiveTurn, index: number): string {
    return `${turn.apiMessageId ?? 'msg'}:${index}`;
  }

  /** Index in assistant.content for a streamed block, appending a new block when unseen. */
  private streamIdx(turn: ActiveTurn, index: number, make: () => ContentBlock): number {
    const key = this.streamKey(turn, index);
    const known = turn.keyToIdx.get(key);
    if (known !== undefined) return known;
    const idx = turn.assistant.content.push(make()) - 1;
    turn.keyToIdx.set(key, idx);
    turn.dirty = true;
    return idx;
  }

  private onStreamEvent(turn: ActiveTurn, ev: { type: string; [k: string]: unknown }): void {
    const { chatId } = turn;
    const msg = turn.assistant;
    switch (ev.type) {
      case 'message_start': {
        const m = ev.message as { id?: string } | undefined;
        turn.segmentOpen = false;
        this.openSegment(turn, m?.id);
        this.setStatus(chatId, 'thinking');
        break;
      }
      case 'message_stop':
        // Keep the segment open: without partial-message interleaving the full `assistant` event for this
        // API message arrives after message_stop. The next message_start (or a different id) resets it.
        break;
      case 'content_block_start': {
        this.openSegment(turn, turn.apiMessageId);
        const cb = ev.content_block as ApiContentBlock | undefined;
        if (!cb) break;
        let make: (() => ContentBlock) | undefined;
        if (cb.type === 'text') make = () => ({ type: 'text', text: cb.text ?? '' });
        else if (cb.type === 'thinking') make = () => ({ type: 'thinking', text: cb.thinking ?? '' });
        else if (cb.type === 'tool_use') {
          // The full `assistant` event for this block may already have arrived; reuse it by tool id.
          const existingIdx = msg.content.findIndex((b) => b.type === 'tool_use' && b.id === cb.id);
          if (existingIdx >= 0) {
            turn.keyToIdx.set(this.streamKey(turn, Number(ev.index ?? 0)), existingIdx);
            break;
          }
          make = () => ({ type: 'tool_use', id: cb.id, name: cb.name, input: cb.input ?? {} });
        }
        if (!make) break;
        const idx = this.streamIdx(turn, Number(ev.index ?? 0), make);
        const block = msg.content[idx];
        if (block.type === 'tool_use') this.setStatus(chatId, 'working');
        this.emit({ type: 'message.block', chatId, messageId: msg.id, blockIndex: idx, block });
        break;
      }
      case 'content_block_delta': {
        const delta = ev.delta as { type: string; text?: string; thinking?: string; partial_json?: string } | undefined;
        if (!delta) break;
        const index = Number(ev.index ?? 0);
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          const idx = this.streamIdx(turn, index, () => ({ type: 'text', text: '' }));
          if (turn.finalized.has(idx)) break; // the full assistant event already carried this text
          const b = msg.content[idx];
          if (b.type === 'text') b.text += delta.text;
          this.emit({ type: 'message.delta', chatId, messageId: msg.id, blockIndex: idx, delta: { text: delta.text } });
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          const idx = this.streamIdx(turn, index, () => ({ type: 'thinking', text: '' }));
          if (turn.finalized.has(idx)) break;
          const b = msg.content[idx];
          if (b.type === 'thinking') b.text += delta.thinking;
          this.emit({ type: 'message.delta', chatId, messageId: msg.id, blockIndex: idx, delta: { thinking: delta.thinking } });
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          const idx = turn.keyToIdx.get(this.streamKey(turn, index));
          if (idx !== undefined) this.emit({ type: 'message.delta', chatId, messageId: msg.id, blockIndex: idx, delta: { partialJson: delta.partial_json } });
        }
        turn.dirty = true;
        break;
      }
      default:
        break;
    }
  }



  /**
   * Full assistant content. The CLI emits one `assistant` event per content block (interleaved with the
   * stream, sometimes before the block's last deltas) or, without partial messages, one event with every
   * block. Blocks are matched by identity — tool_use by id, text/thinking by prefix within the current API
   * message — so nothing is duplicated whichever order the events arrive in.
   */
  private onAssistantMessage(turn: ActiveTurn, apiMessageId: string | undefined, blocks: ApiContentBlock[]): void {
    const { chatId } = turn;
    if (apiMessageId && turn.apiMessageId && apiMessageId !== turn.apiMessageId) turn.segmentOpen = false;
    this.openSegment(turn, apiMessageId);
    const content = turn.assistant.content;
    const emitBlock = (idx: number) => this.emit({ type: 'message.block', chatId, messageId: turn.assistant.id, blockIndex: idx, block: content[idx] });

    for (const cb of blocks) {
      if (cb.type === 'tool_use') {
        const idx = content.findIndex((b) => b.type === 'tool_use' && b.id === cb.id);
        if (idx >= 0) {
          const prev = content[idx] as ToolUseBlock;
          content[idx] = { ...prev, name: cb.name, input: cb.input };
        } else {
          content.push({ type: 'tool_use', id: cb.id, name: cb.name, input: cb.input });
        }
        const at = idx >= 0 ? idx : content.length - 1;
        turn.finalized.add(at);
        turn.dirty = true;
        this.setStatus(chatId, 'working');
        emitBlock(at);
        continue;
      }
      if (cb.type !== 'text' && cb.type !== 'thinking') continue;
      const text = cb.type === 'text' ? cb.text : cb.thinking;
      // Prefer the latest unfinalised streamed block of the same type in this API message whose text is a
      // prefix of the final text (or empty); an identical finalised block means we already have it.
      let target = -1;
      for (let i = content.length - 1; i >= turn.segmentBase; i--) {
        const b = content[i];
        if (b.type !== cb.type) continue;
        if (turn.finalized.has(i)) {
          if (b.text === text) {
            target = -2;
            break;
          }
          continue;
        }
        if (b.text === '' || text.startsWith(b.text) || b.text.startsWith(text)) {
          target = i;
          break;
        }
      }
      if (target === -2) continue;
      if (target >= 0) {
        content[target] = { type: cb.type, text };
      } else {
        content.push({ type: cb.type, text });
        target = content.length - 1;
      }
      turn.finalized.add(target);
      turn.dirty = true;
      emitBlock(target);
    }
    this.persist(turn);
  }

  private attachToolResult(turn: ActiveTurn, toolUseId: string, block: { content?: unknown; is_error?: boolean }): void {
    const content = turn.assistant.content;
    for (let i = content.length - 1; i >= 0; i--) {
      const b = content[i];
      if (b.type === 'tool_use' && b.id === toolUseId) {
        b.result = summarizeToolResult(b.name, { content: block.content as ApiToolResultBlock['content'], is_error: block.is_error });
        turn.dirty = true;
        this.emit({ type: 'message.block', chatId: turn.chatId, messageId: turn.assistant.id, blockIndex: i, block: b });
        this.persist(turn);
        return;
      }
    }
  }

  private persist(turn: ActiveTurn, force = false): void {
    if (!turn.dirty && !force) return;
    try {
      this.store.updateMessage(turn.assistant);
      turn.dirty = false;
    } catch (err) {
      this.log.warn('persist assistant message failed', err);
    }
  }

  // ─── turn completion / self-healing ───

  private async finishTurn(turn: ActiveTurn, input: TurnInput, result: CliRunResult): Promise<void> {
    const { chatId } = turn;
    if (result.sessionId) {
      try {
        this.store.updateChat(chatId, { sessionId: result.sessionId });
      } catch {
        /* chat deleted meanwhile */
      }
    }
    if (!this.store.getChatSummary(chatId)) return; // deleted during the turn

    if (turn.stopped) {
      this.addStatusBlock(turn, 'Stopped by the user.');
      this.orchestrator.cancelAll(chatId);
      this.healer.reset(chatId);
      this.emit({ type: 'message.end', chatId, message: turn.assistant });
      this.setStatus(chatId, 'idle');
      this.queue.delete(chatId);
      return;
    }

    if (result.ok) {
      this.emit({ type: 'message.end', chatId, message: turn.assistant });
      this.healer.reset(chatId);
      const tasks = this.store.getTasks(chatId);
      const progress = computeProgress(tasks);
      const allDone = tasks.length > 0 && progress.done + progress.failed === tasks.length;
      this.setStatus(chatId, allDone ? 'done' : 'idle');
      await this.notifyTurnComplete(chatId, turn.turnMessages);
      this.runNextQueued(chatId);
      return;
    }

    const errorMessage = result.errorMessage ?? 'The turn failed.';
    this.log.warn(`chat ${chatId}: turn failed — ${errorMessage}`);

    // A stale --resume id (session file gone): drop it and retry once with a fresh session, not counted as self-heal.
    if (!turn.resumeRetried && /no conversation found|session .* not found|could not resume|invalid session/i.test(errorMessage)) {
      const chat = this.store.getChatSummary(chatId);
      if (chat?.sessionId) {
        this.log.info(`chat ${chatId}: stale session ${chat.sessionId}; retrying without --resume`);
        this.store.updateChat(chatId, { sessionId: undefined });
        this.addStatusBlock(turn, 'Previous session unavailable; starting a fresh session.');
        this.emit({ type: 'message.end', chatId, message: turn.assistant });
        this.startTurn(chatId, input, turn.turnMessages, { resumeRetried: true });
        return;
      }
    }

    if (this.healer.shouldRetry(chatId, result)) {
      const attempt = this.healer.nextAttempt(chatId);
      const max = this.healer.maxAttempts();
      this.addStatusBlock(turn, `Self-repair attempt ${attempt}/${max}: ${errorMessage}`);
      this.emit({ type: 'message.end', chatId, message: turn.assistant });
      this.emit({ type: 'self_heal', chatId, attempt, max, error: errorMessage });
      const repair = this.healer.buildRepairPrompt(result, attempt);
      this.startTurn(chatId, { text: repair }, turn.turnMessages, { resumeRetried: turn.resumeRetried });
      return;
    }

    this.addStatusBlock(turn, `Failed: ${errorMessage}`);
    this.emit({ type: 'message.end', chatId, message: turn.assistant });
    this.orchestrator.cancelAll(chatId, 'failed');
    this.healer.reset(chatId);
    this.emit({ type: 'error', chatId, error: errorMessage, recoverable: false });
    this.setStatus(chatId, 'waiting_user');
    this.runNextQueued(chatId);
  }

  private addStatusBlock(turn: ActiveTurn, text: string): void {
    const idx = turn.assistant.content.push({ type: 'status', text }) - 1;
    turn.dirty = true;
    this.persist(turn);
    this.emit({ type: 'message.block', chatId: turn.chatId, messageId: turn.assistant.id, blockIndex: idx, block: turn.assistant.content[idx] });
  }

  private async notifyTurnComplete(chatId: string, turnMessages: Message[]): Promise<void> {
    if (!this.deps.onTurnComplete) return;
    const chat = this.store.getChat(chatId);
    if (!chat) return;
    try {
      await this.deps.onTurnComplete(chat, turnMessages);
    } catch (err) {
      this.log.warn('onTurnComplete failed', err);
    }
  }

  private runNextQueued(chatId: string): void {
    const q = this.queue.get(chatId);
    if (!q || q.length === 0) return;
    const next = q.shift()!;
    if (q.length === 0) this.queue.delete(chatId);
    this.startTurn(chatId, { text: next.text, images: next.images }, [next.userMessage]);
  }

  // ─── stop ───

  async stop(chatId: string): Promise<void> {
    this.queue.delete(chatId);
    for (const [id, q] of this.questions) {
      if (q.chatId === chatId) this.answerQuestion(chatId, id, CANCELLED_ANSWER_TEXT);
    }
    const starting = this.starting.get(chatId);
    if (starting) {
      starting.stopped = true;
      await waitFor(() => !this.starting.has(chatId), 5_000);
    }
    const turn = this.active.get(chatId);
    if (!turn) {
      const chat = this.store.getChatSummary(chatId);
      if (chat && chat.status !== 'idle' && chat.status !== 'done') this.setStatus(chatId, 'idle');
      return;
    }
    turn.stopped = true;
    turn.handle.abort();
    await turn.handle.done;
  }

  // ─── tool callbacks (desktop ToolRouter) ───

  setTasks(chatId: string, tasks: { title: string; state?: ChatTask['state']; detail?: string }[]): ChatProgress {
    if (!this.store.getChatSummary(chatId)) throw new Error(`Chat not found: ${chatId}`);
    const now = Date.now();
    const list: ChatTask[] = tasks.map((t, i) => {
      const task: ChatTask = { id: newId('task'), chatId, title: t.title.trim() || `Task ${i + 1}`, state: t.state ?? 'pending', order: i, createdAt: now, updatedAt: now };
      if (t.detail) task.detail = t.detail;
      return task;
    });
    this.store.setTasks(chatId, list);
    return this.emitTasks(chatId);
  }

  updateTask(chatId: string, sel: { index?: number; title?: string }, patch: { state: ChatTask['state']; detail?: string }): ChatProgress {
    const tasks = this.store.getTasks(chatId);
    let target: ChatTask | undefined;
    if (typeof sel.index === 'number') target = tasks[sel.index];
    if (!target && sel.title) {
      const t = sel.title.trim().toLowerCase();
      target = tasks.find((x) => x.title.toLowerCase() === t) ?? tasks.find((x) => x.title.toLowerCase().includes(t));
    }
    if (!target) throw new Error(`Task not found (${typeof sel.index === 'number' ? `index ${sel.index}` : `title "${sel.title ?? ''}"`}); ${tasks.length} tasks exist`);
    target.state = patch.state;
    if (patch.detail !== undefined) target.detail = patch.detail;
    target.updatedAt = Date.now();
    this.store.setTasks(chatId, tasks);
    return this.emitTasks(chatId);
  }

  private emitTasks(chatId: string): ChatProgress {
    const tasks = this.store.getTasks(chatId);
    const progress = computeProgress(tasks);
    this.emit({ type: 'tasks', chatId, tasks, progress });
    this.emitChatUpdated(chatId);
    return progress;
  }

  /** Emits ask_user and waits for answerQuestion (or the timeout). */
  askUser(chatId: string, question: string, options?: string[], timeoutMs = ASK_USER_DEFAULT_TIMEOUT_MS): Promise<string> {
    const requestId = newId('q');
    return new Promise<string>((resolve) => {
      const timer = setTimeout(() => this.answerQuestion(chatId, requestId, NO_ANSWER_TEXT), Math.max(1_000, timeoutMs));
      timer.unref?.();
      this.questions.set(requestId, { chatId, resolve, timer });
      this.emit({ type: 'ask_user', chatId, requestId, question, options });
      if (this.store.getChatSummary(chatId)) this.setStatus(chatId, 'waiting_user');
    });
  }

  answerQuestion(chatId: string, requestId: string, answer: string): void {
    const q = this.questions.get(requestId);
    if (!q) return;
    clearTimeout(q.timer);
    this.questions.delete(requestId);
    this.emit({ type: 'ask_user.resolved', chatId, requestId });
    const stillWaiting = [...this.questions.values()].some((x) => x.chatId === chatId);
    if (!stillWaiting && this.active.has(chatId)) this.setStatus(chatId, 'working');
    q.resolve(answer);
  }

  /** Run a sub-task in a separate CLI process (worker agent) and return its result text. */
  spawnWorker(chatId: string, spec: { role: AgentRole; name: string; task: string; cwd?: string }): Promise<{ agentId: string; result: string; ok: boolean }> {
    if (!this.store.getChatSummary(chatId)) return Promise.reject(new Error(`Chat not found: ${chatId}`));
    return this.orchestrator.spawnWorker(chatId, spec);
  }

  dispose(): void {
    this.disposed = true;
    for (const [id, q] of this.questions) {
      clearTimeout(q.timer);
      q.resolve(CANCELLED_ANSWER_TEXT);
      this.questions.delete(id);
    }
    for (const s of this.starting.values()) s.stopped = true;
    for (const turn of this.active.values()) {
      turn.stopped = true;
      turn.handle.abort();
    }
    this.queue.clear();
    this.orchestrator.dispose();
    this.deps.cli.dispose();
    this.listeners.clear();
  }
}

/** Polls `pred` every 10 ms until true or the timeout elapses (never rejects). */
function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (pred() || Date.now() - start > timeoutMs) return resolve();
      setTimeout(tick, 10);
    };
    tick();
  });
}

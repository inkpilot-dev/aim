import type { Chat, ChatStreamEvent, Settings } from '@aim/shared';
import { DEFAULT_SETTINGS } from '@aim/shared';
import type { ChatServiceLike, CliRunOptionsLike, CliRunResultLike, LoggerLike, OneShotRunnerLike } from '../deps.js';

export const settingsOf = (over: Partial<Settings> = {}) => (): Settings => ({ ...DEFAULT_SETTINGS, ...over });

export class FakeRunner implements OneShotRunnerLike {
  calls: { prompt: string; opts: CliRunOptionsLike }[] = [];
  constructor(private readonly respond: (prompt: string, opts: CliRunOptionsLike) => CliRunResultLike | Promise<CliRunResultLike>) {}
  async runOnce(prompt: string, opts: CliRunOptionsLike): Promise<CliRunResultLike> {
    this.calls.push({ prompt, opts });
    return this.respond(prompt, opts);
  }
}

export const okResult = (structured: unknown, resultText?: string): CliRunResultLike => ({ ok: true, isError: false, structured, resultText, exitCode: 0 });
export const textResult = (text: string): CliRunResultLike => ({ ok: true, isError: false, resultText: text, exitCode: 0 });
export const errResult = (msg: string): CliRunResultLike => ({ ok: false, isError: true, errorMessage: msg, exitCode: 1 });

export class CollectingLogger implements LoggerLike {
  lines: { level: string; args: unknown[] }[] = [];
  debug = (...a: unknown[]) => void this.lines.push({ level: 'debug', args: a });
  info = (...a: unknown[]) => void this.lines.push({ level: 'info', args: a });
  warn = (...a: unknown[]) => void this.lines.push({ level: 'warn', args: a });
  error = (...a: unknown[]) => void this.lines.push({ level: 'error', args: a });
  text(): string {
    return this.lines.map((l) => `${l.level}: ${l.args.map(String).join(' ')}`).join('\n');
  }
}

/** Minimal ChatService stand-in: emits a configurable status sequence after sendMessage. */
export class FakeChatService implements ChatServiceLike {
  chats: Chat[] = [];
  sent: { chatId: string; text: string }[] = [];
  private listeners = new Set<(e: ChatStreamEvent) => void>();
  /** Statuses emitted (asynchronously) after each sendMessage. */
  script: Array<(chatId: string) => ChatStreamEvent[]> = [];
  failSend = false;

  createChat(input: { title?: string; cwd?: string; origin?: Chat['origin']; goalId?: string } = {}): Chat {
    const chat: Chat = {
      id: `chat_${this.chats.length + 1}`,
      title: input.title ?? 'New chat',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: 'idle',
      origin: input.origin ?? 'user',
      ...(input.goalId ? { goalId: input.goalId } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
    };
    this.chats.push(chat);
    // ChatService may emit an idle status on creation — the runner must ignore it.
    this.emit({ type: 'status', chatId: chat.id, status: 'idle' });
    return chat;
  }
  async sendMessage(input: { chatId: string; text: string }): Promise<void> {
    if (this.failSend) throw new Error('cli unavailable');
    this.sent.push(input);
    const next = this.script.shift();
    const events = next ? next(input.chatId) : [
      { type: 'status', chatId: input.chatId, status: 'working' } as ChatStreamEvent,
      { type: 'status', chatId: input.chatId, status: 'done' } as ChatStreamEvent,
    ];
    setTimeout(() => {
      for (const e of events) this.emit(e);
    }, 5);
  }
  on(cb: (e: ChatStreamEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  emit(e: ChatStreamEvent): void {
    for (const l of Array.from(this.listeners)) l(e);
  }
  get listenerCount(): number {
    return this.listeners.size;
  }
}

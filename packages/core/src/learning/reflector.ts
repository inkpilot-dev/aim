import os from 'node:os';
import type { ChatWithMessages, MemoryEntry, MemoryKind, Message, Settings } from '@aim/shared';
import { REFLECTION_JSON_SCHEMA } from '@aim/shared';
import type { LoggerLike, OneShotRunnerLike } from './deps.js';
import { asNumber, asString, clamp01, errorMessage, extractJsonObject, scopedLogger } from './deps.js';
import type { MemoryStore } from './memory-store.js';

export interface ReflectorOptions {
  runner: OneShotRunnerLike;
  memory: MemoryStore;
  settings: () => Settings;
  log?: LoggerLike;
  /** Model alias for the reflection run (default 'haiku'). */
  model?: string;
}

export interface ReflectionResult {
  memories: MemoryEntry[];
  chatTitle?: string;
}

const MAX_TRANSCRIPT_CHARS = 8000;
const MIN_TURN_CHARS = 200;
const MAX_MEMORIES = 10;
const TIMEOUT_MS = 90_000;
const KINDS: readonly MemoryKind[] = ['preference', 'fact', 'lesson', 'procedure', 'goal_feedback'];

/** Post-turn reflection: extracts durable memories about the user (and a chat title) with a cheap model. */
export class Reflector {
  private readonly o: ReflectorOptions;
  private readonly log: LoggerLike;

  constructor(opts: ReflectorOptions) {
    this.o = opts;
    this.log = scopedLogger(opts.log, 'reflector');
  }

  async reflect(chat: ChatWithMessages, turnMessages: Message[]): Promise<ReflectionResult> {
    try {
      if (!this.o.settings().reflectionEnabled) return { memories: [] };
      const assistantCount = turnMessages.filter((m) => m.role === 'assistant').length;
      if (assistantCount < 1) return { memories: [] };
      const transcript = buildTranscript(turnMessages);
      if (transcript.chars < MIN_TURN_CHARS) return { memories: [] };

      const wantTitle = needsTitle(chat);
      const prompt = this.buildPrompt(chat, transcript.text, wantTitle);
      const result = await this.o.runner.runOnce(prompt, {
        cwd: os.homedir(),
        jsonSchema: REFLECTION_JSON_SCHEMA,
        model: this.o.model ?? 'haiku',
        timeoutMs: TIMEOUT_MS,
      });
      if (!result.ok || result.isError) {
        this.log.warn('reflection run failed', result.errorMessage ?? `exit ${result.exitCode ?? 'n/a'}`);
        return { memories: [] };
      }
      const parsed = extractJsonObject(result);
      if (!parsed) {
        this.log.warn('reflection output was not JSON');
        return { memories: [] };
      }

      const memories: MemoryEntry[] = [];
      const raw = Array.isArray(parsed.memories) ? parsed.memories : [];
      for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const r = item as Record<string, unknown>;
        const key = asString(r.key).trim().slice(0, 120);
        const value = asString(r.value).replace(/\s+/g, ' ').trim().slice(0, 600);
        if (!key || !value) continue;
        const kind = KINDS.includes(r.kind as MemoryKind) ? (r.kind as MemoryKind) : 'fact';
        const confidence = clamp01(asNumber(r.confidence, 0.6));
        if (confidence < 0.3) continue; // too speculative to keep
        try {
          memories.push(this.o.memory.remember({ key, value, kind, confidence, source: 'reflection' }));
        } catch (e) {
          this.log.warn('remember failed', key, errorMessage(e));
        }
        if (memories.length >= MAX_MEMORIES) break;
      }
      const out: ReflectionResult = { memories };
      const title = asString(parsed.chatTitle).replace(/\s+/g, ' ').trim().slice(0, 80);
      if (wantTitle && title) out.chatTitle = title;
      this.log.info(`stored ${memories.length} memories from chat ${chat.id}${out.chatTitle ? ` (title: "${out.chatTitle}")` : ''}`);
      return out;
    } catch (e) {
      this.log.error('reflection failed', errorMessage(e));
      return { memories: [] };
    }
  }

  buildPrompt(chat: ChatWithMessages, transcript: string, wantTitle: boolean): string {
    const existingKeys = this.o.memory
      .list()
      .slice(0, 60)
      .map((m) => m.key);
    const lines = [
      'You are the reflection step of A.I.M., a desktop assistant. Review the transcript of one completed conversation turn and extract DURABLE memories about the USER that will help in future sessions.',
      '',
      'Extract only things that stay true beyond this conversation:',
      '- preference: how the user likes things done (tools, style, browser, formats, schedule)',
      '- fact: stable facts about the user, their accounts, devices, projects, people',
      '- procedure: a sequence of steps that worked for a recurring task on this machine',
      '- lesson: what went wrong and what to do differently next time',
      '- goal_feedback: how the user reacted to planned goals or autonomous work',
      '',
      'Do NOT record transient details (one-off values, timestamps, intermediate tool output), secrets, passwords or card data. Skip the memories array entirely when nothing durable was learned.',
      'Use short snake_case keys that describe the memory (e.g. "preferred_browser", "inbox_cleanup_procedure"). Reuse an existing key when the memory refines or confirms it.',
      existingKeys.length ? `Existing memory keys: ${existingKeys.join(', ')}` : 'There are no existing memories yet.',
      `Return at most ${MAX_MEMORIES} memories with confidence between 0 and 1.`,
    ];
    if (wantTitle) lines.push('Also provide "chatTitle": a title of at most 6 words describing what this chat is about.');
    lines.push('', `## Chat: ${chat.title || '(untitled)'}`, '', '## Transcript', transcript);
    return lines.join('\n');
  }
}

// ─── helpers ───

/** Compact transcript: user/assistant text and tool names, trimmed to MAX_TRANSCRIPT_CHARS (head + tail). */
export function buildTranscript(messages: Message[]): { text: string; chars: number } {
  const parts: string[] = [];
  let chars = 0;
  for (const m of messages) {
    if (m.role === 'system') continue;
    const who = m.role === 'user' ? 'User' : 'AIM';
    const texts: string[] = [];
    const tools: string[] = [];
    for (const b of m.content) {
      if (b.type === 'text' && b.text.trim()) texts.push(b.text.trim());
      else if (b.type === 'tool_use') tools.push(b.name.replace(/^mcp__aim__/, '') + (b.result && !b.result.ok ? ' (failed)' : ''));
    }
    const text = texts.join('\n');
    chars += text.length;
    if (text) parts.push(`${who}: ${text}`);
    if (tools.length) parts.push(`${who} used tools: ${tools.join(', ')}`);
  }
  let text = parts.join('\n');
  if (text.length > MAX_TRANSCRIPT_CHARS) {
    const head = Math.floor(MAX_TRANSCRIPT_CHARS * 0.5);
    const tail = MAX_TRANSCRIPT_CHARS - head - 20;
    text = `${text.slice(0, head)}\n[… ${text.length - head - tail} chars omitted …]\n${text.slice(-tail)}`;
  }
  return { text, chars };
}

/** True when the chat still has a placeholder title or one derived from the first user message. */
export function needsTitle(chat: ChatWithMessages): boolean {
  const title = (chat.title ?? '').trim();
  if (!title || /^new chat$/i.test(title) || /^untitled/i.test(title)) return true;
  const firstUser = chat.messages.find((m) => m.role === 'user');
  const firstText = firstUser?.content.find((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')?.text.trim();
  if (!firstText) return false;
  const stem = title.replace(/[…]|\.{3}$/g, '').trim().toLowerCase();
  return stem.length > 0 && firstText.toLowerCase().startsWith(stem);
}

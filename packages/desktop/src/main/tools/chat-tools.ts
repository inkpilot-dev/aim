/** tasks_set / tasks_update / ask_user / agents_status → ChatService (from @aim/core). */
import type { ChatService } from '@aim/core';
import type { ChatTask } from '@aim/shared';
import type { ToolImpl } from './tool-router.js';

const STATES: ChatTask['state'][] = ['pending', 'in_progress', 'done', 'failed', 'skipped'];

export function createChatTools(getService: () => ChatService | null): Record<string, ToolImpl> {
  const need = (ctx: { chatId?: string }): { svc: ChatService; chatId: string } | { error: string } => {
    const svc = getService();
    if (!svc) return { error: 'Chat service is not available (core failed to start).' };
    if (!ctx.chatId) return { error: 'This tool needs a chat context (AIM_CHAT_ID was not provided to the MCP proxy).' };
    return { svc, chatId: ctx.chatId };
  };

  const tasks_set: ToolImpl = async (args, ctx) => {
    const n = need(ctx);
    if ('error' in n) return { ok: false, error: n.error };
    const raw = Array.isArray(args['tasks']) ? (args['tasks'] as unknown[]) : [];
    const tasks = raw
      .map((t) => (t && typeof t === 'object' ? (t as Record<string, unknown>) : null))
      .filter((t): t is Record<string, unknown> => !!t && typeof t['title'] === 'string' && !!(t['title'] as string).trim())
      .map((t) => ({ title: (t['title'] as string).trim().slice(0, 140), state: STATES.includes(t['state'] as ChatTask['state']) ? (t['state'] as ChatTask['state']) : undefined, detail: typeof t['detail'] === 'string' ? (t['detail'] as string) : undefined }));
    if (!tasks.length) return { ok: false, error: 'tasks must contain at least one {title}.' };
    const progress = n.svc.setTasks(n.chatId, tasks);
    return { ok: true, text: `Task list set (${progress.total} task(s)). ${progress.label || ''}`.trim(), data: progress };
  };

  const tasks_update: ToolImpl = async (args, ctx) => {
    const n = need(ctx);
    if ('error' in n) return { ok: false, error: n.error };
    const state = args['state'];
    if (!STATES.includes(state as ChatTask['state'])) return { ok: false, error: `state must be one of ${STATES.join(', ')}.` };
    const sel: { index?: number; title?: string } = {};
    if (typeof args['index'] === 'number') sel.index = args['index'] as number;
    if (typeof args['title'] === 'string') sel.title = args['title'] as string;
    if (sel.index === undefined && !sel.title) return { ok: false, error: 'Provide index or title to select the task.' };
    const progress = n.svc.updateTask(n.chatId, sel, { state: state as ChatTask['state'], detail: typeof args['detail'] === 'string' ? (args['detail'] as string) : undefined });
    return { ok: true, text: `Task updated. Progress ${progress.done}/${progress.total}${progress.label ? ` — ${progress.label}` : ''}.`, data: progress };
  };

  const ask_user: ToolImpl = async (args, ctx) => {
    const n = need(ctx);
    if ('error' in n) return { ok: false, error: n.error };
    const question = String(args['question'] ?? '').trim();
    if (!question) return { ok: false, error: 'question is required.' };
    const options = Array.isArray(args['options']) ? (args['options'] as unknown[]).map(String).filter(Boolean).slice(0, 8) : undefined;
    const timeoutSec = typeof args['timeoutSec'] === 'number' && args['timeoutSec'] > 0 ? Math.min(3600, args['timeoutSec'] as number) : 600;
    try {
      const answer = await n.svc.askUser(n.chatId, question, options, timeoutSec * 1000);
      return { ok: true, text: answer, data: { answer } };
    } catch (err) {
      return { ok: false, error: `No answer from the user: ${(err as Error).message}. Continue with your best judgement or stop and summarise.` };
    }
  };

  const agents_status: ToolImpl = async (_args, ctx) => {
    const n = need(ctx);
    if ('error' in n) return { ok: false, error: n.error };
    const agents = n.svc.getAgents(n.chatId);
    if (!agents.length) return { ok: true, text: 'No worker agents are running for this chat.', data: { agents } };
    const text = agents.map((a) => `- ${a.name} [${a.role}] ${a.state}${a.task ? `: ${a.task}` : ''}${a.lastActivity ? ` (${a.lastActivity})` : ''}`).join('\n');
    return { ok: true, text, data: { agents } };
  };

  return { tasks_set, tasks_update, ask_user, agents_status };
}

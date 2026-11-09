/**
 * ToolRouter — validates and dispatches every `tools.call` from the hub to the implementing
 * module, wrapped in the payment guard. Never throws: every outcome is a ToolResult.
 */
import { AIM_TOOLS, RpcErrorCode, getToolDefinition, type HubToolsCallParams, type ToolDefinition, type ToolResult } from '@aim/shared';
import { blockedResult, checkPolicy, type PolicyContext } from './policy.js';

export interface ToolCallContext {
  chatId?: string;
  agentId?: string;
  toolUseId?: string;
  tool: ToolDefinition;
}

export type ToolImpl = (args: Record<string, unknown>, ctx: ToolCallContext) => Promise<ToolResult> | ToolResult;

export interface ToolRouterOptions {
  impls: Record<string, ToolImpl>;
  policy?: PolicyContext;
  log?: { debug(...a: unknown[]): void; info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void };
  /** Called before/after every tool call (for UI activity, overlay, metrics). */
  onCall?: (info: { name: string; chatId?: string; durationMs: number; ok: boolean; blocked?: boolean }) => void;
  /** Hard per-call timeout (ms); ask_user is exempt. Default 5 minutes. */
  timeoutMs?: number;
}

export class ToolRouter {
  private readonly impls: Record<string, ToolImpl>;
  constructor(private readonly opts: ToolRouterOptions) {
    this.impls = opts.impls;
  }

  /** Names in the catalogue with no implementation registered (useful for a startup warning). */
  missingImplementations(): string[] {
    return AIM_TOOLS.filter((t) => !this.impls[t.name]).map((t) => t.name);
  }

  register(name: string, impl: ToolImpl): void {
    this.impls[name] = impl;
  }

  async call(params: HubToolsCallParams): Promise<ToolResult> {
    const started = Date.now();
    const name = typeof params?.name === 'string' ? params.name : '';
    const args = params?.args && typeof params.args === 'object' ? params.args : {};
    const tool = getToolDefinition(name);
    if (!tool) {
      return { ok: false, error: `Unknown tool "${name}". Available tools: ${AIM_TOOLS.map((t) => t.name).join(', ')}.`, errorCode: RpcErrorCode.MethodNotFound };
    }
    const impl = this.impls[name];
    if (!impl) {
      return { ok: false, error: `Tool "${name}" is not available on this platform/build.`, errorCode: RpcErrorCode.MethodNotFound };
    }
    const missing = (tool.inputSchema.required ?? []).filter((k) => args[k] === undefined || args[k] === null);
    if (missing.length) {
      return { ok: false, error: `Missing required argument(s) for ${name}: ${missing.join(', ')}.`, errorCode: RpcErrorCode.InvalidParams };
    }

    let verdict;
    try {
      verdict = await checkPolicy(name, args, this.opts.policy);
    } catch (err) {
      verdict = { blocked: false, reason: (err as Error).message };
    }
    if (verdict.blocked) {
      this.opts.log?.warn(`policy blocked ${name}: ${verdict.reason}`);
      this.opts.onCall?.({ name, chatId: params.chatId, durationMs: Date.now() - started, ok: false, blocked: true });
      return blockedResult(verdict);
    }

    const ctx: ToolCallContext = { chatId: params.chatId, agentId: params.agentId, toolUseId: params.toolUseId, tool };
    let result: ToolResult;
    try {
      const run = Promise.resolve(impl(args, ctx));
      const timeoutMs = name === 'ask_user' || name === 'browser_wait' ? 0 : (this.opts.timeoutMs ?? 5 * 60_000);
      result = timeoutMs > 0 ? await withTimeout(run, timeoutMs, name) : await run;
      if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
        result = { ok: true, data: result };
      }
    } catch (err) {
      const e = err as Error & { code?: number };
      result = {
        ok: false,
        error: `${name} failed: ${e?.message ?? String(err)}`,
        errorCode: typeof e?.code === 'number' ? e.code : RpcErrorCode.ToolFailed,
      };
      this.opts.log?.warn(`tool ${name} failed`, e?.message);
    }
    this.opts.onCall?.({ name, chatId: params.chatId, durationMs: Date.now() - started, ok: result.ok });
    return result;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      const e = new Error(`${label} timed out after ${Math.round(ms / 1000)} s`) as Error & { code?: number };
      e.code = RpcErrorCode.Timeout;
      reject(e);
    }, ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err) => {
        clearTimeout(t);
        reject(err);
      },
    );
  });
}

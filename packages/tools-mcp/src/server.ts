/**
 * The MCP server half of the proxy: serves tools/list and tools/call to the Claude CLI
 * and forwards them to the Hub over the HubClient.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { AIM_TOOLS, MCP_SERVER_NAME, type HubToolsCallParams, type HubToolsListResult, type ToolDefinition, type ToolResult } from '@aim/shared';
import type { HubClient } from './hub-client.js';
import { errorToMcp, toolResultToMcp } from './convert.js';

export interface ProxyServerOptions {
  hub: HubClient;
  chatId?: string;
  version?: string;
  /** Per tool call timeout (ms). ask_user may legitimately wait a long time. */
  callTimeoutMs?: number;
  /** How long tools/list waits for the hub before falling back to the static catalogue (ms). */
  listTimeoutMs?: number;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

export const DEFAULT_CALL_TIMEOUT_MS = 10 * 60 * 1000;

function toMcpTool(t: ToolDefinition) {
  return {
    name: t.name,
    description: t.description,
    inputSchema: { ...(t.inputSchema as Record<string, unknown>), type: 'object' as const },
  };
}

export function createProxyServer(opts: ProxyServerOptions): Server {
  const { hub } = opts;
  const callTimeoutMs = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const listTimeoutMs = opts.listTimeoutMs ?? 4_000;
  const log = opts.log ?? (() => undefined);

  const server = new Server(
    { name: MCP_SERVER_NAME, version: opts.version ?? '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'A.I.M. desktop tools: screen, mouse/keyboard, windows, browser (via the A.I.M. extension), memory, tasks and goals. Every tool returns ok/error text; on error, read the message and retry or adjust. Payments are never performed.',
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      const res = await hub.request<HubToolsListResult>('tools.list', {}, listTimeoutMs);
      if (res && Array.isArray(res.tools) && res.tools.length > 0) {
        return { tools: res.tools.map(toMcpTool) };
      }
    } catch (err) {
      log('warn', `tools.list via hub failed (${(err as Error).message}); serving static catalogue`);
    }
    return { tools: AIM_TOOLS.map(toMcpTool) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const params: HubToolsCallParams = { name, args, chatId: opts.chatId };
    // ask_user carries its own timeout; honour it (plus slack) so a long wait is not cut short.
    let timeout = callTimeoutMs;
    if (name === 'ask_user' && typeof args['timeoutSec'] === 'number' && Number.isFinite(args['timeoutSec'])) {
      timeout = Math.max(callTimeoutMs, (args['timeoutSec'] as number) * 1000 + 30_000);
    }
    try {
      const result = await hub.request<ToolResult>('tools.call', params, timeout);
      return toolResultToMcp(result);
    } catch (err) {
      log('warn', `tools.call ${name} failed: ${(err as Error).message}`);
      return errorToMcp(err, `A.I.M. tool "${name}" failed`);
    }
  });

  return server;
}

/**
 * Hub protocol — the WebSocket link between the Electron main process ("Hub") and:
 *   (a) the MCP proxy (`@aim/tools-mcp`) spawned by the Claude CLI for each chat,
 *   (b) the browser extension (see extension.ts).
 * Transport: JSON-RPC envelopes from rpc.ts, one JSON object per WebSocket text frame.
 * Auth: first message from a client must be `hub.hello` carrying the token from ENV_HUB_TOKEN
 * (the extension uses the token the user pasted / the pairing code).
 */
import type { ToolDefinition, ToolResult } from './tools.js';

export interface HubHelloParams {
  token: string;
  client: 'mcp-proxy' | 'extension' | 'internal';
  /** For mcp-proxy: the chat this CLI process belongs to (from ENV_CHAT_ID). */
  chatId?: string;
  /** Free-form version / UA. */
  version?: string;
  /** For extension: browser name ("edge" | "chrome" | ...). */
  browser?: string;
}
export interface HubHelloResult { ok: true; hubVersion: string; serverTime: number }

/** MCP-proxy → Hub */
export interface HubToolsListResult { tools: ToolDefinition[] }
export interface HubToolsCallParams { name: string; args: Record<string, unknown>; chatId?: string; agentId?: string; toolUseId?: string }
export type HubToolsCallResult = ToolResult;

/** Hub → MCP-proxy notifications (rare) */
export interface HubToolsCancelParams { toolUseId: string }

export type HubMethod =
  | 'hub.hello'
  | 'tools.list'
  | 'tools.call'
  | 'tools.cancel'
  | 'hub.ping';

export const HUB_VERSION = '1';

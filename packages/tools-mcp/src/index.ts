#!/usr/bin/env node
/**
 * @aim/tools-mcp — stdio MCP server that proxies tools/list and tools/call to the A.I.M. Hub
 * over WebSocket. Spawned by the Claude CLI (via --mcp-config) once per chat.
 *
 * Environment (set by the Hub in the mcp-config):
 *   AIM_HUB_URL   ws://127.0.0.1:<port>   (HUB_PATH_TOOLS is appended if missing)
 *   AIM_HUB_TOKEN pairing token
 *   AIM_CHAT_ID   chat this CLI process belongs to
 *
 * Runs under `node dist/index.js` and under Electron with ELECTRON_RUN_AS_NODE=1.
 * All diagnostics go to stderr; stdout is reserved for the MCP transport.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ENV_CHAT_ID, ENV_HUB_TOKEN, ENV_HUB_URL } from '@aim/shared';
import { resolveHubUrl } from './env.js';
import { HubClient } from './hub-client.js';
import { createProxyServer } from './server.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
const minLevel = LEVELS[(process.env['AIM_LOG_LEVEL'] as keyof typeof LEVELS) ?? 'info'] ?? LEVELS.info;
function log(level: keyof typeof LEVELS, message: string): void {
  if (LEVELS[level] < minLevel) return;
  process.stderr.write(`[aim-tools-mcp] ${level} ${message}\n`);
}

async function main(): Promise<void> {
  const url = resolveHubUrl(process.env[ENV_HUB_URL]);
  const token = process.env[ENV_HUB_TOKEN] ?? '';
  const chatId = process.env[ENV_CHAT_ID] || undefined;
  if (!token) log('warn', `${ENV_HUB_TOKEN} is not set; the hub will reject this proxy`);

  const hub = new HubClient({ url, token, chatId, log });
  hub.connect();
  const server = createProxyServer({ hub, chatId, log });
  const transport = new StdioServerTransport();

  let stopping = false;
  const shutdown = (why: string) => {
    if (stopping) return;
    stopping = true;
    log('info', `shutting down (${why})`);
    hub.close();
    void server.close().catch(() => undefined);
    setTimeout(() => process.exit(0), 50).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.stdin.on('close', () => shutdown('stdin closed'));
  transport.onclose = () => shutdown('transport closed');

  await server.connect(transport);
  log('info', `ready; hub ${url}${chatId ? ` chat ${chatId}` : ''}`);
}

main().catch((err) => {
  log('error', `fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});

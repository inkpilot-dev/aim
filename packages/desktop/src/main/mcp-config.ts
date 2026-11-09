/**
 * Builds the --mcp-config JSON for one chat: the `aim` server is the @aim/tools-mcp proxy, run by
 * Electron itself as Node (ELECTRON_RUN_AS_NODE=1) so no separate Node install is required.
 *
 * Path resolution for the proxy entry (first hit wins):
 *   1. AIM_TOOLS_MCP_PATH env override
 *   2. <resourcesPath>/tools-mcp/index.js            (packaged: extraResources)
 *   3. require.resolve('@aim/tools-mcp')              (dev and packaged; inside app.asar it is
 *      rewritten to app.asar.unpacked — packaging MUST asarUnpack node_modules/@aim/tools-mcp/**)
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { ENV_CHAT_ID, ENV_HUB_TOKEN, ENV_HUB_URL, MCP_SERVER_NAME } from '@aim/shared';

export interface McpConfigDeps {
  hubToolsUrl: () => string;
  hubToken: () => string;
  isPackaged: boolean;
  resourcesPath?: string;
  execPath?: string;
  log?: { debug(...a: unknown[]): void; warn(...a: unknown[]): void };
}

let cachedEntry: string | null = null;

export function resolveToolsMcpEntry(deps: Pick<McpConfigDeps, 'isPackaged' | 'resourcesPath' | 'log'>): string {
  if (cachedEntry && fs.existsSync(cachedEntry)) return cachedEntry;
  const override = process.env['AIM_TOOLS_MCP_PATH'];
  if (override && fs.existsSync(override)) return (cachedEntry = override);

  if (deps.isPackaged && deps.resourcesPath) {
    const extra = path.join(deps.resourcesPath, 'tools-mcp', 'index.js');
    if (fs.existsSync(extra)) return (cachedEntry = extra);
  }
  let resolved = '';
  try {
    const req = createRequire(typeof __filename === 'string' ? __filename : import.meta.url);
    resolved = req.resolve('@aim/tools-mcp');
  } catch (err) {
    deps.log?.warn(`could not resolve @aim/tools-mcp: ${(err as Error).message}`);
  }
  if (resolved) {
    const unpacked = resolved.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    if (fs.existsSync(unpacked)) return (cachedEntry = unpacked);
    if (fs.existsSync(resolved)) return (cachedEntry = resolved);
  }
  // Last resort: monorepo layout relative to this file.
  const candidates = [
    path.resolve(process.cwd(), 'packages/tools-mcp/dist/index.js'),
    path.resolve(process.cwd(), '../tools-mcp/dist/index.js'),
    deps.resourcesPath ? path.join(deps.resourcesPath, 'app.asar.unpacked', 'node_modules', '@aim', 'tools-mcp', 'dist', 'index.js') : '',
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return (cachedEntry = c);
  deps.log?.warn('tools-mcp entry not found; MCP config will point at the resolved path anyway');
  return resolved || candidates[0]!;
}

export function buildMcpConfig(chatId: string, deps: McpConfigDeps): string {
  const entry = resolveToolsMcpEntry(deps);
  const command = deps.execPath ?? process.execPath;
  const env: Record<string, string> = {
    ELECTRON_RUN_AS_NODE: '1',
    ELECTRON_NO_ATTACH_CONSOLE: '1',
    [ENV_HUB_URL]: deps.hubToolsUrl(),
    [ENV_HUB_TOKEN]: deps.hubToken(),
    [ENV_CHAT_ID]: chatId,
  };
  return JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { command, args: [entry], env } } });
}

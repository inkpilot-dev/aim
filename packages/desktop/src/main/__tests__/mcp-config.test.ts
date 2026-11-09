import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { ENV_CHAT_ID, ENV_HUB_TOKEN, ENV_HUB_URL, MCP_SERVER_NAME } from '@aim/shared';
import { buildMcpConfig, resolveToolsMcpEntry } from '../mcp-config.js';

describe('mcp-config', () => {
  it('resolves the tools-mcp entry in the workspace and builds the config', () => {
    const entry = resolveToolsMcpEntry({ isPackaged: false });
    expect(entry).toMatch(/tools-mcp[\\/]dist[\\/]index\.js$/);
    expect(fs.existsSync(entry)).toBe(true);
    const json = buildMcpConfig('chat_42', { hubToolsUrl: () => 'ws://127.0.0.1:47821/aim/tools', hubToken: () => 'tok', isPackaged: false, execPath: '/path/to/electron' });
    const cfg = JSON.parse(json);
    const server = cfg.mcpServers[MCP_SERVER_NAME];
    expect(server.command).toBe('/path/to/electron');
    expect(server.args).toEqual([entry]);
    expect(server.env).toMatchObject({ ELECTRON_RUN_AS_NODE: '1', [ENV_HUB_URL]: 'ws://127.0.0.1:47821/aim/tools', [ENV_HUB_TOKEN]: 'tok', [ENV_CHAT_ID]: 'chat_42' });
  });
});

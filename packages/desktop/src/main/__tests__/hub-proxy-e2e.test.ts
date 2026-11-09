/**
 * End-to-end: Claude-side MCP client → real @aim/tools-mcp proxy (child process, built dist) →
 * real HubServer (in-process) → ToolRouter with fake implementations.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { AIM_TOOLS, ENV_CHAT_ID, ENV_HUB_TOKEN, ENV_HUB_URL, PAYMENT_BLOCK_MESSAGE } from '@aim/shared';
import { HubServer } from '../hub/hub-server.js';
import { ToolRouter } from '../tools/tool-router.js';
import { resolveToolsMcpEntry } from '../mcp-config.js';

const TOKEN = 'e2e-token';
const entry = resolveToolsMcpEntry({ isPackaged: false });
const haveProxy = fs.existsSync(entry);

describe.skipIf(!haveProxy)('hub ⇄ tools-mcp proxy end-to-end', () => {
  let hub: HubServer;
  let client: Client;
  const seen: { name: string; chatId?: string }[] = [];

  beforeAll(async () => {
    hub = new HubServer({ port: 0, token: () => TOKEN });
    await hub.start();
    const router = new ToolRouter({
      impls: {
        screen_info: async () => ({ ok: true, text: 'one display' }),
        keyboard_type: async (a) => ({ ok: true, text: `typed ${String(a['text']).length}` }),
      },
    });
    hub.toolHandler = (p) => {
      seen.push({ name: p.name, chatId: p.chatId });
      return router.call(p);
    };
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      env: { ...(process.env as Record<string, string>), [ENV_HUB_URL]: hub.url, [ENV_HUB_TOKEN]: TOKEN, [ENV_CHAT_ID]: 'chat_e2e' },
      stderr: 'ignore',
    });
    client = new Client({ name: 'e2e', version: '0' });
    await client.connect(transport);
  }, 20_000);

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    await hub?.stop();
  });

  it('lists the full catalogue through the hub and executes/blocks calls with the chat id', async () => {
    const list = await client.listTools();
    expect(list.tools.length).toBe(AIM_TOOLS.length);
    const ok = await client.callTool({ name: 'screen_info', arguments: {} });
    expect(ok.isError).toBeFalsy();
    expect((ok.content as { text: string }[])[0]?.text).toBe('one display');
    expect(seen[0]).toEqual({ name: 'screen_info', chatId: 'chat_e2e' });

    const blocked = await client.callTool({ name: 'keyboard_type', arguments: { text: '4242 4242 4242 4242' } });
    expect(blocked.isError).toBe(true);
    expect((blocked.content as { text: string }[])[0]?.text).toContain(PAYMENT_BLOCK_MESSAGE);

    const missing = await client.callTool({ name: 'mouse_move', arguments: { x: 1, y: 2 } });
    expect(missing.isError).toBe(true);
    expect((missing.content as { text: string }[])[0]?.text).toContain('not available');
  }, 20_000);
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AIM_TOOLS, HUB_PATH_TOOLS, PAYMENT_BLOCK_MESSAGE, RpcErrorCode, isRpcRequest, type RpcRequest } from '@aim/shared';
import { HubClient } from '../hub-client.js';
import { createProxyServer } from '../server.js';
import { toolResultToMcp } from '../convert.js';
import { resolveHubUrl } from '../env.js';

const TOKEN = 'test-token';

interface FakeHub {
  port: number;
  url: string;
  hellos: unknown[];
  calls: { name: string; args: Record<string, unknown>; chatId?: string }[];
  close(): Promise<void>;
  /** Whether tools.list should fail (to test the static fallback). */
  failList: boolean;
}

function startFakeHub(): Promise<FakeHub> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    const hub: FakeHub = {
      port: 0,
      url: '',
      hellos: [],
      calls: [],
      failList: false,
      close: () => new Promise((r) => wss.close(() => r())),
    };
    wss.on('connection', (ws: WebSocket, req) => {
      let authed = false;
      if (req.url !== HUB_PATH_TOOLS) {
        ws.close(4004, 'bad path');
        return;
      }
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as RpcRequest<string, Record<string, unknown>>;
        if (!isRpcRequest(msg)) return;
        if (!authed) {
          if (msg.method !== 'hub.hello' || msg.params['token'] !== TOKEN) {
            ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: RpcErrorCode.Unauthorized, message: 'bad token' } }));
            ws.close(4001, 'unauthorized');
            return;
          }
          authed = true;
          hub.hellos.push(msg.params);
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: true, hubVersion: '1', serverTime: Date.now() } }));
          return;
        }
        if (msg.method === 'tools.list') {
          if (hub.failList) {
            ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: RpcErrorCode.InternalError, message: 'boom' } }));
          } else {
            ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: AIM_TOOLS.slice(0, 3) } }));
          }
          return;
        }
        if (msg.method === 'tools.call') {
          const p = msg.params as { name: string; args: Record<string, unknown>; chatId?: string };
          hub.calls.push(p);
          let result: unknown;
          if (p.name === 'screen_capture') result = { ok: true, text: 'Screen 1920x1080', images: [{ mediaType: 'image/png', dataBase64: 'AAAA' }] };
          else if (p.name === 'browser_navigate') result = { ok: false, errorCode: RpcErrorCode.PolicyBlocked, error: `${PAYMENT_BLOCK_MESSAGE} URL looks like checkout` };
          else if (p.name === 'slow_tool') return; // never answers
          else result = { ok: true, data: { echoed: p.args } };
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
          return;
        }
        if (msg.method === 'hub.ping') {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { pong: true } }));
        }
      });
    });
    wss.on('listening', () => {
      const addr = wss.address() as { port: number };
      hub.port = addr.port;
      hub.url = `ws://127.0.0.1:${addr.port}${HUB_PATH_TOOLS}`;
      resolve(hub);
    });
  });
}

async function connectClient(server: ReturnType<typeof createProxyServer>): Promise<Client> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientT);
  return client;
}

describe('toolResultToMcp', () => {
  it('converts text, data and images', () => {
    const r = toolResultToMcp({ ok: true, text: 'hi', data: { a: 1 }, images: [{ mediaType: 'image/png', dataBase64: 'Zm9v' }] });
    expect(r.isError).toBeUndefined();
    expect(r.content[0]).toEqual({ type: 'text', text: 'hi' });
    expect(r.content[1]).toEqual({ type: 'text', text: JSON.stringify({ a: 1 }, null, 2) });
    expect(r.content[2]).toEqual({ type: 'image', data: 'Zm9v', mimeType: 'image/png' });
  });
  it('marks failures and adds the policy message for blocked results', () => {
    const r = toolResultToMcp({ ok: false, error: 'card number detected', errorCode: RpcErrorCode.PolicyBlocked });
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain(PAYMENT_BLOCK_MESSAGE);
    expect((r.content[0] as { text: string }).text).toContain('card number detected');
  });
  it('handles empty / missing results', () => {
    expect(toolResultToMcp({ ok: true }).content[0]).toEqual({ type: 'text', text: 'OK' });
    expect(toolResultToMcp(undefined).isError).toBe(true);
  });
});

describe('resolveHubUrl', () => {
  it('appends the tools path and defaults', () => {
    expect(resolveHubUrl('ws://127.0.0.1:47821')).toBe(`ws://127.0.0.1:47821${HUB_PATH_TOOLS}`);
    expect(resolveHubUrl('ws://127.0.0.1:1/aim/tools')).toBe('ws://127.0.0.1:1/aim/tools');
    expect(resolveHubUrl('127.0.0.1:5')).toBe(`ws://127.0.0.1:5${HUB_PATH_TOOLS}`);
    expect(resolveHubUrl(undefined)).toContain(HUB_PATH_TOOLS);
  });
});

describe('MCP proxy against a fake hub', () => {
  let hub: FakeHub;
  const clients: HubClient[] = [];
  beforeAll(async () => {
    hub = await startFakeHub();
  });
  afterAll(async () => {
    for (const c of clients) c.close();
    await hub.close();
  });

  it('sends hub.hello with token and chatId, lists tools from the hub, and round-trips a call', async () => {
    const hc = new HubClient({ url: hub.url, token: TOKEN, chatId: 'chat_1' });
    clients.push(hc);
    const server = createProxyServer({ hub: hc, chatId: 'chat_1', callTimeoutMs: 2_000 });
    const client = await connectClient(server);

    const list = await client.listTools();
    expect(list.tools.map((t) => t.name)).toEqual(AIM_TOOLS.slice(0, 3).map((t) => t.name));
    expect(list.tools[0]?.inputSchema.type).toBe('object');
    expect(hub.hellos[0]).toMatchObject({ token: TOKEN, client: 'mcp-proxy', chatId: 'chat_1' });

    const res = await client.callTool({ name: 'memory_recall', arguments: { query: 'x' } });
    expect(res.isError).toBeFalsy();
    expect((res.content as { type: string; text: string }[])[0]?.text).toContain('"echoed"');
    expect(hub.calls.at(-1)).toMatchObject({ name: 'memory_recall', args: { query: 'x' }, chatId: 'chat_1' });

    const shot = await client.callTool({ name: 'screen_capture', arguments: {} });
    const content = shot.content as { type: string; data?: string; mimeType?: string }[];
    expect(content.some((c) => c.type === 'image' && c.data === 'AAAA' && c.mimeType === 'image/png')).toBe(true);

    const blocked = await client.callTool({ name: 'browser_navigate', arguments: { tabId: 1, url: 'https://x/checkout' } });
    expect(blocked.isError).toBe(true);
    expect((blocked.content as { text: string }[])[0]?.text).toContain(PAYMENT_BLOCK_MESSAGE);
    await client.close();
  });

  it('times out a call that the hub never answers', async () => {
    const hc = new HubClient({ url: hub.url, token: TOKEN });
    clients.push(hc);
    const server = createProxyServer({ hub: hc, callTimeoutMs: 300 });
    const client = await connectClient(server);
    const res = await client.callTool({ name: 'slow_tool', arguments: {} });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0]?.text).toMatch(/timed out/i);
    await client.close();
  });

  it('falls back to the static catalogue when the hub list fails or the hub is unreachable', { timeout: 15_000 }, async () => {
    hub.failList = true;
    const hc = new HubClient({ url: hub.url, token: TOKEN });
    clients.push(hc);
    const server = createProxyServer({ hub: hc });
    const client = await connectClient(server);
    const list = await client.listTools();
    expect(list.tools.length).toBe(AIM_TOOLS.length);
    hub.failList = false;
    await client.close();

    const dead = new HubClient({ url: 'ws://127.0.0.1:1/aim/tools', token: TOKEN, minBackoffMs: 100_000 });
    clients.push(dead);
    const server2 = createProxyServer({ hub: dead, listTimeoutMs: 300, callTimeoutMs: 500 });
    const client2 = await connectClient(server2);
    const list2 = await client2.listTools();
    expect(list2.tools.length).toBe(AIM_TOOLS.length);
    const call = await client2.callTool({ name: 'screen_info', arguments: {} });
    expect(call.isError).toBe(true);
    await client2.close();
  });

  it('is rejected with 4001 on a wrong token and reports not connected', async () => {
    const hc = new HubClient({ url: hub.url, token: 'wrong', minBackoffMs: 100_000 });
    clients.push(hc);
    const closeCode = await new Promise<number>((resolve) => {
      hc.once('close', (code: number) => resolve(code));
      hc.connect();
    });
    expect(closeCode).toBe(4001);
    expect(hc.connected).toBe(false);
  });
});

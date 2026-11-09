import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { HUB_PATH_EXTENSION, HUB_PATH_TOOLS, RpcErrorCode, type RpcRequest, type ToolResult } from '@aim/shared';
import { HubServer } from '../hub/hub-server.js';

const TOKEN = 'secret-token';

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}
function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => ws.once('message', (d) => resolve(JSON.parse(d.toString()))));
}
function closeCode(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.once('close', (code) => resolve(code)));
}
async function hello(ws: WebSocket, params: Record<string, unknown>) {
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 'hello', method: 'hub.hello', params }));
  return nextMessage(ws);
}

describe('HubServer', () => {
  const servers: HubServer[] = [];
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const s of sockets.splice(0)) {
      try {
        s.terminate();
      } catch {
        /* ignore */
      }
    }
    for (const s of servers.splice(0)) await s.stop();
  });

  async function startHub(toolHandler?: HubServer['toolHandler']) {
    const hub = new HubServer({ port: 0, token: () => TOKEN, toolHandler: toolHandler ?? undefined });
    await hub.start();
    servers.push(hub);
    return hub;
  }

  it('rejects wrong token / wrong first message with 4001 and unknown paths with 4004', async () => {
    const hub = await startHub();
    const bad = await connect(hub.toolsUrl);
    sockets.push(bad);
    const codeP = closeCode(bad);
    const res = await hello(bad, { token: 'nope', client: 'mcp-proxy' });
    expect((res['error'] as { code: number }).code).toBe(RpcErrorCode.Unauthorized);
    expect(await codeP).toBe(4001);

    const notHello = await connect(hub.toolsUrl);
    sockets.push(notHello);
    const code2 = closeCode(notHello);
    notHello.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools.list', params: {} }));
    expect(await code2).toBe(4001);

    const unknown = new WebSocket(`${hub.url}/nowhere`);
    sockets.push(unknown);
    expect(await closeCode(unknown)).toBe(4004);
  });

  it('serves tools.list, tools.call round-trip and hub.ping to authenticated proxies', async () => {
    const calls: unknown[] = [];
    const hub = await startHub(async (p) => {
      calls.push(p);
      return { ok: true, text: `ran ${p.name}` } satisfies ToolResult;
    });
    const ws = await connect(hub.toolsUrl);
    sockets.push(ws);
    const h = await hello(ws, { token: TOKEN, client: 'mcp-proxy', chatId: 'chat_9' });
    expect(h['result']).toMatchObject({ ok: true, hubVersion: '1' });

    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools.list', params: {} }));
    const list = await nextMessage(ws);
    expect(((list['result'] as { tools: unknown[] }).tools).length).toBeGreaterThan(10);

    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools.call', params: { name: 'screen_info', args: { a: 1 } } }));
    const call = await nextMessage(ws);
    expect(call['result']).toEqual({ ok: true, text: 'ran screen_info' });
    expect(calls[0]).toMatchObject({ name: 'screen_info', args: { a: 1 }, chatId: 'chat_9' });

    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'hub.ping', params: {} }));
    expect((await nextMessage(ws))['result']).toMatchObject({ pong: true });

    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'does.not.exist', params: {} }));
    expect(((await nextMessage(ws))['error'] as { code: number }).code).toBe(RpcErrorCode.MethodNotFound);
    expect(hub.toolClientCount).toBe(1);
  });

  it('returns a ToolResult error when the tool handler throws or is missing', async () => {
    const hub = await startHub();
    const ws = await connect(hub.toolsUrl);
    sockets.push(ws);
    await hello(ws, { token: TOKEN, client: 'mcp-proxy' });
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools.call', params: { name: 'x', args: {} } }));
    expect(((await nextMessage(ws))['result'] as ToolResult).ok).toBe(false);
    hub.toolHandler = async () => {
      throw new Error('kaboom');
    };
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools.call', params: { name: 'x', args: {} } }));
    const r = (await nextMessage(ws))['result'] as ToolResult;
    expect(r.ok).toBe(false);
    expect(r.error).toContain('kaboom');
  });

  it('extCall round-trips, times out, reports ext.event, and keeps only the latest extension', async () => {
    const hub = await startHub();
    await expect(hub.extCall('ext.status', {}, 100)).rejects.toThrow(/not connected/i);
    expect(hub.extensionHealth().connected).toBe(false);

    const ext1 = await connect(hub.extensionUrl);
    sockets.push(ext1);
    await hello(ext1, { token: TOKEN, client: 'extension', browser: 'edge', version: '0.1.0' });
    expect(hub.extensionConnected).toBe(true);
    expect(hub.extensionHealth()).toMatchObject({ connected: true, browser: 'edge', version: '0.1.0' });

    ext1.on('message', (d) => {
      const req = JSON.parse(d.toString()) as RpcRequest<string, { tabId?: number }>;
      if (req.method === 'ext.status') ext1.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { browser: 'edge', version: '130', extensionVersion: '0.1.0', windows: 1, tabs: 4 } }));
      if (req.method === 'ext.tabs.close') ext1.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -1, message: 'no such tab' } }));
      // ext.page.wait: never answers → timeout
    });
    const status = await hub.extCall('ext.status', {}, 1000);
    expect(status.tabs).toBe(4);
    expect(hub.extensionHealth().tabs).toBe(4);
    await expect(hub.extCall('ext.tabs.close', { tabId: 1 }, 1000)).rejects.toThrow(/no such tab/);
    await expect(hub.extCall('ext.page.wait', { tabId: 1 }, 80)).rejects.toThrow(/timed out/);

    const evP = new Promise<unknown>((resolve) => hub.once('ext.event', resolve));
    ext1.send(JSON.stringify({ jsonrpc: '2.0', method: 'ext.event', params: { type: 'user.activity', tabId: 1, url: 'https://a.b', title: 'A', kind: 'focus' } }));
    expect(await evP).toMatchObject({ type: 'user.activity', url: 'https://a.b' });

    const ext1Closed = closeCode(ext1);
    const ext2 = await connect(hub.extensionUrl);
    sockets.push(ext2);
    await hello(ext2, { token: TOKEN, client: 'extension', browser: 'chrome' });
    expect(await ext1Closed).toBe(4000);
    expect(hub.extensionHealth().browser).toBe('chrome');

    ext2.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(hub.extensionConnected).toBe(false);
  });

  it('moves to the next port when the requested one is busy', async () => {
    const first = await startHub();
    const second = new HubServer({ port: first.actualPort, token: () => TOKEN, portAttempts: 3 });
    servers.push(second);
    const port = await second.start();
    expect(port).toBeGreaterThan(first.actualPort);
    expect(port - first.actualPort).toBeLessThanOrEqual(3);
  });
});

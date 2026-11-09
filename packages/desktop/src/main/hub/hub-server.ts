/**
 * HubServer — the local WebSocket server owned by the Electron main process.
 *
 * Paths (both on 127.0.0.1:<port>):
 *   HUB_PATH_TOOLS      — @aim/tools-mcp proxies (one per Claude CLI process). Methods: tools.list, tools.call, hub.ping.
 *   HUB_PATH_EXTENSION  — the browser extension (single latest connection wins). Hub → ext requests `ext.*`;
 *                         ext → hub `ext.event` notifications and `hub.ping`.
 *
 * Auth: the first frame from any client must be `hub.hello` {token, client, ...}; a wrong token
 * (or any other first message) closes the socket with code 4001. Clients that stay silent for
 * HELLO_TIMEOUT_MS are closed with 4002.
 */
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  AIM_TOOLS,
  HUB_HOST,
  HUB_PATH_EXTENSION,
  HUB_PATH_TOOLS,
  HUB_VERSION,
  RpcErrorCode,
  isRpcNotification,
  isRpcRequest,
  isRpcResponse,
  nextRpcId,
  rpcFailure,
  rpcRequest,
  rpcSuccess,
  type ExtEvent,
  type ExtMethod,
  type ExtParams,
  type ExtResult,
  type ExtensionHealth,
  type HubHelloParams,
  type HubHelloResult,
  type HubToolsCallParams,
  type RpcId,
  type RpcMessage,
  type RpcRequest,
  type ToolResult,
} from '@aim/shared';

export interface HubLogger {
  debug(...a: unknown[]): void;
  info(...a: unknown[]): void;
  warn(...a: unknown[]): void;
  error(...a: unknown[]): void;
}

export interface HubServerOptions {
  port: number;
  token: () => string;
  host?: string;
  /** How many consecutive ports to try when `port` is busy. */
  portAttempts?: number;
  log?: HubLogger;
  /** Set later via `toolHandler` when the ToolRouter exists. */
  toolHandler?: (params: HubToolsCallParams) => Promise<ToolResult>;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

interface ClientState {
  kind: 'tools' | 'extension';
  authed: boolean;
  hello?: HubHelloParams;
  chatId?: string;
}

const HELLO_TIMEOUT_MS = 5_000;
const noopLog: HubLogger = { debug() {}, info() {}, warn() {}, error() {} };

export class HubServer extends EventEmitter {
  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private ext: WebSocket | null = null;
  private extHello: HubHelloParams | null = null;
  private extLastSeen = 0;
  private extTabs: number | undefined;
  private pending = new Map<RpcId, Pending>();
  private toolClients = new Set<WebSocket>();
  private readonly log: HubLogger;
  actualPort = 0;
  toolHandler: ((params: HubToolsCallParams) => Promise<ToolResult>) | null;

  constructor(private readonly opts: HubServerOptions) {
    super();
    this.log = opts.log ?? noopLog;
    this.toolHandler = opts.toolHandler ?? null;
  }

  get listening(): boolean {
    return !!this.httpServer?.listening;
  }
  get host(): string {
    return this.opts.host ?? HUB_HOST;
  }
  get url(): string {
    return `ws://${this.host}:${this.actualPort}`;
  }
  get toolsUrl(): string {
    return `${this.url}${HUB_PATH_TOOLS}`;
  }
  get extensionUrl(): string {
    return `${this.url}${HUB_PATH_EXTENSION}`;
  }
  get extensionConnected(): boolean {
    return !!this.ext && this.ext.readyState === this.ext.OPEN;
  }
  get toolClientCount(): number {
    return this.toolClients.size;
  }

  extensionHealth(): ExtensionHealth {
    const connected = this.extensionConnected;
    return {
      connected,
      browser: this.extHello?.browser,
      version: this.extHello?.version,
      tabs: connected ? this.extTabs : undefined,
      lastSeen: this.extLastSeen || undefined,
    };
  }

  /** Start listening; tries `portAttempts` consecutive ports. Resolves with the port in use. */
  async start(): Promise<number> {
    const attempts = Math.max(1, this.opts.portAttempts ?? 10);
    let lastErr: Error | null = null;
    for (let i = 0; i < attempts; i++) {
      const port = this.opts.port + i;
      try {
        this.actualPort = await this.listen(port);
        this.log.info(`hub listening on ${this.url} (tools ${HUB_PATH_TOOLS}, extension ${HUB_PATH_EXTENSION})`);
        return port;
      } catch (err) {
        lastErr = err as Error;
        if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') break;
        this.log.warn(`port ${port} busy, trying ${port + 1}`);
      }
    }
    throw lastErr ?? new Error('Hub failed to start');
  }

  private listen(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((_req, res) => {
        res.writeHead(426, { 'content-type': 'text/plain' });
        res.end('A.I.M. hub: WebSocket only.');
      });
      const wss = new WebSocketServer({ server });
      // ws re-emits the http server's errors on the WebSocketServer; without a listener they are thrown.
      wss.on('error', (err) => this.log.warn(`hub ws error: ${err.message}`));
      const onError = (err: Error) => {
        wss.close();
        server.close();
        reject(err);
      };
      server.once('error', onError);
      server.listen(port, this.host, () => {
        server.off('error', onError);
        server.on('error', (err) => this.log.error('hub http error', err));
        this.httpServer = server;
        this.wss = wss;
        wss.on('connection', (ws, req) => this.onConnection(ws, req));
        const addr = server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : port);
      });
    });
  }

  async stop(): Promise<void> {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('Hub stopped'));
    }
    this.pending.clear();
    const wss = this.wss;
    const server = this.httpServer;
    this.wss = null;
    this.httpServer = null;
    this.ext = null;
    if (wss) {
      for (const c of wss.clients) {
        try {
          c.close(1001, 'hub shutting down');
        } catch {
          /* ignore */
        }
      }
      await new Promise<void>((r) => wss.close(() => r()));
    }
    if (server) await new Promise<void>((r) => server.close(() => r()));
    this.toolClients.clear();
  }

  // ───────────────────────────── connections ─────────────────────────────

  private onConnection(ws: WebSocket, req: http.IncomingMessage): void {
    const path = (() => {
      try {
        return new URL(req.url ?? '/', 'http://localhost').pathname;
      } catch {
        return '/';
      }
    })();
    let kind: ClientState['kind'];
    if (path === HUB_PATH_TOOLS) kind = 'tools';
    else if (path === HUB_PATH_EXTENSION) kind = 'extension';
    else {
      this.log.warn(`rejecting connection to unknown path ${path}`);
      ws.close(4004, 'unknown path');
      return;
    }
    const state: ClientState = { kind, authed: false };
    const helloTimer = setTimeout(() => {
      if (!state.authed) {
        this.log.warn(`${kind} client did not send hub.hello in time`);
        ws.close(4002, 'hello timeout');
      }
    }, HELLO_TIMEOUT_MS);

    ws.on('message', (raw) => {
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        this.send(ws, rpcFailure(null, { code: RpcErrorCode.ParseError, message: 'Invalid JSON' }));
        if (!state.authed) ws.close(4001, 'unauthorized');
        return;
      }
      if (!state.authed) {
        clearTimeout(helloTimer);
        this.handleHello(ws, state, msg);
        return;
      }
      this.dispatch(ws, state, msg as RpcMessage);
    });
    ws.on('error', (err) => this.log.warn(`${kind} socket error: ${err.message}`));
    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (state.kind === 'tools') this.toolClients.delete(ws);
      if (state.kind === 'extension' && this.ext === ws) {
        this.ext = null;
        this.log.info('extension disconnected');
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error('A.I.M. browser extension disconnected during the request.'));
          this.pending.delete(id);
        }
        this.emit('extension', { connected: false });
      }
    });
  }

  private handleHello(ws: WebSocket, state: ClientState, msg: unknown): void {
    if (!isRpcRequest(msg) || msg.method !== 'hub.hello') {
      this.send(ws, rpcFailure(isRpcRequest(msg) ? msg.id : null, { code: RpcErrorCode.Unauthorized, message: 'First message must be hub.hello' }));
      ws.close(4001, 'unauthorized');
      return;
    }
    const params = (msg.params ?? {}) as Partial<HubHelloParams>;
    const expected = this.opts.token();
    if (!expected || typeof params.token !== 'string' || !safeEqual(params.token, expected)) {
      this.log.warn(`${state.kind} client presented an invalid token`);
      this.send(ws, rpcFailure(msg.id, { code: RpcErrorCode.Unauthorized, message: 'Invalid token' }));
      ws.close(4001, 'unauthorized');
      return;
    }
    state.authed = true;
    state.hello = params as HubHelloParams;
    state.chatId = params.chatId;
    const result: HubHelloResult = { ok: true, hubVersion: HUB_VERSION, serverTime: Date.now() };
    this.send(ws, rpcSuccess(msg.id, result));

    if (state.kind === 'tools') {
      this.toolClients.add(ws);
      this.log.debug(`mcp proxy connected${params.chatId ? ` (chat ${params.chatId})` : ''}`);
      return;
    }
    // extension: keep the newest connection only
    if (this.ext && this.ext !== ws) {
      this.log.info('replacing previous extension connection');
      const old = this.ext;
      this.ext = null;
      try {
        old.close(4000, 'superseded by a newer extension connection');
      } catch {
        /* ignore */
      }
    }
    this.ext = ws;
    this.extHello = params as HubHelloParams;
    this.extLastSeen = Date.now();
    this.extTabs = undefined;
    this.log.info(`extension connected (${params.browser ?? 'browser'} ${params.version ?? ''})`.trim());
    this.emit('extension', { connected: true, browser: params.browser, version: params.version });
  }

  private dispatch(ws: WebSocket, state: ClientState, msg: RpcMessage): void {
    if (state.kind === 'extension') this.extLastSeen = Date.now();
    if (isRpcResponse(msg)) {
      const p = this.pending.get(msg.id as RpcId);
      if (!p) return;
      this.pending.delete(msg.id as RpcId);
      clearTimeout(p.timer);
      if ('error' in msg) {
        const e = new Error(msg.error?.message || `${p.method} failed`) as Error & { code?: number; data?: unknown };
        e.code = msg.error?.code;
        e.data = msg.error?.data;
        p.reject(e);
      } else p.resolve(msg.result);
      return;
    }
    if (isRpcNotification(msg)) {
      if (state.kind === 'extension' && msg.method === 'ext.event') {
        const ev = msg.params as ExtEvent;
        if (ev && typeof ev === 'object' && typeof ev.type === 'string') {
          if (ev.type === 'tab.updated' || ev.type === 'tab.removed') this.extTabs = undefined; // stale
          this.emit('ext.event', ev);
        }
      }
      return;
    }
    if (isRpcRequest(msg)) {
      void this.handleRequest(ws, state, msg);
    }
  }

  private async handleRequest(ws: WebSocket, state: ClientState, req: RpcRequest): Promise<void> {
    const { id, method } = req;
    try {
      switch (method) {
        case 'hub.hello':
          return this.send(ws, rpcSuccess(id, { ok: true, hubVersion: HUB_VERSION, serverTime: Date.now() } satisfies HubHelloResult));
        case 'hub.ping':
          return this.send(ws, rpcSuccess(id, { pong: true, serverTime: Date.now() }));
        case 'tools.list':
          if (state.kind !== 'tools') break;
          return this.send(ws, rpcSuccess(id, { tools: AIM_TOOLS }));
        case 'tools.call': {
          if (state.kind !== 'tools') break;
          const p = (req.params ?? {}) as Partial<HubToolsCallParams>;
          if (typeof p.name !== 'string') {
            return this.send(ws, rpcFailure(id, { code: RpcErrorCode.InvalidParams, message: 'tools.call requires {name, args}' }));
          }
          const params: HubToolsCallParams = {
            name: p.name,
            args: p.args && typeof p.args === 'object' ? p.args : {},
            chatId: p.chatId ?? state.chatId,
            agentId: p.agentId,
            toolUseId: p.toolUseId,
          };
          if (!this.toolHandler) {
            return this.send(ws, rpcSuccess(id, { ok: false, error: 'A.I.M. tools are not available yet (hub still starting).', errorCode: RpcErrorCode.InternalError } satisfies ToolResult));
          }
          let result: ToolResult;
          try {
            result = await this.toolHandler(params);
          } catch (err) {
            result = { ok: false, error: `Tool ${params.name} crashed: ${(err as Error).message}`, errorCode: RpcErrorCode.ToolFailed };
          }
          return this.send(ws, rpcSuccess(id, result));
        }
        default:
          break;
      }
      this.send(ws, rpcFailure(id, { code: RpcErrorCode.MethodNotFound, message: `Unknown method ${method}` }));
    } catch (err) {
      this.send(ws, rpcFailure(id, { code: RpcErrorCode.InternalError, message: (err as Error).message }));
    }
  }

  private send(ws: WebSocket, msg: unknown): void {
    if (ws.readyState !== ws.OPEN) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch (err) {
      this.log.warn(`send failed: ${(err as Error).message}`);
    }
  }

  // ───────────────────────────── extension RPC ─────────────────────────────

  /** Call a method on the connected extension. Rejects when not connected or on timeout. */
  extCall<M extends ExtMethod>(method: M, params: ExtParams<M>, timeoutMs = 30_000): Promise<ExtResult<M>> {
    const ws = this.ext;
    if (!ws || ws.readyState !== ws.OPEN) {
      const e = new Error('A.I.M. browser extension is not connected.') as Error & { code?: number };
      e.code = RpcErrorCode.NotConnected;
      return Promise.reject(e);
    }
    const id = nextRpcId('h');
    return new Promise<ExtResult<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const e = new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)} s`) as Error & { code?: number };
        e.code = RpcErrorCode.Timeout;
        reject(e);
      }, timeoutMs);
      this.pending.set(id, {
        method,
        timer,
        reject,
        resolve: (v) => {
          if (method === 'ext.status' && v && typeof v === 'object' && typeof (v as { tabs?: unknown }).tabs === 'number') this.extTabs = (v as { tabs: number }).tabs;
          if (method === 'ext.tabs.list' && v && typeof v === 'object' && Array.isArray((v as { tabs?: unknown }).tabs)) this.extTabs = (v as { tabs: unknown[] }).tabs.length;
          resolve(v as ExtResult<M>);
        },
      });
      this.send(ws, rpcRequest(method, params, id));
    });
  }

  /** Broadcast a notification to every connected MCP proxy (e.g. tools.cancel). */
  notifyTools(method: string, params: unknown): void {
    for (const ws of this.toolClients) this.send(ws, { jsonrpc: '2.0', method, params });
  }
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

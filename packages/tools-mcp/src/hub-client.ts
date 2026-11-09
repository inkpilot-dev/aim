/**
 * WebSocket client used by the MCP proxy to talk to the A.I.M. Hub (Electron main process).
 * - JSON-RPC envelopes from @aim/shared rpc.ts, one object per text frame.
 * - First frame is `hub.hello` carrying the pairing token; the hub closes with 4001 otherwise.
 * - Auto-reconnects with exponential backoff; pending requests are rejected on disconnect.
 */
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import {
  HUB_VERSION,
  RpcError,
  RpcErrorCode,
  isRpcNotification,
  isRpcRequest,
  isRpcResponse,
  nextRpcId,
  rpcRequest,
  type HubHelloParams,
  type HubHelloResult,
  type RpcId,
} from '@aim/shared';

export interface HubClientOptions {
  url: string;
  token: string;
  chatId?: string;
  version?: string;
  /** Initial reconnect delay (ms). */
  minBackoffMs?: number;
  /** Max reconnect delay (ms). */
  maxBackoffMs?: number;
  /** How long `hub.hello` may take before the socket is recycled (ms). */
  helloTimeoutMs?: number;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout | undefined;
  method: string;
}

/** Events: 'ready' (hello acked), 'close' (socket lost), 'notification' ({method, params}). */
export class HubClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private pending = new Map<RpcId, Pending>();
  private closed = false;
  private helloAcked = false;
  private backoffMs: number;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private helloTimer: NodeJS.Timeout | null = null;
  private readyWaiters: { resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }[] = [];
  readonly opts: Required<Pick<HubClientOptions, 'minBackoffMs' | 'maxBackoffMs' | 'helloTimeoutMs'>> & HubClientOptions;

  constructor(opts: HubClientOptions) {
    super();
    this.opts = { minBackoffMs: 500, maxBackoffMs: 15_000, helloTimeoutMs: 5_000, ...opts };
    this.backoffMs = this.opts.minBackoffMs;
  }

  get connected(): boolean {
    return this.helloAcked && !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    this.opts.log?.(level, message);
  }

  /** Start connecting (idempotent). */
  connect(): void {
    if (this.closed || this.ws) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.url);
    } catch (err) {
      this.log('warn', `hub connect failed: ${(err as Error).message}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.helloAcked = false;

    ws.on('open', () => {
      this.log('debug', `connected to ${this.opts.url}; sending hub.hello`);
      const params: HubHelloParams = { token: this.opts.token, client: 'mcp-proxy', chatId: this.opts.chatId, version: this.opts.version ?? HUB_VERSION };
      this.send(rpcRequest('hub.hello', params, 'hello'));
      this.helloTimer = setTimeout(() => {
        this.log('warn', 'hub.hello timed out; recycling socket');
        ws.terminate();
      }, this.opts.helloTimeoutMs);
    });
    ws.on('message', (data) => this.onMessage(ws, data.toString()));
    ws.on('error', (err) => this.log('warn', `hub socket error: ${err.message}`));
    ws.on('close', (code, reason) => {
      if (this.ws !== ws) return;
      this.log('info', `hub socket closed (${code}${reason?.length ? ` ${reason.toString()}` : ''})`);
      this.ws = null;
      this.helloAcked = false;
      if (this.helloTimer) clearTimeout(this.helloTimer);
      this.helloTimer = null;
      this.rejectAll(new RpcError(RpcErrorCode.NotConnected, 'Connection to the A.I.M. hub was lost.'));
      this.emit('close', code);
      if (code === 4001) {
        // Unauthorized — reconnecting with the same token will not help, but keep trying slowly in case the hub restarted.
        this.backoffMs = this.opts.maxBackoffMs;
      }
      this.scheduleReconnect();
    });
  }

  private onMessage(ws: WebSocket, raw: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.log('warn', 'hub sent a non-JSON frame');
      return;
    }
    if (isRpcResponse(msg)) {
      if (msg.id === 'hello') {
        if ('error' in msg) {
          this.log('error', `hub rejected hello: ${msg.error.message}`);
          ws.close(4001, 'hello rejected');
          return;
        }
        const r = msg.result as HubHelloResult;
        this.helloAcked = true;
        this.backoffMs = this.opts.minBackoffMs;
        if (this.helloTimer) clearTimeout(this.helloTimer);
        this.helloTimer = null;
        this.log('info', `hub hello acknowledged (hub v${r?.hubVersion ?? '?'})`);
        for (const w of this.readyWaiters.splice(0)) {
          clearTimeout(w.timer);
          w.resolve();
        }
        this.emit('ready');
        return;
      }
      const p = this.pending.get(msg.id as RpcId);
      if (!p) return;
      this.pending.delete(msg.id as RpcId);
      if (p.timer) clearTimeout(p.timer);
      if ('error' in msg) p.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data));
      else p.resolve(msg.result);
      return;
    }
    if (isRpcNotification(msg)) {
      this.emit('notification', { method: msg.method, params: msg.params });
      return;
    }
    if (isRpcRequest(msg)) {
      // Hub → proxy requests are not part of the protocol yet; answer politely.
      if (msg.method === 'hub.ping') this.send({ jsonrpc: '2.0', id: msg.id, result: { pong: true } });
      else this.send({ jsonrpc: '2.0', id: msg.id, error: { code: RpcErrorCode.MethodNotFound, message: `Unknown method ${msg.method}` } });
    }
  }

  private send(obj: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(obj));
    } catch (err) {
      this.log('warn', `send failed: ${(err as Error).message}`);
    }
  }

  private rejectAll(err: Error): void {
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.opts.maxBackoffMs, Math.round(this.backoffMs * 1.8));
    this.log('debug', `reconnecting in ${delay} ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  /** Resolve once hello is acknowledged; reject after `timeoutMs`. */
  ready(timeoutMs = 3_000): Promise<void> {
    if (this.connected) return Promise.resolve();
    if (this.closed) return Promise.reject(new RpcError(RpcErrorCode.NotConnected, 'Hub client is closed.'));
    this.connect();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter((w) => w.timer !== timer);
        reject(new RpcError(RpcErrorCode.NotConnected, `A.I.M. hub not reachable at ${this.opts.url}`));
      }, timeoutMs);
      this.readyWaiters.push({ resolve, reject, timer });
    });
  }

  /** Send a JSON-RPC request and await its result. */
  async request<R = unknown>(method: string, params: unknown, timeoutMs = 30_000): Promise<R> {
    if (!this.connected) {
      await this.ready(Math.min(timeoutMs, 5_000));
    }
    const id = nextRpcId('p');
    return new Promise<R>((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new RpcError(RpcErrorCode.Timeout, `${method} timed out after ${Math.round(timeoutMs / 1000)} s`));
          }, timeoutMs)
        : undefined;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, method });
      this.send(rpcRequest(method, params, id));
    });
  }

  /** Stop reconnecting and close the socket. */
  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.helloTimer = null;
    for (const w of this.readyWaiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(new RpcError(RpcErrorCode.NotConnected, 'Hub client closed.'));
    }
    this.rejectAll(new RpcError(RpcErrorCode.NotConnected, 'Hub client closed.'));
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close(1000, 'bye');
    } catch {
      /* ignore */
    }
  }
}

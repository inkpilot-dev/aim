/** Minimal JSON-RPC 2.0 style envelope used on every A.I.M. WebSocket link. */

export type RpcId = string | number;

export interface RpcRequest<M extends string = string, P = unknown> {
  jsonrpc: '2.0';
  id: RpcId;
  method: M;
  params: P;
}

export interface RpcNotification<M extends string = string, P = unknown> {
  jsonrpc: '2.0';
  method: M;
  params: P;
}

export interface RpcSuccess<R = unknown> {
  jsonrpc: '2.0';
  id: RpcId;
  result: R;
}

export interface RpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface RpcFailure {
  jsonrpc: '2.0';
  id: RpcId | null;
  error: RpcErrorObject;
}

export type RpcResponse<R = unknown> = RpcSuccess<R> | RpcFailure;
export type RpcMessage = RpcRequest | RpcNotification | RpcResponse;

export const RpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  // A.I.M. specific
  Unauthorized: -32001,
  NotConnected: -32002, // e.g. extension not connected
  Timeout: -32003,
  PolicyBlocked: -32010, // payment guard
  ToolFailed: -32020,
} as const;

export class RpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = 'RpcError';
  }
  toObject(): RpcErrorObject {
    return { code: this.code, message: this.message, data: this.data };
  }
}

export function isRpcRequest(m: unknown): m is RpcRequest {
  return !!m && typeof m === 'object' && 'method' in m && 'id' in m && (m as RpcRequest).jsonrpc === '2.0';
}
export function isRpcNotification(m: unknown): m is RpcNotification {
  return !!m && typeof m === 'object' && 'method' in m && !('id' in m) && (m as RpcNotification).jsonrpc === '2.0';
}
export function isRpcResponse(m: unknown): m is RpcResponse {
  return !!m && typeof m === 'object' && 'id' in m && !('method' in m) && (m as RpcResponse).jsonrpc === '2.0';
}

let counter = 0;
export function nextRpcId(prefix = 'r'): string {
  counter = (counter + 1) % Number.MAX_SAFE_INTEGER;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}`;
}

export function rpcRequest<M extends string, P>(method: M, params: P, id: RpcId = nextRpcId()): RpcRequest<M, P> {
  return { jsonrpc: '2.0', id, method, params };
}
export function rpcNotification<M extends string, P>(method: M, params: P): RpcNotification<M, P> {
  return { jsonrpc: '2.0', method, params };
}
export function rpcSuccess<R>(id: RpcId, result: R): RpcSuccess<R> {
  return { jsonrpc: '2.0', id, result };
}
export function rpcFailure(id: RpcId | null, error: RpcErrorObject): RpcFailure {
  return { jsonrpc: '2.0', id, error };
}

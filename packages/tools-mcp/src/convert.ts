/**
 * Pure helpers: convert A.I.M. ToolResult payloads into MCP tool-call content.
 * Kept free of I/O so they can be unit-tested without a hub.
 */
import { PAYMENT_BLOCK_MESSAGE, RpcErrorCode, type ToolResult } from '@aim/shared';

export type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface McpCallResult {
  content: McpContent[];
  isError?: boolean;
  [k: string]: unknown;
}

function stringifyData(data: unknown): string {
  if (typeof data === 'string') return data;
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

/** Convert a ToolResult into the MCP CallToolResult shape. Never throws. */
export function toolResultToMcp(result: ToolResult | null | undefined): McpCallResult {
  if (!result || typeof result !== 'object') {
    return { content: [{ type: 'text', text: 'Tool returned no result.' }], isError: true };
  }
  const content: McpContent[] = [];
  if (!result.ok) {
    let text = result.error ?? 'Tool failed.';
    if (result.errorCode === RpcErrorCode.PolicyBlocked && !text.includes(PAYMENT_BLOCK_MESSAGE)) {
      text = `${PAYMENT_BLOCK_MESSAGE} ${text}`.trim();
    }
    if (typeof result.errorCode === 'number') text = `${text} (code ${result.errorCode})`;
    content.push({ type: 'text', text });
    if (result.text) content.push({ type: 'text', text: result.text });
    if (result.data !== undefined) content.push({ type: 'text', text: stringifyData(result.data) });
    return { content, isError: true };
  }
  if (result.text) content.push({ type: 'text', text: result.text });
  if (result.data !== undefined) content.push({ type: 'text', text: stringifyData(result.data) });
  for (const img of result.images ?? []) {
    if (img && typeof img.dataBase64 === 'string') {
      content.push({ type: 'image', data: img.dataBase64, mimeType: img.mediaType || 'image/png' });
    }
  }
  if (content.length === 0) content.push({ type: 'text', text: 'OK' });
  return { content };
}

/** Build an MCP error result from an arbitrary thrown value. */
export function errorToMcp(err: unknown, prefix = 'Tool call failed'): McpCallResult {
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: `${prefix}: ${msg}` }], isError: true };
}

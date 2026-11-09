/**
 * Types for the Claude Code CLI run in headless mode:
 *   claude -p --output-format stream-json --input-format stream-json --verbose --include-partial-messages ...
 * One JSON object per line on stdout. These mirror the SDK message shapes closely enough for A.I.M.
 */

export interface CliSystemInit {
  type: 'system';
  subtype: 'init';
  session_id: string;
  cwd?: string;
  tools?: string[];
  mcp_servers?: { name: string; status: string }[];
  model?: string;
  permissionMode?: string;
  apiKeySource?: string;
  [k: string]: unknown;
}

export interface CliSystemOther {
  type: 'system';
  subtype: string;
  session_id?: string;
  [k: string]: unknown;
}

export interface ApiTextBlock { type: 'text'; text: string }
export interface ApiThinkingBlock { type: 'thinking'; thinking: string; signature?: string }
export interface ApiToolUseBlock { type: 'tool_use'; id: string; name: string; input: unknown }
export interface ApiToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content?: string | Array<{ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }>;
  is_error?: boolean;
}
export interface ApiImageBlock { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
export type ApiContentBlock = ApiTextBlock | ApiThinkingBlock | ApiToolUseBlock | ApiToolResultBlock | ApiImageBlock;

export interface CliAssistantMessage {
  type: 'assistant';
  session_id: string;
  /** Set when emitted by a subagent (Agent tool). */
  parent_tool_use_id?: string | null;
  message: {
    id?: string;
    role: 'assistant';
    model?: string;
    content: ApiContentBlock[];
    stop_reason?: string | null;
    usage?: { input_tokens?: number; output_tokens?: number; [k: string]: unknown };
  };
  uuid?: string;
}

export interface CliUserMessage {
  type: 'user';
  session_id: string;
  parent_tool_use_id?: string | null;
  message: { role: 'user'; content: ApiContentBlock[] | string };
  uuid?: string;
  /** Present on synthetic tool-result user messages in newer CLIs. */
  tool_use_result?: unknown;
}

export interface CliResultMessage {
  type: 'result';
  subtype: 'success' | 'error_max_turns' | 'error_during_execution' | string;
  session_id: string;
  is_error: boolean;
  result?: string;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number; [k: string]: unknown };
  errors?: unknown[];
  /** Structured output when --json-schema was used. */
  structured_output?: unknown;
  [k: string]: unknown;
}

/** Partial streaming (with --include-partial-messages). Wraps raw Anthropic stream events. */
export interface CliStreamEvent {
  type: 'stream_event';
  session_id: string;
  parent_tool_use_id?: string | null;
  event:
    | { type: 'message_start'; message: unknown }
    | { type: 'content_block_start'; index: number; content_block: ApiContentBlock }
    | { type: 'content_block_delta'; index: number; delta: { type: 'text_delta'; text: string } | { type: 'thinking_delta'; thinking: string } | { type: 'input_json_delta'; partial_json: string } | { type: string; [k: string]: unknown } }
    | { type: 'content_block_stop'; index: number }
    | { type: 'message_delta'; delta: unknown; usage?: unknown }
    | { type: 'message_stop' }
    | { type: string; [k: string]: unknown };
}

export interface CliToolProgress {
  type: 'tool_progress';
  session_id?: string;
  tool_use_id?: string;
  [k: string]: unknown;
}

export type CliEvent =
  | CliSystemInit
  | CliSystemOther
  | CliAssistantMessage
  | CliUserMessage
  | CliResultMessage
  | CliStreamEvent
  | CliToolProgress
  | { type: string; [k: string]: unknown };

/** What A.I.M. writes to the CLI's stdin with --input-format stream-json. */
export interface CliUserInput {
  type: 'user';
  message: { role: 'user'; content: string | ApiContentBlock[] };
  /** Optional, lets the CLI tie the message to a session. */
  session_id?: string;
  parent_tool_use_id?: null;
}

export function isCliInit(e: CliEvent): e is CliSystemInit {
  return e.type === 'system' && (e as CliSystemInit).subtype === 'init';
}
export function isCliAssistant(e: CliEvent): e is CliAssistantMessage {
  return e.type === 'assistant';
}
export function isCliUser(e: CliEvent): e is CliUserMessage {
  return e.type === 'user';
}
export function isCliResult(e: CliEvent): e is CliResultMessage {
  return e.type === 'result';
}
export function isCliStream(e: CliEvent): e is CliStreamEvent {
  return e.type === 'stream_event';
}

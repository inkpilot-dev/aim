/**
 * One-line, human-readable summaries of tool calls and results for the chat UI.
 * The UI never shows raw payloads; these strings are what appears next to a tool chip.
 */
import type { ApiToolResultBlock, ToolResult, ToolResultSummary } from '@aim/shared';
import { MCP_TOOL_PREFIX } from '@aim/shared';

const MAX = 90;
/** Images above this size are not forwarded to the UI as thumbnails (base64 length). */
const MAX_THUMB_BASE64 = 600_000;

export function shortToolName(name: string): string {
  return name.startsWith(MCP_TOOL_PREFIX) ? name.slice(MCP_TOOL_PREFIX.length) : name;
}

function clip(s: string, max = MAX): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** e.g. `browser_click e12`, `Bash: npm test`, `screen_capture`. */
export function summarizeToolUse(name: string, input: unknown): string {
  const short = shortToolName(name);
  const i = asRecord(input);
  const target = str(i.ref) ?? str(i.selector);
  switch (short) {
    case 'screen_capture': {
      const r = asRecord(i.region);
      return num(r.width) ? `screen_capture ${r.width}×${r.height} region` : 'screen_capture';
    }
    case 'screen_find_text':
      return clip(`screen_find_text "${str(i.query) ?? '*'}"`);
    case 'mouse_move':
    case 'mouse_click':
      return `${short} ${num(i.x) ?? '·'},${num(i.y) ?? '·'}${num(i.clicks) === 2 ? ' ×2' : ''}`;
    case 'mouse_drag':
      return `mouse_drag ${i.fromX},${i.fromY} → ${i.toX},${i.toY}`;
    case 'mouse_scroll':
      return `mouse_scroll ${num(i.deltaY) ?? 300}`;
    case 'keyboard_type':
      return clip(`keyboard_type "${str(i.text) ?? ''}"`);
    case 'keyboard_press':
      return `keyboard_press ${str(i.combo) ?? ''}`;
    case 'clipboard':
      return `clipboard ${str(i.action) ?? ''}`;
    case 'window_focus':
      return clip(`window_focus ${str(i.titleContains) ?? str(i.appContains) ?? i.id ?? ''}`);
    case 'app_launch':
      return clip(`app_launch ${str(i.target) ?? ''}`);
    case 'browser_open_tab':
      return clip(`browser_open_tab ${hostOf(str(i.url) ?? '')}`);
    case 'browser_navigate':
      return clip(`browser_navigate ${hostOf(str(i.url) ?? '')}`);
    case 'browser_click':
      return clip(`browser_click ${target ?? ''}`);
    case 'browser_type':
      return clip(`browser_type ${target ?? ''} "${str(i.text) ?? ''}"`);
    case 'browser_select':
      return clip(`browser_select ${target ?? ''} "${str(i.value) ?? ''}"`);
    case 'browser_press_key':
      return `browser_press_key ${str(i.key) ?? ''}`;
    case 'browser_snapshot':
      return `browser_snapshot tab ${num(i.tabId) ?? ''}${str(i.filter) ? ` "${i.filter}"` : ''}`;
    case 'browser_read':
    case 'browser_screenshot':
    case 'browser_close_tab':
    case 'browser_activate_tab':
    case 'browser_scroll':
    case 'browser_wait':
      return `${short} tab ${num(i.tabId) ?? ''}`;
    case 'browser_evaluate':
      return clip(`browser_evaluate ${str(i.code) ?? ''}`);
    case 'ask_user':
      return clip(`ask_user "${str(i.question) ?? ''}"`);
    case 'notify_user':
      return clip(`notify_user "${str(i.title) ?? ''}"`);
    case 'tasks_set': {
      const tasks = Array.isArray(i.tasks) ? i.tasks.length : 0;
      return `tasks_set ${tasks} task${tasks === 1 ? '' : 's'}`;
    }
    case 'tasks_update':
      return clip(`tasks_update ${i.index ?? str(i.title) ?? ''} → ${str(i.state) ?? ''}`);
    case 'memory_remember':
      return clip(`memory_remember ${str(i.key) ?? ''}`);
    case 'memory_recall':
      return clip(`memory_recall "${str(i.query) ?? ''}"`);
    case 'memory_forget':
      return clip(`memory_forget ${str(i.key) ?? ''}`);
    case 'goals_update':
      return clip(`goals_update ${str(i.goalId) ?? ''} → ${str(i.status) ?? ''}`);
    // Claude Code built-ins
    case 'Bash':
      return clip(`Bash: ${str(i.command) ?? ''}`);
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return clip(`${short} ${str(i.file_path) ?? str(i.notebook_path) ?? ''}`);
    case 'Glob':
    case 'Grep':
      return clip(`${short} ${str(i.pattern) ?? ''}`);
    case 'WebFetch':
      return clip(`WebFetch ${hostOf(str(i.url) ?? '')}`);
    case 'WebSearch':
      return clip(`WebSearch "${str(i.query) ?? ''}"`);
    case 'Agent':
    case 'Task':
      return clip(`${short} ${str(i.subagent_type) ?? ''}: ${str(i.description) ?? ''}`);
    case 'TodoWrite':
      return 'TodoWrite';
    default: {
      const first = Object.entries(i).find(([, v]) => typeof v === 'string' || typeof v === 'number');
      return first ? clip(`${short} ${first[1]}`) : short;
    }
  }
}

/** Raw text + images of a tool_result block, in whichever shape the CLI used. */
export function flattenToolResult(block: Pick<ApiToolResultBlock, 'content' | 'is_error'>): {
  text: string;
  images: { mediaType: string; dataBase64: string }[];
  isError: boolean;
} {
  const images: { mediaType: string; dataBase64: string }[] = [];
  let text = '';
  if (typeof block.content === 'string') text = block.content;
  else if (Array.isArray(block.content)) {
    const parts: string[] = [];
    for (const c of block.content) {
      if (c.type === 'text') parts.push(c.text);
      else if (c.type === 'image' && c.source?.data) images.push({ mediaType: c.source.media_type, dataBase64: c.source.data });
    }
    text = parts.join('\n');
  }
  return { text, images, isError: !!block.is_error };
}

/** Tries to interpret the MCP text payload as the ToolResult JSON the Hub returns. */
function parseToolResultJson(text: string): (ToolResult & { data?: unknown }) | undefined {
  const t = text.trim();
  if (!t.startsWith('{')) return undefined;
  try {
    const v = JSON.parse(t) as unknown;
    if (v && typeof v === 'object' && 'ok' in v) return v as ToolResult;
  } catch {
    /* not JSON */
  }
  return undefined;
}

/**
 * Summarises a tool result for the UI. Image results (screenshots) carry a thumbnail when reasonably small.
 * Accepts either the raw CLI tool_result block or a ToolResult from the Hub.
 */
export function summarizeToolResult(name: string, result: Pick<ApiToolResultBlock, 'content' | 'is_error'> | ToolResult): ToolResultSummary {
  const short = shortToolName(name);
  let text: string;
  let images: { mediaType: string; dataBase64: string }[];
  let isError: boolean;
  let parsed: ToolResult | undefined;

  if ('ok' in result) {
    parsed = result;
    text = result.text ?? (result.data !== undefined ? JSON.stringify(result.data) : '');
    images = result.images ?? [];
    isError = !result.ok;
  } else {
    const flat = flattenToolResult(result);
    text = flat.text;
    images = flat.images;
    isError = flat.isError;
    parsed = parseToolResultJson(text);
    if (parsed) {
      isError = isError || parsed.ok === false;
      if (parsed.text) text = parsed.text;
      else if (parsed.data !== undefined) text = JSON.stringify(parsed.data);
      if (parsed.images?.length) images = parsed.images;
    }
  }

  const data = asRecord(parsed?.data);
  const out: ToolResultSummary = { ok: !isError, summary: '' };
  if (isError) {
    out.error = clip(parsed?.error ?? text ?? 'error', 200);
    out.summary = clip(`${short} failed: ${parsed?.error ?? text ?? 'error'}`);
    return out;
  }

  const thumb = images[0];
  if (thumb && thumb.dataBase64.length <= MAX_THUMB_BASE64) out.imageBase64 = thumb.dataBase64;

  switch (short) {
    case 'screen_capture': {
      const w = num(data.width) ?? num(asRecord(data.screen).width);
      const h = num(data.height) ?? num(asRecord(data.screen).height);
      out.summary = w && h ? `screen_capture → ${w}×${h}` : 'screen_capture → image';
      break;
    }
    case 'browser_screenshot':
      out.summary = 'browser_screenshot → image';
      break;
    case 'browser_open_tab':
      out.summary = `tab ${num(data.tabId) ?? ''} opened`.trim();
      break;
    case 'browser_snapshot': {
      const els = Array.isArray(data.elements) ? data.elements.length : undefined;
      out.summary = els !== undefined ? `${els} elements` : clip(text || 'snapshot');
      break;
    }
    case 'browser_tabs': {
      const tabs = Array.isArray(data.tabs) ? data.tabs.length : Array.isArray(parsed?.data) ? (parsed?.data as unknown[]).length : undefined;
      out.summary = tabs !== undefined ? `${tabs} tabs` : clip(text || 'ok');
      break;
    }
    case 'browser_read':
      out.summary = `${text.length.toLocaleString()} chars read`;
      break;
    case 'screen_find_text': {
      const m = Array.isArray(data.matches) ? data.matches.length : undefined;
      out.summary = m !== undefined ? `${m} match${m === 1 ? '' : 'es'}` : clip(text || 'ok');
      break;
    }
    case 'tasks_set':
    case 'tasks_update': {
      const label = str(data.label) ?? str(asRecord(data.progress).label);
      out.summary = label ? clip(label) : 'tasks updated';
      break;
    }
    case 'ask_user':
      out.summary = clip(`answer: ${text}`);
      break;
    default:
      out.summary = text ? clip(text) : 'ok';
  }
  return out;
}

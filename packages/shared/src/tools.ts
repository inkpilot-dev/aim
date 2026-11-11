/**
 * The A.I.M. tool catalogue exposed to Claude through the `aim` MCP server.
 * Single source of truth: the MCP proxy advertises exactly these; the Hub implements exactly these.
 * Tool names must be snake_case; Claude sees them as `mcp__aim__<name>`.
 */

export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  description?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  additionalProperties?: boolean | JsonSchema;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** Category used by the UI and the policy layer. */
  category: 'screen' | 'input' | 'window' | 'browser' | 'system' | 'memory' | 'tasks' | 'agents' | 'user';
  /** Tools that physically move the user's real cursor / type on the real keyboard. */
  takesOverDesktop?: boolean;
}

/** Result shape returned by every AIM tool (converted to MCP content by the proxy). */
export interface ToolResult {
  ok: boolean;
  /** Text payload for the model. */
  text?: string;
  /** JSON payload for the model (serialised as text). */
  data?: unknown;
  /** Images for the model (screenshots). */
  images?: { mediaType: string; dataBase64: string }[];
  error?: string;
  /** Code from RpcErrorCode when applicable (PolicyBlocked etc.). */
  errorCode?: number;
}

const str = (description: string, extra: Partial<JsonSchema> = {}): JsonSchema => ({ type: 'string', description, ...extra });
const num = (description: string, extra: Partial<JsonSchema> = {}): JsonSchema => ({ type: 'number', description, ...extra });
const int = (description: string, extra: Partial<JsonSchema> = {}): JsonSchema => ({ type: 'integer', description, ...extra });
const bool = (description: string, extra: Partial<JsonSchema> = {}): JsonSchema => ({ type: 'boolean', description, ...extra });
const obj = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({ type: 'object', properties, required, additionalProperties: false });

export const AIM_TOOLS: ToolDefinition[] = [
  // ───────────── screen ─────────────
  {
    name: 'screen_capture',
    category: 'screen',
    description:
      'Take a screenshot of the user\'s screen (or one display / a region) and return it as an image plus the screen size. Use this to SEE the screen before and after acting. Returns coordinates in screen pixels, which are what mouse tools accept.',
    inputSchema: obj({
      display: int('Display index (0 = primary). Omit for the primary display.'),
      region: obj({ x: int('left'), y: int('top'), width: int('width'), height: int('height') }, ['x', 'y', 'width', 'height']),
      scale: num('Downscale factor 0.25..1 to reduce image size (default 0.5 for full screens, 1 for regions).', { minimum: 0.1, maximum: 1 }),
    }),
  },
  {
    name: 'screen_info',
    category: 'screen',
    description: 'List displays with their bounds, scale factor and which is primary. Also returns the current mouse position and the active window.',
    inputSchema: obj({}),
  },
  {
    name: 'screen_find_text',
    category: 'screen',
    description: 'OCR the screen (or region) and return text fragments with their bounding boxes. Useful to find a button or label to click. Returns {matches:[{text,x,y,width,height,confidence}]}.',
    inputSchema: obj({
      query: str('Text to look for (case-insensitive substring). Omit to return all text found.'),
      region: obj({ x: int('left'), y: int('top'), width: int('width'), height: int('height') }, ['x', 'y', 'width', 'height']),
    }),
  },
  // ───────────── input (desktop) ─────────────
  {
    name: 'mouse_move',
    category: 'input',
    takesOverDesktop: true,
    description: 'Move AIM\'s cursor (shown in teal) to screen coordinates. On the desktop this moves the real pointer, so prefer browser_* tools when the task is inside the browser and the user is doing something else.',
    inputSchema: obj({ x: int('screen x'), y: int('screen y'), smooth: bool('animate the move (default true)') }, ['x', 'y']),
  },
  {
    name: 'mouse_click',
    category: 'input',
    takesOverDesktop: true,
    description: 'Click at screen coordinates (or the current position if omitted).',
    inputSchema: obj({
      x: int('screen x'),
      y: int('screen y'),
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'default left' },
      clicks: int('1 = single, 2 = double (default 1)'),
      modifiers: { type: 'array', items: { type: 'string', enum: ['ctrl', 'alt', 'shift', 'meta'] }, description: 'held modifier keys' },
    }),
  },
  {
    name: 'mouse_drag',
    category: 'input',
    takesOverDesktop: true,
    description: 'Press at (fromX,fromY), drag to (toX,toY), release.',
    inputSchema: obj({ fromX: int(''), fromY: int(''), toX: int(''), toY: int(''), durationMs: int('default 400') }, ['fromX', 'fromY', 'toX', 'toY']),
  },
  {
    name: 'mouse_scroll',
    category: 'input',
    takesOverDesktop: true,
    description: 'Scroll the mouse wheel at the current (or given) position. Positive deltaY scrolls down.',
    inputSchema: obj({ x: int(''), y: int(''), deltaX: int('default 0'), deltaY: int('default 300') }),
  },
  {
    name: 'keyboard_type',
    category: 'input',
    takesOverDesktop: true,
    description: 'Type text into the focused desktop control (uses the clipboard for long/unicode text so it is fast and exact).',
    inputSchema: obj({ text: str('text to type'), perCharDelayMs: int('default 0') }, ['text']),
  },
  {
    name: 'keyboard_press',
    category: 'input',
    takesOverDesktop: true,
    description: 'Press a key or key combination, e.g. "enter", "ctrl+l", "alt+tab", "win", "ctrl+shift+t".',
    inputSchema: obj({ combo: str('key combination joined by "+"'), repeat: int('default 1') }, ['combo']),
  },
  {
    name: 'clipboard',
    category: 'system',
    description: 'Read or write the system clipboard.',
    inputSchema: obj({ action: { type: 'string', enum: ['read', 'write'] }, text: str('text to write (for write)') }, ['action']),
  },
  // ───────────── windows / apps ─────────────
  {
    name: 'window_list',
    category: 'window',
    description: 'List open top-level windows: id, title, app/process name, bounds, and which is focused.',
    inputSchema: obj({}),
  },
  {
    name: 'window_focus',
    category: 'window',
    description: 'Bring a window to the foreground by id or by a title/app substring. NOTE: this steals focus from the user; avoid while they are actively using another app unless they asked.',
    inputSchema: obj({ id: int('window id from window_list'), titleContains: str('substring match on title'), appContains: str('substring match on app name') }),
  },
  {
    name: 'app_launch',
    category: 'window',
    description: 'Launch an application or open a file/URL with the default handler. Accepts an app name ("notepad", "msedge", "code"), an executable path, or a URL/file path.',
    inputSchema: obj({ target: str('app name, exe path, file path or URL'), args: { type: 'array', items: { type: 'string' }, description: 'extra arguments' } }, ['target']),
  },
  // ───────────── browser (via the A.I.M. extension; works in background tabs, never steals the user\'s cursor) ─────────────
  {
    name: 'browser_status',
    category: 'browser',
    description: 'Check whether the A.I.M. browser extension is connected (Edge/Chrome), and which browser/version. Always call before other browser_* tools if unsure.',
    inputSchema: obj({}),
  },
  {
    name: 'browser_tabs',
    category: 'browser',
    description: 'List open tabs: tabId, windowId, title, url, active, audible. The tab marked active is the one the user is on — work there by default. Never open a new browser window.',
    inputSchema: obj({}),
  },
  {
    name: 'browser_open_tab',
    category: 'browser',
    description: 'Open a URL in a NEW TAB of the existing browser window (background by default). Use only for research that must not disturb the page the user is on, or when the task truly needs a separate page; otherwise work in the user\'s current tab (browser_tabs → active). The tab is placed in the browser\'s "A.I.M." tab group; reuse a tab already in that group instead of opening another. Returns the tabId.',
    inputSchema: obj({ url: str('http(s) URL'), active: bool('focus the tab (default false — stay out of the user\'s way)'), windowId: int('target window; default = last focused') }, ['url']),
  },
  {
    name: 'browser_navigate',
    category: 'browser',
    description: 'Navigate an existing tab to a URL (or back/forward/reload) and wait for load.',
    inputSchema: obj({ tabId: int(''), url: str('URL, or "back" | "forward" | "reload"') }, ['tabId', 'url']),
  },
  {
    name: 'browser_close_tab',
    category: 'browser',
    description: 'Close a tab AIM opened. Never close a tab the user opened unless they asked.',
    inputSchema: obj({ tabId: int('') }, ['tabId']),
  },
  {
    name: 'browser_activate_tab',
    category: 'browser',
    description: 'Make a tab the active (visible) tab. Only do this when the user asked to see it or is not using the browser.',
    inputSchema: obj({ tabId: int('') }, ['tabId']),
  },
  {
    name: 'browser_snapshot',
    category: 'browser',
    description:
      'Get a compact accessibility-style snapshot of the page in a tab: interactive elements (links, buttons, inputs, selects, textareas, role=button…) and headings, each with a stable ref like "e12", its role, name/label, value, and visibility. Works in BACKGROUND tabs. Use refs with browser_click / browser_type / browser_select.',
    inputSchema: obj({
      tabId: int(''),
      maxElements: int('default 400'),
      includeText: bool('include visible text content blocks (default true)'),
      filter: str('only elements whose text/name contains this (case-insensitive)'),
    }, ['tabId']),
  },
  {
    name: 'browser_click',
    category: 'browser',
    description: 'Click an element by ref (from browser_snapshot) or CSS selector. Moves the teal AIM cursor to it first (visible only if the user is viewing that tab).',
    inputSchema: obj({ tabId: int(''), ref: str('element ref, e.g. e12'), selector: str('CSS selector alternative'), button: { type: 'string', enum: ['left', 'right', 'middle'] }, double: bool('') }, ['tabId']),
  },
  {
    name: 'browser_type',
    category: 'browser',
    description: 'Type text into an input/textarea/contenteditable by ref or selector. Clears existing value first unless append=true. Optionally presses Enter.',
    inputSchema: obj({ tabId: int(''), ref: str(''), selector: str(''), text: str(''), append: bool(''), pressEnter: bool('') }, ['tabId', 'text']),
  },
  {
    name: 'browser_select',
    category: 'browser',

    description: 'Choose an option in a <select> by ref/selector, matching value or visible label.',
    inputSchema: obj({ tabId: int(''), ref: str(''), selector: str(''), value: str('option value or label') }, ['tabId', 'value']),
  },
  {
    name: 'browser_press_key',
    category: 'browser',
    description: 'Dispatch a key press to the focused element in the tab, e.g. "Enter", "Escape", "Tab", "ArrowDown", "Control+a".',
    inputSchema: obj({ tabId: int(''), key: str('') }, ['tabId', 'key']),
  },
  {
    name: 'browser_scroll',
    category: 'browser',
    description: 'Scroll the page or an element (by ref) by a delta, or scroll an element into view.',
    inputSchema: obj({ tabId: int(''), ref: str(''), deltaY: int('default 600; negative scrolls up'), intoView: bool('scroll ref into view instead of by delta') }, ['tabId']),
  },
  {
    name: 'browser_read',
    category: 'browser',
    description: 'Extract the readable text of a page (or of an element by ref/selector), with links optionally. Great for research in background tabs.',
    inputSchema: obj({ tabId: int(''), ref: str(''), selector: str(''), includeLinks: bool(''), maxChars: int('default 20000') }, ['tabId']),
  },
  {
    name: 'browser_screenshot',
    category: 'browser',
    description: 'Screenshot a tab. Only possible for the ACTIVE tab of a window (browser limitation) — for background tabs use browser_snapshot/browser_read instead.',
    inputSchema: obj({ tabId: int('') }, ['tabId']),
  },
  {
    name: 'browser_evaluate',
    category: 'browser',
    description: 'Run JavaScript in the page context of a tab and return the JSON-serialisable result. Use sparingly; prefer the structured tools.',
    inputSchema: obj({ tabId: int(''), code: str('JS expression or function body returning a value') }, ['tabId', 'code']),
  },
  {
    name: 'browser_wait',
    category: 'browser',
    description: 'Wait until the tab finished loading, or until a selector/text appears, or a fixed time.',
    inputSchema: obj({ tabId: int(''), selector: str(''), text: str(''), timeoutMs: int('default 15000'), ms: int('fixed wait') }, ['tabId']),
  },
  // ───────────── system ─────────────
  {
    name: 'system_info',
    category: 'system',
    description: 'OS, hostname, user, uptime, CPU/memory, default browser, time zone and current local time.',
    inputSchema: obj({}),
  },
  {
    name: 'notify_user',
    category: 'user',
    description: 'Show a desktop notification to the user (non-blocking). Use for important completions when the user may be in another app.',
    inputSchema: obj({ title: str(''), body: str('') }, ['title', 'body']),
  },
  {
    name: 'ask_user',
    category: 'user',
    description:
      'Ask the user a clarifying question and WAIT for the answer (they see it in the chat). Only use after you have genuinely tried to resolve the problem yourself, including at least one self-repair attempt.',
    inputSchema: obj({ question: str(''), options: { type: 'array', items: { type: 'string' }, description: 'optional quick choices' }, timeoutSec: int('give up waiting after N seconds (default 600)') }, ['question']),
  },
  // ───────────── tasks / progress ─────────────
  {
    name: 'tasks_set',
    category: 'tasks',
    description:
      'Replace the chat\'s task list (plan). Call this at the start of any multi-step job so the user sees a progress ring. Each task: {title, state?}. Keep titles short and user-facing.',
    inputSchema: obj({ tasks: { type: 'array', items: obj({ title: str(''), state: { type: 'string', enum: ['pending', 'in_progress', 'done', 'failed', 'skipped'] }, detail: str('') }, ['title']) } }, ['tasks']),
  },
  {
    name: 'tasks_update',
    category: 'tasks',
    description: 'Update one task by index (0-based) or exact title: set its state and optional detail. Mark tasks in_progress when you start them and done when finished.',
    inputSchema: obj({ index: int(''), title: str(''), state: { type: 'string', enum: ['pending', 'in_progress', 'done', 'failed', 'skipped'] }, detail: str('') }, ['state']),
  },
  // ───────────── memory / learning ─────────────
  {
    name: 'memory_remember',
    category: 'memory',
    description: 'Store a durable fact, preference, or lesson learned about the user or their environment. E.g. "User prefers Edge; their email is in Outlook web." Deduplicated by key.',
    inputSchema: obj({ key: str('short stable key, e.g. preferred_browser'), value: str(''), kind: { type: 'string', enum: ['preference', 'fact', 'lesson', 'procedure', 'goal_feedback'] }, confidence: num('0..1') }, ['key', 'value']),
  },
  {
    name: 'memory_recall',
    category: 'memory',
    description: 'Search memory (semantic-ish keyword search) and return matching entries with keys, values and when they were learned.',
    inputSchema: obj({ query: str(''), limit: int('default 20') }, ['query']),
  },
  {
    name: 'memory_forget',
    category: 'memory',
    description: 'Delete a memory by key.',
    inputSchema: obj({ key: str('') }, ['key']),
  },
  {
    name: 'behavior_summary',
    category: 'memory',
    description: 'What the user has been doing recently (apps/sites used, active hours, routines), from the behaviour observer. Use it to anticipate what they want and to plan goals.',
    inputSchema: obj({ days: int('lookback window (default 7)') }),
  },
  // ───────────── goals ─────────────
  {
    name: 'goals_list',
    category: 'tasks',
    description: 'List standing directives (what the user told AIM to pursue) and current/recent goals with status.',
    inputSchema: obj({ includeDone: bool('') }),
  },
  {
    name: 'goals_add',
    category: 'tasks',
    description: 'Create a goal A.I.M. will pursue on its own: today (run as soon as possible) or on a later date. Use it to commit to follow-ups ("check this again tomorrow", "finish the remaining items tonight") or when the user asks A.I.M. to take something on.',
    inputSchema: obj({ title: str('short, user-facing goal'), rationale: str('why it matters / what done looks like'), date: str('YYYY-MM-DD; default today'), priority: int('1 = highest, 3 = lowest (default 2)'), effort: { type: 'string', enum: ['small', 'medium', 'large'] }, directiveId: str('standing directive this serves, if any') }, ['title', 'rationale']),
  },
  {
    name: 'directives_add',
    category: 'tasks',
    description: 'Record a standing directive — something the user wants A.I.M. to keep pursuing over time ("keep my Downloads organised", "find ML internships weekly"). Daily goals are planned from directives. Only add what the user clearly asked for or confirmed.',
    inputSchema: obj({ text: str(''), priority: int('1 = highest, 3 = lowest (default 2)') }, ['text']),
  },
  {
    name: 'goals_update',
    category: 'tasks',
    description: 'Update a goal\'s status and result notes (used by the goal runner).',
    inputSchema: obj({ goalId: str(''), status: { type: 'string', enum: ['planned', 'in_progress', 'done', 'failed', 'deferred'] }, notes: str('') }, ['goalId', 'status']),
  },
  // ───────────── agents ─────────────
  {
    name: 'agents_status',
    category: 'agents',
    description: 'List AIM worker agents running for this chat and their states.',
    inputSchema: obj({}),
  },
];

export const AIM_TOOL_NAMES = AIM_TOOLS.map((t) => t.name);
export function getToolDefinition(name: string): ToolDefinition | undefined {
  return AIM_TOOLS.find((t) => t.name === name);
}
/** Prefix Claude uses for MCP tools from the `aim` server. */
export const MCP_TOOL_PREFIX = 'mcp__aim__';
export function fullToolName(name: string): string {
  return `${MCP_TOOL_PREFIX}${name}`;
}

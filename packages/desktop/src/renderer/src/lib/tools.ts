/** Tool name humanisation and categorisation for ToolUseRow. */

export type ToolCategory =
  | 'screen'
  | 'browser'
  | 'input'
  | 'window'
  | 'memory'
  | 'tasks'
  | 'goals'
  | 'file'
  | 'shell'
  | 'search'
  | 'agent'
  | 'ask'
  | 'web'
  | 'other';

const AIM_PREFIX = /^mcp__aim__/;

const KNOWN: Record<string, string> = {
  Bash: 'Shell command',
  Read: 'Read file',
  Write: 'Write file',
  Edit: 'Edit file',
  MultiEdit: 'Edit files',
  Glob: 'Find files',
  Grep: 'Search in files',
  LS: 'List directory',
  WebFetch: 'Fetch web page',
  WebSearch: 'Web search',
  Task: 'Delegate to agent',
  Agent: 'Delegate to agent',
  TodoWrite: 'Update task list',
  NotebookEdit: 'Edit notebook',
  AskUserQuestion: 'Ask user',
};

export function stripToolPrefix(name: string): string {
  return name.replace(AIM_PREFIX, '').replace(/^mcp__[^_]+__/, '');
}

export function humanizeToolName(name: string): string {
  if (KNOWN[name]) return KNOWN[name];
  const base = stripToolPrefix(name);
  if (KNOWN[base]) return KNOWN[base];
  const words = base
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  if (!words) return name;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function toolCategory(name: string): ToolCategory {
  const base = stripToolPrefix(name).toLowerCase();
  if (/^(agent|task)$/.test(name.toLowerCase()) || base.startsWith('agent')) return 'agent';
  if (base.startsWith('screen')) return 'screen';
  if (base.startsWith('browser') || base.startsWith('tab')) return 'browser';
  if (base.startsWith('mouse') || base.startsWith('keyboard') || base.startsWith('input') || base.startsWith('clipboard')) return 'input';
  if (base.startsWith('window') || base.startsWith('app_')) return 'window';
  if (base.startsWith('memory')) return 'memory';
  if (base.startsWith('tasks') || base === 'todowrite') return 'tasks';
  if (base.startsWith('goal') || base.startsWith('directive')) return 'goals';
  if (base.startsWith('ask_user') || base === 'askuserquestion' || base.startsWith('notify')) return 'ask';
  if (/^(bash|shell|powershell|run_command)$/.test(base)) return 'shell';
  if (/^(read|write|edit|multiedit|notebookedit|ls)$/.test(base) || base.startsWith('file') || base.startsWith('fs_')) return 'file';
  if (/^(glob|grep)$/.test(base) || base.includes('search')) return 'search';
  if (base.startsWith('web')) return 'web';
  return 'other';
}

/** A one-line textual rendering of a tool input for the collapsed row when no summary is available. */
export function summarizeToolInput(input: unknown, max = 120): string {
  if (input == null) return '';
  if (typeof input === 'string') return clip(input, max);
  if (typeof input !== 'object') return clip(String(input), max);
  const obj = input as Record<string, unknown>;
  const preferred = ['command', 'url', 'path', 'file_path', 'pattern', 'query', 'text', 'selector', 'description', 'prompt', 'title', 'name', 'app', 'key'];
  for (const k of preferred) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return clip(v.trim().replace(/\s+/g, ' '), max);
  }
  const entries = Object.entries(obj).filter(([, v]) => v != null && typeof v !== 'object');
  if (!entries.length) return '';
  return clip(entries.map(([k, v]) => `${k}: ${String(v)}`).join(', '), max);
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function formatToolInput(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

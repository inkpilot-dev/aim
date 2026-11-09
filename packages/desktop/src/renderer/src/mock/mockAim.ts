/**
 * In-memory fake of window.aim for previewing the renderer in a plain browser (`vite --config src/renderer/vite.renderer.config.ts`).
 * Never bundled into the Electron build path unless window.aim is missing.
 *
 * Query params: ?view=goals|memory|settings  ?chat=<id|first|none>  ?platform=win32|linux  ?theme=light
 */
import type {
  AgentInfo,
  AimApi,
  AppHealth,
  Attachment,
  BehaviorSummary,
  Chat,
  ChatStreamEvent,
  ChatTask,
  ChatWithMessages,
  DailyPlan,
  Directive,
  GlobalEvent,
  Goal,
  MemoryEntry,
  Message,
  Settings,
} from '@aim/shared';
import { computeProgress, DEFAULT_SETTINGS } from '@aim/shared';

const now = Date.now();
const H = 3_600_000;
const D = 24 * H;

let seq = 0;
const id = (p: string) => `${p}_${(++seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function fakeScreenshotPng(): string {
  const c = document.createElement('canvas');
  c.width = 160;
  c.height = 100;
  const g = c.getContext('2d')!;
  g.fillStyle = '#1e1e24';
  g.fillRect(0, 0, 160, 100);
  g.fillStyle = '#2a2a33';
  g.fillRect(0, 0, 160, 14);
  g.fillStyle = '#ffffff';
  g.fillRect(10, 24, 140, 66);
  g.fillStyle = '#d7d7de';
  for (let i = 0; i < 5; i++) g.fillRect(18, 32 + i * 11, 90 + (i % 3) * 14, 4);
  g.fillStyle = '#1ABFB0';
  g.fillRect(118, 72, 24, 10);
  return c.toDataURL('image/png').split(',')[1];
}

const SHOT = fakeScreenshotPng();

const chatEventListeners = new Set<(e: ChatStreamEvent) => void>();
const globalEventListeners = new Set<(e: GlobalEvent) => void>();
const emitChat = (e: ChatStreamEvent) => chatEventListeners.forEach((cb) => cb(e));
const emitGlobal = (e: GlobalEvent) => globalEventListeners.forEach((cb) => cb(e));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const settings: Settings = { ...DEFAULT_SETTINGS, hubToken: 'aim-7f3c9a1e-5b2d-4e8f-9c1a-2d3e4f5a6b7c', claudeCliPath: '', defaultCwd: 'C:\\Users\\Alex' };

const health: AppHealth = {
  cli: { found: true, path: 'C:\\Users\\Alex\\AppData\\Roaming\\npm\\claude.cmd', version: '2.1.4', authenticated: true },
  extension: { connected: true, browser: 'Microsoft Edge', version: '0.1.0', tabs: 7, lastSeen: now - 2000 },
  hub: { listening: true, port: 47821, url: 'ws://127.0.0.1:47821', token: settings.hubToken },
  observer: { enabled: true, samples: 12_480 },
  version: '0.1.0',
  userName: 'Samuel',
  platform: 'win32',
};

// ---------- seed data ----------
const chats = new Map<string, ChatWithMessages>();

function mkChat(partial: Partial<Chat> & { title: string }): ChatWithMessages {
  const c: ChatWithMessages = {
    id: partial.id ?? id('chat'),
    title: partial.title,
    createdAt: partial.createdAt ?? now - H,
    updatedAt: partial.updatedAt ?? now - H,
    status: partial.status ?? 'idle',
    origin: partial.origin ?? 'user',
    pinned: partial.pinned,
    archived: partial.archived,
    goalId: partial.goalId,
    cwd: 'C:\\Users\\Alex',
    messages: [],
    tasks: [],
    agents: [],
  };
  chats.set(c.id, c);
  return c;
}

function msg(chatId: string, role: Message['role'], content: Message['content'], at: number, extra: Partial<Message> = {}): Message {
  return { id: id('msg'), chatId, role, content, createdAt: at, ...extra };
}

const research = mkChat({ id: 'chat_research', title: 'GPU inference research', updatedAt: now - 6 * 60_000, status: 'working', pinned: true });
{
  const t0 = now - 14 * 60_000;
  research.messages.push(
    msg(research.id, 'user', [{ type: 'text', text: 'Research the current state of local LLM inference on consumer GPUs in a background tab and summarise the findings with sources.' }], t0),
    msg(
      research.id,
      'assistant',
      [
        { type: 'thinking', text: 'The user wants a research summary. I will plan the tasks, open a background tab, gather three or four sources and summarise.' },
        { type: 'text', text: 'I will research this in a background tab so your current work is not interrupted. Setting up the plan first.' },
        {
          type: 'tool_use',
          id: 'tu_1',
          name: 'mcp__aim__tasks_set',
          input: { tasks: ['Open background tab', 'Collect sources', 'Read benchmarks', 'Summarise findings', 'Verify citations'] },
          result: { ok: true, summary: '5 tasks registered', durationMs: 42 },
        },
        {
          type: 'tool_use',
          id: 'tu_2',
          name: 'mcp__aim__browser_open_tab',
          input: { url: 'https://www.bing.com/search?q=local+llm+inference+consumer+gpu+2026', background: true },
          result: { ok: true, summary: 'Opened tab 412 in background (Edge)', durationMs: 830 },
        },
        {
          type: 'tool_use',
          id: 'tu_3',
          name: 'mcp__aim__browser_snapshot',
          input: { tabId: 412 },
          result: { ok: true, summary: 'Snapshot: 38 links, 12 headings', durationMs: 1210 },
        },
        {
          type: 'tool_use',
          id: 'tu_4',
          name: 'mcp__aim__screen_capture',
          input: { display: 0 },
          result: { ok: true, summary: 'Captured 2560x1440 display', durationMs: 310, imageBase64: SHOT },
        },
        {
          type: 'tool_use',
          id: 'tu_5',
          name: 'mcp__aim__browser_click',
          input: { tabId: 412, selector: 'a[href*="paywalled-benchmarks"]' },
          result: { ok: false, summary: '', error: 'Element not found after 5 s (selector matched 0 nodes)', durationMs: 5020 },
        },
        { type: 'status', text: 'Self-repair attempt 1 of 3: retrying with an alternative source.' },
        {
          type: 'tool_use',
          id: 'tu_6',
          name: 'Agent',
          input: { subagent_type: 'researcher', description: 'Read benchmark articles and extract tokens/s figures' },
          agentId: 'ag_1',
        },
        {
          type: 'text',
          text: '## Interim findings\n\n- **Quantisation** (4-bit GGUF / AWQ) is the default for 7B–14B models on 8–16 GB cards.\n- Consumer cards in the **RTX 4070–4090** class sustain roughly 40–120 tokens/s on 7B models, depending on context length.\n- `llama.cpp`, `vLLM` and `ExLlamaV2` are the three runtimes that come up in every comparison.\n\n| Card | VRAM | 7B Q4 tok/s |\n|---|---|---|\n| RTX 4070 | 12 GB | ~55 |\n| RTX 4080 | 16 GB | ~85 |\n| RTX 4090 | 24 GB | ~120 |\n\nContinuing with the benchmark deep-dive',
        },
      ],
      t0 + 20_000,
    ),
  );
  const tasks: ChatTask[] = ['Open background tab', 'Collect sources', 'Read benchmarks', 'Summarise findings', 'Verify citations'].map((title, i) => ({
    id: `task_${i}`,
    chatId: research.id,
    title,
    state: i < 2 ? 'done' : i === 2 ? 'in_progress' : 'pending',
    order: i,
    createdAt: t0,
    updatedAt: now,
  }));
  research.tasks = tasks;
  research.progress = computeProgress(tasks);
  research.agents = [
    { id: 'ag_0', chatId: research.id, role: 'orchestrator', name: 'A.I.M.', state: 'running', task: 'Coordinate the research and write the summary', startedAt: t0 + 5000, lastActivity: 'Waiting for researcher' },
    { id: 'ag_1', chatId: research.id, role: 'researcher', name: 'Researcher', state: 'running', task: 'Read benchmark articles and extract tokens/s figures', startedAt: now - 4 * 60_000, lastActivity: 'Reading article 3 of 4', parentAgentId: 'ag_0' },
    { id: 'ag_2', chatId: research.id, role: 'browser_operator', name: 'Browser Operator', state: 'done', task: 'Open search results and collect source links', startedAt: t0 + 8000, endedAt: t0 + 95_000, parentAgentId: 'ag_0' },
  ];
}

const downloads = mkChat({ id: 'chat_downloads', title: 'Organise Downloads folder', updatedAt: now - 3 * H, status: 'done' });
{
  const t0 = now - 3 * H - 10 * 60_000;
  downloads.messages.push(
    msg(downloads.id, 'user', [{ type: 'text', text: 'Organise my Downloads folder into sensible subfolders by type and date. Ask before deleting anything.' }], t0),
    msg(
      downloads.id,
      'assistant',
      [
        { type: 'tool_use', id: 'tu_d1', name: 'Bash', input: { command: 'ls -la ~/Downloads | head -50' }, result: { ok: true, summary: '184 files, 3.2 GB', durationMs: 120 } },
        {
          type: 'text',
          text: 'Done. I moved 184 files into `Documents`, `Images`, `Installers`, `Archives` and `Other`, each with a `2026-11` subfolder. Nothing was deleted; 9 duplicate installers are listed in `Downloads/_review/duplicates.txt` for you to confirm.',
        },
      ],
      t0 + 90_000,
      { usage: { durationMs: 84_000, outputTokens: 2130, costUsd: 0.14 } },
    ),
  );
  const tasks: ChatTask[] = ['Scan folder', 'Group by type', 'Move files', 'Report'].map((title, i) => ({ id: `td_${i}`, chatId: downloads.id, title, state: 'done', order: i, createdAt: t0, updatedAt: t0 + 80_000 }));
  downloads.tasks = tasks;
  downloads.progress = computeProgress(tasks);
}

const goalChat = mkChat({ id: 'chat_goal_inbox', title: 'Morning inbox briefing', updatedAt: now - 26 * H, status: 'done', origin: 'goal', goalId: 'goal_y1' });
goalChat.messages.push(
  msg(goalChat.id, 'user', [{ type: 'text', text: 'Daily goal: check the inbox for anything urgent and prepare a short briefing.' }], now - 26 * H),
  msg(goalChat.id, 'assistant', [{ type: 'text', text: 'Two items need your attention today:\n\n1. **Visa appointment confirmation** — reply requested by Friday.\n2. **Invoice #2231** from the landlord — amount matches the lease; I did not pay it (payments are never performed).' }], now - 26 * H + 60_000),
);

mkChat({ id: 'chat_err', title: 'Export Roblox build log', updatedAt: now - 2 * D - H, status: 'error' });
mkChat({ id: 'chat_wait', title: 'Draft reply to recruiter', updatedAt: now - 50 * 60_000, status: 'waiting_user' });
mkChat({ id: 'chat_old1', title: 'Compare laptop prices', updatedAt: now - 5 * D });
mkChat({ id: 'chat_old2', title: 'Set up Python environment', updatedAt: now - 12 * D });
mkChat({ id: 'chat_arch', title: 'Old notes cleanup', updatedAt: now - 20 * D, archived: true });

const waitChat = chats.get('chat_wait')!;
waitChat.messages.push(
  msg(waitChat.id, 'user', [{ type: 'text', text: 'Draft a reply to the recruiter email from yesterday.' }], now - 55 * 60_000),
  msg(waitChat.id, 'assistant', [{ type: 'text', text: 'I found two recruiter emails from yesterday. Which one should I reply to?' }], now - 52 * 60_000),
);
const pendingQuestions = new Map<string, { chatId: string; question: string; options?: string[] }>();
pendingQuestions.set('q_1', { chatId: waitChat.id, question: 'Which recruiter email should I reply to?', options: ['Nordic Labs — ML intern', 'Brightwave — data role', 'Neither'] });

function toChat(c: ChatWithMessages): Chat {
  const { messages, tasks, agents, ...rest } = c;
  const last = messages[messages.length - 1];
  const preview = last?.content.find((b) => b.type === 'text');
  return { ...rest, lastMessagePreview: preview && preview.type === 'text' ? preview.text.slice(0, 120) : undefined, progress: tasks.length ? computeProgress(tasks) : undefined, ...(agents.length ? {} : {}) };
}

// ---------- learning data ----------
let directives: Directive[] = [
  { id: 'dir_1', text: 'Keep my inbox at zero and flag anything urgent', createdAt: now - 20 * D, active: true, priority: 1, lastPursuedAt: now - 26 * H },
  { id: 'dir_2', text: 'Find ML internships in Europe every week', createdAt: now - 15 * D, active: true, priority: 2, lastPursuedAt: now - 3 * D },
  { id: 'dir_3', text: 'Keep the Downloads folder organised', createdAt: now - 10 * D, active: true, priority: 3 },
  { id: 'dir_4', text: 'Practice Spanish vocabulary daily', createdAt: now - 8 * D, active: false, priority: 2 },
];

const todayIso = isoDate(now);
const yIso = isoDate(now - D);
let goals: Goal[] = [
  { id: 'goal_t1', date: todayIso, title: 'Triage inbox and prepare briefing', rationale: 'Directive 1 — three unread threads look time-sensitive.', directiveId: 'dir_1', status: 'done', priority: 1, effort: 'small', chatId: 'chat_goal_inbox', createdAt: now - 3 * H, updatedAt: now - 2 * H },
  { id: 'goal_t2', date: todayIso, title: 'Scan three job boards for new ML internships', rationale: 'Weekly cadence for directive 2; last run was 3 days ago.', directiveId: 'dir_2', status: 'in_progress', priority: 2, effort: 'medium', chatId: 'chat_research', createdAt: now - 3 * H, updatedAt: now - 10 * 60_000 },
  { id: 'goal_t3', date: todayIso, title: 'Review duplicate installers in Downloads/_review', rationale: 'Follow-up from yesterday\u2019s cleanup; 9 duplicates await confirmation.', directiveId: 'dir_3', status: 'planned', priority: 3, effort: 'small', createdAt: now - 3 * H, updatedAt: now - 3 * H },
  { id: 'goal_y1', date: yIso, title: 'Morning inbox briefing', rationale: 'Directive 1.', directiveId: 'dir_1', status: 'done', priority: 1, effort: 'small', chatId: 'chat_goal_inbox', createdAt: now - 27 * H, updatedAt: now - 26 * H },
  { id: 'goal_y2', date: yIso, title: 'Organise Downloads folder', rationale: 'Directive 3.', directiveId: 'dir_3', status: 'done', priority: 3, effort: 'medium', chatId: 'chat_downloads', createdAt: now - 27 * H, updatedAt: now - 25 * H },
  { id: 'goal_y3', date: yIso, title: 'Export Roblox build log', rationale: 'Requested in a previous chat.', status: 'failed', priority: 2, effort: 'small', chatId: 'chat_err', createdAt: now - 27 * H, updatedAt: now - 24 * H, notes: 'Roblox Studio was not running' },
];

let memories: MemoryEntry[] = [
  { key: 'preferred_browser', value: 'Prefers Microsoft Edge; keeps work tabs in a separate profile.', kind: 'preference', confidence: 0.92, createdAt: now - 18 * D, updatedAt: now - 2 * D, hits: 14, source: 'observer' },
  { key: 'downloads_layout', value: 'Downloads are organised by type then YYYY-MM subfolder. Never delete without asking.', kind: 'procedure', confidence: 0.88, createdAt: now - 1 * D, updatedAt: now - 3 * H, hits: 2, source: 'reflection' },
  { key: 'timezone', value: 'Works in Europe/London time; mornings start around 08:30.', kind: 'fact', confidence: 0.8, createdAt: now - 20 * D, updatedAt: now - 5 * D, hits: 9, source: 'observer' },
  { key: 'roblox_studio_logs', value: 'Roblox Studio must be running before exporting build logs; otherwise the export menu is unavailable.', kind: 'lesson', confidence: 0.7, createdAt: now - 24 * H, updatedAt: now - 24 * H, hits: 1, source: 'reflection' },
  { key: 'briefing_format', value: 'Likes briefings as a numbered list with bold subject lines and a one-line action.', kind: 'goal_feedback', confidence: 0.75, createdAt: now - 10 * D, updatedAt: now - 1 * D, hits: 5, source: 'user' },
  { key: 'internship_regions', value: 'Only interested in internships in the UK, Netherlands and Germany.', kind: 'preference', confidence: 0.95, createdAt: now - 15 * D, updatedAt: now - 3 * D, hits: 6, source: 'user' },
];

const behavior: BehaviorSummary = {
  days: 7,
  totalActiveMs: 31.5 * H,
  topApps: [
    { app: 'msedge', ms: 12.2 * H, share: 0.39 },
    { app: 'Code', ms: 8.4 * H, share: 0.27 },
    { app: 'RobloxStudio', ms: 4.1 * H, share: 0.13 },
    { app: 'Outlook', ms: 3.2 * H, share: 0.1 },
    { app: 'Discord', ms: 2.3 * H, share: 0.07 },
    { app: 'Explorer', ms: 1.3 * H, share: 0.04 },
  ],
  topSites: [
    { host: 'github.com', ms: 4.1 * H, share: 0.34 },
    { host: 'docs.python.org', ms: 2.2 * H, share: 0.18 },
    { host: 'youtube.com', ms: 1.9 * H, share: 0.16 },
    { host: 'linkedin.com', ms: 1.4 * H, share: 0.11 },
    { host: 'create.roblox.com', ms: 1.2 * H, share: 0.1 },
    { host: 'mail.google.com', ms: 0.9 * H, share: 0.07 },
  ],
  activeHours: [0, 0, 0, 0, 0, 0, 0, 0.2, 1.4, 2.8, 3.1, 2.6, 1.2, 2.4, 3.0, 2.9, 2.1, 1.3, 1.1, 1.8, 2.2, 1.6, 0.6, 0.1].map((h) => h * H),
  routines: ['Opens Outlook most mornings around 09:00', 'Long Roblox Studio sessions on weekday evenings after 19:00', 'Visits linkedin.com on Mondays and Thursdays', 'Rarely active between 00:00 and 07:00'],
};

function isoDate(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------- simulated turn ----------
async function simulateTurn(chat: ChatWithMessages, text: string) {
  const chatId = chat.id;
  const set = (status: Chat['status']) => {
    chat.status = status;
    emitChat({ type: 'status', chatId, status });
  };
  set('thinking');
  await sleep(500);
  const m: Message = { id: id('msg'), chatId, role: 'assistant', content: [], createdAt: Date.now() };
  chat.messages.push(m);
  emitChat({ type: 'message.start', chatId, message: { ...m, content: [] } });

  const tasks: ChatTask[] = ['Understand request', 'Inspect current state', 'Carry out the work', 'Verify result'].map((title, i) => ({
    id: id('task'),
    chatId,
    title,
    state: i === 0 ? 'in_progress' : 'pending',
    order: i,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }));
  chat.tasks = tasks;
  emitChat({ type: 'tasks', chatId, tasks: [...tasks], progress: computeProgress(tasks) });
  set('working');

  const stream = async (idx: number, full: string) => {
    m.content[idx] = { type: 'text', text: '' };
    const words = full.split(/(\s+)/);
    for (const w of words) {
      (m.content[idx] as { text: string }).text += w;
      emitChat({ type: 'message.delta', chatId, messageId: m.id, blockIndex: idx, delta: { text: w } });
      await sleep(18);
    }
  };

  await stream(0, `Understood. I will ${text.length > 60 ? 'work through this step by step' : 'take care of that'} and keep the progress ring updated.`);

  const tool = async (idx: number, name: string, input: unknown, summary: string, ms: number, extra: Partial<NonNullable<Extract<Message['content'][number], { type: 'tool_use' }>['result']>> = {}) => {
    const block = { type: 'tool_use' as const, id: id('tu'), name, input };
    m.content[idx] = block;
    emitChat({ type: 'message.block', chatId, messageId: m.id, blockIndex: idx, block: { ...block } });
    await sleep(ms);
    const done = { ...block, result: { ok: true, summary, durationMs: ms, ...extra } };
    m.content[idx] = done;
    emitChat({ type: 'message.block', chatId, messageId: m.id, blockIndex: idx, block: { ...done } });
  };

  const advance = (i: number) => {
    tasks.forEach((t, j) => (t.state = j < i ? 'done' : j === i ? 'in_progress' : 'pending'));
    emitChat({ type: 'tasks', chatId, tasks: [...tasks], progress: computeProgress(tasks) });
  };

  advance(1);
  await tool(1, 'mcp__aim__screen_capture', { display: 0 }, 'Captured 2560x1440 display', 700, { imageBase64: SHOT });
  await tool(2, 'mcp__aim__window_list', {}, '6 windows (active: Microsoft Edge)', 400);
  advance(2);
  await tool(3, 'mcp__aim__browser_open_tab', { url: 'https://example.com', background: true }, 'Opened tab 413 in background', 900);
  advance(3);
  await tool(4, 'mcp__aim__memory_search', { query: text.slice(0, 40) }, '2 relevant memories', 300);
  await stream(
    5,
    `Here is what I did:\n\n1. Took a screenshot to see the current state.\n2. Opened the relevant page in a **background tab** so your focus was not interrupted.\n3. Checked my memory for related preferences.\n\n\`\`\`text\nResult: completed without errors\n\`\`\`\n\nLet me know if you would like me to go further.`,
  );
  tasks.forEach((t) => (t.state = 'done'));
  emitChat({ type: 'tasks', chatId, tasks: [...tasks], progress: computeProgress(tasks) });
  m.usage = { durationMs: 6400, outputTokens: 412, inputTokens: 3200, costUsd: 0.03 };
  emitChat({ type: 'message.end', chatId, message: JSON.parse(JSON.stringify(m)) as Message });
  set('done');
  chat.updatedAt = Date.now();
  if (chat.title === 'New chat') {
    chat.title = text.slice(0, 40).replace(/[.?!]$/, '');
    emitChat({ type: 'title', chatId, title: chat.title });
  }
  emitChat({ type: 'chat.updated', chat: toChat(chat) });
  setTimeout(() => emitGlobal({ type: 'toast', level: 'success', title: 'Task completed', body: chat.title }), 300);
}

// ---------- API ----------
export function installMockAim(): void {
  const params = new URLSearchParams(location.search);
  const platform = params.get('platform') ?? 'win32';
  const prefs: Record<string, unknown> = {};
  const view = params.get('view');
  if (view) prefs.view = view;
  const chatParam = params.get('chat');
  if (chatParam === 'none') prefs.lastChatId = null;
  else if (chatParam === 'first') prefs.lastChatId = 'chat_research';
  else if (chatParam) prefs.lastChatId = chatParam;
  if (params.has('collapsed')) prefs.sidebarCollapsed = true;
  if (Object.keys(prefs).length) {
    try {
      localStorage.setItem('aim.ui.prefs', JSON.stringify({ ...(JSON.parse(localStorage.getItem('aim.ui.prefs') ?? '{}') as object), ...prefs }));
    } catch {
      /* ignore */
    }
  }
  if (params.get('theme') === 'light') settings.theme = 'light';
  health.platform = platform;

  const api: AimApi & { platform: string } = {
    platform,
    listChats: async () => [...chats.values()].map(toChat),
    getChat: async (chatId) => {
      await sleep(60);
      const c = chats.get(chatId);
      return c ? { ...toChat(c), messages: [...c.messages], tasks: [...c.tasks], agents: [...c.agents] } : null;
    },
    createChat: async (input) => {
      const c = mkChat({ title: input?.title ?? 'New chat', createdAt: Date.now(), updatedAt: Date.now() });
      return toChat(c);
    },
    renameChat: async (chatId, title) => {
      const c = chats.get(chatId);
      if (c) {
        c.title = title;
        emitChat({ type: 'chat.updated', chat: toChat(c) });
      }
    },
    deleteChat: async (chatId) => {
      chats.delete(chatId);
      emitChat({ type: 'chat.deleted', chatId });
    },
    pinChat: async (chatId, pinned) => {
      const c = chats.get(chatId);
      if (c) c.pinned = pinned;
    },
    archiveChat: async (chatId, archived) => {
      const c = chats.get(chatId);
      if (c) c.archived = archived;
    },
    sendMessage: async ({ chatId, text, attachments }) => {
      const c = chats.get(chatId);
      if (!c) throw new Error('Chat not found');
      const content: Message['content'] = [
        ...(attachments ?? []).filter((a) => a.dataBase64).map((a) => ({ type: 'image' as const, mediaType: a.mediaType, dataBase64: a.dataBase64!, alt: a.name })),
        { type: 'text', text },
      ];
      const um = msg(chatId, 'user', content, Date.now());
      c.messages.push(um);
      c.updatedAt = Date.now();
      emitChat({ type: 'message.start', chatId, message: um });
      emitChat({ type: 'message.end', chatId, message: um });
      void simulateTurn(c, text);
    },
    stopChat: async (chatId) => {
      const c = chats.get(chatId);
      if (c) {
        c.status = 'idle';
        emitChat({ type: 'status', chatId, status: 'idle' });
      }
    },
    answerQuestion: async (chatId, requestId) => {
      pendingQuestions.delete(requestId);
      emitChat({ type: 'ask_user.resolved', chatId, requestId });
      const c = chats.get(chatId);
      if (c) void simulateTurn(c, 'Continue with the chosen option.');
    },
    searchChats: async (query) => [...chats.values()].filter((c) => c.title.toLowerCase().includes(query.toLowerCase())).map(toChat),
    captureScreenshot: async () => {
      await sleep(400);
      const a: Attachment = { kind: 'screenshot', name: 'Screenshot.png', mediaType: 'image/png', dataBase64: SHOT };
      return a;
    },
    getSettings: async () => ({ ...settings }),
    updateSettings: async (patch) => {
      Object.assign(settings, patch);
      await sleep(80);
      return { ...settings };
    },
    getHealth: async () => ({ ...health }),
    detectCli: async () => {
      await sleep(600);
      return { ...health.cli };
    },
    listMemories: async (query) => {
      const q = query?.toLowerCase();
      return memories.filter((m) => !q || m.key.includes(q) || m.value.toLowerCase().includes(q));
    },
    deleteMemory: async (key) => {
      memories = memories.filter((m) => m.key !== key);
      emitGlobal({ type: 'memory.updated', count: memories.length });
    },
    upsertMemory: async (entry) => {
      const existing = memories.find((m) => m.key === entry.key);
      if (existing) Object.assign(existing, entry, { updatedAt: Date.now(), hits: existing.hits + 1 });
      else memories.push({ ...entry, confidence: 1, createdAt: Date.now(), updatedAt: Date.now(), hits: 1, source: 'user' });
    },
    getBehaviorSummary: async () => behavior,
    listDirectives: async () => [...directives],
    addDirective: async (text, priority = 2) => {
      const d: Directive = { id: id('dir'), text, createdAt: Date.now(), active: true, priority };
      directives.push(d);
      return d;
    },
    updateDirective: async (dirId, patch) => {
      directives = directives.map((d) => (d.id === dirId ? { ...d, ...patch } : d));
    },
    deleteDirective: async (dirId) => {
      directives = directives.filter((d) => d.id !== dirId);
    },
    listGoals: async (opts) => goals.filter((g) => (!opts?.date || g.date === opts.date) && (opts?.includeDone || g.status !== 'done')),
    planGoalsNow: async () => {
      await sleep(1500);
      const g: Goal = { id: id('goal'), date: todayIso, title: 'Draft follow-up to Nordic Labs recruiter', rationale: 'Directive 2 — the recruiter asked for a reply this week.', directiveId: 'dir_2', status: 'planned', priority: 2, effort: 'small', createdAt: Date.now(), updatedAt: Date.now() };
      goals = [...goals, g];
      const plan: DailyPlan = { date: todayIso, goals: goals.filter((x) => x.date === todayIso), summary: 'Today focuses on the inbox and the internship search. One small follow-up was added for the recruiter thread; the Downloads review stays low priority.', createdAt: Date.now() };
      emitGlobal({ type: 'goals.plan', plan });
      return plan;
    },
    runGoal: async (goalId) => {
      const g = goals.find((x) => x.id === goalId);
      if (!g) throw new Error('Goal not found');
      const c = mkChat({ title: g.title, origin: 'goal', goalId, createdAt: Date.now(), updatedAt: Date.now() });
      g.status = 'in_progress';
      g.chatId = c.id;
      emitChat({ type: 'chat.updated', chat: toChat(c) });
      setTimeout(() => void api.sendMessage({ chatId: c.id, text: `Goal: ${g.title}. ${g.rationale}` }), 400);
      return { chatId: c.id };
    },
    minimize: () => console.info('[mock] minimize'),
    maximize: () => console.info('[mock] maximize'),
    close: () => console.info('[mock] close'),
    openExternal: async (url) => {
      window.open(url, '_blank', 'noopener');
    },
    openPath: async (p) => console.info('[mock] openPath', p),
    checkForUpdates: async () => ({ state: 'not_available' as const, currentVersion: '0.1.0', latestVersion: '0.1.0', repo: 'example/aim', checkedAt: Date.now() }),
    downloadUpdate: async () => ({ state: 'downloaded' as const, currentVersion: '0.1.0', latestVersion: '0.2.0', repo: 'example/aim', percent: 100 }),
    installUpdate: async () => console.info('[mock] installUpdate'),
    onChatEvent: (cb) => {
      chatEventListeners.add(cb);
      // Replay the pending question for the waiting chat once the UI is listening.
      setTimeout(() => {
        pendingQuestions.forEach((q, requestId) => cb({ type: 'ask_user', chatId: q.chatId, requestId, question: q.question, options: q.options }));
      }, 200);
      return () => chatEventListeners.delete(cb);
    },
    onGlobalEvent: (cb) => {
      globalEventListeners.add(cb);
      return () => globalEventListeners.delete(cb);
    },
  };
  window.aim = api;
  console.info('[mock] window.aim installed');
}

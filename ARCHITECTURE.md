# A.I.M. — Artificial Intelligence Management — Architecture

A.I.M. is a Windows-first (cross-platform Electron) desktop agent. It talks to the **Claude Code CLI** (`claude -p --output-format stream-json`) — no API key is stored; the user's existing `claude` login is used. AIM can see the screen, drive the mouse/keyboard, drive the browser through its own extension (background tabs, no cursor theft), remember, learn from behaviour, plan daily goals, and split work across worker agents. The single hard limit: **payments are never performed**.

## Processes

```
┌──────────────────────────── Electron (packages/desktop) ──────────────────────────────┐
│  main process = "Hub"                                                                  │
│   ├─ ChatService (@aim/core)  — chats, messages, tasks, agents; persists via ChatStore │
│   ├─ ClaudeCliBridge (@aim/core) — one `claude` child process per active chat turn     │
│   ├─ Orchestrator (@aim/core) — plans, delegates to worker agents (CLI --agents + extra │
│   │                               parallel CLI processes), tracks AgentInfo + progress │
│   ├─ SelfHealer (@aim/core) — retries, re-prompts with error context, then ask_user     │
│   ├─ Learning (@aim/core) — MemoryStore, BehaviorObserver, Reflector, GoalPlanner,      │
│   │                           Scheduler (daily goals), DirectiveStore                   │
│   ├─ HubServer (desktop/main/hub) — ws://127.0.0.1:47821 {/aim/tools, /aim/ext}         │
│   ├─ ToolRouter (desktop/main/tools) — implements every AIM_TOOLS entry                 │
│   │     screen (desktopCapturer/screenshot), input (nut-js), windows (active-win,       │
│   │     PowerShell on win32), browser (relay to extension), memory/tasks/goals (core),   │
│   │     ask_user/notify (renderer IPC), PaymentGuard wraps browser+input tools          │
│   ├─ CursorOverlay — transparent click-through always-on-top window drawing AIM's teal  │
│   │                  cursor during desktop input tools                                   │
│   └─ IPC (shared/ipc.ts) ⇄ preload ⇄ renderer (React)                                   │
└────────────────────────────────────────────────────────────────────────────────────────┘
         ▲ stdio (MCP)                          ▲ ws /aim/ext
┌────────┴───────────────┐            ┌─────────┴───────────────────────────┐
│ claude CLI (per chat)  │            │ Browser extension (packages/extension│
│  --mcp-config → spawns │            │  MV3, Edge/Chrome) service worker +  │
│  @aim/tools-mcp proxy  │──ws──► Hub │  content script (snapshot, actions,  │
│  (stdio⇄ws, stateless) │ /aim/tools │  teal cursor overlay, payment guard) │
└────────────────────────┘            └──────────────────────────────────────┘
```

### Why a proxy MCP server
The CLI spawns MCP servers itself. `@aim/tools-mcp` is a tiny stdio MCP server that forwards `tools/list` and `tools/call` to the Hub over WebSocket (`HUB_PATH_TOOLS`), authenticating with `AIM_HUB_TOKEN` and tagging calls with `AIM_CHAT_ID`. All real logic lives once, in the Hub, with access to Electron APIs, the extension socket, the overlay window and the stores.

### CLI invocation (ClaudeCliBridge)
```
claude -p --verbose --output-format stream-json --input-format stream-json --include-partial-messages \
  --permission-mode bypassPermissions --dangerously-skip-permissions \
  --mcp-config <json> --strict-mcp-config \
  --append-system-prompt <AIM system prompt + memory digest> \
  --agents <json: planner, browser_operator, desktop_operator, researcher, coder, verifier> \
  [--resume <sessionId>] [--model x] [--effort x] [--max-budget-usd x] [--add-dir ...]
```
- stdin gets `CliUserInput` lines; stdout yields `CliEvent` lines (shared/cli.ts).
- The chat keeps `sessionId` from the `system/init` event for `--resume`. One process per turn (simpler recovery); if the process dies mid-turn, SelfHealer restarts with `--resume` and a "continue" nudge.
- `parent_tool_use_id` on assistant/user events ⇒ sub-agent activity → AgentInfo updates.
- The mcp-config: `{"mcpServers":{"aim":{"command":"<node>","args":["<tools-mcp/dist/index.js>"],"env":{"AIM_HUB_URL":...,"AIM_HUB_TOKEN":...,"AIM_CHAT_ID":...}}}}`. In packaged builds `<node>` is Electron itself with `ELECTRON_RUN_AS_NODE=1`.

### Orchestration
1. Every turn's system prompt instructs AIM to call `tasks_set` first for multi-step work and keep it updated → progress ring.
2. Claude Code's own Agent tool with `--agents` definitions handles delegation inside one CLI process (parallel sub-agents). The Orchestrator mirrors those into `AgentInfo` from `parent_tool_use_id` + Agent tool_use inputs (`subagent_type`, `description`).
3. For very large jobs, the orchestrator can also launch **worker chats**: separate CLI processes (own session) whose results are fed back as a user message into the parent chat (`Orchestrator.spawnWorker`). Limit: `maxParallelAgents`.

### Self-learning
- `MemoryStore` (SQLite via better-sqlite3): MemoryEntry rows + FTS5 search. A digest (top N by hits/recency, ≤ 2k tokens) is appended to every system prompt.
- `Reflector`: after each completed turn (if enabled) runs `claude -p --model haiku --json-schema REFLECTION_JSON_SCHEMA` on a compact transcript to extract memories + chat title.
- `BehaviorObserver`: samples active window every 5 s (active-win) + extension `user.activity` events → BehaviorSample rows → `BehaviorSummary` (top apps/sites, hours, routines).
- `GoalPlanner` + `Scheduler`: daily at `dailyGoalsTime` (and on launch if today's plan is missing) → `claude -p --json-schema DAILY_PLAN_JSON_SCHEMA` with directives + memory digest + behaviour summary + yesterday's outcomes → `DailyPlan`; if `autoRunGoals`, each goal becomes a chat (`origin:'goal'`) run sequentially with progress.

### Self-healing
- Tool errors return `{ok:false,error}` to the model (never throw across the wire) so the model can retry.
- CLI process errors / `result.is_error` → SelfHealer: attempt ≤ `maxSelfHealAttempts` re-prompts (“The previous attempt failed with: … Diagnose and fix, then continue.”), emitting `self_heal` events; only then surface to the user / `ask_user`.
- Extension disconnected → browser tools return a clear error with the fix (open Edge, enable extension) and `app_launch('msedge')` is attempted once.

### Payment guard (shared/payment-guard.ts)
Applied in the Hub for `browser_click/type/navigate/open_tab` and `keyboard_type` (card numbers), and again in the extension content script before dispatching clicks/typing. Blocked calls return `errorCode: RpcErrorCode.PolicyBlocked` + `PAYMENT_BLOCK_MESSAGE`.

### Cursor rules
- Browser work: the extension draws a teal cursor (`#1ABFB0`, white outline) inside the page, only when `document.visibilityState === 'visible'` — so the user sees it only on the same tab.
- Desktop work: the real pointer must move (OS limitation). The `CursorOverlay` window draws AIM's teal cursor on top so it's clearly AIM's; the system prompt tells AIM to prefer browser tools when the user is active in another app (`screen_info.activeWindow`).

## Packages / ownership
| package | owner | contents |
|---|---|---|
| `packages/shared` | done | types, protocol, tool catalogue, payment guard, IPC contract |
| `packages/core` | core agent | ChatStore, ChatService, ClaudeCliBridge, Orchestrator, SelfHealer, prompts |
| `packages/core/src/learning` | learning agent | MemoryStore, BehaviorObserver, Reflector, DirectiveStore, GoalPlanner, Scheduler |
| `packages/desktop/src/main` | main agent | Electron boot, windows, tray, IPC handlers, HubServer, ToolRouter + tool impls, CursorOverlay |
| `packages/desktop/src/preload` | main agent | contextBridge → `window.aim: AimApi` |
| `packages/desktop/src/renderer` | UI agent | React UI |
| `packages/tools-mcp` | main agent | stdio MCP ⇄ Hub ws proxy |
| `packages/extension` | extension agent | MV3 extension |
| `assets/`, `scripts/`, packaging | branding agent | icon, electron-builder, installers, README |

## Conventions
- TypeScript strict, ESM (`"type":"module"`), Node 20+. Imports between packages: `@aim/shared`, `@aim/core`.
- Never throw raw errors to the model — return `ToolResult` with `ok:false`.
- Everything the user sees is formal, concise, no emoji.
- Tests: vitest, `*.test.ts` next to code or in `__tests__`.
- Logging: `@aim/core` exports `createLogger(scope)` writing to console + `logs/aim.log` in userData.

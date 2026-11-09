# A.I.M. — Artificial Intelligence Management

A.I.M. is a desktop AI agent that runs on your own machine and works through the **Claude Code CLI**. It can see the screen, operate the mouse and keyboard, drive Microsoft Edge or Google Chrome through its own browser extension, remember what it learns, plan daily goals and split large jobs across worker agents. It uses the `claude` login you already have: A.I.M. never asks for, stores or transmits an API key.

One rule is absolute: **A.I.M. never performs a payment.** It will take a task up to the point where money would change hands and then stop and hand over to you.

## Capabilities

| Area | What A.I.M. does |
|---|---|
| Chat | Multi-turn chats with streaming output, attachments, per-chat working directory, model and effort selection. |
| Screen | Captures the screen or a window, finds on-screen text, reports the active window. |
| Desktop input | Moves and clicks the mouse, drags, scrolls, types and presses keys; a teal cursor overlay shows when A.I.M. is in control. |
| Browser | Opens, reads, snapshots, clicks, types into and navigates web pages through the A.I.M. extension, in background tabs, without taking over your pointer. |
| Windows and apps | Lists, focuses and launches applications. |
| Planning | Breaks work into tracked tasks (the progress ring) and delegates to parallel sub-agents: planner, browser operator, desktop operator, researcher, coder, verifier. |
| Memory | Stores durable facts and preferences in a local SQLite database and recalls them in later chats. |
| Behaviour | Observes which applications and sites you use (locally) to adapt its suggestions and routines. |
| Goals | Plans goals each morning from your standing directives and can run them automatically. |
| Self-healing | Retries failed steps with the error context before asking you for help. |

## Architecture

A.I.M. is an Electron application (`packages/desktop`). Its main process, the **Hub**, owns every capability. Each chat turn is a `claude -p` process; the CLI connects back to the Hub through a tiny stdio MCP proxy (`@aim/tools-mcp`), and the browser extension connects to the Hub over a local WebSocket.

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

Packages: `shared` (types, protocol, tool catalogue, payment guard), `core` (chat service, CLI bridge, orchestrator, self-healer, learning), `tools-mcp` (stdio MCP to WebSocket proxy), `extension` (Manifest V3 extension for Edge and Chrome), `desktop` (Electron main, preload and React renderer). See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design.

## Requirements

- **Windows 10 or 11** (primary target). macOS and Linux builds are produced on a best-effort basis; see [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) for platform permissions.
- **Node.js 20 or newer** and **pnpm** (only when building from source).
- **Claude Code CLI**, installed and signed in. A Claude Pro or Max subscription, or a Console (API) login made through the CLI itself, both work. A.I.M. never asks for an API key.
- **Microsoft Edge or Google Chrome** for browser automation (the extension is loaded unpacked; see [docs/EXTENSION.md](docs/EXTENSION.md)).

## Quick start

1. Install the Claude Code CLI and sign in:
   ```powershell
   npm install -g @anthropic-ai/claude-code      # or: irm https://claude.ai/install.ps1 | iex
   claude                                        # follow the login prompt once
   ```
   `scripts/check-claude-cli.ps1` (or `.sh`) confirms the CLI is found and logged in.
2. Install A.I.M.: run `AIM-Setup-<version>.exe` from the releases page, or from a source checkout:
   ```powershell
   pnpm install
   .\scripts\dev.ps1          # builds the packages and starts the app in development mode
   ```
3. Pair the browser extension: open Settings in A.I.M., copy the pairing token, load the extension unpacked in Edge or Chrome (`scripts/install-extension.ps1` opens the right pages) and paste the token. See [docs/INSTALL.md](docs/INSTALL.md) and [docs/EXTENSION.md](docs/EXTENSION.md).
4. Start a chat. Describe the outcome you want; A.I.M. plans the steps, shows them on the progress ring and reports back. Press `Ctrl+Shift+A` at any time to show or hide the window.

Packaging: `pnpm dist:win` builds the NSIS installer and a portable executable into `packages/desktop/release/` (Windows host required; see `scripts/package-win.ps1`).

## Self-updating

A.I.M. updates itself from GitHub Releases. Push the repository to GitHub, run `scripts/release.sh 0.2.0` (or the PowerShell equivalent), and the Release workflow builds the installers and publishes them with auto-update metadata. Installed copies check on launch and every six hours, download in the background and install on quit or on demand from Settings → Updates. See [docs/UPDATES.md](docs/UPDATES.md).

## The payment limit

A.I.M. blocks any action that would complete a purchase or payment: navigating into checkout or payment pages, clicking buttons labelled as pay, buy, place order or subscribe, typing into card, CVC or IBAN fields, and typing anything that looks like a card number. The guard runs twice — in the Hub before a tool executes, and again inside the browser extension before an event is dispatched — and it cannot be switched off. When it fires, A.I.M. tells you where it stopped so you can finish by hand.

## Privacy

Everything A.I.M. stores lives on your machine, in the application data directory: chats, memories, behaviour samples, goals and settings in SQLite, logs in `logs/aim.log`. The only network conversations are those made by the Claude Code CLI you installed, under your own login. The Hub listens on `127.0.0.1` only, and both the MCP proxy and the browser extension must present a token to connect. A.I.M. has no telemetry or analytics; the only other network request is the periodic update check against GitHub Releases, which can be turned off in Settings → Updates. See [docs/SECURITY.md](docs/SECURITY.md) for the threat model.

## Documentation

- [docs/INSTALL.md](docs/INSTALL.md) — installation, from the CLI to the paired extension
- [docs/EXTENSION.md](docs/EXTENSION.md) — loading and pairing the browser extension
- [docs/USAGE.md](docs/USAGE.md) — chats, progress ring, agents, goals, memory, settings, shortcuts
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — common problems and their fixes
- [docs/UPDATES.md](docs/UPDATES.md) — self-updating from GitHub Releases
- [docs/SECURITY.md](docs/SECURITY.md) — threat model and recommendations
- [docs/CORE_API.md](docs/CORE_API.md) — the `@aim/core` contract for contributors

## Development

```bash
pnpm install
pnpm build            # shared → core → tools-mcp → extension → desktop
pnpm dev              # electron-vite dev server with hot reload
pnpm test             # vitest across all packages
pnpm icons            # regenerate assets/icons and packages/desktop/build from the vector mark
```

### Verification

```bash
pnpm typecheck
pnpm test
```

The suite covers every package (shared contracts, core engine, learning layer, tools proxy, Electron main, renderer logic and the extension). The extension additionally has a Playwright end-to-end test (`node packages/extension/test/e2e.mjs`) that loads the built extension into Chromium against a fake Hub, and the Electron app has been driven end to end with a stand-in Claude CLI that spawns the real MCP proxy: tasks set through tools move the progress ring, a simulated CLI crash is repaired automatically, memories and goal plans are persisted, and payment URLs are refused.

## License

MIT. See [LICENSE](LICENSE).

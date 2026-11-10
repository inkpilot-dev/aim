# Using A.I.M.

This guide covers the desktop application from the user's side. For installation see [INSTALL.md](INSTALL.md); for the browser extension see [EXTENSION.md](EXTENSION.md).

## The window and the tray

A.I.M. lives in the system tray (the teal pointer icon) and opens as a single window. `Ctrl+Shift+A` shows or hides it from anywhere; the shortcut can be changed in Settings. Closing the window keeps A.I.M. running in the tray so that scheduled goals, the behaviour observer and the browser connection continue. Quit from the tray menu.

## Chats

A chat is a conversation with a goal. Create one with **New chat**, type what you want done and press Enter (Shift+Enter inserts a line break). You can attach screenshots or files, which are passed to the model with your message.

Each chat has its own:

- **working directory** — the folder the CLI treats as the project; set a default in Settings and override per chat,
- **model** and **effort** — passed straight to the CLI; leave them blank for the CLI's defaults,
- **session** — A.I.M. keeps the CLI session so follow-up messages carry the full context.

Responses stream in as they are produced. Tool activity (screen captures, clicks, browser actions, memory operations) is shown inline in a compact form so you can see what A.I.M. is doing, including the results it received. Thinking blocks are hidden by default and can be shown from Settings.

Chats can be renamed, archived, searched (full-text across messages) and deleted. After a turn completes, A.I.M. proposes a title and extracts memories from the conversation if reflection is enabled.

## The progress ring

For anything that takes more than one step, A.I.M. first writes a task list and keeps it updated as it works. The ring in the chat header fills as tasks complete; expanding it shows every task with its state (pending, in progress, done, failed, skipped). The same list is what the sub-agents report against, so the ring is a reliable picture of where a long job stands.

## Agents

Larger jobs are split across specialised sub-agents that run inside the same CLI session, in parallel where possible:

| Agent | Role |
|---|---|
| planner | Breaks the request into tasks and decides the order. |
| browser_operator | Works in Edge or Chrome through the extension. |
| desktop_operator | Works with the screen, mouse and keyboard. |
| researcher | Reads and summarises sources. |
| coder | Writes and edits code and files. |
| verifier | Checks results against the original request before A.I.M. reports back. |

The **Agents** panel lists active agents, what each is doing and which task it is on. For very large jobs A.I.M. may launch worker chats — separate CLI processes whose results are fed back into the parent chat; they appear as linked chats. The maximum number of parallel agents is set in Settings (default 4).

## Asking you questions and notifications

When A.I.M. needs a decision, a password you have not provided, or hits the payment limit, it asks in the chat and, if the window is hidden, raises a system notification. Tasks wait until you answer. Routine progress is not pushed as notifications unless you enable it.

## Directives and goals

**Directives** are standing instructions: "Keep my inbox at zero every morning", "Never touch the finance spreadsheet", "Prefer Edge over Chrome". They are stored locally and included in every planning prompt. Manage them in the **Goals** view; each can be active or paused.

Every day at the configured time (default 08:00, also on launch if the day's plan is missing) A.I.M. drafts a **daily plan**: a short list of goals derived from your directives, memories, recent behaviour and yesterday's outcomes. With **Run goals automatically** enabled, each goal becomes a chat that runs in sequence, with the usual progress ring and self-healing; otherwise the plan is shown for you to start goals by hand. Goals can be edited, skipped or marked done, and the outcomes feed the next day's plan.

## Memory

A.I.M. keeps a local memory of facts, preferences, procedures and project details, each with a source (which chat it came from), a confidence and a hit count. The most relevant entries are summarised into every system prompt, so A.I.M. does not need to be told twice. You can:

- ask A.I.M. directly to remember or forget something,
- browse, search, edit and delete entries in the **Memory** view,
- turn off automatic extraction (reflection) in Settings while keeping manual memories.

Memory is a SQLite database in the application data directory and never leaves the machine.

## Behaviour observer

With the observer enabled, A.I.M. samples the active window title and application every five seconds and, through the extension, notes which sites you visit. The samples are reduced to a summary — top applications and sites, active hours, recurring routines — that helps planning and lets A.I.M. avoid interrupting you (for example by preferring background browser work while you are typing in another application). The raw samples are local, viewable and deletable in Settings, and the observer can be switched off entirely.

## Desktop control and the teal cursor

When A.I.M. uses the mouse or keyboard, the real pointer has to move; the operating system offers no alternative. To make this unmistakable, A.I.M. draws its teal cursor on top of the screen for the duration of each action. Moving your own mouse while A.I.M. is acting can interfere with the step; if it does, A.I.M. detects the failed step and retries or asks. The system prompt tells A.I.M. to prefer browser tools, which do not touch the pointer, whenever you are active in another application.

## Self-healing

If a tool fails or the CLI process stops mid-turn, A.I.M. retries with the error context — up to the configured number of attempts (default 3) — before asking you. Each attempt is visible in the chat as a self-heal step, so nothing happens silently.

## Settings

| Group | Options |
|---|---|
| Claude CLI | Executable path (auto-detected), model, effort, per-turn budget cap in USD. |
| Workspace | Default working directory, additional directories the CLI may access, preferred browser. |
| Hub | Port (default 47821), pairing token with regenerate. |
| Appearance | Theme (dark, light, system), cursor colour, show thinking. |
| Behaviour | Launch at login, start minimized, global shortcut, desktop cursor overlay. |
| Learning | Reflection, behaviour observer, daily goals time, run goals automatically. |
| Orchestration | Maximum parallel agents, maximum self-heal attempts. |
| Policy | Payment guard — displayed for reference; it cannot be disabled. |

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+A` (global, configurable) | Show or hide the A.I.M. window |
| `Enter` | Send the message |
| `Shift+Enter` | New line in the message |
| `Esc` | Stop the current turn |

Additional shortcuts are listed in the application's Settings.

## Tool activity

By default each run of tool calls inside a reply is collapsed into one line such as "Worked · 6 steps · 7.4s" (with a count of failed steps when any). Click the line to expand it, or use "Show work" in the top bar to see every tool call inline. Settings → Tool activity offers three modes: one line per run (default), show every call, or hide completely (only a small "Working" indicator while A.I.M. is busy). Replies type out smoothly as they stream.

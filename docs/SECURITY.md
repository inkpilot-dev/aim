# Security

This document describes what A.I.M. can do on your machine, what it is prevented from doing, how its components trust each other, and what we recommend. Read it before granting A.I.M. standing directives or automatic goal execution.

## Threat model

### What A.I.M. is

A.I.M. is an autonomous agent that runs **with your privileges**: whatever your user account can read, write, launch, click or type, A.I.M. can too. It drives the Claude Code CLI with `--permission-mode bypassPermissions` and `--dangerously-skip-permissions` **by design**: the point of A.I.M. is to complete work without stopping at every step, so the CLI's interactive permission prompts are turned off and A.I.M.'s own safeguards (the payment guard, task tracking, self-healing with a bounded number of attempts, and `ask_user` for genuine decisions) take their place.

Consequences you should accept before using it:

- A.I.M. can read, modify and delete files in the working directory of a chat and in any additional directory you allow, and can run commands through the CLI's tools.
- It can operate any application that is visible on your desktop, including ones holding sensitive data, while a chat or an automatic goal is running.
- It can browse as you, in your logged-in browser profile, through the extension.
- Instructions found in web pages, documents or application windows (prompt injection) can mislead the model. A.I.M.'s system prompt tells it to treat such content as data, and the payment guard holds regardless, but no agent is immune.

### What A.I.M. is not

- It is not a remote-control service. The Hub listens on `127.0.0.1` only; nothing on the network can reach it.
- It is not a telemetry source. There is no analytics, crash reporting, update check or "phone home" of any kind. The only network traffic originates from the Claude Code CLI you installed, under your own login, as governed by Anthropic's terms for that login.
- It does not hold your API key. A.I.M. has no field for one and never reads the CLI's credential files; it only launches the CLI.

### Assets and adversaries considered

| Asset | Protected against |
|---|---|
| Your money | Automated purchases and payments, including via prompt injection — the payment guard. |
| Your local Hub | Other local processes or web pages connecting to it — token-authenticated local-only sockets. |
| Your data | Leaving the machine other than through the CLI — local storage, no telemetry. |
| Your attention | Silent actions — visible teal cursor, inline tool log, notifications on questions. |

Not in scope: a malicious local user or malware already running under your account (it has the same rights A.I.M. has); compromise of the Claude Code CLI or the model service itself; the browser's own security.

## The payment guard

The guard is implemented once, in `@aim/shared`, and applied in two places:

1. **In the Hub**, before any `browser_click`, `browser_type`, `browser_navigate`, `browser_open_tab` or `keyboard_type` call executes.
2. **In the extension's content script**, before a click, keystroke or navigation is dispatched — so a Hub bug cannot bypass it.

It refuses: navigation to checkout, payment, billing and subscription URLs; clicks on controls whose label reads as pay, buy, purchase, place order, checkout, subscribe, confirm payment, donate or similar; typing into fields identified as card number, expiry, CVC/CVV, IBAN or `autocomplete="cc-*"`; and typing text that contains a Luhn-valid card number anywhere, in any tool. A blocked call returns a policy error to the model with the message:

> Blocked by A.I.M. policy: payments and purchases are never performed automatically. I can take you to the point before payment and hand over.

The guard has no setting. It is shown in Settings as always on for transparency only.

Limits of the guard: it is a pattern-based control. It will stop ordinary and most obfuscated checkout flows; it cannot know the semantics of every button on every site, and it does not detect payments made by other means (for example telling a desktop application to place an order by keyboard shortcuts that do not involve typing card data). Keep payment methods in your browser behind a password or biometric prompt, and do not store cards in sites you let A.I.M. operate.

## Local sockets and tokens

The Hub serves two WebSocket paths on `127.0.0.1:47821` (port configurable):

- `/aim/tools` — the MCP proxy that the Claude CLI spawns for each chat. It authenticates with a token passed in the process environment (`AIM_HUB_TOKEN`) and identifies its chat (`AIM_CHAT_ID`).
- `/aim/ext` — the browser extension, which authenticates with the pairing token you copy from Settings.

Connections that do not present a valid token in their first message are closed. Because the Hub binds to the loopback interface only, the remaining risk is a local process or a web page attempting to connect; web pages cannot complete the handshake without the token, and the extension's own origin is checked. Regenerate the pairing token from Settings if you suspect it has been copied.

The MCP proxy is stateless and contains no logic beyond forwarding; all tool implementations live in the Hub.

## Data at rest

Everything is stored in the application data directory: SQLite databases for chats, messages, tasks, agents, memories, behaviour samples, directives and plans; JSON settings; and `logs/aim.log`. Files are protected only by your account's file permissions — they are not encrypted by A.I.M. Memories and behaviour samples can be reviewed and deleted from the application. Deleting the directory removes all data.

The CLI keeps its own session transcripts under `~/.claude` according to its own rules; A.I.M. does not manage them.

## Recommendations

1. **Use a dedicated browser profile** for A.I.M.'s extension, signed in only to the accounts the agent should reach, with no saved payment methods.
2. **Scope working directories.** Point chats at project folders, not your home directory, and be deliberate about "additional directories".
3. **Review directives and automatic goals.** Goals run without you watching; keep directives specific and leave "Run goals automatically" off until you are comfortable with the plans A.I.M. produces.
4. **Keep the behaviour observer in mind.** It records window titles and visited URLs locally. Disable it, or clear its samples, when working with material that should not be summarised into prompts.
5. **Lock the machine** when you step away during a long job; A.I.M. stops when it needs you and cannot unlock the session.
6. **Keep the CLI current.** `npm update -g @anthropic-ai/claude-code` or the native installer's update. A.I.M. inherits the CLI's security fixes.
7. **Build from source if you need assurance.** The installer is unsigned; `scripts/package-win.ps1` produces an identical artifact from the repository you can audit.

## Reporting

Report vulnerabilities privately to the maintainers through the repository's security contact rather than in a public issue. Include the A.I.M. version, platform, and steps to reproduce.

## Updates

The updater contacts `api.github.com` and `github.com` release assets only, over HTTPS, for the repository configured at build time or in Settings. Downloaded installers are verified against the SHA-512 recorded in the release's `latest.yml` before they are launched. Releases are unsigned unless you add a code-signing certificate to the release workflow; on Windows this means a SmartScreen prompt on first install, and on macOS Gatekeeper requires a signed and notarised build for automatic installation. Turning off "Automatic updates" in Settings stops all update traffic.

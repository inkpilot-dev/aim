# Troubleshooting

Logs are written to `logs/aim.log` in the application data directory (`%APPDATA%\A.I.M.` on Windows, `~/Library/Application Support/A.I.M.` on macOS, `~/.config/A.I.M.` on Linux). Most problems below leave a clear line there.

## "Claude CLI not found"

A.I.M. looks for `claude` on `PATH` and in the usual install locations (`%APPDATA%\npm`, `%USERPROFILE%\.local\bin`, `~/.local/bin`, `~/.claude/local`, `/opt/homebrew/bin`, `/usr/local/bin`).

1. Run `claude --version` in a **new** terminal. If it fails, install the CLI:
   ```
   npm install -g @anthropic-ai/claude-code
   ```
   or, on Windows, `irm https://claude.ai/install.ps1 | iex`.
2. If the terminal finds it but A.I.M. does not (typical when A.I.M. was started from a shortcut before `PATH` was updated), restart A.I.M., or set the full path to the executable in **Settings → Claude CLI**.
3. `scripts\check-claude-cli.ps1` / `scripts/check-claude-cli.sh` reproduces A.I.M.'s detection and prints what it found.

## "Not logged in" or the first message fails immediately

The CLI has no active login. Run `claude` in a terminal and complete the sign-in (`claude auth login` on recent versions). A.I.M. will not ask for an API key; if you want to use one, configure it for the CLI (`ANTHROPIC_API_KEY`). After signing in, start a new turn — no restart of A.I.M. is required.

If the message fails with a rate-limit or usage message, that is the CLI reporting your subscription's limits; A.I.M. shows the CLI's text verbatim.

## Browser extension shows "Disconnected"

Check, in order:

1. A.I.M. is running (tray icon present). The extension reconnects automatically within a few seconds of A.I.M. starting.
2. The token in the extension matches the one shown in **Settings → Hub**. Regenerating the token in A.I.M. requires pasting the new one into the extension.
3. The port matches (default `47821`).
4. The extension is enabled on `edge://extensions` or `chrome://extensions` and was not disabled by the "developer mode extensions" prompt. Click **Reload** on its card.
5. Edge's "startup boost" or "continue running background extensions" settings do not matter for the connection but may keep an old copy of the extension alive after an update; reload it.

Browser tool calls made while disconnected return an explicit error to A.I.M., which will try once to launch the preferred browser and otherwise asks you to check the extension.

## "Port in use" when A.I.M. starts

Another process, or a previous A.I.M. instance that did not exit, is listening on the Hub port.

- Windows: `netstat -ano | findstr :47821` shows the PID; end it in Task Manager, or
- change the port in **Settings → Hub** (the extension must be given the new port too).

A.I.M. is single-instance: launching it again brings the existing window forward instead of starting a second Hub.

## Native module errors on start

Messages such as `The module ... was compiled against a different Node.js version`, `Could not locate the bindings file`, or errors mentioning `better_sqlite3.node` or `libnut` mean the native modules were not built for the bundled Electron.

For the database this is not fatal: when `better-sqlite3` cannot be loaded, A.I.M. logs a warning and switches to the SQLite engine built into the Electron runtime (`node:sqlite`), so chats, memory and goals keep working. Mouse and keyboard tools do depend on `libnut`, so rebuild the native modules as described below to restore them.

From a source checkout, rebuild them:

```
pnpm --filter @aim/desktop exec electron-builder install-app-deps
```

This runs automatically on `pnpm install` (postinstall) but must be repeated after changing the Electron version or switching Node versions. A C++ toolchain is required: Visual Studio Build Tools ("Desktop development with C++") and Python 3 on Windows; Xcode command line tools on macOS; `build-essential python3 libxtst-dev libpng++-dev libx11-dev libxkbfile-dev` on Debian/Ubuntu.

In a packaged build this error indicates a broken installation; reinstall from the installer.

## Windows SmartScreen or antivirus blocks the installer

The installer is not code-signed, so SmartScreen shows "Windows protected your PC" on first run. Click **More info**, then **Run anyway**. Some antivirus products quarantine unsigned Electron installers or the `libnut` input module because it simulates keyboard and mouse events; add an exclusion for the installation directory (`%LOCALAPPDATA%\Programs\A.I.M.`) or build from source with `scripts\package-win.ps1` to produce your own copy. The portable executable triggers the same checks.

## Screen capture or input does nothing on macOS

macOS requires explicit permissions, requested on first use:

- **Screen Recording** (System Settings → Privacy & Security → Screen Recording) for `screen_capture`; without it captures return a black image.
- **Accessibility** (Privacy & Security → Accessibility) for mouse and keyboard control.
- **Automation** prompts may appear when A.I.M. launches or focuses applications.

After granting a permission, quit and restart A.I.M.; macOS applies them at process start. Unsigned builds lose these grants when the application is updated and must be re-approved.

## Linux: input or window tools fail

Desktop input and active-window detection rely on X11 (`libxtst`, `libxkbfile`). On Wayland sessions, global input simulation is restricted by the compositor; run under an X11 session or use XWayland-compatible applications. Screen capture under Wayland uses the portal and may prompt each time.

## The teal cursor is not shown in the browser

The in-page cursor is drawn only while the tab is visible (`document.visibilityState === 'visible'`). Switch to the tab A.I.M. is working in. If the tab is visible and nothing appears, the page may block injected content (some browser-internal and store pages do); A.I.M. still acts, without the visual.

## Chats or memories are missing after an update

Data lives in the application data directory and is migrated forward automatically. If the database was moved or the directory was cleaned, A.I.M. starts empty. Check `logs/aim.log` for migration errors; restoring the `aim.db` file (and its `-wal` / `-shm` companions) restores everything.

## Collecting diagnostics

Attach the following when reporting a problem: the A.I.M. version (Settings → About), `claude --version`, the operating system version, the last 200 lines of `logs/aim.log`, and, for extension problems, the service worker console from the extension card ("Inspect views: service worker").

## Updates

See [UPDATES.md](UPDATES.md) for the update flow and its error messages. In short: updates only apply to installed releases (not `pnpm dev`), the repository must contain a release produced by the Release workflow, and private repositories need a token in Settings → Updates.

## "Error: Electron uninstall" when starting `pnpm dev`

pnpm 10 and newer block package install scripts unless they are approved, so the `electron` package can be present without its downloaded executable. `pnpm dev` and `pnpm build` now run `scripts/ensure-electron.mjs`, which downloads it when missing. To do it by hand: `node node_modules/electron/install.js`, or run `pnpm approve-builds`, select `electron`, `better-sqlite3` and `@nut-tree-fork/libnut-win32`, then `pnpm install` again.

# Installing A.I.M.

A.I.M. consists of three parts that are set up in order: the Claude Code CLI (which A.I.M. drives), the desktop application, and the browser extension. Windows 10/11 is the primary platform; macOS and Linux notes are included where they differ.

## 1. Install the Claude Code CLI

A.I.M. does not contain a model client of its own. Every request goes through the `claude` command-line tool, so it must be installed first.

Windows (PowerShell), either of:

```powershell
npm install -g @anthropic-ai/claude-code
```

```powershell
irm https://claude.ai/install.ps1 | iex
```

macOS / Linux:

```bash
npm install -g @anthropic-ai/claude-code
# or
curl -fsSL https://claude.ai/install.sh | bash
```

Confirm the installation:

```
claude --version
```

If the command is not found after installing with npm, open a new terminal so the updated `PATH` is picked up. On Windows the npm global directory is `%APPDATA%\npm`; the native installer places the binary under `%USERPROFILE%\.local\bin`.

## 2. Sign in

Run `claude` once in a terminal and follow the prompt. Two kinds of login are accepted:

- a Claude **Pro or Max** subscription (browser sign-in), or
- an Anthropic **Console** account (also a browser sign-in; usage is billed to that account).

A.I.M. never asks for an API key and provides no field for one. If you prefer to use an API key with the CLI, configure it for the CLI itself (for example through the `ANTHROPIC_API_KEY` environment variable); A.I.M. simply inherits whatever the CLI is configured to use.

Verify both steps with the bundled check:

```powershell
.\scripts\check-claude-cli.ps1     # Windows
./scripts/check-claude-cli.sh      # macOS / Linux
```

It prints the CLI path and version and whether a login was detected.

## 3. Install the desktop application

### Option A — installer (Windows)

1. Download `AIM-Setup-<version>.exe` (or `AIM-Portable-<version>.exe` if you prefer no installation).
2. Run the installer. It installs per user (no administrator rights), lets you choose the directory and creates a desktop and Start Menu shortcut named "A.I.M.".
3. The installer is not code-signed. Windows SmartScreen will show "Windows protected your PC": choose **More info**, then **Run anyway**. See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) if your antivirus quarantines the file.

The application installs to `%LOCALAPPDATA%\Programs\A.I.M.`. The extension files are placed in `resources\extension` inside that directory.

### Option B — from source (all platforms)

Prerequisites: Node.js 20 or newer, pnpm (`npm install -g pnpm` or `corepack enable`), and a C++ toolchain for the native modules (Windows: Visual Studio Build Tools with "Desktop development with C++" and Python 3; macOS: Xcode command line tools; Debian/Ubuntu: `build-essential python3 libxtst-dev libpng++-dev libx11-dev libxkbfile-dev`).

```powershell
git clone <repository-url> aim
cd aim
.\scripts\dev.ps1        # Windows
./scripts/dev.sh         # macOS / Linux
```

The script installs dependencies, builds `shared`, `core`, `tools-mcp` and the extension, generates the icons if needed, checks the CLI and starts the application with hot reload. The extension folder in this mode is `packages/extension/dist`.

To produce the Windows installer yourself, run `.\scripts\package-win.ps1` on a Windows machine. Artifacts appear in `packages/desktop/release/`.

### First launch

On first launch A.I.M.:

- detects the `claude` executable (override the path in Settings if it is installed somewhere unusual),
- generates the **pairing token** the browser extension will need,
- starts the local Hub on `127.0.0.1:47821` (configurable),
- registers the global shortcut `Ctrl+Shift+A` to show or hide the window.

## 4. Pair the browser extension

Browser automation requires the A.I.M. extension in Microsoft Edge or Google Chrome. It is loaded as an unpacked extension — browsers do not permit a program to install one silently.

1. In A.I.M., open **Settings** and copy the pairing token.
2. Run `.\scripts\install-extension.ps1` (add `-Browser chrome` for Chrome). It opens the extensions page, opens the extension folder in Explorer and prints the remaining steps. Alternatively, follow [EXTENSION.md](EXTENSION.md) by hand.
3. In the browser, enable Developer mode, choose **Load unpacked**, select the folder, then open the extension and paste the token.
4. Back in A.I.M., the browser status indicator shows the extension as connected. A quick test: ask A.I.M. to "open example.com in a new tab and tell me the page title".

## 5. Optional settings

Settings worth reviewing after installation:

- **Launch at login** and **Start minimized** (tray).
- **Default working directory** for chats, and additional directories the CLI may access.
- **Model** and **effort**; both are passed straight to the CLI.
- **Per-turn budget cap** in USD (only relevant for Console logins).
- **Daily goals** time and whether planned goals run automatically.
- **Behaviour observer** and **post-turn reflection**, both on by default and both local.

## Uninstalling

Windows: use "Apps & features" or the uninstaller in the installation directory. Application data (chats, memories, logs) is kept in `%APPDATA%\A.I.M.`; delete that directory to remove everything. Remove the extension from the browser's extensions page.

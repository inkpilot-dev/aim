# Self-updating from GitHub

A.I.M. keeps itself current through GitHub Releases. The desktop app embeds `electron-updater`; each release carries a small metadata file (`latest.yml`) next to the installer, and the running app compares that with its own version, downloads the new installer in the background and installs it when you quit (or immediately from Settings).

## One-time setup

1. Push this repository to GitHub (public or private). The repository name and owner are read from the git remote when the installers are built, so nothing has to be hard-coded.
2. Keep the `Release` workflow (`.github/workflows/release.yml`). It needs no secrets beyond the default `GITHUB_TOKEN`, which has permission to create releases in the same repository.
3. Install A.I.M. from a published release at least once. Builds made with `pnpm dev` or a locally produced installer have no release to compare against; the Settings page shows "Development build" or an explanation in that case.

## Cutting a release

```bash
scripts/release.sh 0.2.0
```

```powershell
.\scripts\release.ps1 0.2.0
```

The script bumps `packages/desktop/package.json`, commits, tags `v0.2.0` and pushes. GitHub Actions then builds the Windows installer and portable build (and a Linux AppImage), runs the tests, and attaches everything to a release named after the tag together with `latest.yml` and the blockmap files that enable differential downloads. The job refuses to run if the tag does not match the package version.

## What users see

* On launch (after 30 seconds) and then every 6 hours, A.I.M. checks the newest release. The interval is configurable in Settings → Updates.
* If a newer version exists and "Download automatically" is on, it downloads in the background and a notice appears: "A.I.M. x.y.z is ready to install". The sidebar shows an "Update ready" pill.
* The update installs when the app quits, or immediately through Settings → Updates → "Restart and update". Chats, memories, goals and settings live in the application data folder and are untouched by updates.
* The bundled browser extension is updated together with the app. Edge and Chrome re-read an unpacked extension from disk when the browser restarts; if the extension's permissions change in a release, the browser asks you to accept them.

## Running from source

A copy started with `pnpm dev` cannot replace itself, so it does not auto-update. It still checks GitHub: Settings → Updates shows "Running from source" and, when a newer release exists, a "Download installer" button that opens the release page. Install that once and the installed copy updates itself from then on.

## Settings reference

| Setting | Meaning |
| --- | --- |
| Automatic updates | Master switch for scheduled checks. "Check now" always works while the app is a packaged build. |
| Download automatically | Download in the background. Off = you are told an update exists and download it manually. |
| Check every (hours) | Schedule interval, 1 to 168. |
| GitHub repository | `owner/repo` or a GitHub URL. Leave empty to use the repository the build was published from. Use this to follow a fork. |
| Include pre-releases | Also install releases marked as pre-release. |
| Access token | Only for private repositories. A fine-grained token with read access to the repository's contents is enough. It is stored in `settings.json` in the application data folder and sent only to GitHub. |

## Private repositories

GitHub does not serve release assets of private repositories anonymously. Either make the repository (or a separate releases-only repository) public, or give each installation a token in Settings → Updates. A dedicated public repository that holds only releases is the simplest arrangement: point `updatesRepo` at it and run the release workflow from the private source repository with a `GH_TOKEN` secret that can write to the public one.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| "Development build — updates apply to installed releases only." | You are running `pnpm dev` or an unpackaged build. Install a release. |
| "No GitHub repository configured for updates." | The build was made outside a git checkout with an `origin` remote and Settings has no repository. Enter `owner/repo` in Settings → Updates. |
| "No release with update metadata (latest.yml) was found" | The repository has no release produced by the Release workflow yet, or the release is a draft. Run `scripts/release.sh`. |
| "GitHub refused the request" | Private repository without a token, an expired token, or the unauthenticated rate limit. Add or renew the token. |
| Update downloaded but never installs | Quit A.I.M. fully (tray icon → Quit) or use "Restart and update". Antivirus software may quarantine the downloaded installer; allow `%LOCALAPPDATA%\@aimdesktop-updater` (the updater download cache). |
| Windows SmartScreen warns about the installer | Releases are unsigned unless you add code-signing certificates to the workflow (`CSC_LINK` / `CSC_KEY_PASSWORD`). |

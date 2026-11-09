#!/usr/bin/env bash
# A.I.M. development bootstrap (macOS / Linux / Git Bash).
# Installs dependencies, builds the library packages the Electron app imports, then starts
# the desktop app in development mode (electron-vite dev with hot reload).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

need() { command -v "$1" >/dev/null 2>&1 || { echo "error: '$1' is required but was not found on PATH." >&2; exit 1; }; }
need node

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "error: Node.js 20 or newer is required (found $(node --version))." >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1; then
    echo "pnpm not found; enabling it through corepack."
    corepack enable
  else
    echo "error: pnpm is required. Install it with 'npm install -g pnpm' or enable corepack." >&2
    exit 1
  fi
fi

echo "== Installing dependencies"
pnpm install

echo "== Building shared, core, tools-mcp and the browser extension"
pnpm build:shared
pnpm build:core
pnpm build:tools-mcp
pnpm build:extension

if [ ! -f assets/icons/icon.png ]; then
  echo "== Generating icons"
  node scripts/generate-icons.mjs
fi

echo "== Checking the Claude Code CLI (non-fatal)"
bash scripts/check-claude-cli.sh || echo "warning: fix the Claude CLI before starting a chat; the app will still launch."

echo "== Starting A.I.M. in development mode"
exec pnpm dev

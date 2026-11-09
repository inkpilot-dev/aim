#!/usr/bin/env bash
# Full build: dependencies, icons, every package, typecheck and tests.
# Usage: scripts/build-all.sh [--dist]      (--dist also runs electron-builder for the host OS)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DIST=0
for arg in "$@"; do
  case "$arg" in
    --dist) DIST=1 ;;
    -h|--help) echo "usage: $0 [--dist]"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

command -v pnpm >/dev/null 2>&1 || { echo "error: pnpm is required." >&2; exit 1; }

echo "== pnpm install"
if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile || pnpm install; else pnpm install; fi

echo "== icons"
node scripts/generate-icons.mjs

echo "== build (shared → core → tools-mcp → extension → desktop)"
pnpm build

echo "== typecheck"
pnpm typecheck

echo "== test"
pnpm test

if [ "$DIST" = "1" ]; then
  echo "== electron-builder (host platform)"
  pnpm --filter @aim/desktop dist
  echo "Artifacts: packages/desktop/release/"
  ls -1 packages/desktop/release 2>/dev/null || true
fi

echo "Build complete."

#!/usr/bin/env bash
# Cut a release: bump packages/desktop version, commit, tag vX.Y.Z and push.
# The Release workflow (.github/workflows/release.yml) then builds and publishes the installers
# and auto-update metadata to GitHub Releases, which running copies of A.I.M. pick up automatically.
#
# Usage: scripts/release.sh 0.2.0 [--no-push]
set -euo pipefail
VERSION="${1:-}"
if [[ -z "$VERSION" || ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]]; then
  echo "usage: scripts/release.sh <semver, e.g. 0.2.0> [--no-push]" >&2
  exit 1
fi
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is not clean. Commit or stash first." >&2
  exit 1
fi
if ! git remote get-url origin >/dev/null 2>&1; then
  echo "No 'origin' remote. Push this repository to GitHub first (see docs/UPDATES.md)." >&2
  exit 1
fi
node -e "
const fs=require('fs');const p='packages/desktop/package.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));
j.version=process.argv[1];fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n');
" "$VERSION"
git add packages/desktop/package.json
git commit -m "release: v$VERSION"
git tag -a "v$VERSION" -m "A.I.M. v$VERSION"
if [[ "${2:-}" != "--no-push" ]]; then
  git push origin HEAD
  git push origin "v$VERSION"
  echo "Pushed v$VERSION. Watch the Release workflow on GitHub; the release appears under Releases when it finishes."
else
  echo "Created commit and tag v$VERSION (not pushed)."
fi

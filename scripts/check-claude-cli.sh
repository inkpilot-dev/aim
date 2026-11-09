#!/usr/bin/env bash
# Verify that the Claude Code CLI is installed and logged in. Exit 0 when ready.
# A.I.M. drives this CLI and never stores an API key itself: the CLI's own login is used.
set -u

ok() { printf '  [ok]   %s\n' "$*"; }
bad() { printf '  [fail] %s\n' "$*" >&2; }

echo "Checking the Claude Code CLI"

CLI=""
if command -v claude >/dev/null 2>&1; then
  CLI="$(command -v claude)"
else
  for c in "$HOME/.local/bin/claude" "$HOME/.claude/local/claude" "/opt/homebrew/bin/claude" "/usr/local/bin/claude"; do
    if [ -x "$c" ]; then CLI="$c"; break; fi
  done
fi

if [ -z "$CLI" ]; then
  bad "'claude' was not found on PATH."
  cat <<'MSG'
  Install it with one of:
    npm install -g @anthropic-ai/claude-code
    curl -fsSL https://claude.ai/install.sh | bash        (native installer, macOS/Linux)
  then run `claude` once and sign in (Pro/Max subscription or Console account).
MSG
  exit 1
fi

VERSION="$("$CLI" --version 2>/dev/null | head -n1 || true)"
if [ -z "$VERSION" ]; then
  bad "'$CLI' exists but '--version' failed."
  exit 1
fi
ok "found $CLI ($VERSION)"

# Login check: newer CLIs have `claude auth status`; otherwise inspect the local config.
LOGGED_IN=0
if STATUS="$("$CLI" auth status 2>/dev/null)"; then
  if printf '%s' "$STATUS" | grep -qiE '"loggedIn":\s*true|logged in|authenticated'; then LOGGED_IN=1; fi
  if printf '%s' "$STATUS" | grep -qiE '"loggedIn":\s*false|not logged in|unauthenticated'; then LOGGED_IN=0; fi
fi
if [ "$LOGGED_IN" = "0" ]; then
  if [ -f "$HOME/.claude.json" ] && grep -qE '"oauthAccount"|"primaryApiKey"' "$HOME/.claude.json" 2>/dev/null; then LOGGED_IN=1; fi
  if [ -f "$HOME/.claude/.credentials.json" ]; then LOGGED_IN=1; fi
  if [ -n "${ANTHROPIC_API_KEY:-}" ]; then LOGGED_IN=1; fi
fi

if [ "$LOGGED_IN" = "1" ]; then
  ok "login detected"
  echo "The CLI is ready. A.I.M. will use this login."
  exit 0
fi

bad "no login detected."
cat <<'MSG'
  Sign in by running `claude` in a terminal and following the prompt (or `claude auth login`
  on recent versions). A Claude Pro/Max subscription or a Console account is accepted.
  A.I.M. does not accept API keys directly; it always uses the CLI's own session.
MSG
exit 2

#!/bin/bash
# =====================================================================
# Awamer Terminal — SessionStart hook
# =====================================================================
# Installs dependencies so tests, typechecks, and builds work in
# Claude Code on the web sessions. Runs synchronously by default so the
# session never races ahead of dependency installation.
# =====================================================================
set -euo pipefail

# Only do work in remote (Claude Code on the web) environments. Local
# sessions already have whatever the developer set up.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

echo "[session-start] Installing backend npm dependencies…"
( cd "$ROOT/backend" && npm install --no-audit --no-fund )

echo "[session-start] Installing desktop npm dependencies…"
( cd "$ROOT/desktop" && npm install --no-audit --no-fund )

# Best-effort: the native libraries needed to compile the Tauri desktop
# crate (`cargo check`, `npm run tauri build`). These require root and a
# healthy apt mirror. If either is missing we WARN and continue — the
# npm-based frontend typecheck/build does not need them, so a failure
# here must not abort the session.
install_tauri_libs() {
  command -v apt-get >/dev/null 2>&1 || return 1
  local sudo_cmd=""
  if [ "$(id -u)" -ne 0 ]; then
    command -v sudo >/dev/null 2>&1 && sudo_cmd="sudo" || return 1
  fi
  $sudo_cmd apt-get update -qq || return 1
  $sudo_cmd apt-get install -y --no-install-recommends \
    build-essential pkg-config \
    libgtk-3-dev libsoup-3.0-dev \
    libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev || return 1
}

echo "[session-start] Attempting Tauri system libraries (best-effort)…"
if install_tauri_libs; then
  echo "[session-start] Tauri system libraries installed."
else
  echo "[session-start] WARN: skipped Tauri system libs (apt offline or unprivileged). Rust/Tauri builds may not work in this session; npm tasks are unaffected."
fi

echo "[session-start] Done."

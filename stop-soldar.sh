#!/usr/bin/env bash
# Stops the Soldar server. Reads the PID file the server writes at
# startup, asks that process to stop, and waits for it to go. Falls back
# to matching the server by its command line when the PID file is missing
# (a server started before PID files existed). Safe to run when Soldar
# is not running: it just says so. Used by the installer (before a
# reinstall) and the uninstaller.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="${SOLDAR_DATA_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/soldar}"
PID_FILE="$DATA_DIR/soldar.pid"

is_soldar_pid() {
  local pid="$1"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  local cmdline
  cmdline="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || echo "")"
  case "$cmdline" in
    *apps/server/dist/index.js*) return 0 ;;
    *) return 1 ;;
  esac
}

stop_pid() {
  local pid="$1"
  kill "$pid" 2>/dev/null || return 0
  # The server finishes a run in flight before it stops (up to 30
  # seconds), so give it a little longer than that before forcing it.
  local i
  for ((i = 0; i < 35; i++)); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 1
  done
  kill -9 "$pid" 2>/dev/null || true
}

main() {
  local pid=""
  if [ -f "$PID_FILE" ]; then
    pid="$(tr -d ' \n\r' < "$PID_FILE" 2>/dev/null || echo "")"
    case "$pid" in ''|*[!0-9]*) pid="" ;; esac
  fi
  if [ -n "$pid" ] && is_soldar_pid "$pid"; then
    echo "Stopping Soldar (process $pid)..."
    stop_pid "$pid"
    rm -f "$PID_FILE"
    echo "Soldar stopped."
    return 0
  fi
  if [ -n "$pid" ]; then
    # A PID file for a process that is not a Soldar server: stale, or
    # the PID was reused. Remove it and fall through to the
    # command-line match.
    rm -f "$PID_FILE"
  fi
  # No PID file (or a stale one): match the server by its command line.
  local found=""
  if command -v pgrep >/dev/null 2>&1; then
    found="$(pgrep -f "apps/server/dist/index.js" 2>/dev/null || true)"
  fi
  if [ -n "$found" ]; then
    echo "Stopping Soldar..."
    local p
    for p in $found; do stop_pid "$p"; done
    echo "Soldar stopped."
    return 0
  fi
  echo "Soldar is not running."
}

main "$@"

#!/usr/bin/env bash
# Soldar launcher — what the desktop icon runs.
#
# Starts the server if it is not already running (one copy only: a second
# click reuses the running server), waits until it answers, then opens the
# app in the default browser. No terminal window.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${SOLDAR_PORT:-5678}"
# The launcher log lives with the rest of Soldar's data, outside the app
# folder, so reinstalling from a new ZIP keeps it. Same location rule as
# the server (see apps/server/src/data-dir.ts); a different file name so
# it never collides with the server's own soldar.log.
DATA_DIR="${SOLDAR_DATA_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/soldar}"
LOG="$DATA_DIR/launcher.log"
mkdir -p "$DATA_DIR" 2>/dev/null || LOG="$APP_DIR/soldar.log"

# A staged update waits here when the user said "Later" to the restart
# prompt (or the app was closed with one staged). Apply it before starting
# the server, so the app opens on the new version. A failed apply leaves
# the old version in place and never blocks the launch.
if [ -f "$DATA_DIR/update/pending-update.json" ] && [ -f "$APP_DIR/scripts/apply-update.sh" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') Applying the pending Soldar update..." >>"$LOG"
  bash "$APP_DIR/scripts/apply-update.sh" "$APP_DIR" "$DATA_DIR" "$PORT" --from-launcher >>"$LOG" 2>&1 || true
fi

resolve_node() {
  # The installer's own copy of Node wins; otherwise use the system one.
  if [ -x "$HOME/.local/soldar/node/bin/node" ]; then
    echo "$HOME/.local/soldar/node/bin/node"
  elif command -v node >/dev/null 2>&1; then
    command -v node
  else
    echo ""
  fi
}

server_healthy() {
  local body
  body="$(curl -fsSL --max-time 3 "http://127.0.0.1:${PORT}/api/health" 2>/dev/null || echo "")"
  case "$body" in
    *'"status":"ok"'*) return 0 ;;
    *) return 1 ;;
  esac
}

show_error() {
  local message="$1"
  echo "$(date '+%Y-%m-%d %H:%M:%S') $message" >>"$LOG"
  if command -v zenity >/dev/null 2>&1; then
    zenity --error --title="Soldar" --text="$message" 2>/dev/null || true
  elif command -v notify-send >/dev/null 2>&1; then
    notify-send "Soldar" "$message" 2>/dev/null || true
  fi
}

NODE="$(resolve_node)"
if [ -z "$NODE" ]; then
  show_error "Soldar could not find Node. Run the installer again (double-click Install Soldar in the Soldar folder)."
  exit 1
fi
if [ ! -f "$APP_DIR/apps/server/dist/index.js" ]; then
  show_error "Soldar is not built yet. Run the installer again (double-click Install Soldar in the Soldar folder)."
  exit 1
fi

# A tab was opened at this time (seconds since the epoch), so a second
# click soon after does not pile up another tab for the same app.
LAST_OPEN_FILE="$DATA_DIR/launcher-last-open"

open_app() {
  if command -v xdg-open >/dev/null 2>&1; then
    nohup xdg-open "http://127.0.0.1:${PORT}" >/dev/null 2>&1 &
    date +%s > "$LAST_OPEN_FILE" 2>/dev/null || true
  else
    show_error "Soldar is running at http://127.0.0.1:${PORT} but no browser opener was found on this computer."
    exit 1
  fi
}

STARTED_BY_ME=0
if ! server_healthy; then
  nohup "$NODE" "$APP_DIR/apps/server/dist/index.js" >>"$LOG" 2>&1 &
  STARTED_BY_ME=1
  ok=0
  # A cold first start on a slow PC can take a while; give it a minute.
  for ((i = 0; i < 60; i++)); do
    if server_healthy; then ok=1; break; fi
    sleep 1
  done
  if [ "$ok" != "1" ]; then
    show_error "Soldar started but did not answer. See $LOG for what it said."
    exit 1
  fi
fi

# The server is up (it was already running, or this launch started it).
if [ "$STARTED_BY_ME" = "1" ]; then
  # A fresh server means a fresh session: open the app.
  open_app
  exit 0
fi
# The server was already running. Opening a tab on every click piles up
# tabs, so skip the new tab if one was opened in the last ten minutes —
# the app is already open. After that, open one again: the old tab was
# probably closed by then.
last_open=0
if [ -f "$LAST_OPEN_FILE" ]; then
  last_open="$(cat "$LAST_OPEN_FILE" 2>/dev/null || echo 0)"
  case "$last_open" in ''|*[!0-9]*) last_open=0 ;; esac
fi
now="$(date +%s)"
if [ "$((now - last_open))" -lt 600 ] && [ "$last_open" != "0" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') Soldar is already running; not opening another tab." >>"$LOG"
  if command -v notify-send >/dev/null 2>&1; then
    notify-send "Soldar" "Soldar is already running. Open http://127.0.0.1:${PORT} in your browser." 2>/dev/null || true
  fi
  exit 0
fi
open_app
exit 0

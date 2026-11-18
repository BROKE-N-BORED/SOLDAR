#!/usr/bin/env bash
# Soldar update applier — installs a staged update and restarts the app.
#
#   apply-update.sh <app-dir> <data-dir> <port> [--from-launcher]
#
# Two callers, one job:
#   - Restart now: the server starts this script detached, then shuts
#     down. The script waits for the server to go quiet, applies the
#     staged update, and relaunches Soldar (which opens the browser).
#   - Next launch: soldar.sh runs it with --from-launcher when a staged
#     update is waiting. The server is not running yet, so there is
#     nothing to wait for, and the launcher starts the app itself.
#
# The staged update lives in <data-dir>/update/: pending-update.json
# (version, zip name, sha256) plus the verified zip. This script checks
# the zip's hash AGAIN before touching anything — the server verified it
# when it downloaded, and the launcher path re-verifies because the file
# has sat on disk since. A hash mismatch means nothing is installed.
#
# Release zips carry a top-level folder (soldar-vX.Y.Z/); the script
# extracts to a staging dir and overlays that folder's contents on the
# app folder. A flat zip (no top-level folder) is accepted too.
#
# Safety: every built output folder (apps/*/dist, packages/*/dist) is
# backed up before the new files land. If the reinstall fails, the backup
# is restored, so the app still runs the old version. Backing up only the
# two app folders is not enough: tsc rebuilds the workspace packages too,
# and an old server build against a half-rebuilt engine crashes on launch
# (proven 2026-11-17: entryToItem missing from the rebuilt engine dist).
# The pending files are removed either way, so a failed update never
# retries in a loop. The database and logs live in the data dir, outside
# the app folder, so replacing the app folder never touches them.
#
# Known limitation: files the new version deleted upstream are not
# removed — the zip is extracted over the old tree. Our releases only add
# or change files, so nothing is left behind in practice.

set -u

APP_DIR="$1"
DATA_DIR="$2"
PORT="$3"
FROM_LAUNCHER=0
if [ "${4:-}" = "--from-launcher" ]; then FROM_LAUNCHER=1; fi

UPDATE_DIR="$DATA_DIR/update"
PENDING="$UPDATE_DIR/pending-update.json"
LOG="$UPDATE_DIR/update.log"
BACKUP_DIR="$UPDATE_DIR/dist-backup"

mkdir -p "$UPDATE_DIR" 2>/dev/null || true

log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >>"$LOG" 2>/dev/null || true
}

show_error() {
  log "ERROR: $1"
  if command -v zenity >/dev/null 2>&1; then
    zenity --error --title="Soldar update" --text="$1" 2>/dev/null || true
  elif command -v notify-send >/dev/null 2>&1; then
    notify-send "Soldar update" "$1" 2>/dev/null || true
  fi
}

cleanup_pending() {
  # Remove the staged files, but keep update.log as the record of what
  # happened.
  rm -f "$PENDING" "$UPDATE_DIR"/soldar-v*.zip "$UPDATE_DIR"/soldar-v*.zip.sha256 2>/dev/null || true
  rm -rf "$BACKUP_DIR" 2>/dev/null || true
}

restore_backup() {
  # Every dist folder backed up below, restored to its own place. The
  # backup keeps the tree's own layout (apps/server/dist, ...), so the
  # restore is a move per folder, no name mapping to get wrong.
  for saved in "$BACKUP_DIR"/apps/*/dist "$BACKUP_DIR"/packages/*/dist; do
    [ -d "$saved" ] || continue
    rel="${saved#"$BACKUP_DIR"/}"
    rm -rf "$APP_DIR/$rel" 2>/dev/null || true
    mv "$saved" "$APP_DIR/$rel" 2>/dev/null || true
  done
}

relaunch() {
  # Only the restart-now path relaunches: the launcher path is already
  # inside a launch, and soldar.sh starts the app itself afterwards.
  if [ "$FROM_LAUNCHER" = "0" ] && [ -x "$APP_DIR/soldar.sh" ]; then
    nohup bash "$APP_DIR/soldar.sh" >/dev/null 2>&1 &
  fi
}

fail() {
  # $1 is the message. Restore the old build, drop the pending update so
  # it never retries in a loop, tell the user, and get the app running
  # again on the old version.
  restore_backup
  cleanup_pending
  show_error "$1"
  relaunch
  exit 1
}

if [ ! -f "$PENDING" ]; then
  log "No pending update found; nothing to do."
  exit 0
fi

# pending-update.json is small, flat JSON the server wrote. Read the three
# fields with sed rather than depending on a JSON tool being installed.
VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$PENDING" | head -n 1)"
ZIP_NAME="$(sed -n 's/.*"zipName"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$PENDING" | head -n 1)"
EXPECTED_SHA="$(sed -n 's/.*"sha256"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$PENDING" | head -n 1)"
if [ -z "$VERSION" ] || [ -z "$ZIP_NAME" ] || [ -z "$EXPECTED_SHA" ]; then
  fail "The staged update is damaged (its details could not be read), so it was thrown away. Soldar is still the old version."
fi
ZIP_PATH="$UPDATE_DIR/$ZIP_NAME"
if [ ! -f "$ZIP_PATH" ]; then
  fail "The staged update file is missing, so the update was thrown away. Soldar is still the old version."
fi

log "Applying Soldar $VERSION."

# Restart-now path: wait for the server to stop answering before touching
# the app folder. The server shuts down right after starting this script,
# so this is normally a second or two; a minute is the limit.
if [ "$FROM_LAUNCHER" = "0" ]; then
  stopped=0
  for ((i = 0; i < 60; i++)); do
    if ! curl -fsSL --max-time 2 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
      stopped=1
      break
    fi
    sleep 1
  done
  if [ "$stopped" != "1" ]; then
    fail "Soldar did not stop, so the update was not applied. Soldar is still the old version."
  fi
fi

# Verify the staged zip again before anything is installed.
if ! command -v sha256sum >/dev/null 2>&1; then
  fail "sha256sum is missing from this computer, so the update could not be verified and was not installed."
fi
ACTUAL_SHA="$(sha256sum "$ZIP_PATH" | awk '{print $1}')"
if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then
  fail "The downloaded update did not match its published checksum, so it was thrown away. Nothing was installed."
fi

# Back up the current build so a failed reinstall can be undone. Every
# dist folder, not just the two app ones (see the header comment).
rm -rf "$BACKUP_DIR" 2>/dev/null || true
mkdir -p "$BACKUP_DIR"
for dist in "$APP_DIR"/apps/*/dist "$APP_DIR"/packages/*/dist; do
  [ -d "$dist" ] || continue
  rel="${dist#"$APP_DIR"/}"
  mkdir -p "$BACKUP_DIR/$(dirname "$rel")"
  cp -r "$dist" "$BACKUP_DIR/$rel"
done

# Lay the new files over the app folder. Release zips carry a top-level
# folder (soldar-vX.Y.Z/); a flat zip is accepted too. Extract to a
# staging dir first so the tree root can be found before anything is
# copied over the running app.
EXTRACT_DIR="$UPDATE_DIR/extract"
rm -rf "$EXTRACT_DIR" 2>/dev/null || true
mkdir -p "$EXTRACT_DIR"
if ! command -v unzip >/dev/null 2>&1; then
  fail "unzip is missing from this computer, so the update could not be installed."
fi
if ! unzip -o -q "$ZIP_PATH" -d "$EXTRACT_DIR" >>"$LOG" 2>&1; then
  fail "The update file could not be unpacked, so the update was not installed. Soldar is still the old version."
fi
TREE_ROOT="$EXTRACT_DIR"
TOP_DIRS="$(find "$EXTRACT_DIR" -mindepth 1 -maxdepth 1 -type d)"
TOP_COUNT="$(printf '%s' "$TOP_DIRS" | grep -c . || true)"
if [ "$TOP_COUNT" = "1" ] && [ -f "$TOP_DIRS/install.sh" ]; then
  TREE_ROOT="$TOP_DIRS"
fi
if [ ! -f "$TREE_ROOT/install.sh" ]; then
  rm -rf "$EXTRACT_DIR" 2>/dev/null || true
  fail "The update file did not contain a Soldar install, so it was not installed."
fi
if ! cp -a "$TREE_ROOT/." "$APP_DIR/" >>"$LOG" 2>&1; then
  rm -rf "$EXTRACT_DIR" 2>/dev/null || true
  fail "The update files could not be copied in, so the update was not installed. Soldar is still the old version."
fi
rm -rf "$EXTRACT_DIR" 2>/dev/null || true

# Reinstall dependencies and rebuild, exactly like a fresh install. The
# installer also refreshes the desktop icon and migrates data (both are
# no-ops when everything is already in place).
log "Rebuilding Soldar $VERSION."
if ! SOLDAR_INSTALL_NONINTERACTIVE=1 bash "$APP_DIR/install.sh" >>"$LOG" 2>&1; then
  fail "Soldar $VERSION could not be built, so the update was rolled back. Soldar is still the old version."
fi

log "Soldar $VERSION installed."
cleanup_pending
relaunch
exit 0

#!/usr/bin/env bash
# End-to-end test of the Soldar installer in a scratch copy with a fake HOME.
#
#   Phase A: Node + pnpm already on PATH (the common case).
#   Phase B: Node hidden from PATH, so the installer downloads its own copy.
#
# Each phase: fresh extract -> install (into the stable home
# ~/.local/soldar/app) -> icon exists and points at the stable launcher ->
# launch -> server answers on its port -> second launch reuses the same
# server process and opens no new tab.
#
# Phase A also checks: the reinstall keeps the data (0.2.0 layout
# migration), the build-only parts were pruned, and the uninstaller
# removes the icons, the app, and (with --remove-data) the data.
#
# Usage: scripts/test-installer.sh [--keep] [--phase A|B]
#   --keep leaves the scratch directory behind for inspection.
#   --phase runs only one phase (A: Node already present; B: Node hidden).
#
# Needs: node + pnpm on PATH for Phase A, curl, tar, pgrep/pkill, and an
# internet connection (both phases download packages into the fake HOME).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEEP=0
ONLY_PHASE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --keep) KEEP=1 ;;
    --phase) ONLY_PHASE="${2:-}"; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

SCRATCH="$(mktemp -d)"
STUB_BIN="$SCRATCH/bin"
XDG_LOG="$SCRATCH/xdg-open.log"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

note() {
  echo ""
  echo "== $1 =="
}

cleanup() {
  # Stop any test server still running, then remove the scratch dir.
  pkill -f "$SCRATCH/.*/apps/server/dist/index.js" 2>/dev/null || true
  sleep 1
  if [ "$KEEP" = "1" ]; then
    echo "Scratch kept at: $SCRATCH"
  else
    rm -rf "$SCRATCH"
  fi
}
trap cleanup EXIT

server_pid() {
  # The PID of the server running from a given extract (empty if none).
  pgrep -f "$1/apps/server/dist/index.js" 2>/dev/null || true
}

port_free() {
  ! curl -fsSL --max-time 2 "http://127.0.0.1:$1/api/health" >/dev/null 2>&1
}

# soldar.sh backgrounds xdg-open and exits, so the stub's write can land
# after the launcher returns; poll instead of grepping once.
wait_for_url() {
  local port="$1"
  local i
  for ((i = 0; i < 20; i++)); do
    if grep -q "http://127.0.0.1:$port" "$XDG_LOG" 2>/dev/null; then return 0; fi
    sleep 0.5
  done
  return 1
}

# Wait until the filesystem accepts a write in the scratch dir (up to 3
# minutes). A busy or snapshotting filesystem can refuse writes for a
# while; starting a phase in the middle of that usually fails the install
# for no reason to do with the installer. If writes are still refused
# after 3 minutes, warn and carry on anyway: the install steps have their
# own retries, and the run may still succeed.
wait_writable() {
  local dir="$1"
  local i
  for ((i = 0; i < 36; i++)); do
    if printf 'ok' > "$dir/.write-probe" 2>/dev/null; then
      rm -f "$dir/.write-probe"
      return 0
    fi
    sleep 5
  done
  echo "WARNING: the filesystem refused writes for 3 minutes. Carrying on anyway; the install steps will retry." >&2
}

fresh_extract() {
  # Copy the repo as a fresh download would look: no node_modules, no
  # build output, no database, no log.
  local dest="$1"
  mkdir -p "$dest"
  # --no-same-owner: the checkout's files may be owned by uid 0 with a
  # group this user cannot chown to, which makes plain tar fail.
  (cd "$REPO_ROOT" && tar --no-same-owner \
    --exclude=node_modules \
    --exclude=dist \
    --exclude=.git \
    --exclude=test-results \
    --exclude='*.tsbuildinfo' \
    --exclude=soldar.db \
    --exclude=soldar.log \
    -cf - .) | (cd "$dest" && tar --no-same-owner -xf -)
}

run_phase() {
  local name="$1"       # A or B
  local port="$2"       # port this phase's server uses
  local path="$3"       # PATH the installer runs with
  local expect_bundled="$4"  # 1 if the installer must download Node

  note "Phase $name: install (port $port)"
  wait_writable "$SCRATCH"
  local fake_home="$SCRATCH/home-$name"
  local extract="$SCRATCH/extract-$name"
  # The installer copies the app here; the icons, the launcher, and the
  # server all live in the stable home, not the extract.
  local stable_app="$fake_home/.local/soldar/app"
  mkdir -p "$fake_home/Desktop" "$fake_home/.local/share/applications"
  fresh_extract "$extract"

  port_free "$port" || fail "Phase $name: port $port is already in use before the install."

  # XDG_CONFIG_HOME is pinned so the server's data dir is under the fake
  # home no matter what the machine running this test has set.
  env HOME="$fake_home" PATH="$path" SOLDAR_INSTALL_NONINTERACTIVE=1 \
    SOLDAR_PORT="$port" XDG_CONFIG_HOME="$fake_home/.config" bash "$extract/install.sh" \
    || fail "Phase $name: install.sh exited non-zero."

  [ -f "$fake_home/.local/share/applications/soldar.desktop" ] \
    || fail "Phase $name: no icon in ~/.local/share/applications."
  [ -f "$fake_home/Desktop/soldar.desktop" ] \
    || fail "Phase $name: no icon on the Desktop."
  grep -q "Exec=\"$stable_app/soldar.sh\"" "$fake_home/Desktop/soldar.desktop" \
    || fail "Phase $name: the desktop icon does not point at the stable launcher."
  [ -x "$fake_home/Desktop/soldar.desktop" ] \
    || fail "Phase $name: the desktop icon is not executable."
  [ -f "$stable_app/apps/server/dist/index.js" ] \
    || fail "Phase $name: the app was not installed into its stable home."

  # The build-only parts were pruned (vitest gone) while the runtime
  # parts stayed (fastify present).
  [ ! -e "$stable_app/node_modules/vitest" ] \
    || fail "Phase $name: dev dependencies were not pruned after the build."
  [ -e "$stable_app/apps/server/node_modules/fastify" ] \
    || fail "Phase $name: the prune removed a runtime dependency."

  if [ "$expect_bundled" = "1" ]; then
    [ -x "$fake_home/.local/soldar/node/bin/node" ] \
      || fail "Phase $name: the installer did not download its own Node."
    "$fake_home/.local/soldar/node/bin/node" --version | grep -q '^v24\.' \
      || fail "Phase $name: the downloaded Node is not v24."
  fi

  note "Phase $name: launch (first click)"
  : > "$XDG_LOG"
  env HOME="$fake_home" PATH="$STUB_BIN:$path" SOLDAR_PORT="$port" \
    XDG_CONFIG_HOME="$fake_home/.config" bash "$stable_app/soldar.sh" \
    || fail "Phase $name: the launcher exited non-zero on the first run."
  curl -fsSL --max-time 5 "http://127.0.0.1:$port/api/health" | grep -q '"status":"ok"' \
    || fail "Phase $name: the server does not answer on port $port after launch."
  wait_for_url "$port" \
    || fail "Phase $name: the launcher did not open the app URL in the browser."
  local pid1
  pid1="$(server_pid "$stable_app")"
  [ -n "$pid1" ] || fail "Phase $name: no server process found after launch."
  local pid_count
  pid_count="$(printf '%s\n' "$pid1" | wc -l | tr -d ' ')"
  [ "$pid_count" = "1" ] \
    || fail "Phase $name: more than one server process after the first launch."
  [ -f "$fake_home/.config/soldar/soldar.pid" ] \
    || fail "Phase $name: the server did not write its PID file."

  note "Phase $name: launch (second click reuses the instance, opens no new tab)"
  env HOME="$fake_home" PATH="$STUB_BIN:$path" SOLDAR_PORT="$port" \
    XDG_CONFIG_HOME="$fake_home/.config" bash "$stable_app/soldar.sh" \
    || fail "Phase $name: the launcher exited non-zero on the second run."
  local pid2
  pid2="$(server_pid "$stable_app")"
  [ "$pid1" = "$pid2" ] \
    || fail "Phase $name: the second launch started a new server (was $pid1, now $pid2)."
  # Give a stray tab-open a moment to land, then the log must still hold
  # exactly one URL: the second click reuses the tab that is already open.
  sleep 2
  [ "$(grep -c "http://127.0.0.1:$port" "$XDG_LOG")" = "1" ] \
    || fail "Phase $name: the second launch opened another browser tab."

  if [ "$name" = "A" ]; then
    # Reinstall keeps the data (0.2.0 layout migration): put the database
    # back where 0.2.0 kept it, in the app folder, reinstall, and check the
    # database moved to the data dir and the workflow survived. The
    # installer migrates first and the server migrates on startup too;
    # this checks the combined behaviour, not which layer moved it.
    note "Phase $name: reinstall keeps the data"
    curl -fsSL --max-time 5 -X POST -H 'Content-Type: application/json' \
      -d '{"name":"Keep me"}' "http://127.0.0.1:$port/api/workflows" >/dev/null \
      || fail "Phase $name: could not create a workflow for the migration check."
    curl -fsSL --max-time 5 "http://127.0.0.1:$port/api/workflows" | grep -q 'Keep me' \
      || fail "Phase $name: the workflow is not listed before the reinstall."

    pkill -f "$stable_app/apps/server/dist/index.js" 2>/dev/null || true
    for ((i = 0; i < 10; i++)); do
      port_free "$port" && break
      sleep 1
    done
    port_free "$port" || fail "Phase $name: the server did not stop for the migration check."
    local data_dir="$fake_home/.config/soldar"
    [ -f "$data_dir/soldar.db" ] \
      || fail "Phase $name: no database in the data dir to migrate."
    mv "$data_dir/soldar.db" "$extract/soldar.db"
    [ -f "$data_dir/soldar.log" ] && mv "$data_dir/soldar.log" "$extract/soldar.log"

    env HOME="$fake_home" PATH="$path" SOLDAR_INSTALL_NONINTERACTIVE=1 \
      SOLDAR_PORT="$port" XDG_CONFIG_HOME="$fake_home/.config" bash "$extract/install.sh" \
      || fail "Phase $name: the reinstall exited non-zero."
    [ -f "$data_dir/soldar.db" ] \
      || fail "Phase $name: the reinstall did not move the database to the data dir."
    [ ! -f "$stable_app/soldar.db" ] \
      || fail "Phase $name: the old database is still in the app folder after the reinstall."
    [ -f "$data_dir/soldar.log" ] \
      || fail "Phase $name: the reinstall did not move the log to the data dir."

    : > "$XDG_LOG"
    env HOME="$fake_home" PATH="$STUB_BIN:$path" SOLDAR_PORT="$port" \
      XDG_CONFIG_HOME="$fake_home/.config" bash "$stable_app/soldar.sh" \
      || fail "Phase $name: the launcher exited non-zero after the reinstall."
    curl -fsSL --max-time 5 "http://127.0.0.1:$port/api/workflows" | grep -q 'Keep me' \
      || fail "Phase $name: the workflow did not survive the reinstall."

    # The uninstaller removes the icons, the app, and (with
    # --remove-data) the data. It stops the server first.
    note "Phase $name: uninstall"
    env HOME="$fake_home" PATH="$STUB_BIN:$path" SOLDAR_PORT="$port" \
      XDG_CONFIG_HOME="$fake_home/.config" SOLDAR_UNINSTALL_NONINTERACTIVE=1 \
      bash "$stable_app/uninstall.sh" --remove-data \
      || fail "Phase $name: the uninstaller exited non-zero."
    port_free "$port" || fail "Phase $name: the server is still running after the uninstall."
    [ ! -e "$fake_home/.local/share/applications/soldar.desktop" ] \
      || fail "Phase $name: the uninstaller left the menu icon behind."
    [ ! -e "$fake_home/Desktop/soldar.desktop" ] \
      || fail "Phase $name: the uninstaller left the desktop icon behind."
    [ ! -e "$fake_home/.local/soldar" ] \
      || fail "Phase $name: the uninstaller left the app folder behind."
    [ ! -e "$data_dir" ] \
      || fail "Phase $name: the uninstaller left the data behind with --remove-data."
  fi

  pkill -f "$stable_app/apps/server/dist/index.js" 2>/dev/null || true
  for ((i = 0; i < 10; i++)); do
    port_free "$port" && break
    sleep 1
  done
  echo "Phase $name passed."
}

# Wait for a writable moment before doing anything: a busy or snapshotting
# filesystem can refuse writes for a while, and there is no point starting
# the test in the middle of that.
wait_writable "$SCRATCH"

# A stub xdg-open that records the URL instead of opening a real browser.
# Retried a few times: a slow or busy filesystem can refuse a write once.
mkdir -p "$STUB_BIN"
for _ in 1 2 3 4 5; do
  if printf '#!/usr/bin/env sh\necho "$@" >>"$XDG_OPEN_LOG"\n' > "$STUB_BIN/xdg-open" 2>/dev/null; then
    break
  fi
  sleep 3
done
[ -s "$STUB_BIN/xdg-open" ] || fail "Could not create the xdg-open stub."
chmod +x "$STUB_BIN/xdg-open"
export XDG_OPEN_LOG="$XDG_LOG"

command -v curl >/dev/null 2>&1 || fail "curl is needed to run this test."
command -v pgrep >/dev/null 2>&1 || fail "pgrep is needed to run this test."
command -v pkill >/dev/null 2>&1 || fail "pkill is needed to run this test."
command -v node >/dev/null 2>&1 || fail "node is needed on PATH for Phase A."
command -v pnpm >/dev/null 2>&1 || fail "pnpm is needed on PATH for Phase A."

if [ -z "$ONLY_PHASE" ] || [ "$ONLY_PHASE" = "A" ]; then
  run_phase A 5678 "$PATH" 0
fi

# Free Phase A's disk (its own pnpm store lives under its fake HOME) before
# Phase B starts, so the two phases never hold two full installs at once.
rm -rf "$SCRATCH/extract-A" "$SCRATCH/home-A"

# Phase B hides Node and pnpm from PATH with an allowlist bin dir: symlinks
# to every tool the installer needs except node/npm/npx/corepack/pnpm.
# That simulates a machine with no Node even when this machine has one in
# /usr/bin, and it works the same way everywhere.
build_allowlist_bin() {
  local dir="$1"
  mkdir -p "$dir"
  local tools=(
    bash sh env curl tar xz sha256sum gpgv python3 grep sed ln mkdir rm sleep
    cat chmod cp mv sort head tail wc tr dirname basename mktemp nohup
    xdg-user-dir gio zenity notify-send make g++ gcc cc date uname which
    ls file id
  )
  local t found
  for t in "${tools[@]}"; do
    found="$(command -v "$t" 2>/dev/null || echo "")"
    if [ -n "$found" ]; then ln -sf "$found" "$dir/$t"; fi
  done
  if PATH="$dir" command -v node >/dev/null 2>&1; then
    fail "Phase B: node is still visible with the allowlist PATH."
  fi
  if PATH="$dir" command -v pnpm >/dev/null 2>&1; then
    fail "Phase B: pnpm is still visible with the allowlist PATH."
  fi
}

if [ -z "$ONLY_PHASE" ] || [ "$ONLY_PHASE" = "B" ]; then
  ALLOWLIST_BIN="$SCRATCH/allowlist-bin"
  build_allowlist_bin "$ALLOWLIST_BIN"
  run_phase B 5679 "$ALLOWLIST_BIN" 1
fi

echo ""
echo "Installer test passed."

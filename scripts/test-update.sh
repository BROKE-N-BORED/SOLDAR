#!/usr/bin/env bash
# Tests for scripts/apply-update.sh, against a fake app tree with a stub
# installer — no real pnpm install, no network, no running server. The
# full path (real server, real install, browser) is verified by hand on
# every release; this script pins the apply script's own behaviour:
# verify, extract, rebuild, roll back, and never retry a failed update.
#
# Usage: bash scripts/test-update.sh
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPLY="$SCRIPT_DIR/apply-update.sh"
ROOT="$(mktemp -d /tmp/soldar-update-test.XXXXXX)"
PASS=0
FAIL=0

ok() { PASS=$((PASS + 1)); echo "ok: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }

# Build a fake app tree: old dist markers, a stub install.sh that records
# it ran (and can be told to fail), and a stub soldar.sh that records a
# relaunch. Returns the app dir.
make_app() {
  local dir="$1" fail_install="${2:-0}"
  mkdir -p "$dir/apps/server/dist" "$dir/apps/web/dist" "$dir/packages/engine/dist" "$dir/packages/nodes/dist" "$dir/scripts"
  echo "old server build" >"$dir/apps/server/dist/old-marker.txt"
  echo "old web build" >"$dir/apps/web/dist/old-marker.txt"
  echo "old engine build" >"$dir/packages/engine/dist/old-marker.txt"
  echo "old nodes build" >"$dir/packages/nodes/dist/old-marker.txt"
  cat >"$dir/install.sh" <<EOF
#!/usr/bin/env bash
echo "install ran" >>"$dir/install-calls.txt"
# A real tsc build rebuilds the package dists before it can fail on the
# app typecheck: simulate that partial rebuild, then fail.
echo "new engine build" >"$dir/packages/engine/dist/new-marker.txt"
echo "new nodes build" >"$dir/packages/nodes/dist/new-marker.txt"
if [ "$fail_install" = "1" ]; then exit 1; fi
echo "new server build" >"$dir/apps/server/dist/new-marker.txt"
echo "new web build" >"$dir/apps/web/dist/new-marker.txt"
exit 0
EOF
  cat >"$dir/soldar.sh" <<EOF
#!/usr/bin/env bash
echo "relaunch" >>"$dir/relaunch-calls.txt"
exit 0
EOF
  chmod +x "$dir/soldar.sh"
  cp "$APPLY" "$dir/scripts/apply-update.sh"
}

# Stage a pending update in a fake data dir: a zip holding newfile.txt
# plus pending-update.json. $3 is the hash to record ("good" = the real
# one, anything else = that literal value). $4 is the fake app dir, whose
# install stub is copied into the zip so the apply's "does this look like
# a Soldar install" check passes. The zip carries the release layout: a
# top-level soldar-v9.9.9/ folder.
stage_update() {
  local data_dir="$1" zip_name="$2" hash="${3:-good}" app_dir="$4"
  mkdir -p "$data_dir/update" "$ROOT/zip-src/soldar-v9.9.9"
  echo "new version file" >"$ROOT/zip-src/soldar-v9.9.9/newfile.txt"
  cp "$app_dir/install.sh" "$ROOT/zip-src/soldar-v9.9.9/install.sh"
  (cd "$ROOT/zip-src" && zip -q -r "$data_dir/update/$zip_name" soldar-v9.9.9)
  local real_hash
  real_hash="$(sha256sum "$data_dir/update/$zip_name" | awk '{print $1}')"
  if [ "$hash" = "good" ]; then hash="$real_hash"; fi
  cat >"$data_dir/update/pending-update.json" <<EOF
{"version": "9.9.9", "zipName": "$zip_name", "sha256": "$hash", "stagedAt": 1}
EOF
}

# --- 1. Happy path, launcher mode: extract, rebuild, clean up, no relaunch.
APP="$ROOT/app1"; DATA="$ROOT/data1"
make_app "$APP" 0
stage_update "$DATA" "soldar-v9.9.9.zip" "good" "$APP"
if bash "$APP/scripts/apply-update.sh" "$APP" "$DATA" 5678 --from-launcher; then
  ok "launcher mode exits 0 on a good update"
else
  bad "launcher mode exits 0 on a good update"
fi
[ -f "$APP/newfile.txt" ] && ok "new files extracted" || bad "new files extracted"
[ -f "$APP/install-calls.txt" ] && ok "install.sh ran" || bad "install.sh ran"
[ ! -f "$DATA/update/pending-update.json" ] && ok "pending file removed after success" || bad "pending file removed after success"
[ ! -f "$DATA/update/soldar-v9.9.9.zip" ] && ok "staged zip removed after success" || bad "staged zip removed after success"
[ ! -f "$APP/relaunch-calls.txt" ] && ok "launcher mode does not relaunch" || bad "launcher mode does not relaunch"
[ -f "$DATA/update/update.log" ] && ok "update log kept" || bad "update log kept"

# --- 2. Bad checksum: nothing installed, pending dropped, old build intact.
APP="$ROOT/app2"; DATA="$ROOT/data2"
make_app "$APP" 0
stage_update "$DATA" "soldar-v9.9.9.zip" "0000000000000000000000000000000000000000000000000000000000000000" "$APP"
if bash "$APP/scripts/apply-update.sh" "$APP" "$DATA" 5678 --from-launcher; then
  bad "bad checksum exits non-zero"
else
  ok "bad checksum exits non-zero"
fi
[ ! -f "$APP/newfile.txt" ] && ok "bad checksum installs nothing" || bad "bad checksum installs nothing"
[ ! -f "$APP/install-calls.txt" ] && ok "bad checksum never runs install.sh" || bad "bad checksum never runs install.sh"
[ ! -f "$DATA/update/pending-update.json" ] && ok "bad checksum drops the pending update" || bad "bad checksum drops the pending update"
[ -f "$APP/apps/server/dist/old-marker.txt" ] && ok "old build untouched after bad checksum" || bad "old build untouched after bad checksum"

# --- 3. Install failure: the old build is restored, pending dropped.
APP="$ROOT/app3"; DATA="$ROOT/data3"
make_app "$APP" 1
stage_update "$DATA" "soldar-v9.9.9.zip" "good" "$APP"
if bash "$APP/scripts/apply-update.sh" "$APP" "$DATA" 5678 --from-launcher; then
  bad "failed install exits non-zero"
else
  ok "failed install exits non-zero"
fi
[ -f "$APP/apps/server/dist/old-marker.txt" ] && ok "old server build restored after failed install" || bad "old server build restored after failed install"
[ ! -f "$APP/apps/server/dist/new-marker.txt" ] && ok "failed install leaves no new build behind" || bad "failed install leaves no new build behind"
[ -f "$APP/packages/engine/dist/old-marker.txt" ] && ok "old engine build restored after failed install" || bad "old engine build restored after failed install"
[ -f "$APP/packages/nodes/dist/old-marker.txt" ] && ok "old nodes build restored after failed install" || bad "old nodes build restored after failed install"
[ ! -f "$APP/packages/engine/dist/new-marker.txt" ] && ok "failed install leaves no new engine build behind" || bad "failed install leaves no new engine build behind"
[ ! -f "$APP/packages/nodes/dist/new-marker.txt" ] && ok "failed install leaves no new nodes build behind" || bad "failed install leaves no new nodes build behind"
[ ! -f "$DATA/update/pending-update.json" ] && ok "failed install drops the pending update" || bad "failed install drops the pending update"

# --- 4. No pending update: exit 0, nothing happens.
APP="$ROOT/app4"; DATA="$ROOT/data4"
make_app "$APP" 0
mkdir -p "$DATA/update"
if bash "$APP/scripts/apply-update.sh" "$APP" "$DATA" 5678 --from-launcher; then
  ok "no pending update exits 0"
else
  bad "no pending update exits 0"
fi
[ ! -f "$APP/install-calls.txt" ] && ok "no pending update runs nothing" || bad "no pending update runs nothing"

# --- 5. Damaged pending file: refused, dropped, old build intact.
APP="$ROOT/app5"; DATA="$ROOT/data5"
make_app "$APP" 0
mkdir -p "$DATA/update"
echo "this is not json" >"$DATA/update/pending-update.json"
if bash "$APP/scripts/apply-update.sh" "$APP" "$DATA" 5678 --from-launcher; then
  bad "damaged pending file exits non-zero"
else
  ok "damaged pending file exits non-zero"
fi
[ ! -f "$DATA/update/pending-update.json" ] && ok "damaged pending file dropped" || bad "damaged pending file dropped"

rm -rf "$ROOT"
echo "---"
echo "passed: $PASS, failed: $FAIL"
[ "$FAIL" = "0" ]

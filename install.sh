#!/usr/bin/env bash
# Soldar installer — double-click "Install Soldar" and this does the rest.
#
# What it does, in order:
#   0. Copies Soldar into its permanent home (~/.local/soldar/app) when
#      it was started from anywhere else, and carries on from there, so
#      the desktop icons never point at a folder that moves or is deleted.
#   1. Moves your workflows and runs to ~/.config/soldar if they still
#      live in the app folder from an older install.
#   2. Makes sure Node 24 or newer is available (downloads its own copy
#      into ~/.local/soldar/node if the computer does not have one), and
#      checks the download's signature as well as its checksum.
#   3. Makes sure pnpm is available (corepack, then npm, then npx).
#   4. Installs Soldar's parts and builds the app, then removes the
#      build-only parts to save space.
#   5. Puts a Soldar icon on the desktop and in the applications menu.
#   6. Starts Soldar once to prove the install actually works.
#
# It never uses sudo and never touches anything outside the Soldar folder,
# ~/.local, and ~/.config/soldar. Set SOLDAR_INSTALL_NONINTERACTIVE=1 to skip the final
# "Press Enter" prompt (used by the installer test). Two installer runs at
# once are refused: the second one waits for the first to finish.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOLDAR_HOME="$HOME/.local/soldar"
STABLE_DIR="$SOLDAR_HOME/app"
NODE_FALLBACK="v24.22.3"
PNPM_VERSION="12.21.0"
USING_BUNDLED_NODE=0
TRUST_FAILED=0

press_enter() {
  if [ -n "${SOLDAR_INSTALL_NONINTERACTIVE:-}" ]; then return 0; fi
  if [ ! -t 0 ]; then return 0; fi
  echo ""
  read -r -p "Press Enter to close this window." _dummy || true
}

die() {
  echo ""
  echo "Soldar could not be installed: $1" >&2
  exit 1
}

# --- One installer at a time -------------------------------------------
# flock when it exists; otherwise a lock directory holding the installer's
# PID (a stale directory, whose PID is gone, is removed and retried).
# The lock is taken before the relocation below, and the relocated copy
# inherits it: the file descriptor survives the exec, so the second copy
# skips locking when SOLDAR_INSTALL_LOCK_HELD is set (to "flock" or
# "mkdir", so the exit trap knows whether the lock directory needs
# removing — a flock releases itself when the process exits).
LOCK_DIR="$SOLDAR_HOME/install.lock.d"
LOCK_TYPE=""
take_lock() {
  mkdir -p "$SOLDAR_HOME"
  if [ -n "${SOLDAR_INSTALL_LOCK_HELD:-}" ]; then return 0; fi
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$SOLDAR_HOME/install.lock"
    if ! flock -n 9; then
      die "Soldar is already being installed. Wait for that install to finish, then run this one again."
    fi
    LOCK_TYPE="flock"
    return 0
  fi
  local tries
  for tries in 1 2 3; do
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      echo "$$" > "$LOCK_DIR/pid"
      LOCK_TYPE="mkdir"
      return 0
    fi
    local owner=""
    owner="$(cat "$LOCK_DIR/pid" 2>/dev/null || echo "")"
    if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then
      rm -rf "$LOCK_DIR"
      continue
    fi
    die "Soldar is already being installed. Wait for that install to finish, then run this one again."
  done
  die "Soldar is already being installed. Wait for that install to finish, then run this one again."
}
release_lock() {
  local held="${SOLDAR_INSTALL_LOCK_HELD:-$LOCK_TYPE}"
  if [ "$held" != "mkdir" ]; then return 0; fi
  local owner=""
  owner="$(cat "$LOCK_DIR/pid" 2>/dev/null || echo "")"
  if [ "$owner" = "$$" ]; then rm -rf "$LOCK_DIR"; fi
}
trap 'release_lock; press_enter' EXIT

# --- Stable install location -------------------------------------------
# The desktop icons must point somewhere that never moves. A ZIP extract
# in Downloads does move (or gets deleted), so the first thing the
# installer does is copy the tree to ~/.local/soldar/app and re-run
# itself from there. The copy leaves out build outputs and node_modules,
# which are rebuilt in place; the database and log ARE copied, so a
# reinstall still finds legacy data to migrate.
take_lock
if [ -z "${SOLDAR_INSTALL_RELOCATED:-}" ] && [ "$APP_DIR" != "$STABLE_DIR" ]; then
  echo "Putting Soldar in its permanent home ($STABLE_DIR)..."
  mkdir -p "$STABLE_DIR" || die "Could not create $STABLE_DIR. Check the disk and run the installer again."
  (cd "$APP_DIR" && tar --no-same-owner \
    --exclude=node_modules \
    --exclude=dist \
    --exclude=.git \
    --exclude=test-results \
    --exclude='*.tsbuildinfo' \
    -cf - .) | (cd "$STABLE_DIR" && tar --no-same-owner -xf -) \
    || die "Could not copy Soldar to $STABLE_DIR. Check the disk and run the installer again."
  exec env SOLDAR_INSTALL_RELOCATED=1 SOLDAR_INSTALL_LOCK_HELD="$LOCK_TYPE" bash "$STABLE_DIR/install.sh" "$@"
fi

server_healthy() {
  local port="${1:-${SOLDAR_PORT:-5678}}"
  local body
  body="$(curl -fsSL --max-time 3 "http://127.0.0.1:${port}/api/health" 2>/dev/null || echo "")"
  case "$body" in
    *'"status":"ok"'*) return 0 ;;
    *) return 1 ;;
  esac
}

port_free() {
  ! server_healthy "$1"
}

node_major() {
  node --version 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/'
}

# Where Soldar keeps its data: ~/.config/soldar, unless SOLDAR_DATA_DIR
# says otherwise. Matches apps/server/src/data-dir.ts; keep the two in step.
data_dir() {
  if [ -n "${SOLDAR_DATA_DIR:-}" ]; then
    printf '%s' "$SOLDAR_DATA_DIR"
  else
    printf '%s' "${XDG_CONFIG_HOME:-$HOME/.config}/soldar"
  fi
}

# Up to 0.2.0 the database lived in the app folder, so reinstalling from a
# new ZIP wiped every workflow and run. Move it (and the log) to the data
# dir, but only when the data dir has no database yet, and never when the
# user picked a data dir themselves (their choice stands). The server does
# the same move on startup; this runs first so the data is safe even if
# the rest of the install is interrupted.
migrate_legacy_data() {
  if [ -n "${SOLDAR_DATA_DIR:-}" ]; then return 0; fi
  [ -f "$APP_DIR/soldar.db" ] || return 0
  local dest
  dest="$(data_dir)"
  mkdir -p "$dest"
  if [ -f "$dest/soldar.db" ]; then
    echo "Found an old database in the app folder, but $dest/soldar.db already exists, so the old one was left alone."
    return 0
  fi
  echo "Moving your workflows and runs to $dest..."
  local name
  for name in soldar.db soldar.db-wal soldar.db-shm soldar.db-journal soldar.log soldar.log.1; do
    if [ -f "$APP_DIR/$name" ] && [ ! -e "$dest/$name" ]; then
      mv "$APP_DIR/$name" "$dest/$name" \
        || echo "Could not move $APP_DIR/$name. It is still there."
    fi
  done
}

# The Node download is checked twice: the checksum list is signed by the
# Node.js release team, and that signature is verified against their
# published keyring (fetched from GitHub, a different trust root from
# nodejs.org, so a compromised mirror cannot fake both), then the
# tarball's hash is checked against the verified list. Without gpgv the
# signature cannot be checked, so the checksum alone is used and the
# installer says so plainly.
verify_node_download() {
  local version="$1" tarball="$2" dest="$3"
  local sums_file="$SOLDAR_HOME/SHASUMS256.txt"
  if command -v gpgv >/dev/null 2>&1; then
    echo "Checking the download's signature..."
    local keyring="$SOLDAR_HOME/nodejs-release-keys.kbx"
    if [ ! -s "$keyring" ]; then
      curl -fsSL --retry 3 --retry-all-errors --max-time 30 \
        "https://raw.githubusercontent.com/nodejs/release-keys/HEAD/gpg-only-active-keys/pubring.kbx" \
        -o "$keyring" \
        || die "Could not fetch the Node.js release keys. Check the internet connection and run the installer again."
    fi
    curl -fsSL --max-time 30 "https://nodejs.org/dist/${version}/SHASUMS256.txt.asc" -o "$SOLDAR_HOME/SHASUMS256.txt.asc" \
      || die "Could not fetch the Node checksum list."
    if ! gpgv --keyring "$keyring" --output "$sums_file" "$SOLDAR_HOME/SHASUMS256.txt.asc" >/dev/null 2>&1; then
      rm -f "$dest"
      die "The Node checksum list did not match its signature, so the download was thrown away. Run the installer again."
    fi
  else
    echo "Checking the download (gpg is not on this computer, so the signature could not be checked; the checksum was)..."
    curl -fsSL --max-time 30 "https://nodejs.org/dist/${version}/SHASUMS256.txt" -o "$sums_file" \
      || die "Could not fetch the Node checksum list."
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    if ! grep "  ${tarball}\$" "$sums_file" | (cd "$SOLDAR_HOME" && sha256sum -c - >/dev/null); then
      rm -f "$dest"
      die "The Node download did not match its checksum, so it was thrown away. Run the installer again."
    fi
  fi
}

install_bundled_node() {
  command -v tar >/dev/null 2>&1 || die "tar is needed to unpack Node and it is not on this computer."
  command -v xz >/dev/null 2>&1 || die "xz is needed to unpack Node and it is not on this computer."
  mkdir -p "$SOLDAR_HOME"

  # Ask nodejs.org for the newest Node 24 LTS; fall back to the version
  # this installer was written against if the list cannot be read.
  local version="$NODE_FALLBACK"
  local index
  index="$(curl -fsSL --max-time 30 https://nodejs.org/dist/index.json 2>/dev/null || echo "")"
  if [ -n "$index" ] && command -v python3 >/dev/null 2>&1; then
    local latest
    latest="$(printf '%s' "$index" | python3 -c 'import json, sys; data = json.load(sys.stdin); print(next((e["version"] for e in data if e.get("lts") and e["version"].startswith("v24.")), ""))' 2>/dev/null || echo "")"
    if [ -n "$latest" ]; then version="$latest"; fi
  fi

  local tarball="node-${version}-linux-x64.tar.xz"
  local dest="$SOLDAR_HOME/$tarball"
  echo "Downloading Node $version..."
  # -C - resumes a half-finished download instead of starting over.
  curl -fSL --retry 3 --retry-all-errors -C - -o "$dest" "https://nodejs.org/dist/${version}/${tarball}" \
    || die "The Node download failed. Check the internet connection and run the installer again."

  verify_node_download "$version" "$tarball" "$dest"

  echo "Unpacking Node..."
  # --no-same-owner: run as root, plain tar tries to restore the
  # tarball's ownership and fails on filesystems that reject chown.
  tar --no-same-owner -xJf "$dest" -C "$SOLDAR_HOME"
  ln -sfn "$SOLDAR_HOME/node-${version}-linux-x64" "$SOLDAR_HOME/node"
  export PATH="$SOLDAR_HOME/node/bin:$PATH"
  echo "Node $(node --version) is ready."
}

ensure_node() {
  local major
  major="$(node_major || echo "")"
  if [ -n "$major" ] && [ "$major" -ge 24 ] 2>/dev/null; then
    echo "Node $(node --version) found."
    return 0
  fi
  echo "Node 24 or newer was not found. Getting a copy for Soldar..."
  install_bundled_node
  USING_BUNDLED_NODE=1
}

# Finds a pnpm and leaves the command in the PNPM array. Prefers a real
# pnpm on PATH; falls back to corepack, then a global npm install, then an
# npx shim so the nested `pnpm` calls inside the build scripts still work.
resolve_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    PNPM=(pnpm)
    return 0
  fi
  if command -v corepack >/dev/null 2>&1; then
    # corepack downloads pnpm; a hiccup in the download is worth one retry.
    local attempt
    for attempt in 1 2; do
      if corepack prepare "pnpm@${PNPM_VERSION}" --activate >/dev/null 2>&1 && command -v pnpm >/dev/null 2>&1; then
        PNPM=(pnpm)
        return 0
      fi
      sleep 10
    done
  fi
  if command -v npm >/dev/null 2>&1; then
    if npm install -g "pnpm@${PNPM_VERSION}" >/dev/null 2>&1 && command -v pnpm >/dev/null 2>&1; then
      PNPM=(pnpm)
      return 0
    fi
  fi
  mkdir -p "$SOLDAR_HOME/bin"
  local shim_ok=0
  for attempt in 1 2 3; do
    # Unquoted heredoc so $PNPM_VERSION expands here; \$@ stays literal
    # for the shim.
    if cat > "$SOLDAR_HOME/bin/pnpm" <<SHIM_EOF 2>/dev/null; then
#!/usr/bin/env sh
exec npx -y pnpm@${PNPM_VERSION} "\$@"
SHIM_EOF
      shim_ok=1
      break
    fi
    sleep 5
  done
  [ "$shim_ok" = "1" ] || die "Could not set up pnpm. Check the disk and run the installer again."
  chmod +x "$SOLDAR_HOME/bin/pnpm"
  export PATH="$SOLDAR_HOME/bin:$PATH"
  PNPM=(pnpm)
}

install_deps() {
  echo "Installing Soldar's parts (this takes a minute)..."
  # --frozen-lockfile: a drifted lockfile fails loudly instead of
  # silently installing untested versions.
  if "${PNPM[@]}" install --frozen-lockfile; then return 0; fi
  echo "That install hit a snag. Approving the native parts and trying again..."
  "${PNPM[@]}" approve-builds better-sqlite3 esbuild isolated-vm vue-demi >/dev/null 2>&1 || true
  if "${PNPM[@]}" install --frozen-lockfile; then return 0; fi
  return 1
}

write_desktop_file() {
  local dest="$1"
  cat > "$dest" <<EOF
[Desktop Entry]
Type=Application
Name=Soldar
Comment=Workflow automation
Exec="$APP_DIR/soldar.sh"
Icon=$APP_DIR/apps/web/public/icon.svg
Terminal=false
Categories=Utility;
StartupWMClass=soldar
EOF
  chmod +x "$dest"
}

install_desktop_icons() {
  mkdir -p "$HOME/.local/share/applications"
  local app_file="$HOME/.local/share/applications/soldar.desktop"
  write_desktop_file "$app_file"

  local desktop_dir
  desktop_dir="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")"
  local desk_file=""
  if [ -d "$desktop_dir" ]; then
    desk_file="$desktop_dir/soldar.desktop"
    write_desktop_file "$desk_file"
  fi

  # Mark the icons trusted so a double-click starts the app instead of
  # opening a text editor. If that fails, the note at the end covers it.
  if command -v gio >/dev/null 2>&1; then
    gio set "$app_file" metadata::trusted true 2>/dev/null || TRUST_FAILED=1
    if [ -n "$desk_file" ]; then
      gio set "$desk_file" metadata::trusted true 2>/dev/null || TRUST_FAILED=1
    fi
  else
    TRUST_FAILED=1
  fi
}

# Prove THIS install works before claiming success. A healthy answer on
# the port is not proof — any Soldar on the port would answer, including
# an older install. This install counts as already running only when a
# server process is running from this very folder AND the port answers.
# Otherwise the new build is started on a scratch port with a throwaway
# data dir (so it cannot touch the real database or fight over the PID
# file), and the check passes only when THAT server answers.
verify_install() {
  [ -f "$APP_DIR/apps/server/dist/index.js" ] || die "The server did not build. See the build output above."
  [ -f "$APP_DIR/apps/web/dist/index.html" ] || die "The web app did not build. See the build output above."
  if command -v pgrep >/dev/null 2>&1 \
    && pgrep -f "$APP_DIR/apps/server/dist/index.js" >/dev/null 2>&1 \
    && server_healthy; then
    echo "Soldar is already running from this install, and it answers. Good."
    return 0
  fi
  echo "Starting Soldar once to make sure it works..."
  local test_port=""
  local candidate
  for candidate in 15678 15679 15680 15681 15682 15683 15684 15685 15686 15687; do
    if port_free "$candidate"; then test_port="$candidate"; break; fi
  done
  [ -n "$test_port" ] || die "Could not find a free port to test Soldar on."
  local verify_data
  verify_data="$(mktemp -d)/soldar-verify"
  local verify_log
  verify_log="$verify_data/verify.log"
  mkdir -p "$verify_data"
  SOLDAR_PORT="$test_port" SOLDAR_DATA_DIR="$verify_data" SOLDAR_NO_UPDATE_CHECK=1 \
    node "$APP_DIR/apps/server/dist/index.js" >>"$verify_log" 2>&1 &
  local pid=$!
  local ok=0
  # A cold first start on a slow PC can take a while; give it a minute.
  for ((i = 0; i < 60; i++)); do
    if server_healthy "$test_port"; then ok=1; break; fi
    if ! kill -0 "$pid" 2>/dev/null; then break; fi
    sleep 1
  done
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  if [ "$ok" != "1" ]; then
    echo "What Soldar said before it stopped:" >&2
    tail -20 "$verify_log" 2>/dev/null >&2 || true
    rm -rf "$(dirname "$verify_data")"
    die "Soldar started but did not answer on its test port. See the output above for what it said."
  fi
  rm -rf "$(dirname "$verify_data")"
  echo "Soldar started and answered. The install works."
}

main() {
  echo "Installing Soldar..."
  echo ""
  command -v curl >/dev/null 2>&1 || die "curl is needed to install Soldar and it is not on this computer."

  cd "$APP_DIR"

  # The desktop icon runs soldar.sh directly, so make sure it is executable
  # no matter how this folder arrived (a zip or a clone can drop the bit).
  [ -f "$APP_DIR/soldar.sh" ] || die "soldar.sh is missing from this folder, so the install cannot finish."
  chmod +x "$APP_DIR/soldar.sh"
  [ -f "$APP_DIR/stop-soldar.sh" ] && chmod +x "$APP_DIR/stop-soldar.sh"
  [ -f "$APP_DIR/uninstall.sh" ] && chmod +x "$APP_DIR/uninstall.sh"

  # A reinstall must not build over a running server: stop this install's
  # server first, so the verification at the end proves the NEW build.
  if [ -f "$APP_DIR/stop-soldar.sh" ]; then
    bash "$APP_DIR/stop-soldar.sh" >/dev/null 2>&1 || true
  fi

  migrate_legacy_data

  ensure_node
  resolve_pnpm

  if ! install_deps; then
    if [ "$USING_BUNDLED_NODE" = "0" ]; then
      echo "Trying again with Soldar's own copy of Node..."
      install_bundled_node
      USING_BUNDLED_NODE=1
      resolve_pnpm
      install_deps || die "Soldar's parts would not install. Check the output above."
    else
      die "Soldar's parts would not install. Check the output above."
    fi
  fi

  echo "Building Soldar..."
  # A reinstall over an existing tree (the updater's path, or a new ZIP
  # extracted on top of the old folder) can leave .tsbuildinfo files
  # newer than the overlaid sources. tsc -b trusts those and skips
  # rebuilding, so the app would keep running the OLD version's build.
  # Delete them first so the build always comes from the current sources.
  # (A fresh install has none, so this is a no-op there.)
  find "$APP_DIR" -name '*.tsbuildinfo' -not -path '*/node_modules/*' -delete 2>/dev/null || true
  "${PNPM[@]}" run build || die "The build failed. Check the output above."

  # The build is done: the dev-only parts (vite, vitest, Playwright,
  # TypeScript) are no longer needed at runtime, and keeping them costs
  # ~200 MB. Removing them is best-effort — if it fails, Soldar still
  # works, it just takes more disk space. The next install or update
  # reinstalls them before building again.
  echo "Removing the build-only parts to save space..."
  "${PNPM[@]}" prune --prod >/dev/null 2>&1 \
    || echo "Could not remove the build-only parts; Soldar still works, it just takes more disk space."

  echo "Putting the Soldar icon on the desktop and in the menu..."
  install_desktop_icons

  verify_install

  echo ""
  echo "Soldar is installed."
  echo "Double-click the Soldar icon on your desktop (or find Soldar in your applications menu) to open it."
  echo "Soldar lives in $STABLE_DIR now. The folder you extracted the ZIP into can be deleted."
  if [ "$TRUST_FAILED" = "1" ]; then
    echo ""
    echo "One thing: if double-clicking the Soldar icon opens a text editor"
    echo "instead of starting the app, right-click the icon and choose"
    echo "Allow Launching, then double-click it again."
  fi
}

main "$@"

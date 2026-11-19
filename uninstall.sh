#!/usr/bin/env bash
# Removes Soldar: stops the server, removes the desktop icons, and
# removes the app itself (including the bundled Node, when there is
# one). Your workflows and runs are kept unless you pass --remove-data
# or answer yes when asked.
#
#   uninstall.sh [--remove-data]
#
# Set SOLDAR_UNINSTALL_NONINTERACTIVE=1 to skip the questions (used by
# the installer test); without --remove-data the data is kept.
set -euo pipefail

REMOVE_DATA=0
for arg in "$@"; do
  case "$arg" in
    --remove-data) REMOVE_DATA=1 ;;
    --help|-h)
      echo "Usage: uninstall.sh [--remove-data]"
      echo "Removes Soldar (icons, app, bundled Node). Your workflows and runs are kept"
      echo "unless --remove-data is given."
      exit 0
      ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

# The app lives in ~/.local/soldar/app, and this script runs from there —
# deleting that folder while bash is still reading this script from it
# would cut the script off mid-run. So: stop the server first (from the
# real location), then re-run a copy of this script from /tmp, which can
# delete the app folder freely.
APP_DIR="${SOLDAR_UNINSTALL_APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
SOLDAR_HOME="$HOME/.local/soldar"
DATA_DIR="${SOLDAR_DATA_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/soldar}"

if [ -z "${SOLDAR_UNINSTALL_REEXEC:-}" ]; then
  if [ -f "$APP_DIR/stop-soldar.sh" ]; then
    bash "$APP_DIR/stop-soldar.sh" || true
  fi
  TMP_DIR="$(mktemp -d)"
  cp "$APP_DIR/uninstall.sh" "$TMP_DIR/uninstall.sh"
  exec env SOLDAR_UNINSTALL_REEXEC=1 SOLDAR_UNINSTALL_APP_DIR="$APP_DIR" \
    SOLDAR_UNINSTALL_TMP_DIR="$TMP_DIR" bash "$TMP_DIR/uninstall.sh" "$@"
fi

if [ "$REMOVE_DATA" = "0" ] && [ -z "${SOLDAR_UNINSTALL_NONINTERACTIVE:-}" ] && [ -t 0 ]; then
  echo ""
  echo "Delete your workflows and runs too? They live in $DATA_DIR."
  read -r -p "Delete them? [y/N] " answer || true
  case "$answer" in
    y|Y|yes|YES) REMOVE_DATA=1 ;;
  esac
fi

echo "Removing the Soldar icons..."
rm -f "$HOME/.local/share/applications/soldar.desktop"
DESKTOP_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")"
rm -f "$DESKTOP_DIR/soldar.desktop"

echo "Removing Soldar itself..."
rm -rf "$SOLDAR_HOME"

if [ "$REMOVE_DATA" = "1" ]; then
  echo "Removing your workflows and runs..."
  rm -rf "$DATA_DIR"
  echo ""
  echo "Soldar is gone, including your workflows and runs."
else
  echo ""
  echo "Soldar is gone. Your workflows and runs are still in $DATA_DIR"
  echo "Reinstall Soldar any time and they will be there."
fi
rm -rf "${SOLDAR_UNINSTALL_TMP_DIR:-}" 2>/dev/null || true

#!/usr/bin/env bash

###
# Package: Local CLI Bridge - Control Local sites from the command line.
# Version: see package.json
# License: see README.md and LICENSE
# Author: Remon Pel
###

# Installs the CLI Bridge add-on into Local (symlink into Local's addons
# directory + build) and puts the `local-cli` command on your PATH.
#
# Usage: scripts/install.sh [--bin-dir <dir>] [--no-bin]
#   --bin-dir  where to symlink bin/local-cli (default: /usr/local/bin when
#              writable, otherwise ~/.local/bin)
#   --no-bin   only install the add-on, skip the command symlink
set -euo pipefail

ADDON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="$(node -p "require('$ADDON_DIR/package.json').name")"
BIN_DIR=""
LINK_BIN=1

while [ $# -gt 0 ]; do
	case "$1" in
		--bin-dir) BIN_DIR="$2"; shift 2 ;;
		--no-bin) LINK_BIN=0; shift ;;
		*) echo "Unknown option: $1" >&2; exit 64 ;;
	esac
done

case "$(uname -s)" in
	Darwin) ADDONS_ROOT="$HOME/Library/Application Support/Local/addons" ;;
	Linux)  ADDONS_ROOT="$HOME/.config/Local/addons" ;;
	*) echo "On Windows, copy this folder to %AppData%\\Local\\addons, run 'npm install' and 'npm run build' inside it, and add bin/ to your PATH."; exit 1 ;;
esac

echo "Installing dependencies…"
cd "$ADDON_DIR"
npm install --include=dev --no-audit --no-fund

echo "Building…"
./node_modules/.bin/tsc

mkdir -p "$ADDONS_ROOT"
LINK="$ADDONS_ROOT/$NAME"
if [ -e "$LINK" ] && [ ! -L "$LINK" ]; then
	echo "ERROR: $LINK already exists and is not a symlink — remove it first." >&2
	exit 1
fi
ln -sfn "$ADDON_DIR" "$LINK"
echo "Linked: $LINK -> $ADDON_DIR"

if [ "$LINK_BIN" -eq 1 ]; then
	if [ -z "$BIN_DIR" ]; then
		if [ -w /usr/local/bin ]; then
			BIN_DIR=/usr/local/bin
		else
			BIN_DIR="$HOME/.local/bin"
		fi
	fi
	mkdir -p "$BIN_DIR"
	ln -sfn "$ADDON_DIR/bin/local-cli" "$BIN_DIR/local-cli"
	echo "Linked: $BIN_DIR/local-cli -> $ADDON_DIR/bin/local-cli"
	case ":$PATH:" in
		*":$BIN_DIR:"*) ;;
		*) echo "NOTE: $BIN_DIR is not on your PATH; add it, or re-run with --bin-dir <dir>." ;;
	esac
	FOUND="$(command -v local-cli 2>/dev/null || true)"
	if [ -n "$FOUND" ] && [ "$(readlink "$FOUND" 2>/dev/null || echo "$FOUND")" != "$ADDON_DIR/bin/local-cli" ] && [ "$FOUND" != "$BIN_DIR/local-cli" ]; then
		echo
		echo "WARNING: another local-cli comes first on your PATH: $FOUND"
		echo "         (the deprecated GraphQL one, most likely). Remove it so scripts pick up this one:"
		echo "           npm uninstall -g @getflywheel/local-cli"
	fi
fi

echo
echo "Now restart Local, open Add-ons -> Installed, enable 'CLI Bridge', and relaunch."
echo "Then try:  local-cli list-sites"

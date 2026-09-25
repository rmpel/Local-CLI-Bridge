#!/usr/bin/env bash

###
# Package: Local CLI Bridge - Control Local sites from the command line.
# License: see README.md and LICENSE
# Author: Remon Pel
###

# Removes the add-on symlink from Local's addons directory and any `local-cli`
# symlink that points into this folder. Does not touch the source folder.
set -euo pipefail

ADDON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="$(node -p "require('$ADDON_DIR/package.json').name")"

case "$(uname -s)" in
	Darwin) ADDONS_ROOT="$HOME/Library/Application Support/Local/addons" ;;
	Linux)  ADDONS_ROOT="$HOME/.config/Local/addons" ;;
	*) echo "Remove %AppData%\\Local\\addons\\$NAME by hand on Windows."; exit 1 ;;
esac

LINK="$ADDONS_ROOT/$NAME"
if [ -L "$LINK" ]; then
	rm "$LINK"
	echo "Removed: $LINK"
fi

for dir in /usr/local/bin "$HOME/.local/bin" "$HOME/bin"; do
	if [ -L "$dir/local-cli" ] && [ "$(readlink "$dir/local-cli")" = "$ADDON_DIR/bin/local-cli" ]; then
		rm "$dir/local-cli"
		echo "Removed: $dir/local-cli"
	fi
done

rm -rf "$HOME/.local-cli-bridge"
echo "Done. Restart Local to unload the add-on."

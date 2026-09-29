#!/usr/bin/env bash

###
# Package: Local CLI Bridge - Control Local sites from the command line.
# Version: see package.json
# License: see README.md and LICENSE
# Author: Remon Pel
###

#
# build.sh — package CLI Bridge as a distributable Local (LocalWP) add-on.
#
# The add-on has no runtime npm dependencies, so the archive is just the
# compiled lib/, the bin/ command, the php/ helpers, the sources and the docs, unpacking to a
# top-level folder named after the package (the same name install.sh links).
#
set -euo pipefail

cd "$(dirname "$0")"/.. || exit 1
ROOT=$(pwd -P)

NAME="$(node -p "require('./package.json').name")"
VERSION="$(node -p "require('./package.json').version")"
PRODUCT="$(node -p "require('./package.json').productName || require('./package.json').name")"

STAGE="$ROOT/build"
PKG_DIR="$STAGE/$NAME"
DIST="$ROOT/dist"
ZIP="$DIST/${NAME}-v${VERSION}.tgz"

echo "==> Building $PRODUCT v$VERSION"

echo "==> Compiling TypeScript"
if [ ! -x node_modules/.bin/tsc ]; then
	npm install --include=dev --no-audit --no-fund
fi
./node_modules/.bin/tsc

rm -rf "$STAGE" "$ZIP"
mkdir -p "$PKG_DIR" "$DIST"

echo "==> Staging files"
cp -R lib src bin php scripts "$PKG_DIR/"
cp package.json package-lock.json icon.svg README.md CHANGELOG.md LICENSE "$PKG_DIR/"

echo "==> Creating archive"
(
	cd "$STAGE"
	tar --exclude='.DS_Store' --exclude='.git' -zcf "$ZIP" "$NAME"
)

SIZE="$(du -h "$ZIP" | cut -f1)"
echo
echo "==> Done: $ZIP  ($SIZE)"
echo "    Install: In Local choose 'Install from disk', select the .tgz, and enable"
echo "    '$PRODUCT' under Add-ons -> Installed. Then symlink bin/local-cli onto your PATH."

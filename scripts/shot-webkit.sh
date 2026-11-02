#!/bin/bash
# ReKindle visual-audit screenshot helper (WebKit, no focus theft).
#
# usage: scripts/shot-webkit.sh <url> <width> <height> <out.png> [js]
#
# Compiles scripts/shot-webkit.swift on first use (and whenever the source is
# newer) into $TMPDIR/rekindle-shot-bin. macOS only; never uses Chromium.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN_DIR="${TMPDIR:-/tmp}/rekindle-shot-bin"
BIN="$BIN_DIR/shot-webkit"
SRC="$SCRIPT_DIR/shot-webkit.swift"
mkdir -p "$BIN_DIR"

if [ ! -x "$BIN" ] || [ "$SRC" -nt "$BIN" ]; then
    echo "compiling $SRC -> $BIN" >&2
    swiftc -O -suppress-warnings "$SRC" -o "$BIN"
fi

exec "$BIN" "$@"

#!/usr/bin/env bash
# Download Bun binary for the current (or target) platform into src-tauri/binaries/
set -euo pipefail

BUN_VERSION="1.2.17"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN_DIR="$SCRIPT_DIR/../src-tauri/binaries"
TRIPLE="${TARGET_TRIPLE:-$(rustc --print host-tuple)}"

# Map Rust triple → Bun release asset name
case "$TRIPLE" in
  aarch64-apple-darwin)     BUN_ASSET="bun-darwin-aarch64" ;;
  x86_64-apple-darwin)      BUN_ASSET="bun-darwin-x64-baseline" ;;
  x86_64-pc-windows-msvc)   BUN_ASSET="bun-windows-x64" ;;
  x86_64-unknown-linux-gnu) BUN_ASSET="bun-linux-x64" ;;
  aarch64-unknown-linux-gnu) BUN_ASSET="bun-linux-aarch64" ;;
  *) echo "Unsupported triple: $TRIPLE"; exit 1 ;;
esac

BUN_BIN="$BIN_DIR/bun-$TRIPLE"
[[ "$TRIPLE" == *"windows"* ]] && BUN_BIN="$BUN_BIN.exe"

# Skip if already downloaded
if [ -f "$BUN_BIN" ]; then
  echo "Bun already present for $TRIPLE"
  exit 0
fi

mkdir -p "$BIN_DIR"

URL="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${BUN_ASSET}.zip"
echo "Downloading Bun $BUN_VERSION for $TRIPLE..."
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

curl -fsSL "$URL" -o "$TMPDIR/bun.zip"
unzip -q "$TMPDIR/bun.zip" -d "$TMPDIR"

if [[ "$TRIPLE" == *"windows"* ]]; then
  cp "$TMPDIR/$BUN_ASSET/bun.exe" "$BUN_BIN"
else
  cp "$TMPDIR/$BUN_ASSET/bun" "$BUN_BIN"
  chmod +x "$BUN_BIN"
fi

# macOS: re-sign after copy (cp sets com.apple.provenance which invalidates ad-hoc signature)
if [[ "$(uname)" == "Darwin" ]]; then
  codesign -fs - "$BUN_BIN"
fi

echo "Bun $BUN_VERSION ready for $TRIPLE → $BUN_BIN"

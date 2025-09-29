#!/usr/bin/env bash
set -euo pipefail

OUT_DIR="public"

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

cp index.html "$OUT_DIR"/
cp styles.css "$OUT_DIR"/
cp sidebar.css "$OUT_DIR"/

# Copy supporting assets
cp -R src "$OUT_DIR"/
cp -R assets "$OUT_DIR"/

# Include docs or JSON imports if they exist and are needed for downloads
if [ -d "JSON" ]; then
  cp -R JSON "$OUT_DIR"/
fi

if [ -d "JSON Backup" ]; then
  cp -R "JSON Backup" "$OUT_DIR"/
fi


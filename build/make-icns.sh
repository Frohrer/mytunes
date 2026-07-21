#!/usr/bin/env bash
# Packs build/icon.png (1024x1024 master) into build/icon.icns.
# Requires macOS `sips` and `iconutil`. Run via `npm run icon`.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f build/icon.png ]; then
  echo "build/icon.png missing — run: node build/generate-icon.js" >&2
  exit 1
fi

ICONSET=build/icon.iconset
rm -rf "$ICONSET"
mkdir -p "$ICONSET"
trap 'rm -rf "$ICONSET"' EXIT

for spec in \
  "16 icon_16x16"      "32 icon_16x16@2x" \
  "32 icon_32x32"      "64 icon_32x32@2x" \
  "128 icon_128x128"   "256 icon_128x128@2x" \
  "256 icon_256x256"   "512 icon_256x256@2x" \
  "512 icon_512x512"   "1024 icon_512x512@2x"
do
  px=${spec% *}; name=${spec#* }
  sips -z "$px" "$px" build/icon.png --out "$ICONSET/$name.png" >/dev/null
done

iconutil -c icns "$ICONSET" -o build/icon.icns
echo "wrote build/icon.icns"

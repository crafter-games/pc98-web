#!/bin/bash
# Builds the NP2 WASM cores and the PC-98 font into packages/core/wasm.
set -euo pipefail
cd "$(dirname "$0")"

BUILD_TYPE="${BUILD_TYPE:-Release}"
if [ ! -f "out/build.ninja" ]; then
  emcmake cmake -GNinja -DCMAKE_BUILD_TYPE="$BUILD_TYPE" -S src -B out
fi
ninja -C out

DEST=../packages/core/wasm
mkdir -p "$DEST"
cp out/np2.js out/np2.wasm out/np21.js out/np21.wasm "$DEST/"
if [ ! -f "$DEST/font.bmp" ]; then
  node font/makefont.cjs "$DEST/font.bmp"
fi

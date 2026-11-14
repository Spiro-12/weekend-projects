#!/usr/bin/env bash
# Builds DeepFilterNet (Rust, MIT/Apache-2.0) for the web (WebAssembly + JS glue, wasm-bindgen --target web)
# into build/df-wasm/, which is committed here as 04-wind-test/df/. Run it from an empty folder (~10 min, ~2 GB).
set -euo pipefail

DF_REV=7b14b895fe7fc42cab72b4a4c1e49c982bd6404b
# The DFN lock file pins wasm-bindgen 0.2.92, which predates the wasm features newer Rust turns on by default,
# so build with a Rust from that era.
TOOLCHAIN=1.81.0
BINDGEN=0.2.92

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${DF_WORK:-$ROOT/build/deepfilter-src}"
OUT="$ROOT/build/df-wasm"

rustup toolchain install "$TOOLCHAIN" --profile minimal --target wasm32-unknown-unknown
if ! wasm-bindgen --version 2>/dev/null | grep -q "$BINDGEN"; then
  cargo "+$TOOLCHAIN" install wasm-bindgen-cli --version "$BINDGEN" --locked
fi

if [ ! -d "$WORK/.git" ]; then
  git clone --filter=blob:none https://github.com/Rikorose/DeepFilterNet "$WORK"
fi
git -C "$WORK" checkout -q "$DF_REV"
git -C "$WORK" checkout -q -- libDF/Cargo.toml   # undo the iOS script's crate-type edit; the web needs cdylib
# The page downloads the model itself, so don't also bake an 8 MB copy into the .wasm.
sed -i.bak '/^wasm = \[/,/^\]/{/"default-model",/d;}' "$WORK/libDF/Cargo.toml"
grep -A3 '^wasm = ' "$WORK/libDF/Cargo.toml"

(cd "$WORK" && cargo "+$TOOLCHAIN" build --release --target wasm32-unknown-unknown -p deep_filter --lib --no-default-features --features wasm)

rm -rf "$OUT" && mkdir -p "$OUT"
wasm-bindgen --target web --no-typescript --out-dir "$OUT" "$WORK/target/wasm32-unknown-unknown/release/df.wasm"
if command -v wasm-opt >/dev/null; then
  wasm-opt -O3 --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext "$OUT/df_bg.wasm" -o "$OUT/df_bg.wasm"
fi
cp "$WORK/LICENSE-MIT" "$WORK/LICENSE-APACHE" "$OUT/"
ls -la "$OUT"

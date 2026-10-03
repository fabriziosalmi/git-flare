#!/usr/bin/env sh
# Canonical, reproducible build of crates/aimp-wasm/pkg. Same image, platform and paths everywhere
# (laptop and CI): rustc output depends on the package path, so native builds on different machines
# do not produce identical bytes. CI rebuilds with this script and fails if pkg/ differs from git.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
IMAGE="rust:1.98.1-bookworm"
WASM_PACK_VERSION="0.14.0"
mkdir -p "$ROOT/crates/aimp-wasm/pkg"
docker run --rm --platform linux/amd64 \
  -v "$ROOT/crates/aimp-wasm/src:/in/src:ro" \
  -v "$ROOT/crates/aimp-wasm/Cargo.toml:/in/Cargo.toml:ro" \
  -v "$ROOT/crates/aimp-wasm/Cargo.lock:/in/Cargo.lock:ro" \
  -v "$ROOT/crates/aimp-wasm/LICENSE:/in/LICENSE:ro" \
  -v "$ROOT/crates/aimp-wasm/pkg:/out" \
  -e WASM_PACK_VERSION="$WASM_PACK_VERSION" \
  "$IMAGE" sh -c '
    set -eu
    mkdir -p /work/crates/aimp-wasm && cp -R /in/. /work/crates/aimp-wasm/ && cd /work
    curl -fsSL "https://github.com/rustwasm/wasm-pack/releases/download/v${WASM_PACK_VERSION}/wasm-pack-v${WASM_PACK_VERSION}-x86_64-unknown-linux-musl.tar.gz" | tar -xz -C /tmp
    /tmp/wasm-pack-v${WASM_PACK_VERSION}-x86_64-unknown-linux-musl/wasm-pack build crates/aimp-wasm --target web --release >/tmp/build.log 2>&1 || { cat /tmp/build.log; exit 1; }
    rm -f crates/aimp-wasm/pkg/.gitignore
    find /out -mindepth 1 -delete
    cp crates/aimp-wasm/pkg/* /out/
  '
echo "built: $(cd "$ROOT/crates/aimp-wasm/pkg" && ls)"

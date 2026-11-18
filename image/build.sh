#!/bin/sh
# Run from any directory after npm ci. Requires Node 24, host Cargo and tar.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
build=$(mktemp -d)
trap 'rm -rf "$build"' EXIT
export TAB_LAB_BUILD_DIR="$build"
cargo vendor --locked --manifest-path "$here/template/Cargo.toml" "$build/vendor" >/dev/null
COPYFILE_DISABLE=1 tar -C "$build" -czf "$build/vendor.tgz" vendor
node --experimental-wasm-jspi "$here/guest.mjs" packages
node --experimental-wasm-jspi "$here/guest.mjs" prepare
node --experimental-wasm-jspi "$here/guest.mjs" metadata
node "$here/pack.mjs" "$build/kwdata.img" "$here/../public/images"
node "$here/verify.mjs" "$here/../public/images"

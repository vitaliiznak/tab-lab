#!/bin/sh
set -eu
mkdir -p /opt/lab/cargo-home /opt/lab/target /opt/cudawg/runtime /work /opt/lab/template/src
cp /stage/template/Cargo.toml /stage/template/Cargo.lock /opt/lab/template/
cp /stage/template/src/main.rs /opt/lab/template/src/
cp /cudawg-src/cudawgc.py /opt/cudawg/
cp /cudawg-src/runtime/cudawg.c /cudawg-src/runtime/cuda_runtime.h /opt/cudawg/runtime/
tar -xzf /inputs/vendor.tgz -C /opt/lab
cat >/opt/lab/cargo-home/config.toml <<'CONFIG'
[source.crates-io]
replace-with = "vendored"
[source.vendored]
directory = "/opt/lab/vendor"
[net]
offline = true
[build]
target-dir = "/opt/lab/target"
CONFIG
cat >/etc/profile.d/tab-lab.sh <<'PROFILE'
export CARGO_HOME=/opt/lab/cargo-home
export CARGO_TARGET_DIR=/opt/lab/target
export CARGO_NET_OFFLINE=true
PROFILE
. /etc/profile.d/tab-lab.sh
chown -R 1000:1000 /opt/lab/target /opt/lab/cargo-home /opt/lab/template /work
cd /opt/lab/template
CARGO_BUILD_JOBS=1 cargo build --frozen
chown -R 1000:1000 /opt/lab/target /opt/lab/cargo-home
cargo run --frozen
for tool in rustfmt cargo-clippy gcc ar python3; do command -v "$tool" || true; done
apk info -vv > /opt/lab/packages.txt
sync

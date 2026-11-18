#!/bin/sh
set -eu
# Build-time networking is confined to this guest by the host builder.
grep -q '/community$' /etc/apk/repositories || sed -n 's@/main$@/community@p' /etc/apk/repositories >> /etc/apk/repositories
apk update
optional=""
for package in rustfmt rust-clippy; do
  if apk search -x "$package" | grep -q "^$package-"; then optional="$optional $package"; fi
done
apk add rust cargo gcc musl-dev python3 $optional
sync
rustc -V
cargo -V

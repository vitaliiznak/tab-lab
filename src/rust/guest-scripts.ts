// These scripts execute inside Linux. All commands, including a manually typed
// cargo run, read the same live workspace and use the toolchain's offline cache.
export const environment =
  [
    "export CARGO_HOME=/opt/lab/cargo-home",
    "export CARGO_TARGET_DIR=/opt/lab/target",
    "export CARGO_NET_OFFLINE=true",
    "export CARGO_TERM_COLOR=always",
    "cd /work",
  ].join("\n") + "\n";

export const config = [
  '[target.\'cfg(all(target_os = "linux", target_arch = "aarch64"))\']',
  "runner = ['sh', '/work/.lab/runner']",
  "",
].join("\n");

export const runner = [
  "#!/bin/sh",
  'if [ -n "$TAB_LAB_TICKET" ]; then',
  "  printf '%s run\\n' \"$TAB_LAB_TICKET\" > /work/.lab/event",
  "fi",
  'exec "$@"',
  "",
].join("\n");

export const actionScript = [
  "#!/bin/sh",
  ". /work/.lab/env || exit 1",
  'export TAB_LAB_TICKET="$2"',
  'event() { printf \'%s %s %s\\n\' "$TAB_LAB_TICKET" "$1" "$2" > /work/.lab/event; }',
  "trap 'event end \"$?\"' EXIT",
  "trap 'exit 130' INT",
  "event start",
  'case "$1" in',
  "  run) cargo run --locked ;;",
  "  release) cargo run --release --locked ;;",
  "  test) cargo test --locked ;;",
  "  clippy) cargo clippy --locked ;;",
  // --emit stdout leaves edits intact on rustfmt errors.
  "  format) rustfmt --edition 2021 --emit stdout <src/main.rs >/tmp/tab-lab-format.rs && cat /tmp/tab-lab-format.rs >src/main.rs ;;",
  "  *) exit 2 ;;",
  "esac",
  "",
].join("\n");

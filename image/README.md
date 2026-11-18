# Offline Rust disk

Run `npm ci` at the repository root, then `./image/build.sh` with Node 24, Cargo and tar on the host. The script downloads the Alpine release paired with the pinned unkernel SDK, creates a temporary 4 GiB sparse ext4 disk from the SDK's `kwdata` template, and installs the aarch64 toolchain in that guest. APK installation uses direct networking during this build.

A second guest boot disables networking. It unpacks the Cargo.lock-pinned crates, builds the template using the guest's own cargo and rustc, runs it, and powers off cleanly. The template, vendored sources, build cache and Cargo config are in `/opt/lab`. The transpiler and C runtime are in `/opt/cudawg`. A third offline boot exports package versions, license identifiers and source locations to `public/images/packages.json`.

`public/images/manifest.json` indexes the raw data disk in 2 MiB logical chunks. Each nonzero chunk is a gzip file named for the SHA-256 of its compressed bytes. A null filename is an all-zero extent with no network payload. The manifest includes each compressed length, the uncompressed size, the SHA-256 of the complete raw disk and the total bytes of unique compressed files. `alpine.erofs` is the separate read-only root image and is served from the same origin. Cargo build artifacts persist for the lifetime of the browser VM through its writable overlay.

The Cargo lockfile and kernel/distro version are pinned. Alpine's v3.24 package repositories receive updates. The package manifest records the exact versions and source revisions installed for each published build.

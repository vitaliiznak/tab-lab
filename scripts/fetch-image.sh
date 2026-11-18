#!/bin/sh
# Restore the exact disk used for the published browser measurements.
set -eu
cd "$(dirname "$0")/.."
archive=$(mktemp)
trap 'rm -f "$archive"' EXIT
curl --fail --location --retry 3 --output "$archive" https://github.com/vitaliiznak/tab-lab/releases/download/toolchain-v1/images.tar
node --input-type=module - "$archive" <<'JS'
import { createReadStream, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const hash = createHash('sha256');
for await (const bytes of createReadStream(process.argv[2])) hash.update(bytes);
if (hash.digest('hex') !== readFileSync('image/release.sha256','utf8').trim()) throw Error('Image archive checksum mismatch');
JS
mkdir -p public/images
tar -xf "$archive" -C public/images

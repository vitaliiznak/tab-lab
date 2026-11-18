// Exercise both static-host behaviours, including a worker restart and a damaged range.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { gzipSync } from "node:zlib";
const hash = (b) => createHash("sha256").update(b).digest("hex");
const parts = [Buffer.alloc(512, 47), Buffer.alloc(512, 209)];
const frames = parts.map((b) => gzipSync(b)),
  packed = Buffer.concat(frames);
const members = frames.map((f, n) => ({
  offset: n ? frames[0].length : 0,
  bytes: f.length,
  sha256: hash(f),
}));
const entry = {
  file: "chunks/" + hash(packed) + ".gz",
  sha256: hash(packed),
  bytes: packed.length,
  members,
};
const manifest = JSON.stringify({
  size: 2048,
  chunkSize: 1024,
  memberSize: 512,
  encoding: "gzip",
  chunks: [entry, { file: null }],
});
const source = readFileSync(
  new URL("../src/rust/image-sw.js", import.meta.url),
  "utf8",
);
const base = "https://test.invalid/tab-lab/";
for (const mode of ["range", "whole", "damaged"]) {
  let listener,
    downloads = 0;
  const cache = new Map();
  const start = () =>
    runInNewContext(source, {
      self: {
        registration: { scope: base },
        addEventListener: (_, fn) => (listener = fn),
      },
      caches: {
        open: async () => ({
          match: (k) => cache.get(k.href)?.clone(),
          put: (k, v) => {
            cache.set(k.href, v.clone());
            return Promise.resolve();
          },
        }),
      },
      URL,
      crypto,
      Response,
      Uint8Array,
      Blob,
      TextDecoder,
      DecompressionStream,
      BroadcastChannel,
      fetch: async (u, { headers } = {}) => {
        if (u.pathname.endsWith("manifest.json")) return new Response(manifest);
        const range = headers.Range.match(/bytes=(\d+)-(\d+)/);
        downloads++;
        if (mode === "whole") return new Response(packed);
        const data = Buffer.from(packed.subarray(+range[1], +range[2] + 1));
        if (mode === "damaged") data[data.length - 1] ^= 1;
        return new Response(data, { status: 206 });
      },
    });
  async function read(from, to) {
    let pending;
    listener({
      request: new Request(base + "images/toolchain.disk?v=" + hash(manifest), {
        headers: { Range: "bytes=" + from + "-" + to },
      }),
      stopImmediatePropagation() {},
      respondWith: (p) => (pending = p),
    });
    return await pending;
  }
  start();
  const result = await read(480, 1099);
  if (mode === "damaged") {
    assert.equal(result.status, 503);
    continue;
  }
  assert.equal(result.status, 206);
  const disk = Buffer.concat([...parts, Buffer.alloc(1024)]);
  assert.deepEqual(
    Buffer.from(await result.arrayBuffer()),
    disk.subarray(480, 1100),
  );
  assert.equal(downloads, mode === "range" ? 2 : 1);
  start();
  assert.deepEqual(
    Buffer.from(await (await read(21, 51)).arrayBuffer()),
    disk.subarray(21, 52),
  );
  assert.equal(downloads, mode === "range" ? 2 : 1);
}
console.log(
  "Image Range reads, whole-chunk fallback, warm cache, sparse extents and checksum failures passed.",
);

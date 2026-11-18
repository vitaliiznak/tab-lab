// Verify both static host behaviours with a fresh worker and after a worker restart.
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { gzipSync } from "node:zlib";
const hash = (b) => createHash("sha256").update(b).digest("hex");
const parts = [Buffer.alloc(512, 47), Buffer.alloc(512, 209)];
const frames = parts.map((b) => gzipSync(b)),
  packed = Buffer.concat(frames);
const entry = {
  file: "chunks/" + hash(packed) + ".bin",
  sha256: hash(packed),
  bytes: packed.length,
  members: frames.map((frame, n) => ({
    offset: n ? frames[0].length : 0,
    bytes: frame.length,
    sha256: hash(frame),
  })),
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
const alpine = new URL("../public/images/alpine.erofs", import.meta.url);

async function exercise(mode, baseImage) {
  const original = baseImage || packed;
  const disk = baseImage || Buffer.concat([...parts, Buffer.alloc(1024)]);
  const cache = new Map();
  const requests = [];
  let listener;
  const start = () =>
    runInNewContext(source, {
      self: {
        registration: { scope: base },
        addEventListener: (_, fn) => (listener = fn),
      },
      caches: {
        open: async () => ({
          match: (key) => cache.get(key.href)?.clone(),
          put: async (key, value) => {
            cache.set(key.href, value.clone());
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
      fetch: async (url, options = {}) => {
        if (url.pathname.endsWith("manifest.json"))
          return new Response(manifest);
        const range = options.headers?.Range;
        requests.push(range ? "range" : "whole");
        if (!range || mode === "ignore-range") {
          const data = Buffer.from(original);
          if (mode === "corrupt-whole") data[data.length - 1] ^= 1;
          return new Response(data);
        }
        const [, from, to] = /^bytes=(\d+)-(\d+)$/.exec(range);
        const data = Buffer.from(original.subarray(+from, +to + 1));
        const headers = {
          "Content-Range": "bytes " + from + "-" + to + "/" + original.length,
        };
        if (mode === "wrong-total")
          headers["Content-Range"] =
            "bytes " + from + "-" + to + "/" + (original.length + 1);
        if (mode === "http-encoded" || mode === "corrupt-whole")
          headers["Content-Encoding"] = "gzip";
        if (mode === "bad-member") data[0] ^= 1;
        const response = new Response(data, { status: 206, headers });
        if (mode === "broken-body")
          response.arrayBuffer = async () => {
            throw Error("Simulated truncated HTTP body");
          };
        return response;
      },
    });
  async function read(from, to) {
    let pending;
    const file = baseImage ? "base.disk" : "toolchain.disk?v=" + hash(manifest);
    listener({
      request: new Request(base + "images/" + file, {
        headers: { Range: "bytes=" + from + "-" + to },
      }),
      stopImmediatePropagation() {},
      respondWith: (p) => (pending = p),
    });
    return pending;
  }
  const from = baseImage ? 262143 : 480,
    to = baseImage ? 262168 : 1099;
  start();
  const result = await read(from, to);
  if (mode === "corrupt-whole") {
    assert.equal(result.status, 503);
    assert.deepEqual(requests, ["range", "whole"]);
    assert.equal(cache.size, 0, "corrupt whole not cached");
    return;
  }
  assert.equal(result.status, 206, mode);
  assert.deepEqual(
    Buffer.from(await result.arrayBuffer()),
    disk.subarray(from, to + 1),
    mode,
  );
  const expected =
    mode === "range"
      ? ["range", "range"]
      : mode === "ignore-range"
        ? ["range"]
        : ["range", "whole"];
  assert.deepEqual(requests, expected, mode);
  start();
  const warm = await read(21, 51);
  assert.equal(warm.status, 206);
  assert.deepEqual(
    Buffer.from(await warm.arrayBuffer()),
    disk.subarray(21, 52),
  );
  assert.deepEqual(requests, expected, "worker restart reuses verified data");
}
for (const mode of [
  "range",
  "ignore-range",
  "http-encoded",
  "wrong-total",
  "broken-body",
  "bad-member",
  "corrupt-whole",
]) {
  await exercise(mode);
  if (existsSync(alpine)) await exercise(mode, readFileSync(alpine));
}
console.log(
  "Range integrity, HTTP encoding, decode failure, whole-asset recovery, corrupt-whole rejection and warm-cache reads passed.",
);

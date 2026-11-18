import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

const [directory] = process.argv.slice(2);
if (!directory) throw new Error("Usage: node image/verify.mjs public/images");
const m = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
if (m.encoding !== "gzip" || m.version !== 1 || m.chunks.length !== Math.ceil(m.size / m.chunkSize)) throw new Error("Invalid manifest");
const used = new Set();
const diskDigest = createHash("sha256");
const zero = Buffer.alloc(m.chunkSize);
let stored = 0;
for (const [i, entry] of m.chunks.entries()) {
  const length = Math.min(m.chunkSize, m.size - i * m.chunkSize);
  if (entry.file === null) {
    if (entry.bytes !== 0) throw new Error("Invalid zero extent at " + i);
    diskDigest.update(zero.subarray(0, length));
    continue;
  }
  if (!/^[a-f0-9]{64}$/.test(entry.sha256) || entry.file !== "chunks/" + entry.sha256 + ".gz") {
    throw new Error("Invalid chunk name at " + i);
  }
  const packed = fs.readFileSync(path.join(directory, entry.file));
  if (packed.length !== entry.bytes || createHash("sha256").update(packed).digest("hex") !== entry.sha256) {
    throw new Error("Chunk checksum mismatch at " + i);
  }
  if (entry.members.length !== Math.ceil(length / m.memberSize)) throw new Error("Invalid member count at " + i);
  let nextOffset = 0;
  for (const [j, member] of entry.members.entries()) {
    const frame = packed.subarray(member.offset, member.offset + member.bytes);
    const expectedLength = Math.min(m.memberSize, length - j * m.memberSize);
    if (member.offset !== nextOffset || frame.length !== member.bytes ||
        createHash("sha256").update(frame).digest("hex") !== member.sha256 ||
        gunzipSync(frame, { maxOutputLength: expectedLength }).length !== expectedLength) {
      throw new Error("Invalid gzip member at " + i + "/" + j);
    }
    nextOffset += member.bytes;
  }
  if (nextOffset !== packed.length) throw new Error("Incomplete member index at " + i);
  const raw = gunzipSync(packed, { maxOutputLength: length });
  if (raw.length !== length) throw new Error("Chunk length mismatch at " + i);
  diskDigest.update(raw);
  if (!used.has(entry.file)) {
    used.add(entry.file);
    stored += packed.length;
  }
}
if (diskDigest.digest("hex") !== m.diskSha256 || stored !== m.compressedBytes) throw new Error("Disk verification failed");
console.log("Verified " + used.size + " compressed chunks, " + stored + " bytes, disk SHA-256 " + m.diskSha256);

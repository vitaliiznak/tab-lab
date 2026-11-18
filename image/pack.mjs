import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
const [source, destination] = process.argv.slice(2);
if (!source || !destination) throw new Error("Usage: node image/pack.mjs kwdata.img public/images");
const chunkSize = 2 * 1024 * 1024;
const memberSize = 256 * 1024;
const size = fs.statSync(source).size;
const chunks = [];
const zero = Buffer.alloc(chunkSize);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const emptyDigest = hash(Buffer.alloc(0));
const diskHash = createHash("sha256");
const fd = fs.openSync(source, "r");
const output = path.join(destination, "chunks");
fs.mkdirSync(output, {recursive:true});
let uniqueBytes = 0;
const unique = new Set();
try {
  for (let offset = 0; offset < size; offset += chunkSize) {
    const block = Buffer.allocUnsafe(Math.min(chunkSize, size - offset));
    if (fs.readSync(fd, block, 0, block.length, offset) !== block.length) throw new Error("Short disk read at " + offset);
    diskHash.update(block);
    if (zero.subarray(0, block.length).equals(block)) {
      chunks.push({file:null,bytes:0,sha256:emptyDigest});
      continue;
    }
    const members = [];
    const frames = [];
    let packedOffset = 0;
    for (let pos = 0; pos < block.length; pos += memberSize) {
      const frame = gzipSync(block.subarray(pos, pos + memberSize), { level: 6 });
      members.push({ offset: packedOffset, bytes: frame.length, sha256: hash(frame) });
      frames.push(frame);
      packedOffset += frame.length;
    }
    const encoded = Buffer.concat(frames, packedOffset);
    const sha256 = hash(encoded);
    const file = "chunks/" + sha256 + ".bin";
    if (!unique.has(file)) {
      const target = path.join(destination, file);
      fs.writeFileSync(target + ".tmp", encoded);
      fs.renameSync(target + ".tmp", target);
      uniqueBytes += encoded.length;
      unique.add(file);
    }
    chunks.push({file,bytes:encoded.length,sha256,members});
  }
} finally { fs.closeSync(fd); }
const manifest = {version:1, size, chunkSize, memberSize, encoding:"gzip", diskSha256:diskHash.digest("hex"), compressedBytes:uniqueBytes, chunks};
fs.writeFileSync(path.join(destination, "manifest.json.tmp"), JSON.stringify(manifest));
fs.renameSync(path.join(destination, "manifest.json.tmp"), path.join(destination, "manifest.json"));
for (const old of fs.readdirSync(output)) {
  if (/^[a-f0-9]{64}\.(?:gz|bin)$/.test(old) && !unique.has("chunks/"+old)) fs.unlinkSync(path.join(output,old));
}
console.log(JSON.stringify({size, compressedBytes:uniqueBytes, files:unique.size, sha256:manifest.diskSha256}));

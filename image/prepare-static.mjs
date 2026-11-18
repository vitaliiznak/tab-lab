// Static hosts may apply HTTP Content-Encoding to .gz files. Preserve the exact
// wire bytes for range verification by publishing them as opaque .bin files.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const directory = process.argv[2] ?? fileURLToPath(new URL("../public/images", import.meta.url));
const manifestFile = path.join(directory, "manifest.json");
if (!fs.existsSync(manifestFile)) process.exit(0);
const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
const legacy = new Map();
let changed = false;

for (const entry of manifest.chunks) {
  if (entry.file === null) continue;
  if (!/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error("Invalid chunk digest");
  const base = "chunks/" + entry.sha256;
  if (entry.file !== base + ".gz" && entry.file !== base + ".bin") throw new Error("Invalid chunk name");
  const oldFile = path.join(directory, base + ".gz");
  const newFile = path.join(directory, base + ".bin");
  if (fs.existsSync(oldFile)) legacy.set(oldFile, { newFile, sha256: entry.sha256 });
  if (entry.file.endsWith(".gz")) {
    if (!fs.existsSync(oldFile) && !fs.existsSync(newFile)) throw new Error("Missing chunk " + entry.file);
    entry.file = base + ".bin";
    changed = true;
  }
}

// Keep both names valid until the manifest swap, including after a partial run.
for (const [oldFile, { newFile, sha256 }] of legacy) {
  if (!fs.existsSync(newFile)) {
    try { fs.linkSync(oldFile, newFile); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  if (createHash("sha256").update(fs.readFileSync(newFile)).digest("hex") !== sha256) {
    throw new Error("Chunk digest mismatch: " + newFile);
  }
}
if (changed) {
  const temporary = manifestFile + "." + process.pid + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(manifest));
  fs.renameSync(temporary, manifestFile);
}
for (const oldFile of legacy.keys()) fs.rmSync(oldFile, { force: true });
if (changed) console.log("Prepared opaque static filenames for " + legacy.size + " compressed chunks.");

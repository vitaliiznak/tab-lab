import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { fetchDistro } from "unkernel/node";
import { loadDuckdbInputs } from "../experiments/duckdb/assets.mjs";

const assets = new URL("../public/data-runtime/", import.meta.url);
const images = new URL("../public/images/", import.meta.url);
const alpine = new URL("alpine.erofs", images);
const baseHash =
  "f05a6163bad2547790a92ba1accfa317881d0306694d719202aa39afc39669f6";

async function publish(file, bytes) {
  const temporary = new URL(file.href + "." + randomUUID() + ".part");
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

function verifyAlpine(bytes) {
  if (createHash("sha256").update(bytes).digest("hex") !== baseHash)
    throw Error("Unexpected Alpine base image");
}

async function prepareAlpine() {
  try {
    verifyAlpine(await readFile(alpine));
    return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  // A data-only checkout needs the Alpine base, without the Rust image.
  const bytes = await readFile(await fetchDistro("alpine"));
  verifyAlpine(bytes);
  await mkdir(images, { recursive: true });
  await publish(alpine, bytes);
}

const [{ binary, packages }] = await Promise.all([
  loadDuckdbInputs(),
  prepareAlpine(),
]);
await mkdir(assets, { recursive: true });
// An opaque filename prevents static hosts from transparently decoding gzip.
await Promise.all([
  publish(new URL("duckdb-1.5.6.bin", assets), gzipSync(binary)),
  ...packages.map(({ name, data }) => publish(new URL(name, assets), data)),
]);

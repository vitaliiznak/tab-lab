import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const version = "1.5.6";
const cache = join(
  process.env.TAB_LAB_CACHE_DIR ||
    process.env.XDG_CACHE_HOME ||
    join(homedir(), ".cache"),
  "tab-lab",
  "duckdb",
  version,
);
const assets = [
  {
    name: "duckdb.zip",
    url: `https://github.com/duckdb/duckdb/releases/download/v${version}/duckdb_cli-linux-arm64-musl.zip`,
    sha: "70f55385c1d42bc34c8865f4d5c606215545cb38c03a4c86a87f17d17773a3a3",
  },
  {
    name: "libgcc-15.2.0-r5.apk",
    sha: "369aaa6e9d099a737bad6dd3e6c2fe7bb1547ca26d22b94ee0411228f709b403",
  },
  {
    name: "libstdc++-15.2.0-r5.apk",
    sha: "2302e766d4e4926038ec166ecb85837ee884576115236ddb565e3a5fca4a11d7",
  },
];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function cached(asset) {
  if (asset.name.endsWith(".apk")) {
    const data = await readFile(
      new URL("./packages/" + asset.name, import.meta.url),
    );
    if (digest(data) !== asset.sha)
      throw Error("SHA-256 mismatch for " + asset.name);
    return data;
  }
  const filename = join(cache, asset.name);
  try {
    const data = await readFile(filename);
    if (digest(data) === asset.sha) return data;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  console.error("Downloading " + asset.name);
  const response = await fetch(asset.url, {
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok)
    throw Error(asset.name + " returned HTTP " + response.status);
  const data = new Uint8Array(await response.arrayBuffer());
  if (digest(data) !== asset.sha)
    throw Error("SHA-256 mismatch for " + asset.name);
  const temp = filename + "." + randomUUID() + ".part";
  try {
    await writeFile(temp, data, { flag: "wx" });
    await rename(temp, filename);
  } finally {
    await rm(temp, { force: true });
  }
  return data;
}

export async function loadDuckdbInputs() {
  await mkdir(cache, { recursive: true });
  const [, ...packages] = await Promise.all(assets.map(cached));
  const binary = execFileSync(
    "unzip",
    ["-p", join(cache, assets[0].name), "duckdb"],
    {
      maxBuffer: 80 * 1024 * 1024,
    },
  );
  if (
    digest(binary) !==
    "5f0360c99938ffe94d250aeab726a06fe7e793d9b0c6f496fac9f178f5d49e66"
  )
    throw Error("Unexpected DuckDB CLI binary");
  return {
    binary,
    packages: packages.map((data, i) => ({ name: assets[i + 1].name, data })),
  };
}

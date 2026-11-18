// Assemble the already verified static disk for the GitHub release. No guest state
// or host directories beyond the four public image components enter the archive.
import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
const output = process.argv[2];
if (!output)
  throw Error("Usage: node scripts/pack-release.mjs /path/to/images.tar");
execFileSync(process.execPath, ["image/verify.mjs", "public/images"], {
  stdio: "inherit",
});
const archive = resolve(output);
execFileSync(
  "tar",
  [
    "-cf",
    archive,
    "-C",
    "public/images",
    "alpine.erofs",
    "packages.json",
    "manifest.json",
    "chunks",
  ],
  { env: { ...process.env, COPYFILE_DISABLE: "1" } },
);
const hash = createHash("sha256");
for await (const part of createReadStream(archive)) hash.update(part);
await writeFile("image/release.sha256", hash.digest("hex") + "\n");

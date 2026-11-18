import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
await mkdir("public/licenses", { recursive: true });
for (const [source, name] of [
  ["unkernel/LICENSE", "kernel-GPL-2.txt"],
  ["unkernel/LICENSE-MIT", "unkernel-MIT.txt"],
  ["coi-serviceworker/LICENSE", "coi-MIT.txt"],
  ["@xterm/xterm/LICENSE", "xterm-MIT.txt"],
  ["@fontsource-variable/space-grotesk/LICENSE", "space-grotesk-OFL.txt"],
  ["@fontsource/ibm-plex-mono/LICENSE", "plex-OFL.txt"],
  ["codemirror/LICENSE", "codemirror-MIT.txt"],
]) {
  await copyFile("node_modules/" + source, "public/licenses/" + name);
}
const coi = await readFile(
  "node_modules/coi-serviceworker/coi-serviceworker.js",
  "utf8",
);
// The disk Range handler must see virtual disk requests before COI wraps ordinary fetches.
await writeFile(
  "public/coi-serviceworker.js",
  "if (typeof window === 'undefined') importScripts('./rust-image-sw.js');\n" +
    coi,
);
await copyFile("src/rust/image-sw.js", "public/rust-image-sw.js");

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createKernel, fetchDistro, bundledBoot, createImageFromKwsparse } from "unkernel/node";

const here = path.dirname(fileURLToPath(import.meta.url));
const input = file => fs.readFileSync(path.join(here, file));
const stage = process.argv[2];
const buildDir = process.env.TAB_LAB_BUILD_DIR;
if (!buildDir || !["packages", "prepare", "metadata", "inspect"].includes(stage)) {
  throw new Error("Use image/build.sh or set TAB_LAB_BUILD_DIR and select packages, prepare, metadata or inspect.");
}

const out = path.resolve(here, "../public/images");
fs.mkdirSync(out, { recursive: true });
const distro = await fetchDistro("alpine");
if (stage === "packages") fs.copyFileSync(distro, path.join(out, "alpine.erofs"));
const disk = path.resolve(buildDir, "kwdata.img");
if (!fs.existsSync(disk)) {
  const kernel = fs.readFileSync(new URL(import.meta.resolve("unkernel/unkernel.wasm")));
  const module = await WebAssembly.compile(kernel);
  await createImageFromKwsparse(disk, bundledBoot(module).datadisk);
}

const options = {
  worker: true, cpus: 1, memoryMiB: 2048, distro,
  disks: [{ kind: "file", path: disk }],
  onProgress: p => console.log(p.stage),
};
// Only APK installation uses the network. The subsequent, offline boot catches missing dependencies.
if (stage === "packages") options.net = { kind: "net", backend: { kind: "direct" } };
const vm = await createKernel(options);
try {
  if (stage === "metadata") {
    const result = await vm.exec("python3", ["-c", input("metadata.py").toString()], { user: "root" });
    if (result.exitCode !== 0) throw new Error(result.stderr);
    const licenses = JSON.parse(result.stdout);
    fs.writeFileSync(path.join(out, "packages.json"), JSON.stringify(licenses, null, 2) + "\n");
  } else {
    if (stage === "packages") await vm.mount("/stage", { "packages.sh": input("packages.sh") });
    if (stage === "prepare") {
      const template = {
        "Cargo.toml": input("template/Cargo.toml"),
        "Cargo.lock": input("template/Cargo.lock"),
        src: { "main.rs": input("template/src/main.rs") },
      };
      await vm.mount("/stage", { "prepare.sh": input("prepare.sh"), template });
      await vm.mount("/inputs", { "vendor.tgz": fs.readFileSync(path.join(buildDir, "vendor.tgz")) });
      await vm.mount("/cudawg-src", {
        "cudawgc.py": input("../cudawg/cudawgc.py"),
        runtime: {
          "cudawg.c": input("../cudawg/runtime/cudawg.c"),
          "cuda_runtime.h": input("../cudawg/runtime/cuda_runtime.h"),
        },
      });
    }
    const args = stage === "inspect" ? ["-lc", process.argv[3]] : ["/stage/" + stage + ".sh"];
    const proc = await vm.spawn("/bin/sh", args, { pty: false, user: "root" });
    async function pump(stream, sink) {
      for await (const part of stream) sink.write(part);
    }
    const [exit] = await Promise.all([proc.ended, pump(proc.stdout, process.stdout), pump(proc.stderr, process.stderr)]);
    if (exit.code !== 0) process.exitCode = 1;
  }
  const deadline = new Promise((_, reject) => {
    setTimeout(() => reject(new Error("Guest poweroff timed out")), 30000).unref();
  });
  vm.write("poweroff\n");
  const result = await Promise.race([vm.exited, deadline]);
  if (result.code !== 0) throw new Error("Guest shutdown failed: " + JSON.stringify(result));
} finally {
  vm.stop();
}

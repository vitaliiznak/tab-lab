import type { KernelHandle, MemoryFs } from "unkernel/web";
import launcher from "./work-mount.py?raw";

// The SDK looks up its 9p client on the guest PATH. Supply our mount options
// for /work during that call. The image's own client stays intact.
export async function mountWorkspace(vm: KernelHandle, fs: MemoryFs) {
  const path = "/run/kw/bin/kw9p";
  const install = await vm.exec(
    "sh",
    [
      "-c",
      "mkdir -p /run/kw/bin && (set -C; cat > /run/kw/bin/kw9p) && chmod 755 /run/kw/bin/kw9p",
    ],
    { user: "root", input: launcher },
  );
  if (install.exitCode !== 0)
    throw Error("Cannot prepare the live editor mount. " + install.stderr);
  try {
    await vm.mount("/work", fs);
  } finally {
    await vm.exec("rm", [path], { user: "root" });
  }
}

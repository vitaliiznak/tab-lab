import { MemoryFs } from "unkernel/web";
import { assetUrl, command, report, start, terminalSize, lab } from "./boot";
const commands = ["nvidia-smi", "vecadd", "matmul", "reduce", "tunnel"];
void start(async () => {
  report("Loading CUDA programs…");
  const fs = new MemoryFs();
  await Promise.all(
    commands.map(async (name) => {
      const r = await fetch(assetUrl("cuda/" + name));
      if (!r.ok) throw new Error("Could not load " + name);
      fs.writeFile("/" + name, new Uint8Array(await r.arrayBuffer()), {
        mode: 0o755,
      });
    }),
  );
  return {
    options: { mounts: { "/opt/cuda": fs } },
    cwd: "/opt/cuda",
    env: { PATH: "/opt/cuda:/usr/local/bin:/usr/bin:/bin:/sbin" },
    adapter: (name) => fs.writeFile("/adapter.txt", name + "\n"),
    connect: async (vm, pty) => {
      // Some 9p configurations mark the mount noexec. Probe before exposing shortcuts.
      const probe = await vm.exec(
        "/bin/sh",
        ["-c", "/opt/cuda/nvidia-smi >/dev/null"],
        { user: "root" },
      );
      if (probe.exitCode !== 0) {
        const copied = await vm.exec("/bin/sh", [
          "-c",
          "mkdir -p /tmp/cuda && cp /opt/cuda/* /tmp/cuda/ && chmod +x /tmp/cuda/*",
        ]);
        if (copied.exitCode)
          throw Error(copied.stderr || "Could not prepare CUDA programs");
        await pty.write("export PATH=/tmp/cuda:$PATH\n");
      }
      function tunnelCommand(frames?: number) {
        const { cols, rows } = terminalSize();
        const width = Math.max(1, Math.min(cols - 1, 100));
        const height = Math.max(6, Math.min(rows - 2, 32));
        return `tunnel ${width} ${height}${frames ? " " + frames : ""}\n`;
      }
      for (const button of document.querySelectorAll<HTMLButtonElement>(
        "[data-cmd]",
      )) {
        const cmd = button.dataset.cmd!;
        button.disabled =
          !lab.gpu && !["nvidia-smi", "interrupt"].includes(cmd);
        button.onclick = () => {
          command(
            cmd === "interrupt"
              ? "\x03"
              : cmd === "tunnel"
                ? tunnelCommand()
                : cmd + "\n",
          );
        };
      }
      if (lab.gpu && new URLSearchParams(location.search).get("demo") === "tunnel")
        command(tunnelCommand(90));
    },
  };
});

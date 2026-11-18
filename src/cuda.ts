import { MemoryFs } from "unkernel/web";
import { assetUrl, command, report, start, terminalSize, setShellInputFilter, lab } from "./boot";
import { connectFlight } from "./flight";

const commands = ["nvidia-smi", "vecadd", "matmul", "reduce", "tunnel"];

// Signals go to the foreground process group. The marker is written only after
// Linux has installed the traps, so even an immediate click can stop a replay.
const playTunnel = `#!/bin/sh
state=/opt/cuda/.replay-state
trap 'echo idle > "$state"' EXIT
trap 'exit 130' INT TERM
echo playing > "$state"
"$@"
`;

void start(async () => {
  report("Loading CUDA programs…");
  const fs = new MemoryFs({ ".replay": playTunnel, ".replay-state": "" });
  await Promise.all(commands.map(async name => {
    // The canvas client requires the binary with the --screen presentation mode.
    const asset = name === "tunnel" ? "cuda/tunnel?v=screen1" : "cuda/" + name;
    const response = await fetch(assetUrl(asset));
    if (!response.ok) throw new Error("Could not load " + name);
    fs.writeFile("/" + name, new Uint8Array(await response.arrayBuffer()), { mode: 0o755 });
  }));
  return {
    options: { mounts: { "/opt/cuda": fs } },
    cwd: "/opt/cuda",
    env: { PATH: "/opt/cuda:/usr/local/bin:/usr/bin:/bin:/sbin" },
    adapter: name => fs.writeFile("/adapter.txt", name + "\n"),
    connect: async (vm, pty) => {
      let bin = "/opt/cuda";
      const probe = await vm.exec("/bin/sh", ["-c", "/opt/cuda/nvidia-smi >/dev/null"], { user: "root" });
      if (probe.exitCode !== 0) {
        bin = "/tmp/cuda";
        const copied = await vm.exec("/bin/sh", ["-c", "mkdir -p /tmp/cuda && cp /opt/cuda/* /tmp/cuda/ && chmod +x /tmp/cuda/*"]);
        if (copied.exitCode) throw Error(copied.stderr || "Could not prepare CUDA programs");
        await pty.write("export PATH=/tmp/cuda:$PATH\n");
      }

      let replay: {
        started: boolean;
        stopping: boolean;
        done: Promise<void>;
        finish: () => void;
      } | undefined;
      document.body.dataset.tunnelState = "idle";
      function finish() {
        replay?.finish();
        replay = undefined;
        document.body.dataset.tunnelState = "idle";
      }
      function sendInterrupt() {
        void pty.write("\x03").catch(finish);
      }
      const detach = fs.onChange(change => {
        if (!replay || change.type !== "write" || change.path !== "/.replay-state") return;
        const state = fs.readText(change.path).trim();
        if (state === "idle") finish();
        if (state === "playing" && replay) {
          replay.started = true;
          if (replay.stopping) sendInterrupt();
        }
      });
      setShellInputFilter(input => {
        // Deliver a keyboard Ctrl+C after the guest has installed its trap.
        // Ordinary typed commands stay in this PTY and run when the finite
        // foreground job exits, as they would in a native interactive shell.
        if (input !== "\x03" || !replay || replay.started) return false;
        replay.stopping = true;
        return true;
      });
      void pty.ended.catch(() => {}).finally(() => {
        detach();
        setShellInputFilter();
        finish();
      });

      function play() {
        const { cols, rows } = terminalSize();
        const width = Math.max(1, Math.min(cols - 1, 100));
        const height = Math.max(1, Math.min(rows - 2, 32));
        let resolve!: () => void;
        const done = new Promise<void>(r => { resolve = r; });
        replay = { started: false, stopping: false, done, finish: resolve };
        document.body.dataset.tunnelState = "running";
        // Write straight to the PTY: automated playback must not focus xterm
        // or summon a phone keyboard. On exit the same real shell prints PS1.
        void pty.write(`sh /opt/cuda/.replay ${bin}/tunnel ${width} ${height} 90\n`).catch(finish);
      }

      let queued = Promise.resolve();
      function select(name: string) {
        queued = queued.then(async () => {
          const current = replay;
          if (current) {
            current.stopping = true;
            if (current.started) sendInterrupt();
            await current.done;
          }
          if (name === "tunnel") play();
          else if (name === "interrupt") {
            if (!current) command("\x03");
          } else command(name + "\n");
        }).catch(error => { report(String(error)); });
      }
      for (const button of document.querySelectorAll<HTMLButtonElement>("[data-cmd]")) {
        const name = button.dataset.cmd!;
        button.disabled = !lab.gpu && name !== "nvidia-smi" && name !== "interrupt";
        button.onclick = () => select(name);
      }

      if (document.querySelector("#flight-canvas")) {
        connectFlight(vm, bin + "/tunnel");
      } else {
        const params = new URLSearchParams(location.search);
        if (lab.gpu && !["1", "compare"].includes(params.get("inspect") ?? "") && params.get("demo") !== "shell")
          play();
      }
    },
  };
});

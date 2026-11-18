import kernelUrl from "unkernel/unkernel.wasm?url";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  checkSupport,
  createKernel,
  type CreateKernelOptions,
  type KernelHandle,
  type Pty,
} from "unkernel/web";
import { attachCudawg } from "../cudawg/host/unkernel.js";

export function assetUrl(path: string) {
  const root = document.querySelector<HTMLMetaElement>('meta[name="lab-root"]')?.content ?? "../";
  return new URL(path, new URL(root, document.baseURI)).href;
}
const byId = (id: string) => document.getElementById(id)!;
export function report(message: string) {
  byId("status").textContent = message;
}
const term = new Terminal({
  theme: {
    background: "#0c100d",
    foreground: "#d9dfd3",
    cursor: "#c2f482",
    green: "#c2f482",
    brightGreen: "#c2f482",
    magenta: "#c2acf8",
  },
  fontFamily: '"IBM Plex Mono", monospace',
  fontSize: 13,
  lineHeight: 1.14,
  scrollback: 1500,
  cursorBlink: false,
  convertEol: false,
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open(byId("terminal"));
let vm: KernelHandle | undefined,
  pty: Pty | undefined,
  actionPty: Pty | undefined,
  closeGPU: (() => void) | undefined;
const resize = new ResizeObserver(() => {
  fit.fit();
  (actionPty ?? pty)?.resize(term.cols, term.rows);
});
resize.observe(byId("terminal"));
fit.fit();
const decoder = new TextDecoder();
export const lab = {
  ready: false,
  output: "",
  bootMs: 0,
  cpus: 0,
  memoryMiB: 0,
  gpu: false,
  async stop() {
    this.ready = false;
    resize.disconnect();
    closeGPU?.();
    if (vm) await vm.stop();
  },
};
Object.assign(window, { tabLab: lab });
window.addEventListener(
  "pagehide",
  () => {
    void lab.stop();
  },
  { once: true },
);
// pagehide releases the kernel, including on a navigation the browser caches.
window.addEventListener("pageshow", (event) => {
  if (event.persisted) location.reload();
});
export function setActionPty(active?: Pty) {
  actionPty = active;
  if (active) {
    active.resize(term.cols, term.rows);
    term.focus();
  }
}
export function writeTerminal(text: string | Uint8Array) {
  const printable =
    typeof text === "string" ? text : decoder.decode(text, { stream: true });
  lab.output = (lab.output + printable).slice(-400000);
  return new Promise<void>((resolve) => term.write(text, resolve));
}
let shellInputFilter: ((data: string) => boolean) | undefined;
export function setShellInputFilter(filter?: (data: string) => boolean) {
  shellInputFilter = filter;
}
term.onData((data) => {
  if (!actionPty && shellInputFilter?.(data)) return;
  void (actionPty ?? pty)?.write(data).catch(() => {});
});
export function command(cmd: string) {
  if (pty) {
    void pty.write(cmd).catch(() => {});
    if (!matchMedia("(pointer: coarse)").matches) term.textarea?.focus({ preventScroll: true });
  }
}
export function terminalSize() {
  return { cols: term.cols, rows: term.rows };
}
export type LabSetup = {
  options: CreateKernelOptions;
  connect?: (vm: KernelHandle, pty: Pty) => Promise<unknown> | unknown;
  adapter?: (name: string) => void;
  cwd: string;
  env?: Record<string, string>;
};
// The route lookup asks the local kernel and sends no packets.
// Only the originating tab creates a marker, so the comparison is independent.
async function inspectGuest(machine: KernelHandle, button: HTMLButtonElement) {
  const proof = byId("guest-proof");
  const compare = byId("guest-compare");
  const secondGuest = new URLSearchParams(location.search).get("inspect") === "compare";
  compare.hidden = true;
  button.disabled = true;
  proof.hidden = false;
  proof.textContent = "Reading the running guest…";
  const script = [
    "printf '$ uname -srm\\n'",
    "uname -srm",
    "printf '\\n$ ls /sys/class/net\\n'",
    "ls -1 /sys/class/net",
    "printf '\\n$ ip route get 192.0.2.1  # local route lookup\\n'",
    "ip route get 192.0.2.1 2>&1 || true",
    "printf '\\n$ cat /proc/sys/kernel/random/boot_id\\n'",
    "cat /proc/sys/kernel/random/boot_id",
    secondGuest
      ? "printf '\\n$ ls /tmp/tab-lab-marker\\n'; ls /tmp/tab-lab-marker 2>&1 || true"
      : "printf '\\n$ touch /tmp/tab-lab-marker && ls /tmp/tab-lab-marker\\n'; touch /tmp/tab-lab-marker && ls /tmp/tab-lab-marker",
  ].join("\n");
  try {
    const result = await machine.exec("/bin/sh", ["-ec", script]);
    if (result.exitCode) throw Error(result.stderr || "Guest inspection failed.");
    proof.textContent = result.stdout.trimEnd();
    if (secondGuest) {
      compare.querySelector("span")!.textContent =
        "Compare the boot ID and the marker above with the first tab to see each guest’s own kernel and filesystem.";
      compare.querySelector("a")!.hidden = true;
    }
    compare.hidden = false;
  } catch (error) {
    proof.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    button.disabled = !lab.ready;
  }
}
export async function start(prepare: () => Promise<LabSetup>) {
  const started = performance.now();
  const kind = document.body.dataset.lab;
  const rust = kind === "rust";
  const usesDisk = rust || kind === "data";
  const inspectButton = byId("inspect-guest") as HTMLButtonElement;
  writeTerminal("\x1b[38;2;167;178;163mBooting Linux…\x1b[0m\r\n");
  try {
    const support = await checkSupport();
    if (!support.ok) throw new Error(support.problems.join(" "));
    // Wait for the first Pages navigation to install the isolation worker and reload.
    if (
      !navigator.serviceWorker?.controller &&
      (usesDisk || !crossOriginIsolated) &&
      isSecureContext &&
      "serviceWorker" in navigator
    ) {
      report("Preparing the local service worker…");
      // Hosts that supply isolation headers still need the disk Range handler.
      await navigator.serviceWorker.register(assetUrl("coi-serviceworker.js"));
      if (!navigator.serviceWorker.controller) {
        await Promise.race([
          new Promise<void>((r) =>
            navigator.serviceWorker.addEventListener(
              "controllerchange",
              () => r(),
              { once: true },
            ),
          ),
          new Promise<void>((r) => setTimeout(r, 7000)),
        ]);
      }
    }
    if (usesDisk && !navigator.serviceWorker?.controller)
      throw new Error(
        "The offline disk needs a service worker. Allow site storage in this browser and reload.",
      );
    const setup = await prepare();
    const request = new URLSearchParams(location.search).get("cpus");
    const cpus =
      rust && crossOriginIsolated
        ? Math.min(request === "1" ? 1 : 4, navigator.hardwareConcurrency || 1)
        : 1;
    report("Starting the ARM64 guest…");
    vm = await createKernel({
      ...setup.options,
      kernel: new URL(kernelUrl, document.baseURI).href,
      worker: true,
      cpus,
      memoryMiB: setup.options.memoryMiB ?? (rust ? 2048 : 192),
      memoryFallbackMiB: setup.options.memoryFallbackMiB ?? (rust ? [1024] : [128]),
      onProgress: (p) => report("Linux · " + p.stage + "…"),
    });
    const machine = vm;
    let name = "WebGPU unavailable";
    if (kind !== "data" && navigator.gpu) {
      try {
        const gpu = await attachCudawg(machine, navigator.gpu, {
          canvas: document.querySelector<HTMLCanvasElement>('#flight-canvas') ?? undefined,
          log: (msg?: string) => report("GPU · " + (msg || "Device event")),
        });
        closeGPU = () => gpu.close();
        lab.gpu = true;
        const info = gpu.adapter.info;
        name =
          info?.description ||
          [info?.vendor, info?.architecture].filter(Boolean).join(" · ") ||
          "Adapter details withheld by browser";
      } catch {
        /* The terminal and CPU examples also run without an adapter. */
      }
    }
    setup.adapter?.(name);
    if (kind !== "data") byId("gpu-missing").hidden = lab.gpu;
    report("Opening the guest shell…");
    const env = {
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      PS1: "\\[\\033[1;32m\\]guest\\[\\033[0m\\]:\\w $ ",
      ...setup.env,
    };
    if (kind === "cuda") {
      writeTerminal(
        lab.gpu
          ? "\x1b[38;2;194;244;130mCUDA programs mounted at /opt/cuda.\x1b[0m\r\n"
          : "WebGPU unavailable. You can use the shell or play the tunnel recording.\r\n",
      );
    }
    pty = await machine.spawn("/bin/sh", ["-i"], {
      user: "root",
      cwd: setup.cwd,
      env,
      cols: term.cols,
      rows: term.rows,
      timeout: 120000,
    });
    const manualShell = pty;
    void manualShell.ended.then(() => {
      if (pty !== manualShell) return;
      pty = undefined;
      byId("signal").className = "";
      report("Shell closed · reload to reopen");
      for (const button of document.querySelectorAll<HTMLButtonElement>("[data-cmd]")) button.disabled = true;
    }).catch(() => {});
    void pty.output
      .pipeTo(
        new WritableStream<Uint8Array>({
          write(b) {
            lab.output = (
              lab.output + decoder.decode(b, { stream: true })
            ).slice(-400000);
            return new Promise<void>((r) => term.write(b, r));
          },
        }),
      )
      .catch(() => {});
    await setup.connect?.(machine, pty);
    lab.bootMs = performance.now() - started;
    lab.cpus = machine.stats().cpus || cpus;
    lab.memoryMiB = machine.memoryMiB;
    lab.ready = true;
    byId("signal").className = "ready";
    report("Shell ready");
    inspectButton.disabled = false;
    inspectButton.onclick = () => void inspectGuest(machine, inspectButton);
    if (["1", "compare"].includes(new URLSearchParams(location.search).get("inspect") ?? ""))
      void inspectGuest(machine, inspectButton);
    byId("machine").textContent =
      lab.cpus +
      " vCPU · " +
      lab.memoryMiB +
      " MiB · " +
      (lab.bootMs / 1000).toFixed(1) +
      " s boot";
    void machine.exited.then((exit) => {
      lab.ready = false;
      inspectButton.disabled = true;
      byId("signal").className = "";
      report("Guest stopped · " + (exit.reason || exit.code));
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    byId("signal").className = "error";
    report("Boot failed");
    const flight = document.querySelector<HTMLCanvasElement>("#flight-canvas");
    if (flight) {
      flight.hidden = true;
      byId("flight-status").textContent = "Linux could not start: " + msg;
      byId("gpu-missing").hidden = false;
    }
    writeTerminal("\r\n" + msg + "\r\nReload the page to retry.\r\n");
    await vm?.stop();
  }
}

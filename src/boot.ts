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
  return new URL(path, new URL("../", document.baseURI)).href;
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
term.onData((data) => {
  void (actionPty ?? pty)?.write(data);
});
export function command(cmd: string) {
  if (pty) {
    void pty.write(cmd);
    term.focus();
  }
}
export function terminalSize() {
  return { cols: term.cols, rows: term.rows };
}
type LabSetup = {
  options: CreateKernelOptions;
  connect?: (vm: KernelHandle, pty: Pty) => Promise<unknown> | unknown;
  adapter?: (name: string) => void;
  cwd: string;
  env?: Record<string, string>;
};
export async function start(prepare: () => Promise<LabSetup>) {
  const started = performance.now(),
    rust = document.body.dataset.lab === "rust";
  writeTerminal("\x1b[38;2;167;178;163mBooting Linux…\x1b[0m\r\n");
  try {
    const support = await checkSupport();
    if (!support.ok) throw new Error(support.problems.join(" "));
    // Wait for the first Pages navigation to install the isolation worker and reload.
    if (
      !navigator.serviceWorker?.controller &&
      (rust || !crossOriginIsolated) &&
      isSecureContext &&
      "serviceWorker" in navigator
    ) {
      report("Preparing the local service worker…");
      // Hosts that supply isolation headers still need the disk Range handler for Rust.
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
    if (rust && !navigator.serviceWorker?.controller)
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
      memoryMiB: rust ? 2048 : 192,
      memoryFallbackMiB: rust ? [1024] : [128],
      onProgress: (p) => report("Linux · " + p.stage + "…"),
    });
    const machine = vm;
    let name = "WebGPU unavailable";
    if (navigator.gpu) {
      try {
        const gpu = await attachCudawg(machine, navigator.gpu, {
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
    byId("gpu-missing").hidden = lab.gpu;
    report("Opening the guest shell…");
    const env = {
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      PS1: "\\[\\033[1;32m\\]guest\\[\\033[0m\\]:\\w $ ",
      ...setup.env,
    };
    if (!rust) {
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
    byId("machine").textContent =
      lab.cpus +
      " vCPU · " +
      lab.memoryMiB +
      " MiB · " +
      (lab.bootMs / 1000).toFixed(1) +
      " s boot";
    void machine.exited.then((exit) => {
      lab.ready = false;
      byId("signal").className = "";
      report("Guest stopped · " + (exit.reason || exit.code));
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    byId("signal").className = "error";
    report("Boot failed");
    writeTerminal("\r\n" + msg + "\r\nReload the page to retry.\r\n");
    await vm?.stop();
  }
}

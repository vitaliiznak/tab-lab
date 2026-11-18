import {
  MemoryFs,
  type CreateKernelOptions,
  type KernelHandle,
  type Pty,
} from "unkernel/web";
import { mountWorkspace } from "./mount";
import { createEditor } from "./editor";
import { actionScript, config, environment, runner } from "./guest-scripts";
import { readHash, shareHash, type SourceFile, type GpuFiles } from "./share";
import toml from "../../image/template/Cargo.toml?raw";
import lock from "../../image/template/Cargo.lock?raw";
import hello from "./examples/hello.rs?raw";
import json from "./examples/json.rs?raw";
import rayon from "./examples/rayon.rs?raw";
import query from "./examples/query.rs?raw";
import fractal from "./examples/fractal.rs?raw";
import build from "./examples/build.rs?raw";
import kernels from "./examples/kernels.cu?raw";

const examples = {
  hello: { label: "Hello + iterators", source: hello },
  json: { label: "Transform JSON", source: json },
  rayon: { label: "Parallel sum", source: rayon },
  query: { label: "CSV query engine", source: query },
  fractal: { label: "Rust + CUDA · Mandelbrot", source: fractal },
};
type Example = keyof typeof examples;
type Setup = {
  assetUrl(path: string): string;
  hasGpu?(): boolean;
  report(text: string): void;
  writeTerminal(s: string | Uint8Array): Promise<void> | void;
  setActionPty?(process: Pty | undefined): void;
};
type Action = "run" | "release" | "test" | "clippy" | "format";
type Timing = {
  ticket: string;
  action: Action;
  example: Example;
  start: number;
  run?: number;
  end?: number;
};

const seconds = (ms: number) => (ms / 1000).toFixed(ms < 1000 ? 3 : 1) + " s";
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export async function prepareRust({
  assetUrl,
  report,
  writeTerminal,
  setActionPty,
  hasGpu = () => !!navigator.gpu,
}: Setup) {
  const status = document.querySelector<HTMLElement>("#rust-stats")!;
  const select = document.querySelector<HTMLSelectElement>("#rust-example")!;
  const buttons = [
    ...document.querySelectorAll<HTMLButtonElement>("[data-rust-action]"),
  ];
  const stats = status.dataset;
  stats.state = "booting";
  stats.seq = "0";
  const requested = new URLSearchParams(location.search).get("example");
  let chosen: Example =
    requested && Object.hasOwn(examples, requested)
      ? (requested as Example)
      : "hello";
  const requestedFile = new URLSearchParams(location.search).get("file");
  let activeFile: SourceFile =
    chosen === "fractal" && (requestedFile === "kernels.cu" || requestedFile === "build.rs")
      ? requestedFile : "src/main.rs";
  let gpuFiles: GpuFiles = { "kernels.cu": kernels, "build.rs": build };
  const fileTabs = [
    ...document.querySelectorAll<HTMLButtonElement>("[data-rust-file]"),
  ];
  const cpuChoice =
    document.querySelector<HTMLButtonElement>("#rust-cpu-choice")!;
  const heading = document.getElementById("rust-heading")!;
  const description = document.getElementById("rust-description")!;
  const featureLink = document.getElementById("rust-feature-link")!;
  let pty: Pty | undefined;
  let machine: KernelHandle | undefined;
  let hardware = "";
  let hasFormat = false,
    hasClippy = false;
  let running: Timing | undefined;
  let firstBuild = true;
  let sharedCode: string | undefined;
  try {
    const shared = await readHash(location.hash);
    if (shared) {
      if (!Object.hasOwn(examples, shared.example))
        throw Error("Unknown example in shared link.");
      chosen = shared.example as Example;
      sharedCode = shared.code;
      if (shared.files) gpuFiles = shared.files;
      activeFile = shared.file ?? "src/main.rs";
    }
  } catch (error) {
    status.textContent = "Shared link could not be read. " + errorText(error);
  }

  const workspace = new MemoryFs({
    "Cargo.toml": toml,
    "Cargo.lock": lock,
    ...(chosen === "fractal" ? gpuFiles : {}),
    ".lab": { env: environment, action: actionScript, runner, event: "" },
    ".cargo": { "config.toml": config },
    src: { "main.rs": sharedCode ?? examples[chosen].source },
  });
  // The interactive shell can rename or remove files while their tab is open.
  // An empty editor lets the visitor re-create such a file with the next edit.
  function source(file: SourceFile) {
    return workspace.exists(file) ? workspace.readText(file) : "";
  }
  const compareLink = document.querySelector<HTMLAnchorElement>("#guest-compare a")!;
  const linkNote = document.getElementById("rust-link-note")!;
  const linkHint = linkNote.textContent;
  let linkRevision = 0;
  let linkTimer: ReturnType<typeof setTimeout>;
  async function updateLink() {
    clearTimeout(linkTimer);
    const revision = ++linkRevision;
    const url = new URL(location.href);
    url.searchParams.set("example", chosen);
    if (activeFile === "src/main.rs") url.searchParams.delete("file");
    else url.searchParams.set("file", activeFile);
    const code = source("src/main.rs");
    const files = chosen === "fractal"
      ? { "kernels.cu": source("kernels.cu"), "build.rs": source("build.rs") }
      : undefined;
    const edited = code !== examples[chosen].source ||
      (files && (files["kernels.cu"] !== kernels || files["build.rs"] !== build));
    let failure: unknown;
    try {
      url.hash = edited ? await shareHash(chosen, code, files, activeFile) : "";
    } catch (error) {
      failure = error;
      url.hash = "";
    }
    if (revision !== linkRevision) return false;
    linkNote.textContent = failure ? "Edits could not be included in the URL. " + errorText(failure) : linkHint;
    if (url.href !== location.href) history.replaceState(history.state, "", url);
    url.searchParams.set("inspect", "compare");
    compareLink.href = url.href;
    if (failure) throw failure;
    return true;
  }
  function queueLink() {
    ++linkRevision;
    clearTimeout(linkTimer);
    linkTimer = setTimeout(() => {
      void updateLink().catch(error => { status.textContent = errorText(error); });
    }, 180);
  }
  const drafts = new Map<Example, string>();
  let syncing = false;
  const { view: editor, open: openEditor } = createEditor(
    document.querySelector("#rust-editor")!,
    activeFile,
    source(activeFile),
    (code) => {
      if (!syncing) {
        workspace.writeFile(activeFile, code);
        queueLink();
      }
    },
  );
  function syncEditor() {
    const code = source(activeFile);
    if (code === editor.state.doc.toString()) return;
    syncing = true;
    try {
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: code },
      });
    } finally {
      syncing = false;
    }
  }
  function openFile(file: SourceFile) {
    activeFile = file;
    openEditor(file, source(file));
    for (const tab of fileTabs)
      tab.setAttribute("aria-pressed", String(tab.dataset.rustFile === file));
  }
  function showExample() {
    const gpu = chosen === "fractal";
    heading.textContent = gpu ? "Rust + CUDA" : "Rust playground";
    description.textContent = gpu
      ? "Run Mandelbrot to compile Rust with Cargo, launch the CUDA kernel on your GPU through WebGPU, and draw the frames in the terminal."
      : "Edit Rust here and run Cargo inside the tab’s isolated Linux machine.";
    featureLink.hidden = gpu;
    for (const tab of fileTabs) {
      tab.hidden = !gpu && tab.dataset.rustFile !== "src/main.rs";
      tab.setAttribute(
        "aria-pressed",
        String(tab.dataset.rustFile === activeFile),
      );
    }
  }
  for (const tab of fileTabs)
    tab.addEventListener("click", () => {
      if (tab.hidden || running?.action === "format") return;
      openFile(tab.dataset.rustFile as SourceFile);
      queueLink();
      controls();
    });
  showExample();
  for (const [value, example] of Object.entries(examples))
    select.add(new Option(example.label, value));
  select.value = chosen;
  queueLink();
  function requiresGpu() {
    return chosen === "fractal" && !hasGpu();
  }
  function readyStatus() {
    return requiresGpu()
      ? "This example needs WebGPU. Choose a CPU example to run code here."
      : "Ready · " + hardware;
  }
  function controls() {
    select.disabled = !!running;
    cpuChoice.hidden = !pty || !requiresGpu();
    for (const tab of fileTabs) tab.disabled = running?.action === "format";
    editor.dom.inert = running?.action === "format";
    for (const button of buttons) {
      const action = button.dataset.rustAction;
      const blockedByGpu =
        !!pty && requiresGpu() && (action === "run" || action === "release");
      if (action === "run" || action === "release")
        button.title = blockedByGpu
          ? "Enable WebGPU or select a CPU example."
          : chosen === "fractal"
            ? "Compile and run Mandelbrot on your GPU."
            : "";
      if (action === "format")
        button.title =
          activeFile === "kernels.cu"
            ? "rustfmt formats Rust source files."
            : !hasFormat
              ? "Waiting for rustfmt."
              : "Format " + activeFile;
      button.disabled =
        action !== "share" &&
        (!pty ||
          !!running ||
          blockedByGpu ||
          (action === "format" &&
            (!hasFormat || activeFile === "kernels.cu")) ||
          (action === "clippy" && !hasClippy));
    }
  }
  controls();
  function changeExample(next: Example) {
    if (running) {
      select.value = chosen;
      return;
    }
    if (next === chosen) return;
    drafts.set(chosen, source("src/main.rs"));
    if (chosen === "fractal") {
      gpuFiles = {
        "kernels.cu": source("kernels.cu"),
        "build.rs": source("build.rs"),
      };
      workspace.rm("kernels.cu", { force: true });
      workspace.rm("build.rs", { force: true });
    }
    chosen = next;
    select.value = next;
    if (chosen === "fractal") {
      workspace.writeFile("kernels.cu", gpuFiles["kernels.cu"]);
      workspace.writeFile("build.rs", gpuFiles["build.rs"]);
    }
    workspace.writeFile(
      "src/main.rs",
      drafts.get(chosen) ?? examples[chosen].source,
    );
    openFile("src/main.rs");
    showExample();
    queueLink();
    controls();
    if (pty) status.textContent = readyStatus();
  }
  select.addEventListener("change", () =>
    changeExample(select.value as Example),
  );
  cpuChoice.addEventListener("click", () => changeExample("hello"));
  featureLink.addEventListener("click", (event) => {
    if (
      event instanceof MouseEvent &&
      (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
    )
      return;
    event.preventDefault();
    changeExample("fractal");
  });

  let updateTimer: ReturnType<typeof setTimeout>;
  function finish(code: number) {
    const timing = running;
    if (!timing) return;
    const end = timing.end ?? performance.now();
    const elapsed = end - timing.start;
    const run = timing.run === undefined ? 0 : end - timing.run;
    const compile = elapsed - run;
    const isCompile = timing.action !== "format";
    Object.assign(stats, {
      state: code === 0 ? "ready" : "error",
      action: timing.action,
      example: timing.example,
      elapsedMs: elapsed.toFixed(1),
      compileMs: isCompile ? compile.toFixed(1) : "",
      runMs: run.toFixed(1),
      exitCode: String(code),
    });
    const times = isCompile
      ? "Build " + seconds(compile) + " · Run " + seconds(run)
      : "Format " + seconds(elapsed);
    status.textContent =
      (code === 0 ? "" : "Exit " + code + " · ") + times + " · " + hardware;
    if (timing.action === "format") syncEditor();
    if (firstBuild && code === 0 && isCompile && timing.run !== undefined) {
      firstBuild = false;
      const note = document.querySelector("#rust-first-build");
      if (note)
        note.textContent =
          "First build in this tab took " +
          seconds(compile) +
          " on the emulated CPU. Later builds reuse Cargo’s incremental cache.";
    }
    running = undefined;
    controls();
  }
  const sharedPaths = new Set(["/src/main.rs", "/kernels.cu", "/build.rs"]);
  workspace.onChange((change) => {
    if (sharedPaths.has(change.path) || (change.to && sharedPaths.has(change.to)))
      queueLink();
    if (change.path === "/" + activeFile || change.to === "/" + activeFile) {
      clearTimeout(updateTimer);
      updateTimer = setTimeout(syncEditor, 35);
    }
    if (change.path !== "/.lab/event" || change.type !== "write" || !running)
      return;
    const [ticket, phase, rc] = workspace
      .readText("/.lab/event")
      .trim()
      .split(/\s+/);
    if (ticket !== running.ticket) return;
    if (phase === "start") running.start = performance.now();
    if (phase === "run" && running.run === undefined) {
      running.run = performance.now();
      status.textContent = "Running in Linux · " + hardware;
    }
    if (phase === "end" && /^\d+$/.test(rc)) running.end = performance.now();
  });

  for (const button of buttons)
    button.addEventListener("click", async () => {
      const action = button.dataset.rustAction!;
      if (action === "share") {
        try {
          if (!(await updateLink())) return;
          try {
            await navigator.clipboard.writeText(location.href);
            status.textContent = "Link copied.";
          } catch {
            status.textContent =
              "Share link ready. Copy it from the address bar.";
          }
        } catch (err) {
          status.textContent = errorText(err);
        }
        return;
      }
      if (!pty || !machine || running || button.disabled) return;
      const ticket = crypto.randomUUID();
      const actionFile = activeFile;
      running = {
        ticket,
        action: action as Action,
        example: chosen,
        start: performance.now(),
      };
      Object.assign(stats, {
        state: "running",
        seq: String(Number(stats.seq) + 1),
        example: chosen,
        action,
      });
      status.textContent =
        (action === "format" ? "Formatting…" : "Building in Linux…") +
        " · " +
        hardware;
      controls();
      let process: Pty | undefined;
      try {
        const commands: Record<Action, string> = {
          run: "cargo run --locked",
          release: "cargo run --release --locked",
          test: "cargo test --locked",
          clippy: "cargo clippy --locked",
          format: "rustfmt --edition 2021 " + actionFile,
        };
        await writeTerminal("\r\n$ " + commands[action as Action] + "\r\n");
        process = await machine.spawn(
          "sh",
          ["/work/.lab/action", action, ticket, actionFile],
          {
            cwd: "/work",
            user: "root",
            cols: pty.cols,
            rows: pty.rows,
            term: "xterm-256color",
          },
        );
        // This PTY owns toolbar input only while its command is running. Never
        // inject a toolbar command into a waiting read, editor, or other process.
        setActionPty?.(process);
        const [ended] = await Promise.all([
          process.ended,
          process.output.pipeTo(
            new WritableStream({ write: (bytes) => writeTerminal(bytes) }),
          ),
        ]);
        const rc =
          ended.type === "exit"
            ? ended.code
            : ended.type === "signal"
              ? 128 + ended.signal
              : 1;
        await writeTerminal("\x1b[2m[Returned to terminal]\x1b[0m\r\n");
        finish(rc);
      } catch (error) {
        await process?.close().catch(() => {});
        finish(1);
        status.textContent = errorText(error);
      } finally {
        setActionPty?.(undefined);
      }
    });

  report("Opening the offline toolchain…");
  const manifestResponse = await fetch(assetUrl("images/manifest.json"), {
    cache: "no-cache",
  });
  if (
    !manifestResponse.ok ||
    manifestResponse.headers.get("Content-Type")?.includes("text/html")
  )
    throw Error("The Rust toolchain image is unavailable on this host.");
  const manifestBytes = await manifestResponse.arrayBuffer();
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  if (!manifest.size || !manifest.chunks?.length)
    throw Error("Invalid Rust toolchain image manifest.");
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", manifestBytes),
  );
  const revision = Array.from(digest, (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  const id = crypto.randomUUID();
  const channel = new BroadcastChannel("tab-lab-bytes-" + id);
  stats.imageBytes = "0";
  stats.imageSize = String(manifest.size);
  const byteCounter = document.getElementById("disk-bytes");
  let lastMiB = -1;
  function showBytes(total: number) {
    stats.imageBytes = String(total);
    const mib = Math.round(total / (1024 * 1024));
    if (byteCounter && lastMiB !== mib) {
      byteCounter.textContent = mib + " MiB downloaded";
      lastMiB = mib;
    }
  }
  showBytes(0);
  channel.onmessage = ({ data }) => {
    if (Number.isSafeInteger(data) && data > 0)
      showBytes(Number(stats.imageBytes) + data);
  };
  addEventListener("pagehide", () => channel.close(), { once: true });
  const virtual = (file: string) =>
    assetUrl("images/" + file) + "?v=" + revision + "&id=" + id;
  const options: CreateKernelOptions = {
    distro: { kind: "http", url: virtual("base.disk"), prefetch: false },
    disks: [
      {
        kind: "http",
        url: virtual("toolchain.disk"),
        chunkSize: 64 * 1024,
        prefetch: false,
      },
    ],
  };
  return {
    options,
    cwd: "/",
    async connect(vm: KernelHandle, shell: Pty) {
      const probe = await vm.exec("sh", [
        "-c",
        "command -v cargo && command -v rustc; command -v rustfmt; command -v cargo-clippy; true",
      ]);
      if (
        !probe.stdout.split("\n").some((line) => line.endsWith("/cargo")) ||
        !probe.stdout.split("\n").some((line) => line.endsWith("/rustc"))
      )
        throw Error("The guest booted without the Rust toolchain.");
      await mountWorkspace(vm, workspace);
      hasFormat = probe.stdout.includes("/rustfmt");
      hasClippy = probe.stdout.includes("/cargo-clippy");
      for (const button of buttons) {
        if (button.dataset.rustAction === "clippy") button.hidden = !hasClippy;
        if (button.dataset.rustAction === "format" && !hasFormat)
          button.title = "rustfmt is unavailable in this image.";
      }
      await shell.write(". /work/.lab/env\n");
      hardware =
        vm.stats().cpus +
        " CPU" +
        (vm.stats().cpus === 1 ? "" : "s") +
        " · " +
        vm.memoryMiB +
        " MiB";
      Object.assign(stats, {
        state: "ready",
        cpus: String(vm.stats().cpus),
        memoryMib: String(vm.memoryMiB),
      });
      machine = vm;
      pty = shell;
      controls();
      status.textContent = readyStatus();
      void vm.exited.then(() => {
        pty = undefined;
        if (running) finish(1);
        stats.state = "error";
        controls();
      });
    },
  };
}

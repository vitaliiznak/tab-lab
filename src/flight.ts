import type { KernelHandle } from "unkernel/web";
import { lab } from "./boot";

type FlightRequest = { start: number; end: number; mode: number };
const lastFrame = 120;

export function connectFlight(vm: KernelHandle, executable: string) {
  const deck = document.querySelector<HTMLElement>("#flight");
  if (!deck) return;
  const canvas = document.querySelector<HTMLCanvasElement>("#flight-canvas")!;
  const play = document.querySelector<HTMLButtonElement>("#flight-play")!;
  const camera = document.querySelector<HTMLInputElement>("#flight-camera")!;
  const view = document.querySelector<HTMLSelectElement>("#flight-view")!;
  const position = document.querySelector<HTMLOutputElement>("#camera-position")!;
  const status = document.getElementById("flight-status")!;
  const legend = document.getElementById("work-legend")!;
  const poster = document.getElementById("flight-poster")!;
  const caption = document.getElementById("poster-label")!;
  function state(name: string, message: string) {
    deck!.dataset.state = name;
    status.textContent = message;
    play.textContent = name === "playing" ? "Pause flight" :
      Number(camera.value) === lastFrame ? "Replay flight" : "Play flight";
  }
  const expand = document.querySelector<HTMLButtonElement>("#flight-expand")!;
  if (document.fullscreenEnabled) {
    expand.hidden = false;
    expand.onclick = async () => {
      try {
        if (document.fullscreenElement === deck) await document.exitFullscreen();
        else await deck.requestFullscreen();
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : String(error);
      }
    };
    document.addEventListener("fullscreenchange", () => {
      const expanded = document.fullscreenElement === deck;
      expand.textContent = expanded ? "Exit full screen" : "Full screen";
      expand.setAttribute("aria-pressed", String(expanded));
    });
  }
  if (!lab.gpu) {
    state("unavailable", "WebGPU unavailable · recorded tunnel");
    canvas.hidden = poster.hidden = caption.hidden = true;
    return;
  }
  play.disabled = camera.disabled = view.disabled = false;
  let queued: FlightRequest | undefined;
  let active: AbortController | undefined;
  let disposed = false;
  let running = false;
  let renderingMode = 0;
  let firstVisible = true;
  let seenFrame = false;
  const query = new URLSearchParams(location.search);
  const quiet = query.has("inspect") || query.get("demo") === "shell";
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

  canvas.addEventListener("cudawgframe", (event) => {
    if (disposed || active?.signal.aborted) return;
    const frame = (event as CustomEvent<number>).detail;
    canvas.dataset.frame = String(frame);
    canvas.dataset.view = String(renderingMode);
    camera.value = String(frame);
    position.value = frame + " / " + lastFrame;
    if (!seenFrame) {
      seenFrame = true;
      canvas.classList.add("has-frame");
      document.getElementById("gpu-missing")!.hidden = true;
      poster.hidden = caption.hidden = true;
    }
  });

  async function drain() {
    if (running) return;
    running = true;
    try {
      while (queued && !disposed && !document.hidden) {
        const request = queued;
        queued = undefined;
        const controller = new AbortController();
        active = controller;
        renderingMode = request.mode;
        const moving = request.end > request.start;
        state(moving ? "playing" : "rendering", moving ? "Live CUDA · flying" : "Rendering camera position…");
        try {
          const result = await vm.exec(executable, [
            "--screen", String(request.start), String(request.end), String(request.mode),
          ], { user: "root", signal: controller.signal });
          if (controller.signal.aborted) continue;
          if (result.exitCode !== 0 || !seenFrame)
            throw Error(result.stderr.trim() || "The guest could not present a frame.");
          state(moving ? "complete" : "paused", moving ? "Flight complete · GPU frame" : "Paused · GPU frame");
        } catch (error) {
          if (!controller.signal.aborted && !disposed) {
            state("error", error instanceof Error ? error.message : String(error));
            // The same shell remains usable if canvas presentation failed.
            if (!seenFrame) document.getElementById("gpu-missing")!.hidden = false;
          }
        } finally {
          if (active === controller) active = undefined;
        }
      }
    } finally { running = false; }
  }
  function request(start: number, end = start) {
    queued = {start, end, mode: Number(view.value)};
    active?.abort();
    void drain();
  }
  function pause() {
    queued = undefined;
    active?.abort();
    state("paused", seenFrame ? "Paused · GPU frame" : "Ready to render");
  }
  play.onclick = () => {
    if (deck.dataset.state === "playing") pause();
    else request(Number(camera.value) === lastFrame ? 0 : Number(camera.value), lastFrame);
  };
  camera.oninput = () => {
    const frame = Number(camera.value);
    position.value = frame + " / " + lastFrame;
    request(frame);
  };
  view.onchange = () => {
    legend.hidden = view.value !== "1";
    request(Number(camera.value));
  };
  function onVisibility() {
    if (document.hidden) {
      pause();
    } else if (firstVisible) {
      firstVisible = false;
      if (quiet) state("paused", "Camera ready · shell mode");
      else request(0, reducedMotion.matches ? 0 : lastFrame);
    }
  }
  document.addEventListener("visibilitychange", onVisibility);
  const stop = () => {
    disposed = true;
    queued = undefined;
    active?.abort();
    play.disabled = camera.disabled = view.disabled = true;
    document.removeEventListener("visibilitychange", onVisibility);
  };
  window.addEventListener("pagehide", stop, {once:true});
  void vm.exited.then(stop);
  onVisibility();
}

// Async side of the channel: owns the WebGPU device, serves requests forever.
// Page setup:
//   const chan = createChannel();
//   new Worker(new URL('./gpu-worker.js', import.meta.url), { type: 'module' }).postMessage({ chan });
//   ...pass `chan` to every worker that runs kernel Wasm and build the bridge there.
import { createGpuCore } from './gpu-core.js';

const waitWhile = async (ctl, value) => {
  if (Atomics.waitAsync) {
    const r = Atomics.waitAsync(ctl, 0, value);
    if (r.async) await r.value;
  } else {
    await new Promise((res) => setTimeout(res, 0)); // fallback: poll
  }
};

globalThis.onmessage = async ({ data: { chan } }) => {
  const core = await createGpuCore(navigator.gpu);
  const ctl = new Int32Array(chan, 0, 4);
  const data = new Uint8Array(chan, 16);
  postMessage({ ready: true });
  for (;;) {
    while (Atomics.load(ctl, 0) !== 1) await waitWhile(ctl, Atomics.load(ctl, 0));
    const req = data.slice(0, Atomics.load(ctl, 1));
    const resp = await core.handle(req);
    data.set(resp);
    Atomics.store(ctl, 1, resp.length);
    Atomics.store(ctl, 0, 2);
    Atomics.notify(ctl, 0);
  }
};

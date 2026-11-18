// Synchronous side of the channel. Runs in whichever worker executes kernel Wasm.
// Plug into the kernel's import object:
//   imports.cudawg = { call: createCudawgBridge(chan, () => kernelMemory) };
//
// chan layout: Int32[0] state (0 idle, 1 request ready, 2 response ready), Int32[1] length,
//              bytes from offset 16 = payload (CHAN_SIZE).
export const CHAN_SIZE = 1 << 20;
export const createChannel = () => new SharedArrayBuffer(16 + CHAN_SIZE);

export function createCudawgBridge(chan, getMemory) {
  const ctl = new Int32Array(chan, 0, 4);
  const data = new Uint8Array(chan, 16, CHAN_SIZE);
  return function call(reqPtr, reqLen, respPtr, respCap) {
    data.set(new Uint8Array(getMemory().buffer, reqPtr, reqLen));
    Atomics.store(ctl, 1, reqLen);
    Atomics.store(ctl, 0, 1);
    Atomics.notify(ctl, 0);
    while (Atomics.load(ctl, 0) !== 2) Atomics.wait(ctl, 0, 1, 1000);
    const n = Atomics.load(ctl, 1);
    // re-read memory.buffer: it may have grown while we waited
    new Uint8Array(getMemory().buffer, respPtr, Math.min(n, respCap)).set(data.subarray(0, Math.min(n, respCap)));
    Atomics.store(ctl, 0, 0);
    return n;
  };
}

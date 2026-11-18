// Main thread plays the role of the kernel Wasm: synchronous calls through the bridge.
import { Worker } from 'node:worker_threads';
import { createChannel, createCudawgBridge } from '../host/bridge.js';
const chan = createChannel();
const w = new Worker(new URL('./worker-shim.mjs', import.meta.url));
w.postMessage({ chan });
await new Promise((r) => w.once('message', r)); // ready
const memory = { buffer: new ArrayBuffer(1 << 16) }; // fake kernel linear memory
const call = createCudawgBridge(chan, () => memory);
const mem = new Uint8Array(memory.buffer), dv = new DataView(memory.buffer);
const req = (words, extra = new Uint8Array()) => {
  words.forEach((v, i) => dv.setUint32(i * 4, v, true));
  mem.set(extra, words.length * 4);
  const n = call(0, words.length * 4 + extra.length, 8192, 8192);
  return { status: dv.getInt32(8192, true), word: dv.getUint32(8196, true), n };
};
const id = req([1, 64]).word;                                  // MALLOC 64
req([3, id, 0, 16], new Uint8Array(new Float32Array([1, 2, 3, 4]).buffer)); // H2D
const r = req([4, id, 0, 16]);                                 // D2H
console.log('bridge roundtrip:', [...new Float32Array(memory.buffer, 8196, 4)], 'status', r.status);
await w.terminate();

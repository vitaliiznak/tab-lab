// Runs host/gpu-worker.js inside a Node worker_thread (browser-worker API shim).
import { parentPort } from 'node:worker_threads';
import { create, globals } from 'webgpu';
Object.assign(globalThis, globals);
const gpu = create([]);
Object.defineProperty(globalThis, 'navigator', { value: { gpu }, configurable: true });
globalThis.postMessage = (m) => parentPort.postMessage(m);
await import('../host/gpu-worker.js');
parentPort.on('message', (m) => globalThis.onmessage({ data: m }));

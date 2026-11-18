// Test host: speaks length-prefixed cudawg frames on fd 3 (in) / fd 4 (out), runs them on Dawn (npm "webgpu").
import { create, globals } from 'webgpu';
import fs from 'node:fs';
import { createGpuCore } from '../host/gpu-core.js';
Object.assign(globalThis, globals);

const gpu = create([]);
globalThis.__cudawgGpu = gpu; // must outlive the device (Dawn instance)
const core = await createGpuCore(gpu);
let pending = Buffer.alloc(0);
let chain = Promise.resolve();

const input = fs.createReadStream(null, { fd: 3 });
const output = fs.createWriteStream(null, { fd: 4 });
output.on('error', () => process.exit(0)); // client went away
input.on('data', (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= 4) {
    const n = pending.readUInt32LE(0);
    if (pending.length < 4 + n) break;
    const req = new Uint8Array(pending.subarray(4, 4 + n)); // copy
    pending = pending.subarray(4 + n);
    chain = chain.then(async () => {
      if (process.env.CUDAWG_TRACE) console.error("op", new DataView(req.buffer).getUint32(0, true), "len", req.length);
      const resp = await core.handle(new Uint8Array(req));
      if (process.env.CUDAWG_TRACE) console.error("  ->", resp.length, new DataView(resp.buffer).getInt32(0, true));
      const hdr = Buffer.alloc(4); hdr.writeUInt32LE(resp.length);
      output.write(Buffer.concat([hdr, Buffer.from(resp)]));
    });
  }
});
input.on('end', () => chain.then(() => process.exit(0)));

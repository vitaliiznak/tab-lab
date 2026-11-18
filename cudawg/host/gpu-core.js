// cudawg GPU core: executes cudawg protocol requests on WebGPU.
// Used by gpu-worker.js (browser) and test/node-host.mjs (Node + Dawn).

const OP = { MALLOC: 1, FREE: 2, H2D: 3, D2H: 4, REGISTER: 5, LAUNCH: 6, SYNC: 7, MEMSET: 8, D2D: 9, PRESENT: 10 };
const ERR = { INVALID_VALUE: 1, ALLOC: 2, LAUNCH: 4, BAD_PTR: 17, BAD_IMAGE: 200, UNKNOWN: 999 };
const enc = new TextEncoder(), dec = new TextDecoder();

export async function createGpuCore(gpu, present) {
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('cudawg: no WebGPU adapter');
  const L = adapter.limits;
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxComputeInvocationsPerWorkgroup: L.maxComputeInvocationsPerWorkgroup,
      maxComputeWorkgroupSizeX: L.maxComputeWorkgroupSizeX,
      maxComputeWorkgroupSizeY: L.maxComputeWorkgroupSizeY,
      maxComputeWorkgroupSizeZ: L.maxComputeWorkgroupSizeZ,
      maxComputeWorkgroupStorageSize: L.maxComputeWorkgroupStorageSize,
      maxStorageBuffersPerShaderStage: L.maxStorageBuffersPerShaderStage,
      maxStorageBufferBindingSize: L.maxStorageBufferBindingSize,
      maxBufferSize: L.maxBufferSize,
    },
  });
  device.lost?.then((info) => { if (info.reason !== 'destroyed') console.warn('cudawg: device lost', info.message); });

  function session() {
    const buffers = new Map(); let nextBuf = 1;
    const kernels = new Map(); let nextKernel = 1;

    const ok = (payload) => {
      const out = new Uint8Array(4 + (payload ? payload.byteLength : 0));
      if (payload) out.set(new Uint8Array(payload.buffer ?? payload, payload.byteOffset ?? 0, payload.byteLength), 4);
      return out;
    };
    const okU32 = (v) => ok(new Uint32Array([v]));
    const fail = (code, msg) => {
      const m = enc.encode(msg);
      const out = new Uint8Array(4 + m.length);
      new DataView(out.buffer).setInt32(0, code, true);
      out.set(m, 4);
      return out;
    };

    async function scoped(fn) {
      device.pushErrorScope('validation');
      device.pushErrorScope('out-of-memory');
      let r, thrown;
      try { r = await fn(); } catch (e) { thrown = e; }
      const oom = await device.popErrorScope();
      const val = await device.popErrorScope();
      if (thrown) throw thrown;
      if (oom || val) throw Object.assign(new Error((oom || val).message), { oom: !!oom });
      return r;
    }

    async function register(kinds, name, wgsl) {
      const module = device.createShaderModule({ code: wgsl, label: name });
      const info = await module.getCompilationInfo();
      const errs = info.messages.filter((m) => m.type === 'error');
      if (errs.length) {
        throw new Error(`WGSL for kernel '${name}' failed:\n` +
          errs.map((m) => `  line ${m.lineNum}: ${m.message}`).join('\n') + '\n--- WGSL ---\n' + wgsl);
      }
      const entries = []; let b = 0;
      for (const k of kinds) {
        if (k === 'r' || k === 'w')
          entries.push({ binding: b++, visibility: GPUShaderStage.COMPUTE,
                         buffer: { type: k === 'r' ? 'read-only-storage' : 'storage' } });
      }
      const nScalars = [...kinds].filter((k) => k !== 'r' && k !== 'w').length;
      if (nScalars) entries.push({ binding: b, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } });
      const bgl = device.createBindGroupLayout({ entries });
      const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
      return { name, kinds, module, bgl, layout, nScalars, pipelines: new Map() };
    }

    // sync createComputePipeline on purpose: the async variant crashes some Dawn builds
    function pipelineFor(k, bx, by, bz) {
      const key = `${bx},${by},${bz}`;
      let p = k.pipelines.get(key);
      if (!p) {
        p = device.createComputePipeline({
          layout: k.layout,
          compute: { module: k.module, entryPoint: 'main', constants: { _cwbx: bx, _cwby: by, _cwbz: bz } },
        });
        k.pipelines.set(key, p);
      }
      return p;
    }

    async function handle(req) {
      const dv = new DataView(req.buffer, req.byteOffset, req.byteLength);
      const u = (i) => dv.getUint32(i * 4, true);
      const op = u(0);
      try {
        switch (op) {
          case OP.MALLOC: {
            const size = u(1);
            const buf = await scoped(() => device.createBuffer({
              size: Math.max(4, size),
              usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
            }));
            const id = nextBuf++; buffers.set(id, buf);
            return okU32(id);
          }
          case OP.FREE: {
            buffers.get(u(1))?.destroy(); buffers.delete(u(1));
            return ok();
          }
          case OP.H2D: {
            const buf = buffers.get(u(1)); if (!buf) return fail(ERR.BAD_PTR, 'bad buffer');
            device.queue.writeBuffer(buf, u(2), req, 16, u(3));
            return ok();
          }
          case OP.D2H: {
            const buf = buffers.get(u(1)); if (!buf) return fail(ERR.BAD_PTR, 'bad buffer');
            const off = u(2), n = u(3);
            const staging = device.createBuffer({ size: n, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
            const ce = device.createCommandEncoder();
            ce.copyBufferToBuffer(buf, off, staging, 0, n);
            device.queue.submit([ce.finish()]);
            await staging.mapAsync(GPUMapMode.READ);
            const out = ok(new Uint8Array(staging.getMappedRange()).slice());
            staging.unmap();
            staging.destroy();
            return out;
          }
          case OP.D2D: {
            const s = buffers.get(u(1)), d = buffers.get(u(3));
            if (!s || !d) return fail(ERR.BAD_PTR, 'bad buffer');
            const ce = device.createCommandEncoder();
            ce.copyBufferToBuffer(s, u(2), d, u(4), u(5));
            device.queue.submit([ce.finish()]);
            return ok();
          }
          case OP.MEMSET: {
            const buf = buffers.get(u(1)); if (!buf) return fail(ERR.BAD_PTR, 'bad buffer');
            const off = u(2), n = u(3), v = u(4);
            if (v === 0) {
              const ce = device.createCommandEncoder();
              ce.clearBuffer(buf, off, n);
              device.queue.submit([ce.finish()]);
            } else {
              device.queue.writeBuffer(buf, off, new Uint8Array(n).fill(v));
            }
            return ok();
          }
          case OP.PRESENT: {
            const buffer = buffers.get(u(1));
            if (!buffer || !present) return fail(ERR.INVALID_VALUE, 'no presentation surface');
            const width = u(2), height = u(3), frame = u(4);
            if (width !== 640 || height !== 360 || buffer.size < width * height * 4)
              return fail(ERR.INVALID_VALUE, 'invalid presentation extent');
            await scoped(() => present(device, buffer, width, height, frame));
            return ok();
          }
          case OP.SYNC: {
            await device.queue.onSubmittedWorkDone();
            return ok();
          }
          case OP.REGISTER: {
            const nl = u(1), wl = u(2), np = u(3);
            let p = 16;
            const kinds = dec.decode(req.subarray(p, p + np)); p += np;
            const name = dec.decode(req.subarray(p, p + nl)); p += nl;
            const wgsl = dec.decode(req.subarray(p, p + wl));
            try {
              const k = await register(kinds, name, wgsl);
              const id = nextKernel++; kernels.set(id, k);
              return okU32(id);
            } catch (e) {
              return fail(ERR.BAD_IMAGE, e.message);
            }
          }
          case OP.LAUNCH: {
            const k = kernels.get(u(1)); if (!k) return fail(ERR.LAUNCH, 'unknown kernel');
            const [gx, gy, gz, bx, by, bz] = [u(2), u(3), u(4), u(5), u(6), u(7)];
            const np = u(8);
            let w = 9;
            const entries = []; let b = 0;
            const scal = new Uint32Array(Math.max(4, Math.ceil(k.nScalars / 4) * 4)); let si = 0;
            for (let i = 0; i < np; i++) {
              const kind = k.kinds[i];
              if (kind === 'r' || kind === 'w') {
                const buf = buffers.get(u(w)), off = u(w + 1); w += 2;
                if (!buf) return fail(ERR.BAD_PTR, `${k.name}: arg ${i} bad buffer`);
                if (off % 256) return fail(ERR.INVALID_VALUE, `${k.name}: arg ${i} offset ${off} not 256-aligned (MVP)`);
                entries.push({ binding: b++, resource: { buffer: buf, offset: off, size: buf.size - off } });
              } else {
                scal[si++] = u(w++);
              }
            }
            if (gx * gy * gz === 0) return ok();
            let ub;
            if (k.nScalars) {
              ub = device.createBuffer({ size: scal.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
              device.queue.writeBuffer(ub, 0, scal);
              entries.push({ binding: b, resource: { buffer: ub } });
            }
            try {
              await scoped(async () => {
                const pipe = pipelineFor(k, bx, by, bz);
                const bg = device.createBindGroup({ layout: k.bgl, entries });
                const ce = device.createCommandEncoder();
                const pass = ce.beginComputePass();
                pass.setPipeline(pipe);
                pass.setBindGroup(0, bg);
                pass.dispatchWorkgroups(gx, gy, gz);
                pass.end();
                device.queue.submit([ce.finish()]);
              });
            } finally {
              ub?.destroy();
            }
            return ok(); // async like CUDA: returns before the GPU finishes
          }
          default:
            return fail(ERR.INVALID_VALUE, `unknown op ${op}`);
        }
      } catch (e) {
        return fail(e.oom ? ERR.ALLOC : (op === OP.LAUNCH ? ERR.LAUNCH : ERR.UNKNOWN), String(e.message || e));
      }
    }

    function dispose() {
      for (const buffer of buffers.values()) buffer.destroy();
      buffers.clear();
      kernels.clear();
    }
    return { handle, dispose };
  }
  // keep the GPU instance alive: in Node (Dawn) collecting it tears down the device
  return { ...session(), session, device, adapter, gpu };
}

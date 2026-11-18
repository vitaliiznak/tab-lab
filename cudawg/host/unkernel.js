import { createGpuCore } from './gpu-core.js';

// VSock is a byte stream. A frame can span multiple kernel buffers, or share a
// buffer with the next frame. Allocate only after checking the four-byte size.
async function* requests(stream) {
  const header = new Uint8Array(4);
  let frame = header;
  let offset = 0;
  for await (const chunk of stream) {
    let cursor = 0;
    while (cursor < chunk.length) {
      const count = Math.min(frame.length - offset, chunk.length - cursor);
      frame.set(chunk.subarray(cursor, cursor + count), offset);
      offset += count;
      cursor += count;
      if (offset < frame.length) continue;
      offset = 0;
      if (frame === header) {
        const size = new DataView(header.buffer).getUint32(0, true);
        if (size < 4 || size > 1048576) throw new Error('Invalid cudawg frame size');
        frame = new Uint8Array(size);
      } else {
        yield frame;
        frame = header;
      }
    }
  }
  if (frame !== header || offset) throw new Error('Incomplete cudawg frame');
}

/**
 * @param {any} vm
 * @param {GPU} gpu
 * @param {{log?: (message?: string) => void, canvas?: HTMLCanvasElement}} [options]
 */
export async function attachCudawg(vm, gpu, { log = () => {}, canvas } = {}) {
  let context;
  async function present(device, buffer, width, height, frame) {
    if (!context) {
      context = canvas.getContext('webgpu');
      if (!context) throw Error('Could not open the WebGPU canvas');
      context.configure({device, format: 'rgba8unorm', alphaMode: 'opaque',
        usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT});
    }
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToTexture({buffer, bytesPerRow: width * 4},
      {texture: context.getCurrentTexture()}, [width, height]);
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    canvas.dispatchEvent(new CustomEvent('cudawgframe', {detail: frame}));
  }
  const core = await createGpuCore(gpu, canvas ? present : undefined);
  const connections = new Set();
  // WebGPU error scopes are a stack on the device. Keep requests ordered even
  // when several independent guest programs share the adapter.
  let queue = Promise.resolve();
  async function serve(conn) {
    connections.add(conn);
    const session = core.session();
    const writer = conn.writable.getWriter();
    try {
      for await (const request of requests(conn.readable)) {
        const response = queue.then(() => session.handle(request));
        queue = response.catch(() => {});
        const bytes = await response;
        const frame = new Uint8Array(bytes.length + 4);
        new DataView(frame.buffer).setUint32(0, bytes.length, true);
        frame.set(bytes, 4);
        await writer.write(frame);
      }
    } catch (error) {
      log(String(error));
    } finally {
      writer.releaseLock();
      conn.close();
      session.dispose();
      connections.delete(conn);
    }
  }
  const listener = vm.vsock.listen(7744, (conn) => { void serve(conn); });
  return {
    adapter: core.adapter,
    close() {
      listener.close();
      for (const conn of connections) conn.reset();
      context?.unconfigure();
      core.device.destroy();
    },
  };
}

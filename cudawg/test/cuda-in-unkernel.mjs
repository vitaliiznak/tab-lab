import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createKernel } from 'unkernel';
import { create, globals } from 'webgpu';
import { attachCudawg } from '../host/unkernel.js';

Object.assign(globalThis, globals);
const binaries = {};
for (const name of ['vecadd','matmul','reduce','tunnel']) {
  binaries[name] = await readFile(new URL('../../public/cuda/' + name, import.meta.url));
}
const started = performance.now();
const vm = await createKernel({ mounts: { '/opt/cuda': binaries }, memoryMiB: 192 });
let bridge;
const deadline = setTimeout(() => { console.error('Guest test exceeded 120 s'); vm.stop(); }, 120000);
try {
  const prepared = await vm.exec('sh', ['-c', 'cp /opt/cuda/* /tmp/ && chmod +x /tmp/vecadd /tmp/matmul /tmp/reduce /tmp/tunnel']);
  assert.equal(prepared.exitCode, 0, prepared.stderr);
  console.log('Linux boot and binary setup: ' + Math.round(performance.now() - started) + ' ms');
  bridge = await attachCudawg(vm, create([]), { log: console.warn });
  for (const [name, args, expected] of [
    ['vecadd', [], /errors=0 c\[12345\]=30862\.5/],
    ['matmul', [], /errors=0/],
    ['reduce', [], /sum=300000 expected=300000 OK/],
    ['tunnel', ['24', '8', '1'], /\x1b\[38;2;\d+;\d+;\d+m\x1b\[48;2;\d+;\d+;\d+m▀/],
  ]) {
    const start = performance.now();
    const result = await vm.exec('/tmp/' + name, args);
    const ms = Math.round(performance.now() - start);
    assert.equal(result.exitCode, 0, result.stderr + result.stdout.slice(0, 500));
    assert.match(result.stdout, expected);
    if (name === 'tunnel') {
      assert.equal([...result.stdout.matchAll(/▀/g)].length, 24 * 8);
      assert.ok(ms < 10000);
    }
    console.log(name + ' (' + ms + ' ms): ' + (name === 'tunnel' ? '192 truecolor half blocks' : result.stdout.trim()));
  }
} finally {
  clearTimeout(deadline);
  bridge?.close();
  vm.stop();
  await vm.exited;
}

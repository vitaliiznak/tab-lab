# cudawg

cudawg translates a subset of CUDA C to WGSL and embeds it in a C host program.
The unmodified aarch64 Linux executable calls a small runtime that connects to
host CID 2, port 7744 using AF_VSOCK. The browser executes the compute dispatch on
its WebGPU adapter and sends the result back. The guest needs no network or
kernel changes.

The translator, protocol, examples, and WebGPU executor come from the original
cudawg development archive. This project reconstructed its guest integration
from the earlier device-driver version. The original bridge and driver are
retained as historical sources and are not part of the build.

## Build and run the baseline

Use Node 24, Python 3, make, and the Zig compiler. The simplest cross-toolchain
is available as a Python wheel.

```sh
cd cudawg
python3 -m venv .venv
.venv/bin/python -m pip install ziglang==0.15.2
make PYTHON=.venv/bin/python
npm ci
npm test
```

The targets under `../public/cuda/` are statically linked for aarch64 Linux.
Use `GUEST_CC=aarch64-linux-musl-gcc` to select an alternative cross-compiler.
The test boots the pinned kernel, copies the binaries from a 9p mount, and
checks all four examples against Dawn. A usable WebGPU adapter is required.
The default tunnel runs until interrupted. Pass `tunnel 24 8 1` to draw one
24-column, 8-row frame.

In a browser, call `await attachCudawg(vm, navigator.gpu, { log })` after boot.
The result provides the actual adapter and a `close()` method to release
the listener and GPU device. Each Unix process has its own buffer and kernel
namespace, which is released when that process disconnects.

## Kernel subset (MVP)
Supported: int/unsigned/float/bool and pointers to them as params, thread/block builtins, if/else/for/while,
casts, fixed-size `__shared__` arrays, `__syncthreads`, scalar `__device__` functions, common math, simple
`#define`s, `<<<grid, block>>>` with int or dim3, `dim3 v(x, y)`.

Not yet: implicit int/float mixing (write `(float)i`), ternary `?:`, atomics, pointer arithmetic in kernels,
pointer offsets not 256-aligned as kernel args, memcpy sizes not multiple of 4, printf, dynamic shared
memory, warp intrinsics, streams/events, cuBLAS and friends. Host code must be C (uses `_Generic`).

## Protocol (little-endian u32s; response = i32 status + payload, error payload = message)
1 MALLOC size -> id | 2 FREE id | 3 H2D id off len bytes | 4 D2H id off len -> bytes |
5 REGISTER namelen wgsllen nparams kinds name wgsl -> kid | 6 LAUNCH kid gx gy gz bx by bz n args |
7 SYNC | 8 MEMSET id off len byte | 9 D2D sid soff did doff len

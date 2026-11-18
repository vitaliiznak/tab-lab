/* cudawg runtime: implements the CUDA runtime subset by sending small
 * binary requests to a WebGPU host.
 *
 * Default transport: length-prefixed frames over AF_VSOCK (host CID 2, port 7744).
 * Test transport (-DCUDAWG_NODE_TRANSPORT): spawns `node host/node-host.mjs`
 * and talks length-prefixed frames over pipes, so it runs on a normal Linux box.
 */
#include "cuda_runtime.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>

enum { OP_MALLOC = 1, OP_FREE, OP_H2D, OP_D2H, OP_REGISTER, OP_LAUNCH, OP_SYNC, OP_MEMSET, OP_D2D, OP_PRESENT };

#define CHAN_SIZE (1u << 20)          /* must match kernel driver + JS */
#define CHUNK (CHAN_SIZE - 64)
#define VA_BASE 0x40000000u           /* fake device address space */
#define VA_ALIGN 256u                 /* = minStorageBufferOffsetAlignment */

static unsigned char *g_req, *g_resp;
static cudaError_t g_last = cudaSuccess;
static int g_init = 0;

/* ---------------- transport ---------------- */
static int g_to = -1, g_from = -1;
static int full_io(int fd, void *b, size_t n, int wr) {
  unsigned char *p = b;
  while (n) {
    ssize_t r = wr ? write(fd, p, n) : read(fd, p, n);
    if (r < 0 && errno == EINTR) continue;
    if (r <= 0) return -1;
    p += r; n -= (size_t)r;
  }
  return 0;
}
#ifdef CUDAWG_NODE_TRANSPORT
static int transport_open(void) {
  int a[2], b[2];
  if (pipe(a) || pipe(b)) return -1;
  pid_t pid = fork();
  if (pid == 0) {
    /* protocol on fds 3 (in) / 4 (out); Dawn may print to stdout */
    int in = fcntl(a[0], F_DUPFD, 10), out = fcntl(b[1], F_DUPFD, 10);
    close(a[0]); close(a[1]); close(b[0]); close(b[1]);
    dup2(in, 3); dup2(out, 4); close(in); close(out);
    const char *host = getenv("CUDAWG_NODE_HOST");
    execlp("node", "node", host ? host : "host/node-host.mjs", (char *)0);
    _exit(127);
  }
  close(a[0]); close(b[1]);
  g_to = a[1]; g_from = b[0];
  return 0;
}
#else
#include <sys/socket.h>
#include <linux/vm_sockets.h>
static int transport_open(void) {
  int fd = socket(AF_VSOCK, SOCK_STREAM, 0);
  if (fd < 0) return -1;
  struct sockaddr_vm host = { .svm_family = AF_VSOCK, .svm_cid = VMADDR_CID_HOST, .svm_port = 7744 };
  if (connect(fd, (struct sockaddr *)&host, sizeof host) < 0) {
    close(fd);
    return -1;
  }
  g_to = g_from = fd;
  return 0;
}
#endif
static long transport_call(size_t req_len) {
  uint32_t n = (uint32_t)req_len;
  if (full_io(g_to, &n, 4, 1) || full_io(g_to, g_req, req_len, 1)) return -1;
  if (full_io(g_from, &n, 4, 0)) return -1;
  if (n > CHAN_SIZE || full_io(g_from, g_resp, n, 0)) return -1;
  return n;
}


/* ---------------- request building ---------------- */
static size_t g_pos;
static void put32(uint32_t v) { memcpy(g_req + g_pos, &v, 4); g_pos += 4; }
static void putb(const void *p, size_t n) { memcpy(g_req + g_pos, p, n); g_pos += n; }
static uint32_t get32(size_t off) { uint32_t v; memcpy(&v, g_resp + off, 4); return v; }

static cudaError_t ensure_init(void) {
  if (g_init) return g_init > 0 ? cudaSuccess : cudaErrorNoDevice;
  g_req = malloc(CHAN_SIZE);
  g_resp = malloc(CHAN_SIZE);
  g_init = (g_req && g_resp && transport_open() == 0) ? 1 : -1;
  if (g_init < 0) fprintf(stderr, "cudawg: no WebGPU device (check host vsock port 7744)\n");
  return g_init > 0 ? cudaSuccess : cudaErrorNoDevice;
}

/* send g_req[0..g_pos); returns status from host; payload starts at g_resp+4 */
static cudaError_t call(long *payload_len) {
  long n = transport_call(g_pos);
  if (n < 4) return g_last = cudaErrorUnknown;
  int32_t st = (int32_t)get32(0);
  if (st != 0) {
    /* host sends an error message as payload */
    fprintf(stderr, "cudawg host error: %.*s\n", (int)(n - 4), (const char *)g_resp + 4);
    return g_last = (cudaError_t)st;
  }
  if (payload_len) *payload_len = n - 4;
  return cudaSuccess;
}

#define BEGIN(op) do { cudaError_t _e = ensure_init(); if (_e) return g_last = _e; g_pos = 0; put32(op); } while (0)

/* ---------------- fake device pointers ---------------- */
typedef struct { uint32_t base, size, id; } alloc_t;
static alloc_t *g_allocs; static int g_nalloc, g_capalloc;
static uint32_t g_next_va = VA_BASE;

static alloc_t *lookup(const void *p, uint32_t *off) {
  uint32_t a = (uint32_t)(uintptr_t)p;
  for (int i = 0; i < g_nalloc; i++)
    if (a >= g_allocs[i].base && a < g_allocs[i].base + g_allocs[i].size) {
      if (off) *off = a - g_allocs[i].base;
      return &g_allocs[i];
    }
  return NULL;
}

cudaError_t cudaMalloc(void **ptr, size_t size) {
  if (!ptr || size == 0) return g_last = cudaErrorInvalidValue;
  uint32_t sz = (uint32_t)((size + 3) & ~(size_t)3);
  BEGIN(OP_MALLOC); put32(sz);
  cudaError_t e = call(NULL); if (e) return e;
  if (g_nalloc == g_capalloc) {
    g_capalloc = g_capalloc ? g_capalloc * 2 : 16;
    g_allocs = realloc(g_allocs, sizeof(alloc_t) * g_capalloc);
  }
  alloc_t a = { g_next_va, sz, get32(4) };
  g_allocs[g_nalloc++] = a;
  g_next_va += (sz + VA_ALIGN - 1) & ~(VA_ALIGN - 1);
  *ptr = (void *)(uintptr_t)a.base;
  return cudaSuccess;
}

cudaError_t cudaFree(void *ptr) {
  if (!ptr) return cudaSuccess;
  uint32_t off; alloc_t *a = lookup(ptr, &off);
  if (!a || off) return g_last = cudaErrorInvalidDevicePointer;
  BEGIN(OP_FREE); put32(a->id);
  cudaError_t e = call(NULL);
  *a = g_allocs[--g_nalloc];
  return e;
}

cudaError_t cudaMemcpy(void *dst, const void *src, size_t count, cudaMemcpyKind kind) {
  uint32_t doff = 0, soff = 0;
  alloc_t *da = lookup(dst, &doff), *sa = lookup(src, &soff);
  if (kind == cudaMemcpyDefault)
    kind = da ? (sa ? cudaMemcpyDeviceToDevice : cudaMemcpyHostToDevice)
              : (sa ? cudaMemcpyDeviceToHost : cudaMemcpyHostToHost);
  if (kind == cudaMemcpyHostToHost) { memmove(dst, src, count); return cudaSuccess; }
  if ((count | doff | soff) & 3) {
    fprintf(stderr, "cudawg: memcpy sizes/offsets must be multiples of 4 (MVP)\n");
    return g_last = cudaErrorInvalidValue;
  }
  if (kind == cudaMemcpyHostToDevice) {
    if (!da || doff + count > da->size) return g_last = cudaErrorInvalidDevicePointer;
    for (size_t done = 0; done < count; done += CHUNK) {
      uint32_t n = (uint32_t)(count - done < CHUNK ? count - done : CHUNK);
      BEGIN(OP_H2D); put32(da->id); put32(doff + (uint32_t)done); put32(n);
      putb((const char *)src + done, n);
      cudaError_t e = call(NULL); if (e) return e;
    }
  } else if (kind == cudaMemcpyDeviceToHost) {
    if (!sa || soff + count > sa->size) return g_last = cudaErrorInvalidDevicePointer;
    for (size_t done = 0; done < count; done += CHUNK) {
      uint32_t n = (uint32_t)(count - done < CHUNK ? count - done : CHUNK);
      BEGIN(OP_D2H); put32(sa->id); put32(soff + (uint32_t)done); put32(n);
      long got = 0; cudaError_t e = call(&got); if (e) return e;
      if ((uint32_t)got != n) return g_last = cudaErrorUnknown;
      memcpy((char *)dst + done, g_resp + 4, n);
    }
  } else {
    if (!da || !sa) return g_last = cudaErrorInvalidDevicePointer;
    BEGIN(OP_D2D); put32(sa->id); put32(soff); put32(da->id); put32(doff); put32((uint32_t)count);
    return call(NULL);
  }
  return cudaSuccess;
}

cudaError_t cudaMemset(void *ptr, int value, size_t count) {
  uint32_t off; alloc_t *a = lookup(ptr, &off);
  if (!a || off + count > a->size || ((count | off) & 3)) return g_last = cudaErrorInvalidValue;
  BEGIN(OP_MEMSET); put32(a->id); put32(off); put32((uint32_t)count); put32((uint32_t)(value & 0xff));
  return call(NULL);
}

cudaError_t cudawgPresent(void *pixels, unsigned width, unsigned height, unsigned frame) {
  uint32_t off;
  alloc_t *buffer = lookup(pixels, &off);
  if (!buffer || off != 0) return g_last = cudaErrorInvalidDevicePointer;
  BEGIN(OP_PRESENT);
  put32(buffer->id); put32(width); put32(height); put32(frame);
  return call(NULL);
}

cudaError_t cudaDeviceSynchronize(void) { BEGIN(OP_SYNC); return call(NULL); }

cudaError_t cudawgLaunch(cudawg_kernel *k, dim3 grid, dim3 block, void **args) {
  cudaError_t e;
  if (k->id < 0) {
    BEGIN(OP_REGISTER);
    uint32_t nl = (uint32_t)strlen(k->name), wl = (uint32_t)strlen(k->wgsl), np = (uint32_t)strlen(k->kinds);
    put32(nl); put32(wl); put32(np);
    putb(k->kinds, np); putb(k->name, nl); putb(k->wgsl, wl);
    if ((e = call(NULL))) return e;
    k->id = (int)get32(4);
  }
  BEGIN(OP_LAUNCH);
  put32((uint32_t)k->id);
  put32(grid.x); put32(grid.y); put32(grid.z);
  put32(block.x); put32(block.y); put32(block.z);
  uint32_t np = (uint32_t)strlen(k->kinds);
  put32(np);
  for (uint32_t i = 0; i < np; i++) {
    char c = k->kinds[i];
    if (c == 'r' || c == 'w') {
      void *p = *(void **)args[i]; uint32_t off;
      alloc_t *a = lookup(p, &off);
      if (!a) { fprintf(stderr, "cudawg: kernel %s arg %u is not a device pointer\n", k->name, i);
                return g_last = cudaErrorInvalidDevicePointer; }
      put32(a->id); put32(off);
    } else {
      put32(*(uint32_t *)args[i]); /* int / unsigned / float are all 4 bytes */
    }
  }
  return call(NULL);
}

cudaError_t cudaGetLastError(void) { cudaError_t e = g_last; g_last = cudaSuccess; return e; }
cudaError_t cudaPeekAtLastError(void) { return g_last; }
cudaError_t cudaGetDeviceCount(int *c) { *c = ensure_init() == cudaSuccess; return *c ? cudaSuccess : cudaErrorNoDevice; }
cudaError_t cudaSetDevice(int d) { return d == 0 ? ensure_init() : (g_last = cudaErrorInvalidValue); }
cudaError_t cudaDeviceReset(void) { return cudaDeviceSynchronize(); }
cudaError_t cudaGetDeviceProperties(struct cudaDeviceProp *p, int d) {
  if (d != 0) return g_last = cudaErrorInvalidValue;
  memset(p, 0, sizeof *p);
  strcpy(p->name, "WebGPU (cudawg)");
  p->totalGlobalMem = (size_t)1 << 30; p->maxThreadsPerBlock = 256; p->warpSize = 32;
  p->major = 0; p->minor = 1;
  return cudaSuccess;
}
const char *cudaGetErrorString(cudaError_t e) {
  switch (e) {
    case cudaSuccess: return "no error";
    case cudaErrorInvalidValue: return "invalid argument";
    case cudaErrorMemoryAllocation: return "out of memory";
    case cudaErrorLaunchFailure: return "launch failure";
    case cudaErrorInvalidDevicePointer: return "invalid device pointer";
    case cudaErrorInvalidKernelImage: return "invalid kernel image (WGSL compile failed)";
    case cudaErrorNoDevice: return "no WebGPU device";
    default: return "unknown error";
  }
}

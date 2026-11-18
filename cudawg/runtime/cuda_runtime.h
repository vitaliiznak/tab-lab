/* cudawg: a tiny CUDA runtime subset backed by WebGPU (via AF_VSOCK). */
#ifndef CUDAWG_CUDA_RUNTIME_H
#define CUDAWG_CUDA_RUNTIME_H
#include <stddef.h>
#include <stdint.h>

typedef enum {
  cudaSuccess = 0,
  cudaErrorInvalidValue = 1,
  cudaErrorMemoryAllocation = 2,
  cudaErrorInitializationError = 3,
  cudaErrorLaunchFailure = 4,
  cudaErrorInvalidDevicePointer = 17,
  cudaErrorInvalidKernelImage = 200,
  cudaErrorNoDevice = 100,
  cudaErrorUnknown = 999
} cudaError_t;

typedef enum {
  cudaMemcpyHostToHost = 0,
  cudaMemcpyHostToDevice = 1,
  cudaMemcpyDeviceToHost = 2,
  cudaMemcpyDeviceToDevice = 3,
  cudaMemcpyDefault = 4
} cudaMemcpyKind;

typedef struct { unsigned int x, y, z; } dim3;

struct cudaDeviceProp {
  char name[256];
  size_t totalGlobalMem;
  int maxThreadsPerBlock;
  int warpSize;
  int major, minor;
};

typedef struct {
  const char *name;
  const char *kinds; /* per param: r/w = ptr (const/mutable), i/u/f = scalar */
  int id;            /* host-side handle, -1 until registered */
  const char *wgsl;
} cudawg_kernel;

static inline dim3 cudawg_dim3(unsigned x, unsigned y, unsigned z) { dim3 d = {x, y, z}; return d; }
static inline dim3 cudawg_dim3_id(dim3 d) { return d; }
static inline dim3 cudawg_dim3_1(unsigned x) { return cudawg_dim3(x, 1, 1); }
#define CUDAWG_DIM3(v) _Generic((v), dim3: cudawg_dim3_id, default: cudawg_dim3_1)(v)

cudaError_t cudaMalloc(void **ptr, size_t size);
cudaError_t cudaFree(void *ptr);
cudaError_t cudaMemcpy(void *dst, const void *src, size_t count, cudaMemcpyKind kind);
cudaError_t cudaMemset(void *ptr, int value, size_t count);
cudaError_t cudaDeviceSynchronize(void);
cudaError_t cudaGetLastError(void);
cudaError_t cudaPeekAtLastError(void);
const char *cudaGetErrorString(cudaError_t e);
cudaError_t cudaGetDeviceCount(int *count);
cudaError_t cudaSetDevice(int dev);
cudaError_t cudaGetDeviceProperties(struct cudaDeviceProp *prop, int dev);
cudaError_t cudaDeviceReset(void);

cudaError_t cudawgLaunch(cudawg_kernel *k, dim3 grid, dim3 block, void **args);

#endif

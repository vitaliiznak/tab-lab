#include <stdio.h>
#include <stdlib.h>
#include <math.h>

__global__ void vecAdd(const float* a, const float* b, float* c, int n) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) c[i] = a[i] + b[i];
}

int main(void) {
    const int n = 1 << 20;
    size_t bytes = n * sizeof(float);
    float *a = malloc(bytes), *b = malloc(bytes), *c = malloc(bytes);
    for (int i = 0; i < n; i++) { a[i] = i * 0.5f; b[i] = 2.0f * i; }

    float *da, *db, *dc;
    cudaMalloc((void**)&da, bytes);
    cudaMalloc((void**)&db, bytes);
    cudaMalloc((void**)&dc, bytes);
    cudaMemcpy(da, a, bytes, cudaMemcpyHostToDevice);
    cudaMemcpy(db, b, bytes, cudaMemcpyHostToDevice);

    int threads = 256;
    int blocks = (n + threads - 1) / threads;
    vecAdd<<<blocks, threads>>>(da, db, dc, n);
    cudaError_t err = cudaGetLastError();
    if (err != cudaSuccess) { printf("launch: %s\n", cudaGetErrorString(err)); return 1; }

    cudaMemcpy(c, dc, bytes, cudaMemcpyDeviceToHost);
    int bad = 0;
    for (int i = 0; i < n; i++) if (fabsf(c[i] - 2.5f * i) > 1e-3f * (1 + i)) bad++;
    printf("vecAdd: n=%d errors=%d c[12345]=%.1f\n", n, bad, c[12345]);
    cudaFree(da); cudaFree(db); cudaFree(dc);
    return bad != 0;
}

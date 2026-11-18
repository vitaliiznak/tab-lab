#include <stdio.h>
#include <stdlib.h>

// per-block sum with shared memory tree reduction
__global__ void blockSum(const float* in, float* out, int n) {
    __shared__ float sdata[256];
    int tid = threadIdx.x;
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    float v = 0.0f;
    if (i < n) v = in[i];
    sdata[tid] = v;
    __syncthreads();
    for (int s = blockDim.x / 2; s > 0; s >>= 1) {
        if (tid < s) sdata[tid] += sdata[tid + s];
        __syncthreads();
    }
    if (tid == 0) out[blockIdx.x] = sdata[0];
}

__global__ void scale(float* x, float k, int n) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) { x[i] = x[i] * k; }
}

int main(void) {
    int n = 100000, threads = 256, blocks = (n + threads - 1) / threads;
    float *h = malloc(n * sizeof(float));
    for (int i = 0; i < n; i++) h[i] = 1.0f;
    float *din, *dout;
    cudaMalloc((void**)&din, n * sizeof(float));
    cudaMalloc((void**)&dout, blocks * sizeof(float));
    cudaMemcpy(din, h, n * sizeof(float), cudaMemcpyHostToDevice);
    scale<<<blocks, threads>>>(din, 3.0f, n);
    blockSum<<<blocks, threads>>>(din, dout, n);
    cudaDeviceSynchronize();
    float *partial = malloc(blocks * sizeof(float));
    cudaMemcpy(partial, dout, blocks * sizeof(float), cudaMemcpyDeviceToHost);
    double total = 0; for (int b = 0; b < blocks; b++) total += partial[b];
    printf("reduce: sum=%.0f expected=%d %s\n", total, 3 * n, total == 3.0 * n ? "OK" : "FAIL");
    return total != 3.0 * n;
}

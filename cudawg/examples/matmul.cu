#include <stdio.h>
#include <stdlib.h>
#include <math.h>
#define TILE 16

__device__ float madd(float acc, float x, float y) { return acc + x * y; }

// C = A * B, square N x N, tiled with shared memory
__global__ void matmul(const float* A, const float* B, float* C, int N) {
    __shared__ float As[TILE][TILE];
    __shared__ float Bs[TILE][TILE];
    int tx = threadIdx.x, ty = threadIdx.y;
    int row = blockIdx.y * TILE + ty;
    int col = blockIdx.x * TILE + tx;
    float sum = 0.0f;
    for (int t = 0; t < N / TILE; ++t) {
        As[ty][tx] = A[row * N + t * TILE + tx];
        Bs[ty][tx] = B[(t * TILE + ty) * N + col];
        __syncthreads();
        for (int k = 0; k < TILE; k++)
            sum = madd(sum, As[ty][k], Bs[k][tx]);
        __syncthreads();
    }
    C[row * N + col] = sum;
}

int main(void) {
    int N = 256;
    size_t bytes = N * N * sizeof(float);
    float *A = malloc(bytes), *B = malloc(bytes), *C = malloc(bytes);
    for (int i = 0; i < N * N; i++) { A[i] = (float)(i % 7) - 3; B[i] = (float)(i % 5) * 0.25f; }
    float *dA, *dB, *dC;
    cudaMalloc((void**)&dA, bytes); cudaMalloc((void**)&dB, bytes); cudaMalloc((void**)&dC, bytes);
    cudaMemcpy(dA, A, bytes, cudaMemcpyHostToDevice);
    cudaMemcpy(dB, B, bytes, cudaMemcpyHostToDevice);
    dim3 block(TILE, TILE);
    dim3 grid(N / TILE, N / TILE);
    matmul<<<grid, block>>>(dA, dB, dC, N);
    cudaMemcpy(C, dC, bytes, cudaMemcpyDeviceToHost);
    int bad = 0;
    for (int r = 0; r < N; r++) for (int c = 0; c < N; c++) {
        float ref = 0; for (int k = 0; k < N; k++) ref += A[r * N + k] * B[k * N + c];
        if (fabsf(ref - C[r * N + c]) > 1e-2f) bad++;
    }
    printf("matmul %dx%d: errors=%d C[0]=%.2f\n", N, N, bad, C[0]);
    return bad != 0;
}

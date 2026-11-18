// Mandelbrot escape-time colouring, one GPU thread per pixel.
__global__ void mandelbrot(unsigned* pixels, int width, int height, float time) {
    int x = blockIdx.x * blockDim.x + threadIdx.x;
    int y = blockIdx.y * blockDim.y + threadIdx.y;
    if (x >= width || y >= height) return;
    float scale = 3.0f / (1.0f + time * 0.45f);
    float cx = ((float)x / (float)width - 0.5f) * scale - 0.65f;
    float cy = ((float)y / (float)height - 0.5f) * scale * 0.73f;
    float zx = 0.0f;
    float zy = 0.0f;
    int i = 0;
    while (i < 80 && zx * zx + zy * zy < 4.0f) {
        float next_x = zx * zx - zy * zy + cx;
        zy = 2.0f * zx * zy + cy;
        zx = next_x;
        i = i + 1;
    }
    unsigned color = 0x22130du;
    if (i < 80) {
        unsigned r = (unsigned)(118.0f + 116.0f * cosf((float)i * 0.21f + 0.2f));
        unsigned g = (unsigned)(128.0f + 115.0f * cosf((float)i * 0.18f + 1.9f));
        unsigned b = (unsigned)(145.0f + 103.0f * cosf((float)i * 0.14f + 4.5f));
        color = r | (g << 8) | (b << 16);
    }
    pixels[y * width + x] = color;
}

int render(unsigned* rgba, int w, int h, float t) {
    unsigned* device;
    size_t bytes = (size_t)w * h * sizeof(unsigned);
    cudaError_t err = cudaMalloc((void**)&device, bytes);
    if (err != cudaSuccess) return err;
    dim3 block(8, 8);
    dim3 grid((w + 7) / 8, (h + 7) / 8);
    mandelbrot<<<grid, block>>>(device, w, h, t);
    err = cudaGetLastError();
    if (err == cudaSuccess) err = cudaMemcpy(rgba, device, bytes, cudaMemcpyDeviceToHost);
    cudaFree(device);
    return err;
}

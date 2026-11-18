// tunnel.cu: neon fly-through of a gyroid lattice, raymarched on the GPU.
//   ./tunnel              -> animates in the terminal (truecolor ANSI half blocks)
//   ./tunnel --screen START END [MODE] -> presents a finite range of camera frames on the browser canvas
//   ./tunnel --ppm DIR N  -> writes N frames as DIR/f000.ppm ... at 640x360
#define _POSIX_C_SOURCE 199309L
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <time.h>
#include <signal.h>

static volatile sig_atomic_t interrupted;
static void stop_tunnel(int signal_number) { (void)signal_number; interrupted = 1; }

#define STEPS 90

__device__ float pathx(float z) { return sinf(z * 0.23f) * 1.4f; }
__device__ float pathy(float z) { return cosf(z * 0.17f) * 1.1f; }

__device__ float scene(float x, float y, float z) {
    float s = 1.6f;
    float g = sinf(x * s) * cosf(y * s) + sinf(y * s) * cosf(z * s) + sinf(z * s) * cosf(x * s);
    float shell = (fabsf(g) - 0.22f) / (s * 1.8f);
    float dx = x - pathx(z);
    float dy = y - pathy(z);
    float tunnel = 0.9f - sqrtf(dx * dx + dy * dy);
    return fmaxf(shell, tunnel);
}

__device__ float pal(float t, float phase) { return 0.5f + 0.5f * cosf(6.2831f * (t + phase)); }

__global__ void render(unsigned* img, int W, int H, float time, int mode) {
    int px = blockIdx.x * blockDim.x + threadIdx.x;
    int py = blockIdx.y * blockDim.y + threadIdx.y;
    if (px >= W || py >= H) return;

    float u = ((float)px - 0.5f * (float)W) / (float)H;
    float v = (0.5f * (float)H - (float)py) / (float)H;

    float cz = time * 1.6f;
    float cx = pathx(cz);
    float cy = pathy(cz);
    // look slightly ahead along the path
    float lx = pathx(cz + 1.5f) - cx;
    float ly = pathy(cz + 1.5f) - cy;
    float dx = u + lx * 0.5f;
    float dy = v + ly * 0.5f;
    float dz = 1.3f;
    float inv = 1.0f / sqrtf(dx * dx + dy * dy + dz * dz);
    dx = dx * inv; dy = dy * inv; dz = dz * inv;

    float t = 0.0f;
    float glow = 0.0f;
    int hit = 0;
    int steps = 0;
    for (int i = 0; i < STEPS; i++) {
        steps = i + 1;
        float d = scene(cx + dx * t, cy + dy * t, cz + dz * t);
        glow = glow + 1.0f / (1.0f + d * d * 900.0f);
        if (d < 0.002f) { hit = 1; break; }
        t = t + d * 0.9f;
        if (t > 22.0f) break;
    }

    float hx = cx + dx * t, hy = cy + dy * t, hz = cz + dz * t;
    float r = 0.0f, g = 0.0f, b = 0.0f;
    if (hit == 1) {
        float e = 0.002f;
        float nx = scene(hx + e, hy, hz) - scene(hx - e, hy, hz);
        float ny = scene(hx, hy + e, hz) - scene(hx, hy - e, hz);
        float nz = scene(hx, hy, hz + e) - scene(hx, hy, hz - e);
        float nl = 1.0f / sqrtf(nx * nx + ny * ny + nz * nz + 1e-12f);
        nx = nx * nl; ny = ny * nl; nz = nz * nl;
        float diff = fmaxf(0.0f, -(nx * dx + ny * dy + nz * dz));
        float rim = powf(1.0f - diff, 3.0f);
        float k = hz * 0.04f + time * 0.03f;
        float band = fabsf(sinf(hz * 2.2f + (hx + hy) * 1.3f - time * 4.0f));
        float ln = expf(-band * 14.0f) * 2.2f;
        float surf = 0.10f * diff + 0.55f * rim;
        r = pal(k, 0.0f) * surf + ln * pal(k + 0.5f, 0.0f);
        g = pal(k, 0.33f) * surf + ln * pal(k + 0.5f, 0.33f);
        b = pal(k, 0.67f) * surf + ln * pal(k + 0.5f, 0.67f);
    }
    float fog = expf(-t * 0.16f);
    float gk = time * 0.05f + 0.3f;
    float gl = glow * 0.012f;
    r = r * fog + gl * pal(gk, 0.0f);
    g = g * fog + gl * pal(gk, 0.33f);
    b = b * fog + gl * pal(gk, 0.67f);
    // tone map + vignette
    float vig = 1.0f - 0.35f * (u * u + v * v);
    r = (1.0f - expf(-r * 1.6f)) * vig;
    g = (1.0f - expf(-g * 1.6f)) * vig;
    b = (1.0f - expf(-b * 1.6f)) * vig;
    // Reveal the work each ray performed, using the counter from the tracing loop.
    if (mode == 1) {
        float effort = sqrtf((float)steps / (float)STEPS);
        r = fminf(1.0f, fmaxf(0.0f, 2.3f * effort - 0.5f));
        g = fminf(1.0f, fmaxf(0.0f, 2.0f * effort - 0.9f));
        b = 0.16f + 0.55f * (1.0f - effort);
    }
    unsigned R = (unsigned)(fminf(fmaxf(r, 0.0f), 1.0f) * 255.0f);
    unsigned G = (unsigned)(fminf(fmaxf(g, 0.0f), 1.0f) * 255.0f);
    unsigned B = (unsigned)(fminf(fmaxf(b, 0.0f), 1.0f) * 255.0f);
    img[py * W + px] = R | (G << 8) | (B << 16) | 0xff000000u;
}

static void launch_frame(unsigned* dimg, int W, int H, float t, int mode) {
    dim3 block(16, 16);
    dim3 grid((W + 15) / 16, (H + 15) / 16);
    render<<<grid, block>>>(dimg, W, H, t, mode);
    if (cudaGetLastError() != cudaSuccess) exit(1);
}

static void frame(unsigned* dimg, unsigned* himg, int W, int H, float t) {
    launch_frame(dimg, W, H, t, 0);
    if (cudaMemcpy(himg, dimg, W * H * 4, cudaMemcpyDeviceToHost) != cudaSuccess) exit(1);
}

int main(int argc, char** argv) {
    if ((argc == 4 || argc == 5) && strcmp(argv[1], "--screen") == 0) {
        const int width = 640, height = 360;
        int start = atoi(argv[2]), end = atoi(argv[3]);
        int mode = argc == 5 ? atoi(argv[4]) : 0;
        if (start < 0 || end > 120 || start > end || mode < 0 || mode > 1) return 2;
        unsigned *pixels;
        if (cudaMalloc((void**)&pixels, width * height * 4) != cudaSuccess) return 1;
        for (int f = start; f <= end; f++) {
            launch_frame(pixels, width, height, f * 0.075f, mode);
            if (cudawgPresent(pixels, width, height, (unsigned)f) != cudaSuccess) return 1;
            if (f < end) {
                struct timespec delay = { 0, 33000000 };
                nanosleep(&delay, NULL);
            }
        }
        return cudaFree(pixels) != cudaSuccess;
    }
    if (argc >= 4 && strcmp(argv[1], "--ppm") == 0) {
        int W = 640, H = 360, n = atoi(argv[3]);
        unsigned *h = malloc(W * H * 4), *d;
        unsigned char* rgb = malloc(W * H * 3);
        cudaMalloc((void**)&d, W * H * 4);
        for (int f = 0; f < n; f++) {
            frame(d, h, W, H, f / 24.0f);
            for (int i = 0; i < W * H; i++) {
                rgb[i * 3] = h[i] & 255; rgb[i * 3 + 1] = (h[i] >> 8) & 255; rgb[i * 3 + 2] = (h[i] >> 16) & 255;
            }
            char path[512]; snprintf(path, sizeof path, "%s/f%03d.ppm", argv[2], f);
            FILE* fp = fopen(path, "wb");
            fprintf(fp, "P6\n%d %d\n255\n", W, H); fwrite(rgb, 1, W * H * 3, fp); fclose(fp);
            fprintf(stderr, "\rframe %d/%d", f + 1, n);
        }
        fprintf(stderr, "\n");
        return cudaGetLastError() != cudaSuccess;
    }
    // terminal mode: each character cell = 2 vertical pixels using the upper half block
    int cols = 120, rows = 36, W = cols, H = rows * 2;
    if (argc >= 3) {
        cols = atoi(argv[1]); rows = atoi(argv[2]);
        if (cols < 1 || cols > 512 || rows < 1 || rows > 256) return 2;
        W = cols; H = rows * 2;
    }
    int frames = argc >= 4 ? atoi(argv[3]) : 0;
    struct sigaction action;
    memset(&action, 0, sizeof action);
    action.sa_handler = stop_tunnel;
    sigemptyset(&action.sa_mask);
    sigaction(SIGINT, &action, NULL);
    unsigned *h = malloc(W * H * 4), *d;
    char* out = malloc((size_t)cols * rows * 48 + 64);
    cudaMalloc((void**)&d, W * H * 4);
    printf("\x1b[2J\x1b[?25l");
    for (int f = 0; !interrupted && (frames == 0 || f < frames); f++) {
        frame(d, h, W, H, f / 20.0f);
        char* p = out;
        p += sprintf(p, "\x1b[H");
        for (int y = 0; y < rows; y++) {
            for (int x = 0; x < cols; x++) {
                unsigned a = h[(2 * y) * W + x], b = h[(2 * y + 1) * W + x];
                p += sprintf(p, "\x1b[38;2;%u;%u;%um\x1b[48;2;%u;%u;%um\xe2\x96\x80",
                             a & 255, (a >> 8) & 255, (a >> 16) & 255, b & 255, (b >> 8) & 255, (b >> 16) & 255);
            }
            p += sprintf(p, "\x1b[0m\n");
        }
        fwrite(out, 1, p - out, stdout);
        fflush(stdout);
        struct timespec ts = { 0, 30000000 }; nanosleep(&ts, 0);
    }
    printf("\x1b[0m\x1b[?25h\x1b[%d;1H", rows + 1);
    return 0;
}

#include <stdio.h>
#include <string.h>
int main(void) {
    char name[256] = "Adapter unavailable";
    FILE *f = fopen("/opt/cuda/adapter.txt", "r");
    if (f) {
        if (fgets(name, sizeof name, f)) name[strcspn(name, "\r\n")] = 0;
        fclose(f);
    }
    puts("+-------------------------------------------------------------+");
    puts("| cudawg-smi             CUDA subset over WebGPU               |");
    puts("+-------------------------------------------------------------+");
    printf("| %-59.59s |\n", name);
    puts("+-------------------------------------------------------------+");
    puts("Adapter information supplied by the browser. No NVIDIA driver is used.");
    return 0;
}

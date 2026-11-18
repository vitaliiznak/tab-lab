PYTHON ?= python3
ZIG ?= $(PYTHON) -m ziglang
GUEST_CC ?= $(ZIG) cc -target aarch64-linux-musl
CFLAGS := -O2 -std=c11 -static -s -Iruntime
BIN := ../public/cuda
EXAMPLES := vecadd matmul reduce tunnel
all: $(EXAMPLES:%=$(BIN)/%) $(BIN)/nvidia-smi
build $(BIN):
	mkdir -p $@
build/%.c: examples/%.cu cudawgc.py | build
	$(PYTHON) cudawgc.py $< -o $@
$(BIN)/%: build/%.c runtime/cudawg.c runtime/cuda_runtime.h | $(BIN)
	$(GUEST_CC) $(CFLAGS) $< runtime/cudawg.c -lm -o $@
$(BIN)/nvidia-smi: examples/nvidia-smi.c | $(BIN)
	$(GUEST_CC) $(CFLAGS) $< -o $@
.PHONY: all

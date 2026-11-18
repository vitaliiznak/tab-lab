# Browser measurements

Headless Chrome 157 at 1280 × 800 on an Apple M2 Max. The browser reported an Apple metal-3 hardware adapter. Times are wall-clock seconds on a local static server with HTTP ranges and a GitHub Pages project path. Internet latency can change these times. The CUDA rows use precompiled guest binaries and include guest-side input preparation, device transfers, dispatch and verification. For the tunnel, run time ends at the first truecolor half block.

| CUDA command | vCPUs | Guest MiB | Boot s | Run s |
| --- | ---: | ---: | ---: | ---: |
| vecadd | 1 | 192 | 0.366 | 0.280 |
| matmul | 1 | 192 | 0.366 | 0.595 |
| reduce | 1 | 192 | 0.366 | 0.065 |
| tunnel | 1 | 192 | 0.366 | 0.091 |

Rust measurements use the baked offline dependency cache. Each suite started in a fresh browser profile. Hello ran first with an empty disk cache. The other examples then reused previously downloaded chunks. Each warm build reran the same code. Boot is measured to an interactive shell. Build ends when Cargo invokes its runner and run ends on process exit.

| GPU | Example | vCPUs | Guest MiB | Boot s | First build s | Warm build s | First run s | Warm run s | First total s | Warm total s |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| webgpu | hello | 4 | 2048 | 1.554 | 8.682 | 0.841 | 0.004 | 0.005 | 8.687 | 0.846 |
| webgpu | json | 4 | 2048 | 1.554 | 5.422 | 0.879 | 0.006 | 0.006 | 5.428 | 0.885 |
| webgpu | rayon | 4 | 2048 | 1.554 | 5.919 | 0.852 | 0.077 | 0.076 | 5.996 | 0.928 |
| webgpu | query | 4 | 2048 | 1.554 | 5.116 | 0.831 | 0.005 | 0.009 | 5.121 | 0.840 |
| webgpu | fractal | 4 | 2048 | 1.554 | 13.843 | 0.850 | 0.666 | 0.647 | 14.509 | 1.497 |
| webgpu | hello | 1 | 2048 | 1.368 | 9.575 | 0.826 | 0.005 | 0.004 | 9.579 | 0.831 |
| no-webgpu | hello | 1 | 2048 | 1.399 | 9.536 | — | 0.004 | — | 9.540 | — |
| no-webgpu | json | 1 | 2048 | 1.399 | 7.039 | — | 0.006 | — | 7.045 | — |
| no-webgpu | rayon | 1 | 2048 | 1.399 | 9.377 | — | 0.184 | — | 9.561 | — |
| no-webgpu | query | 1 | 2048 | 1.399 | 8.346 | — | 0.005 | — | 8.351 | — |

Image payload counts bytes received over HTTP for the offline data disk and Alpine base. The counter excludes the web application and the WASM kernel. Totals cover boot through the end of the first hello run.

| GPU | vCPUs | Boot bytes | Additional hello bytes | Total image bytes fetched |
| --- | ---: | ---: | ---: | ---: |
| webgpu | 4 | 6,839,144 | 118,207,152 | 125,046,296 |
| webgpu | 1 | 6,839,144 | 118,207,152 | 125,046,296 |
| no-webgpu | 1 | 6,839,144 | 118,207,152 | 125,046,296 |

The data disk has 4,294,967,296 logical bytes. Its stored chunks total 294,840,075 bytes, with another 4,046,848 bytes in the Alpine base.

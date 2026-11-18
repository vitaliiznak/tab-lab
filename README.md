# Tab Lab

Run a real ARM64 Linux shell in a browser, launch CUDA C kernels through WebGPU, and edit and compile Rust with Cargo. The Mandelbrot example compiles Rust, translates its CUDA kernel to WGSL with Python, builds the C bridge with GCC, and draws the results in the terminal. The browser guest has no network.

- **CUDA terminal** mounts five static ARM64 programs at `/opt/cuda`. Try `vecadd`, `matmul`, `reduce`, `tunnel` or `nvidia-smi`. The adapter name comes from WebGPU. The shell also boots on devices without WebGPU, where a six-second recording shows the tunnel.
- **Rust playground** mounts the CodeMirror workspace at `/work`. The buttons and the interactive shell use the same Cargo workspace. The offline toolchain includes rustfmt, Clippy, GCC, Python and seven vendored crate dependencies. WebGPU is needed only for the Mandelbrot example.
- **Runtime** uses [unkernel at 040e142](https://github.com/pithings/unkernel/tree/040e142cd016da066ac018de60fcdcec3201fd24). User programs run on its emulated CPU. Cargo compiles inside the guest. The host fetches static toolchain chunks and caches them by SHA-256. Guest disk writes and source edits last for the session. Share encodes the editor contents in the URL fragment.

## Local development

Use Node 24. From the project root, run `npm ci`, then `bash scripts/fetch-image.sh` to restore the published image or `bash image/build.sh` to build it locally. Run `npm run dev` and open the printed localhost URL. For a static build, run `npm run build` and `npm run preview`. Serve `dist/` as a directory over HTTPS or localhost. The first lab visit registers a same-origin service worker and may reload once.

The [image builder](image/README.md) documents the networked build stage, offline verification, chunk format and package notices. The browser guest never gets a network backend. The [CUDA project](cudawg/README.md) documents the supported language subset and the Node/Dawn baseline. To rerun it, install Zig as documented, then use `npm ci --prefix cudawg && make -C cudawg && npm run test:cuda`.

## Deployment

GitHub Actions verifies the published toolchain archive, builds the static pages and deploys them from `main`. All visitor downloads are served under the same site. The custom domain is `lab.signumspace.net`; the existing Signumspace website has its own hosting configuration.

[Licenses and corresponding source](public/licenses/index.html) · [Alpine package and crate inventory](https://vitaliiznak.github.io/tab-lab/images/packages.json).

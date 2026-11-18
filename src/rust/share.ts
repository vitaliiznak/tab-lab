const maxBytes = 128 * 1024;

export type GpuFiles = { "kernels.cu": string; "build.rs": string };
export type SourceFile = "src/main.rs" | keyof GpuFiles;
type SharedProgram = {
  example: string;
  code: string;
  files?: GpuFiles;
  file?: SourceFile;
};

export async function shareHash(
  example: string,
  code: string,
  files?: GpuFiles,
  file: SourceFile = "src/main.rs",
) {
  const json = JSON.stringify(
    files ? { v: 2, example, code, files, file } : { v: 1, example, code },
  );
  const bytes = new TextEncoder().encode(json);
  if (bytes.byteLength > maxBytes)
    throw Error("Shared programs must fit in 128 KiB.");
  const packed = await new Response(
    new Blob([bytes])
      .stream()
      .pipeThrough(new CompressionStream("deflate-raw")),
  ).bytes();
  let binary = "";
  for (const value of packed) binary += String.fromCharCode(value);
  return (
    "#code=" +
    btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
  );
}

export async function readHash(hash: string): Promise<SharedProgram | null> {
  if (!hash.startsWith("#code=")) return null;
  const payload = hash.slice(6);
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || payload.length > 2 * maxBytes)
    throw Error("Invalid shared program.");
  const packed = Uint8Array.from(
    atob(payload.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
  const reader = new Blob([packed])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"))
    .getReader();
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maxBytes) throw Error("Shared program exceeds 128 KiB.");
      parts.push(new Uint8Array(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const state = JSON.parse(await new Blob(parts).text());
  if (
    ![1, 2].includes(state?.v) ||
    typeof state.code !== "string" ||
    typeof state.example !== "string"
  )
    throw Error("Invalid shared program.");
  if (state.v === 2) {
    if (
      state.example !== "fractal" ||
      typeof state.files?.["kernels.cu"] !== "string" ||
      typeof state.files?.["build.rs"] !== "string" ||
      !["src/main.rs", "kernels.cu", "build.rs"].includes(state.file)
    )
      throw Error("Invalid shared CUDA project.");
    return {
      example: state.example,
      code: state.code,
      file: state.file,
      files: {
        "kernels.cu": state.files["kernels.cu"],
        "build.rs": state.files["build.rs"],
      },
    };
  }
  return { example: state.example, code: state.code };
}

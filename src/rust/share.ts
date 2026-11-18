const maxBytes = 128 * 1024;

export async function shareHash(example: string, code: string) {
  const json = JSON.stringify({ v: 1, example, code });
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

export async function readHash(
  hash: string,
): Promise<{ example: string; code: string } | null> {
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
    state?.v !== 1 ||
    typeof state.code !== "string" ||
    typeof state.example !== "string"
  )
    throw Error("Invalid shared program.");
  return { example: state.example, code: state.code };
}

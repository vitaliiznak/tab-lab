// Imported before the COI worker's catch-all fetch listener. unkernel mounts the
// two virtual URLs as real block devices, so the same image works in SMP mode.
(() => {
  const root = new URL("images/", self.registration.scope);
  const diskPath = root.pathname + "toolchain.disk";
  const alpinePath = root.pathname + "base.disk";
  const manifestRequests = new Map();
  const loading = new Map();
  const recent = new Map();
  const cacheName = "tab-lab-image-v1";

  function record(id, bytes) {
    if (!id || !bytes) return;
    const channel = new BroadcastChannel("tab-lab-bytes-" + id);
    channel.postMessage(bytes);
    channel.close();
  }

  async function sha256(bytes) {
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function getManifest(revision) {
    if (!manifestRequests.has(revision)) {
      const load = async () => {
        const response = await fetch(new URL("manifest.json", root), {
          cache: "no-cache",
        });
        if (!response.ok) throw Error("Cannot load the toolchain manifest");
        const bytes = await response.arrayBuffer();
        if ((await sha256(bytes)) !== revision)
          throw Error("Toolchain image changed. Reload this tab.");
        const manifest = JSON.parse(new TextDecoder().decode(bytes));
        if (
          manifest.encoding !== "gzip" ||
          !Number.isSafeInteger(manifest.size) ||
          !Number.isSafeInteger(manifest.chunkSize) ||
          manifest.chunkSize < 512 ||
          manifest.chunks.length !==
            Math.ceil(manifest.size / manifest.chunkSize)
        ) {
          throw Error("Invalid toolchain image manifest");
        }
        return manifest;
      };
      manifestRequests.set(
        revision,
        load().catch((e) => {
          manifestRequests.delete(revision);
          throw e;
        }),
      );
    }
    return manifestRequests.get(revision);
  }

  async function loadExtent(entry, member, expected, session) {
    const id = member ? member.sha256 : entry.sha256;
    if (recent.has(id)) return recent.get(id);
    if (loading.has(id)) return loading.get(id);
    const read = async () => {
      const asset = new URL(entry.file, root);
      if (
        asset.origin !== root.origin ||
        !asset.pathname.startsWith(root.pathname)
      )
        throw Error("Invalid chunk path");
      const key = (hash) => new URL("cache/" + hash, root);
      const cache = await caches.open(cacheName).catch(() => undefined);
      const stored = await cache?.match(key(id));
      let packed = stored && (await stored.arrayBuffer());
      if (!packed && member) {
        const whole = await cache?.match(key(entry.sha256));
        if (whole)
          packed = (await whole.arrayBuffer()).slice(
            member.offset,
            member.offset + member.bytes,
          );
      }
      if (!packed) {
        const headers = member
          ? {
              Range:
                "bytes=" +
                member.offset +
                "-" +
                (member.offset + member.bytes - 1),
            }
          : {};
        const download = await fetch(asset, { headers });
        if (!download.ok) throw Error("Missing image chunk " + entry.file);
        packed = await download.arrayBuffer();
        record(session, packed.byteLength);
        const wholeResponse = !member || download.status === 200;
        const received = wholeResponse ? entry : member;
        if (
          packed.byteLength !== received.bytes ||
          (await sha256(packed)) !== received.sha256
        ) {
          throw Error("Checksum mismatch for " + entry.file);
        }
        await cache
          ?.put(key(received.sha256), new Response(packed))
          .catch(() => {});
        if (member && wholeResponse)
          packed = packed.slice(member.offset, member.offset + member.bytes);
      }
      const decoded = new Uint8Array(
        await new Response(
          new Blob([packed])
            .stream()
            .pipeThrough(new DecompressionStream("gzip")),
        ).arrayBuffer(),
      );
      if (decoded.length !== expected)
        throw Error("Incorrect image extent size");
      if (recent.size >= 32) recent.delete(recent.keys().next().value);
      recent.set(id, decoded);
      return decoded;
    };
    loading.set(
      id,
      read().finally(() => loading.delete(id)),
    );
    return loading.get(id);
  }

  function bounds(header, size) {
    const m = /^bytes=(\d+)-(\d*)$/i.exec(header || "");
    if (!m) return null;
    const start = Number(m[1]),
      end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    return start <= end && end - start < 8 * 1024 * 1024 ? [start, end] : null;
  }

  function partial(bytes, start, end, size, revision) {
    return new Response(bytes, {
      status: 206,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(end - start + 1),
        "Accept-Ranges": "bytes",
        "Content-Range": "bytes " + start + "-" + end + "/" + size,
        "Cross-Origin-Resource-Policy": "same-origin",
        ETag: '"' + revision + '"',
      },
    });
  }

  async function imageRange(request, url) {
    const revision = url.searchParams.get("v");
    const session = url.searchParams.get("id");
    const manifest = await getManifest(revision);
    const range = bounds(request.headers.get("range"), manifest.size);
    if (!range)
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": "bytes */" + manifest.size },
      });
    const [start, end] = range;
    const answer = new Uint8Array(end - start + 1);
    const cs = manifest.chunkSize;
    for (
      let index = Math.floor(start / cs);
      index <= Math.floor(end / cs);
      index++
    ) {
      const offset = index * cs;
      const from = Math.max(start, offset),
        to = Math.min(end + 1, offset + cs);
      const entry = manifest.chunks[index];
      if (!entry.file) continue;
      if (entry.members && manifest.memberSize) {
        const ms = manifest.memberSize;
        const first = Math.floor((from - offset) / ms);
        const last = Math.floor((to - 1 - offset) / ms);
        for (let n = first; n <= last; n++) {
          const base = offset + n * ms;
          const bytes = await loadExtent(
            entry,
            entry.members[n],
            Math.min(ms, manifest.size - base),
            session,
          );
          const begin = Math.max(from, base),
            stop = Math.min(to, base + ms);
          answer.set(bytes.subarray(begin - base, stop - base), begin - start);
        }
      } else {
        const bytes = await loadExtent(
          entry,
          null,
          Math.min(cs, manifest.size - offset),
          session,
        );
        answer.set(bytes.subarray(from - offset, to - offset), from - start);
      }
    }
    return partial(answer, start, end, manifest.size, revision);
  }

  // Ask the static host for just the requested base-image range. A host that
  // returns HTTP 200 on a Range request supplies the base once, then we slice it.
  let alpineWhole;
  async function alpineRange(request, url) {
    const range = request.headers.get("range");
    if (!range) return new Response(null, { status: 416 });
    const asset = new URL("alpine.erofs", root);
    const version = "unkernel-040e142";
    const cache = await caches.open(cacheName).catch(() => undefined);
    const key = new URL(
      "cache/" + version + "-" + encodeURIComponent(range),
      root,
    );
    const fullKey = new URL("cache/" + version + ".erofs", root);
    const cached = await cache?.match(key);
    if (cached)
      return new Response(cached.body, {
        status: 206,
        headers: cached.headers,
      });
    if (!alpineWhole) {
      const whole = await cache?.match(fullKey);
      if (whole) alpineWhole = new Uint8Array(await whole.arrayBuffer());
    }
    if (!alpineWhole) {
      const response = await fetch(asset, { headers: { Range: range } });
      if (!response.ok) throw Error("Missing Alpine image");
      const bytes = new Uint8Array(await response.arrayBuffer());
      record(url.searchParams.get("id"), bytes.length);
      if (response.status === 206) {
        const result = new Response(bytes, {
          status: 206,
          headers: {
            "Content-Range": response.headers.get("content-range") || "",
            "Content-Length": String(bytes.length),
            "Accept-Ranges": "bytes",
            ETag: '"' + version + '"',
            "Cross-Origin-Resource-Policy": "same-origin",
          },
        });
        await cache
          ?.put(key, new Response(bytes, { headers: result.headers }))
          .catch(() => {});
        return result;
      }
      alpineWhole = bytes;
      await cache?.put(fullKey, new Response(bytes)).catch(() => {});
    }
    const limits = bounds(range, alpineWhole.length);
    if (!limits) return new Response(null, { status: 416 });
    const [start, end] = limits;
    return partial(
      alpineWhole.subarray(start, end + 1),
      start,
      end,
      alpineWhole.length,
      version,
    );
  }

  self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);
    if (
      url.origin !== root.origin ||
      (url.pathname !== diskPath && url.pathname !== alpinePath)
    )
      return;
    event.stopImmediatePropagation();
    const read = url.pathname === diskPath ? imageRange : alpineRange;
    event.respondWith(
      read(event.request, url).catch(
        (error) => new Response(error.message, { status: 503 }),
      ),
    );
  });
})();

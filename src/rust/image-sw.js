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

  const pendingWhole = new Map();
  async function verify(bytes, description) {
    if (
      bytes.byteLength !== description.bytes ||
      (await sha256(bytes)) !== description.sha256
    ) {
      throw Error("Image checksum mismatch: " + description.sha256);
    }
    return bytes;
  }

  async function readAsset(asset, file, part, session) {
    const cache = await caches.open(cacheName).catch(() => undefined);
    const key = (spec) => new URL("cache/" + spec.sha256, root);
    const saved = async (spec) => {
      const hit = await cache?.match(key(spec));
      if (!hit) return;
      try {
        return await verify(await hit.arrayBuffer(), spec);
      } catch {
        /* Replace damaged local cache entries from the source. */
      }
    };
    const store = async (response, spec) => {
      const bytes = await response.arrayBuffer();
      record(session, bytes.byteLength);
      await verify(bytes, spec);
      await cache?.put(key(spec), new Response(bytes)).catch(() => {});
      return bytes;
    };
    const slice = (bytes) =>
      part
        ? verify(bytes.slice(part.offset, part.offset + part.bytes), part)
        : bytes;
    const cached = await saved(part || file);
    if (cached) return cached;
    if (part) {
      const whole = await saved(file);
      if (whole) return slice(whole);
      try {
        const first = part.offset;
        const last = first + part.bytes - 1;
        const response = await fetch(asset, {
          headers: { Range: "bytes=" + first + "-" + last },
        });
        if (response.status === 200) return slice(await store(response, file));
        const encoding = response.headers.get("Content-Encoding");
        if (
          response.status !== 206 ||
          (encoding && encoding.toLowerCase() !== "identity") ||
          response.headers.get("Content-Range") !==
            "bytes " + first + "-" + last + "/" + file.bytes
        ) {
          void response.body?.cancel().catch(() => {});
          throw Error("Range refers to a different representation");
        }
        return await store(response, part);
      } catch {
        // Some CDNs apply Range to an HTTP-gzipped representation. Fetch handles
        // transport decoding on a complete response, whose file hash we verify.
      }
    }
    if (!pendingWhole.has(file.sha256)) {
      const download = async () => {
        const response = await fetch(asset, { cache: "reload" });
        if (response.status !== 200)
          throw Error("Cannot load complete image asset " + asset.pathname);
        return await store(response, file);
      };
      pendingWhole.set(
        file.sha256,
        download().finally(() => pendingWhole.delete(file.sha256)),
      );
    }
    return slice(await pendingWhole.get(file.sha256));
  }

  function memo(id, read) {
    if (recent.has(id)) return recent.get(id);
    if (!loading.has(id)) {
      loading.set(
        id,
        read()
          .then((bytes) => {
            if (recent.size >= 32) recent.delete(recent.keys().next().value);
            recent.set(id, bytes);
            return bytes;
          })
          .finally(() => loading.delete(id)),
      );
    }
    return loading.get(id);
  }

  function loadExtent(entry, member, expected, session) {
    const id = member ? member.sha256 : entry.sha256;
    return memo(id, async () => {
      const asset = new URL(entry.file, root);
      if (
        asset.origin !== root.origin ||
        !asset.pathname.startsWith(root.pathname)
      )
        throw Error("Invalid chunk path");
      const packed = await readAsset(asset, entry, member, session);
      const decoded = new Uint8Array(
        await new Response(
          new Blob([packed])
            .stream()
            .pipeThrough(new DecompressionStream("gzip")),
        ).arrayBuffer(),
      );
      if (decoded.length !== expected)
        throw Error("Incorrect image extent size");
      return decoded;
    });
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

  // Raw 256 KiB ranges of the pinned unkernel Alpine image, including its short final range.
  const alpine = {
    bytes: 4046848,
    sha256: "f05a6163bad2547790a92ba1accfa317881d0306694d719202aa39afc39669f6",
  };
  const alpineBlockSize = 262144;
  const alpineHashes = [
    "0d257add1cd5a8f38890cc5b486d03c0ca18ac4c1a9971fd04b29e376a85ff1d",
    "da798fb3ed08139591cd28edd7afd25bda018dcf908dcaf02b77c9b659186d6f",
    "b7f2c3dc44085258297489f31d02ad28167834a26ca207792efa31debd62cdc3",
    "41eb5feb2a11cb20b47b3ffa421f4fb92494c197f42b29fda52a41178d7be9f2",
    "471c9dd8c8959766dddf97bcc39ae580273a29f21fbf53243af2827a3d14d9f2",
    "44532dd38082174dfde9b4fadbccec5660244cdae372b2763e9bcce57e814305",
    "6da1286f816148284f9c0e58ebfd4a17703d7d58e9cfc9494c178df7b92c5136",
    "920eaff47c8afc7bb7ad155bacc9cc03e1ac1de2ab80c7fce2114b9c821a8fe1",
    "9940f5adf66de1a814a20c591a359e0726f18583470a66033e5b9ba1db3f6bd1",
    "acb8adc7e8115e8f6b2cf6b6925e21af8441e9cb98e7fb40c15e52bed2b12ce6",
    "e20e94482d03d5f401e08793e1c9ddc43754fcbf028878d34a98b72cf2426be3",
    "cc128bc5b1bed8ebbd53a52d9b41c3583e525498044e32a1fbc9a6269fb50663",
    "4bbbc99dda1084c97bab3d29c0be400c9023d171e2790144c9ef0f69db2fbf18",
    "d303d583973edac2e20f2268a7e8dd355fee1e4117a924ae5a3f476edcd7dfbc",
    "db4af4aa0b891af0a78ef97443e3393d1e06fa8ec0a9031ece1fd96b03fac4a6",
    "932130f6978d8bfd0ef89445be0dbf4a536140ed7c2035f4c72f40d3f93a662a",
  ];
  async function alpineRange(request, url) {
    const range = bounds(request.headers.get("Range"), alpine.bytes);
    if (!range)
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": "bytes */" + alpine.bytes },
      });
    const [start, end] = range;
    const asset = new URL("alpine.erofs", root);
    const data = new Uint8Array(end - start + 1);
    const first = Math.floor(start / alpineBlockSize);
    const last = Math.floor(end / alpineBlockSize);
    for (let n = first; n <= last; n++) {
      const offset = n * alpineBlockSize;
      const block = {
        offset,
        bytes: Math.min(alpineBlockSize, alpine.bytes - offset),
        sha256: alpineHashes[n],
      };
      const bytes = await memo(
        block.sha256,
        async () =>
          new Uint8Array(
            await readAsset(asset, alpine, block, url.searchParams.get("id")),
          ),
      );
      const begin = Math.max(start, offset);
      const stop = Math.min(end + 1, offset + bytes.length);
      data.set(bytes.subarray(begin - offset, stop - offset), begin - start);
    }
    return partial(data, start, end, alpine.bytes, alpine.sha256);
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

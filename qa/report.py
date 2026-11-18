"""Summarize the latest browser measurements per example and CPU count."""
from collections import defaultdict
from pathlib import Path
import json

root = Path(__file__).resolve().parents[1]
out = root / "output/playwright"
measurements = [json.loads(line) for line in (out/"measurements.jsonl").read_text().splitlines()]
cuda = {}
rust = defaultdict(dict)
for row in measurements:
    if row["mode"] == "cuda":
        cuda[row["example"]] = row
    if row["mode"] in ("webgpu", "no-webgpu"):
        rust[row["mode"], int(row["cpus"]), row["example"]][row["attempt"]] = row

def seconds(ms):
    return f"{float(ms) / 1000:.3f}"

def count(value):
    return f"{int(value):,}"

lines = [
    "# Browser measurements",
    "",
    "Chrome, headless at 1280 × 800 on an Apple M2 Max. Times are wall-clock seconds on a local static server. The CUDA rows use precompiled guest binaries and include guest-side input preparation, device transfers, dispatch and verification. For the tunnel, run time ends at the first truecolor half block.",
    "",
    "| CUDA command | vCPUs | Guest MiB | Boot s | Run s |",
    "| --- | ---: | ---: | ---: | ---: |",
]
for name, row in cuda.items():
    lines.append(f"| {name} | {row['cpus']} | {row['memoryMiB']} | {seconds(row['bootMs'])} | {seconds(row['runMs'])} |")

if rust:
    lines.extend(["", "Rust measurements use the baked offline dependency cache. “First” is the first build after loading that example in the named session; “warm” repeats it with no source change. For each GPU mode and CPU count, hello is the first build after an empty browser cache. Boot is measured to an interactive shell. Build ends when Cargo invokes its runner and run ends on process exit.", "",
       "| GPU | Example | vCPUs | Guest MiB | Boot s | First build s | Warm build s | First run s | Warm run s | First total s | Warm total s |",
       "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"])
    for (mode, cpus, name), trials in rust.items():
        if "first" not in trials: continue
        row = trials["first"]; warm = trials.get("warm",{})
        times = [seconds(value) if value is not None else "—" for value in [row["bootMs"],row["compileMs"],warm.get("compileMs"),row["runMs"],warm.get("runMs"),row["elapsedMs"],warm.get("elapsedMs")]]
        lines.append("| " + " | ".join([mode,name,str(cpus),row["memoryMib"],*times]) + " |")
    lines.extend(["", "Image payload means compressed static disk bytes received over HTTP for the guest, including the Alpine base. The counter excludes the web application and the WASM kernel. Measures through the end of the first hello build and run.", "",
        "| GPU | vCPUs | Boot bytes | Additional hello bytes | Total image bytes fetched |",
        "| --- | ---: | ---: | ---: | ---: |"])
    for (mode, cpus, name), trials in rust.items():
        if name != 'hello' or 'first' not in trials: continue
        row = trials["first"]
        lines.append("| " + " | ".join([mode,str(cpus),count(row["bootImageBytes"]),count(row["actionImageBytes"]),count(row["imageBytes"])]) + " |")
    manifest = root/"public/images/manifest.json"
    if manifest.exists():
        meta = json.loads(manifest.read_text())
        size = (manifest.parent/'alpine.erofs').stat().st_size
        lines.extend(["", f'The data disk has {count(meta["size"])} logical bytes. Its stored chunks total {count(meta["compressedBytes"])} bytes, with another {count(size)} bytes in the Alpine base.'])
(root/"qa/measurements.md").write_text("\n".join(lines)+"\n")

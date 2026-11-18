"""Emit distribution and upstream source locations for everything on the lab disk."""
from pathlib import Path
import json
import tomllib
from urllib.parse import quote

records = []
for paragraph in Path("/lib/apk/db/installed").read_text().strip().split("\n\n"):
    fields = dict(line.split(":", 1) for line in paragraph.splitlines() if ":" in line)
    name, version = fields["P"], fields["V"]
    origin = fields.get("o", name)
    commit = fields.get("c", "3.24-stable")
    records.append(dict(name=name, version=version, license=fields.get("L"), project=fields.get("U"),
                        origin=origin, aports=f"https://gitlab.alpinelinux.org/alpine/aports/-/tree/{quote(commit, safe='')}",
                        distfiles="https://distfiles.alpinelinux.org/distfiles/v3.24/"))
crates = []
for manifest in sorted(Path("/opt/lab/vendor").glob("*/Cargo.toml")):
    package = tomllib.loads(manifest.read_text())["package"]
    name, version = package["name"], package["version"]
    crates.append(dict(name=name, version=version, license=package.get("license"), source=f"https://crates.io/crates/{name}/{version}",
                       guestSource=str(manifest.parent)))
print(json.dumps({"alpine":"v3.24/aarch64", "apk":sorted(records,key=lambda r:r["name"]), "crates":crates}, indent=2))

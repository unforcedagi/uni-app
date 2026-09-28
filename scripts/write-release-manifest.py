#!/usr/bin/env python3
"""Publish signed Mac + Android update manifests by atomic pointer swap."""
import json
import os
from pathlib import Path
import sys
from datetime import datetime, timezone

serve, version, sha, base = sys.argv[1:]
root = Path(serve)
sig = (root / "mac" / f"Uni-{version}.app.tar.gz.sig").read_text().strip()
assert sig and len(sig) > 50
assert (root / "mac" / f"Uni-{version}.app.tar.gz").is_file()
assert (root / "uni.apk").is_file()
mac = {
    "version": version,
    "notes": f"Uni {version} ({sha[:12]})",
    "pub_date": datetime.now(timezone.utc).isoformat(),
    "platforms": {"darwin-aarch64": {
        "signature": sig,
        "url": f"{base}/mac/Uni-{version}.app.tar.gz"
    }}
}
android = {"version": version, "url": f"{base}/uni.apk"}
for path, data in [(root / "mac" / "latest.json", mac), (root / "android" / "latest.json", android)]:
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2) + "\n")
    os.replace(tmp, path)

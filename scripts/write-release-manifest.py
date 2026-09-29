#!/usr/bin/env python3
"""Write the Mac updater manifest (latest.json) and Android manifest (android.json)
into the release stage directory; both are uploaded as GitHub release assets."""
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

stage, version, sha, repo = sys.argv[1:]
root = Path(stage)
sig = (root / "Uni.app.tar.gz.sig").read_text().strip()
assert sig and len(sig) > 50
assert (root / "Uni.app.tar.gz").is_file() and (root / "uni.apk").is_file()
base = f"https://github.com/{repo}/releases/download/uni-v{version}"
mac = {
    "version": version,
    "notes": f"Uni {version} ({sha[:12]})",
    "pub_date": datetime.now(timezone.utc).isoformat(),
    "platforms": {"darwin-aarch64": {"signature": sig, "url": f"{base}/Uni.app.tar.gz"}},
}
android = {"version": version, "url": f"{base}/uni.apk"}
(root / "latest.json").write_text(json.dumps(mac, indent=2) + "\n")
(root / "android.json").write_text(json.dumps(android, indent=2) + "\n")

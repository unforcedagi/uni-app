#!/usr/bin/env python3
"""Write the Mac updater manifest (latest.json) and Android manifest (android.json)
into the release stage directory; both are uploaded as GitHub release assets.

    write-release-manifest.py <stage> <version> <sha> <repo> [--android-from <apk version>]

T-335 OTA: a screens-only release has no APK. Its android.json keeps pointing at the last APK release
(--android-from), so phones are offered no APK; they take the screens bundle (web.json) instead."""
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

args = sys.argv[1:]
apk_version = None
if "--android-from" in args:
    i = args.index("--android-from")
    apk_version = args[i + 1]
    del args[i:i + 2]
stage, version, sha, repo = args
root = Path(stage)
sig = (root / "Uni.app.tar.gz.sig").read_text().strip()
assert sig and len(sig) > 50
assert (root / "Uni.app.tar.gz").is_file()
assert apk_version is not None or (root / "uni.apk").is_file()
base = f"https://github.com/{repo}/releases/download/uni-v{version}"
mac = {
    "version": version,
    "notes": f"Uni {version} ({sha[:12]})",
    "pub_date": datetime.now(timezone.utc).isoformat(),
    "platforms": {"darwin-aarch64": {"signature": sig, "url": f"{base}/Uni.app.tar.gz"}},
}
android = ({"version": version, "url": f"{base}/uni.apk"} if apk_version is None else
           {"version": apk_version, "url": f"https://github.com/{repo}/releases/download/uni-v{apk_version}/uni.apk"})
(root / "latest.json").write_text(json.dumps(mac, indent=2) + "\n")
(root / "android.json").write_text(json.dumps(android, indent=2) + "\n")

#!/usr/bin/env python3
"""Advance the app's three package versions and Android's integer versionCode."""
import json
from pathlib import Path
import re

root = Path(__file__).resolve().parent.parent
package = root / "package.json"
config = root / "src-tauri/tauri.conf.json"
cargo = root / "Cargo.toml"
lock = root / "Cargo.lock"
p = json.loads(package.read_text())
major, minor, patch = map(int, p["version"].split("."))
old = p["version"]
version = f"{major}.{minor}.{patch + 1}"
p["version"] = version
package.write_text(json.dumps(p, indent=2) + "\n")
t = json.loads(config.read_text())
assert t["version"] == old, "config/package version drift"
t["version"] = version
t["bundle"]["android"]["versionCode"] += 1
config.write_text(json.dumps(t, indent=2) + "\n")
c = cargo.read_text()
assert f'version = "{old}"' in c
cargo.write_text(c.replace(f'version = "{old}"', f'version = "{version}"', 1))
c = lock.read_text()
for name in ("uni-core", "uni-core-cli", "uni-app-tauri"):
    needle = f'name = "{name}"\nversion = "{old}"'
    assert c.count(needle) == 1, name
    c = c.replace(needle, f'name = "{name}"\nversion = "{version}"')
lock.write_text(c)
print(f"Bumped {old} -> {version}, Android versionCode {t['bundle']['android']['versionCode']}")

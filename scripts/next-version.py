#!/usr/bin/env python3
"""Print the next release version and Android versionCode.

Version = one patch above the newest uni-v* tag, unless package.json names a
higher version (edit package.json to jump minor/major). The repo is never
bumped by the pipeline; the version is stamped into the build via --config.
versionCode is derived from semver so it only ever increases.
"""
import json
import re
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parent.parent
parse = lambda v: tuple(map(int, v.split(".")))
tags = subprocess.run(["git", "tag", "-l", "uni-v*"], cwd=root, capture_output=True, text=True, check=True).stdout.split()
released = [parse(t[5:]) for t in tags if re.fullmatch(r"uni-v\d+\.\d+\.\d+", t)]
floor = parse(json.loads((root / "package.json").read_text())["version"])
if released:
    last = max(released)
    nxt = (last[0], last[1], last[2] + 1)
    version = max(nxt, floor)
else:
    version = floor
major, minor, patch = version
assert minor < 100 and patch < 1000
code = 1_000_000 + major * 100_000 + minor * 1_000 + patch
print(f"{major}.{minor}.{patch} {code}")

#!/usr/bin/env python3
"""Reject tracked paths that cannot coexist on a case-insensitive macOS volume.

The normalizer uses Unicode casefold + NFC and checks complete paths (including
extensions), not module stems: Search.tsx and search.ts are legal distinct files.
"""
import subprocess
import sys
import unicodedata


def collisions(paths):
    seen = {}
    pairs = []
    for path in paths:
        key = unicodedata.normalize("NFC", path).casefold()
        if key in seen and path != seen[key]:
            pairs.append((seen[key], path))
        else:
            seen[key] = path
    return pairs


if __name__ == "__main__":
    tracked = subprocess.check_output(["git", "ls-files", "-z"]).decode().rstrip("\0").split("\0")
    found = collisions(tracked)
    for a, b in found:
        print(f"case-insensitive collision: {a} <> {b}", file=sys.stderr)
    if found:
        sys.exit(1)
    print("Case-insensitive paths: OK")

#!/usr/bin/env python3
"""Reject tracked paths that cannot coexist on a case-insensitive macOS volume.

The normalizer uses Unicode casefold + NFC and checks complete paths. Script modules are also checked by stem,
because imports leave the extension off: beside Search.tsx, a search.ts makes macOS resolve "./Search" to it
(uni-v0.1.62's Mac build failed on exactly this).
"""
import subprocess
import sys
import unicodedata

MODULE_EXTS = (".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs")


def collisions(paths):
    seen = {}
    modules = {}
    pairs = []
    for path in paths:
        key = unicodedata.normalize("NFC", path).casefold()
        if key in seen and path != seen[key]:
            pairs.append((seen[key], path))
            continue
        seen[key] = path
        stem, dot, ext = path.rpartition(".")
        if dot and "/" not in ext and f".{ext.lower()}" in MODULE_EXTS:
            norm = unicodedata.normalize("NFC", stem)
            other = modules.setdefault(norm.casefold(), (norm, path))
            if other[0] != norm:  # Foo.ts beside Foo.tsx is fine; Foo.tsx beside foo.ts is not
                pairs.append((other[1], path))
    return pairs


if __name__ == "__main__":
    tracked = subprocess.check_output(["git", "ls-files", "-z"]).decode().rstrip("\0").split("\0")
    found = collisions(tracked)
    for a, b in found:
        print(f"case-insensitive collision: {a} <> {b}", file=sys.stderr)
    if found:
        sys.exit(1)
    print("Case-insensitive paths: OK")

#!/usr/bin/env python3
"""T-335 OTA: does this release need an APK, or can phones take it as new screens over the air?

    python3 scripts/release-kind.py <last-apk file> [<commit>]

Prints one line: ``bundle <last APK version> <shell API>`` when every change since the last APK release is in the
screens (and the shell API and the screens' dependencies are unchanged), else ``apk <why>``. The last APK release is
recorded by publish.sh in the given file as ``<version> <commit> <shell API>``. Anything unknown means an APK: no file,
an unreadable one, a commit that isn't an ancestor, a path that isn't the screens', ``UNI_RELEASE_KIND=apk``.
"""
import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# What only the screens (the Vite dist/) are built from, or what never ships at all. Everything else (src-tauri/,
# crates/, Cargo files, the Android project, pnpm-lock.yaml, ...) is the shell or can change it: an APK.
SCREENS = re.compile(r"(src/|public/|docs/|scripts/|\.github/).*|index\.html|vite\.config\.ts|tsconfig[^/]*\.json"
                     r"|playwright[^/]*\.ts|[^/]*\.md|\.gitignore")
# Under those, what builds or shapes the APK itself: a change here needs an APK to take effect.
APK_TOOLING = re.compile(r"scripts/(android-release-build\.sh|build-mac-hosted\.sh|install-updater-timer\.sh)")
# package.json's fields that change what the screens run on; its "scripts" (the test list) and "version" don't.
PACKAGE_DEPS = ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "pnpm", "overrides",
                "resolutions", "packageManager", "engines", "type")
API_RE = re.compile(r"^export const SHELL_API = (\d+);$", re.M)


def git(*args) -> str:
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, check=True).stdout


def at(commit: str, path: str) -> str | None:
    try:
        return git("show", f"{commit}:{path}")
    except subprocess.CalledProcessError:
        return None


def api(commit: str) -> int | None:
    m = API_RE.search(at(commit, "src/ota.ts") or "")
    return int(m.group(1)) if m else None


def deps(text: str | None) -> dict | None:
    try:
        pkg = json.loads(text or "")
    except ValueError:
        return None
    return {k: pkg.get(k) for k in PACKAGE_DEPS}


def kind(last_apk: Path, head: str) -> str:
    if os.environ.get("UNI_RELEASE_KIND") == "apk":
        return "apk UNI_RELEASE_KIND=apk"
    try:
        version, sha, shell = last_apk.read_text().split()
    except (OSError, ValueError):
        return "apk no last APK release recorded"
    if not re.fullmatch(r"\d+\.\d+\.\d+", version) or not re.fullmatch(r"[0-9a-f]{40}", sha) or not shell.isdigit():
        return "apk the last APK record is malformed"
    if subprocess.run(["git", "merge-base", "--is-ancestor", sha, head], cwd=ROOT).returncode != 0:
        return f"apk the last APK's commit {sha[:12]} is not behind this one"
    now = api(head)
    if now is None or now != int(shell):
        return f"apk the shell API changed ({shell} -> {now})"
    for path in git("diff", "--name-only", "--no-renames", sha, head).splitlines():
        if path == "package.json":
            if deps(at(sha, path)) != deps(at(head, path)) or deps(at(head, path)) is None:
                return "apk package.json's dependencies changed"
        elif not SCREENS.fullmatch(path) or APK_TOOLING.fullmatch(path):
            return f"apk {path} changed since {version}"
    return f"bundle {version} {now}"


if __name__ == "__main__":
    print(kind(Path(sys.argv[1]), sys.argv[2] if len(sys.argv) > 2 else "HEAD"))

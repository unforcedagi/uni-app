#!/usr/bin/env python3
"""Refuse a commit that would put private data into this public repo (T-190).

Scans what git would commit (the index: every tracked path and its staged
content) for three things:

1. Paths that never belong here: screenshots (`__shots__/`, `walkthrough/`
   images and videos) and run notes (`REPORT-*`, `BRIEF-*`, `NEXT-*`,
   `RESULT*`, `WALKTHROUGH*` markdown).
2. Denylisted words: real names, private area names and client domains. They
   are stored only as salted SHA-256 hashes in `scripts/public-denylist.sha256`,
   so the list can't be read or searched for. (The salt is public, so someone
   who guesses a word can confirm it.) Each word, and each dotted or hyphenated
   compound like a domain, of every text file is hashed the same way and compared.
3. Plain patterns: tailnet hosts, the tailnet id, 100.x addresses and real
   @unforced mail addresses. `example` hosts are allowed. A line that must keep
   one of these (shipped config) carries the marker `public-ok` and is listed
   in CLAUDE.md; the marker never exempts a denylisted word.

Findings name the file, line and rule, never the matched text, because CI logs
on a public repo are public. `--show` prints the text, for local use only.

  python3 scripts/check-public.py            check the index (pre-commit, publish.sh)
  python3 scripts/check-public.py --show     the same, printing what matched
  python3 scripts/check-public.py --message F   check a commit message file (commit-msg hook)
  python3 scripts/check-public.py --rev A B  check the tree and message of each commit given (CI)
  python3 scripts/check-public.py --rebuild  regenerate the hashes from the
                                             private list (~/.config/uni/public-denylist.txt)
"""
from __future__ import annotations

import hashlib
import os
import re
import secrets
import subprocess
import sys
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HASHES = ROOT / "scripts" / "public-denylist.sha256"
SOURCE = Path(os.environ.get("UNI_PUBLIC_DENYLIST", Path.home() / ".config" / "uni" / "public-denylist.txt"))
MARKER = "public-ok"

PATH_RULES = [
    ("screenshot", re.compile(r"(^|/)__shots__/")),
    ("walkthrough media", re.compile(r"^walkthrough/.*\.(png|jpe?g|gif|webp|webm|mp4|mov)$", re.I)),
    ("run notes", re.compile(r"(^|/)(REPORT-|BRIEF-|NEXT-|RESULT|WALKTHROUGH)[^/]*\.md$")),
]

# (name, pattern, allowed(match) -> bool)
TEXT_RULES = [
    ("tailnet host", re.compile(r"[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net\b", re.I),
     lambda m: any(label.lower().startswith("example") for label in m.group(0).split("."))),
    ("tailnet id", re.compile(r"taildf9ce2", re.I), lambda m: False),  # public-ok: the pattern itself
    ("100.x address", re.compile(r"(?<!\d)(?<!\d\.)100\.\d{1,3}\.\d{1,3}\.\d{1,3}(?!\d|\.\d)"), lambda m: False),
    ("@unforced address", re.compile(r"[a-z0-9._%+-]+@(?:[a-z0-9-]+\.)*unforced\.(?:org|dev|build)\b", re.I),
     lambda m: False),
]

# Kokoro's English TTS voice ids (`am_<name>`, `bf_<name>`) are product names, not people: dropped before hashing.
VOICE_ID = re.compile(r"(?<![A-Za-z0-9_])[ab][fm]_[a-z]+(?![A-Za-z0-9_])")
WORD = re.compile(r"[a-z0-9]+")
CAMEL = re.compile(r"[A-Z]?[a-z]+|[A-Z]+(?![a-z])|[0-9]+")
COMPOUND = re.compile(r"[a-z0-9]+(?:[.\-_][a-z0-9]+)+")


def tokens(line: str) -> set[str]:
    line = VOICE_ID.sub(" ", line)
    low = line.lower()
    out = set(WORD.findall(low))
    for compound in COMPOUND.findall(low):
        # every run of two or more parts, so `www.client.org/x` still yields `client.org`
        parts = re.split(r"([.\-_])", compound)
        words = parts[::2]
        for i in range(len(words)):
            for j in range(i + 2, len(words) + 1):
                out.add("".join(parts[2 * i:2 * j - 1]))
    out.update(t.lower() for t in CAMEL.findall(line))
    return out


def digest(salt: str, token: str) -> str:
    return hashlib.sha256(f"{salt}:{token}".encode()).hexdigest()


def load_hashes() -> tuple[str, set[str]]:
    salt, hashes = None, set()
    for raw in HASHES.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("salt "):
            salt = line.split(None, 1)[1]
        else:
            hashes.add(line)
    if not salt:
        sys.exit(f"check-public: no salt in {HASHES.relative_to(ROOT)}")
    return salt, hashes


def rebuild() -> int:
    if not SOURCE.exists():
        sys.exit(f"check-public: private list not found at {SOURCE}")
    salt = load_hashes()[0] if HASHES.exists() else secrets.token_hex(16)
    entries = set()
    for raw in SOURCE.read_text().splitlines():
        entry = raw.strip().lower()
        if entry and not entry.startswith("#"):
            entries.add(entry)
    body = sorted(digest(salt, e) for e in entries)
    HASHES.write_text(
        "# uni-app public denylist (T-190): salted SHA-256 of lowercased words that must never be committed.\n"
        "# Generated by `python3 scripts/check-public.py --rebuild` from a private list; do not edit by hand.\n"
        f"salt {salt}\n" + "".join(h + "\n" for h in body)
    )
    print(f"check-public: wrote {len(body)} hashes to {HASHES.relative_to(ROOT)}")
    return 0


def parse_entries(out: bytes, index: bool) -> list[tuple[str, str]]:
    """(blob sha, path) from `git ls-files -s -z` (mode sha stage) or `git ls-tree -r -z` (mode type sha)."""
    blobs = []
    for rec in out.split(b"\0"):
        if not rec:
            continue
        meta, path = rec.split(b"\t", 1)
        mode, a, b = meta.split()
        sha = a if index else b
        if mode != b"160000":  # submodules have no blob
            blobs.append((sha.decode(), path.decode()))
    return blobs


def git(*args: str) -> bytes:
    return subprocess.run(["git", *args], cwd=ROOT, check=True, capture_output=True).stdout


def read_blobs(shas: list[str]):
    proc = subprocess.Popen(["git", "cat-file", "--batch"], cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE)

    def feed():  # from a thread, so a full stdout pipe can't block the writer (and git) for good
        proc.stdin.write("".join(s + "\n" for s in shas).encode())
        proc.stdin.close()

    writer = threading.Thread(target=feed, daemon=True)
    writer.start()
    for _ in shas:
        size = int(proc.stdout.readline().split()[2])
        data = proc.stdout.read(size)
        proc.stdout.read(1)
        yield data
    writer.join()
    proc.wait()


class Scan:
    def __init__(self, show: bool):
        self.salt, self.hashes = load_hashes()
        self.show = show
        self.seen: dict[str, bool] = {}
        self.findings: list[str] = []

    def text(self, where: str, text: str) -> None:
        for n, line in enumerate(text.splitlines(), 1):
            for tok in tokens(line):
                hit = self.seen.get(tok)
                if hit is None:
                    hit = self.seen[tok] = digest(self.salt, tok) in self.hashes
                if hit:
                    self.findings.append(f"{where}:{n}: denylisted word" + (f" '{tok}'" if self.show else ""))
            if MARKER in line:
                continue
            for name, rule, allowed in TEXT_RULES:
                for m in rule.finditer(line):
                    if not allowed(m):
                        self.findings.append(f"{where}:{n}: {name}" + (f" '{m.group(0)}'" if self.show else ""))

    def tree(self, blobs: list[tuple[str, str]], prefix: str = "") -> None:
        for _, path in blobs:
            for name, rule in PATH_RULES:
                if rule.search(path):
                    self.findings.append(f"{prefix}{path}: tracked {name} file (see CLAUDE.md)")
        for (_, path), data in zip(blobs, read_blobs([s for s, _ in blobs])):
            if b"\0" not in data[:8192]:
                self.text(prefix + path, data.decode("utf-8", "replace"))

    def report(self, what: str) -> int:
        if self.findings:
            print("\n".join(self.findings))
            print(f"check-public: {len(self.findings)} finding(s) in {what}. This repo is public; see CLAUDE.md.")
            return 1
        print(f"check-public: ok ({what}, {len(self.hashes)} denylist hashes)")
        return 0


def main(argv: list[str]) -> int:
    if "--rebuild" in argv:
        return rebuild()
    scan = Scan("--show" in argv)
    args = [a for a in argv if a != "--show"]
    if args[:1] == ["--message"]:
        # comment lines are git's template; they are not committed
        msg = "\n".join(l for l in Path(args[1]).read_text().splitlines() if not l.startswith("#"))
        scan.text("commit message", msg)
        return scan.report("the commit message")
    if args[:1] == ["--rev"]:
        for rev in args[1:]:
            sha = git("rev-parse", "--short", rev).decode().strip()
            scan.text(f"{sha} message", git("log", "-1", "--format=%B", rev).decode("utf-8", "replace"))
            scan.tree(parse_entries(git("ls-tree", "-r", "-z", rev), False), f"{sha}:")
        return scan.report(f"{len(args) - 1} commit(s)")
    blobs = parse_entries(git("ls-files", "-s", "-z"), True)
    scan.tree(blobs)
    return scan.report(f"{len(blobs)} tracked files")


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

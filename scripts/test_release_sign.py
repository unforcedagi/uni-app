"""T-335: the release waits for the owner's tap. Runs the real watch-main.sh and publish.sh in a throwaway repo with a
temporary HOME; the builds, the sealed broker, gh, aapt and apksigner are fakes. No network, no keys, no GitHub calls."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
PINNED = "6e9f4f94ffbb86604e02ca97a1b7b764ae0cc341430e92b4c7a4a4f22246b63d"
UNSIGNED = "src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk"


def script(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    path.chmod(0o755)


# Each fake logs one line "<name> <args>" to $CALLS.
LOG = 'printf "%s %s\\n" "${0##*/}" "$*" >> "$CALLS"\n'
FAKES = {
    # The sealed broker: FAKE_SEAL=approve writes an APK "signed" by $FAKE_SIGNER; anything else is a declined card.
    "sealed": LOG + '''
while [[ $# -gt 0 ]]; do case $1 in --out) out=$2; shift ;; --apk) apk=$2; shift ;; esac; shift; done
[[ $FAKE_SEAL == approve ]] || { echo 'declined' >&2; exit 4; }
{ cat "$apk"; echo "signed-by:$FAKE_SIGNER"; } > "$out"
''',
    "gh": LOG + '''
case "$1 $2" in
  'release create') : ;;
  'release download') printf '{"version": "1.2.3"}\\n' ;;
  *) exit 2 ;;
esac
''',
    "curl": LOG + 'printf \'{"version": "1.2.3"}\\n\'\n',
    "pnpm": LOG,
    "cargo": LOG,
    # The Buzz checkout publish.sh pins; every other git call is real.
    "git": '[[ "$*" == "-C ../buzz rev-parse HEAD" ]] && { echo 5669fdc0000; exit 0; }\nexec /usr/bin/git "$@"\n',
}
SDK = {
    "35.0.0/aapt": "echo \"package: name='org.example' versionCode='1102003' versionName='1.2.3'\"\n",
    "36.1.0/apksigner": LOG + '''
apk=${!#}
grep -q '^signed-by:' "$apk" || { echo "DOES NOT VERIFY: no signature" >&2; exit 1; }
echo "Signer #1 certificate SHA-256 digest: $(sed -n 's/^signed-by://p' "$apk")"
''',
}
# The repo's own scripts that publish.sh calls, as fakes. publish.sh, watch-main.sh and release-check.sh are the real ones.
REPO_FAKES = {
    "scripts/next-version.py": "print('1.2.3 1102003')\n",
    "scripts/write-release-manifest.py": "import sys, pathlib\n"
    "for f in ('latest.json', 'android.json'): (pathlib.Path(sys.argv[1]) / f).write_text('{}')\n",
    "scripts/build-mac-hosted.sh": LOG + 'for f in Uni-mac-arm64.zip Uni.app.tar.gz Uni.app.tar.gz.sig; do echo x > "$3/$f"; done\n',
    "scripts/android-release-build.sh": LOG + f'''
[[ $UNI_ANDROID_UNSIGNED == 1 ]] || {{ echo 'publish must build unsigned' >&2; exit 9; }}
[[ ${{FAKE_ANDROID_FAILS:-0}} == 0 ]] || exit 1
cd "$(dirname "$0")/.." && mkdir -p "$(dirname {UNSIGNED})" && echo "apk $1 $2" > {UNSIGNED}
''',
}
for name in ("check-case-collisions.py", "test_case_collisions.py", "test_check_public.py", "check-public.py",
             "test_release_check.py", "test_release_sign.py"):
    REPO_FAKES[f"scripts/{name}"] = ""


class ReleaseSignTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        self.home = root / "home"
        shims = self.home / ".local/share/mise/shims"  # first on watch-main.sh's PATH
        for name, text in FAKES.items():
            script(shims / name, "#!/usr/bin/env bash\n" + text)
        for name, text in SDK.items():
            script(self.home / "Android/Sdk/build-tools" / name, "#!/usr/bin/env bash\n" + text)
        self.calls = root / "calls"
        self.asked = self.home / ".config/uni/updater/sign-asked"

        origin = root / "origin.git"
        self.repo = root / "repo"
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(origin)], check=True)
        for name in ("publish.sh", "watch-main.sh", "release-check.sh"):
            script(self.repo / "scripts" / name, (ROOT / "scripts" / name).read_text())
        for name, text in REPO_FAKES.items():
            script(self.repo / name, ("#!/usr/bin/env bash\n" + text) if name.endswith(".sh") else text)
        (self.repo / "src-tauri/gen/schemas").mkdir(parents=True)
        (self.repo / "src-tauri/gen/schemas/a.json").write_text("{}")
        (self.repo / ".gitignore").write_text("build/\n")
        self.git("init", "-q", "-b", "main")
        self.git("remote", "add", "origin", str(origin))
        self.commit("first")

        self.env = {
            "HOME": str(self.home), "PATH": f"{shims}:{os.environ['PATH']}", "TMPDIR": str(root / "tmp"),
            "CALLS": str(self.calls), "UNI_SEALED_CMD": str(shims / "sealed"), "FAKE_SEAL": "approve",
            "FAKE_SIGNER": PINNED, "UNI_RELEASE_NO_DEVICE_INSTALL": "1",
            "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com",
            "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.com",
        }

    def git(self, *args):
        env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com",
               "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.com"}
        result = subprocess.run(["git", "-C", str(self.repo), *args], capture_output=True, text=True, env=env)
        self.assertEqual(result.returncode, 0, f"git {args}: {result.stderr}")
        return result.stdout.strip()

    def commit(self, message):
        """A new commit on origin/main, as a merge to main would land it."""
        (self.repo / "change.txt").write_text(message)
        self.git("add", "-A")
        self.git("commit", "-q", "-m", message)
        self.git("push", "-q", "origin", "HEAD:main")
        self.git("checkout", "-q", "--detach")
        return self.git("rev-parse", "HEAD")

    def watch(self, **env):
        self.calls.unlink(missing_ok=True)
        result = subprocess.run(["bash", str(self.repo / "scripts/watch-main.sh")], env={**self.env, **env},
                                capture_output=True, text=True, timeout=60)
        calls = self.calls.read_text().splitlines() if self.calls.exists() else []
        return result, calls

    def named(self, calls, prefix):
        return [c for c in calls if c.startswith(prefix)]

    def test_approved_and_right_key_publishes_and_clears_the_ask(self):
        sha = self.git("rev-parse", "HEAD")
        result, calls = self.watch()
        self.assertEqual(result.returncode, 0, result.stderr)
        [sign] = self.named(calls, "sealed ")
        self.assertIn(f"release sign --apk {self.env['TMPDIR']}/uni-release-1.2.3/uni-unsigned.apk --version 1.2.3 "
                      f"--code 1102003 --commit {sha} --out {self.env['TMPDIR']}/uni-release-1.2.3/uni.apk", sign)
        self.assertTrue(sign.endswith(" --wait"), sign)
        [create] = self.named(calls, "gh release create")
        self.assertIn("/uni.apk ", create)
        # Both builds finished before the card was asked; the release came after it.
        self.assertLess(calls.index(self.named(calls, "build-mac-hosted.sh")[0]), calls.index(sign))
        self.assertLess(calls.index(self.named(calls, "android-release-build.sh")[0]), calls.index(sign))
        self.assertLess(calls.index(sign), calls.index(create))
        self.assertFalse(self.asked.exists())

    def test_declined_card_publishes_nothing_and_records_the_ask(self):
        sha = self.git("rev-parse", "HEAD")
        result, calls = self.watch(FAKE_SEAL="decline")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len(self.named(calls, "sealed ")), 1)
        self.assertEqual(self.named(calls, "gh release"), [])
        self.assertIn("Android signing not approved (sealed exit 4); nothing published", result.stderr)
        self.assertEqual(self.asked.read_text().split()[:2], [sha, "1.2.3"])
        self.assertFalse(Path(self.env["TMPDIR"], "uni-release-1.2.3/uni.apk").exists())

    def test_signed_by_another_key_is_refused_before_the_release(self):
        sha = self.git("rev-parse", "HEAD")
        result, calls = self.watch(FAKE_SIGNER="0" * 64)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("APK signed by the wrong key", result.stderr)
        self.assertEqual(self.named(calls, "gh release"), [])
        # Not asked again either: the broker answered, with the wrong key; a person has to look.
        self.assertEqual(self.asked.read_text().split()[0], sha)

    def test_watcher_skips_an_asked_commit_until_a_new_one_or_the_override(self):
        self.watch(FAKE_SEAL="decline")
        sha = self.git("rev-parse", "HEAD")

        result, calls = self.watch()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls, [])  # no build, no card
        self.assertIn(f"origin/main {sha}: signing 1.2.3 was asked at", result.stderr)
        self.assertIn("not asking again", result.stderr)

        result, calls = self.watch(UNI_RELEASE_ASK_AGAIN="1", FAKE_SEAL="decline")
        self.assertEqual(len(self.named(calls, "sealed ")), 1)
        self.assertEqual(self.named(calls, "gh release"), [])

        new = self.commit("second")
        result, calls = self.watch()
        self.assertEqual(result.returncode, 0, result.stderr)
        [sign] = self.named(calls, "sealed ")
        self.assertIn(f"--commit {new}", sign)
        self.assertEqual(len(self.named(calls, "gh release create")), 1)
        self.assertFalse(self.asked.exists())

    def test_a_build_failure_is_not_an_ask_and_the_next_tick_retries(self):
        result, calls = self.watch(FAKE_ANDROID_FAILS="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.named(calls, "sealed "), [])
        self.assertFalse(self.asked.exists())
        result, calls = self.watch()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.named(calls, "gh release create")), 1)


if __name__ == "__main__":
    unittest.main()

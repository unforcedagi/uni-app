"""T-335: the release waits for the owner's tap (an APK, or a screens bundle when only the screens changed). Runs the real watch-main.sh and publish.sh in a throwaway repo with a
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
    # The sealed broker, as its contract says: "asked: request …" on stdout once the card is posted; exit 0 with --out
    # written on approval, exit 1 otherwise. FAKE_SEAL: approve (signed by $FAKE_SIGNER), decline, down (no card),
    # empty (exit 0 but writes nothing: a broken broker).
    "sealed": LOG + '''
while [[ $# -gt 0 ]]; do case $1 in --out) out=$2; shift ;; --apk) apk=$2; shift ;; --archive) archive=$2; shift ;; esac; shift; done
[[ $FAKE_SEAL == down ]] && { echo 'broker unreachable' >&2; exit 1; }
echo 'asked: request r-1'
case $FAKE_SEAL in
  approve) if [[ -n ${archive:-} ]]; then echo "web.json for $(cat "$archive")" > "$out"; else { cat "$apk"; echo "signed-by:$FAKE_SIGNER"; } > "$out"; fi ;;
  empty) : > "$out" ;;
  *) echo 'refused: declined' >&2; exit 1 ;;
esac
''',
    "gh": LOG + '''
case "$1 $2" in
  'release create')
    # FAKE_GH_CREATE_FAILS=partly: the tag reaches origin, then an upload fails.
    [[ ${FAKE_GH_CREATE_FAILS:-0} == partly ]] && /usr/bin/git push -q origin "$7:refs/tags/$3"
    [[ ${FAKE_GH_CREATE_FAILS:-0} == 0 ]] || { echo 'HTTP 503' >&2; exit 1; } ;;
  'release download') printf '{"version": "1.2.3"}\\n' ;;
  *) exit 2 ;;
esac
''',
    "curl": LOG + 'printf \'{"version": "1.2.3"}\\n\'\n',
    "pnpm": LOG,
    # scripts/ota-verify.ts, the only node call publish.sh makes: FAKE_VERIFY=fail says the manifest doesn't check out.
    "node": LOG + '[[ ${FAKE_VERIFY:-ok} == ok ]] || { echo "ota-verify: the signature does not verify" >&2; exit 1; }\n',
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
    "scripts/write-release-manifest.py": "import os, sys, pathlib\n"
    "open(os.environ['CALLS'], 'a').write('write-release-manifest.py ' + ' '.join(sys.argv[1:]) + '\\n')\n"
    "for f in ('latest.json', 'android.json'): (pathlib.Path(sys.argv[1]) / f).write_text('{}')\n",
    "scripts/ota-bundle.sh": LOG + 'echo "bundle $1" > "$2/web-$1.tar.gz"; echo "1 $2/web-$1.tar.gz"\n',
    "src/ota.ts": "export const SHELL_API = 1;\n",
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
        self.last_apk = self.home / ".config/uni/updater/last-apk"
        self.last_bundle = self.home / ".config/uni/updater/last-bundle"

        origin = root / "origin.git"
        self.repo = root / "repo"
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(origin)], check=True)
        for name in ("publish.sh", "watch-main.sh", "release-check.sh", "release-kind.py"):
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

    def commit(self, message, path="change.txt"):
        """A new commit on origin/main, as a merge to main would land it."""
        self.git("checkout", "-q", "--detach", "origin/main") if self.git("branch", "-r") else None
        (self.repo / path).parent.mkdir(parents=True, exist_ok=True)
        (self.repo / path).write_text(message)
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
        self.assertIn("Android signing did not complete (sealed exit 1; a card was posted): refused: declined. "
                      "Nothing published", result.stderr)
        self.assertEqual(self.asked.read_text().split()[:2], [sha, "1.2.3"])
        self.assertFalse(Path(self.env["TMPDIR"], "uni-release-1.2.3/uni.apk").exists())

    def test_a_broker_that_posted_no_card_is_named_and_still_not_asked_again(self):
        sha = self.git("rev-parse", "HEAD")
        result, calls = self.watch(FAKE_SEAL="down")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("(sealed exit 1; no card was posted): broker unreachable. Nothing published", result.stderr)
        self.assertEqual(self.named(calls, "gh release"), [])
        self.assertEqual(self.asked.read_text().split()[0], sha)

    def test_sign_exit_0_without_a_signed_apk_is_refused(self):
        for mode in ("empty", "missing"):
            with self.subTest(mode=mode):
                self.asked.unlink(missing_ok=True)
                # "missing": exit 0 and no --out at all (the fake as `true`).
                env = {"FAKE_SEAL": "empty"} if mode == "empty" else {"UNI_SEALED_CMD": "true"}
                result, calls = self.watch(**env)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Android signing did not complete (sealed exit 0; ", result.stderr)
                self.assertEqual(self.named(calls, "gh release"), [])
                self.assertTrue(self.asked.exists())

    def test_approved_but_release_create_fails_is_not_asked_again(self):
        sha = self.git("rev-parse", "HEAD")
        result, calls = self.watch(FAKE_GH_CREATE_FAILS="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len(self.named(calls, "gh release create")), 1)
        self.assertIn("approved and the APK signed, but 1.2.3 was not published", result.stderr)
        self.assertIn("HTTP 503", result.stderr)
        self.assertIn("UNI_RELEASE_ASK_AGAIN=1", result.stderr)
        self.assertEqual(self.asked.read_text().split()[0], sha)

        result, calls = self.watch()  # GitHub is back: the next tick still neither builds nor asks
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls, [])

        result, calls = self.watch(UNI_RELEASE_ASK_AGAIN="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.named(calls, "sealed ")), 1)
        self.assertEqual(len(self.named(calls, "gh release create")), 1)
        self.assertFalse(self.asked.exists())

    def test_a_release_that_failed_after_its_tag_says_it_may_be_partly_published(self):
        result, calls = self.watch(FAKE_GH_CREATE_FAILS="partly")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("approved and the APK signed, but 1.2.3 may be partly published: check the release page",
                      result.stderr)

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


    # --- T-335 OTA: screens-only changes go out as a signed bundle ---

    def released_apk(self):
        """An APK release went out from origin/main as it is now: publish.sh records it for the bundles after it."""
        sha = self.git("rev-parse", "HEAD")
        result, _ = self.watch()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.last_apk.read_text().split(), ["1.2.3", sha, "1"])
        return sha

    def test_screens_only_changes_go_out_as_a_bundle_on_one_tap_and_no_apk(self):
        self.released_apk()
        sha = self.commit("new screens", "src/App.tsx")
        result, calls = self.watch()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("as new screens for phones on Uni 1.2.3 (shell API 1), no APK", result.stderr)
        self.assertEqual(self.named(calls, "android-release-build.sh"), [])
        [sign] = self.named(calls, "sealed ")
        stage = f"{self.env['TMPDIR']}/uni-release-1.2.3"
        self.assertIn(f"release bundle --archive {stage}/web-1.2.3.tar.gz --version 1.2.3 --api 1 --commit {sha} "
                      f"--out {stage}/web.json --purpose Screens 1.2.3 for phones on Uni 1.2.3", sign)
        [verify] = self.named(calls, "node ")
        self.assertIn(f"scripts/ota-verify.ts {stage}/web.json {stage}/web-1.2.3.tar.gz --version 1.2.3 --api 1", verify)
        [manifest] = self.named(calls, "write-release-manifest.py")
        self.assertTrue(manifest.endswith("--android-from 1.2.3"), manifest)
        [create] = self.named(calls, "gh release create")
        self.assertIn(f"{stage}/web.json", create)
        self.assertIn(f"{stage}/web-1.2.3.tar.gz", create)
        self.assertNotIn("uni.apk", create)
        self.assertLess(calls.index(sign), calls.index(verify))
        self.assertLess(calls.index(verify), calls.index(create))
        self.assertFalse(self.asked.exists())
        self.assertEqual(self.last_bundle.read_text().split()[1], "1.2.3")

    def test_one_bundle_a_day_then_the_commit_waits(self):
        self.released_apk()
        self.commit("new screens", "src/App.tsx")
        self.watch()
        self.commit("more screens", "src/App.tsx")
        result, calls = self.watch()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("waits for tomorrow (one bundle a day)", result.stderr)
        self.assertEqual(self.named(calls, "sealed "), [])
        self.assertEqual(self.named(calls, "gh release"), [])
        self.last_bundle.write_text("2000-01-01 1.2.2\n")  # the next day
        result, calls = self.watch()
        self.assertEqual(len(self.named(calls, "gh release create")), 1, result.stderr)

    def test_a_shell_change_still_ships_an_apk(self):
        self.released_apk()
        for path in ("src-tauri/src/lib.rs", "pnpm-lock.yaml", "src-tauri/gen/android/app/build.gradle.kts"):
            with self.subTest(path=path):
                self.commit(f"change {path}", path)
                result, calls = self.watch()
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(f"an APK, because {path} changed since 1.2.3", result.stderr)
                [sign] = self.named(calls, "sealed ")
                self.assertIn("release sign --apk", sign)
                self.assertIn("/uni.apk", self.named(calls, "gh release create")[0])

    def test_a_declined_bundle_card_publishes_nothing_and_records_the_ask(self):
        self.released_apk()
        sha = self.commit("new screens", "src/App.tsx")
        result, calls = self.watch(FAKE_SEAL="decline")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Screens signing did not complete (sealed exit 1; a card was posted): refused: declined. "
                      "Nothing published", result.stderr)
        self.assertEqual(self.named(calls, "gh release"), [])
        self.assertEqual(self.asked.read_text().split()[0], sha)
        self.assertFalse(self.last_bundle.exists())

    def test_a_manifest_that_doesnt_check_out_against_the_built_in_key_is_not_published(self):
        self.released_apk()
        self.commit("new screens", "src/App.tsx")
        result, calls = self.watch(FAKE_VERIFY="fail")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("doesn't check out against the app's built-in key; nothing published", result.stderr)
        self.assertEqual(self.named(calls, "gh release"), [])

    def test_a_test_key_or_channel_in_the_environment_publishes_nothing(self):
        for var in ("UNI_OTA_PUBKEY", "UNI_OTA_CHANNEL"):
            result, calls = self.watch(**{var: "x"})
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("are for test builds", result.stderr)
            self.assertEqual(self.named(calls, "sealed "), [])


class ReleaseKindTests(unittest.TestCase):
    """scripts/release-kind.py on a real repo: anything not plainly the screens is an APK."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.repo = Path(tmp.name) / "repo"
        (self.repo / "scripts").mkdir(parents=True)
        shutil.copy(ROOT / "scripts/release-kind.py", self.repo / "scripts")
        self.git("init", "-q", "-b", "main")
        self.write("src/ota.ts", "export const SHELL_API = 3;\n")
        self.write("package.json", '{"scripts": {"test": "a"}, "dependencies": {"x": "1"}}')
        self.base = self.commit()
        self.last = Path(tmp.name) / "last-apk"
        self.last.write_text(f"0.3.7 {self.base} 3\n")

    def git(self, *args):
        env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com",
               "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.com"}
        return subprocess.run(["git", "-C", str(self.repo), *args], capture_output=True, text=True, env=env,
                              check=True).stdout.strip()

    def write(self, path, text):
        (self.repo / path).parent.mkdir(parents=True, exist_ok=True)
        (self.repo / path).write_text(text)

    def commit(self):
        self.git("add", "-A")
        self.git("commit", "-q", "-m", "c", "--allow-empty")
        return self.git("rev-parse", "HEAD")

    def kind(self, **env):
        return subprocess.run(["python3", str(self.repo / "scripts/release-kind.py"), str(self.last)], cwd=self.repo,
                              capture_output=True, text=True, check=True, env={**os.environ, **env}).stdout.strip()

    def test_the_screens_and_the_test_list_are_a_bundle(self):
        self.write("src/App.tsx", "x")
        self.write("docs/a.md", "x")
        self.write("package.json", '{"scripts": {"test": "a && b"}, "dependencies": {"x": "1"}}')
        self.commit()
        self.assertEqual(self.kind(), "bundle 0.3.7 3")
        self.assertEqual(self.kind(UNI_RELEASE_KIND="apk"), "apk UNI_RELEASE_KIND=apk")

    def test_anything_else_is_an_apk(self):
        cases = [("src-tauri/src/lib.rs", "x", "apk src-tauri/src/lib.rs changed since 0.3.7"),
                 ("crates/uni-core/src/a.rs", "x", "apk crates/uni-core/src/a.rs changed"),
                 ("pnpm-lock.yaml", "x", "apk pnpm-lock.yaml changed"),
                 ("scripts/android-release-build.sh", "x", "apk scripts/android-release-build.sh changed"),
                 ("package.json", '{"scripts": {"test": "a"}, "dependencies": {"x": "2"}}', "apk package.json's dependencies"),
                 ("src/ota.ts", "export const SHELL_API = 4;\n", "apk the shell API changed (3 -> 4)")]
        for path, text, why in cases:
            with self.subTest(path=path):
                self.git("checkout", "-q", "--detach", self.base)
                self.write(path, text)
                self.commit()
                self.assertTrue(self.kind().startswith(why), self.kind())

    def test_no_record_or_a_bad_one_is_an_apk(self):
        self.write("src/App.tsx", "x")
        self.commit()
        for text, why in [(None, "no last APK release recorded"), ("garbage", "no last APK release recorded"),
                          (f"0.3.7 {'f' * 40} 3", "is not behind this one"), ("0.3.7 abc 3", "malformed")]:
            with self.subTest(text=text):
                self.last.unlink(missing_ok=True)
                if text:
                    self.last.write_text(text)
                self.assertTrue(self.kind().startswith("apk") and why in self.kind(), self.kind())


if __name__ == "__main__":
    unittest.main()

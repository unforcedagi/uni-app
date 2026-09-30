"""Fail-closed hosted release tests; no GitHub calls or signing keys are used."""
import base64
import io
import json
import os
from pathlib import Path
import plistlib
import subprocess
import tarfile
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parent.parent
SHA = "a" * 40


class HostedBuildTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        keys = root / ".config/uni/updater"
        keys.mkdir(parents=True)
        for name in ("macsign.p12", "macsign.pass", "uni.key"):
            (keys / name).write_text("dummy")
        bindir = root / "bin"
        bindir.mkdir()
        gh = bindir / "gh"
        gh.write_text('''#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$GH_LOG"
case "$1 $2" in
  'api repos/'*) echo main ;;
  'secret list')
    if [[ ${FAIL_LIST:-0} == 1 ]]; then exit 1; fi
    if [[ ${LIST_LEFTOVERS:-0} == 1 && -e $GH_MARKER ]]; then echo MACSIGN_P12_BASE64; fi ;;
  'secret set') touch "$GH_MARKER" ;;
  'secret delete') if [[ ${FAIL_DELETE:-0} == 1 ]]; then exit 1; fi; rm -f "$GH_MARKER" ;;
  'workflow run') : ;;
  'run list')
    if [[ ${MATCH_RUN:-0} == 1 ]]; then
      dispatch=$(grep 'workflow run' "$GH_LOG")
      [[ $dispatch =~ release_nonce=([a-f0-9-]+) ]]
      printf '[{"databaseId":42,"headSha":"%s","displayTitle":"Uni 1.2.3 (%s)"}]\\n' "$TEST_SHA" "${BASH_REMATCH[1]}"
    else printf '%s\\n' "${RUN_LIST:-}"; fi ;;
  'run watch') : ;;
  'run download')
    while [[ $# -gt 0 ]]; do
      if [[ $1 == -D ]]; then mkdir -p "$2"; for file in Uni-mac-arm64.zip Uni.app.tar.gz Uni.app.tar.gz.sig; do printf x > "$2/$file"; done; break; fi
      shift
    done ;;
  *) exit 2 ;;
esac
''')
        gh.chmod(0o755)
        sleeper = bindir / "sleep"
        sleeper.write_text('#!/usr/bin/env bash\nexit 0\n')
        sleeper.chmod(0o755)
        python = bindir / "python3"
        python.write_text('''#!/usr/bin/env bash
if [[ ${FAKE_VERIFIER:-0} == 1 && $1 == scripts/verify-mac-assets.py ]]; then exit 0; fi
exec /usr/bin/python3 "$@"
''')
        python.chmod(0o755)
        self.log = root / "calls"
        self.env = dict(os.environ, HOME=str(root), PATH=f"{bindir}:{os.environ['PATH']}",
                        GH_LOG=str(self.log), GH_MARKER=str(root / "created"), TEST_SHA=SHA)
        self.out = root / "out"

    def invoke(self, **env):
        return subprocess.run(["bash", str(ROOT / "scripts/build-mac-hosted.sh"), SHA, "1.2.3", str(self.out)],
                              env={**self.env, **env}, capture_output=True, text=True, timeout=30)

    def calls(self):
        return self.log.read_text() if self.log.exists() else ""

    def test_preflight_api_failure_does_not_set_or_delete_secrets(self):
        result = self.invoke(FAIL_LIST="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("secret set", self.calls())
        self.assertNotIn("secret delete", self.calls())

    def test_cleanup_failure_overrides_successful_work(self):
        result = self.invoke(MATCH_RUN="1", FAKE_VERIFIER="1", LIST_LEFTOVERS="1", FAIL_DELETE="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Verified Mac build assets", result.stderr)
        self.assertIn("cleanup unverified", result.stderr)
        self.assertIn("secret delete", self.calls())
        self.assertIn("secret list", self.calls())

    def test_successful_cleanup_allows_completion(self):
        result = self.invoke(MATCH_RUN="1", FAKE_VERIFIER="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("run watch 42", self.calls())
        self.assertIn("secret delete", self.calls())

    def test_same_sha_other_nonce_is_not_selected(self):
        result = self.invoke(RUN_LIST='[{"databaseId":42,"headSha":"' + SHA + '","displayTitle":"Uni 1.2.3 (other)"}]')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("run watch 42", self.calls())
    def test_selector_requires_exact_nonce_and_sha(self):
        data = [{"databaseId": 10, "headSha": SHA, "displayTitle": "Uni 1.2.3 (wrong)"},
                {"databaseId": 11, "headSha": "b" * 40, "displayTitle": "Uni 1.2.3 (target)"},
                {"databaseId": 12, "headSha": SHA, "displayTitle": "Uni 1.2.3 (target)"}]
        cmd = ["python3", str(ROOT / "scripts/select-mac-run.py"), SHA, "1.2.3", "target"]
        found = subprocess.run(cmd, input=json.dumps(data), text=True, capture_output=True, check=True)
        self.assertEqual(found.stdout.strip(), "12")
        duplicate = subprocess.run(cmd, input=json.dumps(data + [data[-1]]), text=True, capture_output=True)
        self.assertNotEqual(duplicate.returncode, 0)

    def test_verifier_rejects_wrong_version_and_bad_signature(self):
        root = Path(self.tmp.name)
        pub, secret = root / "pub", root / "secret"
        subprocess.run(["minisign", "-G", "-W", "-p", str(pub), "-s", str(secret)],
                       capture_output=True, check=True)
        config = root / "config.json"
        config.write_text(json.dumps({"plugins": {"updater": {"pubkey": base64.b64encode(pub.read_bytes()).decode()}}}))
        archive = root / "Uni.app.tar.gz"
        zpath = root / "Uni-mac-arm64.zip"
        plist = plistlib.dumps({"CFBundleShortVersionString": "1.2.3", "CFBundleIdentifier": "org.unforced.uni"})
        name = "Uni.app/Contents/Info.plist"
        with tarfile.open(archive, "w:gz") as tar:
            entry = tarfile.TarInfo(name)
            entry.size = len(plist)
            tar.addfile(entry, io.BytesIO(plist))
        with zipfile.ZipFile(zpath, "w") as z:
            z.writestr(name, plist)
        sig = root / "Uni.app.tar.gz.sig"
        subprocess.run(["minisign", "-Sm", str(archive), "-s", str(secret), "-x", str(sig)],
                       capture_output=True, check=True)
        sig.write_bytes(base64.b64encode(sig.read_bytes()))
        cmd = ["python3", str(ROOT / "scripts/verify-mac-assets.py"), str(root), "1.2.3", str(config)]
        self.assertEqual(subprocess.run(cmd, capture_output=True).returncode, 0)
        self.assertNotEqual(subprocess.run([*cmd[:3], "9.9.9", str(config)], capture_output=True).returncode, 0)
        with zipfile.ZipFile(zpath, "w") as z:
            z.writestr(name, plist.replace(b"1.2.3", b"1.2.4"))
        self.assertNotEqual(subprocess.run(cmd, capture_output=True).returncode, 0)
        with zipfile.ZipFile(zpath, "w") as z:
            z.writestr(name, plist)
        archive.write_bytes(archive.read_bytes() + b"tampered")
        self.assertNotEqual(subprocess.run(cmd, capture_output=True).returncode, 0)


if __name__ == "__main__":
    unittest.main()

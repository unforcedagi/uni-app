"""T-207: publish.sh's post-publish checks retry with backoff. A stub gh and sleep; no GitHub calls."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent

GH = """#!/usr/bin/env bash
# Fails until it has been called $GH_FAILS times, then answers as GitHub would.
n=$(($(cat "$GH_COUNT" 2>/dev/null || echo 0) + 1)); echo "$n" > "$GH_COUNT"
printf '%s\\n' "$*" >> "$GH_LOG"
((n > GH_FAILS)) || { echo 'HTTP 404: Not Found' >&2; exit 1; }
case "$1 $2" in
  'release download') printf '{"version": "%s"}\\n' "$GH_VERSION" ;;
  'api repos/example/app/releases/latest') echo "$GH_LATEST" ;;
  *) exit 2 ;;
esac
"""


class ReleaseCheckTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)
        bindir = self.dir / "bin"
        bindir.mkdir()
        (bindir / "gh").write_text(GH)
        (bindir / "sleep").write_text('#!/usr/bin/env bash\necho "$1" >> "$SLEEP_LOG"\n')
        for f in bindir.iterdir():
            f.chmod(0o755)
        self.env = {**os.environ, "PATH": f"{bindir}:{os.environ['PATH']}", "GH_COUNT": str(self.dir / "count"),
                    "GH_LOG": str(self.dir / "gh.log"), "SLEEP_LOG": str(self.dir / "sleep.log"),
                    "GH_VERSION": "1.2.3", "GH_LATEST": "uni-v1.2.3"}

    def run_check(self, command, fails):
        script = f"source {ROOT / 'scripts/release-check.sh'}; {command}"
        result = subprocess.run(["bash", "-c", script], env={**self.env, "GH_FAILS": str(fails)},
                                capture_output=True, text=True)
        calls = (self.dir / "gh.log").read_text().splitlines()
        sleeps = (self.dir / "sleep.log").read_text().split() if (self.dir / "sleep.log").exists() else []
        return result, calls, sleeps

    def test_release_read_by_tag_succeeds_on_the_third_try(self):
        result, calls, sleeps = self.run_check("retry 6 5 release_serves example/app uni-v1.2.3 1.2.3", fails=2)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(calls), 3)
        self.assertTrue(all(c.startswith("release download uni-v1.2.3 --repo example/app") for c in calls), calls)
        self.assertEqual(sleeps, ["5", "10"])
        self.assertIn("release_serves failed (try 2 of 6); again in 10s", result.stderr)

    def test_latest_pointer_succeeds_on_the_third_try(self):
        result, calls, sleeps = self.run_check("retry 6 5 release_is_latest example/app uni-v1.2.3", fails=2)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls, ["api repos/example/app/releases/latest --jq .tag_name"] * 3)
        self.assertEqual(sleeps, ["5", "10"])

    def test_gives_up_after_its_tries_without_a_last_wait(self):
        result, calls, sleeps = self.run_check("retry 3 5 release_serves example/app uni-v1.2.3 1.2.3", fails=10)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(len(calls), 3)
        self.assertEqual(sleeps, ["5", "10"])

    def test_a_stale_answer_is_not_success(self):
        self.env.update(GH_VERSION="1.2.2", GH_LATEST="uni-v1.2.2")
        for command in ("release_serves example/app uni-v1.2.3 1.2.3", "release_is_latest example/app uni-v1.2.3"):
            with self.subTest(command=command):
                (self.dir / "gh.log").unlink(missing_ok=True)
                result, calls, sleeps = self.run_check(f"retry 2 5 {command}", fails=0)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(len(calls), 2)


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
import importlib.util
from pathlib import Path
import unittest

script = Path(__file__).with_name("check-public.py")
spec = importlib.util.spec_from_file_location("check_public", script)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def text_hits(line):
    return [name for name, rule, allowed in module.TEXT_RULES for m in rule.finditer(line) if not allowed(m)]


def path_hits(path):
    return [name for name, rule in module.PATH_RULES if rule.search(path)]


class TokensTest(unittest.TestCase):
    def test_words_camel_case_and_compounds(self):
        t = module.tokens("Forward Zorblat the asks; see zorblatRow and https://zorblat-site.example.org/x")
        for want in ("zorblat", "row", "zorblat-site.example.org", "zorblatrow"):
            self.assertIn(want, t)

    def test_a_compound_inside_a_longer_one(self):
        t = module.tokens("see https://www.zorblat-site.example.org/x and zorblat-co-2")
        self.assertIn("zorblat-site.example.org", t)
        self.assertIn("example.org", t)
        self.assertIn("zorblat-co", t)

    def test_url_encoded_words_split(self):
        self.assertIn("zorblat", module.tokens("Projects%2FZorblat%2FPlan"))

    def test_voice_ids_are_dropped(self):
        self.assertNotIn("zorblat", module.tokens("voice='am_zorblat'"))
        self.assertIn("zorblat", module.tokens("Am Zorblat"))
        self.assertIn("zorblat", module.tokens("of_zorblat if_zorblat"))

    def test_digest_is_salted(self):
        self.assertNotEqual(module.digest("a", "zorblat"), module.digest("b", "zorblat"))
        self.assertEqual(len(module.digest("a", "zorblat")), 64)


class TextRulesTest(unittest.TestCase):
    def test_tailnet_hosts_refused_example_allowed(self):
        self.assertEqual(text_hits("https://box.tailabc123.ts.net:8443/x"), ["tailnet host"])  # public-ok: a made-up host
        self.assertEqual(text_hits("https://uni-1.example.ts.net"), [])
        self.assertEqual(text_hits("tailnet certificates (`*.ts.net`)"), [])

    def test_cgnat_addresses(self):
        self.assertEqual(text_hits("ssh me@100.64.1.2 true"), ["100.x address"])  # public-ok: a made-up address
        self.assertEqual(text_hits("ssh to 100.64.1.2."), ["100.x address"])  # public-ok: a made-up address
        self.assertEqual(text_hits("version 1100.2.3.4 and 100.5 and 100.1.2.3.4"), [])

    def test_unforced_addresses(self):
        self.assertEqual(text_hits("write to someone@unforced.dev"), ["@unforced address"])  # public-ok: a made-up address
        self.assertEqual(text_hits("write to someone@example.org"), [])


class PathRulesTest(unittest.TestCase):
    def test_outputs_and_run_notes_refused(self):
        for path in ("scripts/browser/__shots__/simple/a.png", "walkthrough/01-x.png", "walkthrough/t1/clip.webm",
                     "REPORT-T1.md", "BRIEF-T2.md", "NEXT-T3.md", "RESULT.md", "WALKTHROUGH-T4.md"):
            self.assertTrue(path_hits(path), path)

    def test_code_and_docs_allowed(self):
        for path in ("walkthrough/harness/run.sh", "docs/release.md", "README.md", "src-tauri/icons/icon.png", "CLAUDE.md"):
            self.assertEqual(path_hits(path), [], path)


if __name__ == "__main__":
    unittest.main()

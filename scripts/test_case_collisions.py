#!/usr/bin/env python3
import importlib.util
from pathlib import Path
import unittest

script = Path(__file__).with_name("check-case-collisions.py")
spec = importlib.util.spec_from_file_location("case_check", script)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class CaseCollisionsTest(unittest.TestCase):
    def test_case_only_collision(self):
        self.assertEqual(module.collisions(["src/Foo.ts", "src/foo.ts"]), [("src/Foo.ts", "src/foo.ts")])

    def test_module_stems_differing_in_case_collide(self):
        # imports leave the extension off, so on macOS "./Search" can resolve to search.ts (uni-v0.1.62's Mac build)
        self.assertEqual(module.collisions(["src/Search.tsx", "src/search.ts"]), [("src/Search.tsx", "src/search.ts")])

    def test_same_stem_same_case_is_fine(self):
        self.assertEqual(module.collisions(["src/Foo.ts", "src/Foo.tsx"]), [])

    def test_other_extensions_stay_distinct(self):
        self.assertEqual(module.collisions(["src/App.tsx", "src/app.css", "docs/Notes.md", "docs/notes.txt"]), [])

    def test_unicode_casefold(self):
        self.assertEqual(len(module.collisions(["É.ts", "e\N{COMBINING ACUTE ACCENT}.TS"])), 1)

if __name__ == "__main__":
    unittest.main()

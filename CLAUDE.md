# uni-app: rules for agents

## This repo is public

Anyone can clone it, with its full history, and every push to `main` ships a release. So:

- **Nothing from the live app, the vault, Buzz or tasks goes in.** No real names, task text, area or project names,
  hosts, IPs, email addresses, or screenshots of real data. Why: a commit is published the moment it's pushed, and
  taking it back out means rewriting history.
- **Test fixtures and inline spec data are synthetic.** Use made-up names and `example.com` / `example.ts.net` hosts.
  Keep the shape a test depends on (length, step form, number of labels), not the words. Why: real task text in a spec
  is real task text in a public repo; `scripts/fixtures/sample-asks.json` is the pattern. Older specs and the areas
  fixture still use some public area and project names; add no more, and swap them for made-up ones when you touch them.
- **Run reports, briefs and walkthrough notes go to the vault or to `$TMPDIR`, never into the repo.** That covers
  `REPORT-*.md`, `BRIEF-*.md`, `NEXT-*.md`, `RESULT*.md` and `WALKTHROUGH*.md` (all git-ignored). Why: they quote
  live tasks word for word. The old ones are kept privately in `uni-ops/research/uni-app-reports/`.
- **Screenshots and videos are test outputs: ignored, never committed** (`__shots__/`, `walkthrough/` media). A visual
  baseline (`toHaveScreenshot`) may only use synthetic fixtures. Why: a screenshot of the real app shows real data, and
  no test reads the old ones.
- **The owner's private areas are never named.** The app recognises them by a hash (`src/areas/treeRooms.ts`); the
  fixtures' private area is "Sanctum".

## The guard: `scripts/check-public.py`

It checks what git would commit (the index) and refuses:
- tracked screenshots and run notes (the paths above);
- denylisted words: real names, private area names and client domains, stored only as salted SHA-256 hashes in
  `scripts/public-denylist.sha256`, so the list can't be read or searched for (the salt is public, so a guessed word can
  still be confirmed: the hashes keep the list out of sight, they don't make it secret);
- tailnet hosts (`*.ts.net` other than `example`), the tailnet id, `100.x` addresses and real `@unforced` addresses.

It runs as git hooks (`pre-commit` on the staged tree, `commit-msg` on the message), in CI
(`.github/workflows/public-check.yml`: the tree, then each new commit's tree and message) and in `publish.sh` before
the build. Its output names file, line and rule, never the matched text, because CI logs here are public.

```sh
git config core.hooksPath .githooks       # once per clone: installs both hooks
python3 scripts/check-public.py           # check the staged tree; --show prints what matched (local use only)
python3 scripts/test_check_public.py      # the guard's own tests
python3 scripts/check-public.py --rebuild # regenerate the hashes after editing ~/.config/uni/public-denylist.txt
```

The plaintext list lives only at `~/.config/uni/public-denylist.txt` (mode 600) on uni. Never commit it, and never put
a denylisted word in a commit message.

`public-ok` on a line exempts it from the host/address patterns only, never from denylisted words. Use it only for
shipped config that must hold the real value, and say why on the line. Today: the default hub and its alias
(`src-tauri/src/lib.rs`, `crates/uni-core/src/hub.rs`), the legacy APK host
(`scripts/devices.sh`), the transcription URL default (`services/transcribe/server.py`), and the guard's own tests.

## Gates before a commit is ready

The same ones `publish.sh` runs before it builds a release:

```sh
python3 scripts/check-case-collisions.py && python3 scripts/test_case_collisions.py
python3 scripts/test_check_public.py && python3 scripts/check-public.py
python3 scripts/test_release_check.py
pnpm typecheck
pnpm test
cargo test --workspace
```

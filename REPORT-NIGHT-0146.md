# REPORT: night of 10-14, round 24 finished, journal filing fixed, host rename survived (0.1.46)

Branch `feat/simple`, from `e671f58`. Nothing is pushed or released. The untracked `src/approvals.ts` and `scripts/approvals.test.ts` (dated Oct 12) are not mine and were left alone.

| Commit | What |
|---|---|
| `5963a7c` | Part A: run rows cut at a whole line with no "…"; strict 1280×720 Running spec; short-window spec race fixed |
| `e2c84fb` | Part A: `REPORT-SIMPLE-R24.md` |
| `8ee3d32` | Part B: journal entries filed at the source, tag `journal`, no double entry, "Waiting to send" |
| `7b6846d` | Part C: T-137 step 1, one host setting, `uni-1`/`uni` aliases with a remembered fallback |
| (this) | `REPORT-T137.md`, `REPORT-NIGHT-0146.md` |

## Part A: round 24 (details in `REPORT-SIMPLE-R24.md`)
**What changed.**
- I reviewed the five r24 commits against the brief. Every required item is implemented and specced:
  - the moved-on cue, with "Check in" as the primary;
  - the summary note;
  - the "message (in the card)" row;
  - the unresolved named block;
  - the Running list at 1280×720;
  - the Status/Due lines in short windows.
- **Fixed the WIP run-row clamp.** It used `-webkit-line-clamp`, which draws "…" and breaks r23's no-ellipsis rule. It now cuts at a whole line.
- **New spec** at 1280×720: the last run sits fully above the footer, unscrolled, and a long run is two whole lines.
- **Fixed a spec race.** The short-window specs opened the companion before the side panel had switched to the strip (1 in 18 at `e671f58`). They are now 32 of 32 on repeat.

**Checks.**
- `tsc` clean.
- `npm test` passes.
- `cargo test -p uni-core --offline` passes.
- Simple Playwright: 514 passed, 47 skipped, 0 failed.

**Real app** (from the first worker's 19:20–19:28 walks, a build at `4118e53`):
- The cue shows on 2 of 15 Needs-you sheets; it was on 12 of 16 in r23. Both lead with "Check in #Uni first".
- COhere's summary carries "No open request mentions this now · this summary is from Oct 13".
- The Ryan row reads "…(in the card)".
- The last Running row ends 66 px above the footer.
- **Cold launch:** 15.8 s from an empty app home, 471 ms warm. The run under load produced no number.

**Left.**
- No walk at the new HEAD, and no cold-launch timing tonight: the scratch hub is down (below).
- P2s Codex 3, 4, 6 and 7 are not done.

## Part B: journal entries are filed right, once
**Cause** (inferred from the bug report, not reproduced): the first entry sat in the device queue, the same words were typed again, and both flushed. Nothing stopped a second entry with the same words, and each got its own `entry_id` and `Notes/` path.

**What changed.**
1. **Filed at the source.**
   - `newDraft` builds `Journal/YYYY/MM-DD/HH-MM <first words>` in local time.
   - `firstWords` ports the sweep's `first_words` rule for rule: 7 words, 60 characters, the same stripping.
   - The draft also carries the sweep's clash fallbacks as `alternates`: `HH-MM-SS`, then 12, 20 and 40 words within 200 characters. Never `-1`.
   - A voice entry still transcribing keeps `Journal/YYYY/MM-DD/HH-MM`.
   - `create-note` tags `journal`, never `capture`.
   - `check_path` accepts `Journal/` paths with the sweep's banned characters refused.
   - Old queued `Notes/` entries still send, with their old `-N` fallback, and the sweep files them.
2. **No double entry.**
   - A text entry whose trimmed words match one still queued, or one sent in the last 10 minutes, is not queued again.
   - The save reports the existing entry: the Journal says "Waiting to send" or "Already saved", clears the box and marks that entry.
   - A **retry** first looks the entry up by `metadata.entry_id` (one `query-notes`, only when an earlier attempt failed), so a lost answer can't make a second note.
3. **Waiting is visible.** A queued entry reads "Waiting to send" with its time. After a flush the list reloads before the queue does, so a sent entry never blinks out.
4. **The list** reads `journal` and `capture` (`tag_match: any`), so stragglers still show until the sweep converts them.

**Specs.**
- `scripts/journalPaths.test.ts`: 14 invented samples. The expected values come from calling the sweep's own `first_words` and `target_path`. It covers the 7/12/20/40-word forms, text and voice paths, the clash order (seconds, then words, no `-N`), and the draft shape.
- 8 new `journal.rs` tests:
  - path validation;
  - a duplicate refused while waiting and for 10 minutes after;
  - voice never deduped;
  - alternates kept and checked;
  - an old `Notes/` entry flushes tagged `journal`;
  - a clash adds seconds;
  - every path taken stays queued with an error;
  - a retry finds its own write by `entry_id`.
- A browser spec covers "Waiting to send" with its time, the duplicate notice, the marked entry, and a draft filed under `Journal/` with its seconds alternate.

**Checks.**
- `tsc`, `npm test` and `cargo test` pass.
- Simple Playwright: 517 passed, 47 skipped, 0 failed.
- **Live vault, read only:** for the 5 most recent `journal` notes, the derived path equals the actual path **5 of 5**. Over the 100 most recent, titles match for every app-written entry. The time stamp matches for the 11 Uni-app entries since 10-02. Older entries were written by the earlier Parachute app, which stamped the path when the entry was started, not when it was saved, so their stamps differ. No content was printed.
- **The hub accepts both new query shapes** (read-only MCP `query-notes`, no content):
  - the list (`tag: [journal, capture]`, `tag_match: any`) returns `journal` entries;
  - the `entry_id` lookup finds exactly the right note, and nothing for an unknown id.

**Left.**
- **No write test.** It was meant for the scratch hub, which is down, and the live hub takes no writes. The create path is covered by the scripted-hub tests only.
- **The sweep has a bug in its clash fallback** (`~/scripts/t60_journal_sweep.py`, not changed). When the seconds still clash, its "more words" step uses `re.sub(r"(/(?:\d\d-\d\d(?:-\d\d)? )?).*$", …)`. That matches at the first `/`, so it produces `Journal/<words>` with no year, day or time (checked by running that expression). The app ports the intended rule: same folder and stamp, more words. The sweep's owner should fix the regex, for example by anchoring on the last `/`.

## Part C: T-137 step 1 (details in `REPORT-T137.md`)
**What changed.**
- The `uni-1` ↔ `uni` pair lives in one table, `uni_core::hub::HUB_ALIASES`.
- Hub requests retry once on the alias after a DNS or connection failure, never after an HTTP error. When the alias answers, the app writes it to `vault.json`.
- Transcription derives from the hub's host (port 8445), with the same fallback.
- `sameHub` treats both names as this hub, using `hub_origins` from `journal_config`.
- `DEFAULT_HUB` stays `uni-1`.

**Specs.**
- A real DNS failure (`.invalid`) falls back once and is remembered.
- A refused connection falls back.
- 401 and 500 never fall back; the alias is never contacted.
- When neither name answers, the error names the configured host.
- Transcription: the URL derives from the hub, the fallback works, and 401/500 never fall back.
- `sameHub` accepts both names and refuses `uni-2`.
- Suites: `tsc`, `npm test` and `cargo test` (110 + 1 + 22) pass. Simple Playwright: 516 passed, 47 skipped, and 1 flaky failure in r20 phone navigation, which passed 15 of 15 on repeat.

**Real check: not done.** It needs the scratch hub, which is down. The fallback is proven against real DNS in specs, and `REPORT-T137.md` gives the exact scratch run for the room.

**For step 2.** The transcription server pins `PUBLIC_URL` to the `uni-1` URL and would answer 401 to a device that has switched to `uni`. It must accept both names before the rename. The hub already validates against the request's Host, so it accepts both.

## The scratch hub
`t124-scratch-hub6` (127.0.0.1:19390) stopped answering at 19:27:53 on 10-14, when the first r24 worker was stopped. Its transient unit is gone. Per the rules I did not start or move a hub. This blocked three things tonight:
- the walks and cold-launch timing at HEAD;
- the Part B write test;
- the Part C real-app check.

## Processes
I started only Playwright runs, Vite preview servers on port 5791 (stopped with each run), and cargo builds. No Docker, hub or Tailscale action. I removed the leftover `~/.hermes/cache/scratch/t124-apphome-r24w` (r24 brief, step 4), along with my own temp files under `/tmp/claude-1000/`.

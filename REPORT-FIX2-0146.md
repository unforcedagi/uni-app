# 0.1.46 fix pass 2 (Codex re-review NO-SHIP: 2 P2s, 1 P3)

Branch `fix/0146`. Two commits, not pushed.

## P2 1: composer edits lost while a save is in flight (`src/Journal.tsx`)
- The composer keeps a revision counter (`live`: current text and a count bumped on every change). Each save, and each voice save, records the revision it submitted.
- When a save returns, `clearIf(rev, text)` clears the composer only if the revision is unchanged. Anything typed since stays, in the textarea and in local storage. The finished send's ids are always released, so retyping the same words later is a new send.
- A "same words" answer for words that have since changed is dropped (nothing was saved; no question is shown). Otherwise the question records the revision it was raised for, and "Keep one" discards only that draft.
- Voice: the typed words that went with the recording are cleared only if still unchanged. If the Journal screen closed while a save was out, its stored draft is removed only if it still equals what was sent.
- Spec (mac, mac-small, phone): save A, type B before the (gated) response, B stays in the composer and in `uni.journal.draft`; a late duplicate answer for A shows no question and keeps B; a question raised for B then "Keep one" clears B only. It fails against the old `Journal.tsx` (B read back as empty). The fixture gained a `__saveGate`.

## P2 2: old `Notes/` fallbacks (`crates/uni-core/src/journal.rs`)
- After the original path and `-2`…`-9`, an old `Notes/YYYY/MM-DD/HH-MM-SS` entry now continues on `Journal/YYYY/MM-DD/HH-MM-SS (2)`…`(9)`, then `(<entry id>)`, the same last resort Journal entries use. A `Notes/` path that doesn't read as a date and time falls back to the entry's creation time (UTC). No base means no extra paths, as before.
- Specs: `paths_to_try` order and length for an old entry; a flush where all nine old paths hold other entries and the entry saves on `Journal/… (2)`.

## P3: sweep
Not touched (`~/scripts` belongs to someone else). Follow-up for the room: the sweep's `UNTITLED` pattern should learn the `HH-MM-SS (2)` form (and `(<entry id>)`), so numbered voice fallbacks get transcript titles.

## Checks
- `tsc --noEmit`: clean.
- `npm test`: passes.
- `cargo test -p uni-core --offline`: 118 + 1 + 22 passed, 0 failed.
- Journal Playwright specs (`-g journal`, mac / mac-small / phone): 15 passed.
- Only the journal.rs formatting from `cargo fmt` was kept; other files `fmt` touched were reverted.

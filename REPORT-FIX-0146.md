# REPORT-FIX-0146: the four findings from the Codex NO-SHIP review of 0.1.46

Branch `fix/0146`, three commits on top of `cb74df4`. Nothing pushed or released.

- `3433b59`: the outbox in `crates/uni-core/src/journal.rs` and the Tauri command (P1, P2 core, P3)
- `23ced96`: the composer in `src/Journal.tsx` and `src/journalCore.ts`, plus specs (P2 UI)
- `675f2d3`: one origin check shared by the vault and transcription (P4). This commit also carries a `rustfmt` pass over `journal.rs` and `hub.rs`; both files were rustfmt-clean before this work.

## P1: a failed retry lookup never creates

What changed: `send_one` used to swallow a `find_entry` error with `.ok().flatten()`. It now propagates it with `?`. When the lookup fails, the entry records the error, keeps its attempt count, stays queued and is retried on the next flush. A create happens only after a lookup that succeeded and found no match.

Specs (Rust, `journal::tests`):
- `a_retry_whose_lookup_fails_never_creates_and_stays_queued`: the lookup gets a 500. The mock offers no create, so a create attempt would report "unreachable" instead of the 500. The spec checks the report says `hub error 500`, the entry is still queued with attempts at 2, and it has no note. I put the old `.ok().flatten()` back once to check: this spec fails against it.
- `a_retry_whose_lookup_finds_nothing_creates`: the lookup returns `notes: []`, then a create follows and the entry is sent.
- `a_retry_finds_its_own_earlier_write_by_entry_id` (extended): a lookup that finds the entry marks it sent (`journal_sent_note`) and never creates. The mock holds no `create-note`.

## P2: a repeated entry is not silently dropped

What changed:
- **Retries are keyed on the send, not the words.** `newDraft` makes a `submission_id` (a UUID) besides the `entry_id`. The composer creates one draft per send in `send.current` and reuses it while the text stays the same, so a save that threw and is tapped again carries the same ids.
- **Outbox side.** `journal_submit` treats a match on either id, in the outbox or the sent table, as `Queued::Retry`: nothing new is queued, and the user isn't asked anything. This includes an entry that has already been sent, which used to be queued again.
  - New columns: `journal_outbox.submission_id` and `journal_sent.{submission_id, created_at, source}`, added through `add_column`.
  - `journal_queue` remains as a wrapper (submission id = entry id) for existing callers and tests.
- **Same words from a different send** come back as `Queued::SameWords { kind: waiting|saved, id, created_at }`. Nothing is queued. `journal_save_text` puts it in `FlushReport.duplicate`. Only text entries are compared (`source = 'text'`), as before.
- **What the user sees.** The status reads "Same words as your 7:43 PM entry", in the locale's time format, with **Save another** and **Keep one** buttons below it.
  - The composer keeps the text until a choice is made.
  - Editing the text dismisses the question, because it is different text then.
  - **Save another** sends the same draft again with `saveAnother: true`.
  - **Keep one** clears the composer, saves nothing, and marks the existing entry.

Specs:
- Rust:
  - `same_words_are_held_back_until_the_user_chooses_while_waiting_and_for_ten_minutes_after`
  - `save_another_queues_the_same_words_as_a_second_entry`
  - `a_retry_of_the_same_send_queues_nothing_and_is_not_same_words`
- Unit (`scripts/journal.test.ts`): each draft gets a distinct `submission_id` that is not its `entry_id`; `sameWordsLine` text.
- Playwright (`simple.spec.ts`), mac, mac-small and phone:
  - `journal (0.1.46): … the same words again ask "Save another / Keep one" and keep the text; Keep one saves nothing; …` covers the Keep one path and the editing-dismisses case.
  - `journal (0.1.46 fix): same words as an entry already saved: "Save another" saves the same send a second time; a failed save retried keeps its ids` covers the Save another path and the retry ids.
  - The fixture gained `__saveFails`.

## P3: no entry stuck forever on a path clash

What changed: `paths_to_try` now appends `last_resort_paths` after the device's alternates.
- **Order:** the minute, then the seconds, then the longer titles, then `HH-MM-SS <title> (2)` through `(9)`, and finally `HH-MM-SS <title> (<entry id>)`, which no other entry can hold.
- **Base:** the first candidate with seconds in its stamp, so it uses the shortest title. A voice entry still waiting for its transcript gets `HH-MM` → `HH-MM-SS` → `HH-MM-SS (2)` and so on.
- **Already-queued entries are covered too.** The outbox builds these candidates, so entries queued by 0.1.46 builds without them also get unstuck.
- **The sweep leaves them alone.** I read the sweep's `CANON` regex (`Journal/\d{4}/\d\d-\d\d/(\d\d-\d\d(-\d\d)? )?.+`) and it matches every candidate. There is never a `-N` suffix, and `check_path` accepts every candidate.

Specs (Rust):
- `three_entries_at_the_same_second_all_save`: they land at the minute, the seconds and `(2)`.
- `a_voice_entry_still_transcribing_falls_back_to_time_only_then_numbered`
- `alternates_are_kept_and_checked` (updated)

Caveat, from reading the regex only (not run): the sweep's `UNTITLED` regex doesn't match `HH-MM-SS (2)`. A voice entry that lands there will not get titled by the sweep once its transcript arrives; it keeps the time-and-number name. This only happens after two other entries took the same second.

## P4: transcription validates its URL like the vault client

What changed:
- `hub::checked_origin` allows https, or http only for `localhost` and `127.0.0.1`. It is now the single rule: `VaultConfig::origin` delegates to it.
- `hub::transcribe_url` returns `None` for a hub that fails it.
- `voice_transcribe` in `src-tauri/src/lib.rs` checks `cfg.hub` before anything else.
- `transcribe_on_hub` checks the hub.
- `transcribe_or_alias` checks the primary endpoint and drops an alias that fails the check, so it is never tried.
- `post` checks the URL before signing or sending audio, which also covers direct `transcribe()` calls.

Specs:
- `hub::tests::an_http_remote_hub_is_refused_for_transcription`: http to tailnet, LAN or remote hosts is refused; http to localhost or 127.0.0.1 is allowed.
- `transcribe::tests::an_http_remote_hub_is_refused_for_transcription`:
  - The hub setting, a direct URL and an http alias are all refused.
  - A counting listener on `127.0.0.2` (loopback, but not an allowed http host) gets 0 connections.
  - The switch hook never fires.

Not changed: `hub_origins`, the list the UI uses to recognise links to the hub. Nothing is sent to it.

## Suites

- `tsc --noEmit`: pass.
- `npm test`: pass (exit 0).
- `cargo test -p uni-core --offline`: 117 + 1 + 22 pass. `src-tauri` `cargo check`: clean.
- Simple Playwright, first full run: 518 passed, 47 skipped, 2 failed. Both failures were `r20 › P2 (Codex 5) the narrow companion's sheet is a foreground surface: Back closes it first, and the place stays`, on mac and phone.
  - **Flaky:** it passed 30 of 30 with `--repeat-each=10` on its own.
  - REPORT-NIGHT-0146 and REPORT-T137 name the same spec as flaky. It doesn't touch the journal.
- Simple Playwright, second full run: 519 passed, 47 skipped, 1 failed. The failure was `r19 › in a short window the sheet's primary action and "I did this" stay in view: a sticky footer` on phone.
  - **Flaky, and the same on base.** The click in `unfoldAll` times out because the fold button keeps detaching from the DOM while the tree re-renders.
  - Repeat counts with `--repeat-each`:
    - This branch, 3 workers: 24 of 30 failed, then 30 of 30 failed.
    - Base `cb74df4` (src and scripts checked out temporarily), 3 workers: 8 of 30 failed, then 12 of 30 failed.
    - With 1 worker, 5 repeats each: this branch 4 of 15 failed, base 5 of 15 failed.
  - So the failure rate depends on load and is about the same on both. It isn't caused by this change: the journal isn't on that screen. It needs its own fix: the fold button keeps detaching while the tree re-renders on a 740×360 window.
- The new journal specs passed on all three projects in both full runs.

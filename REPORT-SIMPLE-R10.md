# REPORT: Simple first, round 10 (T-124 r10): Needs-you rows that read whole

On `feat/simple` from e9e6c8b: four commits, nothing pushed. Real-app walks (debug build with `--features custom-protocol`, scratch hub, same app data twice):
`~/Code/uni-sketches/t124/walk/runs/r10-worker-cold/` and `r10-worker/` (all 7 PNGs each viewed; no missed steps). The scratch app home was removed afterwards.
My first build lacked `custom-protocol` and the app showed "Could not connect to localhost"; I rebuilt and re-walked. A mid-round walk also showed the ATLAS row overflowing its clamp (fixed, see 2).

## Per item, what the real app showed
1. **Cut calendar-email question: fixed.** Cause (read from the scratch vault db, read only): the note's body is whole ("…a daily calendar email to people who registered and opted in, for those who don't install the app. It goes to real attendees."), so `askFromContent` was fine. The ask reads were capped at 12 **in list order**, and 23 live decisions/tasks have cut titles, so this one often never got read (the cap, not the cache or a cut first line; inferred from the data, I did not trace the live request). Now: reads go decisions first, then Now, then soonest due, up to 40, six at a time. `r10-worker/01,04`: "a daily calendar email to people who registered and opted in, for those who…" with Your call Yes/No. Note that this line ends "…" because of the 3-line clamp (see 2), with More under it. If no full question exists: "Open to decide ›" with the fragment as a quiet line and no buttons (Playwright and unit tests; in the real app it showed for ~1 s on a cold start in an earlier walk before the ask arrived, then the question).
2. **Whole rows.** Each row is at most 3 text lines (ask, due line, next step; title 2 lines when there is more, next gets what remains), action first, then one More/Less per row that expands it. The Benya row (`r10-worker/01`): 3 lines, More, Your call Yes/No. Rows that don't fit above the footer wait behind "+3 more ›" (COhere), no row is faded at the panel bottom (footer is opaque now). **Caveat:** a long ask (calendar email, Benya) still ends on a CSS "…" at line 3, with More beside it and Yes/No below. That is a clamp, not cut data, but a strict reader will see "…" before buttons; the fix would be a wider panel or letting asks with buttons run to 4 lines.
3. **One state label.** The row no longer says "Waiting on you" (the Needs-you heading says it); the opened item says one line, "Status  Waiting on you" (`r10-worker/05`), no "waiting, waiting on aaron".
4. **Stable note titles.** Titles are kept on this device and read ahead when the list loads; while unread a note id shows a muted "the linked note" instead of "a note". Cold (`r10-worker-cold/01`, ATLAS row): no flip seen in the walk; the link sits behind More. "a note" now only appears when a note can't be read. I did not trace why the r9 first render missed the title; most likely it was just the first read of that id with no stored title.
5. **Recent.** Never the room you're in, never twice (by name), at most five, in a fixed 124 px block so the sidebar doesn't move: `r10-worker/01` (empty list, same height), `03` (COhere), `07` (Learn Vibe Build, Uni). In the app "Uni" appeared once in each dump.
6. **Sidebar last row.** Bottom fade removed, padding reduced so the last row clears Recent. Real app: with areas open (`r10-worker/04`) "Expression" is whole above Recent; scrolled to the very end, only Playwright checked it (`last row whole and above Recent`), not the real app.
7. **Overdue.** The ATLAS task (T-129) has **no `due` field** in the data ("Oct 12" is only in its title), so no "was due" line can show; I did not infer dates from titles. The "was due" line works where `due` is set (Tell Christian…: "due Oct 20" shows legibly; overdue is darker, Playwright covers "was due Oct 7"). Fix is data: set `due: 2026-10-12` on T-129.

**Not app work:** Riverside (November) is `priority: now` in the data and so still in Needs you; left alone.

## Tests
- `tsc --noEmit` clean. `npm test` passes (new unit tests: row ask/hint, one state line, ask order, line budget).
- `cargo test -p uni-core --offline`: 86 + 1 + 22 pass.
- Playwright `simple`: 148 passed, 0 failed, 29 skipped (phone-only skips of side-panel specs). New specs: no Yes/No beside a cut ask, 3-line rows within the panel with "+N more ›", row More/Less, single state label, Recent excludes the current room and dedupes with fixed height, sidebar last row at scroll end. Four older specs were adjusted to the new rules (Your call label, "+N more" allowed, long-next now clamps within the row).
- Not re-run: the other Playwright configs (treehome, roomsnav, nested, chatoptional, sidebar, rail, legacy). `vault-links` and the phone-landscape `screens` spec are known failing and untouched.

## Watch
- Companion still has no cache ("Loading…" on a cold start).
- The note-title store is localStorage on the device (ids to titles only, no content).

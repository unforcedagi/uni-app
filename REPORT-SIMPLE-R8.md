# REPORT: Simple first, round 8 (T-124 r8): r7's real-app regressions

On `feat/simple` from c19fbcb, two commits, nothing pushed. Each blocker was reproduced and checked in the REAL Linux app
(debug build, walk on a scratch hub): `~/Code/uni-sketches/t124/walk/runs/r8-worker/` (the standard walk), `r8-early/` and `r8-diag*/`
(my own copies of the driver in `~/.hermes/cache/scratch/r8/`, with a 2.5s boot and DOM probes; the walk scripts are untouched).

## Root causes and walk result, per blocker

1. **COhere (and any room) blank chat.** Two causes. (a) `get_messages` results were thrown away whenever a sync tick re-ran the load effect
   (ticks arrive faster than a 300-message room loads), so the room could stay blank for as long as the sync ran; the quiet placeholder was
   an empty `<p>`, so it looked like "no messages". Now a result for the view still on screen is kept (newest request wins, a sequence guard
   stops an older one overwriting a newer one), and the placeholder says "Loading messages…". (b) a place opened before the rooms list had
   arrived fell back to the dashboard (see 2). **Real app:** `r8-worker/04-cohere.png` and `07-back.png` show the conversation; the probes in
   `r8-early` show COhere with 300 messages on tree click and on Back, Learn Vibe Build with 35. Tree click and Back were walked in the real
   app; Recent and Forward are covered by Playwright only (new spec), not walked.
2. **Uni opened as a dashboard ("no room", zeros).** `treeLevel` chose the room view only when the room was already known, so a place opened
   before `get_rooms` returned (a fresh start) became the full page and never changed back. A room place now waits for the list
   (`roomsPending`: no rooms yet and no sync finished) and shows "Opening the room…" in the chat area, then the conversation. **Real app:**
   `r8-worker/02-uni-room.png`: Uni's conversation with the companion (needs-you items, no "no room"). With a 2.5s boot (`r8-early`) it shows
   "Opening the room…" until the rooms arrive, never the dashboard; in that run the rooms had not arrived within the 6s probe, so I did not see
   the final state of that particular run, only that the later places (COhere, Learn Vibe Build) were fine.
3. **Cut decision titles.** The list queries carry no content. For a decision, or a task of Aaron's, whose title ends in "…", the full
   question is read from the first line of the note (`vault_note`, at most 12, after the list is already on screen, cached by id so a refresh
   shows it at once); `askFromContent` drops `_Converted from …_` lines, the "Decision (…):" label and markdown, and keeps whole sentences
   up to 280 chars. **Real app:** the three decisions read in full ("Uni adds Benya's missing feature #4, the after-event "were you there?
   one takeaway" prompt, to the companion on Wed. Say no to skip it.", the calendar email, the texting one); the Riverside task shows its
   full line. One task title in the live data ("Magnifica reading edition: permission and editorial…") still shows its "…": its note gave no
   better line or it fell outside the 12 cap; I did not look into it.
4. **Needs-you list under the footer.** The footer's fade is longer (34px gradient) and the list has bottom padding. **Real app:**
   `r8-scroll/02-uni-room.png`, scrolled to the bottom: the last item ends above the footer; the panel scrolls (scrollbar on its edge).
   There is no separate scroll indicator beyond the fade and the scrollbar.
5. **Fold chevron.** Bigger (7px, 2px ink stroke, 20px target); `aria-label="Fold X"/"Unfold X"` kept. Folded by default as before.
6. **Recent.** Never lists the current place, and a name is listed once (Uni opened as a room before the tree loaded and as the node counted as
   two places). Real app: shows `Uni` once, then `Learn Vibe Build` / `Uni` as expected.
7. **Uni is the root.** Areas are indented one step under Uni (Uni 10px, areas 14, projects 28, deeper 42/56), width unchanged (220).
8. **Uni needs-you filter.** Uni now opens as a room, so it uses the same `topNeeds` filter as every room (no Someday). Real app: Uni's
   panel lists the Now/Soon items and decisions only; I did not count them against the live vault.
9. **No false zeros.** The room view shows "Loading…" in the companion until the first task fetch resolves (already so); the dashboard that
   showed zeros is no longer what a room place opens as.
10. **Running** lists only runs still going (not `done` or `failed`) in both the companion and the page's Running section; the section is
    absent when none.

Also: "Opening the room…" now has padding and is centered (it was flush against the sidebar).

## Tests
- `tsc --noEmit` clean. `npm test` passes (new unit tests for `askFromContent`/`isCutTitle`, Recent dedupe, `isActiveRun`).
  `cargo test -p uni-core --offline`: 86 + 1 + 22 pass.
- Playwright `simple`: all pass (desktop, mac-small, phone), with 3 new specs: a room opened by Back, Forward and Recent shows its messages;
  Uni opens as its chat room with the rooms list arriving 1.5s late, and Recent has no duplicate or current place; a cut decision title shows
  the full question (fixture option `cutDecision`; `vault_note` in the fixture now also finds task and decision notes).
- With `treehome roomsnav nested chatoptional sidebar rail screens` (the pattern also matched `composer` and `vault-links`): 238 passed, 11
  failed, all in `vault-links` (5 specs, desktop and mobile) and one `composer` mobile spec. `vault-links:44` fails the same way on the commit
  before r8 (checked in a throwaway worktree, since removed), so those are not from this round; the `composer` spec passed on a re-run.
  Phone-landscape `screens` was not among the failures in this run.
- Legacy layouts (`playwright.areas.config.ts`): 329 passed, 9 skipped, 0 failed.

## Not done
- A very large room (COhere, 300 messages) can still take a few seconds to paint on a cold start; it now says "Loading messages…" instead of
  looking empty. I did not change the first-page size.
- Recent and Forward were not walked in the real app (Playwright only).

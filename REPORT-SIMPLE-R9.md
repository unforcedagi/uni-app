# REPORT: Simple first, round 9 (T-124 r9): instant Uni, self-explanatory Needs you

On `feat/simple` from f0046a4: two commits, nothing pushed. Real-app walks (debug build, scratch hub, my own copies of the scripts in
`~/.hermes/cache/scratch/r9/` with `WALK_KEEP_HOME`): `~/Code/uni-sketches/t124/walk/runs/r9-worker-first/` (fresh app data) and
`r9-worker/` (second run, same app data). Boot wait in my driver copy is 3 s after the page's IPC is up.

## Per item, what the real app showed
1. **Uni opens instantly.** Last 60 messages per room (newest by time, entry capped at 90k chars, 12 rooms kept, per identity) and the rooms
   list are kept in localStorage (`src/chatCache.ts`). At launch the cached rooms restore the place, the cached messages paint, the composer
   is live, then the fetch refreshes. `r9-worker/01-open.png` (second run): Uni's conversation, composer ready, the sidebar tree, no
   "Opening the room…" and no "Loading messages…". A DOM probe (`r9-probe`) put 60 messages on screen about 2 s after the page's IPC was up
   (the real 300 arrived at ~6 s). The first run on fresh data (`r9-worker-first`) still waits, as it must. Not cached: the companion's
   "Where this stands" still says "Loading…" at that moment. The earlier second run (`r9-second`) was at 2.5 s and still showed "Loading messages…";
   the probe and the 3 s run show it is about timing of the webview start, not a missing cache. I did not measure from "window appears" precisely.
2. **Needs-you says what to do.** `r9-worker/04-cohere.png`: option-less decisions show "Your call: yes or no" with Yes / No buttons (the write
   uses `decided: "yes"|"no"` through the existing CAS `vault_decide`; options are not written). Decisions with real options are unchanged.
   Tasks with no verb-led title or `next` keep "Open to see what's needed". I did not click Yes/No in the real app (would write to the scratch vault);
   covered by Playwright (`decided: yes`, from open to decided).
3. **No raw ids.** `uni:<ULID>`/bare ULIDs in a title or `next` render as the note's title (`vault_note`, cached), clickable in `next`, "a note" when unread.
   `r9-worker/03-collapsed.png`: "Send the ATLAS Oct 12 follow-up email" shows "a note" (the live id did not resolve to a title in that run; I did not check why).
   The raw `uni:01M4…` chip still shown in `01-open.png` is a chat message, not Needs-you; untouched.
4. **Overdue shown.** Overdue tasks sort first, oldest first, with "was due Oct 7"-style text. Proven in Playwright and unit tests only: no live task was
   overdue in the walk, so not seen in the real app.
5. **Less clipping.** `next` clamps at 6 lines before "More". Footer is always "All of <name>'s work →", wraps to two lines (`06-atlas-teach.png`:
   "All of Learn Vibe Build's / work →"). Panel scroll and fade kept (`03-collapsed.png`).
6. **Sidebar bottom.** Bottom padding 44px plus a 22px fade on the rows area, so the last row clears the edge and Recent. In `06` the list is
   scrolled to the top and "Unforced" fades at the edge as designed; I did not scroll to the very bottom in the real app, so full reachability of
   "Unforced Development" is not verified there.

## Tests
- `tsc --noEmit` clean. `npm test` all ok (new unit tests: overdue sort and wording, ULID splitting, chat cache incl. size cap and eviction).
- `cargo test -p uni-core --offline`: 86 + 1 + 22 pass.
- Playwright `simple`: 134 passed, 2 failed in the full run, both the old "footer link on one line" spec, now updated to "at most two lines" and
  passing alone. I did not re-run the whole suite afterwards. New specs: cached messages before fetch (rooms and messages delayed 8 s), Yes/No on an
  option-less decision, ULID as title, overdue first, footer label. Two older specs changed for the new footer rule.
- Fixture: pinned clock is Oct 9, so `pastDue` and `ulidNext` options were added to `areasFixture.ts`.
- Not re-run this round: treehome, roomsnav, nested, chatoptional, sidebar, rail, screens, legacy-layout configs. `vault-links` and the
  phone-landscape `screens` spec are known failing and were not touched.

## Not done / watch
- The companion has no cache, so it still says "Loading…" while the chat is already there.
- Cut decision titles (…) still show their ellipsis for a moment until the note reads arrive (r8 behaviour).
- Cached messages live only in the app's localStorage; none are in the repo or fixtures (fixture cache is one invented line).

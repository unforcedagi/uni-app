# REPORT: Simple first, round 3 (T-124 r3)

Polish only, on `feat/simple` from 05ae1cd. Nothing pushed. Design unchanged.

## Per item
1. **No clipped first line.** The room's message list has 20px top padding and a 28px soft fade at its top edge (`tree.css`, `.sr-chat .message-list`), so a line that scrolls under the header fades out instead of being cut mid-text. Verified by a computed-style spec, not by a pixel diff of the real COhere room.
2. **Needs-you rows.** Title is one line with an ellipsis; detail is one line with an ellipsis; raw URLs are stripped from visible text (`plainDetail`), the link stays in the opened item. With the fixture's three items at 1280x720 the "All of … work" link ends above 720px (spec asserts it).
3. **Decide is a button.** A decision shows its title on one line, then up to 3 options as filled inline buttons; more than 3 (or none) gets a "More…" / "Decide" outlined button that opens the item. The word "Decide" is no longer a grey label.
4. **Panel.** Tighter sections (smaller lede, margins), the panel scrolls on its own, 40px end padding and a soft fade at the bottom edge so nothing is cut hard.
5. **"All of COhere's work →"** (the node's name).
6. **Rooms tree.** "held by X" is gone from the tree rows, the room header and the row aria-labels. `#channel` shows only for a room with its own channel, in small text. A held room is just its name (e.g. "COhere" under "Boulder #cohere"). The composer placeholder still names the channel it posts to.
7. **Chevron.** The whole "Where this stands" row is one button that folds the side panel to its thin rail (and back from the rail); a spec clicks it and checks the width change.
8. **Empty needs-you** renders no section at all (spec on Learn Vibe Build).

## Tests
- `npx tsc --noEmit`: 0. `npm test`: exit 0.
- Playwright `simple`: 76 passed, 5 skipped (desktop-only, run on the phone project). New specs: one-line rows without URLs and fit at 1280x720, decision buttons, chevron fold, no empty heading, fade/padding and panel scroll. Existing specs updated: "Everything here" -> "All of … work", "held by" assertions.
- Other configs: roomsnav 30, treehome 24 (3 skipped), nested 6, chat-optional 6, rail 18, sidebar 14, areas 330 (10 skipped): all passed. screens: 6 passed, **1 failed: phone-landscape**, the same failure as in r2 (not caused by this round, still not fixed).
- Shots refreshed in `scripts/browser/__shots__/simple/` (new: `fold-1280x720.png`).

## Not done / caveats
- Not run in the real Tauri app, and the r2c walk screenshots were not regenerated; the checks are Playwright against the fixture.
- Fit-at-1280x720 is measured on the fixture's Uni room; a real room with long decision options wrapping to several rows could still push the link down (the panel then scrolls).
- I did not check the Buzz rooms drawer (narrow screens) for "held by" text; I changed only the tree rows and the room header.

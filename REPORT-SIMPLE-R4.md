# REPORT: Simple first, round 4 (T-124 r4)

Fixes from the two r3b critics, on `feat/simple` from c44d989. Nothing pushed. Design unchanged.

## Per item
1. **False empty room.** `No messages in this room yet.` shows only once that room's first fetch has resolved (`loadedView === currentView` in `App.tsx`); until then the list is blank (a quiet `role=status` placeholder). Spec with a delayed `get_messages` (fixture option `messagesDelay`): pending, no empty text; resolved empty (Learn Vibe Build), the text appears; a room with messages never shows it.
2. **Needs-you titles say the ask.** `askOf` strips a leading `Decision (...):` / `Decision:` label from the shown title; the opened item keeps the full title. Title clamps at 2 lines, detail stays 1. The fixture decision is now titled `Decision (default yes): Decide the ATLAS hosting`; specs check the row shows `Decide the ATLAS hosting` and the sheet still says `Decision (default yes)`.
3. **"All of X's work →"** is a sticky footer of the panel (always inside the panel's visible bottom, one line). The name ellipsizes, the arrow stays at the end. Spec: at 1280x600 it sits inside the panel, and with an absurdly long name it stays one line with the arrow inside the panel.
4. **Teaching's needs-you.** The rule is by field only: `owner` or `waiting_on` naming the user. Mismatch found: the match was an exact string compare to `aaron`; it now tolerates case and `person:` / `@` prefixes (`isMe` in `taskCore.ts`), used by grouping, sorting and the row text. I did not read the vault's task notes (instruction: don't touch the vault), so I can't say which of those spellings the real teaching tasks use; if they use something else (say `waiting_on: aaron` on a `done`-looking state) the section stays hidden, which is correct. Fixture gains three Learn Vibe Build tasks (room task waiting on `aaron`, own task, task waiting on `external`); spec expects the first two only. The "no empty heading" spec moved to Atlas Institute.
5. **Boulder "#cohere".** Cause (from the code; I did not have the real Boulder note): a node's room is found by channel id first. If an area's `channel` is the id of a room its child also names (COhere), the area resolved to that room and showed its slash name. `roomView` now lets the deepest node that names a room own it; the ancestor keeps only the room its `room` name finds, else none. Unit test: Boulder with `channel` = COhere's room id shows `#boulder`, or nothing when no `boulder` room exists; COhere keeps its own.
6. **Header: one place for the channel.** The `#channel` is a small line with the breadcrumbs (`Uni › Atlas › Learn Vibe Build · #atlas/teach`), above the title, once. Uni has the same shape: a small `#uni` line above its title. The composer placeholder still says where the message goes.
7. **Quiet marks explained.** Fold control: `title` + aria "Hide where this stands" / "Show where this stands". Orange dots (tree row, rail, strip): `title="Needs you"`.

## Tests
- `npx tsc --noEmit`: 0. `npm test`: exit 0 (treehome, profile unit tests extended).
- Playwright: `simple` 89 passed, 6 skipped (desktop-only on the phone project) after the last test fix, which was then re-run alone and passed; roomsnav 30, treehome 24 (3 skipped), nested 6, chat-optional 6, rail 18, sidebar 14, areas all passed.
- `screens`: 6 passed, **phone-landscape still fails** (same as r2/r3): the spec can't find the "Rooms" button in "Main navigation" at that viewport. A navigation layout issue unrelated to this round; not a quick fix, so left.
- Shots refreshed by the runs in `scripts/browser/__shots__/` (simple, nested, roomsnav, treehome).

## Not done / caveats
- Not run in the real Tauri app; no real-vault data was read. Item 4 and item 5 are fixed against the code and the fixture, not confirmed against the real notes.
- The r3b walk screenshots were not regenerated.

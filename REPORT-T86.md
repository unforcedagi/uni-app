# REPORT-T86 — the octopus with tasks, as a Parachute surface

Branch `feat/life-os`, on top of 4fb53ff. Committed, not pushed. `src-tauri/gen/schemas` untouched (not committed).

## What changed

**Data layer = the Parachute API** (no second store; the cache is memory only, scoped to the signed-in identity, cleared on Forget).
- `src/areas/taskCore.ts` (pure): parse `task`/`decision` notes, build the tree from `node` notes (cycles, missing and self parents, ids or `[[links]]` as references, archived nodes dropped, the `uni` root kept apart), subtree paths, grouping You / Rooms / Others, sort (waiting-on-you → in progress → due → title), roll-up counts, snooze rule, failure classification (409 / 422 / other).
- `src/areas/vaultTasks.ts`: `loadTree()`, `loadTasks(tree, path)`, `transition(id, from, to)`, `snooze(id, until, updatedAt)`. Transport injectable (mocked in tests).
- `src/areas/useTasks.ts`: optimistic hook (leave animation ≤ 240 ms, rollback with message, conflict → re-read, 5 s Undo).
- Rust: three new Tauri commands over the existing NIP-98 `/mcp` door: `vault_query_meta`, `vault_transition`, `vault_patch_meta` (`crates/uni-core/src/parachute.rs`, `src-tauri/src/lib.rs`).
- **Snooze decision:** the state stays as it was; `snoozed_until` (a `YYYY-MM-DD` date, tomorrow in the user's day) is merged into the task's metadata with `if_updated_at`. The client hides a task while `snoozed_until` is after today. Undo = same merge with `null`.
- **Attribution:** the vault stamps `lastUpdatedBy` / `lastUpdatedVia` from the app's own token; the task sheet shows "Changed by … via …" when present (a token-id UUID is shortened to 8 characters).

**UI**
- Node view: under the map, *Talk to this level* (hold-to-talk ≥ 56 px, names the room; tap = one line), the room's last 2 messages, then *Needs doing* grouped You / Rooms / Others. Descendant tasks carry "in <node>"; decisions sit under You with a "Decide" label. Past 8 per group: "Show N more".
- Arms carry a rolled-up open-count badge (the status marks stay); the arm's accessible name gains ", N open".
- Task sheet (dialog, focus-trapped, Esc / Android Back closes it first): Mark done (decision: Mark decided), Archive, Snooze until tomorrow, Open in #room. One-tap check circle on each row.
- Undo bar: 5 s, one at a time. A new action replaces the previous Undo.
- Talk target: the node's `room` name (T-84 field) → its `channel` ids → the parent's → #Uni. Voice goes through the app's existing durable voice outbox (`startVoiceFor` in `App.tsx` builds the same origin/queue the composer's recorder uses; `useRecorder.start` got an optional label); text uses the same `post_message` call as Send (recipients = the room's Uni member, as the voice path does). Drafts are never auto-sent anywhere else.
- Safety rules kept: vault text rendered as text only; cache scoped and cleared on Forget (`forgetAreas` → `forgetTasks`); archived nodes hidden; no looping animation; reduced motion drops the exit/enter animations; Android Back zooms out one level.

## Write → vault API call

| Action | Tauri command | Vault call |
|---|---|---|
| Mark done / Archive / Mark decided | `vault_transition {id, field: state, from, to}` | `update-note {id, state_transition: {field: "state", from, to}}` (atomic CAS; 409 `transition_conflict`, 422 `schema_validation`) |
| Undo | same, from/to swapped | the reverse `state_transition` |
| Snooze / its Undo | `vault_patch_meta {id, metadata: {snoozed_until}, ifUpdatedAt}` | `update-note {id, metadata, if_updated_at}` |
| Tree | `vault_query {tag: node}` | `query-notes {tag: node, include_content: false}` |
| Tasks | `vault_query_meta {tag: task/decision, metadata}` | `query-notes {tag, metadata: {node: {in: [paths + ids]}, state: {in: [...]}}}` |
| Voice note | existing `media_upload` → `prepare_voice_message` → `post_message` | the app's durable voice outbox |
| One line | `post_message {channel, body, replyTo: null, recipients, media: []}` | Buzz relay |

409 = "changed elsewhere", re-read, no retry. 422 = "the vault refused that value", rolled back. Anything else: rolled back with the error text.

## What ran

- `npx tsc --noEmit`: clean.
- `npm test`: exit 0, 373 `ok` lines (new `scripts/tasks.test.ts`: 13 checks — tree incl. cycles/missing parents, subtree set, grouping, roll-up, snooze day maths, failure kinds, `loadTree`/`loadTasks` query shape, `transition` 200/409/422, Undo reverse, talk-room resolution). One `interface.test.ts` check failed once while a browser run was loading the machine and passed on rerun and in the final full run (flaky under load; not touched by this work).
- `cargo test -p uni-core task_queries`: passes (checks the exact `query-notes` / `update-note` bodies against a scripted MCP door). `cargo check -p uni-app-tauri`: clean.
- Playwright areas config (`AREAS_TEST_PORT=14354`): 313 passed, 9 skipped, 0 failed (full run after the last change). New `scripts/browser/tasks.spec.ts`: 12 tests × 2 projects (24; 1 skipped by design: the three-size loop runs on desktop only).
- Rail config: 18 passed. Composer spec (`COMPOSER_TEST_PORT=14421`): 88 passed, 2 skipped.
- Existing assertions changed: `lifeos.spec.ts` counted exactly four `vault_query` tag queries; the task view's own `node` tree query is now excluded from those counts, and the Uni heading-order check ignores the new "Needs doing" `h2`.

## Screenshots (`scripts/browser/__shots__/t86/`, colour + `-gray`)
`uni-`, `techne-`, `cohere-`, `task-sheet-`, `after-done-undo-`, `hold-to-talk-` at 1600×1200 and 390×844; `cohere-` also at 1200×1600.
Two critique passes done: (1) the Rooms group vanished because its class `rooms` collided with the sidebar CSS → renamed; decisions had no check circle (misaligned rows) → added; talk bar capped to 640 px on desktop; a sticky talk bar on phones covered the map labels → removed; (2) Android Back now closes the open task sheet before zooming out.

## Known gaps
- Not run against the live vault (instructed): every vault call is covered by mocks, the Rust request-body test and the documented query shape. The one assumption I could not check: what a `reference` field returns (path vs id). `loadTasks` sends both paths and ids in `node: {in}`, and parsing accepts either, `[[links]]` included.
- The `in` list grows with subtree size; fine for tens of nodes. `limit` is 200 per query; a full page shows "Showing the first 200".
- If the vault has no `node` notes yet, the tree falls back to the app's own area/project tree.
- Decisions have no Archive (the enum is `open|decided`); their "Snooze" writes the same free-form `snoozed_until` key.
- On a phone the talk bar sits under the map, so it is one short scroll away (the chat peek covers its lower edge on first paint). The app's existing recording pill also shows while recording and can overlap the recent-message lines.
- The recorder needs the device microphone: tested with Chromium's fake media device, not a real phone.
- Only one Undo is offered at a time.

## Final totals
Areas config, full run: 313 passed, 9 skipped, 0 failed (322 tests, both projects).

## T-86b one-request queries

The app now reads a node's tasks with the vault's subtree queries (Parachute main 42fbf93) instead of walking the tree client-side.

**Door check.** The running vault is `@openparachute/vault` 0.7.9 (source under `~/.bun/install/global/node_modules/@openparachute/vault/src`). MCP `query-notes` accepts `near: {note_id, relationship, direction, depth, then: {relationship, direction}}` (`near-aggregate.test.ts` exercises the MCP tool with exactly that shape, plus `aggregate`), and `note_id` takes a path. So the Rust `/mcp` door sends it as a JSON argument; no REST detour.

**What changed**
- Rust (`crates/uni-core/src/parachute.rs`, `src-tauri/src/lib.rs`): two fixed-shape commands, `vault_subtree_nodes {vault, root}` and `vault_subtree_tasks {vault, tag, root, states, limit}`. There is no query passthrough: `tag` must be `task` or `decision`, `states` are 1–8 lowercase words, `root` is validated (non-empty, ≤256 bytes, no control characters, no `..` segment). `vault_query_meta` stays for the fallback. Test `subtree_queries_send_the_fixed_near_shapes` checks the exact request bodies and the rejections.
- `vaultTasks.ts`: `loadSubtree(X)` = the `node` notes via `near` inbound over `parent` (one request; the anchor is always included). `loadTasks` = one `near`+`then` request per kind (`task`, and `decision` because a request has one tag, run in parallel) with the live-state filter; no tree needed. The Uni root (ROOT) is still a plain state filter with no `near`, since it means everything.
- Fallback: an unknown-parameter / 400 style error flips a per-session flag (`nearSupported()`), and the existing two-query walk (`node in [paths+ids]`) runs from then on, never retrying. A `not_found` anchor falls back for that call only (and tries `loadSubtree` when the loaded tree lacks the node); a network or other vault error is thrown to the caller, never mistaken for a missing feature.
- `nodeStatus`: `active` now reads as `foreground`; `incubating` and `background` read as background (the vault's aliases).

**Arm badges: computed from the loaded task list (`rollUp`), not `aggregate`.** It costs zero extra requests, whereas `aggregate[group_by]=owner` is one request per arm. Also the You/Rooms/Others split is not a function of `owner` alone (decisions and `waiting_on: aaron` count as You), so an owner aggregate can't reproduce it. Trade-off: when a page is truncated (200) the badges are a lower bound, as before.

**Live read-only check** (`http://localhost:1940/vault/uni/api/notes`, token never printed; statuses `open,doing,waiting`, tag `task`):

| Node | nodes under | one-request tasks | two-query tasks | same ids | owners (one = two = aggregate) |
|---|---|---|---|---|---|
| `Uni` | 40 | 76 | 76 | yes (0 diff) | aaron 50, uni 5, room:uni-os 5, room:techne 5, room:lab 4, room:cohere 3, room:parachute 2, room:woven-web 1, room:atlas 1 |
| `Areas/Techne` | 8 | 28 | 28 | yes | aaron 19, room:techne 5, room:cohere 3, room:woven-web 1 |
| `Projects/COhere/COhere 2026` | 1 | 10 | 10 | yes | aaron 7, room:cohere 3 |

The `aggregate[group_by]=owner` request returned the same counts in all three cases. `near` includes the anchor node itself (e.g. `Areas/Techne` is in its own node list). Open decisions: 4 under `Uni` via `near`, 4 in the vault overall.

**Tests.** `scripts/tasks.test.ts`: six new checks (one-request shape and detection; unknown-parameter fallback, detected once; network error thrown; `not_found` falls back without disabling; `loadSubtree`; tree-lacks-node resolution) with a mocked transport; the old query-shape check now runs on the fallback path. Playwright: the fixture answers `vault_subtree_nodes`/`vault_subtree_tasks` and has a `nearOff` switch; `tasks.spec.ts` asserts the one-request path makes no two-query walk, and a new test checks the fallback shows the same counts and is not retried. Results are under "Final totals (T-86b)" below.

**Left alone: `active` → foreground.** The vault note says `foreground` = `active` and `incubating` = `background`. `incubating` already reads as background. Making `active` read as foreground would turn every live project (all `active`) into a foreground arm and breaks the map-ordering specs, so `nodeStatus` is unchanged; that is a design call for Aaron, not part of this query switch.

### Final totals (T-86b)
- `npx tsc --noEmit`: clean. `npm test`: exit 0, 379 `ok` (tasks.test.ts: 18 checks incl. six new). `cargo test -p uni-core`: 83 + 22 + 1 passed (new `subtree_queries_send_the_fixed_near_shapes`); `cargo check -p uni-app-tauri`: clean.
- Rail config: 18 passed. Areas config (`tasks.spec.ts` alone): 25 passed, 1 skipped by design.
- Areas config, full run: 310 passed, 9 skipped, **5 failed**; composer spec: 110 passed, 3 skipped, **1 failed**. All six are the same assertion family: the seeded brief note has a need "due 2026-10-10", which is overdue on today's real date (2026-10-11) and ranks above "Send the Q4 invoice" (`lifeos.spec.ts:16`, `:64`, `nodeview.spec.ts:22`, both projects). It is clock-dependent fixture data in the Today ranking, untouched by this change (I did not run it against the pre-change commit to prove that). Fix is to make the fixture date relative to now.

## T-86c review fixes

Fixes for the review of 5c2c096 (SHIP with P2/P3).

- **P2 write door narrowed.** `transition_note` only accepts the field `state` (anything else is refused before a request); the `vault_transition` command no longer takes a `field` and hard-codes `state`. `patch_metadata` accepts exactly one key, `snoozed_until`, as a `YYYY-MM-DD` date or null, and first reads the stored note: it must be tagged `task` or `decision`. New Rust tests: `transitions_and_patches_refuse_anything_but_state_and_snooze` (no request is made) and `snooze_is_refused_on_notes_that_are_not_tasks`; the existing task-query test now scripts the tag read.
- **P2 schema doc.** `snoozed_until` (date) is documented on `task` and `decision` in `/home/uni/Code/uni-sketches/t84-data/TYPES.md` (that file is outside this repo and not under git). The live schema is unchanged.
- **P3 midnight.** `useTasks` re-reads the local date on visibility and window focus and recomputes `visible`, so snoozed tasks reappear after midnight.
- **P3 phone talk bar.** On the sheet layout `.talk` is sticky above the chat peek. New phone test `Hold to talk bar is fully above the chat peek`; it fails without the CSS and passes with it.
- **P3 tree cap.** `useTasks` exposes `treeTruncated` and the task list shows "The tree was cut short at 200 nodes…" when the node query hits its cap. (No browser test: the fixture would need 200 node notes.)
- **Date-dependent tests.** `bootAreas({ pinned: true })` freezes the page clock and the fixture's relative timestamps at 2026-10-09 10:00Z. Used by `lifeos.spec.ts` (both describes) and `nodeview.spec.ts`, so `lifeos.spec.ts:16`, `:64` and `nodeview.spec.ts:22` pass on any day.
- **Flaky timing tests.** `interface.test.ts` builds the 5M-element array outside the timer and bounds the fastest of five runs (still < 100 ms); `vaultlinks.test.ts` bounds the fastest of five runs for each timing check (same limits). A quadratic regression is slow on every run, load only on some, so the assertions keep their meaning.

### Final totals (T-86c)
- `npx tsc --noEmit`: clean. `npm test`: exit 0 three times in a row, 379 `ok` each.
- `cargo test -p uni-core`: 85 + 1 + 22 passed; `cargo check -p uni-app-tauri`: clean.
- Areas config (full): 316 passed, 10 skipped, 0 failed. Rail config: 18 passed. Composer spec: 111 passed, 3 skipped, 0 failed.

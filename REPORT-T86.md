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

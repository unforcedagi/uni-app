# REPORT-T140-APP: the area tree from node links, and the Rooms / Projects / Areas views

Branch `feat/t140-links` (from feat/simple 86aaa32). Not pushed.

## What changed

**Data model (pure)**
- `src/areas/nodeLinks.ts` (new): one graph builder for both trees. A link is `metadata.links` (ids, paths or `[[links]]`) read two-way; legacy `metadata.parent` counts as one more link; Uni links to everything implicitly (the Uni note is not in the node set, so a link or parent to it is simply dropped). Unresolved ids, self links, links to archived nodes are ignored. Area children = projects linked to it (either end); a project in two areas is a child of both (one node object). Project-to-project and area-to-area links are recorded in `links` only and never nest. A project with no area is top level. Its primary parent (Back, default breadcrumb) is its first linked area by name. No recursion over links, so cycles cannot loop.
- One legacy exception, outside the brief: a project whose only tie is an old `parent` naming a *project* inherits that project's areas (walk with a repeat guard). Without it, COhere 2026 / Boulder Votes / Woven Web dropped to the top level before the migration. After the migration (parent cleared) it has no effect.
- `areasCore.ts`: `Area.links`; `parseProject` no longer requires `parent` (a project is a tagged note with `parent`, `links`, or a path directly under `Projects/`).
- `treeCore.ts`: `buildTree` uses the graph; `Tree` gains `links`, `areasOf`, `archived` (retired nodes, used to know which rooms are archived). `trail`/`parentPath` take an optional `via` area.
- `taskCore.ts`: `TaskNode` gains `links`/`kind`; `buildTaskTree` uses the same graph (and `TaskTree` gains `areasOf`, `links`); `savedTasks.ts` keeps them (old caches load with empty maps). `rollUp` counts a project once in every area above it and once at Uni (it double-counted a project under two areas).
- `vaultTasks.ts`: the subtree no longer comes from a vault `near` walk over `parent` (it would miss every `links` edge). `loadTasks` computes the subtree from the tree in memory and sends the same two requests as before (`node in [paths and ids]`, one per kind). `loadSubtree`/`nearSupported` and the near feature-detect are gone; the Rust `vault_subtree_*` commands are now unused (left in place).

**UI**
- `treeRooms.treeRows`: rows carry `key` and `via`; a project linked to two areas has two rows with one `path`. `sidebarState.ancestorsOf` reveals every area that holds the selected node, so both rows show and highlight. `TreeHome`: rows keyed by `key`; the fold stays per area (projects never fold).
- Breadcrumb/Back: `AreasSurface` keeps the area you reached a node through (`viaMemory`, outside the component because opening a place remounts it) and falls back to the first linked area.
- New `viewsCore.ts` + `TreeHome` views, switch at the top of the sidebar (and the phone home), remembered per device (`uni.sidebar.view.v1`, default Areas):
  - **Rooms**: every live room by `last_ts` (the app's own room list, kept current by the live push; no new request), newest first, rooms with no message last; archived rooms (named by an archived/done node, or a `room_status: archived` room no live node owns) behind one "Show archived (N)" line.
  - **Projects**: a card per project sorted by its room's last activity; shows `#room` or `talks in #room`; chips for linked areas, then linked projects; a chip or the room opens that room's chat (a chip for a roomless project opens the room it talks in); the name opens the project.
  - **Areas**: the existing tree (areas with their projects, Uni on top).
- Styles in `tree.css`.

## Tests
- `npm test`: 413 checks, 0 failed (new `scripts/links.test.ts`, 14: parent-only, links-only, mixed with duplicates, two-way read, project in two areas, project in no area, unresolved ids, cycle safety, legacy parent project, trail/Back via, sidebar rows and reveal, task tree + rollUp, Rooms/Projects views, view memory). Rewritten for the flat model (nesting assumptions removed): `ids`, `lifeos`, `tasks`, `treehome` tests.
- `tsc --noEmit`: clean.
- `playwright.simple.config.ts`: 667 passed, 107 skipped, 0 failed (full run after the last change). Earlier full runs had 2 r19 sheet-layout failures that passed in isolation (load-dependent flakes). New `scripts/browser/t140.simple.spec.ts` (4 tests x mac, mac-small, phone): uni-app under Parachute and Sadhana and RegenHub under Boulder and Techne (the Techne side listed on the area only), both rows open the same room and highlight, the breadcrumb follows the area used; Rooms sorted by activity with archived hidden and shown on request, view remembered after a reload; Projects order, "talks in", every chip opens the right room. `__shots__` restored.
- Other tree configs: `nested` 6/6, `sidebar` 14/14, `roomsnav` 24 passed / 3 failed, `areas` 248 passed / 2 failed on one run (the two `areas` failures, phone, passed on re-run in isolation; the 3 `roomsnav` failures, "Boulder → COhere 2026 … subtree", fail the same way on the unmodified base 86aaa32).
- Fixture: `links` boot option in `areasFixture.ts` (Parachute area, uni-app, Mail, RegenHub, an archived Old Client with its room).

## Real data (read-only)
Source: a read-only copy of the scratch hub's vault db (`t124-vault/home/vault/data/uni/vault.db`, opened `mode=ro`; the hub on 127.0.0.1:19390 needs a login I did not use). It is parent-only. Its areas and Uni note predate `node` tagging, so I tagged them `node` in memory only, then ran `links_migrate.plan(merges=False)` (40 planned writes, no warnings, nothing written, `--apply` never run) and `apply_to` in memory. The same `parseArea`/`parseProject`/`buildTree` ran over both note sets.

```
## BEFORE: parent-only (scratch hub as it is)  (42 nodes, 0 archived)
Uni
  Atlas
    - ATLAS
    - Atlas Institute
    - Learn Vibe Build
  Boulder
    - AI Oracle
    - Boulder New Tech
    - Boulder Votes
    - Civic
    - COhere
    - COhere 2026
    - RegenBoulder
    - RegenHub
    - Riverside
    - Solarpunk Cafe
    - Spirit of the Front Range
    - Woven Web
  Parachute
    - Lab
    - Mail
    - Parachute
    - uni-app
  Relationships
  Sadhana
  Techne
    - Games.Coop
    - Gitcoin Brain
    - scenius.social
    - Techne
    - TechneOS
  Unforced Development
    - AmeliaPasser.com
    - Carolyn Wagner — AI Video
    - JessicaSirenaMusic.com
    - Ricki
    - SandraEasterPhD.com
    - Unforced Development
    - unforced.org
  Expression
    - Art of Seeing
    - Life Unforced
    - Open Human Design
project-project links (noted only): COhere 2026 ~ COhere; Civic ~ Boulder Votes; Boulder Votes ~ Civic; Woven Web ~ COhere; COhere ~ COhere 2026, Woven Web
## AFTER: links_migrate dry-run plan applied in memory  (42 nodes, 0 archived)
Uni
  Atlas
    - ATLAS
    - Atlas Institute
    - Learn Vibe Build
  Boulder
    - AI Oracle
    - Boulder New Tech
    - Boulder Votes
    - Civic
    - COhere
    - COhere 2026
    - RegenBoulder
    - RegenHub
    - Riverside
    - Solarpunk Cafe
    - Spirit of the Front Range
    - Woven Web
  Parachute
    - Lab
    - Mail
    - Parachute
    - uni-app
  Relationships
  Sadhana
  Techne
    - Games.Coop
    - Gitcoin Brain
    - scenius.social
    - Techne
    - TechneOS
  Unforced Development
    - AmeliaPasser.com
    - Carolyn Wagner — AI Video
    - JessicaSirenaMusic.com
    - Ricki
    - SandraEasterPhD.com
    - Unforced Development
    - unforced.org
  Expression
    - Art of Seeing
    - Life Unforced
    - Open Human Design
project-project links (noted only): COhere 2026 ~ COhere; Civic ~ Boulder Votes; Boulder Votes ~ Civic; Woven Web ~ COhere; COhere ~ COhere 2026, Woven Web
```

The two trees have the same shape. Before the migration the three project-under-project nodes (COhere 2026, Woven Web, Boulder Votes) are placed by the legacy-parent rule above; without that rule they would be top level (that was the first run). This hub has no project linked to two areas, so the multi-area case is covered by the unit tests and the Playwright fixture, not by this data. The v2 map's extra links (RegenHub to Techne, uni-app to Sadhana) come from `links_migrate`'s `EXTRA_LINKS`, which the default plan does not apply.

## Unverified / for Aaron
- Privacy: `isPrivateNode`/`privateRoot` read the primary-parent chain. uni-app is under Parachute first (alphabetical), so it is not treated as Sadhana-private even though it is also shown under Sadhana. If a project linked to a private area should count as private, that is a one-line change in `treeRooms.ts`; I left the behaviour and want a decision.
- Archived rooms are inferred (a retired node's room, or `room_status: archived`); the relay gives no archived flag. Real vault data was not run through the Rooms view; the app was exercised only on the fixture.
- The Rust `vault_subtree_nodes` / `vault_subtree_tasks` commands and the `lifeosAnyVault.ts` mocks for them are now unused; I did not delete them.
- Not run on a device or the Tauri build; only the browser fixture (Chromium: desktop, 1280x800, phone viewport).
- The Projects/Rooms views do not show unread dots or task counts yet; the Areas view keeps its dots.

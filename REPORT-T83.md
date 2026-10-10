# T-83: the octopus node view is the app's home (direction C)

Branch `feat/life-os` on top of eed701c. Committed, not pushed. `src-tauri/gen/schemas` untouched.

## What changed
- **One generic node view** for Uni (root), an area and a project: `src/areas/NodeStage.tsx` (the map) inside the existing `AreaView`/`BriefView` page, so the chat, room switcher, "Open #room", Ask/Refresh drafts, App tab and sealed frame are unchanged.
  - **Centre:** the node's title, its freshness label, then Needs you first and Moving after, two lines at most (the full lists stay below the map with their Ask Uni buttons). Uni's centre reads the ranked cross-area needs and Moved from Today. No brief: "No brief yet", and "Ask Uni to write it" drafts in the node's room (Uni: `@Uni Please refresh Areas/Today`). Never sent.
  - **Arms:** children from the tree (areas at root, projects or sub-areas below). Mark without colour: needs you = solid disc with a second ring, moving = heavy ring, quiet = dashed ring; arm line weight follows. A node's mark is the strongest of itself and everything below it (briefs matched by path only). Background children are smaller. Archived/done stay hidden (existing `nodeStatus`/tree rule). Children's children are drawn as small tips only when the stage is >= 1000 px wide.
  - **Parent chip** above the centre ("Zoom out to X"); breadcrumbs unchanged.
  - **Conversation:** unchanged plumbing. Side by side at >= 900 px, pull-up sheet on a phone (one tap on the peek bar).
  - **Area slot:** `src/areas/areaSlots.tsx`, `areaSlots: Record<nodePath, Component>` (empty) with the stub "This space is for <Area>'s own view." for every area; none for Uni or projects. The App tab/sealed frame path is untouched.
- **Layout** (`src/areas/nodeMap.ts`, pure): arm positions on an ellipse, greedy placement that checks nodes, labels, the centre and the chip; phone labels wrap to two lines; leaf nodes get a larger centre and a short stage.
- **Zoom:** one script-driven transition per tap, 300 ms, ease-out (Web Animations API, finite). The tapped node's rect becomes the new centre, the old centre becomes the chip, children fade/scale in. Zoom out from the chip reverses it; Back / Android back (existing parent-path hook) uses a short scale-in. `prefers-reduced-motion` skips it. There is no CSS animation, no looping and no continuous motion anywhere in the new code.
- **Home:** the app opens to the node view at Uni, painting from the device cache before the network (existing path). The old cards (`ChildCards`) are gone; the Today lists (Needs you, Moved) stay below the map.
- Grayscale first: rings, weights, rules and type; touch targets >= 44 px (arms, chip).

## What ran
- `npx tsc --noEmit`: clean.
- `npm test`: exit 0, 215 ok / 0 fail (includes new `scripts/nodeMap.test.ts`: marks and roll-up, layout for 1-8 children at 358 px / portrait / desktop / few-children stages with and without a parent chip (no overlap, inside the stage, >= 44 px), leaf centre, tips, centre lines, slot registry fallback).
- `AREAS_TEST_PORT=14351 npx playwright test --config playwright.areas.config.ts`: **290 passed, 8 skipped** (phone + desktop). New `scripts/browser/nodeview.spec.ts`: Uni -> Techne -> COhere 2026 -> back twice via breadcrumb, via chip, and via the Android-back hook; centre shows Needs you from the brief; the node's room composer at each level; no-brief state; slot stub; every `document.getAnimations()` entry finite with motion allowed and reduced, the zoom's animations <= 350 ms and none running after it; `scrollWidth <= innerWidth` at all three sizes.
- `npx playwright test --config playwright.rail.config.ts`: 18 passed.
- Existing specs updated where they asserted the removed cards (`areas.spec.ts`, `lifeos.spec.ts`, `areasFixture.ts` `areaCard` now means a map arm; `playwright.areas.config.ts` matches `nodeview`).

## Screenshots
`scripts/browser/__shots__/t83/{uni,techne,cohere}-{1600x1200,1200x1600,390x844}[-gray].png`. Two critique->fix passes: (1) stage sized by child count (a leaf no longer sits in 700 px of space), phone labels wrap instead of "Unforced De...", freshness moved under the title; (2) leaf centre enlarged so its text is not clipped by the ring, compact centre (one-line items) when the disc is small.

## Known gaps
- **Rooms at work** marks: not done (optional; would need a read of System/Room activity).
- Area slot is a stub for every area; nothing registered. The sealed App still lives on the App tab rather than inside the slot.
- Tips (projects at the arm tips) appear only on stages >= 1000 px wide, so on Daylight with the chat side by side they mostly will not; arms still show roll-up status.
- The zoom is a grow/fade with a rect flip; it was verified for existence, length and finiteness, not by eye on a real Daylight or phone.
- At 1200 px wide the side chat leaves the map about 750 px, still the wide layout; below 560 px stage width it is the phone layout (count line in the centre, items below).
- Breadcrumb spacing before the current crumb ("›Techne") is pre-existing and unchanged.

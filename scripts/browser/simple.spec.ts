// T-124: simple first. A room opens to its conversation (the app's own chat, clean); the state is a quiet companion beside it (desktop) or a
// one-line strip above it (phone): one sentence, at most three that need you, what is running. Nothing under a message; its actions are a ⋯ menu.
// "Everything here" goes one level deeper, to the full node page.
// Run: SIMPLE_TEST_PORT=5711 npx playwright test --config playwright.simple.config.ts
import { mkdir } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import { bootAreas } from './areasFixture';

const SHOTS = 'scripts/browser/__shots__/simple';
/** r27: `__arrive(…, -426600)` puts a message at 2026-10-14 08:30Z (the fixture's clock is pinned at Oct 9 10:00Z): after a record written at 08:00 that day */
const BUILD = '7dcea809-25cd-4160-ba99-f0a56386adcb';
const wide = (page: Page) => (page.viewportSize()?.width ?? 0) >= 900;
/** r17: the tree sits beside the room only on a wide window at least 400px tall; otherwise it is in the Places drawer. */
const treeBeside = (page: Page) => wide(page) && (page.viewportSize()?.height ?? 0) >= 400;
const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const calls = (page: Page, cmd: string) => page.evaluate((c) => (window as any).__calls.filter((x: any) => x.cmd === c).map((x: any) => x.args), cmd);
const shot = async (page: Page, name: string) => {
  const s = page.viewportSize()!;
  if (s.width !== 1440 && s.width !== 390) return;
  await mkdir(SHOTS, { recursive: true });
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/${name}-${theme}-${s.width}x${s.height}.png` });
  }
  await page.emulateMedia({ colorScheme: 'light' });
};
/** r27: a sheet's chat lookup settles (pending, then current, unconfirmed or couldn't read). Where the answers wait behind "Answer anyway", take that one tap, so a check that is about something else sees the sheet with its answers. */
async function answersOpen(sheet: ReturnType<Page['locator']>) {
  await expect(sheet.locator('.task-lookpending')).toHaveCount(0, { timeout: 10_000 });
  const anyway = sheet.getByRole('button', { name: 'Answer anyway' });
  if (await anyway.count()) await anyway.click();
}
/** r28: the task's sheet (a phone's strip panel is a dialog too, and it stays under a task's sheet) */
const taskDialog = (page: Page) => page.getByRole('dialog').filter({ has: page.locator('.task-kind') });
const base = { briefs: true, tree: true, tasks: true, atlas: true, steer: true, pinned: true } as const;
const boot = (page: Page, extra: Parameters<typeof bootAreas>[2] = {}) => bootAreas(page, 'seed', { ...base, ...extra });
const scope = (page: Page) => (treeBeside(page) ? page.locator('.th-roomnav') : page.locator('.th-phone-tree'));
/** Open a room from the rooms list (phone: back to the list first when a room is open). */
async function openRoom(page: Page, name: string) {
  // r16: the strip's sheet is modal over the room: close it first, as a person would
  if (!wide(page) && await page.locator('.cp-sheet').count()) { await page.keyboard.press('Escape'); await expect(page.locator('.cp-sheet')).toHaveCount(0); }
  // r13: below 900px the tree is the phone's home and, from a room, the drawer the room's header opens
  if (!treeBeside(page)) { await page.locator('.sr-drawer, .th-phone-tree').first().waitFor(); if (await page.locator('.sr-drawer').count() && !await page.locator('.th-drawer').count()) await page.locator('.sr-drawer').click(); }
  await unfoldAll(page);
  await scope(page).locator(`.th-go[aria-label^="${name},"]`).click();
  // r15: the place opened (a node in a borrowed room has the room as its heading, the node on a line under it)
  await expect(page.locator('.sr')).toHaveAttribute('data-node', name);
}
/** Areas start folded (all but the one holding the open room): open every fold so any row can be clicked. */
async function unfoldAll(page: Page) {
  await scope(page).locator('.th-row.d1').first().waitFor(); // the tree has loaded
  for (let i = 0; i < 12; i++) {
    const f = scope(page).locator('.th-fold[aria-expanded="false"]');
    if (!await f.count()) return;
    await f.first().click();
  }
}
/** The work view's rows at a side panel's width, so a long step has to clamp there too (the r7–r16 More checks, r18: moved from the companion). */
const narrowWork = (page: Page) => page.addStyleTag({ content: '.sr-work .cp-list { max-width: 236px !important; }' });
/** r18: per-row More lives in the work view (the companion's rows open their sheets): open "All of …'s work" from the companion. */
async function openWorkView(page: Page) {
  await openCompanion(page);
  await page.getByRole('button', { name: /^All of .*'s work/ }).first().click();
  await expect(page.locator('.sr-work')).toBeVisible();
}
const companion = (page: Page) => page.getByRole('region', { name: 'Where this stands' }).or(page.getByRole('complementary', { name: 'Where this stands' }));
/** r20 (Codex 7): a decision's answers are in its sheet only: open the row, and its answers are the sheet's. */
async function sheetAnswers(page: Page, row: ReturnType<Page['locator']>) {
  await row.locator('.cp-need').first().click();
  const answers = page.getByRole('dialog').filter({ has: page.locator('.task-kind') }).getByRole('group', { name: /^Decide:/ });
  await expect(answers).toBeVisible();
  return answers;
}
/**
 * r28: a task's sheet from the work view: its row when the ask is confirmed, else "Open" in the recheck list (the feed decides which, once the
 * chat of its room has been read).
 */
async function openTaskSheet(page: Page, text: string | RegExp) {
  const rows = page.locator('.sr-work .cp-item').filter({ hasText: text });
  await expect(page.locator('.sr-work .cp-checking')).toHaveCount(0, { timeout: 10_000 });
  if (await rows.count()) { await rows.locator('.cp-need').first().click(); return; }
  const line = page.locator('.sr-work .cp-recheck-line');
  await expect(line).toBeVisible();
  if ((await line.getAttribute('aria-expanded')) !== 'true') await line.click();
  await page.locator('.sr-work .cp-recheck-item').filter({ hasText: text }).locator('.cp-rc-open').click();
}
/** The phone's strip opens on a tap; the side panel is open already. */
async function openCompanion(page: Page) {
  // (r19: a wide window under 400px tall has the strip too)
  const strip = !wide(page) || await page.locator('.cp.strip').count() > 0;
  if (strip && await page.locator('.cp-line[aria-expanded="false"]').count()) await page.locator('.cp-line').click();
  await expect(page.locator('.cp-body').first()).toBeVisible();
  // r16: an opened strip shows the rows that fit whole; the rest (and a short window's whole strip) are in its sheet
  if (strip) { const more = page.locator('.cp-strip-body .cp-more-rows:not(.cp-more-all)'); if (await more.count()) { await more.click(); await expect(page.locator('.cp-sheet .cp-body')).toBeVisible(); } }
}

test.describe('simple', () => {
  test('a room opens to its conversation, not a state page', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'ATLAS');
    const chat = page.locator('.sr-chat');
    await expect(chat.locator('.message')).toHaveCount(3);
    await expect(chat).toContainText('Where are we on the SOW?');
    await expect(chat.getByRole('textbox', { name: /^Message / })).toHaveAttribute('placeholder', 'Message #atlas/build');
    await expect(page.locator('.sr-door')).toHaveText('#atlas/build');
    // none of the state page's furniture is on this screen
    await expect(page.locator('.wr-counts, .th-sec, .wr-needs, .logstrip, .steer, .talk, .th-ledger')).toHaveCount(0);
    await expect(page.locator('.compose-hint')).toBeHidden();
    expect(await fits(page)).toBe(true);
    await shot(page, 'room');
  });

  test('the companion: where it stands (one sentence, quiet time), at most three that need you, what is running; each item opens its task', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'ATLAS');
    await openCompanion(page);
    const cp = page.locator('.cp-body');
    await expect(cp.locator('.cp-lede')).toContainText('The SOW is drafted and waits on Casey.');
    await expect(cp.locator('.cp-lede')).not.toContainText('The map comes next');
    // r29: a written summary is a dated account, "Last written Oct 13 by #room:", below Needs you; the heading adds no second date
    await expect(companion(page).getByText(/^Where this stands$/).first()).toBeVisible();
    await expect(cp.locator('.cp-asof')).toHaveText(/^Last written [A-Z][a-z]{2} \d+ by #\S+:$/);
    await expect(cp.locator('.cp-stands').first()).toHaveText(/^The SOW is drafted and waits on Casey\./);
    expect((await cp.locator('.cp-stands-note').boundingBox())!.y).toBeGreaterThan((await cp.getByRole('region', { name: 'Needs you' }).boundingBox())!.y);
    const needs = cp.getByRole('region', { name: 'Needs you' });
    await expect(needs.locator('.cp-need')).toHaveCount(2);
    // the decision on this very node leads and carries its options as buttons
    // Now before Soon: the dated Now task first, then the decision (Soon), which carries its options as buttons
    await expect(needs.locator('.cp-need').first()).toContainText('SOW for the commons grant');
    await expect(needs.locator('.cp-need').nth(1)).toContainText('Decide the ATLAS hosting');
    await expect(needs.locator('.cp-opt')).toHaveCount(0); // r20 (Codex 7): its answers are in its sheet
    await expect(needs).toContainText('SOW for the commons grant');
    await expect(needs).toContainText('Confirm scope with Casey');
    await expect(needs).toContainText('due Oct 13');
    const running = cp.getByRole('region', { name: 'Running', exact: true });
    await expect(running).toContainText('Draft the SOW');
    await expect(running).not.toContainText(/scratch|Runs\//);
    await expect(running.locator('.cp-run')).toHaveCount(2); // running (T-125 shape) + queued (0.1.44 ledger); the finished one is not "running"
    await expect(running).not.toContainText('Summarise the grant call');
    // no count badges, counters row, moved list, drafts or tasks here, and no "+N more"
    await expect(cp.locator('.wr-counts, .th-h, .wr-h, em, .cp-more')).toHaveCount(0);
    await expect(cp.getByText(/Moved this week|Drafts|\d+ more|\d+ of \d+/)).toHaveCount(0);
    await shot(page, 'companion');
    // an item opens its task sheet
    await needs.locator('.cp-need[data-id="T-07"]').click();
    await expect(taskDialog(page).first()).toContainText('T-07');
    await page.keyboard.press('Escape');
  });

  test('where it stands is the node\'s own sentence, never a count or the description', async ({ page }) => {
    await boot(page);
    await scope(page).locator('.th-go[aria-label^="Uni,"]').click();
    await expect(page.locator('.sr-title')).toHaveText('Uni');
    await openCompanion(page);
    await expect(page.locator('.cp-lede')).toContainText('Atlas and COhere are moving');
    await expect(page.locator('.cp-lede')).not.toContainText(/need you|areas/);
    await openRoom(page, 'Learn Vibe Build');
    await openCompanion(page);
    await expect(page.locator('.cp-lede')).toContainText('Cohort two starts Oct 15');
    await expect(page.locator('.cp-lede')).not.toHaveText(/^Learn Vibe Build\.?$/);
    // a node with no `stands` says the latest thing in plain words, or nothing: never the description's first sentence
    await openRoom(page, 'Atlas Institute');
    await openCompanion(page);
    const lede = page.locator('.cp-lede');
    if (await lede.count()) await expect(lede).not.toHaveText('Atlas Institute.');
  });

  test('every item that needs you is reachable (whole rows, the rest behind "+N more ›"); "Everything here" goes to the full page', async ({ page }) => {
    await boot(page);
    if (!wide(page)) await expect(page.locator('.th-phone-tree')).toBeVisible();
    await scope(page).locator('.th-go[aria-label^="Uni,"]').click();
    await expect(page.locator('.sr-title')).toHaveText('Uni');
    await openCompanion(page);
    const needs = page.locator('.cp-body').getByRole('region', { name: 'Needs you' });
    // r17: Uni's panel is at most three rows; everything else is one "N more ›" to the work view, which lists every one
    expect(await needs.locator('.cp-list > .cp-item').count()).toBeLessThanOrEqual(3);
    const more = needs.locator('.cp-more-all');
    if (await more.count()) await more.click(); else await page.getByRole('button', { name: /^All of .*'s work/ }).click();
    // r13: the work view, inside the room shell
    await expect(page.locator('.sr-work section[aria-label="Needs you"]')).toBeVisible();
    expect(await page.locator('.sr-work section[aria-label="Needs you"] .cp-need').count()).toBeGreaterThanOrEqual(3);
  });

  test('one tap on an option decides: a compare-and-set with the decided metadata', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'ATLAS');
    await openCompanion(page);
    const needs = page.locator('.cp-body').getByRole('region', { name: 'Needs you' });
    // r20 (Codex 7): one tap on an option in the decision's sheet
    await (await sheetAnswers(page, needs.locator('.cp-item').filter({ hasText: 'Decide the ATLAS hosting' }))).getByRole('button', { name: 'Self-host' }).click();
    await expect.poll(async () => (await calls(page, 'vault_decide')).length).toBe(1);
    const a = (await calls(page, 'vault_decide'))[0];
    expect(a).toMatchObject({ id: 'dq2', from: 'open', to: 'decided', metadata: { decided: 'Self-host', decided_by: expect.any(String), answered_rev: expect.any(String) } });
    expect(Date.parse(a.metadata.decided_at)).not.toBeNaN();
    await openCompanion(page); // a phone's strip closed when the row opened
    await expect(needs).not.toContainText('Decide the ATLAS hosting');
    await expect(needs).toContainText('SOW for the commons grant');
  });

  test('a decision someone else already decided says so and refreshes', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'ATLAS');
    await openCompanion(page);
    const needs = page.locator('.cp-body').getByRole('region', { name: 'Needs you' });
    const answers = await sheetAnswers(page, needs.locator('.cp-item').filter({ hasText: 'Decide the ATLAS hosting' }));
    await expect(answers.getByRole('button', { name: 'Managed' })).toBeVisible();
    await page.evaluate(() => (window as any).__decideElsewhere('dq2'));
    await answers.getByRole('button', { name: 'Managed' }).click();
    await expect(page.getByRole('alert').or(page.getByRole('status')).filter({ hasText: /decided elsewhere/i }).first()).toBeVisible();
    await page.keyboard.press('Escape');
    await openCompanion(page);
    await expect(needs).not.toContainText('Decide the ATLAS hosting');
    await expect.poll(async () => (await calls(page, 'vault_decide')).length).toBe(1);
  });

  test('needs-you rows: the action, then its next step in full; raw links become short link text; the foot stays on screen at 1280x720', async ({ page }) => {
    test.skip(!wide(page), 'side panel');
    await page.setViewportSize({ width: 1280, height: 720 });
    await boot(page);
    await scope(page).locator('.th-go[aria-label^="Uni,"]').click();
    await openCompanion(page);
    expect(await page.locator('.cp-body .cp-item').count()).toBeGreaterThanOrEqual(2);
    await expect(page.locator('.cp-body')).not.toContainText(/https?:\/\//);
    const item = page.locator('.cp-item').filter({ hasText: 'COhere festival readiness' });
    await expect(item.locator('.cp-next')).toContainText('Check-in PR by Oct 12, see example.invalid for the diff');
    await expect(item.locator('.cp-link')).toHaveText('example.invalid');
    // r21 (Codex 10): in a row a link is words (its address in the tooltip); it opens from the sheet
    await expect(item.locator('.cp-link')).toHaveAttribute('title', 'https://example.invalid/pr/12');
    await expect(item.locator('a, .cp-need button')).toHaveCount(0);
    for (const el of await page.locator('.cp-body .cp-title').all()) expect(await el.evaluate((e) => e.getBoundingClientRect().height < 48)).toBeTruthy();
    const link = page.getByRole('button', { name: /^All of .*'s work/ });
    await page.locator('.cp.side').evaluate((e) => { e.scrollTop = e.scrollHeight; });
    const all = await link.boundingBox();
    expect(all!.y + all!.height).toBeLessThanOrEqual(720);
    expect(all!.height).toBeLessThan(48);
    await page.screenshot({ path: `${SHOTS}/fold-1280x720.png` }).catch(() => {});
  });

  test('a decision row is its question (r20, Codex 7: its options are buttons in its sheet, never in the row)', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'ATLAS');
    await openCompanion(page);
    const item = page.locator('.cp-item').filter({ hasText: 'Decide the ATLAS hosting' });
    await expect(item.locator('.cp-title')).toHaveText('Decide the ATLAS hosting');
    expect(await item.locator('.cp-title').evaluate((e) => e.scrollHeight <= e.clientHeight + 1), 'a decision is never clipped').toBe(true);
    await expect(item.locator('.cp-opt')).toHaveCount(0);
    const answers = await sheetAnswers(page, item);
    await expect(answers.locator('.cp-opt')).toHaveText(['Self-host', 'Managed']);
    for (const b of await answers.locator('.cp-opt').all()) expect(await b.evaluate((e) => getComputedStyle(e).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
  });

  test('a decision without options has no Decide button; the row itself opens it. Running fits above the footer', async ({ page }) => {
    test.skip(!wide(page), 'side panel');
    await page.setViewportSize({ width: 1280, height: 720 });
    await boot(page);
    await scope(page).locator('.th-go[aria-label^="Uni,"]').click();
    await openCompanion(page);
    await expect(page.locator('.cp-body').getByRole('button', { name: 'Decide', exact: true })).toHaveCount(0);
    const dec = page.locator('.cp-item').filter({ hasText: 'Decide the COhere venue' }).locator('.cp-need.decision');
    if (await dec.count()) {
      await expect(dec.locator('.cp-go')).toBeVisible();
      expect(await dec.locator('.cp-title').evaluate((e) => e.scrollHeight <= e.clientHeight + 1)).toBe(true);
    }
    await openRoom(page, 'ATLAS');
    expect(await page.locator('.cp-run').count()).toBeLessThanOrEqual(2);
    const side = page.locator('.cp.side');
    await side.evaluate((e) => { e.scrollTop = e.scrollHeight; });
    const foot = (await page.locator('.cp-foot').boundingBox())!;
    for (const r of await page.locator('.cp-run, .cp-item').all()) { const b = (await r.boundingBox())!; expect(b.y + b.height).toBeLessThanOrEqual(foot.y + 20); }
  });

  test('the "All of X\'s work" link sticks to the panel bottom, wraps to at most two lines when the name is long', async ({ page }) => {
    test.skip(!wide(page), 'side panel');
    await page.setViewportSize({ width: 1280, height: 600 });
    await boot(page);
    await scope(page).locator('.th-go[aria-label^="Uni,"]').click();
    await openCompanion(page);
    const foot = page.locator('.cp-all');
    const side = (await page.locator('.cp.side').boundingBox())!;
    const box = (await foot.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(side.y + side.height + 1);
    expect(box.height).toBeLessThan(48);
    // (r28: rows are whole now, so a short panel may have a "+N more running" beside it: not what this is about)
    await page.addStyleTag({ content: '.cp-all-more { display: none !important; }' });
    await page.locator('.cp-all-t').evaluate((e) => { e.textContent = "All of A very long project name that cannot possibly fit on a single line's work"; });
    const after = (await foot.boundingBox())!;
    expect(after.height).toBeLessThan(80);
    expect(after.y + after.height).toBeLessThanOrEqual(side.y + side.height + 1);
    expect(await page.locator('.cp-all-arrow').isVisible()).toBe(true);
    const arrow = (await page.locator('.cp-all-arrow').boundingBox())!;
    expect(arrow.x + arrow.width).toBeLessThanOrEqual(side.x + side.width);
  });

  test('the quiet marks say what they are', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'ATLAS');
    if (wide(page)) {
      await expect(page.getByRole('button', { name: 'Hide where this stands' })).toHaveAttribute('title', 'Hide where this stands');
      await page.getByRole('button', { name: 'Hide where this stands' }).click();
      await expect(page.getByRole('button', { name: 'Show where this stands' })).toHaveAttribute('title', 'Show where this stands');
      await expect(page.locator('.cp-unfold .cp-dot')).toHaveAttribute('title', 'Needs you');
    } else await expect(page.locator('.cp-line .cp-dot')).toHaveAttribute('title', 'Needs you');
    if (wide(page)) await expect(scope(page).locator('.th-dot').first()).toHaveAttribute('title', 'Needs you');
  });

  test('a decision titled "Decision (default yes): …" shows only the ask; the opened item keeps the full title', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'ATLAS');
    await openCompanion(page);
    await expect(page.locator('.cp-body')).not.toContainText(/Decision \(/);
    await page.locator('.cp-item').filter({ hasText: 'Decide the ATLAS hosting' }).locator('.cp-need').click();
    await expect(taskDialog(page).or(page.locator('.sheet, .task-sheet')).first()).toContainText('Decision (default yes)');
  });

  test('teaching lists what is the user\'s own and (r17) what waits on them, whoever holds it; not what waits on someone else', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'Learn Vibe Build');
    await openCompanion(page);
    const needs = page.getByRole('region', { name: 'Needs you' });
    await expect(needs.locator('.cp-item')).toHaveCount(2);
    await expect(needs).toContainText('Your OK on the draft');
    // r18: the owning task is one line of small print, whole in its title (and the sheet)
    await expect(needs.locator('.cp-under[title*="Canvas Week 7 brief draft"]')).toHaveCount(1);
    await expect(needs).toContainText('Grade the Week 6 reflections');
    await expect(needs).not.toContainText('Final brief');
  });

  test('the "where this stands" row folds and unfolds the panel', async ({ page }) => {
    test.skip(!wide(page), 'side panel');
    await boot(page);
    await openRoom(page, 'ATLAS');
    await expect(page.locator('.cp.side.open')).toBeVisible();
    const w = (await page.locator('.cp.side').boundingBox())!.width;
    await page.getByRole('button', { name: 'Hide where this stands' }).click();
    await expect(page.locator('.cp.side.folded')).toBeVisible();
    expect((await page.locator('.cp.side').boundingBox())!.width).toBeLessThan(w - 150);
    await page.getByRole('button', { name: 'Show where this stands' }).click();
    await expect(page.locator('.cp.side.open')).toBeVisible();
  });

  test('a worker status ping is one muted line; a marker-only line mid-message is a chip', async ({ page }) => {
    await boot(page, { longChat: true, tallLast: true });
    await openRoom(page, 'Learn Vibe Build');
    const status = page.locator('.sr-chat .message.status-line');
    await expect(status).toHaveCount(1);
    await expect(status).toHaveAttribute('title', '⏳ Working — 6 min — iteration 7');
    expect((await status.boundingBox())!.height).toBeLessThan(32);
    // r14: the task-state marker is bookkeeping: taken out of the message and not shown as a chip
    await expect(page.locator('.sr-chat .md-mark')).toHaveCount(0);
    await expect(page.locator('.sr-chat').getByText('[done T-123]')).toHaveCount(0);
    await shot(page, 'midmessage');
  });

  test('the footer link keeps the long form at any width; detail lines wrap; a short summary stays whole when narrow', async ({ page }) => {
    test.skip(!wide(page), 'side panel');
    await boot(page);
    await scope(page).locator('.th-go[aria-label^="Uni,"]').click();
    await openCompanion(page);
    await expect(page.locator('.cp-all-t')).toContainText('All of');
    await page.setViewportSize({ width: 900, height: 700 });
    // r13: crossing under 1100px folds the panel (that width's own choice); opened again there, it stays open
    await expect(page.locator('.cp.side')).toHaveClass(/folded/);
    await page.getByRole('button', { name: 'Show where this stands' }).click();
    await page.evaluate(() => { document.querySelector('.cp.side')!.setAttribute('style', 'width:130px'); });
    await expect(page.locator('.cp-all-t')).toHaveText(/^All of .+'s work$/);
    // narrow, a short summary is still shown whole (r29: no clause cuts and no "More"; only a long one is behind "What it said")
    const lede = page.locator('.cp-stands').first();
    await expect(lede).toHaveText('Atlas and COhere are moving; the usage guard is quiet.');
    await expect(page.locator('.cp-stands-more')).toHaveCount(0);
    await expect(page.locator('.cp-stands-note .cp-said')).toHaveCount(0);
    await page.evaluate(() => { document.querySelector('.cp.side')!.removeAttribute('style'); });
    for (const d of await page.locator('.cp-detail').all()) expect(await d.evaluate((e) => getComputedStyle(e).whiteSpace)).not.toBe('nowrap');
  });

  test('a room never says "No messages" while its first fetch is pending; a confirmed empty room does', async ({ page }) => {
    await boot(page, { messagesDelay: 1200 });
    await openRoom(page, 'Learn Vibe Build');
    const none = page.locator('.sr-chat').getByText('No messages in this room yet.');
    await page.waitForTimeout(500);
    await expect(none).toHaveCount(0);
    await expect(none).toBeVisible({ timeout: 4000 });
    await openRoom(page, 'ATLAS');
    await page.waitForTimeout(500);
    await expect(none).toHaveCount(0);
    await expect(page.locator('.sr-chat .message')).toHaveCount(3, { timeout: 4000 });
    await expect(none).toHaveCount(0);
  });

  test('a room with nothing owed to the user says so, quietly', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'Atlas Institute');
    await openCompanion(page);
    await expect(page.locator('.cp-h', { hasText: 'Needs you' })).toHaveCount(1);
    await expect(page.locator('.cp-none')).toHaveText('Nothing needs you here.');
    await expect(page.locator('.cp-need')).toHaveCount(0);
  });

  test('r13: no fade over the conversation\'s first line (a hairline marks the edge), and the panel scrolls on its own', async ({ page }) => {
    test.skip(!wide(page), 'side panel');
    await boot(page);
    await openRoom(page, 'ATLAS');
    expect(await page.locator('.sr-chat .message-list').evaluate((e) => { const c = getComputedStyle(e); return (c.maskImage || (c as any).webkitMaskImage || 'none'); })).toBe('none');
    expect(await page.locator('.cp.side').evaluate((e) => getComputedStyle(e).overflowY)).toBe('auto');
  });

  test('the fold is remembered on this device', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'ATLAS');
    if (wide(page)) {
      await expect(page.locator('.cp.side')).toHaveClass(/open/);
      await page.getByRole('button', { name: 'Hide where this stands' }).click();
      await expect(page.locator('.cp.side')).toHaveClass(/folded/);
      const w = (await page.locator('.cp.side').boundingBox())!.width;
      expect(w).toBeLessThan(80);
      await page.reload();
      await openRoom(page, 'ATLAS');
      await expect(page.locator('.cp.side')).toHaveClass(/folded/);
      await page.getByRole('button', { name: 'Show where this stands' }).click();
      await expect(page.locator('.cp.side')).toHaveClass(/open/);
    } else {
      await expect(page.locator('.cp-line')).toHaveAttribute('aria-expanded', 'false');
      expect((await page.locator('.cp-line').boundingBox())!.height).toBeLessThan(60);
      await page.locator('.cp-line').click();
      await expect(page.locator('.cp-body')).toBeVisible();
      await shot(page, 'strip-open');
      // r16: a phone is a short viewport (under 900px wide): the strip starts folded whatever was chosen, so the conversation comes first
      await page.reload();
      await openRoom(page, 'ATLAS');
      await expect(page.locator('.cp-line')).toHaveAttribute('aria-expanded', 'false');
      expect(await page.evaluate(() => localStorage.getItem('uni.companion.strip.v1'))).toBe('1');
    }
  });

  test('nothing under a message; its ⋯ holds only Copy (and Edit and Delete on your own); no reactions are made from the app', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'ATLAS');
    const first = page.locator('.sr-chat .message').first();
    await expect(page.locator('.sr-chat .message-actions')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^(⤓ )?Keep|Ask Uni about|Reply in thread|React/ })).toHaveCount(0);
    // the ⋯ is on the message's edge and quiet (hidden until hover with a mouse)
    const more = first.getByRole('button', { name: /^More actions for/ });
    if (wide(page)) await expect(more).toHaveCSS('opacity', '0'); else expect(Number(await more.evaluate((e) => getComputedStyle(e).opacity))).toBeLessThan(0.6);
    await first.hover();
    await more.click();
    const menu = page.getByRole('group', { name: 'Message actions' });
    await expect(menu).toBeVisible();
    // Aaron's own message (the first one): Copy, Edit, Delete and nothing else; no menu roles that promise arrow keys
    await expect(menu.getByRole('button')).toHaveText(['Copy', 'Edit', /Delete/]);
    await expect(page.getByRole('menuitem')).toHaveCount(0);
    await shot(page, 'menu');
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    // someone else's message: Copy only
    const theirs = page.locator('.sr-chat .message').nth(1);
    await theirs.hover();
    await theirs.getByRole('button', { name: /^More actions for/ }).click();
    await expect(page.getByRole('group', { name: 'Message actions' }).getByRole('button')).toHaveText(['Copy']);
    await page.keyboard.press('Escape');
    // a right-click is the browser's own: no quick-reaction bar
    if (wide(page)) { await first.click({ button: 'right' }); await expect(page.locator('.quick-react')).toHaveCount(0); await page.keyboard.press('Escape'); }
    expect(await fits(page)).toBe(true);
  });

  test('r13: "All of X\'s work" shows what needs you, what is running, what is being drafted; "Back to chat" returns to the conversation', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'ATLAS');
    await openCompanion(page);
    await page.getByRole('button', { name: /^All of .*'s work/ }).click();
    const work = page.locator('.sr-work');
    await expect(work).toBeVisible();
    await expect(page.locator('.sr-title')).toHaveText('ATLAS');
    await expect(work.getByRole('region', { name: 'Needs you' })).toContainText('SOW for the commons grant');
    await expect(work.getByRole('list', { name: 'Running' })).toContainText('Draft the SOW');
    await expect(work.getByRole('region', { name: 'Drafts' })).toContainText('SOW commons grant');
    await expect(page.locator('.steer, .logstrip, .steer-log, .th-panel')).toHaveCount(0);
    expect(await fits(page)).toBe(true);
    await shot(page, 'everything');
    await page.getByRole('button', { name: 'Back to chat' }).click();
    await expect(page.locator('.sr-chat .message')).toHaveCount(3);
  });

  test('the task sheet\'s "Open in #room" returns to the conversation', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'Atlas'); // another room than the task's own
    await openCompanion(page);
    await page.getByRole('button', { name: /^All of .*'s work/ }).click();
    await page.locator('.sr-work .cp-need[data-id="T-07"]').click();
    await page.getByRole('button', { name: 'Open in #atlas/build' }).click();
    await expect(page.locator('.sr-chat .message')).toHaveCount(3);
    await expect(taskDialog(page)).toHaveCount(0);
  });

  test('typing in the composer posts once to this room\'s channel', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'ATLAS');
    await page.getByRole('textbox', { name: /^Message / }).fill('push T-07 to Thursday');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect.poll(async () => (await calls(page, 'post_message')).filter((a: any) => a.body).length).toBe(1);
    const post = (await calls(page, 'post_message')).find((a: any) => a.body);
    expect(post.channel).toBe(BUILD);
    expect(post.body).toBe('push T-07 to Thursday');
  });

  test('nested rooms still nest, and jumping to a child and back works', async ({ page }) => {
    await boot(page);
    await unfoldAll(page);
    const rows = scope(page).locator('.th-row');
    expect(await rows.evaluateAll((els) => els.map((e) => [e.querySelector('b')?.textContent, [...e.classList].find((c) => /^d\d$/.test(c))]))).toEqual(expect.arrayContaining([['Atlas', 'd1'], ['ATLAS', 'd2'], ['Learn Vibe Build', 'd2'], ['Techne', 'd1'], ['COhere 2026', 'd2']]));
    await openRoom(page, 'ATLAS');
    await expect(page.locator('.sr-chat').getByRole('textbox', { name: /^Message / })).toHaveAttribute('placeholder', 'Message #atlas/build');
    await openRoom(page, 'Learn Vibe Build');
    await expect(page.locator('.sr-door')).toHaveText('#atlas/teach');
    await expect(page.locator('.sr-chat').getByRole('textbox', { name: /^Message / })).toHaveAttribute('placeholder', 'Message #atlas/teach');
    // back: wide, the parent in the crumbs or the list; phone, the ‹ and the list
    await page.locator('.sr .th-crumb', { hasText: 'Atlas' }).click();
    await expect(page.locator('.sr-title')).toHaveText('Atlas');
    await openRoom(page, 'ATLAS');
    await expect(page.locator('.sr-title')).toHaveText('ATLAS');
  });

  test('a node held by an ancestor\'s room says so and writes to that room', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'Atlas Institute');
    // r15: the real room is the heading; the node is a quiet line under it, and the companion's state is labelled as the node's
    await expect(page.locator('.sr-title')).toHaveText('Atlas Institute'); // r20 (Codex 6)
    await expect(page.locator('.sr-context')).toHaveText('Chat in #atlas · no room of its own yet');
    await expect(page.locator('.sr-door')).toHaveCount(0);
    await expect(page.locator('.sr-chat').getByRole('textbox', { name: /^Message / })).toHaveAttribute('placeholder', 'Message #atlas');
  });

  test('the rooms list is quiet: names, rooms in small type, one dot for "needs you", no counters', async ({ page }) => {
    await boot(page);
    await expect(scope(page).locator('.th-tag, .th-open, .th-stump, .th-door')).toHaveCount(0);
    await expect(scope(page).locator('.th-dot').first()).toBeVisible();
    // folded, an area still shows the dot for what is under it
    await expect(scope(page).locator('.th-go[aria-label^="Atlas,"] .th-dot')).toHaveCount(1);
    await unfoldAll(page);
    await expect(scope(page).locator('.th-go[aria-label^="ATLAS,"] .th-sub')).toHaveText('#atlas/build');
    await expect(scope(page).locator('.th-go[aria-label^="Atlas Institute,"] .th-sub')).toHaveCount(0);
    await expect(scope(page)).not.toContainText('held by');
    // a dot only where the room's OWN node has something that needs you: ATLAS holds T-07, its parent Atlas holds nothing itself
    await expect(scope(page).locator('.th-go[aria-label^="ATLAS,"] .th-dot')).toHaveCount(1);
    await expect(scope(page).locator('.th-go[aria-label^="Atlas,"] .th-dot')).toHaveCount(0);
    await expect(scope(page).locator('.th-go[aria-label^="Techne,"] .th-dot')).toHaveCount(1);
    await expect(scope(page).locator('.th-summary, .th-cap')).toHaveCount(0);
    await shot(page, 'rooms');
  });

  test('journal (0.1.46): an entry not in the vault yet says "Waiting to send" with its time; the same words again ask "Save another / Keep one" and keep the text; Keep one saves nothing; a new entry is filed under Journal/', async ({ page }) => {
    await boot(page);
    const words = 'A placeholder entry about the garden and the rain';
    await page.evaluate((words) => {
      const w = window as any;
      w.__queue = [{ entry_id: 'q1', path: 'Journal/2026/10-14/19-43 A placeholder entry about the garden', content: words, source: 'text', created_at: '2026-10-15T01:43:10.000Z', has_audio: false, note_id: null, attempts: 1, last_error: null }];
      w.__flushReport = { sent: [], remaining: 1, error: null };
    }, words);
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Journal' }).click();
    const queued = page.locator('.journal-entry.queued');
    await expect(queued).toHaveCount(1);
    await expect(queued.locator('.queued-tag')).toHaveText('Waiting to send');
    await expect(queued.locator('.journal-meta')).toContainText(/\d{1,2}:43/);
    // typed again while it waits: nothing is saved yet; the app names the entry and asks
    await page.evaluate(() => { (window as any).__saveReport = { sent: [], remaining: 1, error: null, duplicate: { kind: 'waiting', id: 'q1', created_at: '2026-10-15T01:43:10.000Z' } }; });
    const box = page.getByRole('textbox', { name: 'Journal entry', exact: true });
    await box.fill(words);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.journal-status')).toHaveText(/^Same words as your \d{1,2}:43(\s?[AP]M)? entry$/);
    const ask = page.getByRole('group', { name: 'Same words as another entry' });
    await expect(ask.getByRole('button')).toHaveText(['Save another', 'Keep one']);
    await expect(box).toHaveValue(words);
    await expect(queued).toHaveCount(1);
    await expect(queued).toHaveAttribute('data-again', 'true');
    // the draft the app handed over is filed where the sweep files it, with its clash paths (seconds, then more words), and is its own send
    const draft = await page.evaluate(() => (window as any).__calls.filter((c: any) => c.cmd === 'journal_save_text').at(-1).args.entry);
    expect(draft.path).toMatch(/^Journal\/\d{4}\/\d\d-\d\d\/\d\d-\d\d A placeholder entry about the garden and$/);
    expect(draft.alternates[0]).toMatch(/^Journal\/\d{4}\/\d\d-\d\d\/\d\d-\d\d-\d\d A placeholder entry about the garden and$/);
    expect(draft.submission_id).toMatch(/^[0-9a-f-]{36}$/);
    // Keep one: the composer clears and nothing more is saved
    await ask.getByRole('button', { name: 'Keep one' }).click();
    await expect(box).toHaveValue('');
    await expect(ask).toHaveCount(0);
    await expect(page.locator('.journal-status')).toHaveText('Kept one · waiting to send');
    expect(await calls(page, 'journal_save_text')).toHaveLength(1);
    // editing the words drops the question: they are other words now
    await page.evaluate(() => { (window as any).__saveReport = { sent: [], remaining: 1, error: null, duplicate: { kind: 'waiting', id: 'q1', created_at: '2026-10-15T01:43:10.000Z' } }; });
    await box.fill(words);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(ask).toBeVisible();
    await box.fill(words + ' again');
    await expect(ask).toHaveCount(0);
  });

  test('journal (0.1.46 fix): same words as an entry already saved: "Save another" saves the same send a second time; a failed save retried keeps its ids', async ({ page }) => {
    await boot(page);
    const words = 'Placeholder check-in: tea, then a walk';
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Journal' }).click();
    const box = page.getByRole('textbox', { name: 'Journal entry', exact: true });
    const saves = () => calls(page, 'journal_save_text');
    // a save that never answered: the text stays, and Save again is the same send (same ids), so the outbox sees a retry
    await page.evaluate(() => { (window as any).__saveFails = 1; });
    await box.fill(words);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.journal-status')).toHaveText('Not saved · your text is still here');
    await expect(box).toHaveValue(words);
    // the retry meets the words already sent in the last ten minutes
    await page.evaluate(() => { (window as any).__saveReport = { sent: [], remaining: 0, error: null, duplicate: { kind: 'saved', id: 'n1', created_at: '2026-10-15T01:43:10.000Z' } }; });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const ask = page.getByRole('group', { name: 'Same words as another entry' });
    await expect(ask).toBeVisible();
    await expect(page.locator('.journal-status')).toHaveText(/^Same words as your \d{1,2}:43(\s?[AP]M)? entry$/);
    await expect(box).toHaveValue(words);
    let s = await saves();
    expect(s).toHaveLength(2);
    expect(s[1].entry.entry_id).toBe(s[0].entry.entry_id);
    expect(s[1].entry.submission_id).toBe(s[0].entry.submission_id);
    expect(s.map((a: any) => !!a.saveAnother)).toEqual([false, false]);
    // Save another: the same send once more, now allowed; the composer clears
    await page.evaluate(() => { (window as any).__saveReport = { sent: ['n2'], remaining: 0, error: null }; });
    await ask.getByRole('button', { name: 'Save another' }).click();
    await expect(box).toHaveValue('');
    await expect(ask).toHaveCount(0);
    s = await saves();
    expect(s).toHaveLength(3);
    expect(s[2].saveAnother).toBe(true);
    expect(s[2].entry.submission_id).toBe(s[0].entry.submission_id);
    expect(s[2].entry.content).toBe(words);
    // the next words are a new send
    await box.fill('Other placeholder words');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(box).toHaveValue('');
    s = await saves();
    expect(s[3].entry.submission_id).not.toBe(s[0].entry.submission_id);
    expect(s[3].entry.entry_id).not.toBe(s[0].entry.entry_id);
  });

  test('journal (0.1.46 fix 2): words typed while a save is out stay in the composer and in local storage; a late "same words" question for the earlier words never deletes them', async ({ page }) => {
    await boot(page);
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Journal' }).click();
    const box = page.getByRole('textbox', { name: 'Journal entry', exact: true });
    const hold = () => page.evaluate(() => { const w = window as any; w.__saveGate = new Promise((r) => { w.__saveGo = () => { w.__saveGate = null; r(null); }; }); });
    const release = () => page.evaluate(() => (window as any).__saveGo());
    const stored = () => page.evaluate(() => localStorage.getItem('uni.journal.draft'));
    const A = 'Placeholder words A: bread and a long walk';
    const B = 'Placeholder words B: typed while A was saving';
    // saved: A goes, B typed meanwhile stays
    await hold();
    await box.fill(A);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Saving…' })).toBeVisible();
    await box.fill(B);
    await release();
    await expect(page.getByRole('button', { name: 'Saving…' })).toHaveCount(0);
    await expect(box).toHaveValue(B);
    expect(await stored()).toBe(B);
    await box.fill(A);
    await page.evaluate(() => { (window as any).__saveReport = { sent: [], remaining: 0, error: null, duplicate: { kind: 'saved', id: 'n1', created_at: '2026-10-15T01:43:10.000Z' } }; });
    // late duplicate: A is saved again, the answer says "same words", but B replaced A before it came back
    await hold();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Saving…' })).toBeVisible();
    await box.fill(B);
    await release();
    await expect(page.getByRole('button', { name: 'Saving…' })).toHaveCount(0);
    await expect(page.getByRole('group', { name: 'Same words as another entry' })).toHaveCount(0);
    await expect(box).toHaveValue(B);
    expect(await stored()).toBe(B);
    // the question raised for B itself, then Keep one, removes B only
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const ask = page.getByRole('group', { name: 'Same words as another entry' });
    await expect(ask).toBeVisible();
    await ask.getByRole('button', { name: 'Keep one' }).click();
    await expect(box).toHaveValue('');
    expect(await stored()).toBeNull();
  });

  test('one look: the journal, settings and a room read as the same app; Settings has no layout picker (shots, light and dark)', async ({ page }) => {
    await boot(page);
    const rail = page.getByRole('navigation', { name: 'Main navigation' });
    await rail.getByRole('button', { name: 'Journal' }).click();
    await expect(page.locator('.journal-tab-content')).toBeVisible();
    await shot(page, 'journal');
    await rail.getByRole('button', { name: 'Settings' }).click();
    await expect(page.locator('.settings')).toBeVisible();
    // r12: one layout. No Home layout picker, no Map, Octopus or Classic anywhere
    await expect(page.locator('.settings')).not.toContainText(/Home layout|Octopus|Classic|Map \(/);
    await expect(page.getByRole('radio')).toHaveCount(0);
    await shot(page, 'settings');
    if (await page.locator('.panel-close').count()) await page.locator('.panel-close').first().click();
    await rail.getByRole('button', { name: 'Uni', exact: true }).click();
    await openRoom(page, 'ATLAS');
    await expect(page.locator('.sr-door')).toHaveText('#atlas/build');
    await expect(page.locator('.message').first()).toBeVisible();
    await shot(page, 'plain-room');
    expect(await fits(page)).toBe(true);
  });

  test('chat off (profile chat.provider null): the full node page, no composer, no room', async ({ page }) => {
    await boot(page, { profileNote: { chat: { provider: null } } });
    await unfoldAll(page);
    await scope(page).locator('.th-go[aria-label^="ATLAS"]').click();
    // r13: the room's view is its work view (there is no chat to go back to)
    await expect(page.locator('.sr-work').getByRole('region', { name: 'Needs you' }).locator('.cp-need[data-id="T-07"]')).toBeVisible();
    await expect(page.locator('.sr-chat, .cp, .composer, .th-door, .th-ctx, .talk, .sr-door')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Back to chat' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Open #|Hold to talk/ })).toHaveCount(0);
    expect(await fits(page)).toBe(true);
    await shot(page, 'chat-off');
  });

  test('the side panel is narrow (about 270px) and the conversation gets the space', async ({ page }) => {
    test.skip(!wide(page), 'side panel is a desktop surface');
    await boot(page);
    await openRoom(page, 'ATLAS');
    const side = (await page.locator('.cp.side').boundingBox())!;
    expect(side.width).toBeGreaterThanOrEqual(250);
    expect(side.width).toBeLessThanOrEqual(290);
    const chat = (await page.locator('.sr').boundingBox())!;
    expect(chat.width).toBeGreaterThan(side.width * 2);
    expect(await fits(page)).toBe(true);
  });

  test('below 1100px wide the panel starts folded, and what the user chooses is remembered', async ({ page }) => {
    test.skip(!wide(page), 'side panel is a desktop surface');
    await page.setViewportSize({ width: 1000, height: 800 });
    await boot(page);
    await openRoom(page, 'ATLAS');
    await expect(page.locator('.cp.side')).toHaveClass(/folded/);
    await page.getByRole('button', { name: 'Show where this stands' }).click();
    await expect(page.locator('.cp.side')).toHaveClass(/open/);
    await page.reload();
    await openRoom(page, 'ATLAS');
    await expect(page.locator('.cp.side')).toHaveClass(/open/);
    // r13: each width keeps its own choice; a panel folded on the wide window stays folded there, and crossing 1100px takes that width's choice
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator('.cp.side')).toHaveClass(/open/);
    await page.getByRole('button', { name: 'Hide where this stands' }).click();
    await page.setViewportSize({ width: 1000, height: 800 });
    await expect(page.locator('.cp.side')).toHaveClass(/open/);
    await page.getByRole('button', { name: 'Hide where this stands' }).click();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('button', { name: 'Show where this stands' }).click();
    await page.setViewportSize({ width: 1000, height: 800 });
    await expect(page.locator('.cp.side')).toHaveClass(/folded/);
  });

  test('r13: a panel open on a wide window folds when the window narrows under 1100px', async ({ page }) => {
    test.skip(!wide(page), 'side panel is a desktop surface');
    await boot(page);
    await openRoom(page, 'ATLAS');
    await expect(page.locator('.cp.side')).toHaveClass(/open/);
    await page.setViewportSize({ width: 1050, height: 800 });
    await expect(page.locator('.cp.side')).toHaveClass(/folded/);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator('.cp.side')).toHaveClass(/open/);
  });

  test('For you has no number, at most a quiet dot', async ({ page }) => {
    await boot(page);
    await expect(page.locator('.rail-count')).toHaveCount(0);
  });

  test('rooms open at the latest message, on open and on switching, and stay there while late layout lands', async ({ page }) => {
    await boot(page, { longChat: true });
    const atEnd = () => page.locator('.sr-chat .message-list').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
    await openRoom(page, 'ATLAS');
    await expect(page.locator('.sr-chat')).toContainText('The newest line of this room.');
    await expect.poll(atEnd).toBeLessThan(6);
    // late layout (an image, older rows) grows the list above the reader: still at the end
    await page.locator('.sr-chat .message-list').evaluate((el) => { const pad = document.createElement('div'); pad.style.height = '900px'; pad.dataset.late = '1'; el.firstElementChild?.prepend(pad); });
    await expect.poll(atEnd).toBeLessThan(6);
    await openRoom(page, 'Learn Vibe Build');
    await expect(page.locator('.sr-chat')).toContainText('The newest line of this room.');
    await expect.poll(atEnd).toBeLessThan(6);
    await page.waitForTimeout(1700);
    expect(await atEnd()).toBeLessThan(6);
    // and back to the first room: its newest message again, not where it was left
    await page.locator('.sr-chat .message-list').evaluate((el) => { el.scrollTop = 0; });
    await openRoom(page, 'ATLAS');
    await expect.poll(atEnd).toBeLessThan(6);
  });

  test('r12: no rooms drawer: the rail has no Rooms, the tree is the only list of rooms; sync and sign-in status live in Settings', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await boot(page);
    const rail = page.getByRole('navigation', { name: 'Main navigation' });
    await expect(rail.getByRole('button', { name: 'Rooms' })).toHaveCount(0);
    // every place the rail offers, on a phone too (Vault and Search are on the rail now that Rooms is gone)
    for (const n of ['Uni', 'Journal', 'Vault', 'Search', 'Settings']) await expect(rail.getByRole('button', { name: n, exact: true })).toBeVisible();
    await expect(page.locator('aside.rooms .room-text small')).toHaveCount(0); // no avatar list with previews
    await expect(page.locator('section.conversation')).toHaveCSS('animation-name', 'none');
    await rail.getByRole('button', { name: 'Settings' }).click();
    await expect(page.locator('.settings .connection')).toBeVisible();
    await expect(page.locator('.settings .identity')).toBeVisible();
  });

  test('back from a child goes to its parent with no sliding drawer over the conversation', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await boot(page);
    await openRoom(page, 'Learn Vibe Build');
    await page.locator('.sr .th-crumb', { hasText: 'Atlas' }).click();
    await expect(page.locator('.sr-title')).toHaveText('Atlas');
    await expect(page.locator('aside.rooms')).toBeHidden();
    await expect(page.locator('.sr-head, .th-phone-tree').first()).toBeVisible();
    await expect(page.locator('.sr-head, .th-phone-tree').first()).toHaveCSS('animation-name', 'none');
  });

  // ---------------------------------------------------------------------------------------------- r7: one model, one navigation

  test('r7: no tab strip anywhere; the tree is the navigation', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'ATLAS');
    await expect(page.locator('.tab-strip, .tab-chip, [role="tablist"], .tab-add')).toHaveCount(0);
    await expect(page.getByRole('tab')).toHaveCount(0);
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Journal' }).click();
    await expect(page.locator('.tab-strip, .tab-chip, [role="tablist"]')).toHaveCount(0);
  });

  test('r7: a room reads the same from the tree and from Recent (one view per room)', async ({ page }) => {
    test.skip(!wide(page), 'sidebar column');
    await boot(page);
    const view = async () => ({ title: await page.locator('.sr-title').textContent(), door: await page.locator('.sr-door').textContent(), crumbs: await page.locator('.sr .th-crumbs').textContent(),
      placeholder: await page.locator('.sr-chat').getByRole('textbox', { name: /^Message / }).getAttribute('placeholder'), companion: await page.locator('.cp.side').count(), conversation: await page.locator('.conversation-header').count() });
    await openRoom(page, 'ATLAS');
    const fromTree = await view();
    await openRoom(page, 'Learn Vibe Build');
    await page.locator('.th-roomnav').getByRole('region', { name: 'Recent' }).getByRole('button', { name: /^ATLAS/ }).click();
    await expect(page.locator('.sr-title')).toHaveText('ATLAS');
    expect(await view()).toEqual(fromTree);
    expect(fromTree.conversation).toBe(0);
    expect(fromTree.companion).toBe(1);
    // the sidebar followed: the open room is the selected row
    await expect(scope(page).locator('.th-row.sel .th-go')).toHaveAttribute('aria-label', /^ATLAS,/);
  });

  test('r7: a room line is the room\'s real name; no constructed slash path in the DOM', async ({ page }) => {
    await boot(page, { multiRoom: true });
    await unfoldAll(page);
    await expect(page.locator('body')).not.toContainText('boulder/cohere');
    await expect(scope(page).locator('.th-go[aria-label^="COhere"] .th-sub').first()).toHaveText('#Cohere'); // r13: the channel's own name, as it is
    await expect(scope(page).locator('.th-go[aria-label^="ATLAS,"] .th-sub')).toHaveText('#atlas/build');
    await scope(page).locator('.th-go[aria-label^="COhere"]').first().click();
    await expect(page.locator('.sr-door')).toHaveText('#Cohere');
    await expect(page.locator('.sr-chat').getByRole('textbox', { name: /^Message / })).toHaveAttribute('placeholder', 'Message #Cohere');
    await expect(page.locator('body')).not.toContainText('boulder/cohere');
    if (wide(page)) await expect(page.locator('.sr .th-crumbs')).toHaveText(/Uni\s*›\s*Techne\s*›\s*COhere/);
  });

  test('r7: areas fold with a chevron; the choice is remembered; the name opens the room, the chevron only folds; a folded area keeps its dot', async ({ page }) => {
    test.skip(!wide(page), 'sidebar column');
    await boot(page);
    const nav = scope(page);
    // default: folded, except the area holding the open room (Uni is open: no area holds it)
    await expect(nav.locator('.th-row.d2')).toHaveCount(0);
    await expect(nav.locator('.th-fold[aria-expanded="false"]').first()).toBeVisible();
    // a folded area shows the dot for what is under it
    await expect(nav.locator('.th-go[aria-label^="Atlas,"] .th-dot')).toHaveCount(1);
    await nav.locator('.th-fold[data-path="Areas/Atlas"]').click();
    await expect(nav.locator('.th-go[aria-label^="ATLAS,"]')).toBeVisible();
    await expect(page.locator('.sr-title')).toHaveText('Uni'); // the chevron did not open the room
    await expect(nav.locator('.th-go[aria-label^="Atlas,"] .th-dot')).toHaveCount(0);
    await nav.locator('.th-go[aria-label^="Atlas,"]').click(); // the name opens it
    await expect(page.locator('.sr-title')).toHaveText('Atlas');
    // remembered per device
    await page.reload();
    await expect(page.locator('.sr-title')).toHaveText('Atlas');
    await expect(nav.locator('.th-go[aria-label^="ATLAS,"]')).toBeVisible();
    await nav.locator('.th-fold[data-path="Areas/Atlas"]').click();
    await expect(nav.locator('.th-go[aria-label^="ATLAS,"]')).toHaveCount(0);
    await page.reload();
    await expect(page.locator('.th-row .th-go').first()).toBeVisible();
    await expect(nav.locator('.th-go[aria-label^="ATLAS,"]')).toHaveCount(0);
    // another area, opened from elsewhere, is revealed
    await nav.locator('.th-go[aria-label^="Techne,"]').click();
    await expect(page.locator('.sr-title')).toHaveText('Techne');
  });

  test('r7: the sidebar is narrow, resizes by dragging (180 to 360, remembered) and hides', async ({ page }) => {
    test.skip(!wide(page), 'sidebar column');
    await boot(page);
    const nav = page.locator('.th-roomnav');
    const width = async () => { const b = await nav.boundingBox(); return b ? Math.round(b.width) : -1; };
    await expect(nav).toBeVisible();
    await expect.poll(width).toBeGreaterThan(0);
    expect(await width()).toBeLessThanOrEqual(222);
    expect(await width()).toBeGreaterThanOrEqual(218);
    await expect(nav.locator('.th-colname')).toHaveCount(0); // no big "Rooms" heading
    const handle = nav.getByRole('separator', { name: 'Resize the sidebar' });
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 200);
    await page.mouse.down(); await page.mouse.move(box.x + 500, box.y + 200, { steps: 4 }); await page.mouse.up();
    expect(await width()).toBe(360); // clamped at the max
    const b2 = (await handle.boundingBox())!;
    await page.mouse.move(b2.x + b2.width / 2, b2.y + 200);
    await page.mouse.down(); await page.mouse.move(b2.x - 500, b2.y + 200, { steps: 4 }); await page.mouse.up();
    expect(await width()).toBe(180); // and at the min
    await handle.focus(); await page.keyboard.press('ArrowRight');
    expect(await width()).toBe(196);
    await page.reload();
    await expect(page.locator('.th-roomnav')).toBeVisible();
    // the room shell remounts once just after the first paint (as in r13): read the width once it has settled
    await expect.poll(width).toBe(196);
    // hide down to a strip, and bring it back
    await nav.getByRole('button', { name: 'Hide the sidebar' }).click();
    expect(await width()).toBeLessThanOrEqual(40);
    await expect(nav.locator('.th-go')).toHaveCount(0);
    await page.reload();
    await expect(page.locator('.th-roomnav')).toBeVisible();
    await expect.poll(async () => { const w = await width(); return w > 0 && w <= 40; }).toBe(true);
    await page.locator('.th-roomnav').getByRole('button', { name: 'Show the sidebar' }).click();
    expect(await width()).toBe(196);
    // about 20 rows fit at 720px once every area is open
    await page.setViewportSize({ width: 1280, height: 720 });
    await unfoldAll(page);
    const rows = await nav.locator('.th-row').count();
    const fit = await nav.locator('.th-rows-wrap').evaluate((e) => e.scrollHeight <= e.clientHeight + 1 ? e.querySelectorAll('.th-row').length : Math.floor(e.clientHeight / (e.scrollHeight / e.querySelectorAll('.th-row').length)));
    expect(Math.min(rows, fit)).toBeGreaterThanOrEqual(Math.min(rows, 18));
  });

  test('r7: Back and Forward over the places visited (Alt+←/→ and the two buttons), with a short Recent list', async ({ page }) => {
    test.skip(!wide(page), 'sidebar column');
    await boot(page);
    await openRoom(page, 'ATLAS');
    await openRoom(page, 'Learn Vibe Build');
    const nav = page.locator('.th-roomnav');
    await expect(nav.getByRole('button', { name: 'Forward' })).toBeDisabled();
    await nav.getByRole('button', { name: 'Back' }).click();
    await expect(page.locator('.sr-title')).toHaveText('ATLAS');
    await page.keyboard.press('Alt+ArrowRight');
    await expect(page.locator('.sr-title')).toHaveText('Learn Vibe Build');
    await page.keyboard.press('Alt+ArrowLeft');
    await page.keyboard.press('Alt+ArrowLeft');
    await expect(page.locator('.sr-title')).toHaveText('Uni');
    await expect(nav.getByRole('button', { name: 'Back' })).toBeDisabled();
    await expect(nav.getByRole('button', { name: 'Forward' })).toBeEnabled();
    const recent = nav.getByRole('region', { name: 'Recent' });
    await expect(recent.locator('button')).toHaveText(['Learn Vibe Build', 'ATLAS']);
    await recent.getByRole('button', { name: 'ATLAS' }).click();
    await expect(page.locator('.sr-title')).toHaveText('ATLAS');
  });

  test('r7: the app reopens to the room you were in; an old uni.tabs.v1 set is ignored beyond its active room', async ({ page }) => {
    test.skip(!wide(page), 'sidebar column');
    await boot(page);
    await openRoom(page, 'ATLAS');
    await page.reload();
    await expect(page.locator('.sr-title')).toHaveText('ATLAS');
    expect(await page.evaluate(() => localStorage.getItem('uni.tabs.v2'))).toContain('Projects/ATLAS');
    await page.evaluate(() => { localStorage.removeItem('uni.tabs.v2'); localStorage.setItem('uni.tabs.v1', JSON.stringify({ v: 1, tabs: [{ id: 'a', kind: 'area', path: 'Areas/Techne', title: 'Techne' }, { id: 'b', kind: 'areas', title: 'Uni' }, { id: 'c', kind: 'journal', title: 'Journal' }], active: 'a', recent: ['b', 'a'] })); });
    await page.reload();
    await expect(page.locator('.sr-title')).toHaveText('Techne');
    await expect(page.locator('.tab-strip')).toHaveCount(0);
  });

  test('r7: needs you is the feed: Aaron\'s own, Now and Soon, not snoozed, plus decisions; someday and done are not there', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'Techne');
    await openCompanion(page);
    const needs = page.getByRole('region', { name: 'Needs you' });
    await expect(needs).toContainText('COhere festival readiness'); // waiting on aaron, now
    await expect(needs).toContainText('Casey call: book it'); // now
    await expect(needs).not.toContainText('Already finished'); // done
    await expect(needs).not.toContainText('Put away'); // archived
    await expect(needs).not.toContainText('A snoozed one'); // snoozed
    await expect(needs).not.toContainText('Wire the usage guard'); // Uni's, not Aaron's
    if (await page.locator('.cp-more-rows').count()) await page.locator('.cp-more-rows').click(); // a small window keeps the later rows behind "+N more"
    // Now before Soon
    const order = await needs.locator('.cp-need').evaluateAll((els) => els.map((e) => e.textContent ?? ''));
    expect(order.findIndex((t) => t.includes('COhere festival readiness'))).toBeLessThan(order.findIndex((t) => t.includes('Sponsorship invoice draft')));
    // r14: a next step that names an action leads the row; the title is the quiet line under it
    const invoice = needs.locator('.cp-item').filter({ hasText: 'Sponsorship invoice draft' });
    await expect(invoice.locator('.cp-lead')).toHaveText('Send to Casey for the numbers');
    // r22: the quiet line also says when it was asked (the title may give way to it in a narrow panel; it is whole in the tooltip)
    await expect(invoice.locator('.cp-under')).toHaveAttribute('title', /^Sponsorship invoice draft · (?:asked|added) \w+ \d+$/);
    // Someday is never in Needs you, in any room
    await openRoom(page, 'Unforced Development');
    await openCompanion(page);
    await expect(needs).not.toContainText('Send the Q4 invoice');
    await expect(needs).toContainText('Nothing needs you here.');
  });

  test('r7: a long next step is clamped within its row; the row opens its sheet with all of it (r19: in the work view as in the companion, never More in place)', async ({ page }) => {
    test.skip(!wide(page), 'side panel');
    await boot(page, { longNext: true });
    await scope(page).locator('.th-go[aria-label^="Uni,"]').click();
    await openCompanion(page);
    await expect(page.locator('.cp-body .cp-row-more, .cp-body .cp-item .cp-more-next')).toHaveCount(0);
    await openWorkView(page); await narrowWork(page);
    const item = page.locator('.sr-work .cp-item').filter({ hasText: 'COhere festival readiness' });
    // r30: the row is the whole step, every word (it wraps; it is never clamped, cut or opened in place)
    await expect(item.locator('.cp-lead')).toContainText('where do they stand?');
    await expect(item.locator('.cp-lead')).not.toHaveAttribute('data-cut', 'true');
    await expect(item.getByRole('button', { name: /^(More|Less)$/ })).toHaveCount(0);
    await item.locator('.cp-need').click();
    // r30: the heading is the same whole step
    await expect(page.locator('.task-sheet h2')).toContainText('third question');
    await expect(page.locator('.task-sheet h2')).toContainText('where do they stand?');
  });

  test('r7: opening a task without a title worth reading or a next step says to open it', async ({ page }) => {
    test.skip(!wide(page), 'side panel');
    await boot(page, { bareTask: true });
    await scope(page).locator('.th-go[aria-label^="Uni,"]').click();
    await openCompanion(page);
    const item = page.locator('.cp-item').filter({ hasText: 'Taxes' });
    await expect(item.locator('.cp-open-to-see')).toHaveText("Open to see what's needed");
  });

  test('r8: a room opened by Back, Forward or Recent shows its messages, not a blank chat', async ({ page }) => {
    test.skip(!wide(page), 'sidebar column');
    await boot(page, { longChat: true });
    await openRoom(page, 'ATLAS');
    await expect(page.locator('.sr-chat .message').first()).toBeVisible();
    await openRoom(page, 'Learn Vibe Build');
    await expect(page.locator('.sr-chat .message').first()).toBeVisible();
    const nav = page.locator('.th-roomnav');
    await nav.getByRole('button', { name: 'Back' }).click();
    await expect(page.locator('.sr-title')).toHaveText('ATLAS');
    await expect(page.locator('.sr-chat .message').first()).toBeVisible();
    await nav.getByRole('button', { name: 'Forward' }).click();
    await expect(page.locator('.sr-title')).toHaveText('Learn Vibe Build');
    await expect(page.locator('.sr-chat .message').first()).toBeVisible();
    await nav.getByRole('region', { name: 'Recent' }).getByRole('button', { name: 'ATLAS' }).click();
    await expect(page.locator('.sr-title')).toHaveText('ATLAS');
    await expect(page.locator('.sr-chat .message').first()).toBeVisible();
    await expect(page.locator('.sr-chat [aria-label="Loading messages"]')).toHaveCount(0);
  });

  test('r8: Uni opens as its chat room even when the rooms list arrives late; Recent never lists the current place or one twice', async ({ page }) => {
    test.skip(!wide(page), 'sidebar column');
    await boot(page, { roomsDelay: 1500 });
    await scope(page).locator('.th-go[aria-label^="Uni"]').first().click();
    // no dashboard while the rooms load: the room, then its conversation and the companion
    await expect(page.locator('.sr-title')).toHaveText('Uni');
    await expect(page.locator('[data-view="room"]')).toBeVisible();
    await expect(page.getByText('no room', { exact: true })).toHaveCount(0);
    await expect(page.locator('.sr-door')).toHaveText('#Uni', { timeout: 8000 });
    await expect(page.locator('.sr-chat textarea')).toBeVisible();
    await expect(page.locator('.sr-chat-wait')).toHaveCount(0);
    await expect(companion(page)).toBeVisible();
    const recent = page.locator('.th-roomnav').getByRole('region', { name: 'Recent' });
    const names = await recent.locator('button').allTextContents();
    expect(new Set(names).size).toBe(names.length);
    expect(names).not.toContain('Uni');
  });

  test('r8: a decision whose title was cut short shows the full question from its note', async ({ page }) => {
    test.skip(!wide(page), 'side panel');
    await boot(page, { cutDecision: true });
    await scope(page).locator('.th-go[aria-label^="Uni,"]').click();
    await openCompanion(page);
    const item = page.locator('.cp-item').filter({ hasText: 'after-event' });
    // r18: in the companion a long "Your call" is cut on a whole word; its sheet has the whole question from the note
    await expect(item.locator('.cp-title')).toContainText('Should Uni add the after-event "were you there?"');
    await expect(item.locator('.cp-title')).not.toContainText('Decision (default yes)');
    await expect(item.locator('.cp-title')).not.toContainText('Converted from');
    await item.locator('.cp-need').click();
    await expect(page.locator('.task-sheet h2')).toHaveText('Should Uni add the after-event "were you there?" prompt to the companion on Wed? Say no to skip it.');
  });

  test('r9: cached messages and rooms paint, with the composer, before the first fetch answers', async ({ page }) => {
    test.skip(!wide(page), 'sidebar column');
    const who = 'a'.repeat(64);
    await page.addInitScript(([who]) => {
      localStorage.setItem('uni.cache.who.v1', who);
      localStorage.setItem(`uni.cache.rooms.v1:${who}`, JSON.stringify([{ id: 'uni-room', name: 'Uni', last_message: 'hi', last_ts: 1, mentions: false, unread: 0 }]));
      localStorage.setItem(`uni.cache.msgs.v1:${who}:uni-room`, JSON.stringify([{ ref: 'c1', channel: 'uni-room', author: 'bbbb', author_name: 'Uni', ts: 1760000000, body: 'Cached hello from last time', mentions_me: false, root: null, parent: null, mentions: [], reply_count: 0, last_reply_ts: null, edited: false, reactions: [] }]));
    }, [who]);
    await boot(page, { roomsDelay: 8000, messagesDelay: 8000 });
    // nothing has answered yet (8 s): the conversation is already there, and the composer is live
    await expect(page.locator('.sr-chat')).toContainText('Cached hello from last time', { timeout: 3000 });
    await expect(page.locator('.sr-chat textarea')).toBeEnabled();
    expect(await page.evaluate(() => (window as any).__roomsResolved ?? false)).toBe(false);
    await expect(page.locator('.sr-chat-wait')).toHaveCount(0);
  });

  test('r9/r18: a decision without options is "Your call", answered in words in its sheet through the CAS path; never buttons built from its wording', async ({ page }) => {
    test.skip(!wide(page), 'side panel');
    await boot(page, { cutDecision: true });
    await scope(page).locator('.th-go[aria-label^="Uni,"]').click();
    await openCompanion(page);
    const item = page.locator('.cp-item').filter({ hasText: 'after-event' });
    await expect(item.getByText('Your call')).toBeVisible();
    await expect(item.locator('.cp-opt')).toHaveCount(0);
    await item.locator('.cp-need').click();
    const sheet = page.locator('.task-sheet');
    await expect(sheet.getByRole('button', { name: /^(Go ahead|Skip it|Yes|No|Agree|Disagree)$/ })).toHaveCount(0);
    await sheet.getByLabel('Answer in your words').fill('Go ahead on Wednesday');
    await sheet.getByRole('button', { name: 'Answer', exact: true }).click();
    await expect.poll(async () => (await calls(page, 'vault_decide')).length).toBe(1);
    const [call] = await calls(page, 'vault_decide');
    expect(call.metadata.decided).toBe('Go ahead on Wednesday');
    expect(call.from).toBe('open'); expect(call.to).toBe('decided');
    // a decision with real options keeps them, and no yes/no
    const opts = page.locator('.cp-item').filter({ hasText: 'hosting' });
    if (await opts.count()) await expect(opts.getByRole('button', { name: 'Yes' })).toHaveCount(0);
  });

  test('r9: a note id in a next step reads as the note\'s title, never the id', async ({ page }) => {
    test.skip(!wide(page), 'side panel');
    await boot(page, { ulidNext: true });
    await scope(page).locator('.th-go[aria-label^="Techne,"]').click();
    await openCompanion(page);
    const item = page.locator('.cp-item').filter({ hasText: 'ATLAS follow-up' });
    // r14: the step leads the row (an action), and its linked note reads as the note's title. r21 (Codex 10): it opens from the sheet: the
    // row is one button with nothing clickable inside it
    const step = item.locator('.cp-lead, .cp-next').first();
    await expect(item.getByRole('button')).toHaveCount(1);
    // r21: both steps ("Read …, then … and reply"), or "2 steps: Read Follow-up notes, then …" where they don't fit
    await expect(step).toContainText(/^(2 steps: )?Read Follow-up notes, then/);
    await expect(step).not.toContainText('01M3ZK2R6A6C62M1ANJCSQNG3');
    await expect(step).not.toContainText('uni:');
  });

  test('r9: an overdue task stays listed, first, with a quiet "was due" line', async ({ page }) => {
    test.skip(!wide(page), 'side panel');
    await boot(page, { pastDue: true });
    await scope(page).locator('.th-go[aria-label^="Uni,"]').click();
    await openCompanion(page);
    const first = page.locator('.cp-item').first();
    await expect(first).toContainText('COhere festival readiness');
    await expect(first.locator('.cp-detail')).toContainText('was due Oct 7');
    await expect(first.locator('.cp-detail')).not.toContainText(/^due/);
  });

  test('r9: the footer always reads "All of <name>\'s work", wrapping rather than shortening', async ({ page }) => {
    test.skip(!wide(page), 'side panel');
    await boot(page);
    await scope(page).locator('.th-go[aria-label^="Unforced Dev"]').first().click().catch(() => {});
    await openCompanion(page);
    const label = page.locator('.cp-all-t');
    await expect(label).toHaveText(/^All of .+'s work$/);
    await expect(label).not.toHaveText('All work');
    expect(await label.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  });

  test('r12/r16: a decision with no whole question anywhere reads "Decide: <first words> ›", never buttons or a fragment ending "…"; its sheet opens the note', async ({ page }) => {
    await boot(page, { cutNoAsk: true });
    await openRoom(page, 'Techne');
    await openCompanion(page);
    if (await page.locator('.cp-more-rows').count()) await page.locator('.cp-more-rows').click();
    const item = page.locator('.cp-item').filter({ hasText: 'calendar email to people' }).first();
    await expect(item).toBeVisible();
    // r16: the verb first, whole words, never a hanging word or "…": the row is the way in (r19: the whole companion row opens it, no "›")
    await expect(item.locator('.cp-title')).toHaveText(/^Decide: a daily calendar email to people$/i);
    await expect(item.locator('.cp-open-decide')).toHaveCount(0);
    await expect(item.locator('.cp-hint')).toHaveCount(0);
    await expect(item.getByRole('button', { name: /^(Yes|No)$/ })).toHaveCount(0);
    await expect(page.locator('.cp-item').filter({ hasText: 'Open to see the question' })).toHaveCount(0);
    // never Yes/No next to text ending in an ellipsis
    for (const row of await page.locator('.cp-item').all()) {
      if (await row.getByRole('button', { name: 'Yes' }).count()) expect((await row.locator('.cp-title').innerText()).trim()).not.toMatch(/(…|\.\.\.)$/);
    }
    await item.locator('.cp-need').click();
    const sheet = taskDialog(page);
    // r13: no answers where the whole question is not shown: the sheet reads the note, finds no whole question, and offers the note only
    await expect(sheet.getByRole('button', { name: 'Open the note to read the question ›' })).toBeVisible();
    await expect(sheet.getByRole('group', { name: /^Decide:/ })).toHaveCount(0);
    await expect(sheet.getByRole('button', { name: /^(Yes|No)$/ })).toHaveCount(0);
    await expect(sheet.getByRole('button', { name: /Mark decided/ })).toHaveCount(0);
  });

  test('r10 (r30): every action row is its whole step (it wraps, never clamped), a decision is its whole question, and no row is cut at the panel bottom', async ({ page }) => {
    test.skip(!wide(page), 'side panel');
    await boot(page, { crowded: true, cutDecision: true, ulidNext: true });
    await openRoom(page, 'Techne');
    await openCompanion(page);
    await expect(page.locator('.cp-item').first()).toBeVisible();
    const panel = page.locator('aside.cp.side');
    const foot = await page.locator('.cp-foot').boundingBox();
    const pb = await panel.boundingBox();
    for (const row of await page.locator('.cp-item').all()) {
      const decision = await row.locator('.cp-need.decision').count();
      // r30: a row's words are never clamped: nothing scrolls inside it and no cut mark ends it
      expect(await row.locator('.cp-title').evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
      if (!decision && await row.locator('.cp-lead').count()) await expect(row.locator('.cp-lead')).not.toHaveAttribute('data-cut', 'true');
      const b = await row.boundingBox();
      expect(b!.y + b!.height).toBeLessThanOrEqual(Math.min(foot!.y, pb!.y + pb!.height) + 1);
    }
    // the rows that don't fit wait behind "Show N more" (r21: no "›"); a tap shows them
    const more = page.locator('.cp-more-rows');
    await expect(more).toHaveText(/^Show \d+ more$/);
    const before = await page.locator('.cp-item').count();
    await more.click();
    expect(await page.locator('.cp-item').count()).toBeGreaterThan(before);
  });

  test('r10: a row clamps and a tap shows all of it in its sheet (r19: no in-place More anywhere)', async ({ page }) => {
    test.skip(!wide(page), 'side panel');
    await boot(page, { crowded: true });
    await scope(page).locator('.th-go[aria-label^="Uni,"]').click();
    await openWorkView(page); await narrowWork(page);
    await expect(page.locator('.sr-work .cp-row-more, .sr-work .cp-item .cp-more-next')).toHaveCount(0);
    // r30: the row is the whole step, both sentences of it; the sheet's heading says the same
    const row = page.locator('.sr-work .cp-item').filter({ hasText: 'Edit the draft, check the dates' }).first();
    await expect(row.locator('.cp-lead')).toHaveText('Edit the draft, check the dates against the calendar, and send it from the shared inbox. Then post the link in the room and tell the team it went out so nobody sends it twice');
    await row.locator('.cp-need').click();
    await expect(page.locator('.task-sheet h2')).toContainText('so nobody sends it twice');
  });

  test('r10: a row says its state once: no "waiting, waiting on" in the opened item, no repeat of the row\'s label', async ({ page }) => {
    test.skip(!wide(page), 'side panel');
    await boot(page);
    await scope(page).locator('.th-go[aria-label^="Uni,"]').click();
    await openCompanion(page);
    const row = page.locator('.cp-item').filter({ hasText: 'COhere festival readiness' }).first();
    await row.locator('.cp-need').click();
    const sheet = taskDialog(page);
    await expect(sheet).toBeVisible();
    await expect(sheet).not.toContainText(/waiting, waiting on/i);
    await expect(sheet.locator('.task-facts')).toContainText('Waiting on you');
    expect(await sheet.getByText(/waiting on/i).count()).toBe(1);
    await expect(row).not.toContainText('Waiting on you');
  });

  test('r10: Recent never lists the room you are in, and never a room twice', async ({ page }) => {
    test.skip(!wide(page), 'sidebar column');
    await boot(page);
    const go = (n: string) => scope(page).locator(`.th-go[aria-label^="${n},"]`).first().click();
    await go('Uni'); await go('Techne'); await go('Uni'); await go('Techne'); await go('Uni');
    const recent = page.locator('.th-roomnav').getByRole('region', { name: 'Recent' });
    const names = await recent.locator('button').allTextContents();
    expect(new Set(names).size).toBe(names.length);
    expect(names).not.toContain('Uni');
    const h = (await recent.boundingBox())!.height;
    await go('Techne');
    expect((await recent.boundingBox())!.height).toBe(h);
  });

  test('r10: scrolled to the end, the sidebar\'s last row is whole and sits above Recent', async ({ page }) => {
    test.skip(!wide(page), 'sidebar column');
    await boot(page);
    await openRoom(page, 'ATLAS'); await openRoom(page, 'Uni'); // Recent shows once there is somewhere to go back to
    const wrap = page.locator('.th-column .th-rows-wrap');
    await wrap.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    const last = page.locator('.th-column .th-row').last();
    const lb = (await last.boundingBox())!; const wb = (await wrap.boundingBox())!; const rb = (await page.locator('.th-recent').boundingBox())!;
    expect(lb.y + lb.height).toBeLessThanOrEqual(wb.y + wb.height + 0.5);
    expect(lb.y + lb.height).toBeLessThanOrEqual(rb.y + 0.5);
  });

  test('r12/r18: a decision row is "Your call: <question> ›" with no buttons when it stores no options; only with no question anywhere does it read "Decide: …"', async ({ page }) => {
    test.skip(!wide(page), 'side panel');
    await boot(page, { cutDecision: true, longAsk: true, cutNoAsk: true });
    await openRoom(page, 'Techne');
    await openCompanion(page);
    await expect(page.locator('.cp-item').first()).toBeVisible();
    await page.waitForTimeout(600); // asks arrive, rows settle
    if (await page.locator('.cp-more-rows').count()) await page.locator('.cp-more-rows').click();
    let call = 0; let decide = 0;
    for (const row of await page.locator('.cp-item').all()) {
      if (!await row.locator('.cp-need.decision').count()) continue;
      expect(await row.getByRole('group', { name: /^Decide:/ }).getByRole('button').count()).toBe(0); // none of these stores options
      if (await row.locator('.cp-need[data-mode="decide"]').count()) { decide++; continue; }
      call++;
      await expect(row.locator('.cp-need')).toHaveAttribute('data-mode', 'call');
      await expect(row.locator('.cp-call-lead')).toHaveText('Your call:');
      const t = (await row.locator('.cp-title').innerText()).trim();
      expect(t).toMatch(/^[A-Z0-9"“]/); // starts with the ask, sentence-cased
      expect(t).not.toMatch(/…\s*…|\.\.\.\s*…/);
    }
    expect(call).toBeGreaterThan(0); expect(decide).toBeGreaterThan(0);
    // the long one: its sheet has the whole question and the answer box, no buttons built from its wording
    const long = page.locator('.cp-need[aria-label*="catering exclusivity"]').first();
    await long.click();
    const sheet = page.locator('.task-sheet');
    await expect(sheet.locator('h2')).toContainText('catering exclusivity clause');
    await expect(sheet.getByLabel('Answer in your words')).toBeVisible();
    await expect(sheet.locator('.cp-opt')).toHaveCount(0);
  });

  test('r11: asks kept on the device paint on the first render, before any note is read', async ({ page }) => {
    test.skip(!wide(page), 'side panel');
    const who = 'a'.repeat(64);
    await page.addInitScript((w) => {
      localStorage.setItem(`uni.asks.v2:${w}|uni`, JSON.stringify([['dq9', { ask: 'Should Uni add the after-event prompt on Wednesday?', at: '2026-10-10T08:00:00.000Z' }]]));
    }, who);
    await boot(page, { cutDecision: true, queryDelay: 0 });
    await scope(page).locator('.th-go[aria-label^="Uni,"]').click();
    await openCompanion(page);
    const item = page.locator('.cp-item').filter({ hasText: 'after-event prompt' });
    // r18: no stored options: "Your call", no Yes/No from its question mark
    await expect(item.locator('.cp-call-lead')).toHaveText('Your call:');
    await expect(item.getByRole('button', { name: /^(Yes|No)$/ })).toHaveCount(0);
    await expect(item.locator('.cp-title')).toHaveText('Should Uni add the after-event prompt on Wednesday?');
    expect((await calls(page, 'vault_note')).filter((a: any) => a.noteRef === 'dq9')).toHaveLength(0);
  });

  test('r11: an area revealed for the open room folds again on leaving; one the user opened stays open', async ({ page }) => {
    test.skip(!wide(page), 'sidebar column');
    await boot(page);
    const nav = scope(page);
    await expect(nav.locator('.th-row .th-go').first()).toBeVisible();
    // Aaron folds Atlas, with ATLAS the open room: the choice is kept
    await nav.locator('.th-fold[data-path="Areas/Atlas"]').click();
    await nav.locator('.th-go[aria-label^="ATLAS,"]').click();
    await nav.locator('.th-fold[data-path="Areas/Atlas"]').click();
    await expect(nav.locator('.th-go[aria-label^="ATLAS,"]')).toHaveCount(0);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('uni.tree.folds.v1')!)['Areas/Atlas'])).toBe(false);
    // the app reopens on ATLAS: Atlas shows it for now
    await page.reload();
    await expect(page.locator('.sr-title')).toHaveText('ATLAS');
    await expect(nav.locator('.th-go[aria-label^="ATLAS,"]')).toBeVisible();
    // leaving folds it again, and nothing was written to the device
    await nav.locator('.th-go[aria-label^="Uni,"]').click();
    await expect(page.locator('.sr-title')).toHaveText('Uni');
    await expect(nav.locator('.th-go[aria-label^="ATLAS,"]')).toHaveCount(0);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('uni.tree.folds.v1')!)['Areas/Atlas'])).toBe(false);
    // an area Aaron opens himself stays open after he leaves
    await nav.locator('.th-fold[data-path="Areas/Atlas"]').click();
    await nav.locator('.th-go[aria-label^="Techne,"]').click();
    await expect(nav.locator('.th-go[aria-label^="ATLAS,"]')).toBeVisible();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('uni.tree.folds.v1')!)['Areas/Atlas'])).toBe(true);
  });

  test('r11: "Open in #room" is not offered inside that room', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'ATLAS');
    await openCompanion(page);
    await page.getByRole('button', { name: /^All of .*'s work/ }).click();
    await page.locator('.sr-work .cp-need[data-id="T-07"]').click();
    await expect(taskDialog(page)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open in #atlas/build' })).toHaveCount(0);
  });

  test('r11: with long whole questions, "+N more" still sits whole above the footer', async ({ page }) => {
    test.skip(!wide(page), 'side panel');
    await boot(page, { crowded: true, cutDecision: true, longAsk: true, cutNoAsk: true });
    await openRoom(page, 'Techne');
    await openCompanion(page);
    await expect(page.locator('.cp-item .cp-need.decision').first()).toBeVisible();
    await page.waitForTimeout(600); // asks arrive, rows settle
    const more = (await page.locator('.cp-more-rows').boundingBox())!; const foot = (await page.locator('.cp-foot').boundingBox())!;
    expect(more.y + more.height).toBeLessThanOrEqual(foot.y + 1);
    const panel = (await page.locator('aside.cp.side').boundingBox())!;
    for (const row of await page.locator('.cp-item').all()) { const b = (await row.boundingBox())!; expect(b.y + b.height).toBeLessThanOrEqual(foot.y + 1); expect(b.y + b.height).toBeLessThanOrEqual(panel.y + panel.height); }
  });

  // ---------------------------------------------------------------------------------------------- r12: one app
  test('r12: a saved Map, Octopus or Classic choice opens the room layout, and the setting is dropped', async ({ page }) => {
    await boot(page, { savedLayout: 'tree' });
    await expect(scope(page)).toBeVisible();
    await expect(page.locator('.node-stage, .th-stage, .th-classic')).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('uni.home.layout.v1'))).toBeNull();
    await openRoom(page, 'ATLAS');
    await expect(page.locator('[data-view="room"] .sr-chat .message').first()).toBeVisible();
    await page.reload();
    await expect(scope(page).or(page.locator('.sr-title')).first()).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('uni.home.layout.v1'))).toBeNull();
  });

  test('r12: a room no node owns is under "Other rooms" (folded) and opens in the same room shell', async ({ page }) => {
    await boot(page, { strayRoom: true });
    const nav = scope(page);
    await nav.locator('.th-row.d1').first().waitFor();
    const group = nav.locator('.th-others');
    await expect(group).toBeVisible();
    await expect(group.locator('.th-fold')).toHaveAttribute('aria-expanded', 'false');
    // the rooms the tree already shows (Techne, atlas/build, …) are not repeated; only the unfiled one is listed
    await group.locator('.th-fold').click();
    await expect(nav.locator('.th-other .th-go')).toHaveText(['#garden-club']);
    await nav.locator('.th-other .th-go').click();
    // the room shell: header, the conversation with its composer, and the companion saying it is not filed
    await expect(page.locator('.sr-title')).toHaveText('#garden-club');
    await expect(page.locator('.sr-chat')).toContainText('Seed order is in for the spring beds.');
    await expect(page.locator('.sr-chat').getByRole('textbox', { name: /^Message / })).toBeVisible();
    await expect(page.locator('.conversation-header')).toHaveCount(0);
    await openCompanion(page);
    await expect((await page.locator('.cp-sheet').count()) ? page.locator('.cp-sheet') : companion(page)).toContainText('Not filed under an area yet.'); // (a strip's panel is over the room, not inside the strip's line)
    await expect((await page.locator('.cp-sheet').count()) ? page.locator('.cp-sheet').getByRole('button', { name: /^All of/ }) : companion(page).getByRole('button', { name: /^All of/ })).toHaveCount(0);
    if (wide(page)) await expect(nav.locator('.th-other.sel .th-go')).toHaveAttribute('aria-current', 'page');
    // Aaron folds it; reopening the room from Recent shows it again for now, and leaving folds it back (like an area)
    if (wide(page)) {
      await nav.locator('.th-others .th-fold').click();
      await expect(nav.locator('.th-other')).toHaveCount(0);
      await nav.locator('.th-go[aria-label^="Uni,"]').click();
      await nav.getByRole('region', { name: 'Recent' }).getByRole('button', { name: /garden-club/ }).click();
      await expect(nav.locator('.th-other.sel')).toBeVisible();
      await nav.locator('.th-go[aria-label^="Uni,"]').click();
      await expect(nav.locator('.th-other')).toHaveCount(0);
    }
    expect(await fits(page)).toBe(true);
    await shot(page, 'other-room');
  });

  test('r12: a thread opens inside its room\'s shell, with the way back', async ({ page }) => {
    await boot(page, { thread: true });
    await openRoom(page, 'ATLAS');
    await page.locator('.sr-chat .thread-summary').first().click();
    const shell = page.locator('[data-view="thread"]');
    await expect(shell).toBeVisible();
    await expect(page.locator('.sr-title')).toHaveText('ATLAS');
    await expect(page.locator('.sr-thread')).toContainText('Thread · 2 replies');
    await expect(page.locator('.sr-chat')).toContainText('The scope section is done; pricing is next.');
    await expect(page.locator('.sr-chat').getByRole('textbox')).toHaveAttribute('placeholder', 'Reply in thread…');
    await expect(page.locator('.conversation-header')).toHaveCount(0);
    if (wide(page)) { await expect(page.locator('.cp.side')).toBeVisible(); await expect(scope(page).locator('.th-row.sel .th-go')).toHaveAttribute('aria-label', /^ATLAS,/); }
    await page.getByRole('button', { name: 'Back to the room' }).click();
    await expect(page.locator('[data-view="room"]')).toBeVisible();
    await expect(page.locator('.sr-chat')).toContainText('Map labels are in a branch');
    expect(await fits(page)).toBe(true);
  });

  test('r12: a decision is closed only by an answer: the sheet answers it with the companion\'s control; no "Mark decided", no decision checkbox', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'ATLAS');
    await openCompanion(page);
    const row = page.locator('.cp-item').filter({ hasText: 'Decide the ATLAS hosting' });
    await expect(row.getByRole('group', { name: /^Decide:/ })).toHaveCount(0); // r20 (Codex 7): only the sheet answers
    await row.locator('.cp-need').click();
    const sheet = taskDialog(page);
    await expect(sheet.locator('h2')).toHaveText('Decide the ATLAS hosting');
    await expect(sheet.getByRole('button', { name: /Mark decided|Mark done|Archive/ })).toHaveCount(0);
    const answer = sheet.getByRole('group', { name: /^Decide:/ });
    await expect(answer.getByRole('button')).toHaveText(['Self-host', 'Managed']);
    await answer.getByRole('button', { name: 'Managed' }).click();
    await expect(sheet).toHaveCount(0);
    const decided = await calls(page, 'vault_decide');
    expect(decided).toHaveLength(1);
    expect(decided[0]).toMatchObject({ from: 'open', to: 'decided', metadata: { decided: 'Managed' } });
    expect(await calls(page, 'vault_transition')).toHaveLength(0);
    await expect(page.locator('.cp-item').filter({ hasText: 'Decide the ATLAS hosting' })).toHaveCount(0);
  });

  test('r12: on the work page a decision row is the same row (r20: its answers in its sheet), never a check-off', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'ATLAS');
    await openCompanion(page);
    await page.getByRole('button', { name: /^All of .*'s work/ }).click();
    const wrow = page.locator('.sr-work .cp-item').filter({ hasText: 'Decide the ATLAS hosting' });
    await expect(wrow.getByRole('group', { name: /^Decide:/ })).toHaveCount(0);
    await expect(wrow.locator('.task-check')).toHaveCount(0);
    await expect((await sheetAnswers(page, wrow)).getByRole('button')).toHaveText(['Self-host', 'Managed']);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: /^Mark decided/ })).toHaveCount(0);
  });

  test('r12: the task sheet leads with the action and its linked next step; no raw ids, hashes or "via api"; the bookkeeping is behind Details, in words', async ({ page }) => {
    await boot(page, { ulidNext: true });
    await openRoom(page, 'Techne');
    await openCompanion(page);
    if (await page.locator('.cp-more-rows').count()) await page.locator('.cp-more-rows').click();
    await page.locator('.cp-item').filter({ hasText: 'Review the ATLAS follow-up' }).locator('.cp-need').click();
    const sheet = taskDialog(page);
    // r13: its next step names an action, so the sheet leads with it (note ids read as titles) and the title sits under it
    // r21: a step in two parts ("Read …, then … and reply") is listed, numbered, under "2 steps"
    await expect(sheet.locator('h2')).toHaveText('Read Follow-up notes, then Morning pages and reply'); // r26: the heading is the step in full, never "2 steps"
    await expect(sheet.locator('.task-stepof')).toHaveText('Step 1 of 2');
    await expect(sheet.locator('.task-steps li').first()).toHaveText('Read Follow-up notes');
    // r22 (Codex 7): the request is said once; the record's title is in Details
    await expect(sheet.locator('.task-sub-title')).toHaveText('Review the ATLAS follow-up'); // r26: the title is the quiet line under the heading
    await expect(sheet.locator('.task-record')).toHaveText('Task T-13: Review the ATLAS follow-up');
    await expect(sheet.locator('.task-steps')).toContainText('Follow-up notes'); // the note id reads as its title, and opens
    await expect(sheet).not.toContainText(/T-13|cdf67944|via api|Changed by|01M3ZK2R6A6C62M1ANJCSQNG3M/, { useInnerText: true });
    const details = sheet.locator('details.task-details');
    await expect(details).not.toHaveAttribute('open', '');
    await details.locator('summary').click();
    await expect(details).toContainText('Task T-13');
    await expect(details).toContainText(/Last changed, /);
    await expect(details).not.toContainText(/cdf67944|api/);
    // after this device writes to a task, it says "by you"
    await sheet.getByRole('button', { name: 'Snooze until tomorrow' }).click();
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByRole('button', { name: 'Undo' })).toHaveCount(0);
    await openCompanion(page); // r16: on a phone the strip's sheet closed when the item opened
    if (await page.locator('.cp-more-rows').count()) await page.locator('.cp-more-rows').click();
    await page.locator('.cp-item').filter({ hasText: 'Review the ATLAS follow-up' }).locator('.cp-need').click();
    await taskDialog(page).locator('details.task-details summary').click();
    await expect(taskDialog(page).locator('details.task-details')).toContainText(/Last changed by you, /);
  });

  test('r12: a failed first load says "Couldn\'t load. Retry", never an endless Loading; a failed refresh keeps the rows with a quiet Retry', async ({ page }) => {
    await boot(page, { queryFails: ['task'] });
    await openRoom(page, 'ATLAS');
    await openCompanion(page);
    const body = page.locator('.cp-body');
    await expect(body.getByRole('alert')).toContainText("Couldn't load what needs you");
    await expect(body).not.toContainText('Loading…');
    if (wide(page)) await expect(scope(page).locator('.lh-line.bad')).toContainText("Couldn't load what needs you");
    await page.evaluate(() => { (window as any).__queryFails = []; });
    await body.getByRole('button', { name: 'Retry' }).click();
    await expect(page.locator('.cp-item').filter({ hasText: 'SOW for the commons grant' })).toBeVisible();
    await expect(page.locator('.lh')).toHaveCount(0);
    // a refresh that fails a minute later: the rows stay, with when they were read and a Retry (r14: one line, everywhere)
    await page.evaluate(() => { (window as any).__queryFails = ['task']; });
    await page.clock.setFixedTime(Date.parse('2026-10-09T10:02:00.000Z'));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    const stale = page.locator(wide(page) ? '.cp-body .lh' : '.sr-health');
    await expect(stale).toContainText("Couldn't refresh");
    await expect(stale).toContainText(/\d+ as of \d{1,2}:\d{2}/); // r15: the kept count, as of its read
    await expect(page.locator('.cp-item').filter({ hasText: 'SOW for the commons grant' })).toBeVisible();
    // r23: one freshness line at a time: beside the room, the companion says it and the tree doesn't
    if (wide(page)) await expect(scope(page).locator('.lh-line').filter({ hasText: "Couldn't refresh" })).toHaveCount(0);
    await page.evaluate(() => { (window as any).__queryFails = []; });
    if (!wide(page)) await page.keyboard.press('Escape'); // r28: the strip's panel is a modal over the room: the room's health line is reached once it is closed
    await stale.getByRole('button', { name: 'Retry' }).click();
    await expect(stale).toHaveCount(0);
  });

  test('r12: a list past 200 is read page by page before it is taken for the whole', async ({ page }) => {
    await boot(page, { manyTasks: 230 });
    await openRoom(page, 'Techne');
    await openCompanion(page);
    await expect(page.getByRole('region', { name: 'Needs you' })).toContainText('Casey call: book it'); // the 231st task and after: page two
    const offsets = (await calls(page, 'vault_query_meta')).filter((a: any) => a.tag === 'task').map((a: any) => a.offset ?? 0);
    expect(offsets).toContain(200);
    await expect(page.locator('.cp-stale')).toHaveCount(0);
  });

  test('r12: the tree\'s dots are the companion\'s Needs you: no dot for Someday or someone else\'s; a folded area\'s dot is a ring that says "something inside"', async ({ page }) => {
    test.skip(!wide(page), 'sidebar column');
    await boot(page);
    const nav = scope(page);
    await nav.locator('.th-row.d1').first().waitFor();
    // Unforced Development holds only a Someday task: no dot (r11 lit it)
    await expect(nav.locator('.th-go[aria-label^="Unforced Development,"] .th-dot')).toHaveCount(0);
    // folded Atlas: ATLAS inside needs you
    const atlas = nav.locator('.th-go[aria-label^="Atlas,"]');
    await expect(atlas.locator('.th-dot.inside')).toHaveAttribute('title', 'Something inside needs you');
    await expect(atlas).toHaveAttribute('aria-label', /something inside needs you/);
    // every row's dot agrees with its own room's companion
    await unfoldAll(page);
    for (const [name, lit] of [['ATLAS', true], ['Atlas Institute', false], ['Unforced Development', false], ['Learn Vibe Build', true]] as const) {
      await expect(nav.locator(`.th-go[aria-label^="${name},"] .th-dot:not(.inside)`)).toHaveCount(lit ? 1 : 0);
      await openRoom(page, name);
      await openCompanion(page);
      if (lit) await expect(page.locator('.cp-item').first()).toBeVisible(); else await expect(page.locator('.cp-none')).toHaveText('Nothing needs you here.');
    }
  });

  test('r12: Uni\'s own panel is Uni\'s items plus at most three from the areas: never a "+25 more"', async ({ page }) => {
    await boot(page, { crowded: true });
    await scope(page).locator('.th-go[aria-label^="Uni,"]').click();
    await openCompanion(page);
    await expect(page.locator('.cp-item').first()).toBeVisible();
    // r17: at most three rows; what doesn't fit, and everything else, is one "N more ›" to the work view, never "+N in areas"
    expect(await page.locator('.cp-body .cp-item').count()).toBeLessThanOrEqual(3);
    await expect(page.locator('.cp-body .cp-more-rows:not(.cp-more-all), .cp-body .cp-more-areas')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^All of Uni's work/ })).toBeVisible();
  });

  test('r12: "Uni listening" is a small visible switch in the composer; muted, a message does not notify Uni', async ({ page }) => {
    await boot(page, { uniMember: true });
    await openRoom(page, 'ATLAS');
    const sw = page.locator('.sr-chat').getByRole('button', { name: /^Uni is listening/ });
    await expect(sw).toBeVisible();
    await expect(sw).toHaveText('Uni listening');
    await expect(sw).toHaveAttribute('aria-pressed', 'true');
    await sw.click();
    const muted = page.locator('.sr-chat').getByRole('button', { name: /^Uni is muted/ });
    await expect(muted).toHaveText('Uni muted');
    await page.locator('.sr-chat').getByRole('textbox', { name: /^Message / }).fill('Just a note to myself.');
    await page.locator('.sr-chat').getByRole('button', { name: 'Send message' }).click();
    await expect.poll(async () => (await calls(page, 'post_message')).length).toBe(1);
    expect((await calls(page, 'post_message'))[0].recipients).toEqual([]);
    expect(await fits(page)).toBe(true);
  });

  test('r12: Recent tells places apart by id; where two share a name, each says where it sits', async ({ page }) => {
    test.skip(!wide(page), 'sidebar column');
    await boot(page, { twins: true });
    const nav = scope(page);
    await unfoldAll(page);
    await nav.locator('.th-row:has(.th-go[aria-label^="Techne,"]) ~ .th-row .th-go[aria-label^="Workshop,"]').first().click();
    await expect(page.locator('.sr')).toHaveAttribute('data-node', 'Workshop');
    await nav.locator('.th-row:has(.th-go[aria-label^="Atlas,"]) ~ .th-row .th-go[aria-label^="Workshop,"]').first().click();
    await nav.locator('.th-go[aria-label^="Uni,"]').click();
    const recent = nav.getByRole('region', { name: 'Recent' }).getByRole('button');
    await expect(recent.filter({ hasText: /^Workshop/ })).toHaveText(['Workshop · Atlas', 'Workshop · Techne']);
  });

  test('r12: with the tree taller than the column, Recent keeps to three places and never takes the tree\'s room', async ({ page }) => {
    test.skip(!wide(page), 'sidebar column');
    await page.setViewportSize({ width: 1280, height: 480 });
    await boot(page);
    const nav = scope(page);
    for (const name of ['ATLAS', 'Learn Vibe Build', 'Techne', 'Atlas Institute', 'Unforced Development', 'Uni']) await openRoom(page, name);
    const items = nav.getByRole('region', { name: 'Recent' }).getByRole('listitem');
    await unfoldAll(page);
    await expect.poll(() => nav.locator('.th-rows-wrap').evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    await expect(items).toHaveCount(3);
    // folded again, the tree fits: up to five
    for (let i = 0; i < 12 && await nav.locator('.th-fold[aria-expanded="true"]').count(); i++) await nav.locator('.th-fold[aria-expanded="true"]').first().click();
    await expect(items).toHaveCount(5);
  });
  // ------------------------------------------------------------------------------------------------------------------------------ r13
  /** Open "All of X's work" from the companion. */
  const openWork = async (page: Page) => { await openCompanion(page); await page.getByRole('button', { name: /^All of .*'s work/ }).click(); await expect(page.locator('.sr-work')).toBeVisible(); };
  /** How many need you, as the companion says it: its rows (all of them, once "+N more" is opened), its private items and "+N in areas". */
  const panelCount = async (page: Page) => {
    const cp = page.locator('.cp-body');
    // r17: Uni's panel is its rows and one "N more ›" (private items folded in)
    if (await cp.locator('.cp-more-all').count()) return (await cp.locator('.cp-list > .cp-item').count()) + Number(/^Show (\d+) more/.exec(await cp.locator('.cp-more-all').innerText())![1]);
    if (await cp.locator('.cp-more-rows').count()) await cp.locator('.cp-more-rows').click();
    const rows = await cp.locator('.cp-list:not(.cp-privates) > .cp-item').count();
    const privates = (await cp.locator('.cp-privates .cp-title').allInnerTexts()).reduce((n, t) => n + Number(/: (\d+) for you/.exec(t)![1]), 0);
    const rest = await cp.locator('.cp-more-areas').count() ? Number(/\+(\d+)/.exec(await cp.locator('.cp-more-areas').innerText())![1]) : 0;
    return rows + privates + rest;
  };
  /** The dots under a tree row (itself included), from each row's label ("…, 2 need you"), with every fold open. */
  const dotSum = async (page: Page, top: string | null) => {
    await unfoldAll(page);
    const rows = await scope(page).locator('.th-row:not(.th-other):not(.th-others)').evaluateAll((els) => els.map((e) => ({ depth: Number(/\bd(\d)\b/.exec(e.className)?.[1] ?? 0), path: (e.querySelector('.th-go') as HTMLElement).dataset.path ?? '', label: e.querySelector('.th-go')!.getAttribute('aria-label') ?? '' })));
    const at = top === null ? 0 : rows.findIndex((r) => r.path === top);
    expect(at).toBeGreaterThanOrEqual(0);
    const under = top === null ? rows : [rows[at], ...rows.slice(at + 1).filter((_, j, rest) => rest.slice(0, j + 1).every((r) => r.depth > rows[at].depth))];
    return under.reduce((n, l) => n + Number(/, (\d+) needs? you/.exec(l.label)?.[1] ?? 0), 0);
  };

  test('r13: no answers without the whole question, in the work view as in the sheet: an unreadable question opens its note, nothing to tap', async ({ page }) => {
    await boot(page, { cutNoAsk: true });
    await openRoom(page, 'COhere 2026');
    await openWork(page);
    const wv = page.locator('.sr-work');
    const cut = wv.locator('.cp-item').filter({ hasText: 'calendar email to people' });
    await expect(cut).toHaveCount(1);
    // r16: the work view reads the row as the companion does: "Decide: <first words>" (r20: once its note is read, and never a "›")
    await expect(cut.locator('.cp-title')).toHaveText(/^Decide: a daily calendar email to people$/i);
    await expect(wv).not.toContainText('Open to see the question');
    await expect(cut.getByRole('group', { name: /^Decide:/ })).toHaveCount(0);
    // r19: a whole statement with no stored options asks nothing: it is Uni's to tidy, listed apart (never "Your call", never buttons)
    await expect(wv.locator('section[aria-label="Needs you"]')).not.toContainText('the long one that needs a longer ask');
    // r27: records to reword are the rooms' business: not in Aaron's view at all
    await expect(wv).not.toContainText(/the long one that needs a longer ask|rewording/);
    await expect(wv.locator('.wv-tidy-line, .wv-tidy')).toHaveCount(0);
    // never a Yes/No beside a title that ends cut short
    for (const row of await wv.locator('.cp-item').all()) if (await row.getByRole('group', { name: /^Decide:/ }).count()) expect((await row.locator('.cp-title').innerText()).trim()).not.toMatch(/(…|\.\.\.)$/);
    await cut.locator('.cp-need').click();
    const sheet = taskDialog(page);
    await expect(sheet.getByRole('button', { name: 'Open the note to read the question ›' })).toBeVisible();
    await expect(sheet.getByRole('group', { name: /^Decide:/ })).toHaveCount(0);
    await sheet.getByRole('button', { name: 'Open the note to read the question ›' }).click();
    await expect(taskDialog(page)).toHaveCount(0);
    await expect(page.locator('.note-sheet')).toBeVisible();
    expect(await calls(page, 'vault_decide')).toHaveLength(0);
  });

  test('r13: one count: the companion (with "+N in areas" and private items), the dots and the work view say the same number; Someday is apart', async ({ page }) => {
    test.skip(!wide(page), 'the dots are read from the sidebar');
    await boot(page, { privateTasks: true, cutDecision: true });
    for (const [name, top] of [['Uni', null], ['Techne', 'Areas/Techne'], ['COhere 2026', 'Projects/COhere/COhere 2026']] as const) {
      await openRoom(page, name);
      await openCompanion(page);
      await expect(page.locator('.cp-body')).not.toContainText(/counted but not named/);
      const panel = await panelCount(page);
      const dots = await dotSum(page, top);
      await page.getByRole('button', { name: /^All of .*'s work/ }).click();
      const work = Number(await page.locator('.sr-work section[aria-label="Needs you"] .wv-n').innerText());
      expect({ name, panel, dots }).toEqual({ name, panel: work, dots: work });
      // the work view keeps Someday apart, folded, and never in that number
      const later = page.locator('.sr-work section[aria-label="Later"]');
      if (await later.count()) { await expect(later.locator('.wv-fold')).toHaveAttribute('aria-expanded', 'false'); await expect(page.locator('section[aria-label="Needs you"]')).not.toContainText(/Send the Q4 invoice|Find a teacher/); }
      await page.getByRole('button', { name: 'Back to chat' }).click();
    }
    // r14/r17: from Uni's work view a private area is one line, "Sanctum: N for you" (r21: no "›"), opening that area (the panel folds it into "N more"); inside it, its items are ordinary rows
    await openRoom(page, 'Uni');
    await openCompanion(page);
    await expect(page.locator('.cp-body .cp-privates')).toHaveCount(0);
    await page.getByRole('button', { name: /^All of .*'s work/ }).click();
    const priv = page.locator('.sr-work .cp-private');
    await expect(priv).toHaveText('In Sanctum: 1 thing for you · open Sanctum');
    await expect(page.locator('.sr-work')).not.toContainText(/Sit twenty minutes|Before breakfast|A private item/);
    await priv.click();
    await expect(page.locator('.sr-title')).toHaveText('Sanctum');
    await openCompanion(page);
    await expect(page.locator('.cp-privates')).toHaveCount(0);
    const row = page.locator('.cp-body .cp-item').filter({ hasText: 'Sit twenty minutes' });
    await expect(row).toHaveCount(1);
    await row.locator('.cp-need').first().click();
    await expect(taskDialog(page)).toContainText('Sit twenty minutes');
    await expect(taskDialog(page).getByRole('button', { name: 'I did this' })).toBeVisible();
  });

  test('r13: the work view is inside the room shell: same header and crumbs, "‹ Back to chat", the companion\'s rows, no counters or priority pickers', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'ATLAS');
    const title = await page.locator('.sr-title').innerText();
    const meta = await page.locator('.sr-meta').innerText();
    await openWork(page);
    await expect(page.locator('.sr-title')).toHaveText(title);
    expect(await page.locator('.sr-meta').innerText()).toBe(meta);
    await expect(page.getByRole('button', { name: 'Back to chat' })).toBeVisible();
    expect(await page.locator('.sr-work section').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))).toEqual(expect.arrayContaining(['Needs you', 'Running']));
    await expect(page.locator('.wr-counts, .wr-prio, select, .task-check, .th-sec, .th-panel')).toHaveCount(0);
    // the same row as the companion: a decision is its whole question (r20: its answers in its sheet)
    await expect(page.locator('.sr-work .cp-item').filter({ hasText: 'Decide the ATLAS hosting' }).locator('.cp-title')).toHaveText('Decide the ATLAS hosting');
    await expect(page.locator('.sr-work .cp-item').filter({ hasText: 'Decide the ATLAS hosting' }).getByRole('group', { name: /^Decide:/ })).toHaveCount(0);
    await expect(page.locator('.sr-chat')).toHaveCount(0);
    await page.getByRole('button', { name: 'Back to chat' }).click();
    await expect(page.locator('.sr-chat .message')).toHaveCount(3);
    expect(await fits(page)).toBe(true);
    await shot(page, 'r13-work');
  });

  test('r13: Back closes the work view first: Escape, Alt+←, the sidebar\'s ← and Android Back (r19: and an open sheet, before any place changes)', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'Techne');
    await openRoom(page, 'ATLAS');
    const inAtlas = async () => { await expect(page.locator('.sr-title')).toHaveText('ATLAS'); await expect(page.locator('.sr-chat')).toBeVisible(); await expect(page.locator('.sr-work')).toHaveCount(0); };
    await openWork(page);
    await page.keyboard.press('Escape');
    await inAtlas();
    await openWork(page);
    await page.locator('.sr-work').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Alt+ArrowLeft');
    await inAtlas();
    if (wide(page)) { await openWork(page); await page.getByRole('button', { name: 'Back', exact: true }).first().click(); await inAtlas(); }
    await openWork(page);
    await page.evaluate(() => { const w = window as any; w.__cbs[w.__backHandler.id]({ message: {}, index: w.__backIndex ?? 0 }); w.__backIndex = (w.__backIndex ?? 0) + 1; });
    await inAtlas();
    // r19: Back means one thing: Alt+← closes the open sheet first (it used to do nothing behind it), and only then changes places
    await openCompanion(page);
    await page.locator('.cp-need').first().click();
    await expect(page.locator('.task-sheet')).toBeVisible();
    await page.keyboard.press('Alt+ArrowLeft');
    await expect(page.locator('.task-sheet')).toHaveCount(0);
    await expect(page.locator('.sr-title')).toHaveText('ATLAS');
    if (wide(page)) { await page.keyboard.press('Alt+ArrowLeft'); await expect(page.locator('.sr-title')).toHaveText('Techne'); }
  });

  test('r13: the open sheet is live: a change made elsewhere shows on refresh, and a task closed elsewhere says so', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'ATLAS');
    await openCompanion(page);
    await page.locator('.cp-item').filter({ hasText: 'SOW for the commons grant' }).locator('.cp-need').click();
    const sheet = taskDialog(page);
    const id = await page.evaluate(() => (window as any).__tasks.find((t: any) => /SOW for the commons grant/.test(t.path)).id);
    await page.evaluate((i) => (window as any).__setTask(i, { next: 'Say go to send the SOW to Casey', due: '2026-10-20' }), id);
    // the pinned clock moves on a minute and the window is focused again: the list re-reads, and the open sheet with it
    await page.clock.setFixedTime(Date.parse('2026-10-09T10:01:00.000Z'));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    // the action leads, the title sits under it, and its own action fills the room's composer (never sends); "I did this" stays secondary
    await expect(sheet.locator('h2')).toHaveText('Say go to send the SOW to Casey');
    await expect(sheet.locator('.task-record')).toContainText('SOW for the commons grant'); // r22: the title is in Details
    await expect(sheet.locator('.task-facts')).toContainText('due Oct 20');
    // r26: the task changed under the open sheet: it says so, and its answers wait for a reload
    await expect(sheet.locator('[data-moved]')).toHaveText(/^This changed since you opened it\./);
    await expect(sheet.locator('.task-do.primary')).toHaveCount(0);
    await sheet.getByRole('button', { name: 'Reload' }).click();
    await expect(sheet.locator('.task-do.primary')).toHaveText(/^Say it in #/);
    await expect(sheet.getByRole('button', { name: 'I did this' })).not.toHaveClass(/primary/);
    await page.evaluate((i) => (window as any).__setTask(i, { state: 'done' }), id);
    await page.clock.setFixedTime(Date.parse('2026-10-09T10:02:00.000Z'));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(sheet.locator('.task-gone')).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'I did this' })).toHaveCount(0);
    await sheet.getByRole('button', { name: 'Close' }).last().click();
  });

  test('r13: "Say it in #room" puts the words in the composer and sends nothing; priority is set in the sheet', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'ATLAS');
    await openCompanion(page);
    const id = await page.evaluate(() => (window as any).__tasks.find((t: any) => /SOW for the commons grant/.test(t.path)).id);
    await page.evaluate((i) => (window as any).__setTask(i, { next: 'Say go to send the SOW to Casey' }), id);
    await page.clock.setFixedTime(Date.parse('2026-10-09T10:01:00.000Z'));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.locator('.cp-item').filter({ hasText: 'SOW for the commons grant' })).toBeVisible();
    await page.locator('.cp-item').filter({ hasText: 'SOW for the commons grant' }).locator('.cp-need').click();
    const sheet = taskDialog(page);
    // r14: one primary action; priority is under Details
    await expect(sheet.locator('.task-do.primary')).toHaveCount(1);
    await expect(sheet.getByRole('group', { name: 'Priority' })).toBeHidden();
    await sheet.locator('.task-details > summary').click();
    await expect(sheet.getByRole('group', { name: 'Priority' }).getByRole('button')).toHaveText(['Now', 'Soon', 'Someday']);
    await sheet.getByRole('group', { name: 'Priority' }).getByRole('button', { name: 'Soon' }).click();
    await expect.poll(() => calls(page, 'vault_patch_meta').then((c) => c.filter((x: any) => x.metadata?.priority === 'soon').length)).toBe(1);
    await sheet.locator('.task-do.primary').click();
    await expect(taskDialog(page)).toHaveCount(0);
    await expect(page.locator('.sr-chat textarea')).toHaveValue(/go to send the SOW to Casey/i);
    expect(await calls(page, 'post_message')).toHaveLength(0);
  });

  test('r13/r17: below 900px the room header opens a drawer with the tree, Back/Forward and Recent; the app\'s places stay on the rail, never twice', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 600 });
    await boot(page);
    await openRoom(page, 'Techne');
    await openRoom(page, 'ATLAS');
    await expect(page.locator('.sr-meta .th-crumbs')).toContainText('Atlas');
    await page.getByRole('button', { name: 'Places' }).click();
    const drawer = page.getByRole('dialog', { name: 'Rooms and places' });
    await expect(drawer).toBeVisible();
    // r17 (Codex P2-4): the rail is on screen, so Places doesn't repeat it
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
    await expect(drawer.getByRole('navigation', { name: 'App' })).toHaveCount(0);
    await expect(drawer.getByRole('button', { name: 'Back', exact: true })).toBeEnabled();
    await expect(drawer.getByRole('region', { name: 'Recent' })).toContainText('Techne');
    await expect(drawer.getByRole('navigation', { name: 'Rooms and areas' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Settings' }).click();
    await expect(page.locator('.settings')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Run sandbox self-test' })).toBeHidden();
    await expect(page.locator('.settings-dev > summary')).toHaveText('Developer');
  });

  test('r13: phone landscape keeps the app\'s places in every room and on the tree', async ({ page }) => {
    await page.setViewportSize({ width: 740, height: 360 });
    await boot(page);
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeHidden();
    await openRoom(page, 'ATLAS');
    await page.getByRole('button', { name: 'Places' }).click();
    const drawer = page.getByRole('dialog', { name: 'Rooms and places' });
    for (const name of ['Journal', 'Vault', 'Search', 'Settings']) await expect(drawer.getByRole('button', { name, exact: true })).toBeVisible();
    await drawer.getByRole('button', { name: 'Journal', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Journal entry', exact: true })).toBeVisible();
    expect(await fits(page)).toBe(true);
    // and from the Journal (not a room) its own Back goes where it was opened from (r22, Codex 2: ATLAS here), where the places are again; when
    // the app reopens on the Journal, to Uni
    for (const reopen of [false, true]) {
      if (reopen) { await page.reload(); await expect(page.getByRole('textbox', { name: 'Journal entry', exact: true })).toBeVisible(); await page.waitForTimeout(1500); }
      await page.getByRole('button', { name: reopen ? 'Back to Uni' : 'Back to ATLAS' }).click();
      if (!reopen) await expect(page.locator('.sr-title')).toHaveText('ATLAS');
      await expect(page.getByRole('textbox', { name: 'Journal entry', exact: true })).toBeHidden();
      await expect(page.locator('.sr-drawer, .th-places-short .th-places').first()).toBeVisible();
      if (!reopen) { await page.locator('.sr-drawer, .th-places-short .th-places').first().waitFor(); if (await page.locator('.sr-drawer').isVisible()) await page.locator('.sr-drawer').click(); await page.locator('.th-places:visible').getByRole('button', { name: 'Journal', exact: true }).click(); }
    }
  });

  test('r13: a key that exists but could not be read says so with Retry, never the pairing screen', async ({ page }) => {
    await bootAreas(page, 'seed', { ...base, identityFails: 1, noWait: true });
    await expect(page.getByRole('alert')).toHaveText(/Couldn't read your key/);
    await expect(page.getByText(/pair/i)).toHaveCount(0);
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(page.locator('.sr-title, .th-phone-tree').first()).toBeVisible();
  });

  test('r13: a known room is never a blank timeline while its first read is under way', async ({ page }) => {
    await boot(page, { messagesDelay: 1500 });
    await page.evaluate(() => localStorage.clear()).catch(() => {});
    await openRoom(page, 'ATLAS');
    await expect(page.locator('.sr-chat .room-loading')).toHaveText('Loading messages…');
    await expect(page.locator('.sr-chat .message')).toHaveCount(3);
    await expect(page.locator('.sr-chat .room-loading')).toHaveCount(0);
  });
});

// T-124 r14: Needs you that is complete, current and explicit at the edges.
test.describe('r14', () => {
  const openWork = async (page: Page) => { await openCompanion(page); await page.getByRole('button', { name: /^All of .*'s work/ }).click(); await expect(page.locator('.sr-work')).toBeVisible(); };
  const refresh = async (page: Page, at: string) => { await page.clock.setFixedTime(Date.parse(at)); await page.evaluate(() => window.dispatchEvent(new Event('focus'))); };

  test('work view: a failed refresh keeps the rows with "Couldn\'t refresh · Retry"; an incomplete count says so; a failed tree read shows', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'ATLAS');
    await openWork(page);
    const wv = page.locator('.sr-work');
    const row = wv.locator('.cp-item').filter({ hasText: 'SOW for the commons grant' });
    await expect(row).toBeVisible();
    const n = await wv.locator('section[aria-label="Needs you"] .wv-n').innerText();
    await page.evaluate(() => { (window as any).__queryFails = ['task']; });
    await refresh(page, '2026-10-09T10:02:00.000Z');
    const health = wv.locator('.lh');
    await expect(health).toContainText("Couldn't refresh · Retry");
    await expect(health).toContainText(`${n} as of`);
    await expect(row).toBeVisible();
    // r15: the count kept from the last read is that read's count, as of when it was read (never "at least": it may have gone down)
    await expect(wv.locator('section[aria-label="Needs you"] .wv-n')).toHaveText(n);
    await expect(wv.locator('section[aria-label="Needs you"] .wv-n')).toHaveAttribute('aria-label', new RegExp(`^${n} as of `));
    await page.evaluate(() => { (window as any).__queryFails = []; });
    await health.getByRole('button', { name: 'Retry' }).click();
    await expect(wv.locator('.lh')).toHaveCount(0);
    await expect(wv.locator('section[aria-label="Needs you"] .wv-n')).toHaveText(n);
    // the task tree can't be read: the work view (and the tree) say where tasks belong may be wrong
    await page.evaluate(() => { (window as any).__queryFails = ['node']; });
    await refresh(page, '2026-10-09T10:04:00.000Z');
    await expect(wv.locator('.lh')).toContainText("Couldn't read where tasks belong");
    if (wide(page)) await expect(scope(page).locator('.lh')).toContainText("Couldn't read where tasks belong");
  });

  test('a list the app could not read whole: every count says "at least", in the work view and the companion', async ({ page }) => {
    await page.addInitScript(() => { (window as any).__ignoreOffset = true; });
    await boot(page, { manyTasks: 230 });
    await openRoom(page, 'Techne');
    await openCompanion(page);
    await expect(page.locator(wide(page) ? '.cp-body .lh' : '.sr-health')).toContainText('More work exists than the app could read');
    await page.getByRole('button', { name: /^All of .*'s work/ }).click();
    await expect(page.locator('.sr-work section[aria-label="Needs you"] .wv-n')).toHaveText(/^\d+\+$/);
    await expect(page.locator('.sr-work .lh')).toContainText('counts may be low');
  });

  test('below 900px the room says the list could not refresh outside the drawer', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 600 });
    await boot(page);
    await openRoom(page, 'ATLAS');
    await expect(page.locator('.th-drawer')).toHaveCount(0);
    await page.evaluate(() => { (window as any).__queryFails = ['task']; });
    await refresh(page, '2026-10-09T10:02:00.000Z');
    await expect(page.locator('.sr-health')).toContainText("Couldn't refresh · Retry");
  });

  test('a preview never unlocks answers: a long question is whole in the row (r28: never cut; r18: "Your call:"), with no answer in it, and the sheet has the answer box, written against its revision', async ({ page }) => {
    await boot(page, { cutDecision: true, previewAsk: true });
    await openRoom(page, 'COhere 2026');
    await openCompanion(page);
    if (await page.locator('.cp-more-rows').count()) await page.locator('.cp-more-rows').click();
    const row = page.locator('.cp-body .cp-item').filter({ hasText: 'riverside barn' });
    await expect(row.locator('.cp-need')).toHaveAttribute('data-mode', 'call');
    await expect(row.locator('.cp-title')).not.toHaveText(/…/); // r23: no ellipsis in Needs you; the sheet has it whole
    await expect(row.locator('.cp-opt')).toHaveCount(0);
    await expect(row).toContainText('extra fee of 400 dollars'); // r28: a row is whole or it is not shown
    await row.locator('.cp-need').click();
    const sheet = taskDialog(page);
    await expect(sheet.locator('#task-sheet-title')).toContainText('which it will only do for an extra fee of 400 dollars.');
    await expect(sheet.getByRole('button', { name: /^(Yes|No|Go ahead|Skip it)$/ })).toHaveCount(0);
    const rev = await page.evaluate(() => (window as any).__tasks.find((t: any) => t.id === 'dq11').updatedAt);
    const box = sheet.getByLabel('Answer in your words');
    await expect(sheet.getByRole('button', { name: 'Answer', exact: true })).toBeDisabled();
    await box.fill('Yes, at that fee');
    await box.press('Enter');
    await expect.poll(async () => (await calls(page, 'vault_decide')).length).toBe(1);
    const a = (await calls(page, 'vault_decide'))[0];
    expect(a).toEqual({ vault: 'uni', id: 'dq11', from: 'open', to: 'decided', metadata: { decided: 'Yes, at that fee', decided_at: expect.any(String), decided_by: expect.any(String), answered_rev: expect.any(String) }, ifUpdatedAt: rev });
  });

  test('a question is keyed by its revision: a rewritten note drops the old question; an answer to the old one is refused, never recorded', async ({ page }) => {
    await boot(page, { cutDecision: true });
    await openRoom(page, 'COhere 2026');
    await openCompanion(page);
    if (await page.locator('.cp-more-rows').count()) await page.locator('.cp-more-rows').click();
    const oldQ = /after-event "were you there\?" prompt/;
    const row = () => page.locator('.cp-body .cp-item').filter({ hasText: /after-event|takeaway|morning after|skip the/i }).first();
    await expect(row().locator('.cp-title')).toContainText(/after-event "were you there\?"/);
    await row().locator('.cp-need').click();
    let sheet = taskDialog(page);
    await expect(sheet.locator('#task-sheet-title')).toContainText(oldQ);
    // Uni rewrites the question; the list has not been read again: the answer typed beside the old question is refused (it is not the latest)
    await page.evaluate(() => (window as any).__setContent('dq9', 'Decision (default yes): Should Uni ask attendees for one takeaway the morning after, instead of the prompt?'));
    await sheet.getByLabel('Answer in your words').fill('Yes');
    await sheet.getByRole('button', { name: 'Answer', exact: true }).click();
    await expect(sheet.getByRole('alert').filter({ hasText: /changed or was decided elsewhere/ })).toBeVisible();
    expect(await calls(page, 'vault_decide')).toHaveLength(1);
    expect(await page.evaluate(() => (window as any).__tasks.find((t: any) => t.id === 'dq9').metadata.state)).toBe('open');
    await sheet.getByRole('button', { name: 'Close' }).click();
    // the re-read brings the new revision: the old question is gone everywhere, the new one is shown whole
    await refresh(page, '2026-10-09T10:03:00.000Z');
    await openCompanion(page);
    await expect(page.locator('.cp-body')).not.toContainText(oldQ);
    await expect(row().locator('.cp-title')).toContainText('Should Uni ask attendees for one takeaway');
    await row().locator('.cp-need').click();
    sheet = taskDialog(page);
    await expect(sheet.locator('#task-sheet-title')).toHaveText('Should Uni ask attendees for one takeaway the morning after, instead of the prompt?');
    // and while the sheet is open, another rewrite clears the question at once, then shows the new one
    await page.evaluate(() => (window as any).__setContent('dq9', 'Decision (default yes): Should Uni skip the takeaway this year?'));
    await refresh(page, '2026-10-09T10:05:00.000Z');
    await expect(sheet.locator('#task-sheet-title')).toHaveText('Should Uni skip the takeaway this year?');
    await expect(sheet).not.toContainText('one takeaway the morning after');
    const rev = await page.evaluate(() => (window as any).__tasks.find((t: any) => t.id === 'dq9').updatedAt);
    await sheet.getByRole('button', { name: 'Reload' }).click(); // r26: the rewrite moved the revision under the open sheet
    await sheet.getByLabel('Answer in your words').fill('No, keep it');
    await sheet.getByRole('button', { name: 'Answer', exact: true }).click();
    await expect.poll(async () => (await calls(page, 'vault_decide')).length).toBe(2);
    expect((await calls(page, 'vault_decide'))[1].ifUpdatedAt).toBe(rev);
    expect((await calls(page, 'vault_decide'))[1].metadata.decided).toBe('No, keep it');
  });

  test('private areas: from above, counted (r17: in Uni\'s "N more", and one line in its work view); inside the area, real rows with their actions and the sheet', async ({ page }) => {
    await boot(page, { privateTasks: true });
    await openRoom(page, 'Uni');
    await openCompanion(page);
    await expect(page.locator('.cp-body .cp-privates')).toHaveCount(0);
    await expect(page.locator('.cp-body')).not.toContainText(/Sit twenty minutes|Before breakfast|A private item/);
    await page.getByRole('button', { name: /^All of .*'s work/ }).click();
    await expect(page.locator('.sr-work .cp-private')).toHaveText('In Sanctum: 1 thing for you · open Sanctum');
    await expect(page.locator('.sr-work')).not.toContainText(/Sit twenty minutes|Find a teacher|A private item/);
    await expect(page.locator('.sr-work .cp-privates, .sr-work .cp-private')).toHaveCount(1);
    await page.locator('.sr-work .cp-private').click();
    await expect(page.locator('.sr-title')).toHaveText('Sanctum');
    await openCompanion(page);
    await expect(page.locator('.cp-body .cp-private')).toHaveCount(0);
    const row = page.locator('.cp-body .cp-item').filter({ hasText: 'Sit twenty minutes' });
    await expect(row).toContainText('Before breakfast');
    await row.locator('.cp-need, .cp-lead').first().click();
    const sheet = taskDialog(page);
    await expect(sheet).toContainText('Sit twenty minutes');
    await expect(sheet.getByRole('button', { name: 'I did this' })).toBeVisible();
    await sheet.getByRole('button', { name: 'Close' }).click();
    // its Someday item is in Later, inside the area, by name
    await page.getByRole('button', { name: /^All of .*'s work/ }).click();
    await page.locator('.sr-work .wv-fold').click();
    await expect(page.locator('.sr-work')).toContainText('Find a teacher');
  });

  test('chat: a cited note reads as its title (or "a note"), a table renders, and task-state markers are not shown', async ({ page }) => {
    await boot(page, { ulidNext: true });
    await openRoom(page, 'Techne');
    await page.evaluate(() => (window as any).__arrive('ch-techne', 'Uni', 'See uni:01M3ZK2R6A6C62M1ANJCSQNG3M and uni:01M3ZK2R6A6C62M1ANJCSQNG3P.\n\n| Window | When |\n|---|---|\n| Gateway | Wed 10:00 |\n\n[done T-9]'));
    const chat = page.locator('.sr-chat');
    await expect(chat.locator('.note-chip').filter({ hasText: 'Follow-up notes' })).toHaveCount(1);
    await expect(chat.locator('.note-chip').filter({ hasText: /^❋?a note$/ })).toHaveCount(1); // (r20: a note the vault doesn't have)
    await expect(chat).not.toContainText('01M3ZK2R6A6C62M1ANJCSQNG3');
    await expect(chat.locator('.md-table th')).toHaveText(['Window', 'When']);
    await expect(chat.locator('.md-table td')).toHaveText(['Gateway', 'Wed 10:00']);
    await expect(chat).not.toContainText('T-9');
    await expect(page.locator('.address-label')).toHaveCount(0);
  });

  test('920×360: the rail is hidden and Places is in the room header, with every place', async ({ page }) => {
    await page.setViewportSize({ width: 920, height: 360 });
    await boot(page);
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeHidden();
    await openRoom(page, 'ATLAS');
    const places = page.getByRole('button', { name: 'Places' });
    await expect(places).toBeVisible();
    await places.click();
    const drawer = page.getByRole('dialog', { name: 'Rooms and places' });
    for (const name of ['Journal', 'Vault', 'Search', 'Settings']) await expect(drawer.getByRole('button', { name, exact: true })).toBeVisible();
    await drawer.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.locator('.settings')).toBeVisible();
    await expect(page.locator('.panel-head h1')).toHaveText('Settings');
    // and a wider short window keeps the rail; under 400px tall the tree is in Places (r17), which then never repeats the rail's places
    await page.setViewportSize({ width: 1000, height: 360 });
    await page.getByRole('button', { name: 'Close panel' }).click();
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
    await expect(page.locator('.th-roomnav')).toHaveCount(0);
    await page.getByRole('button', { name: 'Places' }).click();
    await expect(drawer.getByRole('navigation', { name: 'Rooms and areas' })).toBeVisible();
    await expect(drawer.getByRole('navigation', { name: 'App' })).toHaveCount(0);
  });

  test('the drawer is a dialog: focus moves in and stays in, the room under it is inert, Escape and Back close it and focus returns', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 600 });
    await boot(page);
    await openRoom(page, 'Techne');
    await openRoom(page, 'ATLAS');
    const places = page.getByRole('button', { name: 'Places' });
    await places.click();
    const drawer = page.getByRole('dialog', { name: 'Rooms and places' });
    await expect(drawer).toBeVisible();
    expect(await page.evaluate(() => !!document.activeElement?.closest('.th-drawer'))).toBe(true);
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press(i % 7 === 6 ? 'Shift+Tab' : 'Tab');
      expect(await page.evaluate(() => !!document.activeElement?.closest('.th-drawer'))).toBe(true);
    }
    expect(await page.locator('.sr').evaluate((e) => !!e.closest('[inert]'))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await expect(places).toBeFocused();
    expect(await page.locator('.sr').evaluate((e) => !!e.closest('[inert]'))).toBe(false);
    // Alt+← closes the drawer and stays in ATLAS; the drawer's own Back goes back a place
    await places.click();
    await page.keyboard.press('Alt+ArrowLeft');
    await expect(drawer).toHaveCount(0);
    await expect(page.locator('.sr-title')).toHaveText('ATLAS');
    await places.click();
    await drawer.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(drawer).toHaveCount(0);
    await expect(page.locator('.sr-title')).toHaveText('Techne');
  });
});

test.describe('r15', () => {
  const openWork = async (page: Page) => { await openCompanion(page); await page.getByRole('button', { name: /^All of .*'s work/ }).click(); await expect(page.locator('.sr-work')).toBeVisible(); };
  const refresh = async (page: Page, at: string) => { await page.clock.setFixedTime(Date.parse(at)); await page.evaluate(() => window.dispatchEvent(new Event('focus'))); };

  test('a node with no room of its own (r20, Codex 6): the node is the heading everywhere, the room it talks in a line under it, the composer the real channel\'s', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'Relationships');
    await expect(page.locator('.sr-title')).toHaveText('Relationships');
    await expect(page.locator('.sr-context')).toHaveText('Chat in #Uni · no room of its own yet');
    await expect(page.locator('.sr-door')).toHaveCount(0);
    await expect(page.locator('.sr-chat').getByRole('textbox', { name: /^Message / })).toHaveAttribute('placeholder', 'Message #Uni');
    // the state beside the conversation is the node's, not the room's
    if (wide(page)) await expect(page.locator('.cp-top')).toContainText('Where Relationships stands');
    else await expect(page.locator('.cp-line .cp-scope')).toHaveText('Relationships:');
    // its work view is the node's own: its name is the heading there
    await openWork(page);
    await expect(page.locator('.sr-title')).toHaveText('Relationships');
    // a node with its own room is unchanged
    await openRoom(page, 'Techne');
    await expect(page.locator('.sr-title')).toHaveText('Techne');
    await expect(page.locator('.sr-context')).toHaveCount(0);
    await expect(page.locator('.sr-door')).toHaveText('#Techne');
  });

  test('the app never reopens on a node that only borrows a room: it opens the last room actually opened', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'Techne');
    await openRoom(page, 'Relationships');
    await expect(page.locator('.sr-title')).toHaveText('Relationships');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('uni.tabs.v2') ?? '')).toContain('"borrowed":true');
    await page.reload();
    await expect(page.locator('.sr')).toHaveAttribute('data-node', 'Techne');
    await expect(page.locator('.sr-title')).toHaveText('Techne');
  });

  test('one vault per reference: in another vault a task\'s bare note id is read and opened there; a uni: one in Uni', async ({ page }) => {
    await boot(page, { lifeVault: 'life', ulidNext: true, vaultNotes: true });
    await unfoldAll(page);
    await scope(page).locator('.th-go[aria-label="Techne"], .th-go[aria-label^="Techne,"]').first().click();
    const row = page.locator('.cp-item').filter({ hasText: 'ATLAS follow-up' }).first();
    // r21: the row is both steps as words (one button, its notes open from the sheet)
    await expect(row.locator('.cp-lead')).toContainText('Follow-up notes');
    await expect(row.getByRole('button')).toHaveCount(1);
    await row.locator('.cp-need').click();
    const sheet = taskDialog(page);
    await expect(sheet.getByRole('button', { name: 'Morning pages' })).toBeVisible();
    const reads = await calls(page, 'vault_note');
    const bare = reads.filter((a: any) => a.noteRef === '01M3ZK2R6A6C62M1ANJCSQNG3N');
    expect(bare.length).toBeGreaterThan(0);
    expect(bare.every((a: any) => a.vault === 'life')).toBe(true);
    expect(reads.filter((a: any) => a.noteRef === '01M3ZK2R6A6C62M1ANJCSQNG3M').every((a: any) => a.vault === 'uni')).toBe(true);
    // the title's note opens in the same vault it was read from
    const before = (await calls(page, 'vault_note')).length;
    await sheet.getByRole('button', { name: 'Morning pages' }).click();
    await expect(page.locator('.note-sheet')).toBeVisible();
    await expect(page.locator('.note-sheet')).not.toContainText(/not found/i);
    const opened = (await calls(page, 'vault_note')).slice(before).filter((a: any) => a.noteRef === '01M3ZK2R6A6C62M1ANJCSQNG3N');
    expect(opened.length).toBeGreaterThan(0);
    expect(opened.every((a: any) => a.vault === 'life')).toBe(true);
  });

  test('an action line is the whole action everywhere (r21: up to three lines, never cut inside its object); all of the step is in the sheet', async ({ page }) => {
    await boot(page, { longNext: true });
    await openRoom(page, 'COhere 2026');
    await openCompanion(page);
    // r30: the row is the whole step, every word of it (it wraps; nothing after the first sentence is left to the sheet)
    const whole = /^Try the new check-in flow at example\.invalid and answer the three questions\. First question: .* and where do they stand\?$/;
    const cpLead = page.locator('.cp-body .cp-item').filter({ hasText: 'Try the new check-in flow' }).locator('.cp-lead');
    await expect(cpLead).toHaveText(whole);
    await expect(cpLead).not.toHaveAttribute('data-cut', 'true');
    await expect(page.locator('.cp-body .cp-item').filter({ hasText: 'Try the new check-in flow' }).getByRole('button', { name: 'More' })).toHaveCount(0);
    await openWorkView(page); await narrowWork(page);
    const lead = page.locator('.sr-work .cp-item').filter({ hasText: 'Try the new check-in flow' }).locator('.cp-lead');
    await expect(lead).toHaveText(whole);
    await page.locator('.sr-work .cp-item').filter({ hasText: 'Try the new check-in flow' }).locator('.cp-need').click();
    await expect(page.locator('.task-sheet h2')).toContainText('where do they stand?');
  });

  test('a failed refresh says what the kept count is as of, never "at least"; an overdue row says "was due"', async ({ page }) => {
    await boot(page, { pastDue: true });
    await openRoom(page, 'COhere 2026');
    await openWork(page);
    const wv = page.locator('.sr-work');
    await expect(wv.locator('.cp-item').filter({ hasText: 'COhere festival readiness' }).locator('.cp-detail.overdue')).toHaveText('was due Oct 7');
    const n = await wv.locator('section[aria-label="Needs you"] .wv-n').innerText();
    await page.evaluate(() => { (window as any).__queryFails = ['task']; });
    await refresh(page, '2026-10-09T10:02:00.000Z');
    const line = wv.locator('.lh-line').filter({ hasText: "Couldn't refresh" });
    await expect(line).toHaveText(new RegExp(`^${n} as of \\d{1,2}:\\d{2}\\s?[AP]M · Couldn't refresh · Retry$`));
    await expect(wv.locator('section[aria-label="Needs you"] .wv-n')).toHaveText(n);
    await expect(wv.locator('section[aria-label="Needs you"] .wv-n')).toHaveAttribute('aria-label', new RegExp(`^${n} as of `));
    await expect(page.getByText(/at least/)).toHaveCount(0);
  });

  test('740×360: the first screen is the room, with Places in its header, not a full-screen list of places', async ({ page }) => {
    await page.setViewportSize({ width: 740, height: 360 });
    await boot(page);
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeHidden();
    await expect(page.locator('.sr')).toHaveAttribute('data-node', 'Uni');
    await expect(page.locator('.sr-chat')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Places' })).toBeVisible();
    await expect(page.locator('.th-phone-tree')).toHaveCount(0);
    expect(await fits(page)).toBe(true);
  });

  test('Search at 800×600 fits its panel: no sideways scroll, no Cancel beside the frame\'s Close, plain words', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 600 });
    await boot(page);
    await openRoom(page, 'Techne');
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Search' }).click();
    const panel = page.getByRole('dialog', { name: 'Search' }); // r19: the utility panels keep the one dialog contract
    const field = panel.getByRole('searchbox', { name: 'Search conversations and notes' });
    await expect(field).toBeVisible();
    expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    const [f, p] = [await field.boundingBox(), await panel.boundingBox()];
    expect(f!.x + f!.width).toBeLessThanOrEqual(p!.x + p!.width);
    await expect(panel.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
    await expect(panel).not.toContainText(/phone|Path prefix|Keyword|uni-1/);
    await panel.locator('.search-narrow > summary').click();
    await expect(panel.getByRole('button', { name: 'Exact words' })).toBeVisible();
    expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  });

  test('the task sheet\'s Tab wraps among the controls you can reach, never the closed Details\' priority buttons', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'COhere 2026');
    await openCompanion(page);
    await page.locator('.cp-body .cp-item').first().locator('.cp-need, .cp-lead').first().click();
    const sheet = taskDialog(page);
    await expect(sheet.locator('details.task-details')).toBeVisible();
    const hidden = () => page.evaluate(() => { const a = document.activeElement as HTMLElement | null; const d = a?.closest('details'); return !!d && !d.open && a!.tagName !== 'SUMMARY'; });
    const inside = () => page.evaluate(() => !!document.activeElement?.closest('.task-sheet'));
    for (let i = 0; i < 24; i++) { await page.keyboard.press(i % 5 === 4 ? 'Shift+Tab' : 'Tab'); expect(await hidden()).toBe(false); expect(await inside()).toBe(true); }
    // from the first control Shift+Tab lands on the last reachable one (r20: the footer's Close, the sheet's last part), never a hidden Now/Soon/Someday
    await sheet.focus();
    await page.keyboard.press('Shift+Tab');
    await expect(sheet.locator('.task-foot').getByRole('button', { name: 'Close' })).toBeFocused();
    await page.keyboard.press('Tab');
    expect(await inside()).toBe(true); expect(await hidden()).toBe(false);
    await expect(sheet.locator('.task-foot').getByRole('button', { name: 'Close' })).not.toBeFocused();
    // opened, its controls join the ring, and its last line is inside the sheet at 720px tall
    await page.setViewportSize({ width: page.viewportSize()!.width, height: 720 });
    await sheet.locator('details.task-details > summary').click();
    const last = sheet.locator('details.task-details > p').last();
    await expect(last).toBeVisible();
    await last.evaluate((el) => (el.closest('.task-body') ?? el.closest('.task-sheet'))!.scrollTo(0, 99999));
    const [l, s] = [await last.boundingBox(), await sheet.boundingBox()];
    expect(l!.y + l!.height).toBeLessThanOrEqual(s!.y + s!.height - 4);
  });

  test('an area that no longer exists stays inside the room shell, with the tree and the ways on', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'Techne');
    await page.evaluate(() => localStorage.setItem('uni.tabs.v2', JSON.stringify({ v: 1, tabs: [{ id: 'g', kind: 'area', path: 'Areas/Gone', title: 'Gone' }], active: 'g', recent: ['g'] })));
    await page.reload();
    await expect(page.locator('.sr-title')).toHaveText('This area no longer exists');
    if (wide(page)) await expect(page.locator('.th-roomnav')).toBeVisible();
    else await expect(page.getByRole('button', { name: 'Places' })).toBeVisible();
    await page.getByRole('button', { name: 'Open Uni' }).click();
    // a phone held upright opens Uni on its tree; elsewhere Uni's room
    if (wide(page)) await expect(page.locator('.sr')).toHaveAttribute('data-node', 'Uni');
    else await expect(page.locator('.th-phone-tree')).toBeVisible();
  });
});

test.describe('r16', () => {
  const openWork = async (page: Page) => { await openCompanion(page); await page.getByRole('button', { name: /^All of .*'s work/ }).click(); await expect(page.locator('.sr-work')).toBeVisible(); };
  const refresh = async (page: Page, at: string) => { await page.clock.setFixedTime(Date.parse(at)); await page.evaluate(() => window.dispatchEvent(new Event('focus'))); };
  const taskId = (page: Page, title: RegExp) => page.evaluate((src) => (window as any).__tasks.find((t: any) => new RegExp(src).test(t.path)).id, title.source);
  const stampOf = (page: Page, id: string) => page.evaluate((i) => (window as any).__tasks.find((t: any) => t.id === i).updatedAt, id);
  const openSheetFor = async (page: Page, text: string) => { await openCompanion(page); await page.locator('.cp-body .cp-item').filter({ hasText: text }).locator('.cp-need, .cp-lead').first().click(); const sheet = page.getByRole('dialog').filter({ has: page.locator('.task-sheet, .task-kind') }); await answersOpen(sheet); return sheet; };

  test('tasks show before Running and Drafts are read; the work view says it is still checking, never "nothing is moving"', async ({ page }) => {
    await page.addInitScript(() => { (window as any).__tagDelay = { run: 60_000, draft: 60_000 }; });
    await boot(page);
    await openRoom(page, 'ATLAS');
    await openCompanion(page);
    // the list is on screen while the ledger and the drafts are still being read
    await expect(page.locator('.cp-body .cp-item').filter({ hasText: 'SOW for the commons grant' })).toBeVisible();
    await expect(page.locator('.cp-body section[aria-label="Running"]')).toHaveCount(0);
    await page.getByRole('button', { name: /^All of .*'s work/ }).click();
    const wv = page.locator('.sr-work');
    await expect(wv.locator('section[aria-label="Needs you"] .cp-item').first()).toBeVisible();
    await expect(wv.getByText("Checking what's running…")).toBeVisible();
    await expect(wv.getByText('Nothing is moving here right now.')).toHaveCount(0);
    // a failed activity read says so, with Retry, never an empty "nothing is moving"
    await page.evaluate(() => { (window as any).__tagDelay = {}; (window as any).__queryFails = ['run']; });
    await refresh(page, '2026-10-09T10:01:00.000Z');
    await expect(wv.locator('.lh-line').filter({ hasText: "Couldn't check what's running" })).toContainText('Retry');
    await expect(wv.getByText('Nothing is moving here right now.')).toHaveCount(0);
  });

  test('a load that runs long says "Still loading · Retry", and Retry reads again; the next launch paints the saved list at once with its age', async ({ page }, info) => {
    test.skip(!['mac', 'mac-small', 'phone'].includes(info.project.name), 'needs the test-hooks build (window.__slowMs): the simple config');
    await page.addInitScript(() => { (window as any).__slowMs = 400; if (!sessionStorage.getItem('r16-second')) (window as any).__tasksDelay = 60_000; });
    await boot(page);
    await openRoom(page, 'ATLAS');
    if (!wide(page)) await expect(page.locator('.cp-line-text')).toHaveText(/Still loading/);
    await openCompanion(page);
    const slow = page.locator('.cp-body .lh-line').filter({ hasText: 'Still loading what needs you' });
    await expect(slow).toBeVisible();
    await expect(page.locator('.cp-body').getByText('Loading…', { exact: true })).toHaveCount(0);
    await page.evaluate(() => { (window as any).__tasksDelay = 0; });
    await slow.getByRole('button', { name: 'Retry' }).click();
    await expect(page.locator('.cp-body .cp-item').filter({ hasText: 'SOW for the commons grant' })).toBeVisible();
    // kept on the device for this identity and vault, then read again on the next launch: shown at once, with its age
    await expect.poll(() => page.evaluate(() => (localStorage.getItem('uni.tasks.saved.v1') ?? '').includes('SOW for the commons grant'))).toBe(true);
    await page.evaluate(() => sessionStorage.setItem('r16-second', '1'));
    await page.addInitScript(() => { (window as any).__tasksDelay = 60_000; });
    await page.reload();
    await openRoom(page, 'ATLAS');
    await openCompanion(page);
    await expect(page.locator('.cp-body .cp-item').filter({ hasText: 'SOW for the commons grant' })).toBeVisible();
    const health = wide(page) ? page.locator('.cp-body .lh-line') : page.locator('.sr-health .lh-line');
    await expect(health.filter({ hasText: /as of \d{1,2}:\d{2}\s?[AP]M · (refreshing…|Still loading · Retry)$/ })).toBeVisible();
    await expect(health.filter({ hasText: /Still loading · Retry$/ })).toBeVisible();
  });

  test('a short window keeps the conversation: the strip starts folded whatever was saved, and opens as a sheet over the room', async ({ page }) => {
    for (const [w, h] of [[800, 600], [740, 360]] as const) {
      await page.setViewportSize({ width: w, height: h });
      // the strip was left open on this device; each size starts at Uni (not the room the last size reopened)
      await page.addInitScript(() => { localStorage.setItem('uni.companion.strip.v1', '1'); localStorage.removeItem('uni.tabs.v2'); localStorage.removeItem('uni.lastRoom.v1'); });
      await boot(page);
      await openRoom(page, 'ATLAS');
      const line = page.locator('.cp-line');
      await expect(line).toHaveAttribute('aria-expanded', 'false');
      const composer = page.locator('.sr-chat .composer');
      const inView = async () => { const b = (await composer.boundingBox())!; return b.y >= 0 && b.y + b.height <= h + 1; };
      expect(await inView()).toBe(true);
      await line.click();
      // too little room beside the composer and 40% of the room for the conversation: a sheet over the room, whole sections, Escape closes
      await expect(page.locator('.cp.strip')).toHaveAttribute('data-place', 'sheet');
      const sheet = page.getByRole('dialog', { name: 'Where this stands' });
      await expect(sheet).toBeVisible();
      await expect(sheet.locator('section[aria-label="Needs you"]')).toBeVisible();
      expect(await inView()).toBe(true);
      await page.keyboard.press('Escape');
      await expect(sheet).toHaveCount(0);
      await expect(line).toHaveAttribute('aria-expanded', 'false');
    }
  });

  test('a phone\'s strip opens one panel over the room, never inline (r28); its footer is outside what scrolls, so no row is under it', async ({ page }) => {
    test.skip(wide(page), 'the strip is below 900px');
    await boot(page, { crowded: true });
    await openRoom(page, 'COhere 2026');
    await page.locator('.cp-line').click();
    await expect(page.locator('.cp.strip')).toHaveAttribute('data-place', 'sheet');
    await expect(page.locator('.cp-strip-body')).toHaveCount(0);
    const geo = await page.evaluate(() => { const s = document.querySelector('.cp-sheet .cp-scroll')!.getBoundingClientRect(); const f = document.querySelector('.cp-sheet > .cp-foot')!.getBoundingClientRect(); return { within: s.bottom <= f.top + 0.5 }; });
    expect(geo.within).toBe(true);
  });

  test('"I did this", Archive and Undo are written against the revision shown; a task changed since stays open and says so', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'ATLAS');
    const id = await taskId(page, /SOW for the commons grant/);
    const seen = await stampOf(page, id);
    let sheet = await openSheetFor(page, 'SOW for the commons grant');
    await sheet.getByRole('button', { name: 'I did this' }).click();
    await expect(taskDialog(page)).toHaveCount(0);
    const done = (await calls(page, 'vault_transition')).at(-1);
    expect(done).toEqual({ vault: 'uni', id, from: 'open', to: 'done', ifUpdatedAt: seen, metadata: { answered_rev: seen } }); // r26: the answer records the revision it answered
    // Undo goes back against the revision the first write returned
    const wrote = await stampOf(page, id);
    expect(wrote).not.toBe(seen);
    await page.locator('.undo-bar').getByRole('button', { name: 'Undo' }).click();
    await expect.poll(async () => (await calls(page, 'vault_transition')).length).toBe(2);
    expect((await calls(page, 'vault_transition')).at(-1)).toEqual({ vault: 'uni', id, from: 'done', to: 'open', ifUpdatedAt: wrote });
    await openCompanion(page);
    await expect(page.locator('.cp-body .cp-item').filter({ hasText: 'SOW for the commons grant' })).toBeVisible();
    if (!wide(page)) { await page.keyboard.press('Escape'); await expect(page.locator('.cp-sheet')).toHaveCount(0); }
    // Uni rewrites the step while the sheet is open (the state is unchanged): "I did this" is refused, the sheet stays with the latest
    await refresh(page, '2026-10-09T10:01:00.000Z');
    sheet = await openSheetFor(page, 'SOW for the commons grant');
    await page.evaluate((i) => (window as any).__setTask(i, { next: 'Confirm the new scope with Casey and Priya' }), id);
    await sheet.getByRole('button', { name: 'I did this' }).click();
    await expect(sheet.locator('.task-changed')).toHaveText(/This changed since you opened it/);
    await expect(sheet).toContainText('Confirm the new scope with Casey and Priya');
    expect(await page.evaluate((i) => (window as any).__tasks.find((t: any) => t.id === i).metadata.state, id)).toBe('open');
    // Archive on the latest copy goes through, against its revision
    const latest = await stampOf(page, id);
    await sheet.getByRole('button', { name: 'Archive' }).click();
    await expect(taskDialog(page)).toHaveCount(0);
    expect((await calls(page, 'vault_transition')).at(-1)).toEqual({ vault: 'uni', id, from: 'open', to: 'archived', ifUpdatedAt: latest });
    // and an Archive against an old revision is refused the same way
    await refresh(page, '2026-10-09T10:02:00.000Z');
    const other = await taskId(page, /Grade the Week 6 reflections/);
    await openRoom(page, 'Learn Vibe Build');
    sheet = await openSheetFor(page, 'Grade the Week 6 reflections');
    await page.evaluate((i) => (window as any).__setTask(i, { due: '2026-10-16' }), other);
    await sheet.getByRole('button', { name: 'Archive' }).click();
    await expect(sheet.locator('.task-changed')).toBeVisible();
    expect(await page.evaluate((i) => (window as any).__tasks.find((t: any) => t.id === i).metadata.state, other)).toBe('open');
  });

  test('one title cleaner: no leading date or "(preview: …" in the companion, the work view or the sheet; a decision without its question reads "Decide: …"', async ({ page }) => {
    await boot(page, { cutNoAsk: true });
    await openRoom(page, 'ATLAS');
    const id = await taskId(page, /SOW for the commons grant/);
    await page.evaluate((i) => (window as any).__setTask(i, {}, 'T-07 2026-10-13 SOW for the commons grant (preview: the draft says the scope is…'), id);
    await refresh(page, '2026-10-09T10:01:00.000Z');
    await openCompanion(page);
    const row = page.locator('.cp-body .cp-item').filter({ hasText: 'SOW for the commons grant' });
    await expect(row).toBeVisible();
    await expect(row).not.toContainText('2026-10-13');
    await expect(row).not.toContainText('preview');
    await row.locator('.cp-need, .cp-lead').first().click();
    const sheet = taskDialog(page);
    await expect(sheet).toContainText('SOW for the commons grant');
    await expect(sheet).not.toContainText(/2026-10-13|preview/);
    await sheet.getByRole('button', { name: 'Close' }).last().click();
    await openWork(page);
    await expect(page.locator('.sr-work')).not.toContainText(/2026-10-13|\(preview/);
    // a cut decision with no question in its note: the verb first and whole words, never a fragment ending in "…" with nothing to act on
    await openRoom(page, 'COhere 2026');
    await openCompanion(page);
    const dq = page.locator('.cp-body .cp-need[data-mode="decide"] .cp-title').filter({ hasText: 'calendar email' });
    await expect(dq).toHaveText(/^Decide: a daily calendar email to people$/i);
    await expect(page.locator('.cp-body .cp-item').filter({ hasText: 'calendar email' }).locator('.cp-opt')).toHaveCount(0);
    for (const t of await page.locator('.cp-body .cp-need .cp-title').allInnerTexts()) expect(t.trim()).not.toMatch(/(…|\.\.\.)$/);
  });

  test('a step cut at the writer\'s 140 characters ends on a whole word with a way to the rest; a note that is only a heading and options is a whole question', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'ATLAS');
    const id = await taskId(page, /SOW for the commons grant/);
    // (r17: a step that names its questions says "Answer N questions" instead; this one names none)
    // (r19: the T-125 "Run /restart…" step this used is machinery now, Uni's to tidy; a real step of the same length)
    const cut = 'Send the SOW to Casey when convenient: attach the budget, the timeline and the scope notes so he can sign it off. Everything else in T-07 is';
    expect(cut.length).toBe(140);
    await page.evaluate(([i, n]) => (window as any).__setTask(i, { next: n }), [id, cut]);
    // the decision's note is only its heading (with a preview link) and its options
    await page.evaluate(() => { const t = (window as any).__tasks.find((x: any) => x.id === 'dq2'); t.path = 'Decisions/2026-10-13 Ship the ATLAS hosting? (preview:…'; t.content = '# Ship the ATLAS hosting? (preview: https://example.invalid/hosting)\n\n- Self-host\n- Managed'; t.updatedAt = new Date(Date.now() + 6000).toISOString(); });
    await refresh(page, '2026-10-09T10:01:00.000Z');
    await openCompanion(page);
    const row = page.locator('.cp-body .cp-item').filter({ hasText: 'Send the SOW to Casey when convenient' });
    // r21: the row is the whole action to its sentence's end; where three lines can't hold it, the cut falls after its first clause (whole,
    // "…when convenient"), never inside it, and never "…T-07 is"; the rest is in the note
    await expect(row.locator('.cp-lead')).toContainText(/^Send the SOW to Casey when convenient: attach the budget/);
    // r30: the row is every word stored but the cut one: a step of exactly the old writer's 140 characters loses its last word ("is"), no more
    await expect(row.locator('.cp-lead')).not.toHaveText(/\bis\s*…?$/);
    await expect(row.locator('.cp-lead')).toHaveText(/Everything else in T-07$/);
    await expect(row.getByRole('button', { name: 'The rest is in its note' })).toHaveCount(0); // r20: the sheet says it, the row has no "›"
    const dq = page.locator('.cp-body .cp-item').filter({ hasText: 'Ship the ATLAS hosting?' });
    await expect(dq.locator('.cp-title')).toHaveText('Ship the ATLAS hosting?');
    await row.locator('.cp-need').click();
    const sheet = taskDialog(page);
    // r23: as stored, no "…", and a plain line instead of an apology
    await expect(sheet.locator('.task-cut')).toHaveText('(the note ends here · open the note)');
    await expect(sheet.locator('.task-cut').getByRole('button', { name: 'open the note' })).toBeVisible();
  });

  test('Needs you is the user\'s (r17: and whatever waits on them, whoever holds it); a room\'s task waiting on someone else is in In motion', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'Learn Vibe Build');
    await openWork(page);
    const wv = page.locator('.sr-work');
    await expect(wv.locator('section[aria-label="Needs you"]')).toContainText('Grade the Week 6 reflections');
    await expect(wv.locator('section[aria-label="Needs you"] .cp-under[title*="Canvas Week 7 brief draft"]')).toHaveCount(1); // r18: one line, whole in its title
    await expect(wv.locator('section[aria-label="With others"]')).not.toContainText('Canvas Week 7 brief draft');
    const moving = wv.locator('section[aria-label="With others"] .cp-item').filter({ hasText: 'Final brief' });
    await expect(moving.locator('.cp-meta')).toHaveAttribute('title', /with #atlas\/teach/); // r18: one line of small print, whole in its title
    // the companion and the dots count the same
    const n = await wv.locator('section[aria-label="Needs you"] .wv-n').innerText();
    expect(Number(n)).toBe(await wv.locator('section[aria-label="Needs you"] .cp-item').count());
  });
});

test.describe('r17', () => {
  const refresh = async (page: Page, at: string) => { await page.clock.setFixedTime(Date.parse(at)); await page.evaluate(() => window.dispatchEvent(new Event('focus'))); };
  const openWork = async (page: Page) => { await openCompanion(page); await page.getByRole('button', { name: /^All of .*'s work/ }).click(); await expect(page.locator('.sr-work')).toBeVisible(); };
  /** A task or decision note added as Uni would write it (raw vault shape), read on the next refresh. */
  const add = (page: Page, n: { id: string; title: string; node: string; tag?: string; meta?: Record<string, unknown>; content?: string }) => page.evaluate((x) => {
    (window as any).__tasks.push({ id: x.id, path: `${x.tag === 'decision' ? 'Decisions' : 'Tasks'}/${x.title}`, extension: 'md', tags: [x.tag ?? 'task'], createdAt: '2026-10-10T08:00:00.000Z', updatedAt: '2026-10-14T08:00:00.000Z', lastUpdatedBy: 'u', lastUpdatedVia: 'mcp', content: x.content ?? x.title, metadata: { node: x.node, state: 'open', owner: 'aaron', ...(x.meta ?? {}) } });
  }, n);
  const sheetOf = (page: Page) => page.getByRole('dialog').filter({ has: page.locator('.task-kind') });

  test('work waiting on Aaron is in Needs you whatever its owner: his requested action leads, the owning task is a quiet line, and its dot lights', async ({ page }) => {
    await boot(page);
    await add(page, { id: 'w-uni', title: 'T-150 Newsletter W42 draft', node: 'Projects/Learn Vibe Build', meta: { owner: 'uni', state: 'waiting', waiting_on: 'aaron', next: 'Pick the lead story: the cohort or the grant' } });
    await refresh(page, '2026-10-09T10:01:00.000Z');
    await openRoom(page, 'Learn Vibe Build');
    await openCompanion(page);
    const needs = page.locator('.cp-body section[aria-label="Needs you"]');
    // a room's task (owner room:atlas/teach) and Uni's (owner uni), both waiting on Aaron
    const room = needs.locator('.cp-item').filter({ hasText: 'Your OK on the draft' });
    await expect(room).toBeVisible();
    await expect(room.locator('.cp-lead')).toHaveText(/^Your OK on the draft/);
    // r18: small print is one line of whole words (never ending on "·"), the whole of it in its title
    // r20: and the due cue, which is never cut
    await expect(room.locator('.cp-under')).toHaveAttribute('title', /^From #atlas\/teach · Canvas Week 7 brief draft(?: · (?:was )?due \w+ \d+)? · (?:asked|added) \w+ \d+$/);
    expect((await room.locator('.cp-under').innerText()).replace(/\s+/g, ' ').trim()).toMatch(/^From #atlas\/teach(?: · Canvas[\p{L}\d ]*)?…?(?:(?: ·)? (?:(?:was )?due \w+ \d+ · )?(?:asked|added) \w+ \d+)?$/u); // r22: a wrapped date line has no " · "
    expect((await room.locator('.cp-under').innerText()).trim()).not.toMatch(/·\s*…$/);
    const uni = needs.locator('.cp-item').filter({ hasText: 'Pick the lead story' });
    await expect(uni.locator('.cp-under')).toHaveAttribute('title', /^From Uni · Newsletter W42 draft · (?:asked|added) \w+( \d+)?$/); // r22: and when it was asked
    // the work view: in Needs you, never in In motion; the count is the companion's
    await openWork(page);
    const wv = page.locator('.sr-work');
    await expect(wv.locator('section[aria-label="Needs you"]')).toContainText('Your OK on the draft');
    await expect(wv.locator('section[aria-label="Needs you"]')).toContainText('Pick the lead story');
    await expect(wv.locator('section[aria-label="With others"]')).not.toContainText(/Canvas Week 7|Newsletter W42/);
    // its sheet: the action, the task it belongs to, whose task it is
    await wv.locator('.cp-item').filter({ hasText: 'Your OK on the draft' }).locator('.cp-lead').click();
    const sheet = sheetOf(page);
    await expect(sheet.locator('h2')).toHaveText(/Your OK on the draft/);
    await expect(sheet.locator('.task-record')).toContainText('Canvas Week 7 brief draft'); // r22: the title is in Details
    await expect(sheet.locator('.task-facts')).toContainText('Task of#atlas/teach');
    await page.keyboard.press('Escape');
    // the tree's dot for its node
    if (wide(page)) await expect(page.locator('.th-roomnav .th-go[aria-label^="Learn Vibe Build,"]')).toHaveAttribute('aria-label', /\d+ needs? you/);
  });

  test('"Say it in #room" only for the room; toward a person (r18) Copy copies a stored message, a destination leads only when written as one, else "Ask Uni to draft it"', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'ATLAS');
    const id = await page.evaluate(() => (window as any).__tasks.find((t: any) => /SOW for the commons grant/.test(t.path)).id);
    let minute = 0;
    const step = async (next: string, extra: Record<string, unknown> = {}) => { await page.evaluate(([i, n, x]) => (window as any).__setTask(i, { next: n, message: null, link: null, url: null, ...(x as object) }), [id, next, extra] as const); await refresh(page, `2026-10-09T10:${String(++minute).padStart(2, '0')}:00.000Z`); };
    const openIt = async (text: string) => { await openCompanion(page); await page.locator('.cp-body .cp-item').filter({ hasText: text }).locator('.cp-lead, .cp-need').first().click(); return sheetOf(page); };
    const textarea = page.locator('.sr-chat textarea');
    // no message stored: the sheet asks Uni to draft one (typed in the room, never sent), and never copies the bare instruction
    await step('Tell Sebastian the PTSA letter went out Oct 2, before the Oct 20 ZBA meeting (skip if already done).');
    let sheet = await openIt('Tell Sebastian');
    await expect(sheet.locator('h2')).toHaveText(/^Tell Sebastian the PTSA letter went out Oct 2/);
    await expect(sheet.getByRole('button', { name: /^Say it in/ })).toHaveCount(0);
    await expect(sheet.getByRole('button', { name: /^Copy/ })).toHaveCount(0);
    await expect(sheet.locator('.task-do.primary')).toHaveText('Ask Uni to draft it');
    await sheet.locator('.task-do.primary').click();
    await expect(textarea).toHaveValue(/^Please draft the message for T-\d+ .*Tell Sebastian the PTSA letter went out Oct 2/);
    expect(await calls(page, 'post_message')).toHaveLength(0);
    await textarea.fill('');
    // a stored message: "Copy the message" copies it, not the instruction
    await step('Tell Sebastian the PTSA letter went out Oct 2', { message: 'Hi Sebastian — I sent the PTSA letter on Oct 2, ahead of the Oct 20 ZBA hearing.' });
    sheet = await openIt('Tell Sebastian');
    await expect(sheet.locator('.task-do.primary')).toHaveText('Copy the message');
    await sheet.locator('.task-do.primary').click();
    await expect(sheet.locator('.task-do.primary')).toHaveText('Copied');
    const copied = (await page.evaluate(() => (window as any).__calls.filter((x: any) => /clipboard/.test(x.cmd)).map((x: any) => JSON.stringify(x.args)))) as string[];
    expect(copied.join('\n')).toContain('Hi Sebastian — I sent the PTSA letter');
    expect(copied.join('\n')).not.toContain('Tell Sebastian');
    await sheet.getByRole('button', { name: 'Close' }).click();
    // an address in the words is not a destination; one written as mailto: is
    await step('Email casey@example.org the scope summary');
    sheet = await openIt('Email casey@example.org');
    await expect(sheet.locator('.task-do.primary')).toHaveText('Ask Uni to draft it');
    await expect(sheet.getByRole('button', { name: /^Email casey/ })).toHaveCount(0);
    await sheet.getByRole('button', { name: 'Close' }).click();
    await step('Email mailto:casey@example.org the scope summary');
    sheet = await openIt('the scope summary');
    await expect(sheet.locator('.task-do.primary')).toHaveText('Email casey@example.org ›');
    await sheet.getByRole('button', { name: 'Close' }).click();
    // a `link` field is a destination; a URL inside the instruction is not
    await step('Tell Sebastian the letter is at https://example.org/letter.pdf');
    sheet = await openIt('Tell Sebastian');
    await expect(sheet.locator('.task-do.primary')).toHaveText('Ask Uni to draft it');
    await sheet.getByRole('button', { name: 'Close' }).click();
    await step('Tell Sebastian about the letter', { link: 'https://example.org/thread' });
    sheet = await openIt('Tell Sebastian');
    await expect(sheet.locator('.task-do.primary')).toHaveText('Open example.org ›');
    await sheet.getByRole('button', { name: 'Close' }).click();
    // for the room: "Say go…"
    await step('Say go to deploy #38 (companion) to production by Wed 10-14.');
    sheet = await openIt('Say go to deploy');
    await expect(sheet.locator('.task-do.primary')).toHaveText('Say it in #atlas/build ›');
    await sheet.locator('.task-do.primary').click();
    await expect(textarea).toHaveValue('Go to deploy #38 (companion) to production by Wed 10-14');
    expect(await calls(page, 'post_message')).toHaveLength(0);
    await textarea.fill('');
    // "Reply to …" a person: never "Say it"
    await step('Reply to Casey about the scope by Friday');
    sheet = await openIt('Reply to Casey');
    await expect(sheet.getByRole('button', { name: /^Say it in/ })).toHaveCount(0);
    await expect(sheet.locator('.task-do.primary')).toHaveText('Ask Uni to draft it');
    // housekeeping is quieter than the real action: r20, in the scrolling body above the footer that holds the action, never in the footer
    await expect(sheet.locator('.task-foot').getByRole('button', { name: 'Ask Uni to draft it' })).toBeVisible();
    await expect(sheet.locator('.task-foot').getByRole('button', { name: /^(Archive|Snooze until tomorrow)$/ })).toHaveCount(0);
    await expect(sheet.locator('.task-house').getByRole('button', { name: 'Archive' })).toBeVisible();
    await expect(sheet.locator('.task-house').getByRole('button', { name: 'Snooze until tomorrow' })).toBeVisible();
  });

  test('no approval buttons under a chat message; T-212: a message naming a decision carries its card, the same answers as its sheet', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'ATLAS');
    await page.evaluate(() => (window as any).__setTask('dq2', { task: 'T-140' }));
    await refresh(page, '2026-10-09T10:01:00.000Z');
    await page.evaluate((b) => (window as any).__arrive(b, 'Uni', '⚠️ Hermes wants to run a command that needs your OK\n```\nrm -rf build\n```\nReason: deletes files\nReply `/approve`, `/approve session`, `/approve always` or `/deny`.'), BUILD);
    await page.evaluate((b) => (window as any).__arrive(b, 'Uni', 'The hosting call is yours: self-host or managed. [decision T-140]'), BUILD);
    const chat = page.locator('.sr-chat');
    await expect(chat.locator('.message').filter({ hasText: 'needs your OK' })).toBeVisible();
    await expect(chat.locator('.approval-actions')).toHaveCount(0);
    await expect(chat.getByRole('button', { name: /Approve|Deny|This session|Always/ })).toHaveCount(0);
    const msg = chat.locator('.message').filter({ hasText: 'The hosting call is yours' });
    // the marker is not shown in the text; the card names the task it decides
    await expect(msg.locator('.md')).not.toContainText('T-140');
    await expect(msg.locator('.decision-kind')).toHaveText('Decision · T-140');
    await expect(msg.getByRole('group', { name: /^Pick one:/ }).getByRole('button')).toHaveText(['Self-host', 'Managed']);
    await expect(chat.locator('.message .decision-card')).toHaveCount(1);
    // the decision's sheet (Needs you) still answers it, with the same options
    await openCompanion(page);
    const sheet = await sheetAnswers(page, page.locator('.cp-body .cp-item').filter({ hasText: 'ATLAS hosting' }).first());
    await expect(sheet.getByRole('button')).toHaveText(['Self-host', 'Managed']);
  });

  test('Uni\'s panel is lighter: at most three rows, then one "N more ›" to the work view (private items folded in, said in its tooltip); the work view keeps the full list', async ({ page }) => {
    await boot(page, { crowded: true, privateTasks: true });
    await openRoom(page, 'Uni');
    await openCompanion(page);
    const body = page.locator('.cp-body').last();
    const needs = body.locator('section[aria-label="Needs you"]');
    const shown = await needs.locator('.cp-list > .cp-item').count();
    expect(shown).toBeGreaterThanOrEqual(1);
    expect(shown).toBeLessThanOrEqual(3);
    await expect(needs.locator('.cp-privates, .cp-private')).toHaveCount(0);
    await expect(needs).not.toContainText(/Sanctum: \d+ for you|in areas/);
    const more = needs.locator('.cp-more');
    await expect(more).toHaveCount(1);
    // r21: "Show N more", no "›"
    await expect(more).toHaveText(/^Show \d+ more$/);
    await expect(more).toHaveAttribute('title', 'Includes 1 item in a private area');
    const n = Number((await more.innerText()).match(/\d+/)![0]);
    await more.click();
    const wv = page.locator('.sr-work section[aria-label="Needs you"]');
    await expect(wv).toBeVisible();
    const total = Number(await wv.locator('.wv-n').innerText());
    expect(shown + n).toBe(total);
    expect(await wv.locator('.cp-item').count()).toBe(total); // every named row, and one line for the private area's one item
    await expect(wv.locator('.cp-private')).toHaveText('In Sanctum: 1 thing for you · open Sanctum');
  });

  test('a short window\'s strip sheet keeps "All of …\'s work" in sight however long the list, and closing it gives focus back to the strip', async ({ page }) => {
    for (const [w, h] of [[800, 600], [740, 360]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.addInitScript(() => { localStorage.removeItem('uni.tabs.v2'); localStorage.removeItem('uni.lastRoom.v1'); });
      await boot(page, { crowded: true });
      await openRoom(page, 'COhere 2026');
      const line = page.locator('.cp-line');
      await line.click();
      const sheet = page.getByRole('dialog', { name: /stands$/ });
      await expect(sheet).toBeVisible();
      expect(await sheet.locator('.cp-scroll').evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true); // r28: what is between the head and the footer scrolls
      const all = sheet.getByRole('button', { name: /^All of .*'s work/ });
      const b = (await all.boundingBox())!; const sb = (await sheet.boundingBox())!;
      expect(b.y + b.height).toBeLessThanOrEqual(sb.y + sb.height + 1);
      expect(b.y).toBeGreaterThanOrEqual(sb.y);
      await page.keyboard.press('Escape');
      await expect(sheet).toHaveCount(0);
      await expect(line).toBeFocused();
    }
  });

  test('920×360: no side panel squeezed beside the room (r19: the strip, folded, saying what waits); opened, it is a sheet of whole rows', async ({ page }) => {
    test.skip(!wide(page), 'a wide window');
    await page.addInitScript(() => { localStorage.setItem('uni.companion.side.narrow.v1', '1'); localStorage.removeItem('uni.tabs.v2'); localStorage.removeItem('uni.lastRoom.v1'); });
    await page.setViewportSize({ width: 920, height: 360 });
    await boot(page, { crowded: true, longNext: true, pastDue: true });
    await openRoom(page, 'COhere 2026');
    await expect(page.locator('.cp.side')).toHaveCount(0);
    for (const h of [360, 330, 300]) {
      await page.setViewportSize({ width: 920, height: h });
      await expect(page.locator('.cp.strip .cp-line-text'), `${h}px`).toHaveText(/^Needs you · \d+(?:: \S.*)?$/); // r28: the first request whole, or just the count: never part of it
    }
    await page.locator('.cp.strip .cp-line').click();
    const sheet = page.locator('.cp-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('.cp-list > .cp-item').first()).toBeVisible();
    // the sheet scrolls; nothing is cut at its edge by the panel's own measuring (all rows are drawn whole in the sheet)
    expect(await sheet.evaluate((el) => el.getBoundingClientRect().bottom <= innerHeight + 0.5)).toBe(true);
  });

  test('a cut action ends on a whole word, never on a colon (r23: and never with an ellipsis)', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'ATLAS');
    const id = await page.evaluate(() => (window as any).__tasks.find((t: any) => /SOW for the commons grant/.test(t.path)).id);
    await page.evaluate((i) => (window as any).__setTask(i, { next: 'Edit and send the draft to Theo and Dominic: the follow-up after the October twelfth session with the deck, the estimate and the open questions about the second phase and its budget and dates' }), id);
    await refresh(page, '2026-10-09T10:01:00.000Z');
    await openCompanion(page);
    const lead = page.locator('.cp-body .cp-item').filter({ hasText: 'Edit and send the draft' }).locator('.cp-lead');
    await expect(lead).toBeVisible();
    const text = (await lead.innerText()).replace(/\s+/g, ' ').trim();
    if (await lead.getAttribute('data-cut')) {
      expect(text).toMatch(/\p{L}$/u);
      expect(text).not.toMatch(/…/);
      expect(text).not.toMatch(/\b(the|and|to|of|with|its)$/i);
    }
  });
});

test.describe('r18', () => {
  const refresh = async (page: Page, at: string) => { await page.clock.setFixedTime(Date.parse(at)); await page.evaluate(() => window.dispatchEvent(new Event('focus'))); };
  /** A task or decision note added as Uni would write it (raw vault shape), read on the next refresh. */
  const add = (page: Page, n: { id: string; title: string; node: string; tag?: string; meta?: Record<string, unknown>; content?: string; path?: string; vault?: string }) => page.evaluate((x) => {
    (window as any).__tasks.push({ id: x.id, path: x.path ?? `${x.tag === 'decision' ? 'Decisions' : 'Tasks'}/${x.title}`, extension: 'md', tags: x.tag === 'none' ? [] : [x.tag ?? 'task'], createdAt: '2026-10-10T08:00:00.000Z', updatedAt: '2026-10-14T08:00:00.000Z', lastUpdatedBy: 'u', lastUpdatedVia: 'mcp', content: x.content ?? x.title, ...(x.vault ? { inVault: x.vault } : {}), metadata: x.tag === 'none' ? (x.meta ?? {}) : { node: x.node, state: 'open', owner: 'aaron', ...(x.meta ?? {}) } });
  }, n);
  const sheetOf = (page: Page) => page.getByRole('dialog').filter({ has: page.locator('.task-kind') });
  const openWork = async (page: Page) => { await openCompanion(page); await page.getByRole('button', { name: /^All of .*'s work/ }).click(); await expect(page.locator('.sr-work')).toBeVisible(); };
  const T11 = 'Merge RegenHub PRs #108 and #109 (both green), then answer the nine operational/editorial questions (door beep, hours, hero wording…) in the';

  test('a task never contradicts its own source: the RegenHub shape reads "Check: … is closed — still needed?", in the row and the sheet, never its merge step as current', async ({ page }) => {
    await boot(page);
    await add(page, { id: 'rh11', title: 'T-160 RegenHub site + newsletter systems', node: 'Projects/ATLAS', meta: { priority: 'now', state: 'waiting', waiting_on: 'aaron', next: T11 }, content: 'RegenHub site + newsletter systems\n\n**Next:** Aaron merges; still owes door beep / hours' });
    await add(page, { id: 'rh93', title: 'T-193 RegenHub: deployed fixes are not awaiting a merge', node: 'Projects/ATLAS', meta: { state: 'done', evidence: 'Merged into T-160 (same RegenHub asks: door beep, hours, hero wording)' }, content: 'RegenHub: deployed fixes are not awaiting a merge; nine answers remain.\n\n- Front-door beep?\n- Hours?' });
    await refresh(page, '2026-10-09T10:01:00.000Z');
    await openRoom(page, 'ATLAS');
    await openWork(page);
    const row = page.locator('.sr-work .cp-item').filter({ hasText: 'deployed fixes are not awaiting a merge' });
    // the source is read a moment after the list is on screen (then kept per revision): on a loaded phone that can pass 5 s
    await expect(row).toHaveAttribute('data-mode', 'check', { timeout: 15_000 });
    await expect(row.locator('.cp-title')).toHaveText(/^Check: “RegenHub: deployed fixes are not awaiting a merge” is closed — still needed\?$/); // r20: no "›"; the row opens its sheet
    await expect(row).not.toContainText('Merge RegenHub PRs');
    await expect(row.getByRole('button', { name: /^Answer \d+ questions?/ })).toHaveCount(0);
    await row.locator('.cp-need').click();
    const sheet = sheetOf(page);
    await expect(sheet.locator('h2')).toHaveText('Check: “RegenHub: deployed fixes are not awaiting a merge” is closed — still needed?');
    await expect(sheet.locator('.task-sub')).toHaveText('RegenHub site + newsletter systems');
    await expect(sheet.locator('.task-do.primary')).toHaveText('Open the note');
    await expect(sheet.getByRole('button', { name: 'I did this' })).toHaveCount(0);
    await expect(sheet.locator('.task-house').getByRole('button', { name: 'Archive' })).toBeVisible();
    await expect(sheet.locator('.task-house').getByRole('button', { name: 'Snooze until tomorrow' })).toBeVisible();
    // the doubted step is only under Details, never the lead
    await expect(sheet.locator('h2, .task-next')).not.toContainText('Merge RegenHub PRs');
    await sheet.locator('.task-do.primary').click();
    await expect(page.locator('.note-sheet')).toBeVisible();
    expect((await calls(page, 'vault_note')).some((a: any) => a.noteRef === 'rh93' && a.vault === 'uni')).toBe(true);
  });

  test('no answer from punctuation: "Which opening hours should we publish?" has no Yes/No; the row is "Your call: … ›" and the sheet answers in words', async ({ page }) => {
    await boot(page);
    await add(page, { id: 'hrs', title: 'Which opening hours should we publish?', node: 'Projects/ATLAS', tag: 'decision' });
    await add(page, { id: 'txt', title: 'Decision: texting is not recommended for this year because carrier…', node: 'Projects/ATLAS', tag: 'decision', content: 'Decision: texting is not recommended for this year because carrier approval may not clear before Oct 15.' });
    await add(page, { id: 'yn', title: 'Ship the ATLAS map this week?', node: 'Projects/ATLAS', tag: 'decision', meta: { options: ['yes', 'no'] } });
    await refresh(page, '2026-10-09T10:01:00.000Z');
    await openRoom(page, 'ATLAS');
    await openWork(page);
    const wv = page.locator('.sr-work section[aria-label="Needs you"]');
    const hours = wv.locator('.cp-item').filter({ hasText: 'Which opening hours' });
    await expect(hours.locator('.cp-need')).toHaveAttribute('aria-label', 'Your call: Which opening hours should we publish?');
    await expect(hours.getByRole('button', { name: /^(Yes|No)$/ })).toHaveCount(0);
    await expect(hours.locator('.cp-go')).toHaveCount(0); // r20: no "›" on a decision row; the whole row opens its sheet
    // r19: the texting statement asks nothing (no question, no options): Uni's to tidy, out of Needs you, never "Your call" or buttons
    await expect(wv).not.toContainText('exting is not recommended');
    await expect(page.locator('.sr-work .wv-tidy-line, .sr-work .wv-tidy')).toHaveCount(0);
    // Yes/No only where they are the stored options, written back as stored
    await expect(wv.locator('.cp-opt')).toHaveCount(0); // r20 (Codex 7): answers are in the sheet only
    await expect((await sheetAnswers(page, wv.locator('.cp-item').filter({ hasText: 'Ship the ATLAS map' }))).getByRole('button')).toHaveText(['Yes', 'No']);
    await page.keyboard.press('Escape');
    await hours.locator('.cp-need').click();
    const sheet = sheetOf(page);
    await expect(sheet.locator('.cp-opt')).toHaveCount(0);
    await expect(sheet.getByLabel('Answer in your words')).toBeVisible();
    await sheet.getByRole('button', { name: 'Close' }).click();
    await (await sheetAnswers(page, wv.locator('.cp-item').filter({ hasText: 'Ship the ATLAS map' }))).getByRole('button', { name: 'Yes' }).click();
    await expect.poll(async () => (await calls(page, 'vault_decide')).length).toBe(1);
    expect((await calls(page, 'vault_decide'))[0].metadata.decided).toBe('yes');
    expect((await calls(page, 'vault_decide')).some((c: any) => /^(agree|disagree)/.test(c.metadata.decided))).toBe(false);
  });

  test('the answer box is the same revision-guarded write as a tap: a decision changed since it was read is refused and the sheet keeps the question with the reason', async ({ page }) => {
    await boot(page);
    await add(page, { id: 'hrs', title: 'Which opening hours should we publish?', node: 'Projects/ATLAS', tag: 'decision' });
    await refresh(page, '2026-10-09T10:01:00.000Z');
    await openRoom(page, 'ATLAS');
    await openWork(page);
    await page.locator('.sr-work .cp-item').filter({ hasText: 'Which opening hours' }).locator('.cp-need').click();
    const sheet = sheetOf(page);
    const box = sheet.getByLabel('Answer in your words');
    await expect(sheet.getByRole('button', { name: 'Answer', exact: true })).toBeDisabled();
    // changed elsewhere after it was read
    await page.evaluate(() => (window as any).__setTask('hrs', { asked: '2026-10-09' }));
    await box.fill('Mon–Fri 9 to 5');
    await sheet.getByRole('button', { name: 'Answer', exact: true }).click();
    await expect(sheet.getByRole('alert')).toContainText(/changed or was decided elsewhere/);
    await expect(sheet.locator('h2')).toHaveText('Which opening hours should we publish?');
    expect(await page.evaluate(() => (window as any).__tasks.find((t: any) => t.id === 'hrs').metadata.state)).toBe('open');
    // read again: the answer is written against the new revision
    await sheet.getByRole('button', { name: 'Close' }).click();
    await refresh(page, '2026-10-09T10:02:00.000Z');
    await page.locator('.sr-work .cp-item').filter({ hasText: 'Which opening hours' }).locator('.cp-need').click();
    const rev = await page.evaluate(() => (window as any).__tasks.find((t: any) => t.id === 'hrs').updatedAt);
    await sheetOf(page).getByLabel('Answer in your words').fill('  Mon–Fri 9 to 5  ');
    await sheetOf(page).getByRole('button', { name: 'Answer', exact: true }).click();
    await expect.poll(async () => (await calls(page, 'vault_decide')).length).toBe(2);
    const last = (await calls(page, 'vault_decide'))[1];
    expect(last).toEqual({ vault: 'uni', id: 'hrs', from: 'open', to: 'decided', metadata: { decided: 'Mon–Fri 9 to 5', decided_at: expect.any(String), decided_by: expect.any(String), answered_rev: expect.any(String) }, ifUpdatedAt: rev });
    expect(await page.evaluate(() => (window as any).__tasks.find((t: any) => t.id === 'hrs').metadata.decided)).toBe('Mon–Fri 9 to 5');
  });

  test('"Answer N questions" only from an explicit source: a numbered plan is not questions, a wrapped item stays whole, a vault-prefixed note is read in its own vault', async ({ page }) => {
    await boot(page);
    // a numbered implementation plan, no Questions heading: no list is claimed
    await add(page, { id: 'plan', title: 'T-170 Door upgrade', node: 'Projects/ATLAS', meta: { priority: 'now', next: 'Answer the 3 door questions before Friday.' }, content: 'Door upgrade\n\n1. Merge #108\n2. Deploy\n3. Test the keypad\n' });
    // a list under "Questions", one item wrapped over two lines
    await add(page, { id: 'wrap', title: 'T-171 Hours and hero', node: 'Projects/ATLAS', meta: { priority: 'now', next: 'Answer the 2 hours questions.' }, content: 'Hours and hero\n\n## Questions for Aaron\n1. Front-door beep: silent keypad, leave it,\n   or disable native relock (needs a hold-open plan)?\n2. Published opening hours?\n\n## Next\n- later\n' });
    // the questions are in another vault's note, named with its prefix
    await add(page, { id: 'xv', title: 'T-172 Parachute design asks', node: 'Projects/ATLAS', meta: { priority: 'now', next: 'Answer the 2 design questions in parachute:01M3ZYXCP9QEM2GS0E5THMXXX9' }, content: 'Parachute design asks' });
    await add(page, { id: '01M3ZYXCP9QEM2GS0E5THMXXX9', title: 'Design questions', node: '', tag: 'none', path: 'Design/Questions for Aaron', vault: 'parachute', content: '## Questions\n- Reader?\n- Scope?' });
    await refresh(page, '2026-10-09T10:01:00.000Z');
    await openRoom(page, 'ATLAS');
    await openWork(page);
    const wv = page.locator('.sr-work');
    const plan = wv.locator('.cp-item').filter({ hasText: 'Answer the 3 door questions' });
    // r21 (Codex 10): the row is one button; what it says about its questions is a quiet line inside it, and the ways in are in the sheet
    await expect(plan.locator('.cp-questions')).toHaveText('Open the note to answer');
    await expect(plan.getByRole('button')).toHaveCount(1);
    await plan.locator('.cp-need').click();
    let sheet = sheetOf(page);
    await expect(sheet.locator('.task-q-list')).toHaveCount(0);
    await expect(sheet.getByRole('button', { name: 'Open the note to answer ›' })).toBeVisible();
    await sheet.getByRole('button', { name: 'Close' }).click();
    const wrap = wv.locator('.cp-item').filter({ hasText: 'Answer the 2 hours questions' });
    await expect(wrap.locator('.cp-questions')).toHaveText('Answer 2 questions');
    await wrap.locator('.cp-need').click();
    sheet = sheetOf(page);
    await expect(sheet.locator('.task-q-list li')).toHaveText(['Front-door beep: silent keypad, leave it, or disable native relock (needs a hold-open plan)?', 'Published opening hours?']);
    await sheet.getByRole('button', { name: 'Close' }).click();
    const xv = wv.locator('.cp-item').filter({ hasText: 'design questions' });
    await expect(xv.locator('.cp-questions')).toHaveText('Answer 2 questions');
    await xv.locator('.cp-need').click();
    sheet = sheetOf(page);
    await expect(sheet.locator('.task-q-list li')).toHaveText(['Reader?', 'Scope?']);
    await expect(sheet.locator('.task-q-note')).toContainText('From Questions for Aaron ›');
    const reads = (await calls(page, 'vault_note')).filter((a: any) => a.noteRef === '01M3ZYXCP9QEM2GS0E5THMXXX9');
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((a: any) => a.vault === 'parachute')).toBe(true);
  });

  test('Uni\'s companion: exactly three rows and one "N more ›", no per-row More; small print one line; a row opens its sheet', async ({ page }) => {
    await boot(page, { crowded: true, privateTasks: true, longNext: true });
    await openRoom(page, 'Uni');
    await openCompanion(page);
    const needs = page.locator('.cp-body').last().locator('section[aria-label="Needs you"]');
    // the side panel shows at most three (r30: a row is its whole step, so a short panel keeps two whole rows); the phone's inline strip keeps the rows that fit beside the conversation (r16), the rest in "N more"
    if (wide(page)) { const n = await needs.locator('.cp-list > .cp-item').count(); expect(n).toBeGreaterThanOrEqual(2); expect(n).toBeLessThanOrEqual(3); }
    else expect(await needs.locator('.cp-list > .cp-item').count()).toBeLessThanOrEqual(3);
    await expect(needs.locator('.cp-more')).toHaveCount(1);
    await expect(needs.locator('.cp-more')).toHaveText(/^Show \d+ more$/);
    await expect(needs.locator('.cp-row-more, .cp-item .cp-more-next')).toHaveCount(0);
    for (const u of await needs.locator('.cp-under, .cp-meta').all()) {
      const lines = await u.evaluate((e) => Math.round(e.getBoundingClientRect().height / (parseFloat(getComputedStyle(e).lineHeight) || 16)));
      // r22: when it was asked is on every row; rather than push out where the row belongs, the date part may take a second line
      expect(lines).toBeLessThanOrEqual(2);
    }
    await needs.locator('.cp-list > .cp-item').first().locator('.cp-need').first().click();
    await expect(sheetOf(page)).toBeVisible();
  });

  test('r18, r29: the summary carries its date and room: "Last written Oct 13 by #room:" in the companion and the work view, below Needs you; the heading adds no second date', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'ATLAS');
    await openCompanion(page);
    await expect(companion(page).getByText('Where this stands', { exact: true }).first()).toBeVisible();
    if (wide(page)) { await expect(companion(page).locator('.cp-asof')).toHaveText(/^Last written [A-Z][a-z]{2} \d+ by #\S+:$/); await expect(companion(page).locator('.cp-stands').first()).toHaveText(/^The SOW is drafted and waits on Casey\./); }
    await page.getByRole('button', { name: /^All of .*'s work/ }).first().click();
    const top = page.locator('.sr-work .wv-top');
    await expect(top.locator('.wv-stands-h')).toHaveText('Where this stands');
    await expect(top.locator('.cp-asof')).toHaveText(/^Last written [A-Z][a-z]{2} \d+ by #\S+:$/);
    await expect(top.locator('.wv-brief .cp-stands')).toHaveText(/^The SOW is drafted and waits on Casey\./);
    expect((await top.boundingBox())!.y).toBeGreaterThan((await page.locator('.sr-work').getByRole('region', { name: 'Needs you' }).boundingBox())!.y);
    await expect(top).toContainText('The SOW is drafted and waits on Casey.');
    await expect(top).not.toContainText(/Brief updated|updated \d+h ago/);
  });

  test('a stale progress line is an earlier update, folded; a fresh one stays a live status line', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'ATLAS');
    await page.evaluate((b) => (window as any).__arrive(b, 'Uni', '⏳ Working — 3 min — iteration 3, terminal', 2 * 86400), BUILD);
    await page.evaluate((b) => (window as any).__arrive(b, 'Uni', 'The SOW draft is in the note.'), BUILD);
    const chat = page.locator('.sr-chat');
    const past = chat.locator('.status-past');
    await expect(past).toHaveCount(1);
    await expect(past.locator('summary')).toContainText('Earlier progress update');
    await expect(past.locator('.status-past-body')).toBeHidden();
    await past.locator('summary').click();
    await expect(past.locator('.status-past-body')).toHaveText('⏳ Working — 3 min — iteration 3, terminal');
    await page.evaluate((b) => (window as any).__arrive(b, 'Uni', '⏳ Working — 1 min — iteration 1'), BUILD);
    await expect(chat.locator('.message.status-line:not(.status-past)')).toHaveText(/⏳ Working — 1 min/);
  });
});

test.describe('r19', () => {
  const refresh = async (page: Page, at: string) => { await page.clock.setFixedTime(Date.parse(at)); await page.evaluate(() => window.dispatchEvent(new Event('focus'))); };
  const add = (page: Page, n: { id: string; title: string; node: string; tag?: string; meta?: Record<string, unknown>; content?: string; path?: string }) => page.evaluate((x) => {
    (window as any).__tasks.push({ id: x.id, path: x.path ?? `${x.tag === 'decision' ? 'Decisions' : 'Tasks'}/${x.title}`, extension: 'md', tags: x.tag === 'none' ? [] : [x.tag ?? 'task'], createdAt: '2026-10-10T08:00:00.000Z', updatedAt: '2026-10-14T08:00:00.000Z', lastUpdatedBy: 'u', lastUpdatedVia: 'mcp', content: x.content ?? x.title, metadata: x.tag === 'none' ? (x.meta ?? {}) : { node: x.node, state: 'open', owner: 'aaron', ...(x.meta ?? {}) } });
  }, n);
  /** A supporting note changed as Uni would (its own metadata and revision), the task that links it untouched. */
  const setNote = (page: Page, id: string, meta: Record<string, unknown>) => page.evaluate(([i, m]) => { const n = (window as any).__tasks.find((x: any) => x.id === i); Object.assign(n.metadata, m); n.updatedAt = new Date(Date.now() + 8000).toISOString(); }, [id, meta] as const);
  const sheetOf = (page: Page) => page.getByRole('dialog').filter({ has: page.locator('.task-kind') });
  const openWork = async (page: Page) => { await openCompanion(page); await page.getByRole('button', { name: /^All of .*'s work/ }).click(); await expect(page.locator('.sr-work')).toBeVisible(); };
  const PLAN = '01M3ZR1RDJAZXTM6NQS74P8YS5';
  const STEP = `Approve or change the mail cutover plan (uni:${PLAN}).`;
  /** T-13's shape: a step that links the note it stands on. */
  const mailTask = async (page: Page, planMeta: Record<string, unknown> = {}) => {
    await add(page, { id: PLAN, title: 'Cutover plan', node: '', tag: 'none', path: 'Projects/Mail/Cutover plan — unforced.dev', meta: planMeta, content: 'The plan.' });
    await add(page, { id: 't13', title: 'T-13 Self-hosted mail: approved 10-02', node: 'Projects/ATLAS', meta: { priority: 'now', state: 'waiting', waiting_on: 'aaron', next: STEP, source: 'Aaron/Tasks#T-13' } });
  };
  const row13 = (page: Page) => page.locator('.sr-work section[aria-label="Needs you"] .cp-item').filter({ hasText: 'Self-hosted mail' });

  test('P1-1 nothing asserts an unchecked action: while the note a step stands on is read, the row and the sheet say "Checking what\'s needed…" (never the step, never "I did this")', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'ATLAS');
    await openWork(page);
    await page.evaluate((id) => { (window as any).__noteDelay = { [id]: 6000 }; }, PLAN);
    // watch the row from the moment the list arrives: the step must never be on screen before its note is read
    await page.evaluate(() => { const w = window as any; w.__sawStep = false; w.__watch = new MutationObserver(() => { for (const li of document.querySelectorAll('.sr-work .cp-item')) if (/Self-hosted mail/.test(li.textContent ?? '') && /Approve or change/.test(li.textContent ?? '')) w.__sawStep = true; }); w.__watch.observe(document.body, { subtree: true, childList: true, characterData: true }); });
    await mailTask(page);
    await refresh(page, '2026-10-09T10:01:00.000Z');
    const row = row13(page);
    await expect(row).toHaveAttribute('data-mode', 'checking');
    // r21: the row leads with its title, "Checking…" a quiet line under it; never the step
    await expect(row.locator('.cp-title')).toHaveText('Self-hosted mail: approved 10-02');
    await expect(row.locator('.cp-under')).toHaveText('Checking…');
    await row.locator('.cp-need').click();
    const sheet = sheetOf(page);
    await expect(sheet.locator('h2')).toHaveText("Checking what's needed…");
    await expect(sheet.getByRole('button', { name: 'I did this' })).toHaveCount(0);
    await expect(sheet.locator('.task-do.primary')).toHaveText('Open the note');
    await expect(sheet).not.toContainText('Approve or change');
    await sheet.getByRole('button', { name: 'Close' }).click();
    // until here (its note still being read) the step was never on screen
    expect(await page.evaluate(() => { const w = window as any; w.__watch.disconnect(); return w.__sawStep; })).toBe(false);
    expect(await page.evaluate(() => document.querySelector('.sr-work [data-mode="checking"]') !== null)).toBe(true);
    // read: the step leads, as it does for any checked task
    await expect(row).toHaveAttribute('data-mode', 'lead', { timeout: 10_000 });
    await expect(row.locator('.cp-lead')).toContainText('Approve or change the mail cutover plan');
  });

  test('P1-1 on a fresh device the first list paints "Checking…" for a task with a supporting note; a task that stands on none shows its step at once', async ({ page }) => {
    await page.addInitScript(([plan, step]) => {
      const w = window as any;
      w.__noteDelay = { [plan]: 60_000 };
      const at = '2026-10-09T09:00:00.000Z';
      w.__seedTasks = [
        { id: plan, path: 'Projects/Mail/Cutover plan — unforced.dev', extension: 'md', tags: [], createdAt: at, updatedAt: at, content: 'The plan.', metadata: {} },
        { id: 't13', path: 'Tasks/T-13 Self-hosted mail: approved 10-02', extension: 'md', tags: ['task'], createdAt: at, updatedAt: at, lastUpdatedVia: 'mcp', content: 'Mail', metadata: { node: 'Projects/ATLAS', state: 'waiting', owner: 'aaron', waiting_on: 'aaron', priority: 'now', next: step, source: 'Aaron/Tasks#T-13' } },
        { id: 't95', path: 'Tasks/T-95 Nico’s deploy access', extension: 'md', tags: ['task'], createdAt: at, updatedAt: at, lastUpdatedVia: 'mcp', content: 'Nico', metadata: { node: 'Projects/ATLAS', state: 'open', owner: 'aaron', priority: 'now', next: 'Send Nico the deploy-access message.' } },
      ];
    }, [PLAN, STEP] as const);
    await boot(page);
    await openRoom(page, 'ATLAS');
    await openWork(page);
    await expect(row13(page)).toHaveAttribute('data-mode', 'checking');
    await expect(row13(page)).not.toContainText('Approve or change');
    // r23: "Send Nico the deploy-access message." with no message stored asks the room for it
    await expect(page.locator('.sr-work .cp-item').filter({ hasText: /^\s*Ask #\S+ for the message/ })).toHaveAttribute('data-mode', 'lead');
  });

  test('P1-2 the source closes while the task stays unchanged: the next list read re-checks it and the row becomes a Check', async ({ page }) => {
    await boot(page);
    await mailTask(page);
    await refresh(page, '2026-10-09T10:01:00.000Z');
    await openRoom(page, 'ATLAS');
    await openWork(page);
    await expect(row13(page)).toHaveAttribute('data-mode', 'lead');
    const rev = await page.evaluate(() => (window as any).__tasks.find((t: any) => t.id === 't13').updatedAt);
    await setNote(page, PLAN, { superseded_by: 'Projects/Mail/Cutover plan v2' });
    await refresh(page, '2026-10-09T10:03:00.000Z');
    await expect(row13(page)).toHaveAttribute('data-mode', 'check');
    await expect(row13(page).locator('.cp-title')).toHaveText('Check: “Cutover plan — unforced.dev” was superseded — still needed?');
    expect(await page.evaluate(() => (window as any).__tasks.find((t: any) => t.id === 't13').updatedAt)).toBe(rev);
  });

  test('P1-2 a read that fails is "Couldn\'t check · Retry" (not ambiguous, not the step); Retry reads again and the row recovers', async ({ page }) => {
    await boot(page);
    await page.evaluate((id) => { (window as any).__noteFails = { [id]: true }; }, PLAN);
    await mailTask(page);
    await refresh(page, '2026-10-09T10:01:00.000Z');
    await openRoom(page, 'ATLAS');
    await openWork(page);
    const row = row13(page);
    await expect(row).toHaveAttribute('data-mode', 'unavailable');
    await expect(row.locator('.cp-checkfail')).toHaveText("Couldn't check · Retry");
    await expect(row).not.toContainText('Approve or change');
    await expect(row.getByRole('button', { name: 'Open the note to answer' })).toHaveCount(0);
    await row.locator('.cp-need').click();
    await expect(sheetOf(page).getByRole('button', { name: 'I did this' })).toHaveCount(0);
    await expect(sheetOf(page).locator('.task-checkfail')).toContainText("Couldn't check");
    await sheetOf(page).getByRole('button', { name: 'Close' }).click();
    await page.evaluate(() => { (window as any).__noteFails = {}; });
    // r21 (Codex 10): the row is one button; its tap retries and opens the sheet
    await expect(row.getByRole('button')).toHaveCount(1);
    await row.locator('.cp-need').click();
    await sheetOf(page).getByRole('button', { name: 'Close' }).click();
    await expect(row).toHaveAttribute('data-mode', 'lead');
    await expect(row.locator('.cp-lead')).toContainText('Approve or change');
  });

  test('P1-3 records that aren\'t real requests are Uni\'s to tidy: not in Needs you, not counted (r20: one quiet line, its titles read-only)', async ({ page }) => {
    await boot(page);
    await add(page, { id: 'f111', title: 'T-111 Fractal flow test: real work in area rooms, check updates…', node: 'Projects/ATLAS', meta: { priority: 'now', next: 'Fractal flow test: real work in area rooms, check updates propagate up; nested room names; app refresh for the tree' } });
    await add(page, { id: 'r125', title: 'T-125 Rooms write state: stands field, runs∕drafts∕decisions in…', node: 'Projects/ATLAS', meta: { priority: 'now', next: 'Run /restart when convenient: loads the uni-relay hook that closes run notes on [done|blocked|decision] markers.' } });
    await add(page, { id: 'mail', title: 'Mail: approve a test week, not an immediate cutover', node: 'Projects/ATLAS', tag: 'decision' });
    await refresh(page, '2026-10-09T10:01:00.000Z');
    await openRoom(page, 'ATLAS');
    await openCompanion(page);
    await expect(companion(page)).not.toContainText('Fractal flow test');
    await expect(companion(page)).not.toContainText('Run /restart');
    await page.getByRole('button', { name: /^All of .*'s work/ }).first().click();
    const needs = page.locator('.sr-work section[aria-label="Needs you"]');
    await expect(needs).not.toContainText('Fractal flow test');
    await expect(needs).not.toContainText('approve a test week');
    // r27: records that need rewording are not shown to the user (the rooms' business: console only)
    await expect(page.locator('.sr-work section[aria-label="Records to reword"]')).toHaveCount(0);
    await expect(page.locator('.sr-work')).not.toContainText(/rewording|Fractal flow test|approve a test week/);
  });

  test('a decision\'s stored options wrap inside its sheet and never run past its edge (r20, Codex 7: the companion\'s row has none)', async ({ page }) => {
    await boot(page);
    await add(page, { id: 'bvc', title: 'Ship the Boulder Votes AI chat?', node: 'Projects/ATLAS', tag: 'decision', meta: { priority: 'now', options: ['Add key and test live on preview first', 'Ship to production after live test', 'Change it first'] } });
    await refresh(page, '2026-10-09T10:01:00.000Z');
    await openRoom(page, 'ATLAS');
    await openCompanion(page);
    await expect(page.locator('.cp-body').last().locator('.cp-opt')).toHaveCount(0);
    const body = await sheetAnswers(page, page.locator('.cp-body').last().locator('.cp-item').filter({ hasText: 'Boulder Votes AI chat' }));
    const opts = body.locator('.cp-opt');
    await expect(opts.first()).toBeVisible();
    const edge = await body.evaluate((b) => b.closest('.task-sheet')!.getBoundingClientRect().right);
    for (const o of await opts.all()) {
      const r = await o.evaluate((e) => ({ right: e.getBoundingClientRect().right, clipped: e.scrollWidth > e.clientWidth + 1 }));
      expect(r.right).toBeLessThanOrEqual(edge + 0.5);
      expect(r.clipped).toBe(false);
    }
    await expect(opts.first()).toHaveText('Add key and test live on preview first');
  });

  test('the companion\'s rows have no stray "›": a "Your call" row opens its sheet as a whole', async ({ page }) => {
    await boot(page);
    await add(page, { id: 'hrs', title: 'Which opening hours should we publish?', node: 'Projects/ATLAS', tag: 'decision', meta: { priority: 'now' } });
    await refresh(page, '2026-10-09T10:01:00.000Z');
    await openRoom(page, 'ATLAS');
    await openCompanion(page);
    const row = page.locator('.cp-body').last().locator('.cp-item').filter({ hasText: 'Which opening hours' });
    await expect(row.locator('.cp-call-lead')).toHaveText('Your call:');
    await expect(row.locator('.cp-go')).toHaveCount(0);
    await row.locator('.cp-need').click();
    await expect(sheetOf(page).locator('h2')).toHaveText('Which opening hours should we publish?');
  });

  test('a sheet\'s text is cut by one rule at every size: the whole step, the title cut at the same words, the whole of it under Details', async ({ page }) => {
    await boot(page);
    const title = 'T-101 Tell Sebastian the PTSA letter is sent before the ZBA hearing on the twentieth, and that Finn has the copy, if that is not done';
    await add(page, { id: 't101', title, node: 'Projects/ATLAS', meta: { priority: 'now', next: 'Reply to Sebastian in your existing thread that the PTSA letter went out Oct 2, before the Oct 20 ZBA meeting (skip if already done).' } });
    await refresh(page, '2026-10-09T10:01:00.000Z');
    const seen: string[][] = [];
    for (const size of [{ width: 1440, height: 900 }, { width: 800, height: 600 }, { width: 740, height: 360 }]) {
      await page.setViewportSize(size);
      await openRoom(page, 'ATLAS');
      await openWork(page);
      await page.locator('.sr-work .cp-item').filter({ hasText: 'Reply to Sebastian' }).locator('.cp-lead').click();
      const sheet = sheetOf(page);
      // r22 (Codex 7): the title is no longer under the action; it is whole in Details
      seen.push([await sheet.locator('h2').innerText(), (await sheet.locator('.task-record').textContent()) ?? '']);
      await sheet.getByRole('button', { name: 'Close' }).click();
      await page.getByRole('button', { name: /Back to chat/ }).click();
    }
    expect(seen[1]).toEqual(seen[0]);
    expect(seen[2]).toEqual(seen[0]);
    expect(seen[0][0]).toBe('Reply to Sebastian in your existing thread that the PTSA letter went out Oct 2, before the Oct 20 ZBA meeting (skip if already done)');
    expect(seen[0][1]).toBe(`Task ${title.replace(/^(T-\d+) /, '$1: ')}`);
  });

  test('in a short window the sheet\'s primary action and "I did this" stay in view: a sticky footer', async ({ page }) => {
    await boot(page);
    await add(page, { id: 't101', title: 'T-101 Tell Sebastian the PTSA letter is sent, if not done…', node: 'Projects/ATLAS', meta: { priority: 'now', due: '2026-10-20', next: 'Reply to Sebastian in your existing thread that the PTSA letter went out Oct 2, before the Oct 20 ZBA meeting (skip if already done).' }, content: 'Tell Sebastian.\n\n' + 'Letter context. '.repeat(40) });
    await refresh(page, '2026-10-09T10:01:00.000Z');
    await page.setViewportSize({ width: 740, height: 360 });
    await openRoom(page, 'ATLAS');
    await openWork(page);
    await page.locator('.sr-work .cp-item').filter({ hasText: 'Reply to Sebastian' }).locator('.cp-lead').click();
    const sheet = sheetOf(page);
    await answersOpen(sheet);
    // measured once it has slid in (configs without reduced motion animate it)
    await sheet.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    for (const name of ['Ask Uni to draft it', 'I did this', 'Close']) {
      const b = await sheet.getByRole('button', { name, exact: true }).boundingBox();
      expect(b, name).not.toBeNull();
      expect(b!.y + b!.height, name).toBeLessThanOrEqual(360);
      expect(b!.y, name).toBeGreaterThanOrEqual(0);
    }
    const box = await sheet.boundingBox();
    expect(box!.y + box!.height).toBeLessThanOrEqual(360.5);
    // the sheet's text scrolls above the footer; Details is still there below
    await sheet.locator('.task-details summary').scrollIntoViewIfNeeded();
    await expect(sheet.getByRole('button', { name: 'I did this' })).toBeInViewport();
    await sheet.getByRole('button', { name: 'Close' }).click();
    // a decision's answers are its primary action: in the footer, whole and in view (found in the real app at 740×360)
    await add(page, { id: 'bvc', title: 'Ship the Boulder Votes AI chat?', node: 'Projects/ATLAS', tag: 'decision', meta: { priority: 'now', options: ['Add key and test live on preview first', 'Ship to production after live test', 'Change it first'] }, content: 'Ship the Boulder Votes AI chat?\n\n' + 'Context line. '.repeat(30) });
    await refresh(page, '2026-10-09T10:02:00.000Z');
    await page.locator('.sr-work .cp-item').filter({ hasText: 'Ship the Boulder Votes AI chat?' }).locator('.cp-need').click();
    const dec = sheetOf(page);
    for (const o of await dec.locator('.task-foot .cp-opt').all()) {
      const b = (await o.boundingBox())!;
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.y + b.height).toBeLessThanOrEqual(360);
    }
    await expect(dec.locator('.task-foot .cp-opt')).toHaveCount(3);
  });

  test('at 920×360 the folded companion still says what is waiting: "Needs you · N: <first request>" on the strip', async ({ page }) => {
    await page.setViewportSize({ width: 920, height: 360 });
    await boot(page);
    // the first request (overdue) has a link in its step: the line says its host, never a gap where the link was (found in the real app)
    await add(page, { id: 'look', title: 'T-113 Companion Today redesign', node: 'Projects/ATLAS', meta: { priority: 'now', due: '2026-10-01', next: 'Look at https://staging.example.invalid/?look=ecology on phone' } });
    await refresh(page, '2026-10-09T10:01:00.000Z');
    await openRoom(page, 'ATLAS');
    const line = page.locator('.cp.strip .cp-line');
    await expect(line).toHaveAttribute('aria-expanded', 'false');
    await expect(line.locator('.cp-line-text')).toHaveText(/^Needs you · \d+: Look at staging\.example\.invalid on phone/);
    await expect(page.locator('.cp.side')).toHaveCount(0);
  });

  test('one dialog contract: the task sheet and Settings take focus, keep Tab inside, make the room inert, close on Escape and give focus back', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'ATLAS');
    await openWork(page);
    const opener = page.locator('.sr-work section[aria-label="Needs you"] .cp-item').first().locator('.cp-need, .cp-lead').first();
    await opener.click();
    const sheet = sheetOf(page);
    await expect(sheet).toBeFocused();
    expect(await page.evaluate(() => !!document.querySelector('.sr[inert], .sr-work[inert], .rail[inert], .tree-home > .sr[inert]') || [...document.querySelectorAll('[inert]')].some((e) => e.contains(document.querySelector('.sr')!)))).toBe(true);
    for (let i = 0; i < 12; i++) { await page.keyboard.press('Tab'); expect(await page.evaluate(() => !!document.activeElement?.closest('.task-sheet'))).toBe(true); }
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    expect(await page.evaluate(() => document.querySelectorAll('[inert]').length)).toBe(0);
    if (wide(page) && await page.locator('.rail-settings').isVisible()) {
      await page.locator('.rail-settings').click();
      const panel = page.getByRole('dialog', { name: 'Settings' });
      await expect(panel).toBeVisible();
      expect(await page.evaluate(() => !!document.activeElement?.closest('aside.rooms'))).toBe(true);
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => !!document.activeElement?.closest('aside.rooms'))).toBe(true);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
      await expect(page.locator('.rail-settings')).toBeFocused();
    }
  });

  test('Uni\'s upkeep is not conversation: a self-improvement review, however long, folds into one closed "Uni\'s upkeep" line', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'ATLAS');
    const body = '💾 Self-improvement review: Background review may not delete memory entries unattended. The proposed batch was staged for your approval.\n\n- one\n- two\n- three\n- four';
    await page.evaluate(([b, t]) => (window as any).__arrive(b, 'Uni', t), [BUILD, body] as const);
    await page.evaluate((b) => (window as any).__arrive(b, 'Uni', 'The SOW draft is in the note.'), BUILD);
    const upkeep = page.locator('.sr-chat .status-upkeep');
    await expect(upkeep).toHaveCount(1);
    await expect(upkeep.locator('summary')).toContainText("Uni's upkeep");
    await expect(upkeep.locator('.status-past-body')).toBeHidden();
    await expect(page.locator('.sr-chat .message:not(.status-line)').filter({ hasText: 'Self-improvement review' })).toHaveCount(0);
  });

  test('Forget takes the device\'s kept checks and questions with it', async ({ page }) => {
    test.skip(!wide(page), 'Settings from the rail');
    await boot(page);
    await mailTask(page);
    await refresh(page, '2026-10-09T10:01:00.000Z');
    await openRoom(page, 'ATLAS');
    await openWork(page);
    await expect(row13(page)).toHaveAttribute('data-mode', 'lead');
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith('uni.checks.v1:')))).toBe(true);
    await page.evaluate(() => localStorage.setItem('uni.support.v1:old|uni', '[]'));
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Forget this device key', exact: true }).click();
    await page.getByRole('button', { name: /Tap again to forget/ }).click();
    await expect(page.locator('.pairing-card')).toBeVisible();
    expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => /^uni\.(checks|asks|support)\./.test(k)))).toEqual([]);
  });

  test('Back means one thing: it closes the open sheet first, then goes back a place', async ({ page }) => {
    test.skip(!treeBeside(page), 'the sidebar\'s Back sits beside the room on a wide window');
    await boot(page);
    await openRoom(page, 'ATLAS');
    await openWork(page);
    await page.locator('.sr-work section[aria-label="Needs you"] .cp-item').first().locator('.cp-need, .cp-lead').first().click();
    await expect(sheetOf(page)).toBeVisible();
    // the history Back (Alt+Left in the app) closes the sheet, and stays in ATLAS
    await page.keyboard.press('Alt+ArrowLeft');
    await expect(sheetOf(page)).toHaveCount(0);
    await expect(page.locator('.sr')).toHaveAttribute('data-node', 'ATLAS');
  });
});

test.describe('r20', () => {
  const refresh = async (page: Page, at: string) => { await page.clock.setFixedTime(Date.parse(at)); await page.evaluate(() => window.dispatchEvent(new Event('focus'))); };
  const add = (page: Page, n: { id: string; title: string; node: string; tag?: string; meta?: Record<string, unknown>; content?: string; path?: string }) => page.evaluate((x) => {
    (window as any).__tasks.push({ id: x.id, path: x.path ?? `${x.tag === 'decision' ? 'Decisions' : 'Tasks'}/${x.title}`, extension: 'md', tags: x.tag === 'none' ? [] : [x.tag ?? 'task'], createdAt: '2026-10-10T08:00:00.000Z', updatedAt: '2026-10-14T08:00:00.000Z', lastUpdatedBy: 'u', lastUpdatedVia: 'mcp', content: x.content ?? x.title, metadata: x.tag === 'none' ? (x.meta ?? {}) : { node: x.node, state: 'open', owner: 'aaron', ...(x.meta ?? {}) } });
  }, n);
  const sheetOf = (page: Page) => page.getByRole('dialog').filter({ has: page.locator('.task-kind') });
  const openWork = async (page: Page) => { await openCompanion(page); await page.getByRole('button', { name: /^All of .*'s work/ }).click(); await expect(page.locator('.sr-work')).toBeVisible(); };
  /** The real steps from the scratch copy (10-14), and the verb phrase each two-line row keeps whole. */
  const REAL = [
    { id: 'ww', title: 'Woven Web handoff note for Harper', next: 'Review the Woven Web handoff draft, fill the unknowns, then talk with Harper yourself.', verb: 'Review the Woven Web handoff draft', action: 'Review the Woven Web handoff draft, fill the unknowns' },
    { id: 'co', title: 'T-90 COhere opens Oct 15', next: 'Wed 10-14: say go on prod deploy of #38 + #58; Harper signs off the copy/photos before/after (posting today); yes/no on add-only DB…', verb: 'Say go', action: 'Say go on prod deploy of #38 + #58', due: '2026-10-14' },
    { id: 'at', title: 'T-138 Send the ATLAS Oct 12 follow-up email', next: 'Edit and send the ATLAS follow-up to Theo and Dominic from your account; fill the opening, sign-off and next-review date.', verb: 'Edit and send the ATLAS follow-up', action: null },
    { id: 'pay', title: '$10k COhere sponsorship invoice draft', next: 'Tell Uni who pays (Techne or Gitcoin Foundation) and how: crypto or ACH/Stripe, plus Woven Web\'s legal details.', verb: 'Tell Uni who pays', action: null },
  ];
  const seedReal = async (page: Page) => {
    for (const r of REAL) await add(page, { id: r.id, title: r.title, node: 'Projects/ATLAS', meta: { priority: 'now', next: r.next, ...(r.due ? { due: r.due } : {}) } });
    await refresh(page, '2026-10-14T09:00:00.000Z');
  };
  /** A rendered lead: its lines (by the words' tops) and its text. */
  const leadOf = (row: ReturnType<Page['locator']>) => row.locator('.cp-lead').evaluate((el) => ({ lines: new Set([...el.querySelectorAll<HTMLElement>('.wc-w')].map((w) => Math.round(w.getBoundingClientRect().top))).size, text: (el as HTMLElement).innerText.replace(/\s+/g, ' ').trim() }));

  test('rows say the whole action (r21, both critics): every real step\'s objects and recipients, within three lines, at the side panel\'s width and in the work view', async ({ page }) => {
    await boot(page);
    await seedReal(page);
    await openRoom(page, 'ATLAS');
    await openWork(page); await narrowWork(page);
    for (const r of REAL) {
      const row = page.locator('.sr-work section[aria-label="Needs you"] .cp-item').filter({ hasText: r.verb });
      await expect(row).toHaveAttribute('data-lead', 'action');
      const l = await leadOf(row);
      expect(l.text.replace(/^2 steps: /, '').startsWith(r.verb), `${r.title}: "${l.text}"`).toBe(true);
      // r30: the row is the whole step, every word of it ("; Harper signs off…" and "; fill the opening…" included), never clamped or cut
      const stored = r.next.replace(/^Wed 10-14:\s*/, '').replace(/…$|\.$/, '').trim();
      expect(l.text.toLowerCase(), r.title).toBe(stored.toLowerCase());
    }
    // COhere: the date label is not the lead; the subtitle is where it belongs and the due cue
    const co = page.locator('.sr-work .cp-item').filter({ hasText: 'Say go on prod deploy' });
    await expect(co.locator('.cp-lead')).toHaveText('Say go on prod deploy of #38 + #58; Harper signs off the copy/photos before/after (posting today); yes/no on add-only DB');
    await expect(co.locator('.cp-under')).toHaveAttribute('title', /^COhere opens Oct 15 · due today · (?:asked|added) (?:today|\w+ \d+)$/); // r22: and when it was asked
    await expect(co.locator('.cp-sub-when')).toHaveText(/^(?: · )?due today · (?:asked|added) (?:today|\w+ \d+)$/); // r22: a wrapped date line has no leading " · "
    // a subtitle that repeats the action is dropped (in its own area there is nothing else to say)
    // (r22: only when it was asked is left)
    await expect(page.locator('.sr-work .cp-item').filter({ hasText: 'Edit and send the ATLAS follow-up' }).locator('.cp-under')).toHaveText(/^\s*(?:asked|added) (?:today|\w+ \d+)$/);
    // the whole step is in the sheet
    await co.locator('.cp-need').click();
    await expect(sheetOf(page).locator('h2')).toHaveText('Say go on prod deploy of #38 + #58; Harper signs off the copy/photos before/after (posting today); yes/no on add-only DB'); // r30: the heading is the whole step, said once
    await sheetOf(page).getByRole('button', { name: 'Close' }).click();
  });

  test('a long host in an action reads as its first part in a row (found in the real app: it broke onto a third line at 236px); the row is one button and its sheet keeps the link', async ({ page }) => {
    await boot(page);
    await add(page, { id: 't113', title: 'T-113 Companion Today redesign + integrated PWA install flow (3 directions, then build the pick)', node: 'Projects/ATLAS', meta: { priority: 'now', due: '2026-10-13', next: 'Look at https://cohere-signup-staging.example-workers.invalid/?look=ecology on phone, then forward #cohere\'s \'For Harper\' block (posted 10-13)' } });
    await refresh(page, '2026-10-14T09:00:00.000Z');
    await openRoom(page, 'ATLAS');
    await openWork(page); await narrowWork(page);
    const row = page.locator('.sr-work .cp-item').filter({ hasText: 'Look at' });
    await expect(row.locator('.cp-lead')).toHaveText('Look at cohere-signup-staging on phone, then forward #cohere\'s \'For Harper\' block (posted 10-13)');
    await expect(row.locator('.cp-lead .cp-link')).toHaveText('cohere-signup-staging');
    await expect(row.locator('.cp-lead .cp-link')).toHaveAttribute('title', 'https://cohere-signup-staging.example-workers.invalid/?look=ecology');
    await expect(row.locator('a')).toHaveCount(0);
    // r22: the row is whole, as many lines as it needs; the sheet's step has the link as its button
    await row.locator('.cp-need').click();
    await expect(sheetOf(page).locator('.task-step-open')).toHaveAttribute('title', 'https://cohere-signup-staging.example-workers.invalid/?look=ecology');
  });

  test('P1-1 a missing prerequisite never authorizes an action: "Couldn\'t find … · Open the task", no action lead, no "I did this"', async ({ page }) => {
    await boot(page);
    await add(page, { id: 'mig', title: 'T-135 Migrate Uni to the new machine (Gigabyte Aero 16)', node: 'Projects/ATLAS', meta: { priority: 'now', next: 'OK the migration windows (gateway Wed, vaults Thu, Buzz+mail Sat)', depends_on: '[[Projects/Mail/Migration runbook]]' } });
    await refresh(page, '2026-10-14T09:00:00.000Z');
    await openRoom(page, 'ATLAS');
    await openWork(page);
    const row = page.locator('.sr-work .cp-item').filter({ hasText: 'Migrate Uni to the new machine' });
    await expect(row).toHaveAttribute('data-mode', 'missing');
    await expect(row.locator('.cp-title')).toHaveText('Couldn\'t find “Migration runbook” · Open the task');
    await expect(row).not.toContainText('OK the migration windows');
    await row.locator('.cp-need').click();
    const sheet = sheetOf(page);
    await expect(sheet.locator('h2')).toHaveText('Couldn\'t find “Migration runbook”');
    await expect(sheet.locator('.task-do.primary')).toHaveText('Open the task');
    await expect(sheet.getByRole('button', { name: 'I did this' })).toHaveCount(0);
    await expect(sheet.locator('h2, .task-next')).not.toContainText('OK the migration windows');
    await sheet.locator('.task-do.primary').click();
    await expect(page.locator('.note-sheet')).toBeVisible();
    expect(await calls(page, 'vault_transition')).toHaveLength(0);
  });

  test('P1-1 a decision has the same contract: a closed `source` is a Check, with no answers to tap', async ({ page }) => {
    await boot(page);
    const SRC = '01M41111111111111111111111';
    await add(page, { id: SRC, title: 'Chat plan', node: '', tag: 'none', path: 'Projects/Boulder Votes/Chat plan', meta: { state: 'done' } });
    await add(page, { id: 'bvc', title: 'Ship the Boulder Votes AI chat?', node: 'Projects/ATLAS', tag: 'decision', meta: { priority: 'now', options: ['Ship it', 'Wait'], source: `uni:${SRC}` } });
    await refresh(page, '2026-10-14T09:00:00.000Z');
    await openRoom(page, 'ATLAS');
    await openWork(page);
    const row = page.locator('.sr-work .cp-item').filter({ hasText: 'Chat plan' });
    await expect(row).toHaveAttribute('data-mode', 'check', { timeout: 10_000 });
    await expect(row.locator('.cp-title')).toHaveText('Check: “Chat plan” is closed — still needed?');
    await expect(row.locator('.cp-opt')).toHaveCount(0);
    await row.locator('.cp-need').click();
    const sheet = sheetOf(page);
    await expect(sheet.locator('h2')).toHaveText('Check: “Chat plan” is closed — still needed?');
    await expect(sheet.locator('.cp-opt, .task-answer-box')).toHaveCount(0);
    await expect(sheet.locator('.task-do.primary')).toHaveText('Open the note');
    expect(await calls(page, 'vault_decide')).toHaveLength(0);
  });

  test('P1-2 unknown decisions aren\'t owed: a cold list with three statement-only decisions counts 0, shows "Checking what\'s needed…" (never "Decide:"), and lights no dot until classified', async ({ page }) => {
    const titles = ['Uni adds Lenny\'s missing feature 4, the…', 'A daily email of the calendar at 7, with…', 'Texting Uni: a number that reaches…'];
    await page.addInitScript((ts) => {
      const w = window as any;
      const at = '2026-10-14T06:00:00.000Z';
      w.__noteDelay = Object.fromEntries(ts.map((_: string, i: number) => [`d${i}`, 5000]));
      w.__seedTasks = ts.map((t: string, i: number) => ({ id: `d${i}`, path: `Decisions/${t}`, extension: 'md', tags: ['decision'], createdAt: at, updatedAt: at, lastUpdatedVia: 'mcp', content: `Decision (needs your yes): ${t.replace(/…$/, '')} and the rest of the proposal.`, metadata: { node: 'Projects/Atlas Institute', state: 'open', owner: 'aaron' } }));
      // watch from the first paint: "Decide:" must never be on screen for these
      w.__sawDecide = false;
      new MutationObserver(() => { if (/Decide: (Uni adds|A daily email|Texting Uni)/.test(document.body?.innerText ?? '')) w.__sawDecide = true; }).observe(document, { subtree: true, childList: true, characterData: true });
    }, titles);
    await boot(page);
    await openRoom(page, 'Atlas Institute');
    await openWork(page);
    const needs = page.locator('.sr-work section[aria-label="Needs you"]');
    await expect(needs.locator('.cp-item[data-mode="checking"]')).toHaveCount(3);
    // r21 (both critics): a decision being checked leads with its question (here the title as words: found in the real app, "…feature 4,
    // the"), "Checking…" a quiet line under it, never its title
    expect((await needs.locator('.cp-item[data-mode="checking"] .cp-title').allInnerTexts()).sort()).toEqual(['A daily email of the calendar at 7', 'Texting Uni: a number that reaches', 'Uni adds Lenny\'s missing feature 4'].sort());
    await expect(needs.locator('.cp-item[data-mode="checking"] .cp-under')).toHaveText(['Checking…', 'Checking…', 'Checking…']);
    await expect(needs.locator('.wv-n')).toHaveText('0');
    if (treeBeside(page)) expect(await page.locator('.th-roomnav .th-go[aria-label^="Atlas Institute"]').getAttribute('aria-label')).not.toMatch(/need/);
    // classified: statements, so the rooms' to reword (not shown); still nothing owed
    await expect(needs.locator('.cp-item[data-mode="checking"]')).toHaveCount(0, { timeout: 15_000 });
    await expect(needs.locator('.cp-item')).toHaveCount(0);
    await expect(needs.locator('.wv-n')).toHaveText('0');
    expect(await page.evaluate(() => (window as any).__sawDecide)).toBe(false);
  });

  test('P2 checking finishes: 45 dependent tasks all resolve (bounded in how many read at once, never in how many)', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as any;
      const at = '2026-10-14T06:00:00.000Z';
      const id = (i: number) => `01M5${String(i).padStart(22, '0')}`;
      w.__seedTasks = Array.from({ length: 45 }, (_, i) => [
        { id: id(i), path: `Projects/Plans/Plan ${i}`, extension: 'md', tags: [], createdAt: at, updatedAt: at, content: 'plan', metadata: {} },
        { id: `t${i}`, path: `Tasks/T-${200 + i} Plan ${i}`, extension: 'md', tags: ['task'], createdAt: at, updatedAt: at, lastUpdatedVia: 'mcp', content: 'x', metadata: { node: 'Projects/Atlas Institute', state: 'open', owner: 'aaron', priority: 'now', next: `Approve or change plan ${i} (uni:${id(i)}).` } },
      ]).flat();
    });
    await boot(page);
    await openRoom(page, 'Atlas Institute');
    await openWork(page);
    const rows = page.locator('.sr-work section[aria-label="Needs you"] .cp-item');
    await expect(rows).toHaveCount(45);
    await expect(page.locator('.sr-work section[aria-label="Needs you"] .cp-item[data-mode="lead"]')).toHaveCount(45, { timeout: 20_000 });
  });

  test('P2 Uni\'s tidying stays Uni\'s: one quiet line, its titles read-only; nothing counts, carries "›" or types a request', async ({ page }) => {
    await boot(page);
    await add(page, { id: 'mail', title: 'Mail: approve a test week, not an immediate cutover', node: 'Projects/ATLAS', tag: 'decision' });
    await add(page, { id: 'r125', title: 'T-125 Rooms write state: stands field, runs∕drafts∕decisions in…', node: 'Projects/ATLAS', meta: { priority: 'now', next: 'Run /restart when convenient: loads the uni-relay hook that closes run notes on [done|blocked|decision] markers.' } });
    await add(page, { id: 'lenny', title: 'Decision (default yes): Uni adds Lenny\'s missing feature 4, the…', node: 'Projects/ATLAS', tag: 'decision', content: 'Decision (default yes): Uni adds Lenny\'s missing feature 4, the calendar view, this week.' });
    await refresh(page, '2026-10-14T09:00:00.000Z');
    await openRoom(page, 'ATLAS');
    await openWork(page);
    const n = await page.locator('.sr-work section[aria-label="Needs you"] .wv-n').innerText();
    // r27: not in the view at all; the count of what needs the user is unchanged by them
    await expect(page.locator('.sr-work .wv-tidy-line, .sr-work .wv-tidy')).toHaveCount(0);
    await expect(page.locator('.sr-work')).not.toContainText(/rewording|approve a test week/);
    await expect(page.locator('.sr-work section[aria-label="Needs you"] .wv-n')).toHaveText(n);
    await expect(page.getByText('Ask Uni to fix this record')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('tasks.py');
  });

  test('P2 no "›" on any decision or tidy row, in the companion and the work view alike: the whole row opens the sheet', async ({ page }) => {
    await boot(page, { cutNoAsk: true });
    await add(page, { id: 'hrs', title: 'Which opening hours should we publish?', node: 'Projects/ATLAS', tag: 'decision', meta: { priority: 'now' } });
    await add(page, { id: 'long', title: 'Should the ATLAS hosting move to the managed plan this quarter, given the grant timeline and the review in November, and who signs it off?', node: 'Projects/ATLAS', tag: 'decision', meta: { priority: 'now', options: ['Yes', 'No'] } });
    await refresh(page, '2026-10-09T10:01:00.000Z');
    await openRoom(page, 'ATLAS');
    await openCompanion(page);
    const decisionRows = (root: ReturnType<Page['locator']>) => root.locator('.cp-item').filter({ has: page.locator('.cp-need.decision') });
    for (const r of await decisionRows(page.locator('.cp-body').last()).all()) expect(await r.innerText()).not.toContain('›');
    await page.getByRole('button', { name: /^All of .*'s work/ }).click();
    const rows = decisionRows(page.locator('.sr-work'));
    expect(await rows.count()).toBeGreaterThan(1);
    for (const r of await rows.all()) expect(await r.innerText()).not.toContain('›');
    await rows.filter({ hasText: 'Which opening hours' }).locator('.cp-need').click();
    await expect(sheetOf(page).locator('h2')).toHaveText('Which opening hours should we publish?');
  });

  for (const size of [{ width: 800, height: 600 }, { width: 740, height: 360 }]) {
    test(`P2 ${size.width}×${size.height} opens on the chat; Places is a drawer you open, and a room picked there lands on its chat`, async ({ page }) => {
      await page.setViewportSize(size);
      await boot(page);
      await expect(page.locator('.sr')).toHaveAttribute('data-node', 'Uni');
      await expect(page.locator('.sr-chat')).toBeVisible();
      await expect(page.locator('.th-phone-tree, .areas-home')).toHaveCount(0);
      const places = page.getByRole('button', { name: 'Places' });
      await expect(places).toBeVisible();
      await places.click();
      const drawer = page.getByRole('dialog', { name: 'Rooms and places' });
      await expect(drawer).toBeVisible();
      await drawer.locator('.th-go[aria-label="Techne"], .th-go[aria-label^="Techne,"]').first().click();
      await expect(page.locator('.sr')).toHaveAttribute('data-node', 'Techne');
      await expect(page.locator('.sr-chat')).toBeVisible();
      await expect(drawer).toHaveCount(0);
    });
  }

  test('P2 (Codex 5) the narrow companion\'s sheet is a foreground surface: Back closes it first, and the place stays', async ({ page }) => {
    await page.setViewportSize({ width: 740, height: 360 });
    await boot(page);
    await openRoom(page, 'ATLAS');
    await page.locator('.cp.strip .cp-line').click();
    await expect(page.locator('.cp-sheet')).toBeVisible();
    await page.keyboard.press('Alt+ArrowLeft');
    await expect(page.locator('.cp-sheet')).toHaveCount(0);
    await expect(page.locator('.sr')).toHaveAttribute('data-node', 'ATLAS');
    expect(await page.evaluate(() => document.querySelectorAll('[inert]').length)).toBe(0);
  });

  for (const size of [{ width: 740, height: 360 }, { width: 920, height: 360 }]) {
    test(`P2 the sheet's foot fits at ${size.width}×${size.height}: "Snooze until tomorrow" sits in the scrolling body above the footer, never behind or below it`, async ({ page }) => {
      await page.setViewportSize(size);
      await boot(page);
      await add(page, { id: 't101', title: 'T-101 Tell Sebastian the PTSA letter is sent, if not done…', node: 'Projects/ATLAS', meta: { priority: 'now', due: '2026-10-20', next: 'Reply to Sebastian in your existing thread that the PTSA letter went out Oct 2, before the Oct 20 ZBA meeting (skip if already done).' }, content: 'Tell Sebastian.\n\n' + 'Letter context. '.repeat(40) });
      await refresh(page, '2026-10-14T09:00:00.000Z');
      await openRoom(page, 'ATLAS');
      await openWork(page);
      await page.locator('.sr-work .cp-item').filter({ hasText: 'Reply to Sebastian' }).locator('.cp-lead').click();
      const sheet = sheetOf(page);
      await answersOpen(sheet);
      await sheet.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
      // the footer is the sheet's last part: nothing after it
      expect(await sheet.evaluate((el) => el.lastElementChild?.classList.contains('task-foot'))).toBe(true);
      await sheet.evaluate((el) => el.scrollTo(0, 99999));
      const snooze = await sheet.getByRole('button', { name: 'Snooze until tomorrow' }).boundingBox();
      const foot = await sheet.locator('.task-foot').boundingBox();
      const box = await sheet.boundingBox();
      expect(snooze!.y + snooze!.height).toBeLessThanOrEqual(foot!.y + 0.5);
      expect(snooze!.y).toBeGreaterThanOrEqual(box!.y);
      expect(foot!.y + foot!.height).toBeLessThanOrEqual(size.height + 0.5);
      for (const name of ['I did this', 'Close']) await expect(sheet.locator('.task-foot').getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 1 });
    });
  }
});

test.describe('r21', () => {
  const refresh = async (page: Page, at: string) => { await page.clock.setFixedTime(Date.parse(at)); await page.evaluate(() => window.dispatchEvent(new Event('focus'))); };
  const add = (page: Page, n: { id: string; title: string; node: string; tag?: string; meta?: Record<string, unknown>; content?: string; path?: string }) => page.evaluate((x) => {
    (window as any).__tasks.push({ id: x.id, path: x.path ?? `${x.tag === 'decision' ? 'Decisions' : 'Tasks'}/${x.title}`, extension: 'md', tags: x.tag === 'none' ? [] : [x.tag ?? 'task'], createdAt: '2026-10-10T08:00:00.000Z', updatedAt: '2026-10-14T08:00:00.000Z', lastUpdatedBy: 'u', lastUpdatedVia: 'mcp', content: x.content ?? x.title, metadata: x.tag === 'none' ? (x.meta ?? {}) : { node: x.node, state: 'open', owner: 'aaron', ...(x.meta ?? {}) } });
  }, n);
  const sheetOf = (page: Page) => page.getByRole('dialog').filter({ has: page.locator('.task-kind') });
  const openWork = async (page: Page) => { await openCompanion(page); await page.getByRole('button', { name: /^All of .*'s work/ }).click(); await expect(page.locator('.sr-work')).toBeVisible(); };
  const leadOf = (row: ReturnType<Page['locator']>) => row.locator('.cp-lead').evaluate((el) => ({ lines: new Set([...el.querySelectorAll<HTMLElement>('.wc-w')].map((w) => Math.round(w.getBoundingClientRect().top))).size, text: (el as HTMLElement).innerText.replace(/\s+/g, ' ').trim(), cut: el.getAttribute('data-cut') === 'true', form: el.getAttribute('data-form') }));
  /** The real steps from the scratch copy (10-14), and what the row must hold whole (its object, its recipients, both steps). */
  const WHOLE = [
    { id: 'at', title: 'T-129 Send the ATLAS Oct 12 follow-up email', next: 'Edit and send the ATLAS follow-up to Theo and Dominic from your account; fill the opening, sign-off and next-review date.', has: ['Edit and send the ATLAS follow-up to Theo and Dominic from your account'] },
    { id: 'ww', title: 'T-67 Woven Web handoff note for Harper', next: 'Review the Woven Web handoff draft, fill the unknowns, then talk with Harper yourself.', has: ['Review the Woven Web handoff draft, fill the unknowns'], step2: 'then talk with Harper yourself' },
    { id: 'st', title: 'T-113 Companion Today redesign + integrated PWA install flow (3…', next: 'Look at https://cohere-signup-staging.example-workers.invalid/?look=ecology on phone, then forward #cohere\'s \'For Harper\' block (posted 10-13)', has: ['Look at cohere-signup-staging on phone'], step2: 'then forward #cohere\'s \'For Harper\' block' },
    { id: 'pay', title: 'T-65 $10k COhere sponsorship invoice draft', next: 'Tell Uni who pays (Techne or Gitcoin Foundation) and how: crypto or ACH/Stripe, plus Woven Web\'s legal details.', has: ['Tell Uni who pays', 'and how: crypto or ACH/Stripe, plus Woven Web\'s legal details'] },
    { id: 'co', title: 'T-90 COhere opens Oct 15', next: 'Wed 10-14: say go on prod deploy of #38 + #58; Harper signs off the copy/photos before/after (posting today); yes/no on add-only DB…', has: ['Say go on prod deploy of #38 + #58'], due: '2026-10-14' },
  ];
  const seed = async (page: Page, node = 'Projects/ATLAS') => {
    for (const r of WHOLE) await add(page, { id: r.id, title: r.title, node, meta: { priority: 'now', next: r.next, ...(r.due ? { due: r.due } : {}) } });
    await refresh(page, '2026-10-14T09:00:00.000Z');
  };
  /** A rendered row holds the whole action: its object and recipients, and both steps (or "2 steps: A, then …"), within three lines, never cut. */
  const assertWhole = async (row: ReturnType<Page['locator']>, r: (typeof WHOLE)[number]) => {
    const l = await leadOf(row);
    expect(l.lines, `${r.title}: "${l.text}"`).toBeLessThanOrEqual(3);
    expect(l.cut, `${r.title}: "${l.text}" is cut`).toBe(false);
    for (const h of r.has) expect(l.text, r.title).toContain(h);
    if (r.step2) expect(l.text.includes(r.step2) || (/^2 steps: /.test(l.text) && /, then …$/.test(l.text)), `${r.title}: "${l.text}" shows both steps`).toBe(true);
  };

  test('the whole action shows: ATLAS (both recipients), Woven Web, cohere-signup-staging (both steps), who pays, COhere opens Oct 15, at 236px and in the work view', async ({ page }) => {
    await boot(page);
    await seed(page);
    await openRoom(page, 'ATLAS');
    await openWork(page);
    for (const narrow of [false, true]) {
      if (narrow) await narrowWork(page);
      for (const r of WHOLE) await assertWhole(page.locator('.sr-work section[aria-label="Needs you"] .cp-item').filter({ hasText: r.has[0].slice(0, 20) }), r);
    }
    // the side panel at its own width: every action row it shows holds its whole action
    if (wide(page)) {
      await page.getByRole('button', { name: /Back to chat/ }).click();
      const body = page.locator('aside.cp.side .cp-body');
      const rows = body.locator('.cp-item[data-lead="action"]');
      expect(await rows.count()).toBeGreaterThan(0);
      for (const row of await rows.all()) {
        const t = (await leadOf(row)).text;
        const r = WHOLE.find((x) => t.includes(x.has[0].slice(0, 20)));
        if (r) await assertWhole(row, r);
      }
    }
  });

  test('a step in two parts: the sheet lists them, numbered, under "2 steps"; the rest of the step (its date) stays in the sheet', async ({ page }) => {
    await boot(page);
    await seed(page);
    await openRoom(page, 'ATLAS');
    await openWork(page);
    await page.locator('.sr-work .cp-item').filter({ hasText: 'Look at cohere-signup-staging' }).locator('.cp-need').click();
    const sheet = sheetOf(page);
    await expect(sheet.locator('h2')).toHaveText("Look at cohere-signup-staging.example-workers.invalid on phone, then forward #cohere's 'For Harper' block (posted 10-13)"); // r26: never "2 steps"
    await expect(sheet.locator('.task-steps li')).toHaveText(['Look at cohere-signup-staging.example-workers.invalid on phoneOpen cohere-signup-staging', 'Forward #cohere\'s \'For Harper\' block (posted 10-13)']);
    // r22 (Codex 7): the link is a button in its step
    await expect(sheet.locator('.task-step-open')).toHaveCount(1);
  });

  test('a decision being checked leads with its question; "Checking…" is a quiet line under it, and it isn\'t counted until it\'s classified', async ({ page }) => {
    const SRC = '01M41111111111111111111112';
    await page.addInitScript((src) => {
      const w = window as any;
      const at = '2026-10-14T06:00:00.000Z';
      w.__noteDelay = { [src]: 4000 };
      w.__seedTasks = [
        { id: src, path: 'Projects/Boulder Votes/Chat plan', extension: 'md', tags: [], createdAt: at, updatedAt: at, content: 'plan', metadata: {} },
        { id: 'bvq', path: 'Decisions/Ship the Boulder Votes AI chat?', extension: 'md', tags: ['decision'], createdAt: at, updatedAt: at, lastUpdatedVia: 'mcp', content: 'Ship the Boulder Votes AI chat?', metadata: { node: 'Projects/Atlas Institute', state: 'open', owner: 'aaron', priority: 'now', options: ['Ship it', 'Wait'], source: `uni:${src}` } },
      ];
      w.__sawChecking = false;
      new MutationObserver(() => { for (const t of document.querySelectorAll('.cp-item .cp-title')) if (/^Checking/.test(t.textContent ?? '')) w.__sawChecking = true; }).observe(document, { subtree: true, childList: true, characterData: true });
    }, SRC);
    await boot(page);
    await openRoom(page, 'Atlas Institute');
    await openWork(page);
    const needs = page.locator('.sr-work section[aria-label="Needs you"]');
    const row = needs.locator('.cp-item').filter({ hasText: 'Boulder Votes' });
    await expect(row).toHaveAttribute('data-mode', 'checking');
    await expect(row.locator('.cp-title')).toHaveText('Ship the Boulder Votes AI chat?');
    await expect(row.locator('.cp-under')).toHaveText('Checking…');
    await expect(needs.locator('.wv-n')).toHaveText('0');
    // classified: the same question, now owed and counted
    await expect(row).toHaveAttribute('data-mode', 'answers', { timeout: 10_000 });
    await expect(row.locator('.cp-title')).toHaveText('Ship the Boulder Votes AI chat?');
    await expect(needs.locator('.wv-n')).toHaveText('1');
    // "Checking…" was never a row's title
    expect(await page.evaluate(() => (window as any).__sawChecking)).toBe(false);
  });

  test('P1-1 a failed check never leaves an old instruction actionable: ok, then a failed refresh, then the action is gone (Couldn\'t check · Retry, no "I did this")', async ({ page }) => {
    const PLAN = '01M3ZR1RDJAZXTM6NQS74P8YS5';
    await boot(page);
    await add(page, { id: PLAN, title: 'Cutover plan', node: '', tag: 'none', path: 'Projects/Mail/Cutover plan — unforced.dev', content: 'The plan.' });
    await add(page, { id: 't13', title: 'T-13 Self-hosted mail: approved 10-02', node: 'Projects/ATLAS', meta: { priority: 'now', next: `Approve or change the mail cutover plan (uni:${PLAN}).` } });
    await refresh(page, '2026-10-14T09:00:00.000Z');
    await openRoom(page, 'ATLAS');
    await openWork(page);
    const row = page.locator('.sr-work section[aria-label="Needs you"] .cp-item').filter({ hasText: /Self-hosted mail|mail cutover plan/ });
    await expect(row).toHaveAttribute('data-mode', 'lead');
    await expect(row.locator('.cp-lead')).toContainText('Approve or change the mail cutover plan');
    // the note can't be read on the next refresh
    await page.evaluate((id) => { (window as any).__noteFails = { [id]: true }; }, PLAN);
    await refresh(page, '2026-10-14T09:02:00.000Z');
    await expect(row).toHaveAttribute('data-mode', 'unavailable');
    await expect(row.locator('.cp-lead')).toHaveCount(0);
    await expect(row).not.toContainText('Approve or change');
    await expect(row.locator('.cp-checkfail')).toHaveText('Couldn\'t check · Retry');
    await row.locator('.cp-need').click();
    const sheet = sheetOf(page);
    await expect(sheet.getByRole('button', { name: 'I did this' })).toHaveCount(0);
    await expect(sheet.locator('h2')).not.toContainText('Approve or change');
    await expect(sheet.locator('.task-checkfail')).toContainText('Couldn\'t check');
    await sheet.getByRole('button', { name: 'Close' }).click();
    // still failing: Retry (the row's tap) never brings the old ok back
    await expect(row).not.toHaveAttribute('data-mode', 'lead');
    await expect(row).not.toContainText('Approve or change');
    // a good read brings the action back
    await page.evaluate(() => { (window as any).__noteFails = {}; });
    await row.locator('.cp-need').click();
    await sheetOf(page).getByRole('button', { name: 'Close' }).click();
    await expect(row).toHaveAttribute('data-mode', 'lead', { timeout: 10_000 });
  });

  test('r27 (Codex P2-5): records that need rewording are the rooms\' business: logged to the console, never shown in the work view', async ({ page }) => {
    const logged: string[] = [];
    page.on('console', (m) => { if (/need rewording by their rooms/.test(m.text())) logged.push(m.text()); });
    await boot(page);
    await add(page, { id: 'mail', title: 'Mail: approve a test week, not an immediate cutover', node: 'Projects/ATLAS', tag: 'decision' });
    await add(page, { id: 'lenny', title: 'Decision (default yes): Uni adds Lenny\'s missing feature 4, the…', node: 'Projects/ATLAS', tag: 'decision', content: 'Decision (default yes): Uni adds Lenny\'s missing feature 4, the calendar view' });
    await refresh(page, '2026-10-14T09:00:00.000Z');
    await openRoom(page, 'ATLAS');
    await openWork(page);
    await expect(page.locator('.sr-work section[aria-label="Needs you"]')).toBeVisible();
    await expect(page.locator('.sr-work section[aria-label="Records to reword"]')).toHaveCount(0);
    await expect(page.locator('.sr-work')).not.toContainText(/rewording|approve a test week/);
    await expect.poll(() => logged.length).toBeGreaterThan(0);
    expect(logged.join('\n')).toMatch(/Mail: approve a test week, not an immediate cutover/);
  });

  test('no "›" on any row or link row: rows, "Sanctum: 1 for you", "Show N more"', async ({ page }) => {
    await boot(page, { crowded: true, privateTasks: true });
    await openRoom(page, 'Uni');
    await openCompanion(page);
    const body = page.locator('.cp-body').last();
    await expect(body.locator('.cp-more')).toHaveText(/^Show \d+ more$/);
    for (const el of await body.locator('.cp-item, .cp-more').all()) expect(await el.innerText()).not.toContain('›');
    await body.locator('.cp-more').click();
    const wv = page.locator('.sr-work');
    await expect(wv.locator('.cp-private')).toHaveText('In Sanctum: 1 thing for you · open Sanctum');
    for (const el of await wv.locator('.cp-item, .cp-more').all()) expect(await el.innerText()).not.toContain('›');
  });

  test('one target per visible request (Codex 10): every row is one keyboard-focusable button that opens its sheet, with nothing clickable inside it', async ({ page }) => {
    await boot(page, { crowded: true, ulidNext: true, longNext: true });
    await seed(page, 'Areas/Techne');
    await openRoom(page, 'Techne');
    await openWork(page);
    const rows = page.locator('.sr-work section[aria-label="Needs you"] .cp-list > .cp-item');
    expect(await rows.count()).toBeGreaterThan(4);
    for (const row of await rows.all()) {
      const focusable = await row.evaluate((el) => [...el.querySelectorAll<HTMLElement>('a[href], button, [tabindex]:not([tabindex="-1"]), input, select, textarea')].map((e) => ({ tag: e.tagName, cls: e.className, nested: !!e.parentElement?.closest('button, a') })));
      expect(focusable, await row.innerText()).toHaveLength(1);
      expect(focusable[0].tag).toBe('BUTTON');
      expect(focusable[0].nested).toBe(false);
    }
    // the keyboard reaches a row and Enter opens its sheet
    const first = rows.first().locator('.cp-need');
    await first.focus();
    await page.keyboard.press('Enter');
    await expect(sheetOf(page)).toBeVisible();
  });

  test('P2 (Codex 6) the Journal has no action strip under every entry: one menu per entry, as in the chat', async ({ page }) => {
    await page.addInitScript(() => { (window as any).__journal = [1, 2, 3].map((i) => ({ id: `j${i}`, path: `Journal/2026/10-1${i}/09-00 Test entry ${i}`, created_at: `2026-10-1${i}T15:00:00Z`, content: `A test entry, number ${i}.`, source: 'text', entry_id: null, tags: ['journal'], pending: false })); });
    if (!wide(page)) await page.setViewportSize({ width: 740, height: 360 });
    await boot(page);
    const nav = wide(page) ? page.getByRole('navigation', { name: 'Main navigation' }) : null;
    if (nav) await nav.getByRole('button', { name: 'Journal' }).click();
    else { await page.getByRole('button', { name: 'Places' }).click(); await page.getByRole('dialog', { name: 'Rooms and places' }).getByRole('button', { name: 'Journal', exact: true }).click(); }
    const list = page.locator('.journal-list');
    await expect(list.locator('.journal-entry')).toHaveCount(3);
    await expect(list.getByRole('button', { name: /Pass (this journal entry )?to Uni|Share to/ })).toHaveCount(0);
    await expect(list.locator('.journal-entry-actions')).toHaveCount(0);
    await expect(list.getByRole('button', { name: 'More for this entry' })).toHaveCount(3);
    await list.getByRole('button', { name: 'More for this entry' }).first().click();
    const menu = list.getByRole('group', { name: 'Entry actions' });
    await expect(menu.getByRole('button')).toHaveText(['Pass to Uni', 'Share to a room…']);
    expect(await calls(page, 'journal_share')).toHaveLength(0);
  });

  test('P2 (Codex 9) a cold launch shows a quiet chat while the conversation opens (never a status panel), and says so past 8 s with Retry', async ({ page }) => {
    // (an upright phone launches on the tree; its landscape launches on the chat, as every other size does)
    if (!wide(page)) await page.setViewportSize({ width: 740, height: 360 });
    await boot(page, { roomsDelay: 9500 });
    const chat = page.locator('.sr-chat');
    await expect(chat).toHaveAttribute('data-chat', 'waiting');
    await expect(chat.locator('.sr-chat-wait-line')).toHaveText('Opening the conversation…');
    // (the room's name once the rooms list says it)
    await expect(chat.locator('.sr-chat-wait-composer')).toHaveText(/^Message #?Uni$/);
    await expect(page.getByText('Opening the room…')).toHaveCount(0);
    await expect(chat.locator('.sr-chat-wait-line')).toHaveText('Still opening the conversation · Retry', { timeout: 10_000 });
    await expect(chat).toHaveAttribute('data-chat', 'open', { timeout: 10_000 });
    await expect(chat.locator('textarea')).toBeVisible();
  });

  test('P2 (Codex 7) a slow note says so with Retry and Back; a failed search says so in words, with Retry, its reason a detail', async ({ page }) => {
    test.skip(!wide(page), 'the rail');
    await page.addInitScript(() => { (window as any).__noteDelay = { '01M3ZQF7EM4ADC7HEY36D3DC3B': 11000 }; });
    await boot(page);
    const rail = page.getByRole('navigation', { name: 'Main navigation' });
    await rail.getByRole('button', { name: 'For you', exact: true }).click();
    await expect(page.locator('.note-sheet')).toContainText('Opening note…');
    await expect(page.locator('.note-sheet')).toContainText('Still opening this note.', { timeout: 10_000 });
    await expect(page.locator('.note-sheet').getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(page.locator('.note-sheet').getByRole('button', { name: /^Back to / }).last()).toBeVisible();
    await page.evaluate(() => { (window as any).__searchFails = true; });
    await rail.getByRole('button', { name: 'Search', exact: true }).click();
    await page.getByRole('searchbox').or(page.getByRole('textbox', { name: /Search/ })).first().fill('cutover');
    await expect(page.getByText('Couldn\'t search messages just now.')).toBeVisible();
    await expect(page.getByText('Couldn\'t reach your vault just now.')).toBeVisible();
    await expect(page.locator('.search-results')).not.toContainText('os error 5', { useInnerText: true });
    await page.evaluate(() => { (window as any).__searchFails = false; });
    await page.locator('.search-results').getByRole('button', { name: 'Retry' }).first().click();
    await expect(page.getByText('Couldn\'t search messages just now.')).toHaveCount(0);
  });

  test('P2 (Codex 3, part) Recent is kept in a short drawer (740×360): one line of places under the tree, and a place picked there lands on its chat', async ({ page }) => {
    await page.setViewportSize({ width: 740, height: 360 });
    await boot(page);
    await openRoom(page, 'ATLAS');
    await openRoom(page, 'Techne');
    await page.getByRole('button', { name: 'Places' }).click();
    const drawer = page.getByRole('dialog', { name: 'Rooms and places' });
    const recent = drawer.getByRole('region', { name: 'Recent' });
    await expect(recent).toBeVisible();
    await expect(recent.getByRole('button').first()).toBeInViewport({ ratio: 1 });
    await recent.getByRole('button', { name: /ATLAS/ }).click();
    await expect(page.locator('.sr')).toHaveAttribute('data-node', 'ATLAS');
    await expect(page.locator('.sr-chat')).toBeVisible();
    await expect(drawer).toHaveCount(0);
  });

  test('P2 (Codex 4) one owner for Escape: pairing opened over Settings closes first, then Settings', async ({ page }) => {
    test.skip(!wide(page), 'the rail');
    await page.addInitScript(() => { (window as any).__pairAvailable = true; });
    await boot(page);
    const rail = page.getByRole('navigation', { name: 'Main navigation' });
    await rail.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await expect(settings).toBeVisible();
    await settings.getByRole('button', { name: 'Pair a device' }).click();
    const pair = page.locator('dialog.pair-source');
    await expect(pair).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(pair).toHaveCount(0);
    await expect(settings).toBeVisible();
    expect(await calls(page, 'pair_source_cancel')).not.toHaveLength(0);
    await page.keyboard.press('Escape');
    await expect(settings).toHaveCount(0);
  });

  test('the folded strip never shows step 1 as the whole job (r28: nor any part of the request): "Needs you · N: <the whole first request>" when it fits one line, else "Needs you · N"', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 600 });
    await boot(page);
    await add(page, { id: 'st', title: 'T-113 Companion Today redesign', node: 'Projects/ATLAS', meta: { priority: 'now', due: '2026-10-01', next: 'Look at https://cohere-signup-staging.example-workers.invalid/?look=ecology on phone, then forward #cohere\'s \'For Harper\' block (posted 10-13)' } });
    await refresh(page, '2026-10-14T09:00:00.000Z');
    await openRoom(page, 'ATLAS');
    const line = page.locator('.cp.strip .cp-line-text');
    const text = (await line.innerText()).trim();
    expect(text).toMatch(/^Needs you · \d+(?:: .+)?$/);
    expect(text).not.toMatch(/step 1 of|…|\.\.\./);
    // with a request after the count it is the whole of it (both steps), never the first step alone
    if (/:/.test(text)) expect(text).toContain("then forward #cohere's 'For Harper' block (posted 10-13)");
    await expect(line).not.toContainText('example-workers.invalid');
  });

  test('privacy never waits on the areas (found in the real app, cold at 800×600): a private area\'s item is never a row before the areas are read', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as any;
      w.__tagDelay = { area: 6000, project: 6000 };
      w.__sawPrivate = false;
      new MutationObserver(() => { if (/Sit twenty minutes|Before breakfast/.test(document.body?.innerText ?? '')) w.__sawPrivate = true; }).observe(document, { subtree: true, childList: true, characterData: true });
    });
    if (!wide(page)) await page.setViewportSize({ width: 740, height: 360 });
    await boot(page, { privateTasks: true });
    await openWork(page);
    await expect(page.locator('.sr-work .cp-private')).toHaveText('In Sanctum: 1 thing for you · open Sanctum', { timeout: 15_000 });
    await page.waitForTimeout(6500);
    expect(await page.evaluate(() => (window as any).__sawPrivate)).toBe(false);
  });

  test('the 800×600 sheet has a margin and its whole border', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 600 });
    await boot(page);
    await seed(page);
    await openRoom(page, 'ATLAS');
    await openWork(page);
    await page.locator('.sr-work .cp-item').filter({ hasText: 'Edit and send the ATLAS follow-up' }).locator('.cp-need').click();
    const sheet = sheetOf(page);
    await sheet.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    const b = (await sheet.boundingBox())!;
    expect(b.y + b.height).toBeLessThanOrEqual(600 - 8);
    expect(b.y).toBeGreaterThanOrEqual(8);
    const border = await sheet.evaluate((el) => { const cs = getComputedStyle(el); return { bottom: parseFloat(cs.borderBottomWidth), radius: parseFloat(cs.borderBottomLeftRadius) }; });
    expect(border.bottom).toBeGreaterThan(0);
    expect(border.radius).toBeGreaterThan(0);
    await page.screenshot({ path: `${SHOTS}/r21-sheet-800x600.png` }).catch(() => {});
  });
});

test.describe('r22', () => {
  const refresh = async (page: Page, at: string) => { await page.clock.setFixedTime(Date.parse(at)); await page.evaluate(() => window.dispatchEvent(new Event('focus'))); };
  const add = (page: Page, n: { id: string; title: string; node: string; tag?: string; meta?: Record<string, unknown>; content?: string; path?: string; updatedAt?: string }) => page.evaluate((x) => {
    (window as any).__tasks.push({ id: x.id, path: x.path ?? `${x.tag === 'decision' ? 'Decisions' : 'Tasks'}/${x.title}`, extension: 'md', tags: x.tag === 'none' ? [] : [x.tag ?? 'task'], createdAt: '2026-10-10T08:00:00.000Z', updatedAt: x.updatedAt ?? '2026-10-14T08:00:00.000Z', lastUpdatedBy: 'u', lastUpdatedVia: 'mcp', content: x.content ?? x.title, metadata: x.tag === 'none' ? (x.meta ?? {}) : { node: x.node, state: 'open', owner: 'aaron', ...(x.meta ?? {}) } });
  }, n);
  const sheetOf = (page: Page) => page.getByRole('dialog').filter({ has: page.locator('.task-kind') });
  const openWork = async (page: Page) => { await openCompanion(page); await page.getByRole('button', { name: /^All of .*'s work/ }).click(); await expect(page.locator('.sr-work')).toBeVisible(); };
  const leadText = (row: ReturnType<Page['locator']>) => row.locator('.cp-lead').evaluate((el) => (el as HTMLElement).innerText.replace(/\s+/g, ' ').trim());
  /** The real steps from the scratch copy (10-14), and every verb phrase the row must say (both critics, r21). */
  const ROWS = [
    { id: 'at', title: 'T-129 Send the ATLAS Oct 12 follow-up email', next: 'Edit and send the ATLAS follow-up to Theo and Dominic from your account; fill the opening, sign-off and next-review date.', has: ['Edit and send the ATLAS follow-up', 'to Theo and Dominic from your account', 'fill the opening, sign-off and next-review date'] },
    { id: 'ww', title: 'T-67 Woven Web handoff note for Harper', next: 'Review the Woven Web handoff draft, fill the unknowns, then talk with Harper yourself.', has: ['Review the Woven Web handoff draft', 'fill the unknowns', 'then talk with Harper yourself'] },
    { id: 'st', title: 'T-113 Companion Today redesign + integrated PWA install flow (3…', next: 'Look at https://cohere-signup-staging.example-workers.invalid/?look=ecology on phone, then forward #cohere\'s \'For Harper\' block (posted 10-13)', has: ['Look at cohere-signup-staging on phone', 'then forward #cohere\'s \'For Harper\' block (posted 10-13)'] },
    { id: 'pay', title: 'T-65 $10k COhere sponsorship invoice draft', next: 'Tell Uni who pays (Techne or Gitcoin Foundation) and how: crypto or ACH/Stripe, plus Woven Web\'s legal details.', has: ['Tell Uni who pays (Techne or Gitcoin Foundation)', 'and how: crypto or ACH/Stripe, plus Woven Web\'s legal details'] },
    { id: 'co', title: 'T-90 COhere opens Oct 15', next: 'Wed 10-14: say go on prod deploy of #38 + #58; Harper signs off the copy/photos before/after (posting today); yes/no on add-only DB…', has: ['Say go on prod deploy of #38 + #58'], due: '2026-10-14' },
  ];
  // r23: `asked` is the request's own time (the record's `updatedAt` is not a request date)
  const seed = async (page: Page, node = 'Projects/ATLAS', asked = '2026-10-11T18:00:00.000Z') => {
    for (const r of ROWS) await add(page, { id: r.id, title: r.title, node, meta: { priority: 'now', next: r.next, asked, asked_at: asked, ...(r.due ? { due: r.due } : {}) } });
    await refresh(page, '2026-10-14T09:00:00.000Z');
  };
  const assertWhole = async (row: ReturnType<Page['locator']>, r: (typeof ROWS)[number]) => {
    const t = await leadText(row);
    for (const h of r.has) expect(t, `${r.title}: "${t}" lacks "${h}"`).toContain(h);
    // never "then …", never an ellipsis, never clamped
    expect(t, r.title).not.toMatch(/…|\.\.\.|then\s*…/);
    const clamp = await row.locator('.cp-lead').evaluate((el) => { const s = getComputedStyle(el); return { clamp: s.webkitLineClamp, over: el.scrollHeight > el.clientHeight + 1 }; });
    expect(clamp.over, `${r.title} overflows its row`).toBe(false);
    expect(['none', '', 'unset'].includes(clamp.clamp), `${r.title}: line clamp ${clamp.clamp}`).toBe(true);
    // the small print says when it was asked; where it belongs stays, and a wrapped date line starts with its words, not " · "
    const sub = row.locator('.cp-sub');
    await expect(sub).toHaveAttribute('title', / · (?:asked|added) (?:today|\w+ \d+)$|^(?:asked|added) (?:today|\w+ \d+)$/);
    if (await sub.getAttribute('data-wrapped')) expect((await sub.locator('.cp-sub-when').textContent()) ?? '', r.title).not.toMatch(/^\s*·/);
    else if (await sub.locator('.cp-sub-where:not([hidden])').count()) expect((await sub.locator('.cp-sub-when').textContent()) ?? '', r.title).toMatch(/^ · /);
  };

  test('rows say the whole job (both critics): staging, Woven Web, ATLAS ("…fill the opening, sign-off and next-review date") and who pays hold every verb phrase, with no "…", at 236px and in the work view', async ({ page }) => {
    await boot(page);
    await seed(page);
    await openRoom(page, 'ATLAS');
    await openWork(page);
    for (const narrow of [false, true]) {
      if (narrow) await narrowWork(page);
      for (const r of ROWS) await assertWhole(page.locator('.sr-work section[aria-label="Needs you"] .cp-item').filter({ hasText: r.has[0].slice(0, 20) }), r);
    }
    // the side panel: whole rows, at least two, then "Show N more" for what doesn't fit
    if (wide(page)) {
      await page.getByRole('button', { name: /Back to chat/ }).click();
      const body = page.locator('aside.cp.side .cp-body');
      const rows = body.locator('section[aria-label="Needs you"] .cp-item');
      await expect(rows.first()).toBeVisible();
      const n = await rows.count();
      expect(n).toBeGreaterThanOrEqual(2);
      for (const row of await rows.all()) { const t = await leadText(row).catch(() => ''); const r = ROWS.find((x) => t.includes(x.has[0].slice(0, 20))); if (r) await assertWhole(row, r); }
      await expect(body.locator('.cp-more')).toHaveText(/^Show \d+ more$/);
    }
  });

  test('a request shows its age: "asked Oct 6" on the row and the sheet; when the room\'s chat is more than a day newer, the sheet says the chat has moved on (and nothing is hidden)', async ({ page }) => {
    await boot(page);
    // Techne's room has messages up to Oct 9 (the fixture's pinned time); these requests were set on Oct 6
    await seed(page, 'Areas/Techne', '2026-10-06T18:00:00.000Z');
    await page.evaluate(() => (window as any).__arrive('ch-techne', 'Uni', 'Prod deploy of #38 is staged and waiting.', -426600));
    await add(page, { id: 'fresh', title: 'T-200 A fresh placeholder request', node: 'Areas/Techne', meta: { priority: 'now', next: 'Send the placeholder note to Casey', asked: new Date(Date.now() + 5000).toISOString() } });
    await refresh(page, '2026-10-14T09:00:00.000Z');
    await openRoom(page, 'Techne');
    await openWork(page);
    // r28: Techne's chat talked about it since it was asked (Oct 6): it is not in Needs you; it is in the recheck list, whole, with when it was asked
    await expect(page.locator('.sr-work section[aria-label="Needs you"] > .cp-list > .cp-item').filter({ hasText: 'Say go on prod deploy' })).toHaveCount(0);
    await openTaskSheet(page, 'Say go on prod deploy');
    await expect(page.locator('.sr-work .cp-recheck-item').filter({ hasText: 'Say go on prod deploy' }).locator('.cp-recheck-step')).toHaveText('Say go on prod deploy of #38 + #58; Harper signs off the copy/photos before/after (posting today); yes/no on add-only DB'); // r30: the whole step
    await expect(page.locator('.sr-work .cp-recheck-item').filter({ hasText: 'Say go on prod deploy' }).locator('.cp-recheck-asked')).toHaveText(/^asked Oct 6$/i); // r31: its reason is the date of its record (asked_at), the sheet says the same
    const sheet = sheetOf(page);
    await expect(sheet.locator('h2')).toHaveText('Say go on prod deploy of #38 + #58; Harper signs off the copy/photos before/after (posting today); yes/no on add-only DB');
    await expect(sheet.locator('.task-asked')).toContainText('Asked Oct 6');
    // Techne's chat has messages from Oct 9: more than a day newer than Oct 6
    await expect(sheet.locator('.task-unconfirmed')).toHaveText(/^Asked Oct 6 · not confirmed since$/i);
    await expect(sheet.locator('.task-movedon')).toHaveCount(0);
    // the request is still there; r26: its "Say it" waits behind "Answer anyway" while it is not confirmed
    await expect(sheet.getByRole('button', { name: /^Say it in #/ })).toHaveCount(0);
    await sheet.getByRole('button', { name: 'Answer anyway' }).click();
    await expect(sheet.getByRole('button', { name: /^Say it in #/ })).toBeVisible();
    await sheet.getByRole('button', { name: 'Close' }).click();
    // a request newer than the chat's last message has no cue
    const fresh = page.locator('.sr-work .cp-item').filter({ hasText: 'Send the placeholder note' });
    await expect(fresh.locator('.cp-under')).toHaveAttribute('title', /(?:asked|added) /);
    await fresh.locator('.cp-need').click();
    await expect(sheetOf(page).locator('.task-asked')).toBeVisible();
    await expect(sheetOf(page).locator('.task-movedon')).toHaveCount(0);
    await sheetOf(page).getByRole('button', { name: 'Close' }).click();
    // r23: "Check in #room first" goes to the room's conversation
    await openTaskSheet(page, 'Say go on prod deploy');
    await sheetOf(page).getByRole('button', { name: /^Check in #.* first$/ }).click();
    await expect(sheetOf(page)).toHaveCount(0);
    await expect(page.locator('.sr-chat')).toBeVisible();
  });

  test('the sheet says the request once: the steps are the body, the record title is in Details, and the step\'s link is its button ("Open cohere-signup-staging"), the primary action of a "look at" request', async ({ page }) => {
    await boot(page);
    await seed(page);
    await openRoom(page, 'ATLAS');
    await openWork(page);
    await page.locator('.sr-work .cp-item').filter({ hasText: 'Look at cohere-signup-staging' }).locator('.cp-need').click();
    const sheet = sheetOf(page);
    await expect(sheet.locator('h2')).toContainText('Look at cohere-signup-staging.example-workers.invalid on phone, then forward');
    await expect(sheet.locator('.task-steps li').nth(0)).toContainText('Look at cohere-signup-staging.example-workers.invalid on phone');
    await expect(sheet.locator('.task-steps li').nth(1)).toHaveText('Forward #cohere\'s \'For Harper\' block (posted 10-13)');
    // r26: the link is the primary action in the footer (the step keeps its own, secondary, button)
    const open = sheet.locator('.task-foot').getByRole('button', { name: 'Open cohere-signup-staging' });
    await expect(open).toBeVisible();
    await expect(open).toHaveClass(/primary/);
    await expect(sheet.locator('.task-steps li').nth(0).getByRole('button', { name: 'Open cohere-signup-staging' })).not.toHaveClass(/primary/);
    await expect(sheet.locator('.task-do.primary')).toHaveCount(1);
    await expect(sheet.getByRole('button', { name: 'I did this' })).not.toHaveClass(/primary/);
    // said once: the title is the quiet line under the heading (r26), no second copy of the step
    await expect(sheet.locator('.task-sub:not(.task-sub-title), .task-next a.cp-link')).toHaveCount(0);
    await expect(sheet.locator('.task-sub-title')).toContainText('Companion Today redesign');
    const text = await sheet.evaluate((el) => (el as HTMLElement).innerText);
    expect(text.split('Forward #cohere').length - 1).toBe(1);
    await sheet.locator('.task-details summary').click();
    await expect(sheet.locator('.task-record')).toHaveText(/^Task T-113: Companion Today redesign/);
    // the link opens (nothing is written)
    await open.click();
    await expect.poll(async () => (await calls(page, 'open_link')).length).toBeGreaterThan(0);
    expect(await calls(page, 'vault_transition')).toHaveLength(0);
  });

  test('private areas show the action, not the content: "In Sanctum: …" for a short work imperative, else "In Sanctum: 1 thing for you · open Sanctum"; never the item\'s other words', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as any;
      w.__sawPrivate = false;
      new MutationObserver(() => { if (/Placeholder memory|placeholder week/.test(document.body?.innerText ?? '')) w.__sawPrivate = true; }).observe(document, { subtree: true, childList: true, characterData: true });
    });
    await boot(page, { privateTasks: true });
    await add(page, { id: 'pa', title: 'T-301 Placeholder memory note', node: 'Areas/Sanctum', meta: { priority: 'now', next: 'Book the placeholder appointment' } });
    await add(page, { id: 'pb', title: 'T-302 Placeholder memory of the week', node: 'Areas/Sanctum', meta: { priority: 'now', next: 'Placeholder feeling about the placeholder week' } });
    await refresh(page, '2026-10-14T09:00:00.000Z');
    await openRoom(page, 'Uni');
    await openWork(page);
    const priv = page.locator('.sr-work .cp-private-item');
    await expect(priv).toHaveText(['In Sanctum: Book the placeholder appointment', 'In Sanctum: 1 more thing for you · open Sanctum']); // r28: an unconfirmed ask in a private area is not named outside it at all (the fixture's own is 8 days old at this clock)
    await expect(page.locator('.sr-work')).not.toContainText(/Sit twenty minutes|Before breakfast|Placeholder memory|placeholder week/);
    expect(await page.evaluate(() => (window as any).__sawPrivate)).toBe(false);
    await page.screenshot({ path: `${SHOTS}/r22-private-${page.viewportSize()?.width}.png` }).catch(() => {});
    // each opens the area, where its items are ordinary rows with their sheets
    await priv.first().locator('button').click();
    await expect(page.locator('.sr-title')).toHaveText('Sanctum');
  });
});

test.describe('r23', () => {
  const refresh = async (page: Page, at: string) => { await page.clock.setFixedTime(Date.parse(at)); await page.evaluate(() => window.dispatchEvent(new Event('focus'))); };
  const add = (page: Page, n: { id: string; title: string; node: string; meta?: Record<string, unknown>; createdAt?: string; updatedAt?: string }) => page.evaluate((x) => {
    (window as any).__tasks.push({ id: x.id, path: `Tasks/${x.title}`, extension: 'md', tags: ['task'], createdAt: x.createdAt ?? '2026-10-06T16:00:00.000Z', updatedAt: x.updatedAt ?? '2026-10-14T08:00:00.000Z', lastUpdatedBy: 'u', lastUpdatedVia: 'mcp', content: x.title, metadata: { node: x.node, state: 'open', owner: 'aaron', priority: 'now', ...(x.meta ?? {}) } });
  }, n);
  const sheetOf = (page: Page) => page.getByRole('dialog').filter({ has: page.locator('.task-kind') });
  const openWork = async (page: Page) => { await openCompanion(page); await page.getByRole('button', { name: /^All of .*'s work/ }).click(); await expect(page.locator('.sr-work')).toBeVisible(); };
  const rowOf = (page: Page, text: string) => page.locator('.sr-work .cp-item').filter({ hasText: text });
  /** The placeholder message a task's `detail` carries (made up; the live one is Nico's deploy-access note). */
  const DETAIL = "Send this to Nico:\n\n'Hey Nico, this is the placeholder message about deploy access for the staging copy of the site.'\n\nAfter he replies, Uni checks the account.";

  test('"asked" means asked (Codex P1): an explicit request time reads "asked Oct 6"; without one, "added Oct 6" from when the task was added; a rebalanced record keeps its date', async ({ page }) => {
    await boot(page);
    await add(page, { id: 'a1', title: 'T-301 Placeholder with a request time', node: 'Areas/Techne', meta: { next: 'Send the placeholder note to Casey', asked: '2026-10-06' } });
    await add(page, { id: 'a2', title: 'T-302 Placeholder added on Oct 6', node: 'Areas/Techne', meta: { next: 'Send the placeholder plan to Casey', asked_at: null } });
    await refresh(page, '2026-10-14T09:00:00.000Z');
    await openRoom(page, 'Techne');
    await openWork(page);
    await expect(rowOf(page, 'placeholder note to Casey').locator('.cp-under, .cp-asked-line').first()).toHaveAttribute('title', /asked Oct 6$/);
    // r28: with no `asked_at` the ask is Uni's to recheck: it is in that list, saying when it was added
    await expect(rowOf(page, 'placeholder plan to Casey').filter({ has: page.locator('.cp-need') })).toHaveCount(0);
    await page.locator('.sr-work .cp-recheck-line').click();
    const added = page.locator('.sr-work .cp-recheck-item').filter({ hasText: 'placeholder plan to Casey' });
    await expect(added.locator('.cp-recheck-asked')).toHaveText(/^added Oct 6/);
    // the board is rebalanced: a new `updatedAt` and priority; the date stays
    await page.evaluate(() => (window as any).__setTask('a2', { priority: 'soon' }));
    await refresh(page, '2026-10-14T09:01:00.000Z');
    await expect(added.locator('.cp-recheck-asked')).toHaveText(/^added Oct 6/);
    await added.locator('.cp-rc-open').click();
    await expect(sheetOf(page).locator('.task-asked')).toContainText('Added Oct 6');
    await expect(sheetOf(page).locator('.task-asked')).toHaveAttribute('data-kind', 'added');
    // r24: "Send the plan to Casey" isn't room-directed or an approval, and the chat hasn't talked about it: no cue
    await expect(sheetOf(page).locator('.task-movedon')).toHaveCount(0);
  });

  test('an approval can\'t outlive its moment (Codex P1): with the chat moved on, "Check in #room first" leads and "Say it" follows; a fresh request keeps "Say it" first', async ({ page }) => {
    await boot(page);
    // Techne's chat has messages up to Oct 9; this request was asked on Oct 6
    await page.evaluate(() => (window as any).__arrive('ch-techne', 'Uni', 'The placeholder deploy is ready whenever you are.', -426600));
    await add(page, { id: 'go', title: 'T-303 Placeholder deploy', node: 'Areas/Techne', meta: { next: 'Say go on the placeholder deploy', asked: '2026-10-06T18:00:00.000Z', asked_at: '2026-10-06T18:00:00.000Z' } });
    await add(page, { id: 'go3', title: 'T-309 Placeholder budget', node: 'Areas/Techne', meta: { next: 'Say go on the quarterly budget', asked: '2026-10-06T18:00:00.000Z', asked_at: '2026-10-06T18:00:00.000Z' } });
    await add(page, { id: 'go2', title: 'T-304 Placeholder fresh deploy', node: 'Areas/Techne', updatedAt: '2026-10-14T08:45:00.000Z', meta: { asked_at: '2026-10-14T08:45:00.000Z', next: 'Say go on the fresh placeholder deploy', asked: new Date(Date.now() + 5000).toISOString() } });
    await refresh(page, '2026-10-14T09:00:00.000Z');
    await openRoom(page, 'Techne');
    await openWork(page);
    await openTaskSheet(page, 'Say go on the placeholder deploy');
    const sheet = sheetOf(page);
    await expect(sheet.locator('.task-unconfirmed')).toHaveText(/^Asked Oct 6 · not confirmed since$/i);
    await expect(sheet.locator('.task-movedon')).toHaveCount(0);
    const primary = sheet.locator('.task-do.primary');
    await expect(primary).toHaveCount(1);
    await expect(primary).toHaveText(/^Check in #.+ first$/);
    const say = sheet.getByRole('button', { name: /^Say it in #/ });
    await expect(say).toHaveCount(0); // r26: behind "Answer anyway" while related chat is unresolved
    await sheet.getByRole('button', { name: 'Answer anyway' }).click();
    await expect(say).toBeVisible();
    await expect(say).not.toHaveClass(/primary/);
    // "Check in" opens the chat, and puts nothing in the composer
    await primary.click();
    await expect(sheetOf(page)).toHaveCount(0);
    await expect(page.locator('.sr-chat')).toBeVisible();
    await expect(page.locator('.sr-chat textarea, .sr-chat [contenteditable]').first()).toHaveText('');
    await openWork(page);
    // r31: the record alone decides: the other Oct 6 ask is no more current for the room's chat being about something else
    await openTaskSheet(page, 'Say go on the quarterly budget');
    await expect(sheetOf(page).locator('.task-unconfirmed')).toHaveText(/^Asked Oct 6 · not confirmed since$/i);
    await expect(sheetOf(page).locator('.task-movedon')).toHaveCount(0);
    await sheetOf(page).getByRole('button', { name: 'Close' }).click();
    await openTaskSheet(page, 'Say go on the fresh placeholder deploy');
    await expect(sheetOf(page).locator('.task-movedon')).toHaveCount(0);
    await expect(sheetOf(page).locator('.task-do.primary')).toHaveText(/^Say it in #/);
  });

  test('r24: a "look at" sheet whose room has talked about it leads with "Check in #room first" like every other sheet with the cue; its link is secondary', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => (window as any).__arrive('ch-techne', 'Uni', 'The signup staging copy is posted, please look.', -426600));
    await add(page, { id: 'st1', title: 'T-330 Placeholder staging look', node: 'Areas/Techne', meta: { next: 'Look at placeholder-signup-staging.example.invalid on phone, then say go on the signup staging', asked: '2026-10-06T18:00:00.000Z', asked_at: '2026-10-06T18:00:00.000Z' } });
    await refresh(page, '2026-10-14T09:00:00.000Z');
    await openRoom(page, 'Techne');
    await openWork(page);
    await openTaskSheet(page, 'placeholder-signup-staging');
    const sheet = sheetOf(page);
    await expect(sheet.locator('.task-unconfirmed')).toHaveText(/^Asked Oct 6 · not confirmed since$/i);
    await expect(sheet.locator('.task-movedon')).toHaveCount(0);
    await expect(sheet.locator('.task-do.primary')).toHaveCount(1);
    await expect(sheet.locator('.task-do.primary')).toHaveText(/^Check in #techne first$/i);
    await expect(sheet.getByRole('button', { name: 'I did this' })).toHaveCount(0); // r26
    await sheet.getByRole('button', { name: 'Answer anyway' }).click();
    await expect(sheet.getByRole('button', { name: 'I did this' })).not.toHaveClass(/primary/);
  });

  test('a step that names a block shows inline text only when it came from that block: otherwise "Open #room to find the \'For Harper\' block"', async ({ page }) => {
    await boot(page);
    await add(page, { id: 'b1', title: 'T-310 Placeholder block', node: 'Areas/Techne', meta: { next: "Forward #techne's 'For Harper' block (posted 10-13)", detail: 'Something else entirely: the Spanish copy list.', room: 'techne' } });
    await add(page, { id: 'b2', title: 'T-311 Placeholder block two', node: 'Areas/Techne', meta: { next: "Forward #techne's 'For Casey' block (posted 10-13)", detail: "## For Casey\nHi Casey, the placeholder text.", room: 'techne' } });
    await refresh(page, '2026-10-14T09:00:00.000Z');
    await openRoom(page, 'Techne');
    await openWork(page);
    await rowOf(page, "'For Harper' block").locator('.cp-need').click();
    await expect(sheetOf(page).locator('.task-detail')).toHaveCount(0);
    await expect(sheetOf(page).locator('.task-block-gap')).toContainText("Open #techne to find the 'For Harper' block");
    await expect(sheetOf(page).getByText('Spanish copy list')).toHaveCount(0);
    await sheetOf(page).getByRole('button', { name: 'Close' }).click();
    await rowOf(page, "'For Casey' block").locator('.cp-need').click();
    await expect(sheetOf(page).locator('.task-detail')).toContainText('Hi Casey, the placeholder text.');
    await expect(sheetOf(page).locator('.task-block-gap')).toHaveCount(0);
  });

  test('no ellipsis: a step stored cut short is shown as stored, with "(the note ends here · open the note)"; a preview question has none', async ({ page }) => {
    await boot(page);
    const cut = 'Say go on the placeholder deploy; Harper signs off the copy and photos before and after (posting today); yes or no on the add-only DB migratio';
    await add(page, { id: 'c1', title: 'T-305 Placeholder cut step', node: 'Areas/Techne', meta: { next: cut.padEnd(140, 'x').slice(0, 140) } });
    await refresh(page, '2026-10-14T09:00:00.000Z');
    await openRoom(page, 'Techne');
    await openWork(page);
    const row = rowOf(page, 'Say go on the placeholder deploy');
    expect(await row.innerText()).not.toMatch(/…|\.\.\./);
    await row.locator('.cp-need').click();
    const sheet = sheetOf(page);
    expect(await sheet.innerText()).not.toMatch(/…|\.\.\./);
    await expect(sheet.locator('.task-cut')).toHaveText('(the note ends here · open the note)');
    await sheet.locator('.task-cut').getByRole('button', { name: 'open the note' }).click();
    await expect(sheetOf(page)).toHaveCount(0);
  });

  test('"…message below": the message a task carries is shown and is what "Copy the message" copies; with none stored the row reads "Ask #room for the message"', async ({ page }) => {
    await boot(page);
    await add(page, { id: 'm1', title: 'T-306 Placeholder deploy access', node: 'Areas/Techne', meta: { next: 'Send Nico the deploy-access message below.', detail: DETAIL, room: 'techne' } });
    await add(page, { id: 'm2', title: 'T-307 Placeholder access, no message', node: 'Areas/Techne', meta: { next: 'Send Casey the access message below.', room: 'techne' } });
    await refresh(page, '2026-10-14T09:00:00.000Z');
    await openRoom(page, 'Techne');
    await openWork(page);
    await expect(rowOf(page, 'Send Nico the deploy-access message').locator('.cp-lead')).toHaveText('Send Nico the deploy-access message');
    await openTaskSheet(page, 'Send Nico the deploy-access message');
    const sheet = sheetOf(page);
    // r25 (Nico): the sheet's heading says the row's words, the message directly beneath it
    await expect(sheet.locator('h2')).toHaveText('Send Nico the deploy-access message');
    expect(await sheet.locator('h2').evaluate((h) => { let n = h.nextElementSibling as HTMLElement | null; if (n?.classList.contains('task-sub-title')) n = n.nextElementSibling as HTMLElement | null; return n?.className ?? ''; })).toContain('task-detail'); // r26: only the quiet title line may sit between
    await expect(sheet.locator('.task-detail')).toContainText('Hey Nico, this is the placeholder message');
    await expect(sheet.locator('.task-detail')).toContainText('After he replies, Uni checks the account.');
    await expect(sheet.locator('.task-do.primary')).toHaveText('Copy the message');
    await expect(sheet.getByRole('button', { name: 'Ask Uni to draft it' })).toHaveCount(0);
    await sheet.getByRole('button', { name: 'Close' }).click();
    // nothing stored: the row asks the room for it, and its sheet puts the request in the room's composer (never sent)
    // (the room that stewards Techne, named as the rooms list names it)
    const ask = page.locator('.sr-work .cp-item').filter({ hasText: /Ask #techne for the message/i });
    await expect(ask.locator('.cp-lead')).toHaveText(/^Ask #techne for the message$/i);
    await ask.locator('.cp-need').click();
    await expect(sheetOf(page).locator('h2')).toHaveText(/^Ask #techne for the message$/i);
    await expect(sheetOf(page).locator('.task-do.primary')).toHaveText(/^Ask in #techne ›$/i);
    await expect(sheetOf(page).locator('.task-detail')).toHaveCount(0);
  });

  test('a short window: the sheet\'s body scrolls above its footer, and no cue is ever under the footer (740×360, 920×360)', async ({ page }) => {
    await boot(page);
    await add(page, { id: 'f1', title: 'T-308 Placeholder long request', node: 'Areas/Techne', meta: { next: 'Send Nico the deploy-access message below.', due: '2026-10-20', detail: `${DETAIL}\n\n${'A further placeholder paragraph about the account and the project. '.repeat(4)}`, room: 'techne', asked: '2026-10-06' } });
    await refresh(page, '2026-10-14T09:00:00.000Z');
    await openRoom(page, 'Techne');
    for (const [w, h] of [[740, 360], [920, 360]] as const) {
      await page.setViewportSize({ width: w, height: h });
      // a window under 400px tall has the strip (r19): wait for the switch before opening it, or openCompanion sees the old side panel
      await expect(page.locator('.cp.strip')).toHaveCount(1);
      await openWork(page);
      await openTaskSheet(page, 'Send Nico the deploy-access message');
      const sheet = sheetOf(page);
      await expect(sheet.locator('.task-asked')).toBeVisible();
      // when it was asked and the moved-on cue lead the sheet: whole and in view at once, above the footer
      await expect(sheet.locator('.task-asked')).toBeInViewport({ ratio: 1 });
      const [cue, foot0] = [await sheet.locator('.task-asked').boundingBox(), await sheet.locator('.task-foot').boundingBox()];
      expect(cue!.y + cue!.height, `${w}×${h}`).toBeLessThanOrEqual(foot0!.y);
      // scrolled to its end, the body's last line is above the footer too
      await sheet.locator('.task-body').evaluate((el) => el.scrollTo(0, 99999));
      const lastBox = await sheet.locator('.task-body > *:last-child').boundingBox();
      expect(lastBox!.y + lastBox!.height, `${w}×${h} scrolled`).toBeLessThanOrEqual(foot0!.y + 1);
      // r24 (Sonnet): the Status and Due lines scroll fully above the footer too (they are the sheet's facts, before Put aside and Details)
      const facts = await sheet.locator('.task-facts dd').last().boundingBox();
      expect(facts!.y + facts!.height, `${w}×${h} facts`).toBeLessThanOrEqual(foot0!.y + 0.5);
      await sheet.locator('.task-facts').scrollIntoViewIfNeeded();
      const [fb, ft] = [await sheet.locator('.task-facts').boundingBox(), await sheet.locator('.task-foot').boundingBox()];
      expect(fb!.y + fb!.height, `${w}×${h} facts in view`).toBeLessThanOrEqual(ft!.y + 0.5);
      await expect(sheet.locator('.task-facts')).toBeInViewport({ ratio: 1 });
      // the footer is not drawn over the body: the body ends where the footer starts
      const [body, foot] = [await sheet.locator('.task-body').boundingBox(), await sheet.locator('.task-foot').boundingBox()];
      expect(body!.y + body!.height).toBeLessThanOrEqual(foot!.y + 0.5);
      await sheet.getByRole('button', { name: 'Close' }).click();
      await page.getByRole('button', { name: /Back to chat/ }).click().catch(() => {});
    }
  });

  test('r24: a decision sheet in a short window keeps its Status and Due lines whole above the footer (740×360, 920×360)', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'ATLAS');
    for (const [w, h] of [[740, 360], [920, 360]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await expect(page.locator('.cp.strip')).toHaveCount(1);
      await openCompanion(page);
      await page.locator('.cp-item').filter({ hasText: 'Decide the ATLAS hosting' }).locator('.cp-need').first().click();
      const sheet = sheetOf(page);
      await expect(sheet.locator('.task-facts')).toHaveCount(1);
      await sheet.locator('.task-body').evaluate((el) => el.scrollTo(0, 99999));
      const [body, foot, facts] = [await sheet.locator('.task-body').boundingBox(), await sheet.locator('.task-foot').boundingBox(), await sheet.locator('.task-facts').boundingBox()];
      expect(body!.height, `${w}×${h} the body has room`).toBeGreaterThan(60);
      expect(body!.y + body!.height).toBeLessThanOrEqual(foot!.y + 0.5);
      expect(facts!.y + facts!.height, `${w}×${h} facts above the footer`).toBeLessThanOrEqual(foot!.y + 0.5);
      expect(facts!.y, `${w}×${h} facts inside the body`).toBeGreaterThanOrEqual(body!.y - 0.5);
      await page.keyboard.press('Escape');
    }
  });

  test('r24 (Sonnet): at 1280×720 the last Running row sits wholly above the panel footer, unscrolled; a long run is whole and wrapped, no "…"', async ({ page }) => {
    test.skip(!wide(page), 'side panel');
    await page.setViewportSize({ width: 1280, height: 720 });
    await boot(page);
    const long = 'Draft the placeholder statement of work for the commons grant, with the budget table, the milestones and the two letters of support attached';
    await page.evaluate((t) => (window as any).__setRunWhat('run-1', t), long);
    await refresh(page, '2026-10-14T09:00:00.000Z');
    await openRoom(page, 'ATLAS');
    await openCompanion(page);
    const runs = page.locator('.cp.side .cp-run');
    const foot = (await page.locator('.cp-foot').boundingBox())!;
    const n = await runs.count();
    if (n) {
      const last = (await runs.nth(n - 1).boundingBox())!;
      expect(last.y + last.height, 'last run above the footer').toBeLessThanOrEqual(foot.y + 0.5);
    }
    const first = page.locator('.cp.side .cp-run span').filter({ hasText: 'placeholder statement of work' });
    if (await first.count()) {
      expect(await first.evaluate((e) => getComputedStyle(e).webkitLineClamp), 'no line-clamp ellipsis').toMatch(/^(none|)$/);
      // r28: a Running row is its whole text, wrapped (no two-line limit, no short form)
      expect((await first.innerText()).trim()).toBe(long);
      await expect(first).toHaveAttribute('title', long);
    } else {
      // the panel had no room for it: it waits behind "+N more running" in the footer
      await expect(page.locator('.cp-all-more')).toContainText('more running');
    }
  });

  test('r25 (Sonnet, Codex): a Running row never ends on a colon or "…": a stored cut is shown without it, a long run is whole (r28: no short form), in the panel and in the work view', async ({ page }) => {
    test.skip(!wide(page), 'side panel');
    await page.setViewportSize({ width: 1280, height: 720 });
    await boot(page);
    const longRun = 'Waiting on your answer in #Uni: release 0.1.46 now, or keep going until two clean rounds. Round 21 keeps building meanwhile.';
    for (const [what, re] of [['Waiting on your answer in #Uni:', /^Waiting on your answer in #Uni$/], ['Waiting on your answer in #Uni: …', /^Waiting on your answer in #Uni$/], [longRun, /^Waiting on your answer in #Uni: release 0\.1\.46 now, or keep going until two clean rounds\. Round 21 keeps building meanwhile\.$/]] as const) {
      await page.evaluate((t) => (window as any).__setRunWhat('run-1', t), what);
      await refresh(page, '2026-10-14T09:00:00.000Z');
      await openRoom(page, 'ATLAS');
      await openCompanion(page);
      const run = page.locator('.cp.side .cp-run .cp-run-text').first();
      await expect(run).toBeVisible();
      await expect.poll(async () => (await run.innerText()).trim()).toMatch(re);
      const text = (await run.innerText()).trim();
      expect(text).not.toMatch(/[:…]$|\.\.\./);
      // the work view says the same words
      await openWork(page);
      const wrun = page.locator('.sr-work .cp-run .cp-run-text').first();
      await expect(wrun).toBeVisible();
      await expect.poll(async () => (await wrun.innerText()).trim()).toMatch(re);
      expect((await wrun.innerText()).trim()).not.toMatch(/[:…]$|\.\.\./);
      await page.getByRole('button', { name: /Back to chat/ }).click();
    }
  });

  test('r25 (Codex P2 5): T-113\'s shape: the row and the sheet say the task\'s `next`, whole; the title is the quiet line, cut with words and no "…"', async ({ page }) => {
    await boot(page);
    await add(page, { id: 'n113', title: 'T-113 Companion Today redesign + integrated PWA install flow (3…', node: 'Areas/Techne', meta: { priority: 'now', due: '2026-10-13', next: 'On your phone, look at grove.example.org, then forward Harper the asks' } });
    await refresh(page, '2026-10-14T09:00:00.000Z');
    await openRoom(page, 'Techne');
    await openWork(page);
    const row = page.locator('.sr-work .cp-item').filter({ hasText: 'grove.example.org' });
    await expect(row.locator('.cp-lead')).toHaveText('On your phone, look at grove.example.org, then forward Harper the asks');
    await expect(row.locator('.cp-under')).toHaveAttribute('title', /^Companion Today redesign \+ integrated PWA install flow · was due Oct 13/);
    expect(await row.innerText()).not.toMatch(/…|\.\.\./);
    await row.locator('.cp-need').click();
    const sheet = sheetOf(page);
    // r26: the heading is the next, whole (never "2 steps", never the title); a step list with nothing to open in it is not repeated under it
    await expect(sheet.locator('h2')).toHaveText('On your phone, look at grove.example.org, then forward Harper the asks');
    await expect(sheet.locator('.task-steps')).toHaveCount(0);
    expect(await sheet.locator('h2').innerText()).not.toContain('Companion Today');
    expect(await sheet.innerText()).not.toMatch(/\(3…|\(3\.\.\./);
  });

  test('r25 (Codex P1 2), r27: Check in: an ask past 3 days is unconfirmed and Check in leads; it keeps the question over the composer (r31: no chat is read)', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => (window as any).__arrive('ch-techne', 'Uni', 'The placeholder deploy is ready whenever you are.', -426600));
    await add(page, { id: 'ci1', title: 'T-303 Placeholder deploy', node: 'Areas/Techne', updatedAt: '2026-10-13T12:00:00.000Z', meta: { next: 'Say go on the placeholder deploy', asked: '2026-10-06T18:00:00.000Z', asked_at: '2026-10-06T18:00:00.000Z' } });
    await add(page, { id: 'ci2', title: 'T-309 Placeholder budget', node: 'Areas/Techne', updatedAt: '2026-10-13T12:00:00.000Z', meta: { next: 'Say go on the quarterly budget', asked: '2026-10-06T18:00:00.000Z', asked_at: '2026-10-06T18:00:00.000Z' } });
    await refresh(page, '2026-10-14T09:00:00.000Z');
    await openRoom(page, 'Techne');
    await openWork(page);
    await openTaskSheet(page, 'Say go on the placeholder deploy');
    let sheet = sheetOf(page);
    // r31: the record says when it was asked (Oct 6, past 3 days); nothing in the chat is read, so there is no "couldn't read" and no Retry
    await expect(sheet.locator('.task-lookfail')).toHaveCount(0);
    await expect(sheet.locator('.task-unconfirmed')).toHaveText(/^Asked Oct 6 · not confirmed since$/i);
    await expect(sheet.locator('.task-movedon')).toHaveCount(0);
    await expect(sheet.locator('.task-do.primary')).toHaveText(/^Check in #techne first$/i);
    // r26: the answers are not offered as ready; one tap on "Answer anyway" brings them, secondary
    await expect(sheet.getByRole('button', { name: 'I did this' })).toHaveCount(0);
    await sheet.getByRole('button', { name: 'Answer anyway' }).click();
    await expect(sheet.getByRole('button', { name: 'I did this' })).not.toHaveClass(/primary/);
    await expect(sheet.getByRole('button', { name: /^Say it in #/ })).not.toHaveClass(/primary/);
    expect(await sheet.innerText()).not.toMatch(/approved|(?<!not )confirmed/i);
    await sheet.getByRole('button', { name: 'Close' }).click();
    await openTaskSheet(page, 'Say go on the placeholder deploy');
    sheet = sheetOf(page);
    // Check in opens the room and keeps the question in view above the composer
    await sheet.locator('.task-do.primary').click();
    const banner = page.locator('.checking-banner');
    await expect(banner).toHaveText(/^Checking: Say go on the placeholder deploy/);
    const bb = (await banner.boundingBox())!;
    const cb = (await page.locator('.sr-chat textarea').first().boundingBox())!;
    expect(bb.y + bb.height, 'the banner is above the composer').toBeLessThanOrEqual(cb.y + 1);
    expect(bb.height, 'one line').toBeLessThan(40);
    expect(await banner.innerText()).not.toMatch(/…|\.\.\./);
    await page.getByRole('button', { name: 'Stop checking' }).click();
    await expect(banner).toHaveCount(0);
  });

  test('r29 (Codex P1-3): a summary that says something waits on Aaron is not judged by the app: dated, below Needs you, no stale notice, whatever is open', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => (window as any).__setStands('p-lvb', "Prod waits on Aaron's go for #38 and #58.", '2026-10-13T20:00:00.000Z'));
    await refresh(page, '2026-10-14T09:00:00.000Z');
    await openRoom(page, 'Learn Vibe Build');
    await openCompanion(page);
    await expect(page.locator('.cp-stale, [data-stale], [data-stale-why]')).toHaveCount(0);
    await expect(page.locator('.cp-body')).not.toContainText('older than the latest work');
    await expect(page.locator('.cp-asof')).toHaveText(/^Last written Oct 13 by #\S+:$/);
    await expect(page.locator('.cp-stands').first()).toHaveText("Prod waits on Aaron's go for #38 and #58.");
    // an open request that doesn't name what the summary says waits: the same line, unchanged
    await add(page, { id: 'other', title: 'T-321 Placeholder other thing', node: 'Projects/Learn Vibe Build', updatedAt: '2026-10-10T08:00:00.000Z', meta: { priority: 'now', next: 'Edit the placeholder note for Casey', asked: '2026-10-13T18:00:00.000Z' } });
    await refresh(page, '2026-10-14T09:15:00.000Z');
    await expect(page.locator('.cp-body').getByText('Edit the placeholder note for Casey')).toBeVisible();
    await expect(page.locator('.cp-asof')).toHaveText(/^Last written Oct 13 by #\S+:$/);
    await expect(page.locator('.cp-stale, [data-stale], [data-stale-why]')).toHaveCount(0);
  });

  test('one freshness line at a time: a saved copy being read again says "N as of 1:44 PM · refreshing…" once, not in the tree too', async ({ page }) => {
    test.skip(!wide(page), 'the tree beside the room');
    await boot(page);
    await openRoom(page, 'ATLAS');
    await openCompanion(page);
    await expect(page.locator('.cp-body .cp-item').first()).toBeVisible();
    await expect.poll(() => page.evaluate(() => (localStorage.getItem('uni.tasks.saved.v1') ?? '').length > 0)).toBe(true);
    await page.addInitScript(() => { (window as any).__tasksDelay = 60_000; });
    await page.reload();
    await openRoom(page, 'ATLAS');
    await openCompanion(page);
    const lines = page.locator('.lh-line').filter({ hasText: /as of \d{1,2}:\d{2}\s?[AP]M · refreshing…$/ });
    await expect(lines.first()).toBeVisible();
    await expect(lines).toHaveCount(1);
  });

  test('Ctrl+W acts on the foreground (Codex 8): an open sheet closes as Escape closes it, and the place stays; Cmd+W is left to the native menu', async ({ page }) => {
    await boot(page);
    await add(page, { id: 'w1', title: 'T-309 Placeholder close', node: 'Areas/Techne', meta: { next: 'Send the placeholder note to Casey' } });
    await refresh(page, '2026-10-14T09:00:00.000Z');
    await openRoom(page, 'Techne');
    await openWork(page);
    await openTaskSheet(page, 'placeholder note to Casey');
    await expect(sheetOf(page)).toBeVisible();
    await page.keyboard.press('Control+w');
    await expect(sheetOf(page)).toHaveCount(0);
    await expect(page.locator('.sr-work')).toBeVisible();
    // Meta+W alone (not macOS here) does nothing in the page
    await openTaskSheet(page, 'placeholder note to Casey');
    await page.keyboard.press('Meta+w');
    await expect(sheetOf(page)).toBeVisible();
  });

  test('Recent never overlaps the area list: the tree scrolls in its own region above Recent, its last line fading while rows run on (1280×720)', async ({ page }) => {
    test.skip(!wide(page), 'the sidebar');
    await page.setViewportSize({ width: 1280, height: 720 });
    await boot(page);
    for (const n of ['Atlas', 'Techne', 'Learn Vibe Build', 'COhere 2026']) await openRoom(page, n);
    // every area unfolded, so the tree runs past its region
    for (let i = 0; i < 20; i++) { const f = page.locator('.th-roomnav .th-fold[aria-expanded="false"]').first(); if (!(await f.count())) break; await f.click(); }
    await page.addStyleTag({ content: '.th-roomnav { max-height: 420px; }' });
    const wrap = page.locator('.th-roomnav .th-rows-wrap');
    const recent = page.locator('.th-roomnav .th-recent');
    await expect(recent).toBeVisible();
    const [a, b] = [await wrap.boundingBox(), await recent.boundingBox()];
    expect(a!.y + a!.height).toBeLessThanOrEqual(b!.y + 0.5);
    if (await wrap.evaluate((el) => el.scrollHeight > el.clientHeight + 1)) {
      await wrap.evaluate((el) => el.scrollTo(0, 0));
      await expect(wrap).toHaveAttribute('data-more', '');
      await wrap.evaluate((el) => el.scrollTo(0, 99999));
      await expect(wrap).not.toHaveAttribute('data-more', '');
    }
  });
});

test.describe('r26', () => {
  const refresh = async (page: Page, at: string) => { await page.clock.setFixedTime(Date.parse(at)); await page.evaluate(() => window.dispatchEvent(new Event('focus'))); };
  const add = (page: Page, n: { id: string; title: string; node: string; tag?: string; meta?: Record<string, unknown>; updatedAt?: string }) => page.evaluate((x) => {
    (window as any).__tasks.push({ id: x.id, path: `Tasks/${x.title}`, extension: 'md', tags: [x.tag ?? 'task'], createdAt: '2026-10-06T16:00:00.000Z', updatedAt: x.updatedAt ?? '2026-10-14T08:00:00.000Z', lastUpdatedBy: 'u', lastUpdatedVia: 'mcp', content: x.title, metadata: { node: x.node, state: 'open', owner: 'aaron', priority: 'now', ...(x.meta ?? {}) } });
  }, n);
  const sheetOf = (page: Page) => page.getByRole('dialog').filter({ has: page.locator('.task-kind') });
  const openWork = async (page: Page) => { await openCompanion(page); await page.getByRole('button', { name: /^All of .*'s work/ }).click(); await expect(page.locator('.sr-work')).toBeVisible(); };
  const rowOf = (page: Page, text: string) => page.locator('.sr-work .cp-item').filter({ hasText: text });
  /** r27: the items a row shows plus "and N more" are the whole list; each is a whole clause (no cut mark, never the bare label "3 answers") */
  const itemTotal = async (row: ReturnType<Page['locator']>) => {
    const lines = await row.locator('.cp-item-line').allInnerTexts();
    for (const l of lines) { expect(l).not.toMatch(/…|\.\.\.|[,;:]$/); expect(l.trim()).not.toBe('3 answers'); }
    const more = await row.locator('.cp-item-more').count() ? await row.locator('.cp-item-more').innerText() : '';
    // r31: the row says the list's own length ("6 asks in all"), the same at any width; with nothing left out it says nothing
    return /^(\d+) \w+ in all$/.exec(more.trim()) ? Number(/^(\d+) /.exec(more.trim())![1]) : lines.length;
  };
  const NEXT113 = "On your phone, look at https://grove.example.org (live now), then forward Harper the asks listed in this task's detail";
  const DETAIL113 = "Live on prod since 10-14 15:24 (PR #61); staging matches. Harper still owes: (1) OK or cut 6 groups of short functional lines (notifications, email links, install, privacy, harvest/board, profile labels); (2) 3 answers: Spanish versions of 'What is COhere?' and 'What's Coming Up', whether 'Explore events on the community events' should end in 'calendar'; (3) one morning-practice line per day for Oct 15–25 (her doc has 2); (4) yes/no on the Today heading showing just 'Honoring Water (9 AM at Martin Park)' with 'Home practice:' in bold. Aaron: sign in once as a member and open Board, People and Me.";

  test('r26 line 5: a row that points at a list carries its first three items and "and N more"; the sheet lists them all directly under the heading, which is the current step in full', async ({ page }) => {
    await boot(page);
    await add(page, { id: 'n113', title: 'T-113 Companion Today redesign + integrated PWA install flow (3…', node: 'Areas/Techne', meta: { due: '2026-10-13', next: NEXT113, detail: DETAIL113, waiting_on: 'aaron', state: 'waiting' } });
    await refresh(page, '2026-10-14T09:00:00.000Z');
    await openRoom(page, 'Techne');
    await openWork(page);
    const row = rowOf(page, 'grove.example.org');
    await expect(row.locator('.cp-lead')).toHaveText("On your phone, look at grove.example.org (live now), then forward Harper the asks listed in this task's detail");
    expect(await itemTotal(row)).toBe(4);
    await expect(row.locator('.cp-item-line').nth(0)).toContainText('OK or cut 6 groups of short functional lines');
    expect(await row.innerText()).not.toMatch(/…|\.\.\./);
    await row.locator('.cp-need').click();
    const sheet = sheetOf(page);
    // the heading is the current step in full (r30: its stored words, "listed in this task's detail" included), never "2 steps"
    await expect(sheet.locator('h2')).toHaveText("On your phone, look at grove.example.org (live now), then forward Harper the asks listed in this task's detail");
    expect(await sheet.locator('h2').innerText()).not.toMatch(/steps|Companion Today/);
    await expect(sheet.locator('.task-stepof')).toHaveText('Step 1 of 2');
    // the whole list sits directly under the heading (after the quiet title line)
    const items = sheet.locator('.task-items');
    await expect(items.locator('h3')).toHaveText('Harper still owes');
    await expect(items.locator('li')).toHaveCount(4);
    await expect(items.locator('li').nth(3)).toContainText("yes/no on the Today heading");
    // r27: the steps come first ("Step 1 of 2"), the asks (step 2's content) after them
    const h = (await sheet.locator('h2').boundingBox())!, i = (await items.boundingBox())!, s = (await sheet.locator('.task-steps').boundingBox())!;
    expect(i.y).toBeGreaterThan(h.y);
    expect(i.y).toBeGreaterThan(s.y);
    await expect(sheet.locator('.task-sub-title')).toContainText('Companion Today redesign + integrated PWA install flow');
    expect(await sheet.locator('.task-sub-title').innerText()).not.toMatch(/…|\.\.\./);
    // the tag always says where it is
    await expect(sheet.locator('.task-kind')).toHaveText(/^Task · in #techne$/i);
    // the sentence after the list stays in the detail, the list is not repeated there
    await expect(sheet.locator('.task-detail')).toContainText('Aaron: sign in once as a member');
    await expect(sheet.locator('.task-detail')).not.toContainText('Harper still owes');
  });

  test('r26 line 5: Woven Web\'s shape: "fill the unknowns" shows the list under "Key unknowns only you can fill:"; a step whose list is not written down says so with the way to the room', async ({ page }) => {
    await boot(page);
    await add(page, { id: 'w67', title: 'T-67 Woven Web handoff note for Harper', node: 'Areas/Techne', meta: { next: 'Review the Woven Web handoff draft, fill the unknowns, then talk with Harper yourself.', state: 'waiting', waiting_on: 'aaron',
      detail: 'Draft (not sent to Harper): [[Projects/Woven Web/Handoff for Harper]]\n\nKey unknowns only you can fill:\n1. Has Harper agreed to the whole handoff, including admin and filings?\n2. Nonprofit details: 501(c)(3) status, legal name, EIN.\n3. Bank account and signers.\n4. Filings: taxes are behind.\n5. Do you stay on the board?\n\nNothing should be promised to funders until filings are current.' } });
    await add(page, { id: 'n9', title: 'T-9 Placeholder asks', node: 'Areas/Techne', meta: { next: 'Forward Casey the asks listed in this task\'s detail', state: 'waiting', waiting_on: 'aaron', detail: 'Nothing else is written here.' } });
    await refresh(page, '2026-10-14T09:00:00.000Z');
    await openRoom(page, 'Techne');
    await openWork(page);
    const row = rowOf(page, 'fill the unknowns');
    expect(await itemTotal(row)).toBe(5);
    await row.locator('.cp-need').click();
    let sheet = sheetOf(page);
    await expect(sheet.locator('.task-items h3')).toHaveText('Key unknowns only you can fill');
    await expect(sheet.locator('.task-items li')).toHaveCount(5);
    await sheet.getByRole('button', { name: 'Close' }).click();
    // nothing resolves
    const none = rowOf(page, 'Forward Casey the asks');
    await expect(none.locator('.cp-items-none')).toHaveText(/^The asks aren't written down in this task · Open #techne$/i);
    await expect(none.locator('.cp-lead')).toHaveText("Forward Casey the asks listed in this task's detail");
    await none.locator('.cp-need').click();
    sheet = sheetOf(page);
    await expect(sheet.locator('.task-notwritten')).toHaveText(/^The asks aren't written down in this task · Open #techne$/i);
    await expect(sheet.locator('.task-items')).toHaveCount(0);
  });

  test('r26 line 5: the sheet heading never carries a note\'s name or the title in brackets; the note is a link on the quiet line', async ({ page }) => {
    await boot(page);
    await add(page, { id: 'ml1', title: 'T-401 Quarterly roadmap sign-off (mail cutover plan)', node: 'Areas/Techne', meta: { next: 'Approve or change the placeholder.dev mail cutover plan (mail cutover plan)', state: 'waiting', waiting_on: 'aaron' } });
    await refresh(page, '2026-10-14T09:00:00.000Z');
    await openRoom(page, 'Techne');
    await openWork(page);
    const row = rowOf(page, 'placeholder.dev mail cutover plan');
    await expect(row.locator('.cp-lead')).toHaveText('Approve or change the placeholder.dev mail cutover plan');
    await row.locator('.cp-need').click();
    const sheet = sheetOf(page);
    await expect(sheet.locator('h2')).toHaveText('Approve or change the placeholder.dev mail cutover plan');
    expect(await sheet.locator('h2').innerText()).not.toMatch(/\(|\)/);
    await expect(sheet.locator('.task-sub-title')).toContainText('Quarterly roadmap sign-off');
    expect(await sheet.locator('.task-sub-title').innerText()).not.toMatch(/\(/);
  });

  test('r26 line 5: archived, done and superseded tasks are never in Needs you or Running, in the panel or the work view', async ({ page }) => {
    test.skip(!wide(page), 'side panel');
    await page.setViewportSize({ width: 1280, height: 720 });
    await boot(page);
    await add(page, { id: 'ar1', title: 'T-13 Self-hosted mail: approved 10-02', node: 'Areas/Techne', meta: { state: 'archived', waiting_on: 'aaron', next: 'Superseded by T-136 (Aaron, 10-14)' } });
    await add(page, { id: 'ar2', title: 'T-14 Superseded but still open', node: 'Areas/Techne', meta: { state: 'waiting', waiting_on: 'aaron', next: 'Superseded by T-136 (Aaron, 10-14)' } });
    await add(page, { id: 'ar3', title: 'T-15 Placeholder open one', node: 'Areas/Techne', meta: { state: 'waiting', waiting_on: 'aaron', next: 'Say go on the placeholder open one' } });
    await page.evaluate(() => {
      const w = window as any;
      for (const [id, task, what] of [['run-t13', 'T-13', 'Waiting on your answer in #Uni'], ['run-t14', 'T-14', 'Superseded run'], ['run-t15', 'T-15', 'Placeholder open run']]) w.__addRun(id, 'Areas/Techne', task, what);
    });
    await refresh(page, '2026-10-14T09:00:00.000Z');
    await openRoom(page, 'Techne');
    await openCompanion(page);
    const body = page.locator('.cp.side .cp-body');
    await expect(body).toContainText('Say go on the placeholder open one');
    expect(await body.innerText()).not.toMatch(/Self-hosted mail|approved 10-02|Superseded/);
    // Running: the run about the open task stays, the runs about the archived and the superseded one are gone
    await expect(body).toContainText('Placeholder open run');
    expect(await body.innerText()).not.toMatch(/Waiting on your answer in #Uni|Superseded run/);
    await openWork(page);
    const wv = page.locator('.sr-work');
    await expect(wv).toContainText('Say go on the placeholder open one');
    expect(await wv.innerText()).not.toMatch(/Self-hosted mail|approved 10-02|Superseded/);
  });

  test('r26 P1 1: an ask that is not confirmed offers no answers as ready (a decision\'s answers and "I did this" wait behind "Answer anyway"); a current one shows the ordinary actions', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => (window as any).__arrive('ch-techne', 'Uni', 'The placeholder deploy is ready whenever you are.', -426600));
    await add(page, { id: 'g1', title: 'T-303 Placeholder deploy', node: 'Areas/Techne', updatedAt: '2026-10-13T12:00:00.000Z', meta: { next: 'Say go on the placeholder deploy', asked: '2026-10-06T18:00:00.000Z', asked_at: '2026-10-06T18:00:00.000Z' } });
    await add(page, { id: 'g2', title: 'T-309 Placeholder budget', node: 'Areas/Techne', updatedAt: '2026-10-13T12:00:00.000Z', meta: { next: 'Say go on the quarterly budget', asked_at: '2026-10-13T12:00:00.000Z' } });
    await refresh(page, '2026-10-14T09:00:00.000Z');
    await openRoom(page, 'Techne');
    await openWork(page);
    // not confirmed: asked Oct 6, past 3 days
    await openTaskSheet(page, 'Say go on the placeholder deploy');
    let sheet = sheetOf(page);
    await expect(sheet.locator('.task-lookpending')).toHaveCount(0);
    await expect(sheet.locator('.task-do.primary')).toHaveText(/^Check in #techne first$/i);
    await expect(sheet.getByRole('button', { name: 'I did this' })).toHaveCount(0);
    await expect(sheet.getByRole('button', { name: /^Say it in #/ })).toHaveCount(0);
    // one tap: the answers, secondary
    await sheet.getByRole('button', { name: 'Answer anyway' }).click();
    await expect(sheet.getByRole('button', { name: 'I did this' })).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'I did this' })).not.toHaveClass(/primary/);
    await expect(sheet.locator('.task-do.primary')).toHaveText(/^Check in #techne first$/i);
    await sheet.getByRole('button', { name: 'Close' }).click();
    // r31: a current ask (its own asked_at is recent) has its ordinary actions, whatever the chat says
    await openTaskSheet(page, 'Say go on the quarterly budget');
    sheet = sheetOf(page);
    await expect(sheet.locator('.task-asked')).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Answer anyway' })).toHaveCount(0);
    await expect(sheet.getByRole('button', { name: 'I did this' })).toBeVisible();
    await expect(sheet.locator('.task-do.primary')).toHaveText(/^Say it in #/);
  });

  test('r26 P1 1: a decision\'s answers wait behind "Answer anyway" while its chat check is unresolved, and an answer records the revision it answered in the same write', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => (window as any).__arrive('ch-techne', 'Uni', 'The placeholder hosting choice is settled in the doc.', -426600));
    await add(page, { id: 'r26d1', title: 'Decide the placeholder hosting choice', tag: 'decision', node: 'Areas/Techne', updatedAt: '2026-10-13T12:00:00.000Z', meta: { options: ['Host A', 'Host B'], next: 'Pick the placeholder hosting choice', asked: '2026-10-06T18:00:00.000Z', asked_at: '2026-10-06T18:00:00.000Z', task: 'T-500' } });
    await refresh(page, '2026-10-14T09:00:00.000Z');
    await openRoom(page, 'Techne');
    await openWork(page);
    await openTaskSheet(page, 'placeholder hosting choice');
    const sheet = sheetOf(page);
    await expect(sheet.locator('.task-unconfirmed')).toBeVisible();
    await expect(sheet.locator('.task-do.primary')).toHaveText(/^Check in #techne first$/i);
    await expect(sheet.getByRole('button', { name: 'Host A' })).toHaveCount(0);
    await sheet.getByRole('button', { name: 'Answer anyway' }).click();
    await expect(sheet.getByRole('button', { name: 'Host A' })).toBeVisible();
    const rev = await page.evaluate(() => (window as any).__tasks.find((t: any) => t.id === 'r26d1').updatedAt);
    await sheet.getByRole('button', { name: 'Host A' }).click();
    await expect(sheetOf(page)).toHaveCount(0);
    const call = (await calls(page, 'vault_decide')).at(-1);
    expect(call.metadata.answered_rev).toBe(rev);
    expect(call.ifUpdatedAt).toBe(rev);
  });

  test('r26 P1 1: "I did this" records the revision it answered; a task that changed since the sheet opened says so and its answers wait for a reload', async ({ page }) => {
    await boot(page);
    await add(page, { id: 'rv1', title: 'T-601 Placeholder revision', node: 'Areas/Techne', meta: { next: 'Send the placeholder note to Casey' } });
    await refresh(page, '2026-10-14T09:00:00.000Z');
    await openRoom(page, 'Techne');
    await openWork(page);
    await openTaskSheet(page, 'placeholder note to Casey');
    let sheet = sheetOf(page);
    const rev0 = await page.evaluate(() => (window as any).__tasks.find((t: any) => t.id === 'rv1').updatedAt);
    // the task changes under the open sheet
    await page.evaluate(() => { const t = (window as any).__tasks.find((x: any) => x.id === 'rv1'); t.metadata.next = 'Send the placeholder plan to Casey instead'; t.updatedAt = new Date(Date.now() + 90_000).toISOString(); });
    await refresh(page, '2026-10-14T09:05:00.000Z');
    await expect(sheet.locator('[data-moved]')).toHaveText(/^This changed since you opened it\./);
    await expect(sheet.getByRole('button', { name: 'I did this' })).toHaveCount(0);
    await sheet.getByRole('button', { name: 'Reload' }).click();
    await expect(sheet.locator('[data-moved]')).toHaveCount(0);
    await expect(sheet.locator('h2')).toContainText('placeholder plan to Casey');
    const rev1 = await page.evaluate(() => (window as any).__tasks.find((t: any) => t.id === 'rv1').updatedAt);
    expect(rev1).not.toBe(rev0);
    await sheet.getByRole('button', { name: 'I did this' }).click();
    await expect(sheetOf(page)).toHaveCount(0);
    const call = (await calls(page, 'vault_transition')).at(-1);
    expect(call.metadata).toEqual({ answered_rev: rev1 });
  });

  test('r26 P1 2: a summary with nothing waiting on Aaron is shown as it is (COhere\'s real summary)', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => (window as any).__setStands('p-lvb', 'COhere 2026 is live on grove.example.org (new look, members, harvests; notifications off); tonight a time-of-day test failure blocks deploys while a fix is built, and register+sign-in (T-138) goes to staging for review on 10-15.'));
    await refresh(page, '2026-10-14T09:00:00.000Z');
    await openRoom(page, 'Learn Vibe Build');
    await openCompanion(page);
    await expect(page.locator('.cp-stale')).toHaveCount(0);
    await expect(page.locator('.cp-stands')).toContainText('COhere 2026 is live on grove.example.org');
  });

  test('r26 P1 3: the message being sent shows "Sending…" in its thread at once and the draft stays until it is delivered', async ({ page }) => {
    test.skip(!wide(page), 'the composer beside the tree');
    await boot(page);
    await openRoom(page, 'Techne');
    await page.evaluate(() => { (window as any).__postDelay = 1500; });
    const box = page.locator('.sr-chat textarea').first();
    await box.fill('A placeholder message sent while the first sync runs');
    await page.keyboard.press('Enter');
    const out = page.locator('article.message.outgoing');
    await expect(out).toContainText('A placeholder message sent while the first sync runs');
    await expect(out.locator('time')).toHaveText('Sending…');
    await expect(out).toHaveCount(0, { timeout: 8000 });
  });
});

test.describe('r27', () => {
  const refresh = async (page: Page, at: string) => { await page.clock.setFixedTime(Date.parse(at)); await page.evaluate(() => window.dispatchEvent(new Event('focus'))); };
  /** `updatedAt` is the record's own write, and (r28) when it was asked (`asked_at`): by default a day before the fixed clock, so the ask is confirmed (within 3 days) */
  const add = (page: Page, n: { id: string; title: string; node: string; tag?: string; meta?: Record<string, unknown>; updatedAt?: string }) => page.evaluate((x) => {
    (window as any).__tasks.push({ id: x.id, path: `Tasks/${x.title}`, extension: 'md', tags: [x.tag ?? 'task'], createdAt: '2026-10-06T16:00:00.000Z', updatedAt: x.updatedAt ?? '2026-10-13T12:00:00.000Z', lastUpdatedBy: 'u', lastUpdatedVia: 'mcp', content: x.title, metadata: { node: x.node, state: 'open', owner: 'aaron', priority: 'now', asked_at: x.updatedAt ?? '2026-10-13T12:00:00.000Z', ...(x.meta ?? {}) } });
  }, n);
  const NOW = '2026-10-14T09:00:00.000Z';
  const sheetOf = (page: Page) => page.getByRole('dialog').filter({ has: page.locator('.task-kind') });
  const openWork = async (page: Page) => { await openCompanion(page); await page.getByRole('button', { name: /^All of .*'s work/ }).click(); await expect(page.locator('.sr-work')).toBeVisible(); };
  const rowOf = (page: Page, text: string) => page.locator('.sr-work .cp-item').filter({ hasText: text });
  const NEXT113 = "On your phone, look at https://grove.example.org (live now), then forward Harper the asks listed in this task's detail";
  const DETAIL113 = "Live on prod since 10-14 15:24 (PR #61); staging matches. Harper still owes: (1) OK or cut 6 groups of short functional lines (notifications, email links, install, privacy, harvest/board, profile labels); (2) 3 answers: Spanish versions of 'What is COhere?' and 'What's Coming Up', whether 'Explore events on the community events' should end in 'calendar', whether the signed-in Home also gets the hat photo; (3) one morning-practice line per day for Oct 15–25 (her doc has 2); (4) yes/no on the Today heading showing just 'Honoring Water (9 AM at Martin Park)' with 'Home practice:' in bold. Aaron: sign in once as a member and open Board, People and Me.";
  const t113 = (page: Page) => add(page, { id: 'n113', title: 'T-113 Companion Today redesign + integrated PWA install flow (3…', node: 'Areas/Techne', meta: { due: '2026-10-13', next: NEXT113, detail: DETAIL113, waiting_on: 'aaron', state: 'waiting' } });
  /** every item line of a row is whole (two lines at most, no cut mark, never ending on a colon or a comma) and the shown ones and "and N more" add up to the list */
  const itemsAreWhole = async (row: ReturnType<Page['locator']>, total: number) => {
    const lines = await row.locator('.cp-item-line').evaluateAll((els) => els.map((e) => ({ text: (e as HTMLElement).innerText.trim(), lines: Math.round(e.getBoundingClientRect().height / (parseFloat(getComputedStyle(e).lineHeight) || 17)) })));
    for (const l of lines) { expect(l.lines, l.text).toBeLessThanOrEqual(2); expect(l.text).not.toMatch(/[,;:]$|…|\.\.\./); expect(l.text).not.toMatch(/^3 answers$/); }
    const more = await row.locator('.cp-item-more').count() ? (await row.locator('.cp-item-more').innerText()).trim() : '';
    const n = /^(\d+) \w+ in all$/.exec(more) ? Number(/^(\d+) /.exec(more)![1]) : lines.length;
    expect(n, `shown ${lines.length} + ${more}`).toBe(total);
    return lines.map((l) => l.text);
  };

  test('r27 line 5.1: T-113\'s row carries whole items (each at most two lines, cut at no colon or comma), in the panel and in the work view', async ({ page }) => {
    test.skip(!wide(page), 'side panel');
    await page.setViewportSize({ width: 1280, height: 720 });
    await boot(page);
    await t113(page);
    await refresh(page, NOW);
    await openRoom(page, 'Techne');
    await openCompanion(page);
    const prow = page.locator('.cp.side .cp-item').filter({ hasText: 'grove.example.org' });
    await expect(prow.locator('.cp-items')).toBeVisible();
    const inPanel = await itemsAreWhole(prow, 4);
    expect(inPanel.length).toBeLessThanOrEqual(3);
    // the panel keeps its footer in view: the row ends above it
    const foot = (await page.locator('.cp.side .cp-foot').boundingBox())!, rb = (await prow.boundingBox())!;
    expect(rb.y + rb.height).toBeLessThanOrEqual(foot.y + 1);
    await openWork(page);
    const row = rowOf(page, 'grove.example.org');
    const inWork = await itemsAreWhole(row, 4);
    expect(inWork.length).toBeGreaterThanOrEqual(inPanel.length);
    // "3 answers" is its clause: what the answers are
    if (inWork.some((t) => /^Spanish versions/.test(t))) expect(inWork.join('\n')).not.toMatch(/^3 answers/m);
    expect(inWork).toContain('one morning-practice line per day for Oct 15–25 (her doc has 2)');
  });

  test('r27 line 5.1: an item too long for two lines is not shown cut: fewer items and the list total', async ({ page }) => {
    test.skip(!wide(page), 'side panel');
    await page.setViewportSize({ width: 1280, height: 720 });
    await boot(page);
    await add(page, { id: 'long1', title: 'T-801 Placeholder asks', node: 'Areas/Techne', meta: { next: 'Forward Casey the asks listed in this task\'s detail', state: 'waiting', waiting_on: 'aaron',
      detail: 'Casey owes: (1) A very long first ask that keeps going and going with many words about the venue and the dates and the budget and the parking and the signage and the schedule for the whole week; (2) short one; (3) another short one' } });
    await refresh(page, NOW);
    await openRoom(page, 'Techne');
    await openCompanion(page);
    const prow = page.locator('.cp.side .cp-item').filter({ hasText: 'Forward Casey the asks' });
    const lines = await itemsAreWhole(prow, 3);
    expect(lines.join(' ')).not.toContain('A very long first ask that keeps going');
    await expect(prow.locator('.cp-item-more')).toBeVisible();
  });

  test('r27 line 5.2: the Checking banner ends at a whole word with no trailing comma, semicolon or colon', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => (window as any).__arrive('ch-techne', 'Uni', 'The placeholder deploy is ready whenever you are.', -426600));
    await add(page, { id: 'bn1', title: 'T-303 Placeholder deploy', node: 'Areas/Techne', meta: { next: 'Say go on the placeholder deploy (recommended: keep 15, fold 32, archive 40), then confirm the quarterly numbers with Casey and the dates for the whole rollout, and the parking', asked: '2026-10-06T18:00:00.000Z', asked_at: '2026-10-06T18:00:00.000Z' } });
    await refresh(page, NOW);
    await openRoom(page, 'Techne');
    await openWork(page);
    await openTaskSheet(page, 'placeholder deploy');
    await sheetOf(page).locator('.task-do.primary').click();
    const banner = page.locator('.checking-banner');
    await expect(banner).toHaveText(/^Checking: /);
    const text = (await banner.locator('.checking-text').innerText()).trim();
    expect(text).not.toMatch(/[,;:]$|…|\.\.\./);
    expect((await banner.boundingBox())!.height, 'one line').toBeLessThan(40);
    const lines = await banner.locator('.checking-text').evaluate((el) => Math.round(el.getBoundingClientRect().height / (parseFloat(getComputedStyle(el).lineHeight) || 16)));
    expect(lines).toBe(1);
  });

  test('r27 line 5.3 + 5.4, r28: a sheet has no heading with nothing under it, and a decision sheet never repeats its title as its body', async ({ page }) => {
    await boot(page);
    await add(page, { id: 'dc1', title: 'T-510 Ship the placeholder chat?', tag: 'decision', node: 'Areas/Techne', meta: { options: ['Yes', 'No'], next: 'Ship the placeholder chat? (preview: https://chat.placeholder-preview.pages.dev)', asked: '2026-10-12T18:00:00.000Z' } });
    await refresh(page, NOW);
    await openRoom(page, 'Techne');
    await openWork(page);
    await openTaskSheet(page, 'Ship the placeholder chat');
    const sheet = sheetOf(page);
    expect((await sheet.innerText()).match(/Ship the placeholder chat/g)?.length).toBe(1);
    // the preview link it carried is still a way in
    await expect(sheet.getByRole('button', { name: /^Open chat/ })).toBeVisible();
    // the sheet has its Details, no empty heading, and the question is still said once
    await expect(sheet.locator('summary')).toHaveText('Details');
    for (const h of await sheet.locator('h1, h2, h3, summary').all()) expect((await h.innerText()).trim().length).toBeGreaterThan(0);
    expect((await sheet.innerText()).match(/Ship the placeholder chat/g)?.length).toBe(1);
  });

  test('r27 line 5.5: a multi-step task\'s sheet shows "Step 1 of 2" without scrolling, with the asks under it (1280×720)', async ({ page }) => {
    test.skip(!wide(page), 'desktop sheet');
    await page.setViewportSize({ width: 1280, height: 720 });
    await boot(page);
    await t113(page);
    await refresh(page, NOW);
    await openRoom(page, 'Techne');
    await openWork(page);
    await openTaskSheet(page, 'grove.example.org');
    const sheet = sheetOf(page);
    await expect(sheet.locator('.task-stepof')).toHaveText('Step 1 of 2');
    await expect(sheet.locator('.task-stepof')).toBeInViewport({ ratio: 1 });
    const s = (await sheet.locator('.task-steps').boundingBox())!, i = (await sheet.locator('.task-items').boundingBox())!;
    expect(i.y, 'the asks follow the steps').toBeGreaterThan(s.y);
    await expect(sheet.locator('.task-items li')).toHaveCount(4);
  });

  test('r27 line 6: All-work uses the companion\'s names; a run waiting on the user\'s answer is in Needs you; no records-to-reword section', async ({ page }) => {
    await boot(page);
    await add(page, { id: 'wk1', title: 'T-520 Placeholder go', node: 'Areas/Techne', meta: { next: 'Say go on the placeholder go', state: 'waiting', waiting_on: 'aaron' } });
    await add(page, { id: 'wk3', title: 'T-522 Placeholder plan', node: 'Areas/Techne', meta: { owner: 'casey', next: 'Casey writes the placeholder plan', state: 'doing' } });
    await add(page, { id: 'wk2', title: 'T-521 Outline', node: 'Areas/Techne', meta: { next: 'Notes: real work in area rooms, check updates propagate up; nested room names; fractal flow', state: 'waiting', waiting_on: 'aaron' } });
    await page.evaluate(() => {
      const w = window as any;
      w.__addRun('rw1', 'Areas/Techne', '', 'Waiting on your answer in #Uni: release 0.1.46 placeholder', 'decision');
      w.__addRun('rw2', 'Areas/Techne', 'T-520', 'Placeholder build underway', 'running');
      w.__addRun('rw3', 'Areas/Techne', 'T-520', 'Placeholder build finished', 'done');
    });
    await refresh(page, NOW);
    await openRoom(page, 'Techne');
    await openWork(page);
    const wv = page.locator('.sr-work');
    const labels = await wv.locator('section').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
    expect(labels).toEqual(expect.arrayContaining(['Needs you', 'Running', 'With others', 'Done lately']));
    expect(labels).not.toContain('Being worked on');
    expect(labels).not.toContain('Records to reword');
    const needs = wv.locator('section[aria-label="Needs you"]');
    // r28: the row's step is the question; "in #Uni" is its place; it is counted with the asks
    await expect(needs.locator('.cp-run-waiting .cp-run-step')).toHaveText('Release 0.1.46 placeholder');
    await expect(needs.locator('.cp-run-waiting .cp-run-place')).toHaveText('in #Uni');
    await expect(needs.locator('.cp-run-waiting .cp-run-open > small')).toHaveText('Waiting on you');
    await expect(needs.locator('.wv-n')).toHaveText('2');
    const running = wv.locator('section[aria-label="Running"]');
    await expect(running).toContainText('Placeholder build underway');
    expect(await running.innerText()).not.toMatch(/Waiting on your answer|not waiting on you/);
    // a task someone else holds is not "Running": it is With others
    await expect(wv.locator('section[aria-label="With others"]')).toContainText('Casey writes the placeholder plan');
    expect(await running.innerText()).not.toContain('Casey writes the placeholder plan');
    await expect(wv.locator('section[aria-label="Done lately"]')).toContainText('Placeholder build finished');
    expect(await wv.innerText()).not.toMatch(/records? needs? rewording|need rewording/i);
    // the panel says the same: the waiting run is under Needs you, not Running
    await page.getByRole('button', { name: /^Back to chat/ }).click();
    await openCompanion(page);
    if (wide(page)) {
      const side = page.locator('.cp.side .cp-body');
      await expect(side.locator('section[aria-label="Needs you"] .cp-run-step')).toHaveText('Release 0.1.46 placeholder');
      expect(await side.locator('section[aria-label="Running"]').innerText()).not.toContain('Release 0.1.46');
    }
  });

  test('r27 P1-1: a request is current only when its own record (asked_at, within 3 days) vouches for it; the sheet leads with answers only then (r31: chat is not read)', async ({ page }) => {
    await boot(page);
    // the chat is from 3 days before the fixed clock: older than the record's write below
    await page.evaluate(() => (window as any).__arrive('ch-techne', 'Uni', 'The placeholder deploy is ready whenever you are.', 6 * 86400));
    await add(page, { id: 'f1', title: 'T-303 Placeholder deploy', node: 'Areas/Techne', updatedAt: '2026-10-13T12:00:00.000Z', meta: { next: 'Say go on the placeholder deploy', asked: '2026-10-06T18:00:00.000Z', asked_at: '2026-10-13T12:00:00.000Z' } });
    await refresh(page, NOW);
    await openRoom(page, 'Techne');
    await openWork(page);
    // current: written yesterday, nothing related since
    await openTaskSheet(page, 'Say go on the placeholder deploy');
    let sheet = sheetOf(page);
    await expect(sheet.locator('.task-asked')).toHaveAttribute('data-fresh', 'current');
    await expect(sheet.locator('.task-asked')).toHaveText(/^Asked Oct 6$/);
    await expect(sheet.locator('.task-do.primary')).toHaveText(/^Say it in #/);
    await expect(sheet.getByRole('button', { name: 'I did this' })).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Answer anyway' })).toHaveCount(0);
    expect(await sheet.innerText()).not.toMatch(/not confirmed|nothing related|validated|confirmed/i);
    await sheet.getByRole('button', { name: 'Close' }).click();
    // a record older than 3 days: unconfirmed, whatever the chat says
    await page.evaluate(() => { const t = (window as any).__tasks.find((x: any) => x.id === 'f1'); t.updatedAt = '2026-10-09T12:00:00.000Z'; t.metadata.asked_at = '2026-10-09T12:00:00.000Z'; });
    await refresh(page, '2026-10-14T09:05:00.000Z');
    await openTaskSheet(page, 'Say go on the placeholder deploy');
    sheet = sheetOf(page);
    await expect(sheet.locator('.task-asked')).toHaveAttribute('data-fresh', 'unconfirmed');
    await expect(sheet.locator('.task-asked')).toHaveText('Asked Oct 6 · not confirmed since');
    await expect(sheet.locator('.task-do.primary')).toHaveText(/^Check in #techne first$/i);
    await expect(sheet.getByRole('button', { name: 'I did this' })).toHaveCount(0);
    await expect(sheet.getByRole('button', { name: /^Say it in #/ })).toHaveCount(0);
    await sheet.getByRole('button', { name: 'Answer anyway' }).click();
    await expect(sheet.getByRole('button', { name: 'I did this' })).not.toHaveClass(/primary/);
    await expect(sheet.locator('.task-do.primary')).toHaveText(/^Check in #techne first$/i);
  });

  test('r27 P1-1: an ask past 3 days and a record with no date are unconfirmed, whatever the chat says (r31)', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => (window as any).__arrive('ch-techne', 'Uni', 'The placeholder deploy is ready whenever you are.', -426600));
    await add(page, { id: 'u1', title: 'T-303 Placeholder deploy', node: 'Areas/Techne', updatedAt: '2026-10-13T12:00:00.000Z', meta: { next: 'Say go on the placeholder deploy', asked: '2026-10-06T18:00:00.000Z', asked_at: '2026-10-06T18:00:00.000Z' } });
    await add(page, { id: 'u2', title: 'T-309 Placeholder budget', node: 'Areas/Techne', updatedAt: '', meta: { next: 'Say go on the quarterly budget', asked: '2026-10-06T18:00:00.000Z', asked_at: null } });
    await refresh(page, NOW);
    await openRoom(page, 'Techne');
    await openWork(page);
    // related chat newer than the write
    await openTaskSheet(page, 'Say go on the placeholder deploy');
    let sheet = sheetOf(page);
    await expect(sheet.locator('.task-asked')).toHaveAttribute('data-fresh', 'unconfirmed');
    await expect(sheet.locator('.task-asked')).toHaveText(/^Asked Oct 6 · not confirmed since$/i);
    await expect(sheet.locator('.task-do.primary')).toHaveText(/^Check in #techne first$/i);
    expect(await sheet.innerText()).not.toMatch(/has talked about|nothing related/i);
    await sheet.getByRole('button', { name: 'Close' }).click();
    // no date to vouch with
    await openTaskSheet(page, 'Say go on the quarterly budget');
    sheet = sheetOf(page);
    await expect(sheet.locator('.task-asked')).toHaveAttribute('data-fresh', 'unconfirmed');
    await expect(sheet.locator('.task-do.primary')).toHaveText(/^Check in #techne first$/i);
    await sheet.getByRole('button', { name: 'Close' }).click();
    // r31: nothing is read from the room, so there is no "couldn't read": the same two asks classify the same on every launch
    await refresh(page, '2026-10-14T09:02:00.000Z');
    await openTaskSheet(page, 'Say go on the placeholder deploy');
    sheet = sheetOf(page);
    await expect(sheet.locator('.task-lookfail')).toHaveCount(0);
    await expect(sheet.locator('.task-asked')).toHaveAttribute('data-fresh', 'unconfirmed');
    await expect(sheet.getByRole('button', { name: 'I did this' })).toHaveCount(0);
    await sheet.getByRole('button', { name: 'Answer anyway' }).click();
    await expect(sheet.getByRole('button', { name: 'I did this' })).toBeVisible();
  });

  test('r29 P1-3: a summary is "Last written Oct 14 by #room:" and the text as written, below Needs you, whether or not anything changed after it; a long one is behind "What it said"', async ({ page }) => {
    await boot(page);
    const SUMMARY = 'COhere 2026 is live on grove.example.org (new look, members, harvests; notifications off); tonight a time-of-day test failure blocks deploys while a fix is built, and register+sign-in (T-138) goes to staging for review on 10-15.';
    await page.evaluate((s) => (window as any).__setStands('p-lvb', s, '2026-10-14T12:00:00.000Z'), SUMMARY);
    await refresh(page, '2026-10-14T20:00:00.000Z');
    await openRoom(page, 'Learn Vibe Build');
    await openCompanion(page);
    const note = page.locator('.cp-body .cp-stands-note');
    await expect(note.locator('.cp-asof')).toHaveText(/^Last written Oct 14 by #\S+:$/);
    await expect(note.locator('.cp-stands')).toHaveText(/^COhere 2026 is live on grove\.example\.org/);
    expect(await note.locator('.cp-stands').innerText()).not.toMatch(/…|\.\.\./);
    await expect(note.locator('.cp-said')).toHaveCount(0); // short: whole
    // below Needs you, never leading
    expect((await note.boundingBox())!.y).toBeGreaterThan((await page.locator('.cp-body').getByRole('region', { name: 'Needs you' }).boundingBox())!.y);
    // a task under the node changed after the summary: the same line, no notice
    await add(page, { id: 'nw1', title: 'T-322 Placeholder newer change', node: 'Projects/Learn Vibe Build', updatedAt: '2026-10-14T18:00:00.000Z', meta: { priority: 'now', next: 'Edit the placeholder note for Casey', asked: '2026-10-14T18:00:00.000Z' } });
    await refresh(page, '2026-10-14T20:05:00.000Z');
    await expect(page.locator('.cp-stale, [data-stale], [data-stale-why]')).toHaveCount(0);
    await expect(note.locator('.cp-asof')).toHaveText(/^Last written Oct 14 by #\S+:$/);
  });

  test('r29 P1-3: a long summary is behind one line, "Where this stands · Oct 14, #room"', async ({ page }) => {
    await boot(page);
    const LONG = 'COhere 2026 is live on grove.example.org (new look, members, harvests; notifications off); tonight a time-of-day test failure blocks deploys while a fix is built, and register+sign-in (T-138) goes to staging for review on 10-15; the festival crew list needs a second pass by Friday, and the harvest sign-up copy waits for the new photographs from the farm.';
    await page.evaluate((s) => (window as any).__setStands('p-lvb', s, '2026-10-14T12:00:00.000Z'), LONG);
    await refresh(page, '2026-10-14T20:10:00.000Z');
    await openRoom(page, 'Learn Vibe Build');
    await openCompanion(page);
    const note = page.locator('.cp-body .cp-stands-note');
    const said = note.locator('.cp-said');
    // r31: one line that opens it, the heading folded into the date and room (no colon with nothing after it)
    await expect(note.locator('.cp-asof')).toHaveCount(0);
    await expect(said.locator('summary')).toHaveText(/^Where this stands · Oct 14, #\S+$/);
    await expect(said).not.toHaveAttribute('open', '');
    await said.locator('summary').click();
    await expect(said.locator('p')).toHaveText(/^COhere 2026 is live on grove\.example\.org .*from the farm\.$/);
  });

  test('r29 P1-3: the work view says the same, below Needs you, and a wait claim is not judged', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => (window as any).__setStands('p-lvb', "Cohort two starts Oct 15; prod deploy of #38 waits on Aaron's go.", '2026-10-14T12:00:00.000Z'));
    await refresh(page, '2026-10-14T20:00:00.000Z');
    await openRoom(page, 'Learn Vibe Build');
    await openCompanion(page);
    await expect(page.locator('.cp-stale, [data-stale], [data-stale-why]')).toHaveCount(0);
    await expect(page.locator('.cp-asof')).toHaveText(/^Last written Oct 14 by #\S+:$/);
    await openWork(page);
    await expect(page.locator('.sr-work .cp-stale, .sr-work [data-stale-why]')).toHaveCount(0);
    await expect(page.locator('.sr-work .cp-asof')).toHaveText(/^Last written Oct 14 by #\S+:$/);
    await expect(page.locator('.sr-work .cp-stands')).toHaveText("Cohort two starts Oct 15; prod deploy of #38 waits on Aaron's go.");
    expect((await page.locator('.sr-work .wv-top').boundingBox())!.y).toBeGreaterThan((await page.locator('.sr-work').getByRole('region', { name: 'Needs you' }).boundingBox())!.y);
  });
});

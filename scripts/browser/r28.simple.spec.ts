// T-124 r28: Needs you holds only confirmed asks (asked_at, resolved in the feed); everything else is one quiet recheck line; one count; every row whole;
// waiting runs are rows; summaries dim only for their own node; one compact panel.
// Run: SIMPLE_TEST_PORT=5711 npx playwright test --config playwright.simple.config.ts r28
import { test, expect, type Locator, type Page } from '@playwright/test';
import { bootAreas, focusSheet, openAreasHome, openDetails } from './areasFixture';

const wide = (page: Page) => (page.viewportSize()?.width ?? 0) >= 900;
const base = { briefs: true, tree: true, tasks: true, atlas: true, steer: true, pinned: true } as const;
const boot = async (page: Page, extra: Parameters<typeof bootAreas>[2] = {}) => { await bootAreas(page, 'seed', { ...base, ...extra }); };
const home = (page: Page) => page.locator('[data-place="front-door"][data-view="places"]');
/** T-335 one surface: a room is in focus over All, opened from its door on Uni's home, or (a place inside an area) from the area's details */
const INSIDE: Record<string, string> = { 'Atlas Institute': 'Atlas', 'Learn Vibe Build': 'Atlas', ATLAS: 'Atlas' };
async function openRoom(page: Page, name: string, parent: string | null = INSIDE[name] ?? null) {
  if (!(await home(page).isVisible())) await openAreasHome(page);
  await home(page).locator(`.fd-door[data-path="Areas/${parent ?? name}"]`).click();
  if (parent) { await openDetails(page); await focusSheet(page).getByRole('region', { name: `Inside ${parent}` }).locator('.fx-place').filter({ has: page.getByText(name, { exact: true }) }).click(); }
  await expect(focusSheet(page).locator('.all-focus-title')).toHaveText(name);
}
/** T-335: the dot that counts what needs you is on the place's door on Uni's home */
async function doorSays(page: Page, name: string, n: number) {
  await openAreasHome(page);
  await expect(home(page).locator(`.fd-door[data-path="Areas/${name}"]`)).toHaveAttribute('aria-label', new RegExp(`^${name}, (.*, )?${n} needs? you(,|\\.|$)`));
}
const details = (page: Page) => focusSheet(page).locator('.all-focus-details .cp-body');
/** T-335: what the old companion held (Needs you, Running, the dated summary) is the room's details, inside its focus */
async function openCompanion(page: Page) {
  await openDetails(page);
  await expect(focusSheet(page).locator('.all-focus-details .cp-body').first()).toBeVisible();
}
async function openWork(page: Page) { await openCompanion(page); await focusSheet(page).getByRole('button', { name: /^All of .*'s work/ }).first().click(); await expect(page.locator('.fx-work')).toBeVisible(); }
const sheetOf = (page: Page) => page.getByRole('dialog').filter({ has: page.locator('.task-kind') });
const NOW = '2026-10-14T09:00:00.000Z';
const refresh = async (page: Page, at: string = NOW) => { await page.clock.setFixedTime(Date.parse(at)); await page.evaluate(() => window.dispatchEvent(new Event('focus'))); };
const RECENT = '2026-10-13T12:00:00.000Z';
/** a task note written straight into the mock vault; `asked_at` is given (null: the record has none) */
const add = (page: Page, n: { id: string; title: string; node: string; tag?: string; asked_at?: string | null; updatedAt?: string; meta?: Record<string, unknown> }) => page.evaluate((x) => {
  (window as any).__tasks.push({ id: x.id, path: `Tasks/${x.title}`, extension: 'md', tags: [x.tag ?? 'task'], createdAt: '2026-10-06T16:00:00.000Z', updatedAt: x.updatedAt ?? '2026-10-13T12:00:00.000Z', lastUpdatedBy: 'u', lastUpdatedVia: 'mcp', content: x.title,
    metadata: { node: x.node, state: 'open', owner: 'aaron', priority: 'now', asked_at: x.asked_at === undefined ? '2026-10-13T12:00:00.000Z' : x.asked_at, ...(x.meta ?? {}) } });
}, n);
const section = (page: Page, label: string) => page.locator('.fx-work').getByRole('region', { name: label });
/** nothing on a row is cut: no element clips its own text, no cut mark */
async function rowsWhole(rows: Locator) {
  const bad = await rows.evaluateAll((lis) => lis.flatMap((li) => [li, ...li.querySelectorAll('*')].filter((el) => {
    const e = el as HTMLElement; const cs = getComputedStyle(e);
    const clips = (cs.overflowY !== 'visible' || cs.overflowX !== 'visible') && cs.display !== 'inline' && !e.matches('.cp-sub-where, .fit-full, .fit-short, .cp-sub') && (e.scrollHeight > e.clientHeight + 1);
    return clips || /…|\.\.\./.test(e.children.length ? '' : e.innerText || '');
  }).map((el) => (el as HTMLElement).className + ': ' + ((el as HTMLElement).innerText || '').slice(0, 60))));
  expect(bad, 'cut text in rows').toEqual([]);
}

test.describe('r28', () => {
  test('line 1+2: Needs you holds only confirmed asks; the rest is one quiet line, a plain list, never counted, and never a dot', async ({ page }) => {
    test.skip(!wide(page), 'work view');
    await boot(page);
    await add(page, { id: 'c1', title: 'T-601 Placeholder alpha', node: 'Areas/Techne', meta: { next: 'Say go on alpha' } });                                   // confirmed
    await add(page, { id: 'c2', title: 'T-602 Placeholder beta', node: 'Areas/Techne', asked_at: null, meta: { next: 'Say go on beta' } });                    // no asked_at (updated_at is fresh: it must not matter)
    await add(page, { id: 'c3', title: 'T-603 Placeholder gamma', node: 'Areas/Techne', asked_at: '2026-10-09T12:00:00.000Z', meta: { next: 'Say go on gamma' } }); // 5 days
    await add(page, { id: 'c4', title: 'T-604 Placeholder delta', node: 'Areas/Techne', asked_at: '2026-10-20T12:00:00.000Z', meta: { next: 'Say go on delta' } }); // future
    await add(page, { id: 'c5', title: 'T-605 Placeholder epsilon', node: 'Areas/Techne', asked_at: '2026-10-09T12:00:00.000Z', meta: { next: 'Say go on epsilon', confirmed_at: RECENT } }); // asked 5 days ago, confirmed since (r31)
    // r31: chat never promotes or demotes an ask: talk about the confirmed one changes nothing
    await page.evaluate(() => (window as any).__arrive('ch-techne', 'Uni', 'T-601 alpha is now ready, so the request has changed.', -426600));
    await refresh(page);
    await openRoom(page, 'Techne');
    await openWork(page);
    const needs = section(page, 'Needs you');
    await expect(needs.locator('.cp-list > li.cp-item').filter({ hasText: 'Say go on alpha' })).toHaveCount(1);
    await expect(needs.locator('.cp-list > li.cp-item').filter({ hasText: 'Say go on epsilon' })).toHaveCount(1);
    for (const w of ['beta', 'gamma', 'delta']) await expect(needs.locator('.cp-list > li.cp-item').filter({ hasText: `Say go on ${w}` })).toHaveCount(0);
    // the count is the rows of Needs you (and the runs waiting on the user), never the rechecks
    const rowCount = await needs.locator('.cp-list > li.cp-item, .cp-waiting > li').count();
    await expect(needs.locator('.wv-n')).toHaveText(String(rowCount));
    // the dot on Techne's door counts the same (checked at the end: it leaves the room)
    // one quiet line, collapsed; it opens to a plain list
    const line = needs.locator('.cp-recheck-line');
    await expect(line).toHaveText(/^\d+ requests? needs? confirming in this room\+$/);
    await expect(needs.locator('.cp-recheck-list')).toHaveCount(0);
    const n = Number((await line.innerText()).match(/\d+/)![0]);
    expect(n).toBeGreaterThanOrEqual(3);
    await line.click();
    const items = needs.locator('.cp-recheck-item');
    await expect(items).toHaveCount(n);
    const beta = items.filter({ hasText: 'Say go on beta' });
    await expect(beta.locator('.cp-recheck-step')).toHaveText('Say go on beta');
    await expect(beta.locator('.cp-recheck-asked')).toHaveText(/^(asked|added) [A-Z][a-z]{2} \d+$/);
    await expect(beta.locator('.cp-rc-open')).toBeVisible();
    // r30: "Answer anyway" is in the sheet, never on a list row
    await expect(beta.getByRole('button', { name: 'Answer anyway' })).toHaveCount(0);
    // not counted, no dots: nothing in the list is a Needs-you row
    await expect(needs.locator('.wv-n')).toHaveText(String(rowCount));
    for (const t of await items.locator('.cp-recheck-step').allInnerTexts()) expect(t).not.toMatch(/[:;,—–-]$|…|\.\.\./);
    // Open: the sheet says it is not confirmed since; Answer anyway: the sheet with its answers ready, one tap
    await beta.locator('.cp-rc-open').click();
    let sheet = sheetOf(page);
    await expect(sheet.locator('.task-asked')).toHaveAttribute('data-fresh', 'unconfirmed');
    await expect(sheet.locator('.task-asked')).toHaveText(/not confirmed since$/);
    await expect(sheet.getByRole('button', { name: 'I did this' })).toHaveCount(0);
    await sheet.getByRole('button', { name: 'Close' }).click();
    await items.filter({ hasText: 'Say go on gamma' }).locator('.cp-rc-open').click();
    sheet = sheetOf(page);
    await sheet.getByRole('button', { name: 'Answer anyway' }).click();
    await expect(sheet.getByRole('button', { name: 'I did this' })).toBeVisible();
    await sheet.getByRole('button', { name: 'Close' }).click();
    // the confirmed ask's sheet has its answers ready and no "not confirmed" line
    await needs.locator('.cp-list > li.cp-item').filter({ hasText: 'Say go on alpha' }).locator('.cp-need').click();
    sheet = sheetOf(page);
    await expect(sheet.locator('.task-asked')).toHaveAttribute('data-fresh', 'current');
    await expect(sheet.getByRole('button', { name: 'I did this' })).toBeVisible();
    expect(await sheet.innerText()).not.toMatch(/not confirmed/);
    await sheet.getByRole('button', { name: 'Close' }).click();
    await doorSays(page, 'Techne', rowCount);
  });

  test('line 1: an unrelated edit never confirms an ask: a fresh updated_at with no asked_at is a recheck', async ({ page }) => {
    test.skip(!wide(page), 'work view');
    await boot(page);
    await add(page, { id: 'e1', title: 'T-611 Placeholder edited', node: 'Areas/Techne', asked_at: null, updatedAt: '2026-10-14T08:59:00.000Z', meta: { next: 'Say go on edited' } });
    await refresh(page);
    await openRoom(page, 'Techne');
    await openWork(page);
    await expect(section(page, 'Needs you').locator('.cp-list > li.cp-item').filter({ hasText: 'Say go on edited' })).toHaveCount(0);
    await section(page, 'Needs you').locator('.cp-recheck-line').click();
    await expect(section(page, 'Needs you').locator('.cp-recheck-item').filter({ hasText: 'Say go on edited' })).toHaveCount(1);
  });

  test('line 3: a run waiting on the user\'s answer is a row whose step is the question; "in #Uni" is its place; counted once with the asks, deduplicated by task', async ({ page }) => {
    test.skip(!wide(page), 'work view');
    await boot(page);
    await add(page, { id: 'w1', title: 'T-631 Placeholder go', node: 'Areas/Techne', meta: { next: 'Say go on placeholder go' } });
    await page.evaluate(() => {
      const w = window as any;
      w.__addRun('rq1', 'Areas/Techne', '', 'Waiting on your answer in #Uni: Ship the placeholder 0.1.46?', 'decision');
      w.__addRun('rq2', 'Areas/Techne', 'T-631', 'Waiting on your answer in #Uni: Say go on placeholder go', 'decision');
    });
    await refresh(page);
    await openRoom(page, 'Techne');
    await openWork(page);
    const needs = section(page, 'Needs you');
    const run = needs.locator('.cp-waiting > li');
    await expect(run).toHaveCount(1);
    await expect(run.locator('.cp-run-step')).toHaveText('Ship the placeholder 0.1.46?');
    await expect(run.locator('.cp-run-place')).toHaveText('in #Uni');
    expect(await run.innerText()).not.toMatch(/Waiting on your answer/);
    expect(await run.locator('.cp-run-step').innerText()).not.toMatch(/[:;,—–-]$/);
    // T-631's run is its own row (once): the count is the ask plus the unnamed run
    await expect(needs.locator('.cp-list > li.cp-item').filter({ hasText: 'Say go on placeholder go' })).toHaveCount(1);
    const rows = await needs.locator('.cp-list > li.cp-item, .cp-waiting > li').count();
    await expect(needs.locator('.wv-n')).toHaveText(String(rows));
    // the details say the same, under Needs you and not Running
    await focusSheet(page).locator('.all-focus-back').click();
    const side = details(page);
    await expect(side.locator('section[aria-label="Needs you"] .cp-run-step')).toHaveText('Ship the placeholder 0.1.46?');
    expect(await side.locator('section[aria-label="Running"]').count() ? await side.locator('section[aria-label="Running"]').innerText() : '').not.toContain('Ship the placeholder');
    // and the door on Uni's home counts the same
    await doorSays(page, 'Techne', rows);
  });

  test('line 3: a row is whole or it is not shown, in the room\'s details and the work view; inline sub-items are at most two, then the list total ("4 asks in all")', async ({ page }) => {
    test.skip(!wide(page), 'one wide window');
    await page.setViewportSize({ width: 1280, height: 720 });
    await boot(page);
    await add(page, { id: 'l1', title: 'T-651 Placeholder long', node: 'Areas/Techne', meta: { next: 'Reply to Harper with the placeholder answers, then paste the same key into the second place she named, and tell her once it works for the whole crew (paste the same key)' } });
    await add(page, { id: 'l2', title: 'T-652 Placeholder list', node: 'Areas/Techne', meta: { next: 'Forward Harper the asks listed in this task\'s detail', detail: 'Harper still owes: (1) OK or cut 6 groups of short functional lines; (2) the Spanish versions of two page names; (3) one morning-practice line per day; (4) yes or no on the heading.' } });
    await refresh(page);
    await openRoom(page, 'Techne');
    await openCompanion(page);
    const side = details(page);
    await rowsWhole(side.locator('section[aria-label="Needs you"] li.cp-item'));
    const row = side.locator('li.cp-item').filter({ hasText: 'Forward Harper the asks' });
    if (await row.count()) {
      const shown = await row.locator('.cp-item-line').count();
      expect(shown).toBeLessThanOrEqual(2);
      // r31: the count is the list's own length, whatever is drawn
      if (shown < 4) await expect(row.locator('.cp-item-more')).toHaveText(/^4 \w+ in all$/);
      else await expect(row.locator('.cp-item-more')).toHaveCount(0);
    }
    await openWork(page);
    await rowsWhole(section(page, 'Needs you').locator('li.cp-item'));
    await expect(section(page, 'Needs you').locator('li.cp-item').filter({ hasText: 'paste the same key' })).toContainText('tell her once it works for the whole crew');
  });

  test('r29 P1-3: nothing that changes after a summary was written (an ask on its node, a closure, a change on its area) dims it or adds a notice: the date is the signal', async ({ page }) => {
    test.skip(!wide(page), 'one wide window');
    await boot(page);
    await page.evaluate(() => (window as any).__setStands('p-lvb', 'Cohort two starts Oct 15; grading briefs are queued.', '2026-10-14T06:00:00.000Z'));
    await add(page, { id: 'cl2', title: 'T-672 Placeholder closed that day', node: 'Projects/Learn Vibe Build', asked_at: null, meta: { state: 'archived', closed: '2026-10-14' } });
    await add(page, { id: 'sm2', title: 'T-662 Placeholder on the node', node: 'Projects/Learn Vibe Build', asked_at: '2026-10-14T08:00:00.000Z', meta: { next: 'Say go on the node' } });
    await refresh(page, '2026-10-14T09:10:00.000Z');
    await openRoom(page, 'Learn Vibe Build');
    await openCompanion(page);
    await expect(page.locator('.cp-stale, [data-stale], [data-stale-why]')).toHaveCount(0);
    await expect(details(page)).not.toContainText('older than the latest work');
    await expect(details(page).locator('.cp-asof')).toHaveText(/^Last written Oct 14 by #\S+:$/);
    await expect(details(page).locator('.cp-stands').first()).toHaveText('Cohort two starts Oct 15; grading briefs are queued.');
    // an area's own summary, with an ask written on it after (T-302 round 2: was Uni's own, gone with #Uni)
    await add(page, { id: 'u2', title: 'T-682 Placeholder on Techne', node: 'Areas/Techne', asked_at: '2026-10-14T08:30:00.000Z', meta: { next: 'Say go on techne itself' } });
    await refresh(page, '2026-10-14T09:15:00.000Z');
    await openRoom(page, 'Techne');
    await openCompanion(page);
    await expect(details(page).locator('.cp-asof')).toHaveText(/^Last written (Oct \d+ )?by #Techne:$/);
    await expect(page.locator('.cp-stale, [data-stale], [data-stale-why]')).toHaveCount(0);
  });

  test('line 2: the rechecks are told to the rooms once per launch, as "recheck: T-NN …", in the app\'s log', async ({ page }) => {
    test.skip(!wide(page), 'work view');
    await boot(page);
    await add(page, { id: 'g1', title: 'T-691 Placeholder logged', node: 'Areas/Techne', asked_at: null, meta: { next: 'Say go on logged' } });
    await refresh(page);
    const logged = () => page.evaluate(() => (window as any).__calls.filter((c: any) => c.cmd === 'log_line').map((c: any) => c.args.line as string));
    await expect.poll(async () => (await logged())[0] ?? '').toMatch(/^recheck: (T-\d+ ?)+$|^recheck: none$/);
    await openRoom(page, 'Techne');
    await refresh(page, '2026-10-14T09:10:00.000Z');
    await openRoom(page, 'Techne').catch(() => {});
    expect((await logged()).length, 'once per launch, not once per list read').toBe(1);
    expect((await logged())[0]).toMatch(/^recheck: /);
  });
});

// T-335: the strip, its fold, its one panel and that panel's footer went with the old room view; at a small window the room's details
// (which hold what the panel did, unfitted) keep the rules: whole rows, the dated summary below Needs you, and a task sheet that closes back
// to the same scroll. ('r28 compact list', which fitted a list into the panel's height, went with the panel.)
test.describe('r28 compact', () => {
  for (const size of [{ width: 740, height: 360 }, { width: 800, height: 600 }, { width: 920, height: 360 }]) {
    test(`Codex P2-5 at ${size.width}×${size.height}: the details start with a whole request; the summary is a dated account below Needs you; a task opened from it returns to it at the same scroll`, async ({ page }) => {
      test.skip(page.viewportSize()?.width !== 1440 && page.viewportSize()?.width !== 1280, 'one project is enough for the fixed sizes');
      await page.setViewportSize(size);
      await boot(page);
      for (let i = 0; i < 5; i++) await add(page, { id: `cp${i}`, title: `T-70${i} Placeholder compact ${i}`, node: 'Areas/Techne', meta: { next: `Say go on the compact number ${i} and tell the whole crew once it has worked end to end` } });
      await refresh(page);
      await openRoom(page, 'Techne');
      await openCompanion(page);
      const scroller = focusSheet(page).locator('.all-focus-details');
      // the summary is a dated account below Needs you, never leading
      await expect(scroller.locator('.cp-stale, [data-stale-why]')).toHaveCount(0);
      const note = scroller.locator('.cp-stands-note');
      await expect(note.locator('.cp-asof')).toHaveText(/^Last written (Oct \d+ )?by #\S+:$/);
      expect(await page.evaluate(() => { const n = document.querySelector('.all-focus-details .cp-stands-note')!; const w = document.querySelector('.all-focus-details section[aria-label="Needs you"]')!; return !!(w.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING); }), 'after Needs you').toBe(true);
      const first = scroller.locator('section[aria-label="Needs you"] li.cp-item').first();
      await expect(first).toBeVisible();
      await rowsWhole(scroller.locator('li.cp-item'));
      // scroll, open a task, close it: the details are where they were
      const top = await scroller.evaluate((el) => { el.scrollTop = Math.min(60, el.scrollHeight - el.clientHeight); return el.scrollTop; });
      const second = scroller.locator('section[aria-label="Needs you"] li.cp-item').nth(1);
      await second.scrollIntoViewIfNeeded().catch(() => {});
      const topNow = await scroller.evaluate((el) => el.scrollTop);
      await second.locator('.cp-need').click();
      await expect(sheetOf(page)).toBeVisible();
      await sheetOf(page).getByRole('button', { name: 'Close' }).click();
      await expect(sheetOf(page)).toHaveCount(0);
      await expect(scroller).toBeVisible();
      expect(await scroller.evaluate((el) => el.scrollTop), `scroll ${top}→${topNow}`).toBe(topNow);
    });
  }
});

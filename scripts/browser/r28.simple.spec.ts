// T-124 r28: Needs you holds only confirmed asks (asked_at, resolved in the feed); everything else is one quiet recheck line; one count; every row whole;
// waiting runs are rows; summaries dim only for their own node; one compact panel.
// Run: SIMPLE_TEST_PORT=5711 npx playwright test --config playwright.simple.config.ts r28
import { test, expect, type Locator, type Page } from '@playwright/test';
import { bootAreas } from './areasFixture';

const wide = (page: Page) => (page.viewportSize()?.width ?? 0) >= 900;
const treeBeside = (page: Page) => wide(page) && (page.viewportSize()?.height ?? 0) >= 400;
const base = { briefs: true, tree: true, tasks: true, atlas: true, steer: true, pinned: true } as const;
const boot = (page: Page, extra: Parameters<typeof bootAreas>[2] = {}) => bootAreas(page, 'seed', { ...base, ...extra });
const scope = (page: Page) => (treeBeside(page) ? page.locator('.th-roomnav') : page.locator('.th-phone-tree'));
async function unfoldAll(page: Page) {
  await scope(page).locator('.th-row.d1').first().waitFor();
  for (let i = 0; i < 12; i++) { const f = scope(page).locator('.th-fold[aria-expanded="false"]'); if (!await f.count()) return; await f.first().click(); }
}
async function openRoom(page: Page, name: string) {
  if (!wide(page) && await page.locator('.cp-sheet').count()) { await page.keyboard.press('Escape'); await expect(page.locator('.cp-sheet')).toHaveCount(0); }
  if (!treeBeside(page)) { await page.locator('.sr-drawer, .th-phone-tree').first().waitFor(); if (await page.locator('.sr-drawer').count() && !await page.locator('.th-drawer').count()) await page.locator('.sr-drawer').click(); }
  await unfoldAll(page);
  await scope(page).locator(`.th-go[aria-label^="${name},"]`).click();
  await expect(page.locator('.sr')).toHaveAttribute('data-node', name);
}
async function openCompanion(page: Page) {
  const strip = !wide(page) || await page.locator('.cp.strip').count() > 0;
  if (strip && await page.locator('.cp-line[aria-expanded="false"]').count()) await page.locator('.cp-line').click();
  await expect(page.locator('.cp-body').first()).toBeVisible();
}
async function openWork(page: Page) { await openCompanion(page); await page.getByRole('button', { name: /^All of .*'s work/ }).first().click(); await expect(page.locator('.sr-work')).toBeVisible(); }
const sheetOf = (page: Page) => page.getByRole('dialog').filter({ has: page.locator('.task-kind') });
const NOW = '2026-10-14T09:00:00.000Z';
const refresh = async (page: Page, at: string = NOW) => { await page.clock.setFixedTime(Date.parse(at)); await page.evaluate(() => window.dispatchEvent(new Event('focus'))); };
const RECENT = '2026-10-13T12:00:00.000Z';
/** a task note written straight into the mock vault; `asked_at` is given (null: the record has none) */
const add = (page: Page, n: { id: string; title: string; node: string; tag?: string; asked_at?: string | null; updatedAt?: string; meta?: Record<string, unknown> }) => page.evaluate((x) => {
  (window as any).__tasks.push({ id: x.id, path: `Tasks/${x.title}`, extension: 'md', tags: [x.tag ?? 'task'], createdAt: '2026-10-06T16:00:00.000Z', updatedAt: x.updatedAt ?? '2026-10-13T12:00:00.000Z', lastUpdatedBy: 'u', lastUpdatedVia: 'mcp', content: x.title,
    metadata: { node: x.node, state: 'open', owner: 'aaron', priority: 'now', asked_at: x.asked_at === undefined ? '2026-10-13T12:00:00.000Z' : x.asked_at, ...(x.meta ?? {}) } });
}, n);
const section = (page: Page, label: string) => page.locator('.sr-work').getByRole('region', { name: label });
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
    await add(page, { id: 'c5', title: 'T-605 Placeholder epsilon', node: 'Areas/Techne', meta: { next: 'Say go on epsilon' } });                                 // related chat since
    await page.evaluate(() => (window as any).__arrive('ch-techne', 'Uni', 'T-605 epsilon is now ready, so the request has changed.', -426600));
    await refresh(page);
    await openRoom(page, 'Techne');
    await openWork(page);
    const needs = section(page, 'Needs you');
    await expect(needs.locator('.cp-list > li.cp-item').filter({ hasText: 'Say go on alpha' })).toHaveCount(1);
    for (const w of ['beta', 'gamma', 'delta', 'epsilon']) await expect(needs.locator('.cp-list > li.cp-item').filter({ hasText: `Say go on ${w}` })).toHaveCount(0);
    // the count is the rows of Needs you (and the runs waiting on the user), never the rechecks
    const rowCount = await needs.locator('.cp-list > li.cp-item, .cp-waiting > li').count();
    await expect(needs.locator('.wv-n')).toHaveText(String(rowCount));
    // the dot on Techne's row counts the same
    await expect(page.locator('.th-roomnav .th-go[aria-label^="Techne,"]')).toHaveAttribute('aria-label', new RegExp(`, ${rowCount} needs? you$`));
    // one quiet line, collapsed; it opens to a plain list
    const line = needs.locator('.cp-recheck-line');
    await expect(line).toHaveText(/^Uni is rechecking \d+ older asks?\+$/);
    await expect(needs.locator('.cp-recheck-list')).toHaveCount(0);
    const n = Number((await line.innerText()).match(/\d+/)![0]);
    expect(n).toBeGreaterThanOrEqual(4);
    await line.click();
    const items = needs.locator('.cp-recheck-item');
    await expect(items).toHaveCount(n);
    const beta = items.filter({ hasText: 'Say go on beta' });
    await expect(beta.locator('.cp-recheck-step')).toHaveText('Say go on beta');
    await expect(beta.locator('.cp-recheck-asked')).toHaveText(/^(asked|added) [A-Z][a-z]{2} \d+$/);
    await expect(beta.getByRole('button', { name: 'Open' })).toBeVisible();
    await expect(beta.getByRole('button', { name: 'Answer anyway' })).toBeVisible();
    // not counted, no dots: nothing in the list is a Needs-you row
    await expect(needs.locator('.wv-n')).toHaveText(String(rowCount));
    for (const t of await items.locator('.cp-recheck-step').allInnerTexts()) expect(t).not.toMatch(/[:;,—–-]$|…|\.\.\./);
    // Open: the sheet says it is not confirmed since; Answer anyway: the sheet with its answers ready, one tap
    await beta.getByRole('button', { name: 'Open' }).click();
    let sheet = sheetOf(page);
    await expect(sheet.locator('.task-asked')).toHaveAttribute('data-fresh', 'unconfirmed');
    await expect(sheet.locator('.task-asked')).toHaveText(/not confirmed since$/);
    await expect(sheet.getByRole('button', { name: 'I did this' })).toHaveCount(0);
    await sheet.getByRole('button', { name: 'Close' }).click();
    await items.filter({ hasText: 'Say go on gamma' }).getByRole('button', { name: 'Answer anyway' }).click();
    sheet = sheetOf(page);
    await expect(sheet.getByRole('button', { name: 'I did this' })).toBeVisible();
    await sheet.getByRole('button', { name: 'Close' }).click();
    // the confirmed ask's sheet has its answers ready and no "not confirmed" line
    await needs.locator('.cp-list > li.cp-item').filter({ hasText: 'Say go on alpha' }).locator('.cp-need').click();
    sheet = sheetOf(page);
    await expect(sheet.locator('.task-asked')).toHaveAttribute('data-fresh', 'current');
    await expect(sheet.getByRole('button', { name: 'I did this' })).toBeVisible();
    expect(await sheet.innerText()).not.toMatch(/not confirmed/);
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

  test('line 1: while a room\'s chat is being read its asks are held back ("Checking…"), then they are counted', async ({ page }) => {
    test.skip(!wide(page), 'work view');
    await boot(page);
    await add(page, { id: 'p1', title: 'T-621 Placeholder pending', node: 'Areas/Expression', meta: { next: 'Say go on pending' } });
    await page.evaluate(() => { (window as any).__lookupDelay = 1800; });
    await refresh(page);
    await openRoom(page, 'Expression');
    await openWork(page);
    const needs = section(page, 'Needs you');
    await expect(needs.locator('.cp-checking')).toHaveText(/^Checking 1 ask…$/);
    await expect(needs.locator('.wv-n')).toHaveText('0');
    await expect(needs.locator('.cp-list > li.cp-item').filter({ hasText: 'Say go on pending' })).toHaveCount(0);
    await expect(needs.locator('.cp-recheck-line')).toHaveCount(0);
    await expect(needs.locator('.cp-list > li.cp-item').filter({ hasText: 'Say go on pending' })).toHaveCount(1, { timeout: 8000 });
    await expect(needs.locator('.cp-checking')).toHaveCount(0);
    await expect(needs.locator('.wv-n')).toHaveText('1');
  });

  test('line 1: a chat that does not answer in a few seconds makes its asks rechecks, and the sheet says it could not read the room', async ({ page }) => {
    test.skip(!wide(page), 'work view');
    await boot(page);
    await add(page, { id: 'p2', title: 'T-622 Placeholder silent', node: 'Areas/Expression', meta: { next: 'Say go on silent' } });
    await page.evaluate(() => { (window as any).__lookupDelay = 30000; });
    await refresh(page);
    await openRoom(page, 'Expression');
    await openWork(page);
    const needs = section(page, 'Needs you');
    await expect(needs.locator('.cp-checking')).toHaveText(/^Checking 1 ask…$/);
    await expect(needs.locator('.cp-recheck-line')).toHaveText(/^Uni is rechecking 1 older ask\+$/, { timeout: 9000 });
    await expect(needs.locator('.cp-checking')).toHaveCount(0);
    await expect(needs.locator('.wv-n')).toHaveText('0');
    await needs.locator('.cp-recheck-line').click();
    await needs.locator('.cp-rc-open').click();
    const sheet = sheetOf(page);
    await expect(sheet.locator('.task-lookfail')).toHaveText(/^Couldn't read #expression · Retry$/i);
    await expect(sheet.getByRole('button', { name: 'I did this' })).toHaveCount(0);
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
    await expect(page.locator('.th-roomnav .th-go[aria-label^="Techne,"]')).toHaveAttribute('aria-label', new RegExp(`, ${rows} needs? you$`));
    // the panel says the same, under Needs you and not Running
    await page.getByRole('button', { name: /^Back to chat/ }).click();
    const side = page.locator('.cp.side .cp-body');
    await expect(side.locator('section[aria-label="Needs you"] .cp-run-step')).toHaveText('Ship the placeholder 0.1.46?');
    expect(await side.locator('section[aria-label="Running"]').count() ? await side.locator('section[aria-label="Running"]').innerText() : '').not.toContain('Ship the placeholder');
  });

  test('line 3: "Show N more" is exactly what is hidden: rows shown + waiting runs + N is the count', async ({ page }) => {
    test.skip(!wide(page), 'side panel');
    await page.setViewportSize({ width: 1280, height: 720 });
    await boot(page);
    for (let i = 0; i < 6; i++) await add(page, { id: `m${i}`, title: `T-64${i} Placeholder many ${i}`, node: i % 2 ? 'Areas/Techne' : 'Projects/ATLAS', meta: { next: `Say go on many number ${i} of the placeholder rows` } });
    await page.evaluate(() => (window as any).__addRun('rm1', 'Areas/Techne', '', 'Waiting on your answer in #Uni: Pick the placeholder color?', 'decision'));
    await refresh(page);
    await openRoom(page, 'Uni').catch(async () => { await page.locator('.th-go[aria-label^="Uni,"]').first().click(); });
    const side = page.locator('.cp.side .cp-body');
    await expect(side.locator('section[aria-label="Needs you"] .cp-item').first()).toBeVisible();
    await openWork(page);
    const total = Number(await section(page, 'Needs you').locator('.wv-n').innerText());
    await page.getByRole('button', { name: /^Back to chat/ }).click();
    const needs = page.locator('.cp.side .cp-body section[aria-label="Needs you"]');
    await expect(needs.locator('.cp-more')).toHaveCount(1);
    const shown = await needs.locator('.cp-list > li.cp-item').count() + await needs.locator('.cp-waiting > li').count();
    const more = Number((await needs.locator('.cp-more').innerText()).match(/Show (\d+) more/)![1]);
    expect(shown + more, `${shown} shown + Show ${more} more`).toBe(total);
    await rowsWhole(needs.locator('li.cp-item'));
  });

  test('line 3: a row is whole or it is not shown, in the side panel and the work view; inline sub-items are at most two, then "and N more"', async ({ page }) => {
    test.skip(!wide(page), 'side panel');
    await page.setViewportSize({ width: 1280, height: 720 });
    await boot(page);
    await add(page, { id: 'l1', title: 'T-651 Placeholder long', node: 'Areas/Techne', meta: { next: 'Reply to Harper with the placeholder answers, then paste the same key into the second place she named, and tell her once it works for the whole crew (paste the same key)' } });
    await add(page, { id: 'l2', title: 'T-652 Placeholder list', node: 'Areas/Techne', meta: { next: 'Forward Harper the asks listed in this task\'s detail', detail: 'Harper still owes: (1) OK or cut 6 groups of short functional lines; (2) the Spanish versions of two page names; (3) one morning-practice line per day; (4) yes or no on the heading.' } });
    await refresh(page);
    await openRoom(page, 'Techne');
    const side = page.locator('.cp.side .cp-body');
    await rowsWhole(side.locator('section[aria-label="Needs you"] li.cp-item'));
    const row = side.locator('li.cp-item').filter({ hasText: 'Forward Harper the asks' });
    if (await row.count()) {
      const shown = await row.locator('.cp-item-line').count();
      expect(shown).toBeLessThanOrEqual(2);
      const more = await row.locator('.cp-item-more').count() ? Number((await row.locator('.cp-item-more').innerText()).match(/and (\d+) more/)![1]) : 0;
      expect(shown + more).toBe(4);
    }
    await openWork(page);
    await rowsWhole(section(page, 'Needs you').locator('li.cp-item'));
    await expect(section(page, 'Needs you').locator('li.cp-item').filter({ hasText: 'paste the same key' })).toContainText('tell her once it works for the whole crew');
  });

  test('line 4: a summary dims only for a task directly on its node: an ask written after it, a task closed on or after its day; Uni\'s root summary is not dimmed by a change anywhere below', async ({ page }) => {
    test.skip(!wide(page), 'side panel');
    await boot(page);
    await page.evaluate(() => (window as any).__setStands('p-lvb', 'Cohort two starts Oct 15; grading briefs are queued.', '2026-10-14T06:00:00.000Z'));
    await refresh(page);
    await openRoom(page, 'Learn Vibe Build');
    await openCompanion(page);
    // case 0: nothing on the node after the summary: as written
    await expect(page.locator('.cp-stale')).toHaveCount(0);
    await expect(page.locator('.cp-stands').first()).toHaveText(/^As of Oct 14: Cohort two starts Oct 15/);
    // a change on a node elsewhere (a sibling) does not touch it
    await add(page, { id: 'sm1', title: 'T-661 Placeholder elsewhere', node: 'Projects/ATLAS', asked_at: '2026-10-14T08:00:00.000Z', meta: { next: 'Say go on elsewhere' } });
    await refresh(page, '2026-10-14T09:05:00.000Z');
    await expect(page.locator('.cp-stale')).toHaveCount(0);
    // case 1: an ask written on the node after the summary
    await add(page, { id: 'sm2', title: 'T-662 Placeholder on the node', node: 'Projects/Learn Vibe Build', asked_at: '2026-10-14T08:00:00.000Z', meta: { next: 'Say go on the node' } });
    await refresh(page, '2026-10-14T09:10:00.000Z');
    await expect(page.locator('.cp-stale')).toHaveText('This summary is older than the latest work · from Oct 14');
  });

  test('line 4: a task closed on the node on or after the summary\'s day dims it, one closed the day before does not', async ({ page }) => {
    test.skip(!wide(page), 'side panel');
    await boot(page);
    await page.evaluate(() => (window as any).__setStands('p-lvb', 'Cohort two starts Oct 15; grading briefs are queued.', '2026-10-14T06:00:00.000Z'));
    await add(page, { id: 'cl1', title: 'T-671 Placeholder closed early', node: 'Projects/Learn Vibe Build', asked_at: null, meta: { state: 'done', closed: '2026-10-13' } });
    await refresh(page);
    await openRoom(page, 'Learn Vibe Build');
    await openCompanion(page);
    await expect(page.locator('.cp-stale')).toHaveCount(0);
    await add(page, { id: 'cl2', title: 'T-672 Placeholder closed that day', node: 'Projects/Learn Vibe Build', asked_at: null, meta: { state: 'archived', closed: '2026-10-14' } });
    await refresh(page, '2026-10-14T09:06:00.000Z'); // (the closed tasks are read at most every five minutes)
    await expect(page.locator('.cp-stale')).toHaveText('This summary is older than the latest work · from Oct 14');
  });

  test('line 4: Uni\'s root summary is not dimmed by a change in an area below it, but is by an ask written on Uni itself', async ({ page }) => {
    test.skip(!wide(page), 'side panel');
    await boot(page);
    await add(page, { id: 'u1', title: 'T-681 Placeholder in an area', node: 'Areas/Techne', asked_at: '2026-10-14T08:00:00.000Z', meta: { next: 'Say go on in an area' } });
    await refresh(page);
    await openRoom(page, 'Uni').catch(async () => { await page.locator('.th-go[aria-label^="Uni,"]').first().click(); });
    await expect(page.locator('.cp.side .cp-stands').first()).toBeVisible();
    await expect(page.locator('.cp-stale')).toHaveCount(0);
    await add(page, { id: 'u2', title: 'T-682 Placeholder on Uni', node: 'Uni', asked_at: '2026-10-14T08:30:00.000Z', meta: { next: 'Say go on uni itself' } });
    await refresh(page, '2026-10-14T09:05:00.000Z');
    await expect(page.locator('.cp-stale')).toHaveText(/^This summary is older than the latest work · from Oct \d+$/);
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
    await openRoom(page, 'Uni').catch(() => {});
    expect((await logged()).length, 'once per launch, not once per list read').toBe(1);
    expect((await logged())[0]).toMatch(/^recheck: /);
  });
});

test.describe('r28 compact', () => {
  for (const size of [{ width: 740, height: 360 }, { width: 800, height: 600 }, { width: 920, height: 360 }]) {
    test(`Codex P2-5 at ${size.width}×${size.height}: the strip opens one panel; it starts with a whole request; the summary is its date line; nothing is under the footer; a task opened from it returns to it at the same scroll`, async ({ page }) => {
      test.skip(page.viewportSize()?.width !== 1440 && page.viewportSize()?.width !== 1280, 'one project is enough for the fixed sizes');
      await page.setViewportSize(size);
      await boot(page);
      for (let i = 0; i < 5; i++) await add(page, { id: `cp${i}`, title: `T-70${i} Placeholder compact ${i}`, node: 'Areas/Techne', meta: { next: `Say go on the compact number ${i} and tell the whole crew once it has worked end to end` } });
      await refresh(page);
      await openRoom(page, 'Techne');
      const line = page.locator('.cp-line');
      await expect(line).toBeVisible();
      // folded: "Needs you · N" is whole, or whole with the first request; never cut
      const folded = (await page.locator('.cp-line-text').innerText()).trim();
      expect(folded).toMatch(/^Needs you · \d+/);
      expect(folded).not.toMatch(/…|\.\.\./);
      await line.click();
      await expect(page.locator('.cp-sheet')).toHaveCount(1);
      await expect(page.locator('.cp-strip-body')).toHaveCount(0);
      const scroller = page.locator('.cp-sheet .cp-scroll');
      const foot = page.locator('.cp-sheet > .cp-foot');
      await expect(foot).toBeVisible();
      // the footer is outside what scrolls: the scrolling region ends where the footer begins
      const geo = await page.evaluate(() => { const s = document.querySelector('.cp-sheet .cp-scroll')!.getBoundingClientRect(); const f = document.querySelector('.cp-sheet > .cp-foot')!.getBoundingClientRect(); return { sBottom: s.bottom, fTop: f.top, within: s.bottom <= f.top + 0.5 }; });
      expect(geo.within, JSON.stringify(geo)).toBe(true);
      // the summary is folded to its date line
      const fold = page.locator('.cp-sheet .cp-stands-fold, .cp-sheet .cp-stale');
      await expect(fold.first()).toBeVisible();
      if (await page.locator('.cp-sheet .cp-stands-fold').count()) expect(await page.locator('.cp-sheet .cp-stands-fold').evaluate((d) => (d as HTMLDetailsElement).open)).toBe(false);
      // the first request is whole and fully in view at scroll 0
      const first = scroller.locator('section[aria-label="Needs you"] li.cp-item').first();
      await expect(first).toBeVisible();
      const inView = await first.evaluate((el) => { const r = el.getBoundingClientRect(); const s = (el.closest('.cp-scroll') as HTMLElement).getBoundingClientRect(); return r.top >= s.top - 0.5 && r.bottom <= s.bottom + 0.5; });
      expect(inView, 'the first request is complete in view').toBe(true);
      await rowsWhole(scroller.locator('li.cp-item'));
      // scroll, open a task, close it: the panel is where it was
      const top = await scroller.evaluate((el) => { el.scrollTop = Math.min(60, el.scrollHeight - el.clientHeight); return el.scrollTop; });
      const second = scroller.locator('section[aria-label="Needs you"] li.cp-item').nth(1);
      await second.scrollIntoViewIfNeeded().catch(() => {});
      const topNow = await scroller.evaluate((el) => el.scrollTop);
      await second.locator('.cp-need').click();
      await expect(sheetOf(page)).toBeVisible();
      await expect(page.locator('.cp-sheet')).toHaveCount(1);
      await sheetOf(page).getByRole('button', { name: 'Close' }).click();
      await expect(sheetOf(page)).toHaveCount(0);
      await expect(page.locator('.cp-sheet')).toBeVisible();
      expect(await scroller.evaluate((el) => el.scrollTop), `scroll ${top}→${topNow}`).toBe(topNow);
    });
  }
});

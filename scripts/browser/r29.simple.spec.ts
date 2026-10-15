// T-124 r29: say only what the app knows. Only Uni's own message naming the ask is its announcement; "N older asks need confirming" claims no work, and
// an empty Needs you says "No confirmed asks" while any wait to be confirmed; a summary is a dated account below Needs you.
// Run: SIMPLE_TEST_PORT=5711 npx playwright test --config playwright.simple.config.ts r29
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


const ASKED = '2026-10-14T08:00:00.000Z';
/** a message `secs` after ASKED (the fixture's clock is Oct 9 10:00Z, so `ago` is negative for later times) */
const arriveAt = (page: Page, who: string, body: string, secs: number) => page.evaluate(([w, b, s]) => (window as any).__arrive('ch-techne', w, b, -(424800 + (s as number))), [who, body, secs] as const);

test.describe('r29', () => {
  test('P1-1: Uni\'s announcement naming the ask is skipped; Aaron\'s correction, and Uni\'s message that doesn\'t name it, unconfirm', async ({ page }) => {
    test.skip(!wide(page), 'work view');
    await boot(page);
    await add(page, { id: 'a1', title: 'T-801 Placeholder announced only', node: 'Areas/Techne', asked_at: ASKED, meta: { next: 'Say go on the amber ledger' } });
    await add(page, { id: 'a2', title: 'T-802 Placeholder corrected by Aaron', node: 'Areas/Techne', asked_at: ASKED, meta: { next: 'Say go on the cobalt ledger' } });
    await add(page, { id: 'a3', title: 'T-803 Placeholder talked past', node: 'Areas/Techne', asked_at: ASKED, meta: { next: 'Say go on the quartz sponsorship invoice' } });
    await arriveAt(page, 'Uni', "I've re-stated each ask: T-801 say go on the amber ledger; T-802 say go on the cobalt ledger", 9);
    await arriveAt(page, 'Aaron', 'T-802 is off', 120);
    await arriveAt(page, 'Uni', 'The quartz sponsorship invoice was paid, so that is settled', 60);
    await refresh(page);
    await openRoom(page, 'Techne');
    await openWork(page);
    const needs = section(page, 'Needs you');
    const rows = needs.locator('.cp-list > li.cp-item');
    await expect(rows.filter({ hasText: 'amber ledger' })).toHaveCount(1);       // Uni's own announcement naming T-801: skipped
    await expect(rows.filter({ hasText: 'cobalt ledger' })).toHaveCount(0);      // Aaron's "T-802 is off" two minutes later
    await expect(rows.filter({ hasText: 'quartz sponsorship' })).toHaveCount(0); // Uni, in the window, not naming T-803
    await needs.locator('.cp-recheck-line').click();
    const items = needs.locator('.cp-recheck-item');
    await expect(items.filter({ hasText: 'cobalt ledger' })).toHaveCount(1);
    await expect(items.filter({ hasText: 'quartz sponsorship' })).toHaveCount(1);
    await expect(items.filter({ hasText: 'amber ledger' })).toHaveCount(0);
  });

  test('P1-1: another key\'s message in the window counts too', async ({ page }) => {
    test.skip(!wide(page), 'work view');
    await boot(page);
    await add(page, { id: 'a1', title: 'T-811 Placeholder other key', node: 'Areas/Techne', asked_at: ASKED, meta: { next: 'Say go on the jade ledger' } });
    await arriveAt(page, 'Ricki', 'T-811 is not needed any more', 30);
    await refresh(page);
    await openRoom(page, 'Techne');
    await openWork(page);
    await expect(section(page, 'Needs you').locator('.cp-list > li.cp-item').filter({ hasText: 'jade ledger' })).toHaveCount(0);
    await expect(section(page, 'Needs you').locator('.cp-recheck-line')).toBeVisible();
  });

  test('P1-2: the quiet line claims no work; the empty Needs you says "No confirmed asks" while any wait to be confirmed, in the panel and in all of the work', async ({ page }) => {
    test.skip(!wide(page), 'side panel');
    await boot(page);
    await add(page, { id: 'q1', title: 'T-821 Placeholder unconfirmed one', node: 'Projects/Atlas Institute', asked_at: null, meta: { next: 'Say go on the first unconfirmed' } });
    await add(page, { id: 'q2', title: 'T-822 Placeholder unconfirmed two', node: 'Projects/Atlas Institute', asked_at: null, meta: { next: 'Say go on the second unconfirmed' } });
    await refresh(page);
    await openRoom(page, 'Atlas Institute');
    await openCompanion(page);
    const panel = page.locator('.cp-body').getByRole('region', { name: 'Needs you' });
    await expect(panel.locator('.cp-none')).toHaveText('No confirmed asks');
    await expect(panel.locator('.cp-recheck-line')).toHaveText(/^2 older asks need confirming\+$/);
    await expect(panel.locator('.cp-list > li.cp-item')).toHaveCount(0);
    await expect(page.locator('.cp-body')).not.toContainText(/rechecking|Nothing needs you here/);
    await panel.locator('.cp-recheck-line').click();
    await expect(panel.locator('.cp-recheck-list')).toHaveAttribute('aria-label', 'Older asks that need confirming');
    await openWork(page);
    const needs = section(page, 'Needs you');
    await expect(needs.locator('.cp-none')).toHaveText('No confirmed asks');
    await expect(needs.locator('.wv-n')).toHaveText('0');
    await expect(needs.locator('.cp-recheck-line')).toHaveText(/^2 older asks need confirming\+$/);
    await expect(page.locator('.sr-work')).not.toContainText(/rechecking|Nothing needs you here/);
  });

  test('P1-2: with none of either, it is still "Nothing needs you here."', async ({ page }) => {
    test.skip(!wide(page), 'side panel');
    await boot(page);
    await openRoom(page, 'Unforced Development');
    await openCompanion(page);
    await expect(page.locator('.cp-body .cp-none')).toHaveText('Nothing needs you here.');
    await expect(page.locator('.cp-body .cp-recheck-line')).toHaveCount(0);
    await openWork(page);
    await expect(section(page, 'Needs you').locator('.cp-none')).toHaveText('Nothing needs you here.');
  });

  test('P1-2: with a confirmed ask the empty line is gone and the quiet line still counts only what needs confirming', async ({ page }) => {
    test.skip(!wide(page), 'side panel');
    await boot(page);
    await add(page, { id: 'q1', title: 'T-831 Placeholder confirmed', node: 'Projects/Atlas Institute', asked_at: '2026-10-14T08:30:00.000Z', meta: { next: 'Say go on the confirmed one' } });
    await add(page, { id: 'q2', title: 'T-832 Placeholder unconfirmed', node: 'Projects/Atlas Institute', asked_at: null, meta: { next: 'Say go on the unconfirmed one' } });
    await refresh(page);
    await openRoom(page, 'Atlas Institute');
    await openCompanion(page);
    const panel = page.locator('.cp-body').getByRole('region', { name: 'Needs you' });
    await expect(panel.locator('.cp-none')).toHaveCount(0);
    await expect(panel.locator('.cp-list > li.cp-item').filter({ hasText: 'confirmed one' })).toHaveCount(1);
    await expect(panel.locator('.cp-recheck-line')).toHaveText(/^1 older ask needs confirming\+$/);
  });

  test('P1-3: the summary is below Needs you, labelled with its date and room, muted, and carries no stale notice', async ({ page }) => {
    test.skip(!wide(page), 'side panel');
    await boot(page);
    await add(page, { id: 's1', title: 'T-841 Placeholder after the summary', node: 'Projects/Learn Vibe Build', asked_at: '2026-10-14T08:00:00.000Z', meta: { next: 'Say go on after the summary' } });
    await page.evaluate(() => (window as any).__setStands('p-lvb', "Cohort two starts Oct 15; prod waits on Aaron's go for #38.", '2026-10-14T06:00:00.000Z'));
    await refresh(page);
    await openRoom(page, 'Learn Vibe Build');
    await openCompanion(page);
    const note = page.locator('.cp-body .cp-stands-note');
    await expect(note.locator('.cp-asof')).toHaveText('Last written Oct 14 by #atlas/teach:');
    await expect(note.locator('.cp-stands')).toHaveText("Cohort two starts Oct 15; prod waits on Aaron's go for #38.");
    await expect(page.locator('.cp-stale, [data-stale], [data-stale-why], .cp-body :text("older than the latest work")')).toHaveCount(0);
    const order = await page.evaluate(() => { const n = document.querySelector('.cp-body .cp-stands-note')!; const w = document.querySelector('.cp-body section[aria-label="Needs you"]')!; const first = document.querySelector('.cp-body')!.firstElementChild!; return { after: !!(w.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING), leading: first === n, color: getComputedStyle(n.querySelector('.cp-stands')!).color }; });
    expect(order.after).toBe(true);
    expect(order.leading).toBe(false);
    const ink = await page.locator('.cp-body .cp-title').first().evaluate((el) => getComputedStyle(el).color);
    expect(order.color, 'muted, not the ink of a request').not.toBe(ink);
  });
});

test.describe('r29 compact', () => {
  for (const size of [{ width: 800, height: 600 }, { width: 740, height: 360 }]) {
    test(`P1-2/P1-3 at ${size.width}×${size.height}: the compact panel says "No confirmed asks" with asks to confirm, and its summary is below Needs you`, async ({ page }) => {
      test.skip(page.viewportSize()?.width !== 1440, 'one project is enough for the fixed sizes');
      await page.setViewportSize(size);
      await boot(page);
      await add(page, { id: 'q1', title: 'T-851 Placeholder unconfirmed', node: 'Projects/Atlas Institute', asked_at: null, meta: { next: 'Say go on the unconfirmed one' } });
      await page.evaluate(() => (window as any).__setStands('p-ai', 'The institute site is staged.', '2026-10-14T06:00:00.000Z'));
      await refresh(page);
      await openRoom(page, 'Atlas Institute');
      await page.locator('.cp-line').click();
      const sheet = page.locator('.cp-sheet');
      await expect(sheet.locator('.cp-none')).toHaveText('No confirmed asks');
      await expect(sheet.locator('.cp-recheck-line')).toHaveText(/^1 older ask needs confirming\+$/);
      await expect(sheet.locator('.cp-asof')).toHaveText(/^Last written Oct 14 by #\S+:$/);
      await expect(sheet.locator('.cp-stale, [data-stale-why]')).toHaveCount(0);
      expect(await page.evaluate(() => { const n = document.querySelector('.cp-sheet .cp-stands-note')!; const w = document.querySelector('.cp-sheet section[aria-label="Needs you"]')!; return !!(w.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING); })).toBe(true);
    });
  }
});

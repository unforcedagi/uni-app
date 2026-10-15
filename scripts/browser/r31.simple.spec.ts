// T-145 r31: an ask is current because its record says so; one summary line; one date and one count on a row; a waiting run's room is its channel id.
// Run: SIMPLE_TEST_PORT=5711 npx playwright test --config playwright.simple.config.ts r31
import { test, expect, type Locator, type Page } from '@playwright/test';
import { bootAreas } from './areasFixture';
import { readFileSync } from 'node:fs';

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
const NEXT113 = 'Send Harper the new site labels listed in detail to approve or replace, and ask her for one morning-practice line per day Oct 15-25; then sign in once on grove.example.org and open Board, People and Me';
const LABELS = Array.from({ length: 10 }, (_, i) => `'Label number ${i + 1} ${['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet'][i]}'`).join(' · ');
const DETAIL113 = `Labels to approve (en; es written): ${LABELS}\n\nAlso her call: nothing else.`;
const composerFocused = (page: Page) => page.evaluate(() => document.activeElement?.tagName === 'TEXTAREA' && !!document.activeElement.closest('.composer'));

test.describe('r31 the record decides', () => {
  test('1: chat cannot cancel or revive an ask; confirmed_at renews an old one; superseded_by and state close one', async ({ page }) => {
    test.skip(!wide(page), 'work view');
    await boot(page);
    await add(page, { id: 'a1', title: 'T-801 Placeholder quoted', node: 'Areas/Techne', asked_at: ASKED, meta: { next: 'Say go on the amber ledger and then tell Uni it is done' } });
    await add(page, { id: 'a2', title: 'T-802 Placeholder old', node: 'Areas/Techne', asked_at: '2026-10-08T08:00:00.000Z', meta: { next: 'Say go on the cobalt ledger' } });
    await add(page, { id: 'a3', title: 'T-803 Placeholder renewed', node: 'Areas/Techne', asked_at: '2026-10-08T08:00:00.000Z', meta: { next: 'Say go on the jade ledger', confirmed_at: ASKED } });
    await add(page, { id: 'a4', title: 'T-804 Placeholder superseded', node: 'Areas/Techne', asked_at: ASKED, meta: { next: 'Say go on the onyx ledger', superseded_by: 'T-805' } });
    await add(page, { id: 'a5', title: 'T-805 Placeholder done', node: 'Areas/Techne', asked_at: ASKED, meta: { next: 'Say go on the opal ledger', state: 'done' } });
    // a cancellation quoting the whole ask, and a message about the old one: neither changes anything
    await page.evaluate(() => { const w = window as any; w.__arrive('ch-techne', 'Uni', 'Cancel T-801: Say go on the amber ledger and then tell Uni it is done', -424800); w.__arrive('ch-techne', 'Aaron', 'the cobalt ledger is ready, go ahead with the cobalt ledger', -424900); });
    await refresh(page);
    await openRoom(page, 'Techne');
    await openWork(page);
    const needs = section(page, 'Needs you');
    const rows = needs.locator('.cp-list > li.cp-item');
    await expect(rows.filter({ hasText: 'amber ledger' })).toHaveCount(1);
    await expect(rows.filter({ hasText: 'jade ledger' })).toHaveCount(1);
    for (const w of ['cobalt ledger', 'onyx ledger', 'opal ledger']) await expect(rows.filter({ hasText: w })).toHaveCount(0);
    await needs.locator('.cp-recheck-line').click();
    const items = needs.locator('.cp-recheck-item');
    await expect(items.filter({ hasText: 'cobalt ledger' }).locator('.cp-recheck-asked')).toHaveText(/^asked Oct 8( · in .*)?$/);
    await expect(items.filter({ hasText: 'onyx ledger' })).toHaveCount(0);
    await expect(items.filter({ hasText: 'opal ledger' })).toHaveCount(0);
    // no reason in the list names chat or a room read
    expect(await needs.locator('.cp-recheck-list').innerText()).not.toMatch(/chat since|couldn't read/i);
  });
});

test.describe('r31 one summary line', () => {
  const LONG = 'Cohort two starts Oct 15 with twelve people; the staging site is live, the sign-in flow was checked on a phone, and prod waits on one go from Aaron for the labels and the three practice lines Harper still owes us, which is a long account that is more than two hundred and eighty characters in all so that it is behind its one line rather than shown whole in the panel.';
  test('2: a long summary is one line, "Where this stands · Oct 14, #room"; older than two days it says how old', async ({ page }) => {
    test.skip(!wide(page), 'side panel');
    await boot(page);
    await page.evaluate((t) => (window as any).__setStands('p-lvb', t, '2026-10-14T06:00:00.000Z'), LONG);
    await refresh(page, '2026-10-14T09:00:00.000Z');
    await openRoom(page, 'Learn Vibe Build');
    await openCompanion(page);
    const note = page.locator('.cp-body .cp-stands-note');
    await expect(note.locator('.cp-asof')).toHaveCount(0);
    await expect(note.locator('.cp-said summary')).toHaveText(/^Where this stands · Oct 14, #\S+$/);
    expect(await note.locator('.cp-said summary').innerText()).not.toMatch(/:\s*$/);
    await page.evaluate((t) => (window as any).__setStands('p-lvb', t, '2026-10-11T06:00:00.000Z'), LONG);
    await refresh(page, '2026-10-14T09:01:00.000Z');
    await expect(note.locator('.cp-said summary')).toHaveText('Where this stands · Oct 11 (3 days old)');
    await note.locator('.cp-said summary').click();
    await expect(note.locator('.cp-stands')).toHaveText(LONG);
  });
});

test.describe('r31 one date and one count', () => {
  test('2: an overdue row says only "was due Oct 13", on the row and the sheet; one that is not keeps its asked date', async ({ page }) => {
    test.skip(!wide(page), 'side panel');
    await boot(page);
    await add(page, { id: 'd1', title: 'T-113 Look at grove.example.org on your phone, then forward Harper the asks', node: 'Areas/Techne', asked_at: ASKED, meta: { due: '2026-10-13', next: NEXT113, state: 'waiting', waiting_on: 'aaron' } });
    await add(page, { id: 'd2', title: 'T-114 Placeholder not due', node: 'Areas/Techne', asked_at: ASKED, meta: { due: '2026-10-20', next: 'Say go on the placeholder number two' } });
    await refresh(page);
    await openRoom(page, 'Techne');
    await openCompanion(page);
    const row = page.locator('.cp-body li.cp-item').filter({ hasText: 'morning-practice' });
    await expect(row.locator('.cp-sub-when, .cp-asked-line').first()).toHaveText(/^(?:· )?was due Oct 13$/);
    expect(await row.innerText()).not.toMatch(/asked/i);
    await row.locator('.cp-need').click();
    await expect(sheetOf(page).locator('.task-asked')).toHaveText('Was due Oct 13');
    await sheetOf(page).getByRole('button', { name: 'Close' }).click();
    await expect(page.locator('.cp-body li.cp-item').filter({ hasText: 'placeholder number two' }).locator('.cp-asked-line, .cp-sub-when').first()).toContainText('asked');
  });

  test('2: the same list says the same count in Uni\'s panel and COhere\'s, at every width; "Show N more" is the count minus the rows shown', async ({ page }) => {
    test.skip(!wide(page), 'side panel');
    await page.setViewportSize({ width: 1280, height: 720 });
    await boot(page);
    await add(page, { id: 'c1', title: 'T-113 Look at grove.example.org on your phone, then forward Harper the asks', node: 'Areas/Techne', asked_at: ASKED, meta: { next: NEXT113, detail: DETAIL113, state: 'waiting', waiting_on: 'aaron', due: '2026-10-13' } });
    for (let i = 0; i < 4; i++) await add(page, { id: `m${i}`, title: `T-12${i} Placeholder many ${i}`, node: i % 2 ? 'Areas/Techne' : 'Projects/ATLAS', asked_at: ASKED, meta: { next: `Say go on many number ${i} of the placeholder rows` } });
    await refresh(page);
    await openRoom(page, 'Techne');
    await openCompanion(page);
    const total = async (scope: Locator) => scope.locator('li.cp-item').filter({ hasText: 'morning-practice' }).locator('.cp-item-more').first().innerText();
    const inTechne = await total(page.locator('.cp-body'));
    expect(inTechne).toMatch(/^10 \w+ in all$/);
    await page.setViewportSize({ width: 1280, height: 520 });
    await refresh(page);
    await expect.poll(async () => { const t = page.locator('.cp-body li.cp-item').filter({ hasText: 'morning-practice' }); return (await t.count()) ? await t.locator('.cp-item-more').first().innerText().catch(() => '') : 'none'; }).toMatch(/^(10 \w+ in all|none)$/);
    await page.locator('.th-go[aria-label^="Uni,"]').first().click();
    await expect(page.locator('.sr')).toHaveAttribute('data-node', 'Uni');
    const side = page.locator('.cp.side .cp-body section[aria-label="Needs you"]');
    await expect(side.locator('.cp-more')).toHaveCount(1);
    const shown = await side.locator('.cp-list > li.cp-item').count() + await side.locator('.cp-waiting > li').count();
    const more = Number((await side.locator('.cp-more').innerText()).match(/Show (\d+) more/)![1]);
    await openWork(page);
    const all = Number(await section(page, 'Needs you').locator('.wv-n').innerText());
    expect(shown + more, `${shown} shown + Show ${more} more`).toBe(all);
    const uniRow = section(page, 'Needs you').locator('li.cp-item').filter({ hasText: 'morning-practice' });
    await expect(uniRow.locator('.cp-item-more')).toHaveText(inTechne);
  });
});

test.describe('r31 a waiting run opens its room by channel id', () => {
  test('3: channel and message_ref are read exactly; a channel that does not resolve says "Room not found" and opens nothing', async ({ page }) => {
    test.skip(!wide(page), 'work view');
    await boot(page);
    const ref = await page.evaluate(() => (window as any).__arrive('ch-techne', 'Uni', 'Placeholder release question for 0.1.47', -424000));
    await page.evaluate((r) => {
      const w = window as any;
      w.__addRun('wc1', 'Areas/Techne', '', 'Waiting on your answer in #Techne: Ship the placeholder 0.1.47?', 'decision', { room: 'wrong-name', channel: 'ch-techne', message_ref: r });
      w.__addRun('wc2', 'Areas/Techne', '', 'Waiting on your answer in #Gone: Say go on the vanished one?', 'decision', { room: 'techne', channel: 'ch-does-not-exist' });
    }, ref);
    await refresh(page);
    await page.locator('.th-go[aria-label^="Uni,"]').first().click();
    await openWork(page);
    const runs = section(page, 'Needs you').locator('.cp-waiting > li');
    await expect(runs).toHaveCount(2);
    const gone = runs.filter({ hasText: 'vanished one' });
    await expect(gone.locator('small').last()).toHaveText('Room not found');
    await gone.getByRole('button').click();
    await expect(page.locator('.sr')).toHaveAttribute('data-node', 'Uni');
    await expect(page.locator('.sr-work')).toBeVisible();
    // the one with a good channel id opens that room at its message, whatever its room name says
    const ok = runs.filter({ hasText: 'placeholder 0.1.47' });
    await expect(ok.locator('small').last()).not.toHaveText('Room not found');
    await ok.getByRole('button').click();
    await expect(page.locator('.sr')).toHaveAttribute('data-node', 'Techne');
    await expect(page.locator(`.message.search-focus[data-ref="${ref}"]`)).toBeVisible();
    await expect.poll(() => composerFocused(page)).toBe(true);
  });
});

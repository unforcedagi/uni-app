// T-145: every ask in Needs you is current at the revision Aaron answers. Its stamp vouches for the words it was written with (`ask_sig`); an ask
// that changes under an open sheet says so and takes no stale answer; one closed elsewhere drops out; an answer records the revision it answered.
// Run: SIMPLE_TEST_PORT=5711 npx playwright test --config playwright.simple.config.ts t145
import { test, expect, type Page } from '@playwright/test';
import { bootAreas } from './areasFixture';
import { askSig } from '../../src/areas/taskCore';

const wide = (page: Page) => (page.viewportSize()?.width ?? 0) >= 900;
const treeBeside = (page: Page) => wide(page) && (page.viewportSize()?.height ?? 0) >= 400;
const base = { briefs: true, tree: true, tasks: true, atlas: true, steer: true, pinned: true } as const;
const boot = (page: Page) => bootAreas(page, 'seed', base);
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
/** The room's Needs you, in the side panel (wide) or the panel the phone's strip opens. */
async function needsYou(page: Page) {
  const strip = !wide(page) || await page.locator('.cp.strip').count() > 0;
  if (strip && !await page.locator('.cp-sheet').count()) await page.locator('.cp-line').click();
  const region = (strip ? page.locator('.cp-sheet .cp-body') : page.locator('.cp.side .cp-body')).getByRole('region', { name: 'Needs you' });
  await expect(region).toBeVisible();
  return region;
}
async function closePanel(page: Page) { if (await page.locator('.cp-sheet').count()) { await page.keyboard.press('Escape'); await expect(page.locator('.cp-sheet')).toHaveCount(0); } }
/** how many requests need confirming in this room (0 when the line is not there) */
const rechecks = async (needs: ReturnType<Page['locator']>) => { const r = needs.locator('.cp-recheck'); return (await r.count()) ? Number(await r.getAttribute('data-count')) : 0; };
const sheetOf = (page: Page) => page.getByRole('dialog').filter({ has: page.locator('.task-kind') });
const calls = (page: Page, cmd: string) => page.evaluate((c) => (window as any).__calls.filter((x: any) => x.cmd === c).map((x: any) => x.args), cmd);
const stampOf = (page: Page, id: string) => page.evaluate((i) => (window as any).__tasks.find((t: any) => t.id === i).updatedAt, id);
const stateOf = (page: Page, id: string) => page.evaluate((i) => (window as any).__tasks.find((t: any) => t.id === i).metadata.state, id);
const refresh = async (page: Page, at: string) => { await page.clock.setFixedTime(Date.parse(at)); await page.evaluate(() => window.dispatchEvent(new Event('focus'))); };
const ASKED = '2026-10-14T08:00:00.000Z';
/** a task note written straight into the mock vault the way tasks.py writes an ask: `asked_at` and `ask_sig` in the same update */
const add = (page: Page, n: { id: string; title: string; next: string; detail?: string; tag?: string; meta?: Record<string, unknown> }) => page.evaluate((x) => {
  (window as any).__tasks.push({ id: x.id, path: `Tasks/${x.title}`, extension: 'md', tags: [x.tag ?? 'task'], createdAt: '2026-10-06T16:00:00.000Z', updatedAt: '2026-10-14T08:00:00.000Z', lastUpdatedBy: 'u', lastUpdatedVia: 'api', content: x.title,
    metadata: { node: 'Areas/Techne', state: 'open', owner: 'aaron', priority: 'now', next: x.next, ...(x.detail ? { detail: x.detail } : {}), asked_at: x.asked, ask_sig: x.sig, ...(x.meta ?? {}) } });
}, { ...n, asked: ASKED, sig: askSig(n.next, n.detail ?? null) });

const NEXT1 = 'Say go on the amber ledger for the placeholder books';
const NEXT2 = 'Say go on the cobalt ledger for the placeholder books instead';
const DETAIL = 'The ledger lines: rent · tools · travel';

function suite(label: string, only: (page: Page) => string | null) {
  test.describe(`t145 ${label}`, () => {
    test.describe.configure({ timeout: 120_000 });
    test('1: an ask whose words were changed by another write is no longer current: it needs confirming, says why, and comes back when its room asks again', async ({ page }) => {
      const skip = only(page); test.skip(!!skip, skip ?? '');
      await boot(page);
      await add(page, { id: 't145k1', title: 'T-901 Placeholder amber ledger', next: NEXT1, detail: DETAIL });
      await refresh(page, '2026-10-14T09:00:00.000Z');
      await openRoom(page, 'Techne');
      let needs = await needsYou(page);
      await expect(needs.locator('.cp-list > li.cp-item').filter({ hasText: 'amber ledger' })).toHaveCount(1);
      const before = await rechecks(needs); // the fixture's own old asks
      await closePanel(page);
      // a vault tool rewrites the step: no asked_at, no ask_sig. The old stamp vouches for words that are gone.
      await page.evaluate((n) => (window as any).__setTask('t145k1', { next: n }), NEXT2);
      await refresh(page, '2026-10-14T09:01:00.000Z');
      needs = await needsYou(page);
      await expect(needs.locator('li.cp-item').filter({ hasText: /amber ledger|cobalt ledger/ })).toHaveCount(0);
      await expect.poll(() => rechecks(needs)).toBe(before + 1);
      if ((await needs.locator('.cp-recheck-line').getAttribute('aria-expanded')) === 'true') await needs.locator('.cp-recheck-line').click();
      await needs.locator('.cp-recheck-line').click();
      const item = needs.locator('.cp-recheck-item').filter({ hasText: 'cobalt ledger' });
      await expect(item.locator('.cp-recheck-asked')).toHaveText(/^changed since asked (today|Oct 14)( · in .*)?$/);
      await item.locator('.cp-rc-open').click();
      const sheet = sheetOf(page);
      await expect(sheet.locator('.task-unconfirmed')).toHaveText(/^Asked (today|Oct 14) · changed since, not confirmed$/i);
      await expect(sheet.locator('h2')).toContainText('cobalt ledger');
      await expect(sheet.getByRole('button', { name: 'I did this' })).toHaveCount(0);
      await expect(sheet.getByRole('button', { name: 'Answer anyway' })).toBeVisible();
      await sheet.getByRole('button', { name: 'Close' }).last().click();
      await expect(sheetOf(page)).toHaveCount(0);
      await closePanel(page);
      // the room asks again (tasks.py set --next): a new asked_at and the sig of the words it wrote, in one write
      await page.evaluate(([n, d, s]) => (window as any).__setTask('t145k1', { next: n, detail: d, asked_at: '2026-10-14T09:01:30.000Z', ask_sig: s }), [NEXT2, DETAIL, askSig(NEXT2, DETAIL)]);
      await refresh(page, '2026-10-14T09:02:00.000Z');
      needs = await needsYou(page);
      await expect(needs.locator('.cp-list > li.cp-item').filter({ hasText: 'cobalt ledger' })).toHaveCount(1);
      await expect.poll(() => rechecks(needs)).toBe(before);
    });

    test('2: an ask that changes after its sheet opened says so and takes no stale answer; the answer after Reload records the revision it answered', async ({ page }) => {
      const skip = only(page); test.skip(!!skip, skip ?? '');
      await boot(page);
      await add(page, { id: 't145k2', title: 'T-902 Placeholder jade ledger', next: 'Say go on the jade ledger for the placeholder books' });
      await refresh(page, '2026-10-14T09:00:00.000Z');
      await openRoom(page, 'Techne');
      const needs = await needsYou(page);
      await needs.locator('.cp-list > li.cp-item').filter({ hasText: 'jade ledger' }).locator('.cp-need').first().click();
      const sheet = sheetOf(page);
      await expect(sheet.getByRole('button', { name: 'I did this' })).toBeVisible();
      const seen = await stampOf(page, 't145k2');
      // the room re-asks while the sheet is open (a properly stamped new revision), and the app has not re-read yet: the tap is the stale answer
      const NEXT = 'Say go on the jade ledger and the onyx ledger for the placeholder books';
      await page.evaluate(([n, s]) => (window as any).__setTask('t145k2', { next: n, asked_at: '2026-10-14T09:00:30.000Z', ask_sig: s }), [NEXT, askSig(NEXT, null)]);
      await sheet.getByRole('button', { name: 'I did this' }).click();
      await expect(sheet.locator('.task-changed')).toHaveText(/This changed since you opened it/);
      await expect(sheet.locator('h2')).toContainText('onyx ledger');
      expect(await stateOf(page, 't145k2')).toBe('open');
      const tried = (await calls(page, 'vault_transition')).filter((c: any) => c.id === 't145k2');
      expect(tried.map((c: any) => c.ifUpdatedAt)).toEqual([seen]); // the one write was against the revision shown, and the vault refused it
      await expect(sheet.getByRole('button', { name: 'I did this' })).toHaveCount(0);
      await sheet.getByRole('button', { name: 'Reload' }).click();
      const now = await stampOf(page, 't145k2');
      expect(now).not.toBe(seen);
      await sheet.getByRole('button', { name: 'I did this' }).click();
      await expect(sheetOf(page)).toHaveCount(0);
      const done = (await calls(page, 'vault_transition')).filter((c: any) => c.id === 't145k2').at(-1);
      expect(done).toEqual({ vault: 'uni', id: 't145k2', from: 'open', to: 'done', ifUpdatedAt: now, metadata: { answered_rev: now } });
      expect(await stateOf(page, 't145k2')).toBe('done');
    });

    test('3: an ask closed or superseded elsewhere drops out of Needs you, and its open sheet says it is no longer open', async ({ page }) => {
      const skip = only(page); test.skip(!!skip, skip ?? '');
      await boot(page);
      await add(page, { id: 't145k3', title: 'T-903 Placeholder opal ledger', next: 'Say go on the opal ledger for the placeholder books' });
      await add(page, { id: 't145k4', title: 'T-904 Placeholder pearl ledger', next: 'Say go on the pearl ledger for the placeholder books' });
      await refresh(page, '2026-10-14T09:00:00.000Z');
      await openRoom(page, 'Techne');
      let needs = await needsYou(page);
      const rows = () => needs.locator('.cp-list > li.cp-item');
      await expect(rows().filter({ hasText: 'opal ledger' })).toHaveCount(1);
      await expect(rows().filter({ hasText: 'pearl ledger' })).toHaveCount(1);
      await rows().filter({ hasText: 'opal ledger' }).locator('.cp-need').first().click();
      const sheet = sheetOf(page);
      await expect(sheet.getByRole('button', { name: 'I did this' })).toBeVisible();
      // its room closes it elsewhere; another is superseded by a newer task
      await page.evaluate(() => { const w = window as any; w.__elsewhere('t145k3', 'done'); w.__setTask('t145k4', { superseded_by: 'T-905' }); });
      await refresh(page, '2026-10-14T09:01:00.000Z');
      await expect(sheet.locator('.task-gone')).toHaveText(/no longer open/);
      await expect(sheet.getByRole('button', { name: 'I did this' })).toHaveCount(0);
      await sheet.getByRole('button', { name: 'Close' }).last().click();
      await expect(sheetOf(page)).toHaveCount(0);
      needs = await needsYou(page);
      await expect(rows().filter({ hasText: /opal ledger|pearl ledger/ })).toHaveCount(0);
      await expect(needs.locator('.cp-recheck-item').filter({ hasText: /opal ledger|pearl ledger/ })).toHaveCount(0);
      expect((await calls(page, 'vault_transition')).filter((c: any) => c.id === 't145k3' || c.id === 't145k4')).toEqual([]);
    });

    test('4: an answer records the revision it answered: "I did this" and a decision both carry answered_rev in the same write', async ({ page }) => {
      const skip = only(page); test.skip(!!skip, skip ?? '');
      await boot(page);
      await add(page, { id: 't145k5', title: 'T-906 Placeholder slate ledger', next: 'Say go on the slate ledger for the placeholder books' });
      await add(page, { id: 't145k6', title: 'Decide the placeholder ledger colour', tag: 'decision', next: 'Pick the placeholder ledger colour', meta: { options: ['Teal', 'Rust'] } });
      await refresh(page, '2026-10-14T09:00:00.000Z');
      await openRoom(page, 'Techne');
      let needs = await needsYou(page);
      const rev5 = await stampOf(page, 't145k5');
      await needs.locator('.cp-list > li.cp-item').filter({ hasText: 'slate ledger' }).locator('.cp-need').first().click();
      await sheetOf(page).getByRole('button', { name: 'I did this' }).click();
      await expect(sheetOf(page)).toHaveCount(0);
      expect((await calls(page, 'vault_transition')).at(-1)).toEqual({ vault: 'uni', id: 't145k5', from: 'open', to: 'done', ifUpdatedAt: rev5, metadata: { answered_rev: rev5 } });
      await closePanel(page);
      needs = await needsYou(page);
      const rev6 = await stampOf(page, 't145k6');
      await needs.locator('.cp-list > li.cp-item').filter({ hasText: 'ledger colour' }).locator('.cp-need').first().click();
      await sheetOf(page).getByRole('button', { name: 'Teal' }).click();
      await expect(sheetOf(page)).toHaveCount(0);
      const d = (await calls(page, 'vault_decide')).at(-1);
      expect(d).toMatchObject({ id: 't145k6', from: 'open', to: 'decided', ifUpdatedAt: rev6, metadata: { decided: 'Teal', answered_rev: rev6 } });
    });
  });
}

// the simple config's projects: mac 1440×900, mac-small 1280×800, phone 390×844
suite('at the project size', (page) => (page.viewportSize()?.width === 1280 ? 'mac and phone are the sizes here; 1280 adds nothing' : null));
// Daylight 1104×828, once (on the mac project)
test.describe('Daylight', () => {
  test.use({ viewport: { width: 1104, height: 828 } });
  suite('at 1104×828', () => (test.info().project.name === 'mac' ? null : 'one project for the fixed size'));
});

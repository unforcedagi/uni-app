// T-86, after r13: tasks are Parachute objects. The lists come from indexed vault queries, every write is a compare-and-set
// `state_transition`, Undo is the reverse. These run in a node's work view ("All of X's work", inside its room's shell) and its task sheet.
// (The octopus node view, its task groups and its talk bar were deleted with the old layouts; roomsnav and simple cover the rest.)
import { mkdir } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import { areaCard, bootAreas } from './areasFixture';

const SHOTS = 'scripts/browser/__shots__/t86';
const isDesktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 900;
const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const calls = (page: Page, cmd: string) => page.evaluate((c) => (window as any).__calls.filter((x: any) => x.cmd === c).map((x: any) => x.args), cmd);
const row = (page: Page, id: string) => page.locator('.sr-work .cp-item').filter({ has: page.locator(`.cp-need[data-id="${id}"]`) });
/** Open a row's task sheet. */
const openTask = (page: Page, id: string) => page.locator(`.sr-work .cp-need[data-id="${id}"]`).click();
const infinite = (page: Page) => page.evaluate(() => document.getAnimations().filter((a) => { const t = a.effect?.getComputedTiming(); return !t || t.iterations === Infinity || !Number.isFinite(t.endTime as number); }).length);
const tree = (page: Page) => page.locator(isDesktop(page) ? '.th-roomnav' : '.th-phone-tree');
/** A node's work page, from its room in the tree. */
async function workPage(page: Page, name: string) {
  if (!isDesktop(page) && await page.locator('.sr-drawer, .th-back').count()) await page.locator('.sr-drawer, .th-back').first().click();
  await tree(page).locator('.th-row.d1').first().waitFor();
  for (let i = 0; i < 12; i++) { const f = tree(page).locator('.th-fold[aria-expanded="false"]'); if (!await f.count()) break; await f.first().click(); }
  await areaCard(page, name).click();
  if (!isDesktop(page) && await page.locator('.cp-line[aria-expanded="false"]').count()) await page.locator('.cp-line').click();
  await page.getByRole('button', { name: /^All of .*'s work/ }).click();
  await expect(page.locator('.sr-work')).toBeVisible();
  await expect(page.locator('.sr-title')).toHaveText(name);
}
const shot = async (page: Page, name: string) => {
  await mkdir(SHOTS, { recursive: true });
  const size = page.viewportSize()!;
  await page.screenshot({ path: `${SHOTS}/${name}-${size.width}x${size.height}.png` });
};

test.describe('tasks in the work view', () => {
  test.beforeEach(async ({ page }) => { await bootAreas(page, 'seed', { briefs: true, tree: true, tasks: true }); });

  test('the task sheet: the action and its next step, Archive, Snooze until tomorrow (guarded merge) and their undo', async ({ page }) => {
    await workPage(page, 'COhere 2026');
    await openTask(page, 'T-03');
    const sheet = page.getByRole('dialog');
    await expect(sheet.locator('h2')).toHaveText('COhere festival readiness');
    await expect(sheet).toContainText('Check-in PR by Oct 12');
    await expect(sheet).not.toContainText(/cdf67944|via api/, { useInnerText: true });
    for (const name of ['I did this', 'Archive', 'Snooze until tomorrow']) await expect(sheet.getByRole('button', { name })).toBeVisible();
    for (const b of await sheet.locator('.task-actions button').all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await shot(page, 'task-sheet');
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);

    await openTask(page, 'T-65');
    await page.getByRole('button', { name: 'Archive' }).click();
    expect((await calls(page, 'vault_transition')).at(-1)).toEqual({ vault: 'uni', id: 'k3', from: 'open', to: 'archived' });
    await expect(row(page, 'T-65')).toHaveCount(0);
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(row(page, 'T-65')).toHaveCount(1);
    expect((await calls(page, 'vault_transition')).at(-1)).toEqual({ vault: 'uni', id: 'k3', from: 'archived', to: 'open' });

    await openTask(page, 'T-65');
    await page.getByRole('button', { name: 'Snooze until tomorrow' }).click();
    const [patch] = await calls(page, 'vault_patch_meta');
    const t = new Date(); t.setDate(t.getDate() + 1);
    const tomorrow = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
    expect(patch).toMatchObject({ vault: 'uni', id: 'k3', metadata: { snoozed_until: tomorrow } });
    expect(typeof patch.ifUpdatedAt).toBe('string');
    await expect(row(page, 'T-65')).toHaveCount(0);
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(row(page, 'T-65')).toHaveCount(1);
    expect((await calls(page, 'vault_patch_meta')).at(-1).metadata).toEqual({ snoozed_until: null });
  });

  test('Open in #room (from another room) opens that room in its shell', async ({ page }) => {
    await workPage(page, 'Uni');
    await openTask(page, 'T-65');
    await page.getByRole('button', { name: 'Open in #Cohere' }).click();
    await expect(page.locator('.sr-title')).toHaveText('COhere 2026');
    await expect(page.getByRole('textbox', { name: 'Message Cohere' })).toBeVisible();
  });

  test('409: changed elsewhere → says so, re-reads, never retries; 422 and other errors roll back with a message', async ({ page }) => {
    await workPage(page, 'COhere 2026');
    await page.evaluate(() => (window as any).__elsewhere('k3', 'done'));
    const before = (await calls(page, 'vault_query_meta')).length;
    await openTask(page, 'T-65');
    await page.getByRole('dialog').getByRole('button', { name: 'I did this' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'changed elsewhere' })).toBeVisible();
    await expect.poll(async () => (await calls(page, 'vault_query_meta')).length).toBeGreaterThan(before);
    expect(await calls(page, 'vault_transition')).toHaveLength(1);
    await expect(row(page, 'T-65')).toHaveCount(0);

    await page.evaluate(() => { (window as any).__failNext = '[schema_validation] state is not one of open,doing'; });
    await openTask(page, 'T-03');
    await page.getByRole('dialog').getByRole('button', { name: 'I did this' }).click();
    await expect(page.getByText(/the vault refused that value/)).toBeVisible();
    await expect(row(page, 'T-03')).toHaveCount(1);

    await page.evaluate(() => { (window as any).__failNext = 'hub unreachable: connect'; });
    await openTask(page, 'T-03');
    await page.getByRole('dialog').getByRole('button', { name: 'I did this' }).click();
    await expect(page.getByText(/Couldn't mark it done: hub unreachable/)).toBeVisible();
    await expect(row(page, 'T-03')).toHaveCount(1);
    expect(await calls(page, 'vault_transition')).toHaveLength(3);
  });

  test('Android Back closes the task sheet first, then the work view, back to the room', async ({ page }) => {
    await workPage(page, 'COhere 2026');
    await openTask(page, 'T-65');
    await expect(page.getByRole('dialog')).toBeVisible();
    const back = () => page.evaluate(() => { const w = window as any; w.__cbs[w.__backHandler.id]({ message: {}, index: w.__backIndex ?? 0 }); w.__backIndex = (w.__backIndex ?? 0) + 1; });
    await back();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('.sr-work')).toBeVisible();
    await back();
    await expect(page.locator('.sr-work')).toHaveCount(0);
    await expect(page.locator('.sr-chat')).toBeVisible();
    await expect(page.locator('.sr-title')).toHaveText('COhere 2026');
  });

  test('calm: nothing loops, no overflow at three sizes', async ({ page }, info) => {
    await workPage(page, 'COhere 2026');
    expect(await infinite(page)).toBe(0);
    await openTask(page, 'T-65');
    await page.waitForTimeout(400);
    expect(await infinite(page)).toBe(0);
    await page.keyboard.press('Escape');
    const css = await page.evaluate(() => [...document.styleSheets].flatMap((s) => { try { return [...s.cssRules]; } catch { return []; } }).filter((r) => /infinite/.test(r.cssText) && /task|undo|work/.test(r.cssText)).length);
    expect(css).toBe(0);
    test.skip(info.project.name !== 'desktop', 'sizes are set inside this test');
    for (const [w, h] of [[1600, 1200], [1200, 1600], [390, 844]]) {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(250);
      expect(await fits(page)).toBe(true);
    }
  });
});

test('a task title is text, never markup', async ({ page }) => {
  await bootAreas(page, 'seed', { briefs: true, tree: true, tasks: true });
  await page.evaluate(() => { (window as any).__tasks.push({ id: 'x1', path: 'Tasks/<img src=x onerror=window.__pwn=1> bold', extension: 'md', tags: ['task'], updatedAt: 'T', metadata: { node: 'Uni', state: 'open', owner: 'aaron', next: '<b>hi</b>' } }); });
  await workPage(page, 'Uni');
  await expect(page.locator('.sr-work .cp-title', { hasText: '<img src=x' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__pwn)).toBeUndefined();
  expect(await page.locator('.sr-work img, .cp-item img').count()).toBe(0);
});

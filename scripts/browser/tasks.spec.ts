// T-86, after r13: tasks are Parachute objects. The lists come from indexed vault queries, every write is a compare-and-set
// `state_transition`, Undo is the reverse. These run in a node's work view ("All of X's work", T-335: inside its room's focus, from its
// details) and its task sheet.
// (The octopus node view, its task groups and its talk bar were deleted with the old layouts; roomsnav and simple cover the rest.)
import { mkdir } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import { bootAreas, focusSheet, openAreaPage, openAreasHome, openDetails } from './areasFixture';

const SHOTS = 'scripts/browser/__shots__/t86';
const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const calls = (page: Page, cmd: string) => page.evaluate((c) => (window as any).__calls.filter((x: any) => x.cmd === c).map((x: any) => x.args), cmd);
const row = (page: Page, id: string) => page.locator('.fx-work .cp-item').filter({ has: page.locator(`.cp-need[data-id="${id}"]`) });
/** Open a row's task sheet. */
const openTask = (page: Page, id: string) => page.locator(`.fx-work .cp-need[data-id="${id}"]`).click();
const infinite = (page: Page) => page.evaluate(() => document.getAnimations().filter((a) => { const t = a.effect?.getComputedTiming(); return !t || t.iterations === Infinity || !Number.isFinite(t.endTime as number); }).length);
const title = (page: Page) => focusSheet(page).locator('.all-focus-title');
/** T-335: a place is opened from Uni's home (its door, or its parent's details there): from anywhere else (a room in focus, All), go there first. */
const fromHome = async (page: Page) => { if (!(await page.locator('[data-place="front-door"]').first().isVisible()) || (await focusSheet(page).isVisible())) await openAreasHome(page); };
/** Where a place inside another is reached: its parent's details ("Inside X"). */
const PARENT: Record<string, string> = { 'COhere 2026': 'Techne' };
/** A node's work page (T-335: its room in focus, its details, "All of X's work"). */
async function workPage(page: Page, name: string) {
  await fromHome(page);
  await openAreaPage(page, name, { app: false, parent: PARENT[name] });
  await openDetails(page);
  await focusSheet(page).getByRole('button', { name: /^All of .*'s work/ }).click();
  await expect(focusSheet(page).getByRole('region', { name: `${name}'s work` })).toBeVisible();
  await expect(page.locator('.fx-work')).toBeVisible();
  await expect(title(page)).toHaveText(name);
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
    // r16: written against the revision shown
    expect((await calls(page, 'vault_transition')).at(-1)).toEqual({ vault: 'uni', id: 'k3', from: 'open', to: 'archived', ifUpdatedAt: expect.any(String) });
    await expect(row(page, 'T-65')).toHaveCount(0);
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(row(page, 'T-65')).toHaveCount(1);
    expect((await calls(page, 'vault_transition')).at(-1)).toEqual({ vault: 'uni', id: 'k3', from: 'archived', to: 'open', ifUpdatedAt: expect.any(String) });

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
    await workPage(page, 'Techne'); // a project's task, seen from its area's work view, opens the project's own room
    await openTask(page, 'T-65');
    await page.getByRole('button', { name: 'Open in #Cohere' }).click();
    await expect(title(page)).toHaveText('COhere 2026');
    await expect(focusSheet(page).getByRole('textbox', { name: 'Message Cohere' })).toBeVisible();
  });

  test('409: changed elsewhere → says so, re-reads, never retries; 422 and other errors roll back with a message', async ({ page }) => {
    await workPage(page, 'COhere 2026');
    await page.evaluate(() => (window as any).__elsewhere('k3', 'done'));
    const before = (await calls(page, 'vault_query_meta')).length;
    await openTask(page, 'T-65');
    await page.getByRole('dialog').getByRole('button', { name: 'I did this' }).click();
    // r16: the sheet stays, says it changed, and re-reads: the task is now done elsewhere, so the sheet says it is no longer open
    await expect(page.getByRole('dialog').locator('.task-gone')).toBeVisible();
    await expect.poll(async () => (await calls(page, 'vault_query_meta')).length).toBeGreaterThan(before);
    expect(await calls(page, 'vault_transition')).toHaveLength(1);
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).last().click();
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

  test('Android Back closes the task sheet first, then the work view, then the details, back to the room', async ({ page }) => {
    await workPage(page, 'COhere 2026');
    await openTask(page, 'T-65');
    await expect(page.getByRole('dialog')).toBeVisible();
    const back = () => page.evaluate(() => { const w = window as any; w.__cbs[w.__backHandler.id]({ message: {}, index: w.__backIndex ?? 0 }); w.__backIndex = (w.__backIndex ?? 0) + 1; });
    await back();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('.fx-work')).toBeVisible();
    await back();
    await expect(page.locator('.fx-work')).toHaveCount(0);
    // T-335: the work view opened from the room's details, so Back passes through them
    await expect(focusSheet(page).getByRole('region', { name: 'COhere 2026 details' })).toBeVisible();
    await back();
    await expect(page.locator('.all-focus-details')).toHaveCount(0);
    await expect(focusSheet(page).locator('.sr-chat')).toBeVisible();
    await expect(title(page)).toHaveText('COhere 2026');
  });

  test('calm: nothing loops, no overflow at three sizes', async ({ page }, info) => {
    await workPage(page, 'COhere 2026');
    expect(await infinite(page)).toBe(0);
    await openTask(page, 'T-65');
    await page.waitForTimeout(400);
    expect(await infinite(page)).toBe(0);
    await page.keyboard.press('Escape');
    const css = await page.evaluate(() => [...document.styleSheets].flatMap((s) => { try { return [...s.cssRules]; } catch { return []; } }).filter((r) => /infinite/.test(r.cssText) && /\.(task|undo|work)\b/.test(r.cssText) /* a class of the work view (\.working-dot is the chat's "Uni is working") */).length);
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
  // 0.2: a place's room opens in focus over the home, with no new read of the tasks, so the task is in the vault from the start
  await page.addInitScript(() => { (window as any).__seedTasks = [{ id: 'x1', path: 'Tasks/<img src=x onerror=window.__pwn=1> bold', extension: 'md', tags: ['task'], updatedAt: 'T', metadata: { node: 'Areas/Techne', state: 'open', owner: 'aaron', next: '<b>hi</b>' } }]; });
  await bootAreas(page, 'seed', { briefs: true, tree: true, tasks: true });
  await workPage(page, 'Techne'); // T-302: Uni's own level went with the Uni room as home; an area's work view reads the same rows
  await expect(page.locator('.fx-work .cp-title', { hasText: '<img src=x' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__pwn)).toBeUndefined();
  expect(await page.locator('.fx-work img, .cp-item img').count()).toBe(0);
});

// T-111 (0.1.42), after r13: rooms as the primary navigation, and each node's work in its room. The room tree is visible on the phone (as
// the home) and on Daylight (a left column); "All of X's work" is a view inside the room shell (Needs you, In motion, Later); priority is
// set in the task sheet with one guarded write and an undo; private areas are named by place only; a vault without chat still works.
// (The "Where we are" census, its Now/Soon/Someday buckets and the per-row priority selects were deleted in r13.)
import { mkdir } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import { bootAreas } from './areasFixture';

const SHOTS = 'scripts/browser/__shots__/roomsnav';
const wide = (page: Page) => (page.viewportSize()?.width ?? 0) >= 900;
const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const calls = (page: Page, cmd: string) => page.evaluate((c) => (window as any).__calls.filter((x: any) => x.cmd === c).map((x: any) => x.args), cmd);
const work = (page: Page) => page.locator('.sr-work');
const base = { briefs: true, tree: true, tasks: true, boulder: true, underBoulder: true, ricki: true, pinned: true, privateTasks: true } as const;
const boot = (page: Page, o: Parameters<typeof bootAreas>[2] = {}) => bootAreas(page, 'seed', { ...base, ...o });
const shot = async (page: Page, name: string) => {
  await mkdir(SHOTS, { recursive: true });
  const s = page.viewportSize()!;
  const file = `${SHOTS}/${name}-${s.width}x${s.height}`;
  await page.screenshot({ path: `${file}.png` });
  const tag = await page.addStyleTag({ content: 'html{filter:grayscale(1)}' });
  await page.screenshot({ path: `${file}-gray.png` });
  await tag.evaluate((n) => n.remove());
};
/** The node's work view ("All of X's work"): one level deeper than its room, inside the same shell. Without chat it is the room's view. */
async function full(page: Page) {
  await page.locator('.sr').first().waitFor();
  if (await work(page).count()) return;
  if (await page.locator('.cp-line[aria-expanded="false"]').count()) await page.locator('.cp-line').click();
  await page.getByRole('button', { name: /^All of .*'s work/ }).click();
  await work(page).waitFor();
}
/** Open a node by name: a row of the left column (wide), or a row of the room tree / a child in the panel (phone). */
/** r7: areas start folded; open every fold so any row can be clicked. */
async function unfoldTree(page: Page) {
  if (!wide(page) && await page.locator('.sr-drawer').count() && !await page.locator('.th-drawer').count()) await page.locator('.sr-drawer').click();
  const tree = page.locator('.th-roomnav, .th-phone-tree').first();
  if (!await tree.count()) return;
  await tree.locator('.th-row.d1').first().waitFor().catch(() => {});
  for (let i = 0; i < 12; i++) { const f = tree.locator('.th-fold[aria-expanded="false"]'); if (!await f.count()) return; await f.first().click(); }
}
async function go(page: Page, name: string) {
  await unfoldTree(page);
  const row = page.locator(`.th-go[aria-label="${name}"], .th-go[aria-label^="${name},"]`);
  await row.or(page.locator(`.th-kid[data-name="${name}"]`)).first().waitFor();
  if (await row.count()) await row.first().click(); else await page.locator(`.th-kid[data-name="${name}"]`).click();
  await full(page);
}
const title = async (page: Page, name: string) => { await full(page); await expect.poll(async () => [await page.locator('.sr').first().getAttribute('data-node').catch(() => null), await page.locator('.sr-title').first().textContent().catch(() => null)]).toContain(name); /* r15: a borrowed room's heading is the room; the place is data-node */ };
const row = (page: Page, id: string) => work(page).locator('.cp-item').filter({ has: page.locator(`.cp-need[data-id="${id}"]`) });
const needs = (page: Page) => work(page).getByRole('region', { name: 'Needs you' });
/** r14: priority is under the sheet's Details. */
const priority = async (page: Page) => { const d = page.getByRole('dialog'); if (await d.locator('.task-details:not([open]) > summary').count()) await d.locator('.task-details > summary').click(); return d.getByRole('group', { name: 'Priority' }); };

test.describe('rooms nav', () => {
  test('the room tree is the home on both screens: a column beside the panel on Daylight, the home on the phone', async ({ page }) => {
    await boot(page);
    await unfoldTree(page);
    if (wide(page)) {
      const nav = page.locator('.th-roomnav');
      await expect(nav).toBeVisible();
      await expect(page.locator('.sr')).toBeVisible();
      await expect(page.locator('.node-stage')).toHaveCount(0);
      await title(page, 'Uni');
      await expect(nav.locator('.th-go[aria-current="page"]')).toHaveAttribute('data-path', '');
      for (const n of ['Boulder', 'COhere 2026', 'Techne', 'Unforced Development']) await expect(nav.locator(`.th-go[aria-label^="${n},"]`)).toBeVisible();
      await expect(nav.locator('.th-go[aria-label^="COhere 2026,"]')).toContainText('#Cohere');
      await expect(nav.locator('.th-go[aria-label^="Boulder Civic Calendar,"]')).not.toContainText('held by');
      // the column stays while the level changes, and marks the selected one
      await page.locator('.th-roomnav .th-go[aria-label^="Techne,"]').click();
      await title(page, 'Techne');
      await expect(nav).toBeVisible();
      await expect(nav.locator('.th-go[aria-current="page"]')).toHaveAttribute('aria-label', /^Techne,/);
    } else {
      await expect(page.locator('.th-phone-tree')).toBeVisible();
      await expect(page.locator('.th-go[aria-label^="COhere 2026,"]')).toContainText('#Cohere');
      await expect(page.locator('.th-go[aria-label^="Techne,"] .th-dot')).toBeVisible();
      for (const b of await page.locator('.th-go').all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    expect(await fits(page)).toBe(true);
    await shot(page, 'home');
  });

  test('Boulder → COhere 2026: each work view lists its own subtree; seen from above a row says where it sits', async ({ page }) => {
    await boot(page);
    await go(page, 'Boulder');
    await title(page, 'Boulder');
    // Boulder's subtree: T-03 (waiting on you), T-65, T-90 and the open decision need you; T-64 (a room's) and T-91 are in motion
    await expect(needs(page).locator('.wv-n')).toHaveText('4');
    for (const id of ['T-03', 'T-65', 'T-90']) await expect(row(page, id)).toHaveCount(1);
    await expect(needs(page)).toContainText('Decide the COhere venue');
    await expect(work(page).getByRole('region', { name: 'In motion' })).toContainText('COhere app spec');
    await expect(work(page).getByRole('region', { name: 'In motion' })).toContainText('in COhere 2026');
    await shot(page, 'boulder');
    await go(page, 'COhere 2026');
    await title(page, 'COhere 2026');
    await expect(needs(page).locator('.wv-n')).toHaveText('3');
    await expect(row(page, 'T-03')).toContainText('Check-in PR by Oct 12');
    await expect(row(page, 'T-03')).toContainText(/due Oct 12/);
    await expect(row(page, 'T-65')).toContainText('Send to Kevin for the numbers');
    await shot(page, 'cohere');
    expect(await fits(page)).toBe(true);
  });

  test('Later holds Someday, folded until opened and never counted in Needs you', async ({ page }) => {
    await boot(page);
    await go(page, 'Unforced Development');
    const later = work(page).getByRole('region', { name: 'Later' });
    const fold = later.locator('.wv-fold');
    await expect(fold).toHaveAttribute('aria-expanded', 'false');
    await expect(work(page)).not.toContainText('Send the Q4 invoice');
    await fold.click();
    await expect(fold).toHaveAttribute('aria-expanded', 'true');
    await expect(later).toContainText('Send the Q4 invoice');
    await expect(needs(page)).not.toContainText('Send the Q4 invoice');
    await shot(page, 'later-open');
  });

  test('priority: set in the task sheet, one guarded metadata write, and Undo reverts it', async ({ page }) => {
    await boot(page);
    await go(page, 'COhere 2026');
    await title(page, 'COhere 2026');
    await row(page, 'T-65').locator('.cp-need').click();
    await expect((await priority(page)).getByRole('button', { name: 'Soon' })).toHaveAttribute('aria-pressed', 'true');
    await (await priority(page)).getByRole('button', { name: 'Now' }).click();
    await expect.poll(async () => (await calls(page, 'vault_patch_meta')).length).toBe(1);
    const [w] = await calls(page, 'vault_patch_meta');
    expect(w).toMatchObject({ vault: 'uni', id: 'k3', metadata: { priority: 'now', priority_by: 'hand' } });
    expect(typeof w.ifUpdatedAt).toBe('string');
    // the sheet is live: it shows the new priority at once
    await expect((await priority(page)).getByRole('button', { name: 'Now' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('Priority: now')).toBeVisible();
    await page.keyboard.press('Escape');
    await shot(page, 'priority-undo');
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(async () => (await calls(page, 'vault_patch_meta')).length).toBe(2);
    expect((await calls(page, 'vault_patch_meta'))[1]).toMatchObject({ id: 'k3', metadata: { priority: 'soon', priority_by: 'weigh.py 2026-10-12' } });
    expect(await page.evaluate(() => (window as any).__tasks.find((t: any) => t.id === 'k3').metadata.priority)).toBe('soon');
    // an unsorted task: undo clears the key again rather than inventing a value
    await go(page, 'Boulder');
    await row(page, 'T-90').locator('.cp-need').click();
    await (await priority(page)).getByRole('button', { name: 'Someday' }).click();
    await expect.poll(async () => (await calls(page, 'vault_patch_meta')).length).toBe(3);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(async () => (await calls(page, 'vault_patch_meta')).length).toBe(4);
    expect((await calls(page, 'vault_patch_meta'))[3]).toMatchObject({ id: 'b1', metadata: { priority: null, priority_by: null } });
    expect(await page.evaluate(() => 'priority' in (window as any).__tasks.find((t: any) => t.id === 'b1').metadata)).toBe(false);
  });

  test('a priority changed elsewhere meanwhile is a conflict: nothing is overwritten, and it says so', async ({ page }) => {
    await boot(page);
    await go(page, 'COhere 2026');
    await row(page, 'T-65').locator('.cp-need').click();
    await page.evaluate(() => { const t = (window as any).__tasks.find((x: any) => x.id === 'k3'); t.metadata.priority = 'someday'; t.updatedAt = '2026-10-11T09:00:00.000Z'; });
    await (await priority(page)).getByRole('button', { name: 'Now' }).click();
    await expect(page.getByText(/changed elsewhere, so its priority wasn't changed/)).toBeVisible();
    expect(await page.evaluate(() => (window as any).__tasks.find((t: any) => t.id === 'k3').metadata.priority)).toBe('someday');
  });

  test('Uni\'s work view is all of it, across the areas: each row says where it sits', async ({ page }) => {
    await boot(page);
    if (!wide(page)) await expect(page.locator('.th-phone-tree')).toBeVisible();
    await go(page, 'Uni');
    await title(page, 'Uni');
    await expect(row(page, 'T-33')).toHaveCount(1);
    await expect(work(page).getByRole('region', { name: 'Needs you' })).toHaveCount(1);
    await shot(page, 'root');
  });

  test('private areas are one line by place from above; inside the area they are its rows; they are counted', async ({ page }) => {
    await boot(page);
    if (!wide(page)) await expect(page.locator('.th-phone-tree')).not.toContainText(/T-3[12]/);
    await go(page, 'Uni');
    await title(page, 'Uni');
    await expect(work(page)).not.toContainText(/Sit twenty|Find a teacher|T-31|T-32/);
    await expect(needs(page).locator('.cp-private')).toHaveText('Sadhana: 1 for you ›');
    await expect(work(page)).toContainText(/One item in a private area is not listed here/);
    if (wide(page)) await expect(page.locator('.th-roomnav')).not.toContainText(/T-3[12]/);
    // r14: the area itself, opened by Aaron: its items are ordinary rows, with their titles
    await go(page, 'Sadhana');
    await title(page, 'Sadhana');
    await expect(needs(page).locator('.wv-n')).toHaveText('1');
    await expect(needs(page).locator('.cp-private')).toHaveCount(0);
    await expect(needs(page)).toContainText('Sit twenty');
    await shot(page, 'private');
  });

  test('chat.provider null: the tree, the work view and the sheet\'s priority work with no room or Buzz surface', async ({ page }) => {
    await boot(page, { profileNote: { chat: { provider: null } } });
    await expect(page.locator(wide(page) ? '.th-roomnav' : '.th-phone-tree')).toBeVisible();
    await go(page, 'Boulder');
    await title(page, 'Boulder');
    await expect(row(page, 'T-03')).toHaveCount(1);
    await expect(page.locator('.talk, .th-door, .th-roomline, .th-ledger, .sr-chat, .composer')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Back to chat' })).toHaveCount(0);
    await row(page, 'T-65').locator('.cp-need').click();
    await (await priority(page)).getByRole('button', { name: 'Now' }).click();
    await expect.poll(async () => (await calls(page, 'vault_patch_meta')).length).toBe(1);
    expect(await calls(page, 'post_message')).toEqual([]);
    await shot(page, 'no-chat');
  });

  test('calm: nothing loops in the work view', async ({ page }) => {
    await boot(page, { });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await go(page, 'Boulder');
    await title(page, 'Boulder');
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => document.getAnimations().filter((a) => { const t = a.effect?.getComputedTiming(); return !t || t.iterations === Infinity || !Number.isFinite(t.endTime as number); }).length)).toBe(0);
  });
});

// T-111 (0.1.42): rooms as the primary navigation, and "Where we are" at the top of each level's panel.
// The room tree is visible on the phone (as the home) and on Daylight (a left column beside the panel); Needs you groups by priority;
// the priority control writes once and undoes; private areas show counts only; a vault without chat still works.
import { mkdir } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import { bootAreas } from './areasFixture';

const SHOTS = 'scripts/browser/__shots__/roomsnav';
const wide = (page: Page) => (page.viewportSize()?.width ?? 0) >= 900;
const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const calls = (page: Page, cmd: string) => page.evaluate((c) => (window as any).__calls.filter((x: any) => x.cmd === c).map((x: any) => x.args), cmd);
const panel = (page: Page) => page.locator('.th-panel');
const where = (page: Page) => panel(page).getByRole('region', { name: 'Where we are' });
const base = { briefs: true, tree: true, tasks: true, boulder: true, underBoulder: true, priya: true, pinned: true, privateTasks: true } as const;
const boot = (page: Page, o: Parameters<typeof bootAreas>[2] = {}) => bootAreas(page, 'seed', { ...base, layout: 'rooms', ...o });
const shot = async (page: Page, name: string) => {
  await mkdir(SHOTS, { recursive: true });
  const s = page.viewportSize()!;
  const file = `${SHOTS}/${name}-${s.width}x${s.height}`;
  await page.screenshot({ path: `${file}.png` });
  const tag = await page.addStyleTag({ content: 'html{filter:grayscale(1)}' });
  await page.screenshot({ path: `${file}-gray.png` });
  await tag.evaluate((n) => n.remove());
};
/** Open a node by name: a row of the left column (wide), or a row of the room tree / a child in the panel (phone). */
async function go(page: Page, name: string) {
  const row = page.locator(`.th-go[aria-label="${name}"], .th-go[aria-label^="${name},"]`);
  await row.or(page.locator(`.th-kid[data-name="${name}"]`)).first().waitFor();
  if (await row.count()) { await row.first().click(); return; }
  await page.locator(`.th-kid[data-name="${name}"]`).click();
}
const title = (page: Page, name: string) => expect(panel(page).locator('h1')).toHaveText(name);
const bucket = (page: Page, p: string) => where(page).locator(`.wr-bucket.p-${p}`);

test.describe('rooms nav', () => {
  test('the room tree is the home on both screens: a column beside the panel on Daylight, the home on the phone', async ({ page }) => {
    await boot(page);
    if (wide(page)) {
      const nav = page.locator('.th-roomnav');
      await expect(nav).toBeVisible();
      await expect(panel(page)).toBeVisible();
      await expect(page.locator('.node-stage')).toHaveCount(0);
      await title(page, 'Uni');
      await expect(nav.locator('.th-go[aria-current="page"]')).toHaveAttribute('data-path', '');
      for (const n of ['Boulder', 'COhere 2026', 'Techne', 'Unforced Development']) await expect(nav.locator(`.th-go[aria-label^="${n},"]`)).toBeVisible();
      await expect(nav.locator('.th-go[aria-label^="COhere 2026,"]')).toContainText('boulder/cohere');
      await expect(nav.locator('.th-go[aria-label^="Boulder Civic Calendar,"]')).toContainText('held by #boulder');
      // the column stays while the level changes, and marks the selected one
      await page.locator('.th-roomnav .th-go[aria-label^="Techne,"]').click();
      await title(page, 'Techne');
      await expect(nav).toBeVisible();
      await expect(nav.locator('.th-go[aria-current="page"]')).toHaveAttribute('aria-label', /^Techne,/);
    } else {
      await expect(page.locator('.th-phone-tree')).toBeVisible();
      await expect(page.locator('.th-go[aria-label^="COhere 2026,"]')).toContainText('boulder/cohere');
      await expect(page.locator('.th-go[aria-label^="Techne,"] .th-tag')).toBeVisible();
      for (const b of await page.locator('.th-go').all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    expect(await fits(page)).toBe(true);
    await shot(page, 'home');
  });

  test('Boulder → COhere 2026: selecting a room updates the panel; Where we are leads it', async ({ page }) => {
    await boot(page);
    await go(page, 'Boulder');
    await title(page, 'Boulder');
    // Where we are is the first section of the panel
    await expect(panel(page).locator('.th-scroll > section').first()).toHaveAttribute('aria-label', 'Where we are');
    // Boulder's subtree: T-03 (waiting on you), T-64 (doing, a room's), T-65, the decision, T-90, T-91
    await expect(where(page).locator('.wr-counts')).toContainText(/open\s*4/);
    await expect(where(page).locator('.wr-counts')).toContainText(/doing\s*1/);
    await expect(where(page).locator('.wr-counts')).toContainText(/waiting\s*1/);
    await expect(where(page).locator('.wr-counts')).toContainText(/need you\s*4/);
    await expect(where(page).getByRole('region', { name: 'Moved this week' })).toContainText('T-90');
    // seen from above, a row names the project it belongs to
    await expect(bucket(page, 'soon').locator('.wr-row', { hasText: 'T-65' })).toContainText('COhere 2026');
    await shot(page, 'boulder');
    await go(page, 'COhere 2026');
    await title(page, 'COhere 2026');
    await expect(where(page).locator('.wr-counts')).toContainText(/need you\s*3/);
    // at its own level a row does not repeat the project; next step and due show
    await expect(bucket(page, 'now').locator('.wr-row', { hasText: 'T-03' })).toContainText('Check-in PR by Oct 12');
    await expect(bucket(page, 'now').locator('.wr-row', { hasText: 'T-03' })).toContainText(/due Oct 12/);
    await expect(bucket(page, 'soon').locator('.wr-row', { hasText: 'T-65' })).not.toContainText('COhere 2026');
    await expect(bucket(page, 'soon').locator('.wr-row', { hasText: 'T-65' })).toContainText('Send to Casey for the numbers');
    await expect(panel(page).locator('.th-roomline .th-door')).toHaveText('boulder/cohere');
    await shot(page, 'cohere');
    expect(await fits(page)).toBe(true);
  });

  test('Needs you is grouped Now / Soon / Someday; Someday is collapsed to a count until opened', async ({ page }) => {
    await boot(page);
    await go(page, 'Boulder');
    await title(page, 'Boulder');
    const needs = where(page).getByRole('region', { name: 'Needs you' });
    await expect(needs.locator('.wr-bucket')).toHaveCount(3);
    await expect(needs.locator('.wr-bucket .wr-h span')).toHaveText(['Now', 'Soon', 'Someday']);
    await expect(bucket(page, 'now').locator('.wr-row')).toHaveText([/T-03/]);
    // soon holds the explicit `soon` and the task with no priority at all (unsorted reads as soon)
    await expect(bucket(page, 'soon').locator('.wr-row .wr-id')).toHaveText(['T-65', 'T-90']);
    await expect(bucket(page, 'soon').locator('.wr-prio[aria-label="Priority for T-90"] option:checked')).toHaveText('Soon (unsorted)');
    // someday: a count, no rows
    const fold = bucket(page, 'someday').locator('.wr-fold');
    await expect(fold).toHaveAttribute('aria-expanded', 'false');
    await expect(fold.locator('em')).toHaveText('1');
    await expect(bucket(page, 'someday').locator('.wr-row')).toHaveCount(0);
    await expect(where(page)).not.toContainText('Decide the COhere venue');
    await fold.click();
    await expect(fold).toHaveAttribute('aria-expanded', 'true');
    await expect(bucket(page, 'someday').locator('.wr-row')).toContainText('Decide the COhere venue');
    await shot(page, 'someday-open');
    await fold.click();
    await expect(bucket(page, 'someday').locator('.wr-row')).toHaveCount(0);
    // check-off keeps working from the new rows: a state_transition, with undo
    await page.getByRole('button', { name: 'Mark done: T-90 Draft council testimony' }).click();
    expect(await calls(page, 'vault_transition')).toEqual([{ vault: 'uni', id: 'b1', from: 'open', to: 'done' }]);
    await expect(where(page).locator('.wr-row', { hasText: 'T-90' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(where(page).locator('.wr-row', { hasText: 'T-90' })).toHaveCount(1);
  });

  test('priority: one guarded metadata write, the row moves, and Undo reverts it', async ({ page }) => {
    await boot(page);
    await go(page, 'Boulder');
    await go(page, 'COhere 2026');
    await title(page, 'COhere 2026');
    const pick = where(page).locator('.wr-prio[aria-label="Priority for T-65"]');
    await expect(pick).toHaveValue('soon');
    await pick.selectOption('now');
    await expect.poll(async () => (await calls(page, 'vault_patch_meta')).length).toBe(1);
    const [w] = await calls(page, 'vault_patch_meta');
    expect(w).toMatchObject({ vault: 'uni', id: 'k3', metadata: { priority: 'now' } });
    expect(typeof w.ifUpdatedAt).toBe('string');
    await expect(bucket(page, 'now').locator('.wr-row .wr-id')).toHaveText(['T-03', 'T-65']);
    await expect(bucket(page, 'soon')).toHaveCount(0);
    await expect(page.getByText('Priority: now')).toBeVisible();
    await shot(page, 'priority-undo');
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(async () => (await calls(page, 'vault_patch_meta')).length).toBe(2);
    expect((await calls(page, 'vault_patch_meta'))[1]).toMatchObject({ id: 'k3', metadata: { priority: 'soon' } });
    await expect(bucket(page, 'soon').locator('.wr-row .wr-id')).toHaveText(['T-65']);
    expect(await page.evaluate(() => (window as any).__tasks.find((t: any) => t.id === 'k3').metadata.priority)).toBe('soon');
    // an unsorted task: undo clears the key again rather than inventing a value
    await panel(page).getByRole('navigation', { name: 'Where you are' }).getByRole('button', { name: 'Boulder' }).click();
    await title(page, 'Boulder');
    await where(page).locator('.wr-prio[aria-label="Priority for T-90"]').selectOption('someday');
    await expect.poll(async () => (await calls(page, 'vault_patch_meta')).length).toBe(3);
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(async () => (await calls(page, 'vault_patch_meta')).length).toBe(4);
    expect((await calls(page, 'vault_patch_meta'))[3]).toMatchObject({ id: 'b1', metadata: { priority: null } });
    expect(await page.evaluate(() => 'priority' in (window as any).__tasks.find((t: any) => t.id === 'b1').metadata)).toBe(false);
    // the five seconds run out
    await where(page).locator('.wr-prio[aria-label="Priority for T-90"]').selectOption('now');
    await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Undo' })).toHaveCount(0, { timeout: 7000 });
  });

  test('a priority changed elsewhere meanwhile is a conflict: nothing is overwritten, and it says so', async ({ page }) => {
    await boot(page);
    await go(page, 'Boulder');
    await go(page, 'COhere 2026');
    await page.evaluate(() => { const t = (window as any).__tasks.find((x: any) => x.id === 'k3'); t.metadata.priority = 'someday'; t.updatedAt = '2026-10-11T09:00:00.000Z'; });
    await where(page).locator('.wr-prio[aria-label="Priority for T-65"]').selectOption('now');
    await expect(page.getByText(/changed elsewhere, so its priority wasn't changed/)).toBeVisible();
    expect(await page.evaluate(() => (window as any).__tasks.find((t: any) => t.id === 'k3').metadata.priority)).toBe('someday');
  });

  test('the root level is the morning view: all of it, across the areas; the old long list is not repeated', async ({ page }) => {
    await boot(page);
    if (!wide(page)) await expect(page.locator('.th-phone-tree')).toBeVisible();
    await go(page, 'Uni');
    await title(page, 'Uni');
    await expect(where(page)).toContainText('All of it');
    await expect(where(page).locator('.wr-counts')).toContainText(/need you\s*\d+/);
    // seen from Uni, each row says where it belongs
    await expect(where(page).locator('.wr-row', { hasText: 'T-33' })).toContainText('Techne');
    await expect(panel(page).getByRole('region', { name: 'Needs you' })).toHaveCount(1);
    await expect(panel(page).locator('.th-sec.th-needs')).toHaveCount(0);
    await shot(page, 'root');
  });

  test('private areas: counts and time only, from above and at their own level', async ({ page }) => {
    await boot(page);
    // the root counts Sanctum's two tasks but names neither
    if (!wide(page)) await expect(page.locator('.th-phone-tree')).not.toContainText(/T-3[12]/);
    await go(page, 'Uni');
    await title(page, 'Uni');
    await expect(where(page)).not.toContainText(/Sit twenty|Find a teacher|T-31|T-32/);
    await expect(where(page).getByRole('region', { name: 'Needs you' }).locator('.wr-bucket.p-now .wr-h em')).toHaveText('3');
    await expect(bucket(page, 'someday').locator('.wr-fold em')).toHaveText('4');
    await expect(where(page).getByText(/more in private areas, counted not named/).first()).toBeVisible();
    if (wide(page)) await expect(page.locator('.th-roomnav')).not.toContainText(/T-3[12]/);
    // the level itself: counts, no rows, a time for the last change
    await go(page, 'Sanctum');
    await title(page, 'Sanctum');
    await expect(where(page).locator('.wr-counts')).toContainText(/need you\s*2/);
    await expect(where(page).locator('.wr-row')).toHaveCount(0);
    await expect(where(page).getByRole('region', { name: 'Moved this week' })).toContainText(/1 changed, the last \d+[dh] ago\. Counted, not named\./);
    await expect(where(page)).not.toContainText(/Sit twenty|Find a teacher/);
    await shot(page, 'private');
  });

  test('Rooms is the default when nothing was chosen; Map, Octopus and Classic stay in Settings', async ({ page }) => {
    await boot(page, { layout: 'unset' });
    await expect(page.locator(wide(page) ? '.th-roomnav' : '.th-phone-tree')).toBeVisible();
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('radio', { name: /^Rooms/ })).toBeChecked();
    for (const l of ['Map', 'Octopus', 'Classic']) await expect(page.getByRole('radio', { name: new RegExp(`^${l}`) })).toBeVisible();
    // an earlier explicit choice of the Map stands
    await page.getByRole('radio', { name: /^Map/ }).check();
    expect(await page.evaluate(() => localStorage.getItem('uni.home.layout.v1'))).toBe('tree');
    await page.reload();
    if (wide(page)) await expect(page.locator('.th-stage .node-stage').first()).toBeVisible();
    await expect(page.locator('.th-roomnav')).toHaveCount(0);
  });

  test('chat.provider null: the tree, Where we are and the priority control work with no room or Buzz surface', async ({ page }) => {
    await boot(page, { profileNote: { chat: { provider: null } } });
    await expect(page.locator(wide(page) ? '.th-roomnav' : '.th-phone-tree')).toBeVisible();
    await go(page, 'Boulder');
    await title(page, 'Boulder');
    await expect(where(page)).toBeVisible();
    await expect(bucket(page, 'now').locator('.wr-row')).toContainText('T-03');
    await expect(page.locator('.talk, .th-door, .th-roomline, .th-ledger, .th-sec.th-updates')).toHaveCount(0);
    await where(page).locator('.wr-prio[aria-label="Priority for T-65"]').selectOption('now');
    await expect.poll(async () => (await calls(page, 'vault_patch_meta')).length).toBe(1);
    expect(await calls(page, 'post_message')).toEqual([]);
    await shot(page, 'no-chat');
  });

  test('calm: nothing loops, and the only motion is a short fade on a leaving row', async ({ page }) => {
    await boot(page, { });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await go(page, 'Boulder');
    await title(page, 'Boulder');
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => document.getAnimations().filter((a) => { const t = a.effect?.getComputedTiming(); return !t || t.iterations === Infinity || !Number.isFinite(t.endTime as number); }).length)).toBe(0);
  });
});

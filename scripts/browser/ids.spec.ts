// T-88: references by note id and who stewards a node. The fixture stores node `parent`, task `node` and node `brief` as ids (the root
// task as a path, so both forms mix), adds an `Areas/Boulder` area whose room the metadata still calls #civics (found by its channel id),
// and a Boulder project with no room of its own.
import { mkdir } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import { bootAreas, focusSheet, openAreaPage, openAreasHome, openDetails } from './areasFixture';

const SHOTS = 'scripts/browser/__shots__/t88';
const calls = (page: Page, cmd: string) => page.evaluate((c) => (window as any).__calls.filter((x: any) => x.cmd === c).map((x: any) => x.args), cmd);
const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const shot = async (page: Page, name: string) => {
  await mkdir(SHOTS, { recursive: true });
  const size = page.viewportSize()!;
  const file = `${SHOTS}/${name}-${size.width}x${size.height}`;
  await page.screenshot({ path: `${file}.png` });
  const tag = await page.addStyleTag({ content: 'html{filter:grayscale(1)}' });
  await page.screenshot({ path: `${file}-gray.png` });
  await tag.evaluate((n) => n.remove());
};
const title = (page: Page) => focusSheet(page).locator('.all-focus-title');
/** T-335: a place is opened from Uni's home (its door, or its parent's details there): from anywhere else (a room in focus, All), go there first. */
const fromHome = async (page: Page) => { if (!(await page.locator('[data-place="front-door"][data-view="places"]').isVisible())) await openAreasHome(page); };
/** Where a place inside another is reached: its parent's details ("Inside X"). */
const PARENT: Record<string, string> = { 'COhere 2026': 'Techne', 'Boulder Civic Calendar': 'Boulder' };
/** Open a node's room (T-335: in focus over All; an area from its door, a place inside it from the area's details). */
async function open(page: Page, name: string) {
  await fromHome(page);
  await openAreaPage(page, name, { app: false, parent: PARENT[name] });
  await expect(title(page)).toHaveText(name);
}
/** The node's work view ("All of X's work", T-335: from the room's details, inside its focus). */
async function work(page: Page) {
  await openDetails(page);
  await focusSheet(page).getByRole('button', { name: /^All of .*'s work/ }).click();
  await expect(page.locator('.fx-work section[aria-label="Needs you"]')).toBeVisible();
}
/** Every live task the work view holds: Needs you, what others hold (In motion) and Later. */
const total = async (page: Page) => page.locator('.fx-work').evaluate((w) => {
  const n = (sel: string) => Number(w.querySelector(sel)?.textContent ?? 0);
  return String(n('section[aria-label="Needs you"] .wv-n') + w.querySelectorAll('.wv-others > .cp-item').length + n('section[aria-label="Later"] .wv-n'));
});

for (const nearOff of [false, true]) {
  test.describe(`ids${nearOff ? ' (two-query fallback)' : ''}`, () => {
    test.beforeEach(async ({ page }) => { await bootAreas(page, 'seed', { briefs: true, tree: true, tasks: true, ids: true, boulder: true, nearOff, pinned: true }); });

    // T-302: Uni's own level (every area's work at once) went with the Uni room as home; the areas' counts are the check now
    test('the tree and the counts are the same with ids as with paths', async ({ page }) => {
      await open(page, 'Techne');
      await work(page);
      await expect.poll(() => total(page)).toBe('7');
      await open(page, 'COhere 2026');
      await work(page);
      await expect.poll(() => total(page)).toBe('4');
      // the Brief named by id is the one shown
      await expect(page.getByText('Venue is held for Oct 15')).toBeVisible();
      expect(await fits(page)).toBe(true);
    });

    test('r12: the whole tree\'s tasks are one read at the root (no per-node subtree query), with ids or paths', async ({ page }) => {
      await open(page, 'Techne');
      await work(page);
      await expect.poll(() => total(page)).toBe('7');
      expect(await calls(page, 'vault_subtree_tasks')).toEqual([]);
      for (const a of await calls(page, 'vault_query_meta')) expect(a.metadata.node).toBeUndefined();
    });
  });
}

test.describe('stewardship', () => {
  test.beforeEach(async ({ page }) => { await bootAreas(page, 'seed', { briefs: true, tree: true, tasks: true, ids: true, boulder: true, pinned: true }); });
  // T-335: the room header that named the room is gone; the composer still names the room it writes to
  const composer = (page: Page) => focusSheet(page).locator('.sr-chat').getByRole('textbox', { name: /^Message / });

  test('Boulder is found by channel id although the metadata says #civics', async ({ page }) => {
    await open(page, 'Boulder');
    await expect(composer(page)).toHaveAttribute('placeholder', 'Message #boulder');
    // its project is inside it, in its details
    await openDetails(page);
    await expect(focusSheet(page).getByRole('region', { name: 'Inside Boulder' })).toContainText('Boulder Civic Calendar');
    await work(page);
    await expect.poll(() => total(page)).toBe('2');
    await shot(page, 'boulder');
  });

  test('a project with its own room says so', async ({ page }) => {
    await open(page, 'Techne');
    await expect(composer(page)).toHaveAttribute('placeholder', 'Message #Techne');
    await expect(focusSheet(page).locator('.all-focus-line', { hasText: 'no room of its own' })).toHaveCount(0);
    await open(page, 'COhere 2026');
    await expect(composer(page)).toHaveAttribute('placeholder', 'Message #Cohere');
    await expect(focusSheet(page).locator('.all-focus-line', { hasText: 'no room of its own' })).toHaveCount(0);
    await shot(page, 'pilot-own-room');
  });

  test('a project without a room is stewarded by its ancestor, and its tasks open that room', async ({ page }) => {
    await open(page, 'Boulder Civic Calendar');
    // r20 (Codex 6): the node stays the heading; T-335: the room it talks in is the head's one line
    await expect(title(page)).toHaveText('Boulder Civic Calendar');
    await expect(focusSheet(page).locator('.all-focus-line')).toHaveText('Talks in #boulder · no room of its own yet');
    await expect(composer(page)).toHaveAttribute('placeholder', 'Message #boulder');
    // (T-302: "seen from Uni, its task offers its steward's room" went with Uni's own level; from Boulder it is already in that room)
    await shot(page, 'inherited-steward');
  });
});

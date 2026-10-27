// T-88: references by note id and who stewards a node. The fixture stores node `parent`, task `node` and node `brief` as ids (the root
// task as a path, so both forms mix), adds an `Areas/Boulder` area whose room the metadata still calls #civics (found by its channel id),
// and a Boulder project with no room of its own.
import { mkdir } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import { bootAreas, showTree } from './areasFixture';

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
const wide = (page: Page) => (page.viewportSize()?.width ?? 0) >= 900;
const scope = (page: Page) => (wide(page) ? page.locator('.th-roomnav') : page.locator('.th-drawer .th-phone-tree'));
/** Open a node's room from the tree (T-302: the tree is in a room, beside it or in a phone's Places drawer). */
async function open(page: Page, name: string) {
  await showTree(page);
  await scope(page).locator('.th-row.d1').first().waitFor();
  for (let i = 0; i < 12; i++) { const f = scope(page).locator('.th-fold[aria-expanded="false"]'); if (!await f.count()) break; await f.first().click(); }
  await scope(page).locator(`.th-go[aria-label^="${name},"]`).click();
  await expect.poll(async () => [await page.locator('.sr').first().getAttribute('data-node').catch(() => null), await page.locator('.sr-title').first().textContent().catch(() => null)]).toContain(name); /* r15: a borrowed room's heading is the room; the place is data-node */
}
/** The node's work view ("All of X's work", r13: inside the room shell). */
async function work(page: Page) {
  if (!wide(page) && await page.locator('.cp-line[aria-expanded="false"]').count()) await page.locator('.cp-line').click();
  await page.getByRole('button', { name: /^All of .*'s work/ }).click();
  await expect(page.locator('.sr-work section[aria-label="Needs you"]')).toBeVisible();
}
/** Every live task the work view holds: Needs you, what others hold (In motion) and Later. */
const total = async (page: Page) => page.locator('.sr-work').evaluate((w) => {
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
  const door = (page: Page) => page.locator('.sr-door');
  const composer = (page: Page) => page.locator('.sr-chat').getByRole('textbox', { name: /^Message / });

  test('Boulder is found by channel id although the metadata says #civics', async ({ page }) => {
    await open(page, 'Boulder');
    await expect(door(page)).toHaveText('#boulder');
    await expect(composer(page)).toHaveAttribute('placeholder', 'Message #boulder');
    await work(page);
    await expect.poll(() => total(page)).toBe('2');
    if (wide(page)) await expect(scope(page)).toContainText('Boulder Civic Calendar');
    await shot(page, 'boulder');
  });

  test('a project with its own room says so', async ({ page }) => {
    await open(page, 'Techne');
    await expect(door(page)).toHaveText('#Techne');
    await open(page, 'COhere 2026');
    await expect(door(page)).toHaveText('#Cohere');
    await expect(composer(page)).toHaveAttribute('placeholder', 'Message #Cohere');
    await shot(page, 'pilot-own-room');
  });

  test('a project without a room is stewarded by its ancestor, and its tasks open that room', async ({ page }) => {
    await open(page, 'Boulder Civic Calendar');
    // r15: the real room is the heading; the project is a line under it
    await expect(page.locator('.sr-title')).toHaveText('Boulder Civic Calendar'); // r20 (Codex 6): the node stays the heading
    await expect(page.locator('.sr-context')).toHaveText('Chat in #boulder · no room of its own yet');
    await expect(composer(page)).toHaveAttribute('placeholder', 'Message #boulder');
    // (T-302: "seen from Uni, its task offers its steward's room" went with Uni's own level; from Boulder it is already in that room)
    await shot(page, 'inherited-steward');
  });
});

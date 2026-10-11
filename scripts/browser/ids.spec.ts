// T-88: references by note id and who stewards a node. The fixture stores node `parent`, task `node` and node `brief` as ids (the root
// task as a path, so both forms mix), adds an `Areas/Boulder` area whose room the metadata still calls #civics (found by its channel id),
// and a Boulder project with no room of its own.
import { mkdir } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import { areaCard, bootAreas } from './areasFixture';

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
const heading = (page: Page, name: string) => expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
const open = async (page: Page, name: string) => { await areaCard(page, name).click(); await heading(page, name); await expect(page.locator('.work-head')).toBeVisible(); };

for (const nearOff of [false, true]) {
  test.describe(`ids${nearOff ? ' (two-query fallback)' : ''}`, () => {
    test.beforeEach(async ({ page }) => { await bootAreas(page, 'seed', { briefs: true, tree: true, tasks: true, ids: true, boulder: true, nearOff, pinned: true }); });

    test('the tree and the counts are the same with ids as with paths', async ({ page }) => {
      await expect(page.locator('.work-head .brief-count')).toHaveText('11');
      await expect(areaCard(page, 'Techne')).toHaveAttribute('aria-label', /, 7 open$/);
      await expect(areaCard(page, 'Boulder')).toHaveAttribute('aria-label', /, 2 open$/);
      await shot(page, 'uni');
      await open(page, 'Techne');
      await expect(page.locator('.work-head .brief-count')).toHaveText('7');
      await expect(areaCard(page, 'COhere 2026')).toHaveAttribute('aria-label', /, room #Cohere, 4 open$/);
      await open(page, 'COhere 2026');
      await expect(page.locator('.work-head .brief-count')).toHaveText('4');
      // the Brief named by id is the one shown
      await expect(page.getByText('Venue is held for Oct 15')).toBeVisible();
      expect(await fits(page)).toBe(true);
    });

    test('subtree queries are anchored at the node id (or fall back to ids and paths together)', async ({ page }) => {
      await open(page, 'Techne');
      await expect(page.locator('.work-head .brief-count')).toHaveText('7');
      if (!nearOff) {
        const near = (await calls(page, 'vault_subtree_tasks')).filter((a: any) => a.tag === 'task').at(-1);
        expect(near.root).toBe('a-techne');
      } else {
        const where = (await calls(page, 'vault_query_meta')).filter((a: any) => a.metadata.node).at(-1).metadata.node.in as string[];
        expect(where).toEqual(expect.arrayContaining(['Areas/Techne', 'a-techne', 'Projects/COhere/COhere 2026', 'p-cohere']));
      }
    });
  });
}

test.describe('stewardship', () => {
  test.beforeEach(async ({ page }) => { await bootAreas(page, 'seed', { briefs: true, tree: true, tasks: true, ids: true, boulder: true, pinned: true }); });

  test('Uni names its own room; Boulder is found by channel id although the metadata says #civics', async ({ page }) => {
    await expect(page.locator('.steward')).toHaveText('Room #Uni');
    await open(page, 'Boulder');
    await expect(page.locator('.steward')).toHaveText('Room #boulder');
    await expect(page.locator('.talk-text small')).toContainText('#boulder');
    await expect(page.locator('.work-head .brief-count')).toHaveText('2');
    await expect(areaCard(page, 'Boulder Civic Calendar')).toBeVisible();
    await shot(page, 'boulder');
  });

  test('a project with its own room says so and shows a dot on its arm', async ({ page }) => {
    await open(page, 'Techne');
    await expect(page.locator('.steward')).toHaveText('Room #Techne');
    await expect(areaCard(page, 'COhere 2026').locator('xpath=..').locator('.node-room-dot')).toHaveCount(1);
    await open(page, 'COhere 2026');
    await expect(page.locator('.steward')).toHaveText('Room #Cohere');
    await expect(page.locator('.talk-text small')).toContainText('#Cohere');
    await shot(page, 'pilot-own-room');
  });

  test('a project without a room is stewarded by its ancestor, and its tasks open that room', async ({ page }) => {
    await open(page, 'Boulder');
    await open(page, 'Boulder Civic Calendar');
    await expect(page.locator('.steward')).toHaveText('Stewarded by #boulder');
    await expect(page.locator('.talk-text small')).toContainText('#boulder');
    await expect(page.locator('.node-room-dot')).toHaveCount(0);
    await page.locator('.task-row').filter({ hasText: 'T-91' }).locator('.task-title').click();
    await expect(page.getByRole('button', { name: 'Open in #boulder' })).toBeVisible();
    await page.keyboard.press('Escape');
    await shot(page, 'inherited-steward');
  });
});

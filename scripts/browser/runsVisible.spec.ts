// T-335 runs visible: in the room list and the room's head only. A room with a worker at work says it is moving, with the run's live line;
// a room with a run waiting on you says so in one line, with what it waits for. A tap on either opens the run's note, whose body leads with
// the same words. A run waiting on Uni, or one a later attempt superseded, says nothing here. Made-up world only (areasFixture's `runs`).
// Shots go to $RUNS_SHOTS (default test-results/runsvisible-shots), never into the repo.
// Run: npx playwright test --config playwright.runsvisible.config.ts
import { test, expect, type Page } from '@playwright/test';
import { bootAreas, openPlaces } from './areasFixture';

const SHOTS = process.env.RUNS_SHOTS ?? 'test-results/runsvisible-shots';
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${name}.png` });
const door = (page: Page, area: string) => page.locator('.fd-doors > li').filter({ has: page.locator(`.fd-door[data-path="Areas/${area}"]`) });
const notes = (page: Page) => page.evaluate(() => (window as any).__calls.filter((c: any) => c.cmd === 'vault_note').map((c: any) => c.args.noteRef));

async function boot(page: Page) {
  await bootAreas(page, 'seed', { world: 'unread', glow: true, uniMember: true, runs: true });
  await page.locator('[data-place="front-door"]').waitFor();
  await openPlaces(page);
}

test('the room list says which rooms are moving and which wait on you, and each line opens its run note', async ({ page }) => {
  await boot(page);
  const kiln = door(page, 'Kiln Studio'), north = door(page, 'North Field');
  // moving: the room at work, with its live line (its PROGRESS.md step, not the bare tool)
  await expect(kiln.locator('.fd-run[data-run="moving"]')).toContainText('Sorting the glaze photos into the studio log');
  await expect(kiln.locator('.fd-run[data-run="waiting"]')).toHaveCount(0);
  // waiting on you: one line, with the exact thing it waits for
  await expect(north.locator('.fd-run[data-run="waiting"]')).toHaveText(/Waiting on you.*Pick the gravel colour for the gate path: grey or buff/);
  await expect(north.locator('.fd-run[data-run="moving"]')).toHaveCount(0);
  // a run waiting on Uni, and a superseded one, put nothing in the list
  await expect(door(page, 'Bee Garden').locator('.fd-run')).toHaveCount(0);
  await expect(door(page, 'Choir').locator('.fd-run')).toHaveCount(0);
  // a private area's door never carries its runs' words
  await expect(door(page, 'Sanctum')).toHaveCount(1);
  await expect(door(page, 'Sanctum').locator('.fd-run')).toHaveCount(0);
  await expect(page.getByText('Private words about the practice')).toHaveCount(0);
  // the page stays one column wide on a phone (a long line is cut, never pushes the page sideways)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await north.scrollIntoViewIfNeeded();
  await shot(page, '01-room-list');
  // a tap on the waiting line opens the run's note: heart first, who it waits on and for what
  await north.locator('.fd-run[data-run="waiting"]').click();
  await expect.poll(() => notes(page)).toContain('run-north');
  await expect(page.getByText('Waiting on Aaron:', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('Priced two tonnes from both yards', { exact: false }).first()).toBeVisible();
  await page.waitForTimeout(300);
  await shot(page, '02-waiting-note');
});

test("the room's head carries the run's line, and a tap on it opens the run note", async ({ page }) => {
  await boot(page);
  await page.locator('.fd-door[data-path="Areas/Kiln Studio"]').click();
  const head = page.locator('.all-focus-head');
  await head.waitFor();
  const line = head.locator('.all-focus-line[data-run="moving"] .all-focus-run');
  await expect(line).toContainText('Working: Sorting the glaze photos into the studio log');
  await page.waitForTimeout(300);
  await shot(page, '03-room-head-moving');
  // the line is its own button: the titles' tap (the room's details) doesn't take it
  await line.click();
  await expect.poll(() => notes(page)).toContain('run-kiln');
  await expect(page.getByText('Working now:', { exact: false }).first()).toBeVisible();
  await expect(page.locator('.all-focus[data-view="details"]')).toHaveCount(0);
  await page.waitForTimeout(300);
  await shot(page, '04-moving-note');
});

test("a room waiting on you says so in its head; one waiting on Uni keeps its summary", async ({ page }) => {
  await boot(page);
  await page.locator('.fd-door[data-path="Areas/North Field"]').click();
  await expect(page.locator('.all-focus-line[data-run="waiting"]')).toContainText('Waiting on you: Pick the gravel colour');
  await page.waitForTimeout(300);
  await shot(page, '05-room-head-waiting');
  await page.locator('.all-focus-back').click();
  await openPlaces(page);
  await page.locator('.fd-door[data-path="Areas/Bee Garden"]').click();
  await expect(page.locator('.all-focus-line')).toContainText('summary');
  await expect(page.locator('.all-focus-line[data-run]')).toHaveCount(0);
});

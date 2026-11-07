// T-111 nested rooms: ATLAS → ATLAS (atlas/build), Learn Vibe Build (atlas/teach), Atlas Institute (held by #atlas); no second room list (r12).
// T-335 one surface: the places inside a place are in its details ("Inside <Name>"), each one tap into its own room in focus over All.
// Run: NESTED_TEST_PORT=5681 npx playwright test --config playwright.nested.config.ts
import { mkdir } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import { bootAreas, focusSheet, openDetails } from './areasFixture';

const SHOTS = 'scripts/browser/__shots__/nested';
const BUILD = '7dcea809-25cd-4160-ba99-f0a56386adcb';
const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const shot = async (page: Page, name: string) => {
  await mkdir(SHOTS, { recursive: true });
  const s = page.viewportSize()!;
  await page.screenshot({ path: `${SHOTS}/${name}-${s.width}x${s.height}.png` });
};
const boot = (page: Page, o: Parameters<typeof bootAreas>[2] = {}) => bootAreas(page, 'seed', { briefs: true, tree: true, tasks: true, atlas: true, pinned: true, ...o });

// 0.2 one home: All's stream, its places in the drawer under the head
const home = (page: Page) => page.locator('[data-place="front-door"][data-view="all"]');
const inside = (page: Page) => focusSheet(page).getByRole('region', { name: 'Inside Atlas' });
const place = (page: Page, name: string) => inside(page).locator('.fx-place').filter({ has: page.getByText(name, { exact: true }) });
// pulls the home's drawer down once the rooms are read (before that the places show open, then fold up under the head)
async function openPlaces(page: Page) {
  const pull = home(page).locator('.fd-pull');
  await expect(pull).toBeEnabled();
  if ((await pull.getAttribute('aria-expanded')) !== 'true') await pull.click();
  await expect(home(page).getByRole('region', { name: 'Your places' })).toBeVisible();
}
async function atlasDetails(page: Page) {
  await openPlaces(page);
  await home(page).locator('.fd-door[data-path="Areas/Atlas"]').click();
  await expect(focusSheet(page).locator('.all-focus-title')).toHaveText('Atlas');
  await openDetails(page);
}

test.describe('nested rooms', () => {
  test('Atlas\'s details name the project rooms inside it without doubling, and each one opens its room in focus', async ({ page }) => {
    await boot(page);
    await atlasDetails(page);
    await expect(place(page, 'ATLAS')).toContainText('#atlas/build');
    await expect(place(page, 'ATLAS')).not.toContainText('atlas/atlas');
    await expect(place(page, 'Learn Vibe Build')).toContainText('#atlas/teach');
    // T-124: a node held by an ancestor's room says whose room it talks in
    await expect(place(page, 'Atlas Institute')).toContainText('talks in #atlas');
    await expect(place(page, 'Atlas Institute')).not.toContainText('held by');
    expect(await fits(page)).toBe(true);
    await shot(page, 'tree');
    // a node held by an ancestor's room opens that room's conversation, named for itself, and says whose it is
    await place(page, 'Atlas Institute').click();
    await expect(focusSheet(page).locator('.all-focus-title')).toHaveText('Atlas Institute'); // r20 (Codex 6): the node stays the heading; the room is a line under it
    await expect(focusSheet(page).locator('.all-focus-line')).toHaveText('Talks in #atlas · no room of its own yet');
    await expect(focusSheet(page).getByRole('textbox', { name: /^Message / })).toHaveAttribute('placeholder', 'Message #atlas');
    // a project with its own room: its conversation, in focus
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Uni', exact: true }).click();
    await expect(focusSheet(page)).toHaveCount(0); // home again, out of the focus, before its doors are used
    await atlasDetails(page);
    await place(page, 'ATLAS').click();
    await expect(focusSheet(page).locator('.all-focus-title')).toHaveText('ATLAS');
    await expect(focusSheet(page).getByRole('textbox', { name: /^Message atlas\/build/ })).toBeVisible();
    await shot(page, 'project');
    // "All of X's work" is a view in the same sheet; its back button returns to the details, then the conversation (r13)
    await openDetails(page);
    await focusSheet(page).getByRole('button', { name: /^All of ATLAS's work/ }).click();
    await expect(focusSheet(page).getByRole('region', { name: "ATLAS's work" })).toBeVisible();
    const back = focusSheet(page).locator('.all-focus-back');
    await expect(back).toBeVisible();
    expect((await back.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await back.click();
    await expect(focusSheet(page).getByRole('region', { name: 'ATLAS details' })).toBeVisible();
    await focusSheet(page).locator('.all-focus-back').click();
    await expect(focusSheet(page).getByRole('textbox', { name: /^Message atlas\/build/ })).toBeVisible();
    await expect(page.locator('.all-focus')).toHaveCount(1);
    await shot(page, 'opened');
  });

  test('r12: build and teach are only places inside Atlas (no separate conversation list); a room only a node owns is never an "Other room"', async ({ page }) => {
    await boot(page, { strayRoom: true }); // a room no node owns (#garden-club), so the home has an "Other rooms" list
    await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Rooms', exact: true })).toHaveCount(0);
    await expect(page.locator('.rooms nav .room')).toHaveCount(0);
    await expect(home(page)).toBeVisible();
    await openPlaces(page);
    const others = home(page).locator('.fd-others');
    await others.locator('summary').click();
    await expect(others).toContainText('garden-club');
    for (const t of await others.locator('li').allInnerTexts()) expect(t).not.toMatch(/atlas/i);
    for (const t of await home(page).getByRole('button', { name: /^#/ }).allInnerTexts()) expect(t).not.toMatch(/atlas/i);
    await shot(page, 'list');
  });
});

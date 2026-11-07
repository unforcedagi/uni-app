// T-335: which rooms have something new, at a glance, across every room, and one tap into each: a count on each area's door (its rooms' new
// messages, the rooms inside it too) beside what needs you there, and a line for the rooms outside the doors. Opening a room marks it read,
// so its count clears; a message arriving elsewhere adds one live; the room in focus never counts.
// The fixture's made-up world (`world: 'unread'`). Run: UNREAD_TEST_PORT=5763 npx playwright test --config playwright.unread.config.ts
import { mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { bootAreas } from './areasFixture';

const fx = JSON.parse(readFileSync(new URL('../fixtures/approval-prompts.json', import.meta.url), 'utf8'));
const SHOTS = process.env.UNREAD_SHOTS ?? 'scripts/browser/__shots__/unread';
// Kiln Studio's room has 2 new and its project Glaze Tests' room 1 (naming you); North Field 1; #allotment (no area holds it) 3
const UNREAD = { 'ch-kiln': 2, 'ch-glaze': { n: 1, at: true }, 'ch-north': 1, 'ch-allot': 3 };
const boot = (page: Page) => bootAreas(page, 'seed', { world: 'unread', pinned: true, unread: UNREAD });
const door = (page: Page, area: string) => page.locator(`.fd-door[data-path="Areas/${area}"]`);
const marked = (page: Page) => page.evaluate(() => (window as any).__calls.filter((c: any) => c.cmd === 'mark_read').map((c: any) => c.args.channel));
const prompt = (page: Page, channel: string) => page.evaluate(([c, b]) => (window as any).__arrive(c, 'Uni', b), [channel, fx.prompts.two_answers_30min]);
let n = 0;
const shot = async (page: Page, name: string) => { await mkdir(SHOTS, { recursive: true }); await page.screenshot({ path: `${SHOTS}/${String(++n).padStart(2, '0')}-${name}-${page.viewportSize()!.width}.png` }); };
// T-335 one surface: a room is in focus over All; the tree beside it (and its counts, and the phone's Places drawer with its mark) is gone.
// What is new shows on Uni's home: each door's count (its rooms', the ones inside it too) and the line for the rooms outside the doors.
const focus = (page: Page) => page.getByRole('region', { name: /in focus$/ });
const rail = (page: Page) => page.getByRole('navigation', { name: 'Main navigation' });
/** Uni's home; a phone steps out of the focus first (the rail is hidden under it). */
async function home(page: Page) {
  if (!(await rail(page).getByRole('button', { name: 'Uni', exact: true }).isVisible())) await focus(page).getByRole('button', { name: 'Back to All' }).click();
  await rail(page).getByRole('button', { name: 'Uni', exact: true }).click();
  await page.locator('[data-place="front-door"][data-view="places"]').waitFor();
}
/** A place inside another: its door, its details, then its row under "Inside". */
async function openInside(page: Page, parent: string, name: string) {
  await home(page);
  await door(page, parent).click();
  await focus(page).getByRole('button', { name: /: room details$/ }).click();
  await focus(page).getByRole('region', { name: `Inside ${parent}` }).getByRole('button', { name: new RegExp(name) }).click();
  await expect(focus(page).locator('.all-focus-title')).toHaveText(name);
}

test.describe('unread by room', () => {
  test('the front door shows what is new in each area and in the rooms outside them; opening one clears it', async ({ page }) => {
    n = 0;
    await boot(page);
    await page.locator('[data-place="front-door"]').waitFor();
    // Kiln Studio: its own 2 and Glaze Tests' 1 (which names you); North Field 1; Still Water nothing
    await expect(door(page, 'Kiln Studio')).toHaveAttribute('aria-label', /^Kiln Studio, 3 new, mentions you/);
    await expect(door(page, 'Kiln Studio').locator('.fd-new-n.at')).toHaveText('3 new · @you');
    await expect(door(page, 'North Field').locator('.fd-new-n')).toHaveText('1 new');
    await expect(door(page, 'Still Water').locator('.fd-marks')).toHaveCount(0);
    const other = page.getByRole('region', { name: 'New in other rooms' });
    await expect(other.getByRole('button')).toHaveText(['#allotment3']);
    await shot(page, 'front-door');

    // one tap from the line into #allotment: its room opens in focus and is marked read, and the line goes
    await other.getByRole('button', { name: '#allotment, 3 new' }).click();
    await expect(focus(page).locator('.all-focus-title')).toHaveText('#allotment');
    await expect.poll(() => marked(page)).toContain('ch-allot');
    await home(page);
    await expect(page.getByRole('region', { name: 'New in other rooms' })).toHaveCount(0);

    // into Kiln Studio: its own room clears; Glaze Tests' message (inside, naming you) still shows on the door after
    await door(page, 'Kiln Studio').click();
    await expect.poll(() => marked(page)).toContain('ch-kiln');
    await shot(page, 'in-kiln');
    await home(page);
    await expect(door(page, 'Kiln Studio').locator('.fd-new-n')).toHaveText('1 new · @you');
    await expect(door(page, 'Kiln Studio')).toHaveAttribute('aria-label', /^Kiln Studio, 1 new, mentions you/);
    await shot(page, 'front-door-after');
  });

  test('a message elsewhere adds to that room live; reading it clears it; the room on screen never counts', async ({ page }) => {
    n = 10;
    await boot(page);
    await page.locator('[data-place="front-door"]').waitFor();
    await door(page, 'North Field').click();
    await expect.poll(() => marked(page)).toContain('ch-north');
    await home(page);
    await expect(door(page, 'North Field').locator('.fd-new-n')).toHaveCount(0);
    await expect(door(page, 'Kiln Studio').locator('.fd-new-n')).toHaveText('3 new · @you');

    // back in North Field, two messages land in Kiln Studio and one in the room on screen: Kiln Studio goes to 5, this room stays clear
    await door(page, 'North Field').click();
    await expect(focus(page).locator('.all-focus-title')).toHaveText('North Field');
    await page.evaluate(() => { const w = window as any; w.__arrive('ch-kiln', 'Uni', 'The glaze order arrived.'); w.__arrive('ch-kiln', 'Rowan', 'Shelf two is free on Friday.'); w.__arrive('ch-north', 'Uni', 'The gate is mended.'); });
    await expect(focus(page)).toContainText('The gate is mended.');
    await page.waitForTimeout(400);
    await home(page);
    await expect(door(page, 'Kiln Studio').locator('.fd-new-n')).toHaveText('5 new · @you');
    await expect(door(page, 'Kiln Studio')).toHaveAttribute('aria-label', /^Kiln Studio, 5 new, mentions you/);
    await expect(door(page, 'North Field').locator('.fd-new-n')).toHaveCount(0);
    await shot(page, 'live-arrival');

    // an approval prompt in #allotment: the line for the rooms outside the doors counts it as new, and the home lists the approval
    await prompt(page, 'ch-allot');
    const other = page.getByRole('region', { name: 'New in other rooms' });
    await expect(other.getByRole('button', { name: '#allotment, 4 new' })).toBeVisible();
    await expect(page.locator('.cp-approval')).toHaveCount(1);
    await shot(page, 'other-rooms');

    // read Kiln Studio from its door: its own room clears (Glaze Tests' one stays); then #allotment
    await door(page, 'Kiln Studio').click();
    await expect.poll(() => marked(page)).toContain('ch-kiln');
    await home(page);
    await expect(door(page, 'Kiln Studio').locator('.fd-new-n')).toHaveText('1 new · @you');
    await other.getByRole('button', { name: '#allotment, 4 new' }).click();
    await expect.poll(() => marked(page)).toContain('ch-allot');
    await home(page);
    await expect(page.getByRole('region', { name: 'New in other rooms' })).toHaveCount(0);
    // the prompt still waits (reading a room doesn't answer it)
    await expect(page.locator('.cp-approval')).toHaveCount(1);
    // Glaze Tests is the last room with something new; reading it leaves nothing new anywhere
    await openInside(page, 'Kiln Studio', 'Glaze Tests');
    await expect.poll(() => marked(page)).toContain('ch-glaze');
    await home(page);
    await expect(page.locator('.fd-doors .fd-new-n')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'New in other rooms' })).toHaveCount(0);
    await shot(page, 'all-read');
  });

  test("a door's needs-you count is what its room's Needs you lists: a project's own room's prompt is in the project's details, not the door", async ({ page }) => {
    n = 30;
    await boot(page);
    await page.locator('[data-place="front-door"]').waitFor();
    await prompt(page, 'ch-glaze');
    await expect(page.locator('.cp-approval')).toHaveCount(1);
    await expect(door(page, 'Kiln Studio').locator('.fd-need-n')).toHaveCount(0);
    await prompt(page, 'ch-kiln');
    await expect(door(page, 'Kiln Studio').locator('.fd-need-n')).toHaveText('1 for you');
    await shot(page, 'door-needs');
    // in Kiln Studio's details, its Needs you holds its own room's prompt; Glaze Tests' details hold the other
    await door(page, 'Kiln Studio').click();
    await focus(page).getByRole('button', { name: /: room details$/ }).click();
    const details = focus(page).getByRole('region', { name: /details$/ });
    await expect(details.locator('.cp-approval')).toHaveCount(1);
    await openInside(page, 'Kiln Studio', 'Glaze Tests');
    await focus(page).getByRole('button', { name: /: room details$/ }).click();
    await expect(details.locator('.cp-approval')).toHaveCount(1);
  });
});

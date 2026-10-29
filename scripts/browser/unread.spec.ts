// T-335: which rooms have something new, at a glance, across every room, and one tap into each: a count on each area's door (its rooms' new
// messages) beside what needs you there, a line for the rooms outside the doors, a count on every row of the room tree (filled when a message
// names you), and a mark on the phone's Places button. Opening a room marks it read, so its count clears; a message arriving elsewhere adds one live.
// The fixture's made-up world (`world: 'unread'`). Run: UNREAD_TEST_PORT=5763 npx playwright test --config playwright.unread.config.ts
import { mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { bootAreas } from './areasFixture';

const fx = JSON.parse(readFileSync(new URL('../fixtures/approval-prompts.json', import.meta.url), 'utf8'));
const GLAZE = 'Projects/Glaze Tests';
const SHOTS = process.env.UNREAD_SHOTS ?? 'scripts/browser/__shots__/unread';
const wide = (page: Page) => (page.viewportSize()?.width ?? 0) >= 900;
// Kiln Studio's room has 2 new and its project Glaze Tests' room 1 (naming you); North Field 1; #allotment (no area holds it) 3
const UNREAD = { 'ch-kiln': 2, 'ch-glaze': { n: 1, at: true }, 'ch-north': 1, 'ch-allot': 3 };
const boot = (page: Page) => bootAreas(page, 'seed', { world: 'unread', pinned: true, unread: UNREAD });
const door = (page: Page, area: string) => page.locator(`.fd-door[data-path="Areas/${area}"]`);
const tree = (page: Page) => page.locator(wide(page) ? '.th-roomnav' : '.th-drawer .th-phone-tree');
const row = (page: Page, path: string) => tree(page).locator(`.th-go[data-path="${path}"]`).first();
const roomRow = (page: Page, id: string) => tree(page).locator(`.th-go[data-room="${id}"]`);
const marked = (page: Page) => page.evaluate(() => (window as any).__calls.filter((c: any) => c.cmd === 'mark_read').map((c: any) => c.args.channel));
const prompt = (page: Page, channel: string) => page.evaluate(([c, b]) => (window as any).__arrive(c, 'Uni', b), [channel, fx.prompts.two_answers_30min]);
let n = 0;
const shot = async (page: Page, name: string) => { await mkdir(SHOTS, { recursive: true }); await page.screenshot({ path: `${SHOTS}/${String(++n).padStart(2, '0')}-${name}-${page.viewportSize()!.width}.png` }); };
/** On a phone the tree is in the Places drawer. */
async function places(page: Page) { if (!wide(page) && !(await page.locator('.th-drawer').isVisible())) await page.locator('.sr-drawer').click(); await tree(page).waitFor(); }
async function unfold(page: Page) { for (let i = 0; i < 8; i++) { const f = tree(page).locator('.th-fold[aria-expanded="false"]'); if (!(await f.count())) return; await f.first().click(); } }
async function home(page: Page) {
  if (!wide(page) && (await page.locator('.th-drawer').isVisible())) await page.keyboard.press('Escape');
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Uni', exact: true }).click();
  await page.locator('[data-place="front-door"]').waitFor();
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

    // one tap from the line into #allotment: its room opens and is marked read, and the line goes
    await other.getByRole('button', { name: '#allotment, 3 new' }).click();
    await expect(page.locator('.sr-title').first()).toHaveText('#allotment');
    await expect.poll(() => marked(page)).toContain('ch-allot');
    await home(page);
    await expect(page.getByRole('region', { name: 'New in other rooms' })).toHaveCount(0);

    // into Kiln Studio: its own room clears; Glaze Tests' message (inside, naming you) still shows on the door after
    await door(page, 'Kiln Studio').click();
    await expect.poll(() => marked(page)).toContain('ch-kiln');
    await places(page); await unfold(page);
    await expect(row(page, GLAZE)).toHaveAttribute('aria-label', /1 new, mentions you$/);
    await expect(row(page, GLAZE).locator('.th-new.at')).toHaveText('1');
    await expect(row(page, 'Areas/Kiln Studio').locator('.th-new')).toHaveCount(0);
    await shot(page, 'in-kiln');
    await home(page);
    await expect(door(page, 'Kiln Studio').locator('.fd-new-n')).toHaveText('1 new · @you');
    await shot(page, 'front-door-after');
  });

  test('a message elsewhere adds to that room live; reading it clears it; the room on screen never counts', async ({ page }) => {
    n = 10;
    await boot(page);
    await page.locator('[data-place="front-door"]').waitFor();
    await door(page, 'North Field').click();
    await expect.poll(() => marked(page)).toContain('ch-north');
    // the phone's Places button says another room has something new
    // its words are for a screen reader only: never drawn over the room's header
    if (!wide(page)) { await expect(page.locator('.sr-drawer')).toHaveAccessibleDescription('New messages in other rooms'); await expect(page.locator('#sr-drawer-new')).toBeHidden(); await expect(page.locator('.sr-drawer-new')).toBeVisible(); await shot(page, 'places-mark'); }
    await places(page); await unfold(page);
    await expect(row(page, 'Areas/North Field').locator('.th-new')).toHaveCount(0);
    await expect(row(page, 'Areas/Kiln Studio').locator('.th-new')).toHaveText('2');

    // two messages land in Kiln Studio and one in the room on screen: Kiln Studio goes to 4, this room stays clear
    await page.evaluate(() => { const w = window as any; w.__arrive('ch-kiln', 'Uni', 'The glaze order arrived.'); w.__arrive('ch-kiln', 'Rowan', 'Shelf two is free on Friday.'); w.__arrive('ch-north', 'Uni', 'The gate is mended.'); });
    await expect(row(page, 'Areas/Kiln Studio').locator('.th-new')).toHaveText('4');
    await expect(row(page, 'Areas/Kiln Studio')).toHaveAttribute('aria-label', /, 4 new$/);
    await page.waitForTimeout(400);
    await expect(row(page, 'Areas/North Field').locator('.th-new')).toHaveCount(0);
    await shot(page, 'live-arrival');

    // an approval prompt in #allotment needs you: the room carries the needs-you dot beside its count
    await prompt(page, 'ch-allot');
    const others = tree(page).locator('.th-others-go');
    // folded, "Other rooms" carries what is inside it; open, each room its own
    if ((await tree(page).locator('.th-fold[data-path="~other-rooms"]').getAttribute('aria-expanded')) === 'true') await others.click();
    await expect(others).toHaveAttribute('aria-label', /something inside needs you, 4 new inside$/);
    await expect(others.locator('.th-new.inside')).toHaveText('4');
    await shot(page, 'other-rooms-folded');
    await others.click();
    await expect(roomRow(page, 'ch-allot')).toHaveAttribute('aria-label', /1 needs you, 4 new$/);
    await expect(roomRow(page, 'ch-allot').locator('.th-dot')).toBeVisible();
    await shot(page, 'other-rooms');

    // read Kiln Studio from the tree: it clears; then #allotment
    await row(page, 'Areas/Kiln Studio').click();
    await expect.poll(() => marked(page)).toContain('ch-kiln');
    await places(page);
    await expect(row(page, 'Areas/Kiln Studio').locator('.th-new')).toHaveCount(0);
    await roomRow(page, 'ch-allot').click();
    await expect.poll(() => marked(page)).toContain('ch-allot');
    await places(page);
    await expect(roomRow(page, 'ch-allot').locator('.th-new')).toHaveCount(0);
    // the prompt still needs you (reading a room doesn't answer it)
    await expect(roomRow(page, 'ch-allot').locator('.th-dot')).toBeVisible();
    // Glaze Tests is the last room with something new; reading it leaves nothing, and the Places mark goes
    await row(page, GLAZE).click();
    await expect.poll(() => marked(page)).toContain('ch-glaze');
    if (!wide(page)) { await expect(page.locator('.sr-drawer-new')).toHaveCount(0); await expect(page.locator('.sr-drawer')).not.toHaveAccessibleDescription(/other rooms/); }
    await places(page);
    await expect(tree(page).locator('.th-new')).toHaveCount(0);
    await shot(page, 'all-read');
  });

  test("a door's needs-you count is what its room's Needs you lists: a project's own room's prompt is on the project's row, not the door", async ({ page }) => {
    n = 30;
    await boot(page);
    await page.locator('[data-place="front-door"]').waitFor();
    await prompt(page, 'ch-glaze');
    await expect(page.locator('.cp-approval')).toHaveCount(1);
    await expect(door(page, 'Kiln Studio').locator('.fd-need-n')).toHaveCount(0);
    await prompt(page, 'ch-kiln');
    await expect(door(page, 'Kiln Studio').locator('.fd-need-n')).toHaveText('1 for you');
    await shot(page, 'door-needs');
    // in Kiln Studio, its Needs you holds its own room's prompt; the tree puts the other on Glaze Tests' row
    await door(page, 'Kiln Studio').click();
    await places(page); await unfold(page);
    await expect(row(page, GLAZE)).toHaveAttribute('aria-label', /1 needs you/);
    await expect(row(page, 'Areas/Kiln Studio')).toHaveAttribute('aria-label', /1 needs you/);
  });
});

// T-335: which rooms have something new, at a glance, across every room, and one tap into each: a count on each area's door (its rooms' new
// messages) beside what needs you there, a line for the rooms outside the doors, a count on every row of the room tree (filled when a message
// names you), and a mark on the phone's Places button. Opening a room marks it read, so its count clears; a message arriving elsewhere adds one live.
// Rooms and messages are the fixture's made-up ones. Run: UNREAD_TEST_PORT=5763 npx playwright test --config playwright.unread.config.ts
import { mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { bootAreas } from './areasFixture';

const fx = JSON.parse(readFileSync(new URL('../fixtures/approval-prompts.json', import.meta.url), 'utf8'));
const C26 = 'Projects/COhere/COhere 2026';
const SHOTS = process.env.UNREAD_SHOTS ?? 'scripts/browser/__shots__/unread';
const wide = (page: Page) => (page.viewportSize()?.width ?? 0) >= 900;
// Techne's room has 2 new and its project COhere's room 1 (naming you); Unforced Dev 1; the unfiled #garden-club 3
const UNREAD = { 'ch-techne': 2, 'ch-cohere': { n: 1, at: true }, 'ch-unf': 1, 'ch-garden': 3 };
const boot = (page: Page) => bootAreas(page, 'seed', { tree: true, tasks: true, strayRoom: true, pinned: true, unread: UNREAD });
const door = (page: Page, area: string) => page.locator(`.fd-door[data-path="Areas/${area}"]`);
const tree = (page: Page) => page.locator(wide(page) ? '.th-roomnav' : '.th-drawer .th-phone-tree');
const row = (page: Page, path: string) => tree(page).locator(`.th-go[data-path="${path}"]`).first();
const roomRow = (page: Page, id: string) => tree(page).locator(`.th-go[data-room="${id}"]`);
const marked = (page: Page) => page.evaluate(() => (window as any).__calls.filter((c: any) => c.cmd === 'mark_read').map((c: any) => c.args.channel));
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
    // Techne: its own 2 and COhere's 1 (which names you), and what needs you there; Unforced Development 1; Atlas nothing
    await expect(door(page, 'Techne')).toHaveAttribute('aria-label', /^Techne, 3 new, mentions you, \d+ needs? you/);
    await expect(door(page, 'Techne').locator('.fd-new-n.at')).toHaveText('3 new · @you');
    await expect(door(page, 'Techne').locator('.fd-need-n')).toBeVisible();
    await expect(door(page, 'Unforced Development').locator('.fd-new-n')).toHaveText('1 new');
    await expect(door(page, 'Atlas').locator('.fd-marks')).toHaveCount(0);
    const other = page.getByRole('region', { name: 'New in other rooms' });
    await expect(other.getByRole('button')).toHaveText(['#garden-club3']);
    await shot(page, 'front-door');

    // one tap from the line into #garden-club: its room opens and is marked read, and the line goes
    await other.getByRole('button', { name: '#garden-club, 3 new' }).click();
    await expect(page.locator('.sr-title').first()).toHaveText('#garden-club');
    await expect.poll(() => marked(page)).toContain('ch-garden');
    await home(page);
    await expect(page.getByRole('region', { name: 'New in other rooms' })).toHaveCount(0);

    // into Techne: its own room clears; COhere's message (inside, naming you) still shows on the door after
    await door(page, 'Techne').click();
    await expect.poll(() => marked(page)).toContain('ch-techne');
    await places(page); await unfold(page);
    await expect(row(page, C26)).toHaveAttribute('aria-label', /1 new, mentions you$/);
    await expect(row(page, C26).locator('.th-new.at')).toHaveText('1');
    await expect(row(page, 'Areas/Techne').locator('.th-new')).toHaveCount(0);
    await shot(page, 'in-techne');
    await home(page);
    await expect(door(page, 'Techne').locator('.fd-new-n')).toHaveText('1 new · @you');
    await shot(page, 'front-door-after');
  });

  test('a message elsewhere adds to that room live; reading it clears it; the room on screen never counts', async ({ page }) => {
    n = 10;
    await boot(page);
    await page.locator('[data-place="front-door"]').waitFor();
    await door(page, 'Unforced Development').click();
    await expect.poll(() => marked(page)).toContain('ch-unf');
    // the phone's Places button says another room has something new
    if (!wide(page)) await expect(page.locator('.sr-drawer')).toHaveAccessibleDescription('New messages in other rooms');
    await places(page); await unfold(page);
    await expect(row(page, 'Areas/Unforced Development').locator('.th-new')).toHaveCount(0);
    await expect(row(page, 'Areas/Techne').locator('.th-new')).toHaveText('2');

    // two messages land in Techne and one in the room on screen: Techne goes to 4, this room stays clear
    await page.evaluate(() => { const w = window as any; w.__arrive('ch-techne', 'Uni', 'The second draft of the poster is up.'); w.__arrive('ch-techne', 'Priya', 'Print run is booked for Friday.'); w.__arrive('ch-unf', 'Uni', 'The proposal went out.'); });
    await expect(row(page, 'Areas/Techne').locator('.th-new')).toHaveText('4');
    await expect(row(page, 'Areas/Techne')).toHaveAttribute('aria-label', /, 4 new$/);
    await page.waitForTimeout(400);
    await expect(row(page, 'Areas/Unforced Development').locator('.th-new')).toHaveCount(0);
    // "Other rooms" is folded: its count is what is inside it
    await shot(page, 'live-arrival');

    // an approval prompt in #garden-club needs you: the room carries the needs-you dot beside its count
    await page.evaluate((b) => (window as any).__arrive('ch-garden', 'Uni', b), fx.prompts.two_answers_30min);
    const others = tree(page).locator('.th-others-go');
    // folded, "Other rooms" carries what is inside it; open, each room its own
    if ((await tree(page).locator(`.th-fold[data-path="~other-rooms"]`).getAttribute('aria-expanded')) === 'true') await others.click();
    await expect(others).toHaveAttribute('aria-label', /something inside needs you, 4 new inside$/);
    await expect(others.locator('.th-new.inside')).toHaveText('4');
    await shot(page, 'other-rooms-folded');
    await others.click();
    await expect(roomRow(page, 'ch-garden')).toHaveAttribute('aria-label', /1 needs you, 4 new$/);
    await expect(roomRow(page, 'ch-garden').locator('.th-dot')).toBeVisible();
    await shot(page, 'other-rooms');

    // read Techne from the tree: it clears; then #garden-club
    await row(page, 'Areas/Techne').click();
    await expect.poll(() => marked(page)).toContain('ch-techne');
    await places(page);
    await expect(row(page, 'Areas/Techne').locator('.th-new')).toHaveCount(0);
    await roomRow(page, 'ch-garden').click();
    await expect.poll(() => marked(page)).toContain('ch-garden');
    await places(page);
    await expect(roomRow(page, 'ch-garden').locator('.th-new')).toHaveCount(0);
    // the prompt still needs you (reading a room doesn't answer it)
    await expect(roomRow(page, 'ch-garden').locator('.th-dot')).toBeVisible();
    // COhere is the last room with something new; reading it leaves nothing, and the Places mark goes
    await row(page, C26).click();
    await expect.poll(() => marked(page)).toContain('ch-cohere');
    if (!wide(page)) { await expect(page.locator('.sr-drawer-new')).toHaveCount(0); await expect(page.locator('.sr-drawer')).not.toHaveAccessibleDescription(/other rooms/); }
    await places(page);
    await expect(tree(page).locator('.th-new')).toHaveCount(0);
    await shot(page, 'all-read');
  });
});

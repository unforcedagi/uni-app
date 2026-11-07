// 0.2.2: an ask acts in its own room. Every action from an ask (its Needs-you row in the home's drawer, its row in a room's details, its sheet's
// "Say it in #room", "Ask #room for the message", "Ask Uni to draft it") opens the ask's room (its `room`, else its node's) in focus with the
// words ready, and never the home composer's "Choose a room". The live relay has no #Uni (archived 10-26): `noUniRoom` is that world.
// Run: ASKROOM_TEST_PORT=5793 npx playwright test --config playwright.askroom.config.ts
import { test, expect, type Page } from '@playwright/test';
import { bootAreas, focusSheet, openAreasHome, openDetails, openPlaces } from './areasFixture';

const base = { briefs: true, tree: true, tasks: true, atlas: true, steer: true, pinned: true } as const;
const calls = (page: Page, cmd: string) => page.evaluate((c) => (window as any).__calls.filter((x: any) => x.cmd === c).map((x: any) => x.args), cmd);
const taskDialog = (page: Page) => page.getByRole('dialog').filter({ has: page.locator('.task-kind') });
/** A made-up ask, as a room writes it: owned by the person, filed on `node`, said in `room`. */
async function ask(page: Page, node: string, room: string | null, next: string, title = 'T-901 Turn on the tap cards') {
  await page.evaluate(([n, r, x, t]) => { const w = window as any; const k = w.__tasks.find((y: any) => /FY-14/.test(y.path)); w.__setTask(k.id, { node: n, room: r, priority: 'now', next: x }, t); }, [node, room, next, title] as const);
  await page.clock.setFixedTime(Date.parse('2026-10-09T10:01:00.000Z'));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
}
/** The home, its drawer pulled down (the app may have opened elsewhere). */
async function home(page: Page) {
  await page.locator('[data-place="front-door"], .all-focus').first().waitFor();
  if (await focusSheet(page).count()) await openAreasHome(page);
  await openPlaces(page);
}
const needRow = (page: Page) => page.getByRole('region', { name: 'Your places' }).locator('.fd-needs-list button', { hasText: 'Turn on the tap cards' });
/** Nothing went out, and the home composer was never asked to pick a room. */
async function nothingSent(page: Page) {
  expect(await calls(page, 'post_message')).toHaveLength(0);
  await expect(page.getByText(/Choose a room|Pick a room/)).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__allHeld?.text ?? '')).toBe('');
}

for (const noUniRoom of [false, true]) test.describe(noUniRoom ? 'no #Uni' : 'with #Uni', () => {
  test('a Needs-you row in the drawer opens the ask in its own room, not its node\'s, and "Say it" fills that room\'s composer', async ({ page }) => {
    await bootAreas(page, 'seed', { ...base, noUniRoom });
    await ask(page, 'Areas/Unforced Development', 'techne', 'Say "approve cards" in #techne');
    await home(page);
    await needRow(page).click();
    await expect(focusSheet(page).locator('.all-focus-title')).toHaveText('Techne');
    const sheet = taskDialog(page);
    await expect(sheet.locator('.task-do.primary')).toHaveText('Say it in #Techne ›');
    await sheet.locator('.task-do.primary').click();
    await expect(taskDialog(page)).toHaveCount(0);
    await expect(focusSheet(page).locator('.sr-chat textarea')).toHaveValue('approve cards');
    await nothingSent(page);
  });

  test('an ask filed at the top (no room of its own there) still opens in its room: the row is never dead', async ({ page }) => {
    await bootAreas(page, 'seed', { ...base, noUniRoom });
    await ask(page, 'Uni', 'techne', 'Say "approve cards" in #techne');
    await home(page);
    await needRow(page).click();
    await expect(focusSheet(page).locator('.all-focus-title')).toHaveText('Techne');
    await taskDialog(page).locator('.task-do', { hasText: 'Say it in #Techne' }).click();
    await expect(focusSheet(page).locator('.sr-chat textarea')).toHaveValue('approve cards');
    await nothingSent(page);
  });

  test('in a room\'s details, an ask said in another room acts in that room', async ({ page }) => {
    await bootAreas(page, 'seed', { ...base, noUniRoom });
    await ask(page, 'Areas/Unforced Development', 'techne', 'Say "approve cards" in #techne');
    await home(page);
    await page.locator('.fd-door[data-path="Areas/Unforced Development"]').click();
    await expect(focusSheet(page).locator('.all-focus-title')).toHaveText('Unforced Development');
    await openDetails(page);
    await focusSheet(page).locator('.cp-item', { hasText: /approve cards/i }).locator('.cp-need').click();
    const sheet = taskDialog(page);
    await expect(sheet.locator('.task-do.primary')).toHaveText('Say it in #Techne ›');
    await sheet.locator('.task-do.primary').click();
    await expect(focusSheet(page).locator('.all-focus-title')).toHaveText('Techne');
    await expect(focusSheet(page).locator('.sr-chat textarea')).toHaveValue('approve cards');
    await nothingSent(page);
  });

  test('an ask worded "In #room, tap the card" opens with that room in focus behind its sheet (the card is there)', async ({ page }) => {
    await bootAreas(page, 'seed', { ...base, noUniRoom });
    await ask(page, 'Uni', 'techne', 'In #techne, tap the card. If it has expired, say "approve cards" there.');
    await home(page);
    await needRow(page).click();
    await expect(focusSheet(page).locator('.all-focus-title')).toHaveText('Techne');
    await expect(taskDialog(page).locator('.task-kind')).toHaveText(/in #Techne/);
    await nothingSent(page);
  });

  test('"Ask Uni to draft it" asks in the ask\'s own room', async ({ page }) => {
    await bootAreas(page, 'seed', { ...base, noUniRoom });
    await ask(page, 'Areas/Unforced Development', 'techne', 'Email Casey Rowe about the venue deposit');
    await home(page);
    await needRow(page).click();
    await expect(focusSheet(page).locator('.all-focus-title')).toHaveText('Techne');
    const sheet = taskDialog(page);
    await expect(sheet.locator('.task-do.primary')).toHaveText(/draft/i);
    await sheet.locator('.task-do.primary').click();
    await expect(focusSheet(page).locator('.all-focus-title')).toHaveText('Techne');
    await expect(focusSheet(page).locator('.sr-chat textarea')).toHaveValue(/^Please draft the message for T-901/);
    await nothingSent(page);
  });
});

test('an ask with no room anywhere opens its sheet over the home, and offers no room it wasn\'t given', async ({ page }) => {
  await bootAreas(page, 'seed', { ...base, noUniRoom: true });
  await ask(page, 'Uni', null, 'Say "approve cards"');
  await home(page);
  await needRow(page).click();
  const sheet = taskDialog(page);
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('button', { name: /^Say it in/ })).toHaveCount(0);
  await expect(focusSheet(page)).toHaveCount(0);
  await nothingSent(page);
});

test('with #Uni archived the app opens on the home, not in the first room', async ({ page }) => {
  await bootAreas(page, 'seed', { ...base, noUniRoom: true });
  await expect(page.locator('[data-place="front-door"]:not(.all-empty)')).toBeVisible();
  await page.waitForTimeout(800);
  await expect(focusSheet(page)).toHaveCount(0);
});

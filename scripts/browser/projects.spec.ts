// T-301: the prototype played as a person would: the front door, a room with its projects, a project opened in place, and its sessions
// started, stopped and retired. Runs the real app against the prototype's made-up world (no native side, nothing leaves the page).
import { expect, test, type Page } from '@playwright/test';

const shot = (page: Page, name: string) => page.screenshot({ path: `__shots__/t301/${test.info().project.name}-${name}.png` });
const rail = (page: Page) => page.getByRole('navigation', { name: 'Main navigation' });
const door = (page: Page, name: string) => page.getByRole('navigation', { name: 'Rooms' }).getByRole('button', { name: new RegExp(`^${name}\\b`) });
const strip = (page: Page) => page.locator('[data-proto="project-strip"]');
const sheet = (page: Page) => page.getByRole('dialog', { name: /co-op site|Mail move/ });

async function openWorkshop(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Uni', level: 1 })).toBeVisible();
  await door(page, 'Workshop').click();
  await expect(page.locator('.sr-title')).toHaveText('Workshop');
}

test('the front door shows the seven rooms, each with where it stands and a mark where work is live', async ({ page }) => {
  await page.goto('/');
  const doors = page.getByRole('navigation', { name: 'Rooms' }).locator('.fd-door');
  await expect(doors).toHaveCount(7);
  await expect(door(page, 'Workshop')).toContainText('The co-op site goes to its board Thursday.');
  await expect(door(page, 'Workshop').locator('.fd-live')).toHaveText('1 working');
  await expect(door(page, 'Hearth').locator('.fd-live')).toHaveCount(0);
  // no ids or task numbers anywhere on the front door
  await expect(page.locator('[data-proto="front-door"]')).not.toContainText(/\bT-\d+|demo-|s-events/);
  await shot(page, '01-front-door');
});

test('a room keeps its chat at the heart, with one quiet strip of its projects', async ({ page }) => {
  await openWorkshop(page);
  // the real chat: the room's messages and its composer
  await expect(page.getByText('Keep their own words on the cards, please. No rewriting.')).toBeVisible();
  await expect(page.getByRole('textbox', { name: /workshop/i })).toBeVisible();
  await expect(strip(page).locator('.ps-tab')).toHaveText(['Riverbend co-op site', 'Seed library catalogue']);
  await expect(strip(page).locator('.ps-tab[data-project="coop"] .ps-dot')).toBeVisible();
  await expect(strip(page).locator('.ps-tab[data-project="seeds"] .ps-dot')).toHaveCount(0);
  await shot(page, '02-room');
  // the strip folds to one line that still says what is live, and stays folded
  await strip(page).getByRole('button', { name: /Projects/ }).click();
  await expect(strip(page).locator('.ps-tab')).toHaveCount(0);
  await expect(strip(page)).toContainText('2 · 1 working');
  // a reload reopens the place it was on (the app's rule); from the front door, the room is one tap
  await page.reload();
  await expect(page.locator('.sr-title, .fd-title').first()).toBeVisible();
  if (await page.locator('.fd-title').count()) await door(page, 'Workshop').click();
  await expect(page.locator('.sr-title')).toHaveText('Workshop');
  await expect(strip(page).locator('.ps-tab')).toHaveCount(0);
  await strip(page).getByRole('button', { name: /Projects/ }).click();
  await expect(strip(page).locator('.ps-tab')).toHaveCount(2);
});

test('a project opens in place: its folder, its live session first, the story on tap, and Stop', async ({ page }) => {
  await openWorkshop(page);
  await strip(page).getByRole('button', { name: /Riverbend co-op site/ }).click();
  const s = sheet(page);
  await expect(s).toBeVisible();
  await expect(s.locator('.pj-folder code')).toHaveText('~/work/riverbend-site');
  // the room is still there under it (opened in place, not a new screen)
  await expect(page.locator('.sr-title')).toHaveText('Workshop');
  const cards = s.locator('.pj-session');
  await expect(cards).toHaveCount(3);
  await expect(cards.first()).toHaveAttribute('data-state', 'running');
  await expect(cards.first().locator('.pj-state')).toContainText(/Working · \d+ min/);
  await expect(cards.first().locator('.pj-now')).toContainText('Recording the walkthrough');
  await expect(cards.nth(2).locator('.pj-result')).toHaveText('Shipped to staging. The coordinator liked it.');
  await expect(cards.nth(2).getByRole('link', { name: 'Watch the walkthrough' })).toBeVisible();
  await expect(s.locator('.pj-time .pj-run.live')).toHaveCount(1);
  await cards.first().getByRole('button', { name: 'The story' }).click();
  await expect(cards.first().locator('.pj-story li')).toHaveCount(6);
  await expect(cards.first().locator('.pj-story')).toContainText("Put the co-op's own words back on every card.");
  await shot(page, '03-project');
  await cards.first().getByRole('button', { name: 'Stop' }).click();
  await expect(cards.first()).toHaveAttribute('data-state', 'stopped');
  await expect(cards.first().locator('.pj-state')).toHaveText(/Stopped just now/);
  await expect(s.getByRole('button', { name: 'Stop' })).toHaveCount(0);
  await expect(s.locator('.pj-sessions-head h3')).toHaveText('Sessions');
  // closing goes back to the room; the live mark is gone there and on the front door
  await page.keyboard.press('Escape');
  await expect(s).toHaveCount(0);
  await expect(strip(page).locator('.ps-tab[data-project="coop"] .ps-dot')).toHaveCount(0);
  await rail(page).getByRole('button', { name: 'Uni', exact: true }).click();
  await expect(door(page, 'Workshop').locator('.fd-live')).toHaveCount(0);
  await expect(door(page, 'Engine Room').locator('.fd-live')).toHaveText('1 working');
});

test('start fresh sessions beside a live one, then retire: a live one is stopped as it goes, every one is kept under Retired, and can be brought back', async ({ page }) => {
  await openWorkshop(page);
  await strip(page).getByRole('button', { name: /Riverbend co-op site/ }).click();
  const s = sheet(page);
  await s.getByRole('button', { name: 'Start a fresh session' }).click();
  const ask = s.getByRole('textbox', { name: 'What should it do?' });
  await expect(s.getByRole('button', { name: 'Start', exact: true })).toBeDisabled();
  await ask.fill('Make the donate page say where the money goes.');
  await s.getByRole('button', { name: 'Start', exact: true }).click();
  await s.getByRole('button', { name: 'Start a fresh session' }).click();
  await ask.fill('Check every page on a slow phone.');
  await ask.press('Enter');
  // three live at once, newest first; the seeded live one is untouched
  const live = s.locator('.pj-session[data-state="running"]');
  await expect(live).toHaveCount(3);
  await expect(live.locator('.pj-ask')).toHaveText(['Check every page on a slow phone.', 'Make the donate page say where the money goes.', /^Make the events page/]);
  await expect(s.locator('.pj-sessions-head h3')).toHaveText('Sessions · 3 working');
  await expect(strip(page).locator('.ps-tab[data-project="coop"]')).toContainText('×3');
  await shot(page, '04-three-live');
  // retire a live one: stopped and put away
  await live.first().getByRole('button', { name: 'Retire' }).click();
  await expect(live).toHaveCount(2);
  await expect(s.locator('.pj-retired summary')).toHaveText('Retired · 1');
  // retire a finished one too
  await s.locator('.pj-session[data-state="finished"]').getByRole('button', { name: 'Retire' }).click();
  await expect(s.locator('.pj-session[data-state="finished"]')).toHaveCount(0);
  await s.locator('.pj-retired summary').click();
  await expect(s.locator('.pj-retired li')).toHaveCount(2);
  await expect(s.locator('.pj-retired')).toContainText('Check every page on a slow phone.');
  await shot(page, '05-retired');
  // Bring back undoes a retire: the session is in the list again, stopped
  await s.locator('.pj-retired li', { hasText: 'Check every page on a slow phone.' }).getByRole('button', { name: 'Bring back' }).click();
  await expect(s.locator('.pj-retired summary')).toHaveText('Retired · 1');
  await expect(s.locator('.pj-session', { hasText: 'Check every page on a slow phone.' })).toHaveAttribute('data-state', 'stopped');
});

test('a fresh session works through its steps and finishes; the room hears about it once', async ({ page }) => {
  await page.clock.install();
  await openWorkshop(page);
  await strip(page).getByRole('button', { name: /Seed library catalogue/ }).click();
  const s = page.getByRole('dialog', { name: 'Seed library catalogue' });
  await s.getByRole('button', { name: 'Start a fresh session' }).click();
  await s.getByRole('textbox', { name: 'What should it do?' }).fill('Add a search box to the catalogue.');
  await s.getByRole('button', { name: 'Start', exact: true }).click();
  const card = s.locator('.pj-session').first();
  await expect(card).toHaveAttribute('data-state', 'running');
  await page.clock.runFor(7_500);
  await expect(card.locator('.pj-now')).toContainText('Looking at what is there now.');
  await expect(card.locator('.pj-ticks i')).toHaveCount(2);
  await page.clock.runFor(40_000);
  await expect(card).toHaveAttribute('data-state', 'finished');
  await expect(card.locator('.pj-result')).toContainText('checked on phone and desktop');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByText('Seed library catalogue: a session finished.')).toHaveCount(1);
});

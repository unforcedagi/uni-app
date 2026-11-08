// T-301/T-302: the areas, projects and sessions interface played as a person would, on the real web build of the app: the front door,
// a room with its projects, a project opened in place, and Stop, Fresh start, Add a session and Archive, each a message in the room that
// the room's Uni acts on. The native side is projectsFixture.ts (a made-up vault and rooms in the page; nothing leaves it).
import { expect, test, type Page } from '@playwright/test';
import { bootProjects } from './projectsFixture.ts';
import { focusSheet, openDetails, openPlaces } from './areasFixture.ts';
import { railGo } from './railGo';

const shot = (page: Page, name: string) => page.screenshot({ path: `__shots__/t302/${test.info().project.name}-${name}.png` });
const door = (page: Page, name: string) => page.getByRole('navigation', { name: 'Rooms' }).getByRole('button', { name: new RegExp(`^${name}\\b`) });
const strip = (page: Page) => page.locator('[data-place="project-strip"]');
const sheet = (page: Page) => page.getByRole('dialog', { name: /co-op site|Mail move|Seed library|zine/ });
const posted = (page: Page) => page.evaluate(() => (window as any).__posted as { channel: string; body: string; recipients: string[] }[]);
const NO_IDS = /\bT-\d+|\brun-|\bmts\b|\bp-coop|\bresume\b|zzzzzzzz/;

/** T-335: a door opens its room in focus over All; the room's projects strip is in its details, inside the focus. */
const title = (page: Page) => focusSheet(page).locator('.all-focus-title');
/** 0.2 one home: the doors, what needs you and the Unfiled sessions are in the drawer under the home's head. */
async function places(page: Page) {
  await page.locator('[data-place="front-door"] .fd-pull').waitFor();
  await openPlaces(page);
}
async function enter(page: Page, name: string) {
  await places(page);
  await door(page, name).click();
  await expect(title(page)).toHaveText(name);
}
/** Back from the details to the room's conversation, in the same focus. */
const toChat = (page: Page) => focusSheet(page).getByRole('button', { name: /: back to the conversation$/ }).click();
async function openRoom(page: Page, name = 'Workshop', details = true) {
  await bootProjects(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Uni', level: 1 })).toBeVisible();
  await enter(page, name);
  if (details) await openDetails(page);
}
async function openProject(page: Page, name: RegExp | string) {
  await strip(page).getByRole('button', { name }).first().click();
  await expect(sheet(page)).toBeVisible();
  return sheet(page);
}

test('the front door is Uni: the seven rooms, where each stands, a mark where sessions work; the usage is in Settings', async ({ page }) => {
  await bootProjects(page);
  await page.goto('/');
  await places(page);
  const doors = page.getByRole('navigation', { name: 'Rooms' }).locator('.fd-door');
  await expect(doors).toHaveCount(7);
  await expect(door(page, 'Workshop')).toContainText('The co-op site goes to its board Thursday.');
  await expect(door(page, 'Workshop').locator('.fd-live')).toHaveText('2 working');
  await expect(door(page, 'Engine Room').locator('.fd-live')).toHaveText('1 working');
  await expect(door(page, 'Hearth').locator('.fd-live')).toHaveCount(0);
  // 0.2: the home's usage line is gone; the full card is in Settings
  await expect(page.getByRole('button', { name: /^Claude:/ })).toHaveCount(0);
  await expect(page.locator('[data-place="front-door"]')).not.toContainText(NO_IDS);
  await shot(page, '01-front-door');
  await railGo(page, 'Settings');
  const card = page.getByRole('region', { name: 'Claude accounts' });
  await expect(card.getByRole('heading', { name: 'Claude accounts' })).toBeVisible();
  await expect(card).toContainText('Account B');
  await expect(card.locator('.usage-age')).toHaveText('As of 6 min ago');
  await shot(page, '02-usage');
});

test('0.3.0: what needs you is For you, at the top of the home (the drawer keeps the places); the archived Uni room is no place', async ({ page }) => {
  await bootProjects(page);
  await page.goto('/');
  // the head's one sentence counts it; For you holds it, over the stream, with where it is (no card: its area) and no ids
  await expect(page.locator('[data-place="front-door"] .fd-pull')).toContainText('One thing needs you.');
  const fy = page.getByRole('region', { name: 'For you' });
  const item = fy.locator('article.fy-item', { hasText: 'Choose the photo for the about page' });
  await expect(item.locator('.fy-where')).toHaveText('Workshop');
  await expect(fy).not.toContainText(NO_IDS);
  await shot(page, '01b-needs-you');
  await places(page);
  // the archived Uni room is no place of the home (T-335: the room tree beside a room is gone; the home's doors are the places)
  await expect(door(page, 'Workshop')).toBeVisible();
  await expect(door(page, 'Uni')).toHaveCount(0);
  // the drawer no longer holds a Needs-you list
  await expect(page.getByRole('region', { name: 'Needs you' })).toHaveCount(0);
  await page.locator('[data-place="front-door"] .fd-pull').click();
  await item.locator('.fy-what').click();
  // T-335: its place's room, in focus (0.2.2: with the ask's sheet over it, where its action is said)
  await expect(title(page)).toHaveText('Riverbend co-op site');
  await expect(page.getByRole('dialog').filter({ has: page.locator('.task-kind') })).toContainText('Choose the photo for the about page');
});

test('a room keeps its chat at the heart, with one strip of its projects: archived behind one tab, a missing folder named', async ({ page }) => {
  await openRoom(page, 'Workshop', false);
  await expect(focusSheet(page).getByText('Keep their own words on the cards, please. No rewriting.')).toBeVisible();
  await openDetails(page);
  await expect(strip(page).locator('.ps-tab:not(.ps-more)')).toHaveText(['Riverbend co-op site2', 'Seed library catalogue', 'Co-op kiosk']);
  await expect(strip(page).locator('.ps-tab[data-project="p-coop"] .ps-dot')).toBeVisible();
  await expect(strip(page).locator('.ps-tab[data-project="p-seeds"] .ps-dot')).toHaveCount(0);
  await expect(strip(page)).not.toContainText('Shop signs'); // T-335 as Aaron: said once, under all of the room's work
  // the archived project is behind its tab, and opens the same way
  await strip(page).getByRole('button', { name: 'Archived · 1' }).click();
  await expect(strip(page).getByRole('button', { name: /Old zine archive, archived/ })).toBeVisible();
  await shot(page, '03-room');
  // a project filed in another area never shows here, even with a link to it; the rail's Uni is the way back to the front door
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Uni', exact: true }).click();
  await enter(page, 'Town Hall');
  await openDetails(page);
  await expect(strip(page).locator('.ps-tab')).toHaveText(['Bike lane map']);
});

test('a project opens in place: its folder, its live sessions first with what each is doing, then its history in words', async ({ page }) => {
  await openRoom(page);
  const s = await openProject(page, /Riverbend co-op site/);
  await expect(s.locator('.pj-folder code')).toHaveText('~/work/riverbend-site');
  await expect(title(page)).toHaveText('Workshop');
  const cards = s.locator('.pj-session');
  await expect(cards.nth(0)).toHaveAttribute('data-state', 'running');
  await expect(cards.nth(1)).toHaveAttribute('data-state', 'running');
  await expect(s.getByRole('heading', { name: 'Sessions · 2 working' })).toBeVisible();
  const events = cards.filter({ hasText: 'Make the events page read like a noticeboard' });
  await expect(events).toContainText('Running npx');
  await expect(events.locator('.pj-ticks')).toHaveAttribute('aria-label', '31 steps so far');
  await expect(cards.filter({ hasText: 'Rebuild the about page' })).toContainText('Left ABOUT.md.');
  await expect(cards.filter({ hasText: 'Rebuild the about page' }).getByRole('link', { name: 'Watch the walkthrough' })).toHaveAttribute('href', 'https://example.com/walkthrough/about-page');
  await expect(cards.filter({ has: page.locator('h3', { hasText: 'Try a donate button' }) }).locator('.pj-state')).toContainText(/Stopped/);
  await expect(s).not.toContainText(NO_IDS);
  await shot(page, '04-project');
});

/** The sheet's one "…" menu: pick an item by its words; nothing is posted until Post. */
async function ask(s: ReturnType<typeof sheet>, item: RegExp | string) {
  await s.getByRole('button', { name: 'Actions' }).click();
  await s.getByRole('list', { name: 'Ask the room' }).getByRole('button', { name: item }).click();
}

test('the sheet is for watching: no action buttons on it, each session says why it started, and one quiet menu holds what can be asked', async ({ page }) => {
  await openRoom(page);
  const s = await openProject(page, /Riverbend co-op site/);
  // T-304: a session's line opens it (watching, not an action)
  await expect(s.locator('.pj-session button:not(.pj-open), .pj-row .task-do')).toHaveCount(0);
  const donate = s.locator('.pj-session').filter({ hasText: 'Donate page with a sliding amount' });
  await expect(donate.locator('.pj-why')).toHaveText('A fresh start of “Try a donate button”, with a handoff');
  await expect(s.locator('.pj-session').filter({ hasText: 'Make the events page' }).locator('.pj-why')).toHaveCount(0);
  await expect(s.getByRole('list', { name: 'Ask the room' })).toHaveCount(0);
  await s.getByRole('button', { name: 'Actions' }).click();
  await expect(s.getByRole('list', { name: 'Ask the room' }).getByRole('button')).toHaveText([
    'Stop “Donate page with a sliding amount”', 'Fresh start of “Donate page with a sliding amount”',
    'Stop “Make the events page read like a noticeboard”', 'Fresh start of “Make the events page read like a noticeboard”',
    'Add a session', 'Archive (stops its sessions first)']);
  await shot(page, '04b-menu');
  expect(await posted(page)).toEqual([]);
});

test('Stop asks the room in plain words, shown before it is posted; the room stops it and the session moves to the history', async ({ page }) => {
  await openRoom(page);
  const s = await openProject(page, /Riverbend co-op site/);
  const events = s.locator('.pj-session').filter({ hasText: 'Make the events page read like a noticeboard' });
  await ask(s, /^Stop “Make the events page/);
  const confirm = s.getByRole('group', { name: /Stop: what will be posted/ });
  await expect(confirm).toContainText('Posts in #workshop, as you:');
  await expect(confirm.locator('blockquote')).toHaveText(/^Stop the session on “Make the events page read like a noticeboard” \(started .+\) on Riverbend co-op site\.$/);
  await shot(page, '05-stop-confirm');
  expect(await posted(page)).toEqual([]);
  await confirm.getByRole('button', { name: 'Post' }).click();
  await expect(events.getByRole('status')).toHaveText(/^Asked the room to stop it · /);
  const sent = await posted(page);
  expect(sent).toHaveLength(1);
  expect(sent[0].channel).toBe('demo-workshop');
  expect(sent[0].body).toMatch(/^Stop the session on “Make the events page read like a noticeboard” \(started .+\) on Riverbend co-op site\.$/);
  expect(sent[0].recipients).toEqual(['c'.repeat(64)]);
  expect(sent[0].body).not.toMatch(NO_IDS);
  // the room's Uni stops it; the next read shows it ended, the other session still working
  await expect(events).toHaveAttribute('data-state', 'stopped', { timeout: 15_000 });
  await expect(s.getByRole('heading', { name: 'Sessions · 1 working' })).toBeVisible();
  await shot(page, '06-stopped');
  await page.keyboard.press('Escape');
  await expect(s).toHaveCount(0);
  // the room's Uni says so in the room's conversation
  await toChat(page);
  await expect(focusSheet(page).getByText('Stopped it.')).toBeVisible();
});

test('Add a session runs alongside the ones working, and Fresh start ends one and starts the next with a handoff', async ({ page }) => {
  await openRoom(page);
  const s = await openProject(page, /Riverbend co-op site/);
  await ask(s, 'Add a session');
  await expect(s.getByText('It runs alongside the 2 already working; nothing is stopped.')).toBeVisible();
  await s.getByLabel('What should the new session do?').fill('Print the  poster\nfor Saturday');
  await expect(s.locator('blockquote')).toHaveText('Add a session on Riverbend co-op site, in ~/work/riverbend-site, alongside any already running: Print the poster for Saturday');
  await s.getByRole('button', { name: 'Post' }).click();
  await expect(s.getByRole('status')).toHaveText(/^Asked the room to add a session · /);
  expect((await posted(page))[0].body).toBe('Add a session on Riverbend co-op site, in ~/work/riverbend-site, alongside any already running: Print the poster for Saturday');
  await expect(s.getByRole('heading', { name: 'Sessions · 2 working' })).toBeVisible();
  // Fresh start
  await ask(s, /^Fresh start of “Donate page/);
  await expect(s.locator('blockquote')).toHaveText(/^Fresh start on Riverbend co-op site: end the session on “Donate page with a sliding amount” \(started .+\) and start a new session on the same project, with a short handoff of where it got to\.$/);
  await s.getByRole('button', { name: 'Post' }).click();
  await expect(s.locator('.pj-session[data-state="running"]').filter({ hasText: 'Reading HANDOFF.md' })).toBeVisible({ timeout: 15_000 });
  await expect(s.getByRole('heading', { name: 'Sessions · 2 working' })).toBeVisible();
});

test('Archive is the project\'s: with live sessions it asks to stop them first; it leaves the strip and can be brought back', async ({ page }) => {
  await openRoom(page);
  const s = await openProject(page, /Riverbend co-op site/);
  await ask(s, 'Archive (stops its sessions first)');
  await expect(s.locator('blockquote')).toHaveText('Archive the project Riverbend co-op site. It has 2 live sessions: stop them first. Keep its folder and its history.');
  await s.getByRole('button', { name: 'Post' }).click();
  await expect(s.getByText('· archived')).toBeVisible({ timeout: 15_000 });
  await expect(s.getByRole('heading', { name: 'Sessions' })).toBeVisible();
  await s.getByRole('button', { name: 'Actions' }).click();
  await expect(s.getByRole('list', { name: 'Ask the room' }).getByRole('button')).toHaveText(['Bring back']);
  await page.keyboard.press('Escape');
  await expect(strip(page).getByRole('button', { name: 'Archived · 2' })).toBeVisible();
  await expect(strip(page).locator('.ps-tab[data-project="p-coop"]')).toHaveCount(0);
  await strip(page).getByRole('button', { name: 'Archived · 2' }).click();
  const back = await openProject(page, /Riverbend co-op site, archived/);
  await ask(back, 'Bring back');
  await expect(back.locator('blockquote')).toHaveText('Bring back the project Riverbend co-op site from the archive.');
  await back.getByRole('button', { name: 'Post' }).click();
  await expect(back.getByText('· archived')).toHaveCount(0, { timeout: 15_000 });
  await back.getByRole('button', { name: 'Actions' }).click();
  await expect(back.getByRole('list', { name: 'Ask the room' }).getByRole('button', { name: 'Add a session' })).toBeVisible();
});

test('a session filed on its area but run in a project\'s folder shows under that project', async ({ page }) => {
  await openRoom(page, 'Engine Room');
  const s = await openProject(page, /Mail move/);
  await expect(s.locator('.pj-session[data-state="running"]')).toContainText('Running rsync');
  await expect(s.locator('.pj-ticks')).toHaveAttribute('aria-label', '64 steps so far');
});

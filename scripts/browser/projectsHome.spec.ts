// Every worker has a place to be seen. A run with no project shows under its area (from its node, its task's node or its room), as the
// area's "Other sessions"; one with no area either shows under "Unfiled sessions" on the home. Played as a person would, on the real web
// build with the projects fixture (made-up vault, nothing leaves the page).
import { expect, test, type Page } from '@playwright/test';
import { bootProjects } from './projectsFixture.ts';

const MIN = 60_000;
const door = (page: Page, name: string) => page.getByRole('navigation', { name: 'Rooms' }).getByRole('button', { name: new RegExp(`^${name}\\b`) });
const strip = (page: Page) => page.locator('[data-place="project-strip"]');
const shot = (page: Page, name: string) => page.screenshot({ path: `__shots__/sessions-home/${test.info().project.name}-${name}.png` });
const posted = (page: Page) => page.evaluate(() => (window as any).__posted as { channel: string; body: string }[]);

const run = (now: number, id: string, title: string, md: Record<string, unknown>) => ({ id, path: `Runs/2026-10-20 ${title}`, tags: ['run'], createdAt: new Date(now - 90 * MIN).toISOString(), updatedAt: new Date(now - MIN).toISOString(),
  metadata: { worker: `mts-${id.slice(-8).padStart(8, 'x')}`, state: 'running', started_at: new Date(now - 40 * MIN).toISOString(), doing_at: new Date(now - MIN).toISOString(), steps: 12, ...md } });
const moreRuns = (now: number) => [
  // the shape of a run under an area-level umbrella task: its node is the area, no project, no project's folder
  run(now, 'run-area-live', 'Fix the charter upload', { node: 'area-guild', doing_now: 'Editing upload.ts', room: 'guild', channel: 'demo-guild' }),
  // no node that says where, only its room
  run(now, 'run-room-only', 'Sort the bike lane photos', { node: 'gone-node', doing_now: 'Reading photos.csv', room: 'town-hall' }),
  // nothing that says where
  run(now, 'run-nowhere', 'Check the old printer', { node: 'gone-node', doing_now: 'Running lpstat', room: 'a-room-long-gone' }),
];

test('a working session on an area, with no project: the home counts it, its room shows it, and it can be stopped', async ({ page }) => {
  await bootProjects(page, { moreRuns });
  await page.goto('/');
  await expect(door(page, 'Guild').locator('.fd-live')).toHaveText('1 working');
  await shot(page, '01-home');
  await door(page, 'Guild').click();
  await expect(page.locator('.sr-title')).toHaveText('Guild');
  const tab = strip(page).getByRole('button', { name: /^Other sessions, 1 working/ });
  await expect(tab).toBeVisible();
  await shot(page, '02-room');
  await tab.click();
  const sheet = page.getByRole('dialog', { name: /Other sessions/ });
  const card = sheet.locator('.pj-session[data-session="run-area-live"]');
  await expect(card).toContainText('Fix the charter upload');
  await expect(card).toContainText('Editing upload.ts');
  // the earlier run on the same area is its history there
  await expect(sheet.locator('.pj-session[data-session="run-loose"]')).toContainText('Tidy the area notes');
  await expect(sheet).toContainText('Guild');
  // not a project: no folder to name, nothing to archive, no place to add a session
  await expect(sheet.locator('.pj-folder')).toHaveCount(0);
  await shot(page, '03-sheet');
  await sheet.getByRole('button', { name: 'Actions' }).click();
  await expect(sheet.locator('.pj-menu-list [data-act="archive"]')).toHaveCount(0);
  await expect(sheet.locator('.pj-menu-list [data-act="add"]')).toHaveCount(0);
  await sheet.locator('.pj-menu-list [data-act="stop"]').click();
  await sheet.locator('.pj-post').click();
  await expect.poll(() => posted(page)).toHaveLength(1);
  const [message] = await posted(page);
  expect(message.channel).toBe('demo-guild');
  expect(message.body).toMatch(/^Stop the session on “Fix the charter upload” \(started .+\) in Guild\.$/);
});

test('a session whose only clue is its room shows under that room\'s area', async ({ page }) => {
  await bootProjects(page, { moreRuns });
  await page.goto('/');
  await expect(door(page, 'Town Hall').locator('.fd-live')).toHaveText('1 working');
  await door(page, 'Town Hall').click();
  await strip(page).getByRole('button', { name: /^Other sessions, 1 working/ }).click();
  await expect(page.getByRole('dialog', { name: /Other sessions/ }).locator('.pj-session[data-session="run-room-only"]')).toContainText('Sort the bike lane photos');
});

test('a session with no area at all has a home too: Unfiled sessions, on the home, which opens in place', async ({ page }) => {
  await bootProjects(page, { moreRuns });
  await page.goto('/');
  const line = page.getByRole('button', { name: /^Unfiled sessions/ });
  await expect(line).toHaveText(/1 working/);
  await line.click();
  const sheet = page.getByRole('dialog', { name: /Unfiled sessions/ });
  await expect(sheet.locator('.pj-session[data-session="run-nowhere"]')).toContainText('Check the old printer');
  await expect(sheet.locator('.pj-session[data-session="run-nowhere"]')).toContainText('Running lpstat');
  await shot(page, '04-unfiled');
  // no room to ask: the sheet says so rather than offer what it can't post
  await expect(sheet.getByRole('button', { name: 'Actions' })).toHaveCount(0);
  await expect(sheet).toContainText('Ask in a room');
  await sheet.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.locator('[data-place="front-door"]')).toBeVisible();
});

test("a run from a private room stays out of a public area's work view; a public one there shows", async ({ page }) => {
  await bootProjects(page, { moreRuns: (now) => [
    run(now, 'run-area-private', 'A private errand', { node: 'area-guild', room: 'sanctum', summary: 'Quiet letter to someone' }),
    run(now, 'run-area-public', 'A public errand', { node: 'area-guild', room: 'guild', summary: 'Public minutes for the charter' }),
  ] });
  await page.goto('/');
  await door(page, 'Guild').click();
  await expect(page.locator('.sr-title')).toHaveText('Guild');
  // on a phone the way there is under the room's one line
  const all = page.getByRole('button', { name: /All of Guild.s work/ }).first();
  if (!(await all.isVisible())) await page.locator('.cp-line[aria-expanded="false"]').click();
  await all.click();
  const view = page.locator('.wv');
  await expect(view.getByText('Public minutes for the charter')).toBeVisible();
  await expect(view).not.toContainText('Quiet letter');
});

test("a run naming its room only by id waits, with no words, until the rooms are read, on the screen and in the device's copy", async ({ page }) => {
  const idOnly = (now: number) => [run(now, 'run-id-only', 'A walk by the still lake', { node: 'node-uni', channel: 'hub-quiet-sub', starter_room: 'uni', doing_now: 'Reading lake.md' })];
  const saved = () => page.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith('uni.work.')).map(([, v]) => v as string).join(''));
  await bootProjects(page, { moreRuns: idOnly, moreRooms: [{ id: 'hub-quiet-sub', name: 'sanctum/build' }], holdRooms: true });
  await page.goto('/');
  await expect.poll(saved).toContain('run-id-only');
  expect(await saved()).not.toContain('still lake');
  expect(await saved()).not.toContain('lake.md');
  expect(await saved()).toContain("A session whose room isn't read yet");
  await expect(page.locator('body')).not.toContainText('still lake');
});

test('the same run, with the rooms read: the id says it is private, so it never shows its words', async ({ page }) => {
  const idOnly = (now: number) => [run(now, 'run-id-only', 'A walk by the still lake', { node: 'node-uni', channel: 'hub-quiet-sub', starter_room: 'uni', doing_now: 'Reading lake.md' })];
  await bootProjects(page, { moreRuns: idOnly, moreRooms: [{ id: 'hub-quiet-sub', name: 'sanctum/build' }] });
  await page.goto('/');
  const line = page.getByRole('button', { name: /^Unfiled sessions/ });
  await line.click();
  const sheet = page.getByRole('dialog', { name: /Unfiled sessions/ });
  await expect(sheet.locator('.pj-session[data-session="run-id-only"]')).toContainText('A session in a private place');
  await expect(sheet).not.toContainText('still lake');
  await expect.poll(() => page.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith('uni.work.')).map(([, v]) => v as string).join(''))).toContain('A session in a private place');
});

test('nothing unfiled: the home says nothing about it, and a room with only projects has no extra tab', async ({ page }) => {
  await bootProjects(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: /^Unfiled sessions/ })).toHaveCount(0);
  await door(page, 'Hearth').click();
  await expect(page.locator('.sr-title')).toHaveText('Hearth');
  await expect(strip(page).getByRole('button', { name: /^Other sessions/ })).toHaveCount(0);
});

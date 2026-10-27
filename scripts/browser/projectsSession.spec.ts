// T-304: a project's sessions, zoomed in, played as a person would on the real web build: a working session opens to a live view of its
// steps that keeps up as it goes; one that needs you shows the exact ask and puts an answer in the room's composer (nothing is sent);
// one that didn't finish says why; a finished one shows what it left, with links. The front door's working mark counts the room's Uni at
// work on your message. The native side is projectsFixture.ts (a made-up vault and rooms in the page; nothing leaves it).
import { expect, test, type Page } from '@playwright/test';
import { bootProjects } from './projectsFixture.ts';

const shot = (page: Page, name: string) => page.screenshot({ path: `__shots__/t304/${test.info().project.name}-${name}.png` });
const door = (page: Page, name: string) => page.getByRole('navigation', { name: 'Rooms' }).getByRole('button', { name: new RegExp(`^${name}\\b`) });
const strip = (page: Page) => page.locator('[data-place="project-strip"]');
const view = (page: Page) => page.locator('[data-place="session-view"]');
const posted = (page: Page) => page.evaluate(() => (window as any).__posted as unknown[]);
const NO_IDS = /\bT-\d+|\brun-|\bfeed-|\bmts\b|\bp-coop|\bresume\b|zzzzzzzz/;

async function openProject(page: Page, room: string, project: RegExp) {
  await bootProjects(page);
  await page.goto('/');
  await door(page, room).click();
  await expect(page.locator('.sr-title')).toHaveText(room);
  await strip(page).getByRole('button', { name: project }).first().click();
  const sheet = page.getByRole('dialog', { name: project });
  await expect(sheet).toBeVisible();
  return sheet;
}
const openSession = async (page: Page, sheet: ReturnType<Page['getByRole']>, ask: string) => {
  // a session's line is a button named by its ask (an earlier one's adds when it ended)
  await sheet.getByRole('button', { name: new RegExp(`^${ask.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }).first().click();
  await expect(view(page)).toBeVisible();
  await expect(view(page).locator('.sv-ask')).toHaveText(ask);
};

test('a working session opens to a live view: its steps and what it wrote, newest last, keeping up as it goes', async ({ page }) => {
  const sheet = await openProject(page, 'Workshop', /Riverbend co-op site/);
  await openSession(page, sheet, 'Make the events page read like a noticeboard');
  const v = view(page);
  await expect(v.getByRole('region', { name: 'Live' })).toContainText('Live');
  const steps = v.getByRole('list', { name: 'What it is doing, newest last' });
  await expect(steps.locator('li')).toHaveCount(13);
  await expect(steps.locator('li').first()).toContainText("I'll start from the events page as it stands");
  await expect(steps.locator('li').last()).toContainText('Recording the walkthrough on phone and desktop');
  await expect(steps.locator('li[data-kind="said"]')).toHaveCount(4);
  // a secret in what it wrote never reaches the screen
  await expect(v).not.toContainText('abc123');
  await expect(v).toContainText('token=[hidden]');
  await expect(v).not.toContainText(NO_IDS);
  // the newest step is in view, at the bottom of its box
  await expect(steps.locator('li').last()).toBeInViewport();
  await shot(page, '01-live');
  // mts writes a new step: the open view shows it on its next read, without a reload
  const reads = await page.evaluate(() => (window as any).__feedReads as number);
  await page.evaluate(() => {
    const f = (window as any).__world.feeds.find((x: any) => x.id === 'feed-events');
    f.content += `- ${new Date().toISOString()} · said · The walkthrough is recorded; writing the report now.\n`;
  });
  await expect(steps.locator('li').last()).toContainText('The walkthrough is recorded; writing the report now.', { timeout: 15_000 });
  expect(await page.evaluate(() => (window as any).__feedReads as number)).toBeGreaterThan(reads);
  await shot(page, '02-live-update');
  // back to the list, on the same session's line
  await v.getByRole('button', { name: 'Sessions' }).click();
  await expect(view(page)).toHaveCount(0);
  await expect(sheet.locator('.pj-session').filter({ hasText: 'Make the events page' }).getByRole('button')).toBeFocused();
  // closed, it stops reading
  const after = await page.evaluate(() => (window as any).__feedReads as number);
  await page.waitForTimeout(11_000);
  expect(await page.evaluate(() => (window as any).__feedReads as number)).toBe(after);
});

test('a working session from before steps were kept says so, and still shows what it is doing now', async ({ page }) => {
  const sheet = await openProject(page, 'Workshop', /Riverbend co-op site/);
  await openSession(page, sheet, 'Donate page with a sliding amount');
  await expect(view(page)).toContainText("This session doesn't share its steps yet");
  await expect(view(page).locator('.sv-now')).toContainText('Now: Editing Donate.tsx');
});

test('a session that needs you shows the exact ask, and Answer puts it in the room\'s composer; nothing is sent for you', async ({ page }) => {
  const sheet = await openProject(page, 'Workshop', /Seed library catalogue/);
  await openSession(page, sheet, 'Estimate a catalogue from the spreadsheet');
  const v = view(page);
  await expect(v.locator('.sv-end')).toContainText('Stopped to ask you something.');
  const needs = v.getByRole('region', { name: 'What it needs from you' });
  await expect(needs.locator('blockquote')).toHaveText('Should a variety with two names be one entry or two? I need that before I can count them.');
  await expect(v.getByRole('region', { name: 'What it did' })).toContainText('Read the spreadsheet: 412 rows.');
  await v.locator('summary', { hasText: 'How it checked' }).click();
  await expect(v).toContainText('API_KEY=[hidden]');
  await expect(v).not.toContainText('made-up-key-123');
  await expect(v).not.toContainText(NO_IDS);
  await shot(page, '03-needs-you');
  await needs.getByRole('button', { name: 'Answer in #workshop' }).click();
  await expect(page.getByRole('dialog', { name: /Seed library catalogue/ })).toHaveCount(0);
  await expect(page.locator('.sr-chat').getByRole('textbox', { name: /^Message / })).toHaveValue(
    'About the session on “Estimate a catalogue from the spreadsheet” (Seed library catalogue), which asks: “Should a variety with two names be one entry or two? I need that before I can count them.” — ');
  await shot(page, '04-answer');
  expect(await posted(page)).toEqual([]);
});

test('a session that didn\'t finish says why: stopped on purpose; ran out of room, and when it picks up again', async ({ page }) => {
  let sheet = await openProject(page, 'Workshop', /Riverbend co-op site/);
  await openSession(page, sheet, 'Try a donate button');
  await expect(view(page).locator('.sv-end')).toHaveText("Didn't finish: it was stopped on purpose.");
  await expect(view(page)).toContainText("Its note has no report");
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await strip(page).getByRole('button', { name: /Seed library catalogue/ }).click();
  sheet = page.getByRole('dialog', { name: /Seed library catalogue/ });
  await openSession(page, sheet, 'Print labels for the spring packets');
  await expect(view(page).locator('.sv-end')).toContainText("Didn't finish: it ran out of room: the Claude account reached its session limit.");
  await expect(view(page).locator('.sv-end')).toContainText(/It picks up again by itself at \d{1,2}:\d{2}/);
  await expect(view(page).getByRole('region', { name: 'What it did' })).toHaveText(/Laid out 40 of the 96 labels\./);
  await shot(page, '05-ran-out-of-room');
});

test('a finished session: what it did, what it left (links where they are links), and its steps, read when opened', async ({ page }) => {
  const sheet = await openProject(page, 'Workshop', /Riverbend co-op site/);
  await openSession(page, sheet, 'Rebuild the about page from the coordinator\'s letter');
  const v = view(page);
  await expect(v.locator('.sv-end')).toHaveText('Finished.');
  await expect(v.getByRole('region', { name: 'What it did' })).toContainText("in her words");
  const left = v.getByRole('region', { name: 'What it left' });
  await expect(left.locator('li')).toHaveText(['ABOUT.md in ~/work/riverbend-site', 'https://example.com/riverbend/about (the preview)', 'commit 1a2b3c4']);
  await expect(left.getByRole('link')).toHaveAttribute('href', 'https://example.com/riverbend/about');
  await expect(v.getByRole('link', { name: 'Watch the walkthrough' })).toHaveAttribute('href', 'https://example.com/walkthrough/about-page');
  const reads = await page.evaluate(() => (window as any).__feedReads ?? 0);
  expect(reads).toBe(0);
  await v.locator('summary', { hasText: 'Its steps' }).click();
  await expect(v.getByRole('list', { name: 'What it did, newest last' }).locator('li')).toHaveCount(3);
  await shot(page, '06-finished');
});

test('a steps note that can\'t be read says so, and the rest of the view still shows', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('t.feedfail', '1'));
  const sheet = await openProject(page, 'Workshop', /Riverbend co-op site/);
  await openSession(page, sheet, 'Make the events page read like a noticeboard');
  await expect(view(page)).toContainText("Couldn't read its steps. Trying again in a moment.");
  await expect(view(page).locator('.sv-now')).toContainText('Now: Recording the walkthrough on phone and desktop');
});

test('the front door\'s working mark counts the room\'s Uni at work on your message, not only sessions', async ({ page }) => {
  await bootProjects(page);
  await page.goto('/');
  await expect(door(page, 'Workshop').locator('.fd-live')).toHaveText('2 working');
  await expect(door(page, 'Hearth').locator('.fd-live')).toHaveCount(0);
  // you ask in Hearth and Workshop; the room's Uni takes both (👀) and is working on them
  await page.evaluate(() => { (window as any).__turn('demo-hearth', 'Move the watering to Saturday.'); (window as any).__turn('demo-workshop', 'And the donate page too.'); });
  await expect(door(page, 'Hearth').locator('.fd-live')).toHaveText('1 working', { timeout: 20_000 });
  await expect(door(page, 'Hearth').locator('.fd-live')).toHaveAttribute('title', 'Uni is answering here');
  await expect(door(page, 'Workshop').locator('.fd-live')).toHaveText('3 working', { timeout: 20_000 });
  await expect(door(page, 'Workshop')).toHaveAttribute('aria-label', /Uni is answering here and 2 sessions are working/);
  await shot(page, '07-front-door-turns');
  // Uni answers in Hearth: its turn is over
  await page.evaluate(() => (window as any).__reply('demo-hearth', 'Saturday it is.'));
  await expect(door(page, 'Hearth').locator('.fd-live')).toHaveCount(0, { timeout: 20_000 });
});

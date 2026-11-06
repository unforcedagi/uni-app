// T-335 glow-up: the study's direction built into the app (home, a room, find) and the All view: every area's room interleaved by time,
// and a composer whose route (editable chips) decides where a message goes, posting once per chosen room and nowhere else.
// Made-up world only (the fixture's `world: 'unread'` with `glow`). Shots go to $GLOWUP_SHOTS (default test-results/glowup-shots),
// never into the repo. Run: GLOWUP_TEST_PORT=1461 npx playwright test --config playwright.glowup.config.ts
import { test, expect, type Page } from '@playwright/test';
import { bootAreas } from './areasFixture';
import { railGo } from './railGo';

const SHOTS = process.env.GLOWUP_SHOTS ?? 'test-results/glowup-shots';
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${name}.png` });
const project = () => test.info().project.name;
const touch = () => project() !== 'desktop';
const UNI = 'c'.repeat(64);

const toAll = async (page: Page) => { await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'All', exact: true }).click(); await page.locator('[data-view="all"]').waitFor(); };
async function boot(page: Page, view: 'places' | 'all' = 'places') {
  await page.addInitScript((v) => {
    if (sessionStorage.getItem('glow.booted')) return;
    sessionStorage.setItem('glow.booted', '1');
    // the Daylight is set to Calm screen, as the device is
    if (navigator.userAgent.includes('SM-T') || (window.innerWidth === 828 && window.innerHeight === 1104)) localStorage.setItem('uni.motion', 'calm');
  }, view);
  await bootAreas(page, 'seed', { world: 'unread', glow: true, uniMember: true, unread: { 'ch-kiln': 1, 'ch-bees': 2 } });
  await page.locator('[data-place="front-door"]').waitFor();
  if (view === 'all') await toAll(page);
}

const posts = (page: Page) => page.evaluate(() => (window as any).__calls.filter((c: any) => c.cmd === 'post_message').map((c: any) => ({ channel: c.args.channel, body: c.args.body, recipients: c.args.recipients })));
const field = (page: Page) => page.getByRole('textbox', { name: 'Message for your rooms' });
const chips = (page: Page) => page.getByRole('group', { name: 'Where this goes' }).locator('.all-chip:not(.all-chip-add) .all-chip-name');

test('look: home, a room and find wear the glow-up, at every size', async ({ page }) => {
  await boot(page);
  const wide = page.viewportSize()!.width >= 900;
  // home: the day in one sentence, then the places as rows; the Daylight reads in ink
  await expect(page.locator('.fd-statement')).toHaveText(/needs? you\.|Nothing needs you\./);
  await expect(page.locator('.fd-door')).toHaveCount(7);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (project() === 'daylight') {
    await expect(page.locator('html')).toHaveAttribute('data-screen', 'ink');
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.fd')!).backgroundColor)).toBe('rgb(255, 255, 255)');
  } else expect(await page.evaluate(() => document.documentElement.dataset.screen)).toBeUndefined();
  expect(await page.locator('.fd-name').first().evaluate((el) => getComputedStyle(el).fontFamily)).toContain('Fraunces Glow');
  await page.waitForTimeout(400);
  await shot(page, '01-home');
  // a room: Uni's words in the reading serif, the person's in the interface sans, in a bubble on the right
  await page.locator('.fd-door[data-path="Areas/Kiln Studio"]').click();
  const box = page.getByRole('textbox', { name: /^Message / }).first();
  await box.waitFor();
  const uni = page.locator('.message-list article.message:not(.mine)').filter({ hasText: 'bisque firing' }).locator('.message-content p').first();
  const mine = page.locator('.message-list article.message.mine').filter({ hasText: 'after lunch' }).locator('.message-content p').first();
  await expect(uni).toBeVisible();
  expect(await uni.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/^"?Literata/);
  expect(await mine.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/^"?Instrument Sans/);
  const [u, m] = [await uni.boundingBox(), await mine.boundingBox()];
  expect(m!.x + m!.width).toBeGreaterThan(u!.x + u!.width * 0.6);
  await expect(page.locator('.message-avatar').first()).toBeHidden();
  await page.waitForTimeout(300);
  await shot(page, '02-room');
  // find: Ctrl+K on a wide window, the rail's Search on a phone; recent places before typing; the query is kept when it opens again
  if (wide) await page.keyboard.press('Control+k');
  else await railGo(page, 'Search');
  const search = page.getByRole('searchbox', { name: 'Search conversations and notes' });
  await expect(search).toBeFocused();
  await expect(page.locator('.search-recent button').first()).toBeVisible();
  await shot(page, '03-find-empty');
  await search.fill('glaze');
  await expect(page.locator('.search-hit').first()).toBeVisible();
  await page.waitForTimeout(500);
  await shot(page, '04-find-results');
  await search.press('ArrowDown');
  await expect(page.locator('.search-hit').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(search).toBeHidden();
  if (wide) await page.keyboard.press('Control+k');
  else await railGo(page, 'Search');
  await expect(search).toHaveValue('glaze');
});

test('All: every area room interleaved by time, each marked with its place; its label puts that room in focus', async ({ page }) => {
  await boot(page);
  await toAll(page);
  const feed = page.getByRole('log', { name: 'All rooms, by time' });
  // oldest first across the five area rooms; Sanctum (private), the project room and the room no area holds stay out
  const order = ['c1', 'c2', 'n1', 'n2', 'k1', 'k2', 'b1', 't1', 't2', 'n3', 'b2', 'k3', 'c3'];
  await expect.poll(() => feed.locator('article.all-msg').evaluateAll((els) => els.map((e) => e.getAttribute('data-ref')))).toEqual(order);
  const rooms = await feed.locator('article.all-msg').evaluateAll((els) => els.map((e) => e.getAttribute('data-room')));
  expect(rooms).toEqual(['ch-choir', 'ch-choir', 'ch-north', 'ch-north', 'ch-kiln', 'ch-kiln', 'ch-bees', 'ch-table', 'ch-table', 'ch-north', 'ch-bees', 'ch-kiln', 'ch-choir']);
  await expect(feed).not.toContainText('Restless but stayed');
  // T-335 chat feel: runs, not a mirror: a place's name where the room changes (nine runs here)
  await expect(feed.locator('article.all-msg .all-place')).toHaveCount(9);
  await expect(feed.locator('article[data-ref="k3"] .all-place')).toHaveText('Kiln Studio');
  await page.waitForTimeout(300);
  await shot(page, '05-all');
  // a live message lands in its place
  await page.evaluate(() => (window as any).__arrive('ch-bees', 'Uni', 'Jars found: the neighbours have thirty.'));
  await expect(feed.locator('article.all-msg').last()).toContainText('Jars found');
  await expect(feed.locator('article.all-msg').last().locator('.all-place')).toHaveText('Bee Garden');
  // its room's label puts the room in focus (a tap on the message itself replies there: allv2.spec.ts; the focus itself: fluid.spec.ts)
  await feed.locator('article[data-ref="k3"] .all-place').click();
  await expect(page.locator('.all-focus')).toBeVisible();
  await expect(page.locator('.message-list')).toContainText('Three glaze tiles came out glossy');
  await expect(page.getByRole('textbox', { name: /^Message kiln-studio/ })).toBeVisible();
});

test('All: the route is a suggestion with its reason; chips edit it; Send posts once per chosen room and nowhere else', async ({ page }) => {
  await boot(page, 'all');
  await expect(page.locator('article.all-msg')).toHaveCount(13);
  const before = (await posts(page)).length;
  // a telling word picks its place, and says why
  await field(page).fill('Is the honey ready to jar?');
  await expect(chips(page)).toHaveText(['Bee Garden']);
  await expect(page.locator('.all-why')).toHaveText('suggested: talks about honey');
  // naming places picks them, in the order named
  await field(page).fill('Tell Choir and North Field the hall is booked for Tuesday');
  await expect(chips(page)).toHaveText(['Choir', 'North Field']);
  await expect(page.locator('.all-why')).toHaveCount(0); // the chips are the rooms you named: nothing to explain
  await expect(page.getByRole('button', { name: 'Send to Choir and North Field', exact: true })).toHaveText('Send to 2 rooms');
  // the person edits the route: take Choir off, add Long Table
  await page.getByRole('button', { name: "Don't send to Choir" }).click();
  await page.getByRole('button', { name: 'Add a room' }).click();
  await page.getByRole('list', { name: 'Rooms to add' }).getByRole('button', { name: 'Long Table' }).click();
  // what you dropped stays on offer, one tap back
  await expect(page.locator('.all-chip.chosen .all-chip-name')).toHaveText(['North Field', 'Long Table']);
  await expect(page.locator('.all-chip.suggested .all-chip-name')).toHaveText(['Choir']);
  await expect(page.locator('.all-why')).toHaveText('your choice');
  await page.waitForTimeout(200);
  await shot(page, '06-route-chips');
  // nothing chosen: nothing can be sent
  await page.getByRole('button', { name: "Don't send to North Field" }).click();
  await page.getByRole('button', { name: "Don't send to Long Table" }).click();
  await expect(page.getByRole('button', { name: 'Choose a room to send to' })).toBeDisabled();
  if (!touch()) await field(page).press('Enter');
  await expect(page.locator('.all-note')).toContainText('Nothing is sent until you do');
  expect((await posts(page)).length).toBe(before);
  // two rooms chosen; Enter sends to each once, as the person, with that room's Uni addressed
  await page.getByRole('button', { name: 'Add a room' }).click();
  await page.getByRole('list', { name: 'Rooms to add' }).getByRole('button', { name: 'North Field' }).click();
  await page.getByRole('button', { name: 'Add a room' }).click();
  await page.getByRole('list', { name: 'Rooms to add' }).getByRole('button', { name: 'Long Table' }).click();
  if (touch()) {
    // on a touch keyboard Return is a new line, never a send; Send is the button
    await field(page).press('Enter');
    await expect(field(page)).toHaveValue('Tell Choir and North Field the hall is booked for Tuesday\n');
    expect((await posts(page)).length).toBe(before);
    await field(page).press('Backspace');
    await page.getByRole('button', { name: 'Send to North Field and Long Table', exact: true }).click();
  } else await field(page).press('Enter');
  await expect(page.locator('.all-note')).toContainText('Sent to North Field and Long Table');
  const sent = (await posts(page)).slice(before);
  expect(sent).toEqual([
    { channel: 'ch-north', body: 'Tell Choir and North Field the hall is booked for Tuesday', recipients: [UNI] },
    { channel: 'ch-table', body: 'Tell Choir and North Field the hall is booked for Tuesday', recipients: [UNI] },
  ]);
  await expect(field(page)).toHaveValue('');
  // the feed shows the message in both rooms, each marked with its place
  const feed = page.getByRole('log', { name: 'All rooms, by time' });
  await expect(feed.locator('article.all-msg.mine', { hasText: 'hall is booked for Tuesday' })).toHaveCount(2);
  await page.waitForTimeout(300);
  await shot(page, '07-all-sent');
  // a room that fails: the other is sent, the failed one says so, and Send again tries only it
  await page.evaluate(() => { const w = window as any; w.__choirFails = 1; w.__extraInvoke = async (cmd: string, args: any) => { if (cmd === 'post_message' && args.channel === 'ch-choir' && w.__choirFails-- > 0) throw new Error('relay unreachable'); return undefined; }; });
  const mark = (await posts(page)).length;
  await field(page).fill('Choir and Bee Garden: the jars are in the shed');
  await expect(chips(page)).toHaveText(['Choir', 'Bee Garden']);
  await page.getByRole('button', { name: 'Send to Choir and Bee Garden', exact: true }).click();
  await expect(page.locator('.all-note')).toContainText("Couldn't send to Choir (relay unreachable)");
  await expect(page.locator('.all-note')).toContainText('Sent to Bee Garden');
  await expect(page.locator('.all-chip.sent')).toHaveText(/Bee Garden\s*sent/);
  await page.getByRole('button', { name: 'Send to Choir', exact: true }).click();
  await expect(page.locator('.all-note')).toContainText('Sent to Choir and Bee Garden');
  const retry = (await posts(page)).slice(mark).map((p: any) => p.channel);
  // Bee Garden once; Choir twice (the failed try and the one that went)
  expect(retry).toEqual(['ch-choir', 'ch-bees', 'ch-choir']);
  await expect(feed.locator('article.all-msg.mine', { hasText: 'jars are in the shed' })).toHaveCount(2);
});

test('Places: the home composer routes the same way, before the places', async ({ page }) => {
  await boot(page);
  await field(page).click();
  await field(page).fill('Remind me which glaze crawled');
  await expect(chips(page)).toHaveText(['Kiln Studio']);
  await expect(page.locator('.all-why')).toHaveText('suggested: talks about glaze');
  await page.waitForTimeout(200);
  await shot(page, '08-home-compose');
  const before = (await posts(page)).length;
  await page.getByRole('button', { name: 'Send to Kiln Studio', exact: true }).click();
  await expect(page.locator('.all-note')).toContainText('Sent to Kiln Studio');
  expect((await posts(page)).slice(before).map((p: any) => p.channel)).toEqual(['ch-kiln']);
  // the sent line opens the room
  await page.locator('.all-note').getByRole('button', { name: 'Kiln Studio' }).click();
  await expect(page.locator('.message-list')).toContainText('Remind me which glaze crawled');
});

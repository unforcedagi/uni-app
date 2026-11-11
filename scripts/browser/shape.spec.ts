// T-335 the shape, end to end on the real build with Tauri faked (shapeFixture.ts, a made-up world): home is the rooms, newest first, with
// what moves and what wants you; answering an ask from home writes the vault once and tells that room; the expiring card is pinned with
// its clock and leaves once approved; a room has its strip, its asks as messages and a run's story; Back goes home; the bar switches the
// three places; the drawer opens each applet in its frame; search starts where you are; a private room keeps its words; the ink screen
// reads by shape and word. Screenshots, named like the prototype's, go to test-results/shape-shots (never committed).
// Run: pnpm test:shape
import { test, expect, type Page } from '@playwright/test';
import { bootShape, calls, live, ROOM, UNI } from './shapeFixture';

const SHOTS = process.env.SHAPE_SHOTS ?? 'test-results/shape-shots';
const shot = async (page: Page, name: string) => { await page.waitForTimeout(250); await page.screenshot({ path: `${SHOTS}/${name}.png` }); };
const row = (page: Page, room: string) => page.locator(`.sh-row[data-room="${room}"]`);
const bar = (page: Page) => page.getByRole('navigation', { name: 'Places' });
const home = (page: Page) => page.getByRole('heading', { name: 'Rooms', level: 1 });
async function openRoomFromHome(page: Page, room: string) {
  await row(page, room).locator('.sh-row-open').click();
  await expect(page.locator('.sh-room')).toBeVisible();
  await expect(page.locator('.composer textarea')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (e) => { throw e; });
});

test('home: rooms newest first, the moving line, the asks with their buttons, a private room keeps its words, a retired room is gone', async ({ page }) => {
  await bootShape(page);
  await expect(home(page)).toBeVisible();
  await expect(row(page, ROOM.uni)).toBeVisible();
  const order = await page.locator('.sh-row').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.room));
  expect(order).toEqual([ROOM.uni, ROOM.river, ROOM.garden, ROOM.studio, ROOM.teach, ROOM.post, ROOM.quiet, ROOM.family, ROOM.house, ROOM.arcade]);
  // the retired room (the registry's) is not a room any more
  await expect(row(page, ROOM.barn)).toHaveCount(0);
  // moving: Uni's and the garden's runs, with their live lines
  await expect(row(page, ROOM.uni).locator('.sh-run[data-run="moving"]')).toContainText('Reading 14 notes from this week');
  await expect(row(page, ROOM.garden).locator('.sh-run[data-run="moving"]')).toContainText('Building the preview');
  // wants you: the ask's line and its buttons, inline
  await expect(row(page, ROOM.uni).locator('.sh-ask-wants')).toContainText('The weekly summary is ready to read');
  await expect(row(page, ROOM.river).getByRole('button', { name: 'Yes, Thursday 2pm' })).toBeVisible();
  await expect(row(page, ROOM.river).getByRole('button', { name: 'Friday instead' })).toBeVisible();
  // the private room is a room: no run line and no ask on its row, only a wordless mark that something waits in it, and none of their
  // words anywhere in home's DOM
  await expect(row(page, ROOM.quiet)).toBeVisible();
  await expect(row(page, ROOM.quiet).locator('.sh-run, .sh-ask')).toHaveCount(0);
  await expect(row(page, ROOM.quiet).locator('.sh-row-hush')).toHaveText(/^◆\uFE0E? Something waits in here$/);
  // a room private by the rooms registry alone (its name says nothing) keeps its words the same way
  await expect(row(page, ROOM.family)).toBeVisible();
  await expect(row(page, ROOM.family).locator('.sh-run, .sh-ask')).toHaveCount(0);
  await expect(row(page, ROOM.family).locator('.sh-row-hush')).toHaveText(/^◆\uFE0E? Something waits in here$/);
  // (the same private room by an old name no room on this device has: hidden, never in Uni's room)
  await expect(row(page, ROOM.uni).locator('.sh-ask')).toHaveCount(1);
  const dom = await page.evaluate(() => document.documentElement.outerHTML);
  for (const words of ['Private words about the practice', 'A quiet line that stays in its room', 'T-605', 'A family line that stays at the table', 'T-606',
    'Family words about the seating', 'A kitchen line that stays private', 'T-607']) expect(dom, words).not.toContain(words);
  // the bar counts what wants you: four asks, the two waiting in private rooms, and the pinned card
  await expect(bar(page).getByRole('button', { name: /^Rooms, 7 things want you$/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await shot(page, '01-home');
});

test('answering from home: Seen and a choice each write the vault once, tell that room, and the ask leaves its row', async ({ page }) => {
  await bootShape(page);
  await expect(row(page, ROOM.uni).locator('.sh-ask-wants')).toBeVisible();
  await row(page, ROOM.uni).locator('.sh-ask-btn[data-act="seen"]').click();
  await expect(row(page, ROOM.uni).locator('.sh-ask')).toHaveCount(0);
  await expect.poll(async () => (await calls(page, 'post_message')).map((c) => [c.args.channel, c.args.body])).toContainEqual([ROOM.uni, 'T-601: seen.']);
  const seen = (await calls(page, 'vault_transition')).filter((c) => c.args.id === 'ask-summary');
  expect(seen).toHaveLength(1);
  expect(seen[0].args).toMatchObject({ from: 'open', to: 'done', metadata: { needs_aaron: false, needs_aaron_why: 'seen' } });
  // a choice: the answer is written with the close, and the room is told, addressed to its Uni
  await row(page, ROOM.river).getByRole('button', { name: 'Yes, Thursday 2pm' }).click();
  await expect(row(page, ROOM.river).locator('.sh-ask')).toHaveCount(0);
  await expect.poll(async () => (await calls(page, 'post_message')).map((c) => [c.args.channel, c.args.body, c.args.recipients])).toContainEqual([ROOM.river, 'T-602: Yes, Thursday 2pm', [UNI]]);
  const answered = (await calls(page, 'vault_transition')).filter((c) => c.args.id === 'ask-walk');
  expect(answered).toHaveLength(1);
  expect(answered[0].args.metadata).toMatchObject({ answer: 'Yes, Thursday 2pm', decided: 'Yes, Thursday 2pm' });
  // nothing was posted anywhere else
  expect((await calls(page, 'post_message')).map((c) => c.args.channel).sort()).toEqual([ROOM.river, ROOM.uni]);
  await expect(bar(page).getByRole('button', { name: /^Rooms, 5 things want you$/ })).toBeVisible();
});

test('inside a private room its ask is drawn in full, in the chat and the strip, and is answered there; home still has none of its words', async ({ page }) => {
  await bootShape(page);
  await expect(row(page, ROOM.quiet).locator('.sh-row-hush')).toBeVisible();
  await openRoomFromHome(page, ROOM.quiet);
  const room = page.locator('.sh-room');
  await expect(room.locator('.sh-strip .sh-run[data-run="waiting"]')).toContainText('A quiet line that stays in its room');
  const ask = room.locator('.sh-room-ask .sh-ask');
  await expect(ask).toContainText('A quiet line that stays in its room');
  // its run stays nowhere: the work store gives a private run no room (src/projects/live.ts)
  await expect(room.locator('.sh-run[data-run="moving"]')).toHaveCount(0);
  await ask.locator('.sh-ask-btn[data-act="seen"]').click();
  await expect(room.locator('.sh-room-ask')).toHaveCount(0);
  await expect.poll(async () => (await calls(page, 'post_message')).map((c) => [c.args.channel, c.args.body])).toEqual([[ROOM.quiet, 'T-605: seen.']]);
  const seen = (await calls(page, 'vault_transition')).filter((c) => c.args.id === 'ask-quiet');
  expect(seen).toHaveLength(1);
  expect(seen[0].args).toMatchObject({ from: 'open', to: 'done', metadata: { needs_aaron: false, needs_aaron_why: 'seen' } });
  // home again: the room's mark is gone with its one ask; the other private room's is still there, wordless
  await page.locator('.sh-room').getByRole('button', { name: 'Back to rooms' }).click();
  await expect(home(page)).toBeVisible();
  await expect(row(page, ROOM.quiet).locator('.sh-row-hush')).toHaveCount(0);
  await expect(row(page, ROOM.family).locator('.sh-row-hush')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.outerHTML)).not.toContain('A family line that stays at the table');
  await expect(bar(page).getByRole('button', { name: /^Rooms, 6 things want you$/ })).toBeVisible();
});

test('the expiring card is pinned with its clock, is approved in place, and leaves', async ({ page }) => {
  await bootShape(page);
  const pin = page.locator('.sh-pin[data-ref="rb-card"]');
  await expect(pin).toBeVisible();
  await expect(pin).toContainText('Riverbend Commons');
  await expect(pin.getByRole('timer')).toHaveText(/^expires in (8:[0-5]\d|9:00)$/);
  await pin.getByRole('button', { name: 'Approve' }).click();
  await expect.poll(async () => (await calls(page, 'sealed_answer')).map((c) => c.args.decision)).toEqual(['approve']);
  await expect(page.locator('.sh-pin')).toHaveCount(0);
  await expect(bar(page).getByRole('button', { name: /^Rooms, 6 things want you$/ })).toBeVisible();
});

test("a room: its strip, its ask as a message, the run's story from the moving line, the jump to the ask, and Back to home", async ({ page }) => {
  await bootShape(page);
  await openRoomFromHome(page, ROOM.uni);
  const room = page.locator('.sh-room');
  await expect(room.getByRole('heading', { name: 'Uni', level: 1 })).toBeVisible();
  const strip = room.locator('.sh-strip');
  await expect(strip.locator('.sh-run[data-run="moving"]')).toContainText('MovingReading 14 notes from this week');
  await expect(strip.locator('.sh-run[data-run="waiting"]')).toContainText('Waits on youThe weekly summary is ready to read');
  // the ask is a message at the end of the room's chat, after its last message, inside the scroller
  const ask = page.locator('.message-list .sh-ask-msg[data-id="ask-summary"]');
  await expect(ask).toContainText('The weekly summary is ready to read');
  await expect(ask.getByRole('button', { name: /^Seen:/ })).toBeVisible();
  const after = await page.evaluate(() => { const a = document.querySelector('.sh-ask-msg')!, last = [...document.querySelectorAll('.message-list article.message')].pop()!; return !!(last.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING); });
  expect(after).toBe(true);
  // the places bar steps aside for a room on a phone
  await expect(bar(page)).toBeHidden();
  await shot(page, '04-room');
  // the moving line opens the run's story, read from its note
  await strip.locator('.sh-run[data-run="moving"]').click();
  const story = page.getByRole('dialog', { name: "Tidying the week's notes" });
  await expect(story).toBeVisible();
  await expect(story).toContainText('Read the brief');
  await expect(story).toContainText(/Running for .* · in Uni/);
  expect((await calls(page, 'vault_note')).map((c) => c.args.noteRef)).toContain('run-tidy');
  await shot(page, '05-run-story');
  await story.getByRole('button', { name: 'Close' }).click();
  await expect(story).toHaveCount(0);
  // "Waits on you" goes to the ask in the chat and marks it
  await strip.locator('.sh-run[data-run="waiting"]').click();
  await expect(ask).toHaveClass(/sh-flash/);
  // Back: home
  await room.getByRole('button', { name: 'Back to rooms' }).click();
  await expect(home(page)).toBeVisible();
  await expect(bar(page)).toBeVisible();
});

test('the bar switches Rooms, Journal and Applets; the drawer opens each applet in its frame and Back returns to the drawer', async ({ page }) => {
  await bootShape(page);
  await expect(home(page)).toBeVisible();
  await bar(page).getByRole('button', { name: /^Journal/ }).click();
  await expect(page.getByText('Walked the river path for the film.')).toBeVisible();
  await expect(bar(page).getByRole('button', { name: /^Journal/ })).toHaveAttribute('aria-current', 'page');
  await shot(page, '06-journal');
  await bar(page).getByRole('button', { name: /^Rooms/ }).click();
  await expect(home(page)).toBeVisible();
  await bar(page).getByRole('button', { name: /^Applets/ }).click();
  const drawer = page.getByRole('dialog', { name: 'Applets' });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'To Post (1)' })).toBeVisible();
  await shot(page, '07-applets-drawer');
  for (const name of ['Arcade', 'Studio', 'To Post', 'Recipes', 'Calendar', 'Vault', 'Messages', 'Mail']) {
    await drawer.getByRole('button', { name: new RegExp(`^${name}( \\(\\d+\\))?$`) }).click();
    const frame = page.locator('.sh-ap-frame');
    await expect(frame.locator('.sh-ap-top h1')).toHaveText(name);
    if (name === 'To Post') {
      await expect(frame.getByText('This season the co-op grew more than beans', { exact: false })).toBeVisible();
      await shot(page, '08-to-post');
    }
    await shot(page, `applet-${name.toLowerCase().replace(' ', '-')}`);
    if (name === 'Vault') {
      await expect(frame.getByRole('button', { name: 'Other vaults (1)' })).toBeVisible();
      // the chooser is a place of its own: a relay event (the rooms read again) leaves it where it is
      await live(page);
      await expect.poll(async () => (await calls(page, 'get_rooms')).length).toBeGreaterThan(2);
      await page.waitForTimeout(300);
      await expect(frame.getByRole('button', { name: 'Other vaults (1)' })).toBeVisible();
    }
    await frame.getByRole('button', { name: 'Back to applets' }).click();
    await expect(drawer).toBeVisible();
  }
  await drawer.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(home(page)).toBeVisible();
});

test('Mail opens inside its frame, its count on the tile', async ({ page }) => {
  await bootShape(page, { mail: true });
  await bar(page).getByRole('button', { name: /^Applets/ }).click();
  const tile = page.getByRole('dialog', { name: 'Applets' }).getByRole('button', { name: /^Mail \(\d+\)$/ });
  await expect(tile).toBeVisible();
  await tile.click();
  await expect(page.locator('.sh-ap-top h1')).toHaveText('Mail');
  await expect(page.locator('.mail-row').first()).toBeVisible();
  await shot(page, '09-mail');
});

test('search starts where you are: from home the rooms and the journal, from a room that room, with Also in; Ask Uni posts to Uni', async ({ page }) => {
  await bootShape(page);
  await page.locator('.sh-home .sh-find').click();
  const search = page.getByRole('region', { name: 'Search' });
  const field = search.getByRole('searchbox');
  await expect(field).toHaveAttribute('placeholder', 'Search rooms and the journal');
  await field.fill('thursday');
  const heads = search.locator('.sh-find-head b');
  await expect(heads).toHaveText(['Riverbend Commons', 'Teaching: Design 2', 'Journal'], { useInnerText: true });
  await expect(search.locator('.sh-find-also')).toContainText('uni vault');
  await shot(page, '10-search');
  // nothing here: Ask Uni, in Uni's room, addressed to its Uni
  await field.fill('zebra crossing');
  await search.getByRole('button', { name: 'Ask Uni' }).click();
  await expect.poll(async () => (await calls(page, 'post_message')).map((c) => [c.args.channel, c.args.body, c.args.recipients])).toContainEqual([ROOM.uni, '@Uni search my notes for: zebra crossing', [UNI]]);
  await expect(search.getByRole('button', { name: '✓ Asked in #Uni' })).toBeVisible();
  await shot(page, '14-search-ask-uni');
  await search.getByRole('button', { name: 'Cancel' }).click();
  // from a room: that room only; the other places with matches are counted apart
  await openRoomFromHome(page, ROOM.river);
  await page.locator('.sh-room').getByRole('button', { name: 'Search' }).click();
  await expect(field).toHaveAttribute('placeholder', 'Search Riverbend Commons');
  await field.fill('thursday');
  await expect(heads).toHaveText(['Riverbend Commons']);
  await expect(search.locator('.sh-find-also')).toContainText('Teaching: Design 2');
  await expect(search.locator('.sh-find-also')).toContainText('Journal');
  await shot(page, '13-search-place');
});

test('the ink screen: every mark reads by shape and word, not by colour', async ({ page }) => {
  await bootShape(page);
  await expect(row(page, ROOM.uni)).toBeVisible();
  await page.evaluate(() => { document.documentElement.dataset.screen = 'ink'; });
  // wants you: a filled diamond plus words (for a screen reader too); moving: a dot plus its line; counts: black pills with numbers
  const want = row(page, ROOM.uni).locator('.sh-ask-wants');
  await expect(want.locator('.sh-ask-mark')).toHaveText('◆');
  await expect(want.locator('.sh-ask-sr')).toHaveText('Wants you:');
  await expect(row(page, ROOM.uni).locator('.sh-run[data-run="moving"] .sh-run-dot')).toHaveCount(1);
  await expect(row(page, ROOM.uni).locator('.sh-run[data-run="moving"]')).toHaveAttribute('aria-label', /^Moving: Reading 14 notes/);
  // a private room's wordless mark: the same filled diamond, and words that say only that something waits
  await expect(row(page, ROOM.quiet).locator('.sh-row-hush .sh-mark-needs')).toHaveText(/^◆\uFE0E?$/);
  await expect(row(page, ROOM.quiet).locator('.sh-row-hush')).toContainText('Something waits in here');
  const count = bar(page).locator('.sh-place-rooms .sh-count');
  await expect(count).toHaveText('7');
  expect(await count.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(0, 0, 0)');
  expect(await page.locator('.sh-pin').first().evaluate((e) => getComputedStyle(e).borderTopColor)).toBe('rgb(0, 0, 0)');
  await shot(page, '11-home-ink');
  await openRoomFromHome(page, ROOM.uni);
  await expect(page.locator('.sh-strip .sh-run[data-run="waiting"] .sh-run-word')).toHaveText('Waits on you');
  await expect(page.locator('.sh-strip .sh-run[data-run="moving"] .sh-run-word')).toHaveText('Moving');
  await shot(page, '12-room-ink');
});

test.describe('wide', () => {
  // a desktop window, not a phone stretched wide
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 });
test('wide: the bar is the left rail, beside home and beside a room, never over them', async ({ page }) => {
  await bootShape(page);
  await expect(home(page)).toBeVisible();
  const rail = await bar(page).boundingBox();
  const content = await page.locator('.sh-home').boundingBox();
  expect(rail!.x).toBe(0);
  expect(rail!.height).toBeGreaterThan(700);
  expect(content!.x).toBeGreaterThanOrEqual(rail!.x + rail!.width);
  await shot(page, '02-home-wide');
  await openRoomFromHome(page, ROOM.river);
  await expect(bar(page)).toBeVisible();
  const chat = await page.locator('.sh-room').boundingBox();
  expect(chat!.x).toBeGreaterThanOrEqual(rail!.width);
  await shot(page, '03-room-wide');
});
});

test("Settings from home's gear, Escape out of a room, a thread's Back steps to its room first", async ({ page }) => {
  await bootShape(page);
  await expect(home(page)).toBeVisible();
  await page.getByRole('button', { name: 'Settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  await expect(settings.getByRole('button', { name: 'Forget this device key' })).toBeVisible();
  await settings.getByRole('button', { name: 'Close' }).click();
  await expect(settings).toBeHidden();
  // a thread inside a room: the head keeps the room's name; Back goes to the room, then home
  await openRoomFromHome(page, ROOM.teach);
  await page.locator('article.message[data-ref="t2"]').getByRole('button', { name: 'Reply' }).click();
  await expect(page.locator('.sh-room h1')).toHaveText('Teaching: Design 2 · thread');
  await page.getByRole('button', { name: 'Back to Teaching: Design 2' }).click();
  await expect(page.locator('.sh-room h1')).toHaveText('Teaching: Design 2');
  await page.keyboard.press('Escape');
  await expect(home(page)).toBeVisible();
});

test("an answer the room didn't get is kept, said in the room, and sent again", async ({ page }) => {
  await bootShape(page, { postFails: 1 });
  await row(page, ROOM.uni).locator('.sh-ask-btn[data-act="seen"]').click();
  await expect(row(page, ROOM.uni).locator('.sh-ask')).toHaveCount(0);
  await expect.poll(async () => (await calls(page, 'vault_transition')).length).toBe(1);
  await openRoomFromHome(page, ROOM.uni);
  const owed = page.locator('.message-list .sh-owed');
  await expect(owed).toContainText("Your answer was saved, but the room didn't get it.");
  await owed.getByRole('button', { name: 'Send again' }).click();
  await expect(owed).toHaveCount(0);
  expect((await calls(page, 'post_message')).map((c) => [c.args.channel, c.args.body])).toEqual([[ROOM.uni, 'T-601: seen.'], [ROOM.uni, 'T-601: seen.']]);
  // the vault was written once
  expect(await calls(page, 'vault_transition')).toHaveLength(1);
});

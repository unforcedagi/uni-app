// T-335 the shape, end to end on the real build with Tauri faked (shapeFixture.ts, a made-up world): home is the rooms, newest first, with
// what moves and what wants you; answering an ask from home writes the vault once and tells that room; the expiring card is pinned with
// its clock and leaves once approved; a room has its strip, its asks as messages and a run's story; Back goes home; the bar switches the
// places (and Settings, T-335 fixes); the drawer opens each applet in its frame; search starts where you are; a private room keeps its words; the ink screen
// reads by shape and word. Screenshots, named like the prototype's, go to test-results/shape-shots (never committed).
// Run: pnpm test:shape
import { test, expect, type Page } from '@playwright/test';
import { bootShape, calls, live, PLOT_NOTE, ROOM, UNI } from './shapeFixture';
import { holdTouch, wordPoint } from './holdMessage';

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

/** A waiting approval's message carries a rule down its left side: its text (the name, the first letter of its body) starts right of the
 *  rule, never under it. The rule is an inset box-shadow on the message or its content; its right edge is that box's left plus its width. */
async function ruleClearsText(page: Page, ref: string) {
  const m = page.locator(`.sh-room .message.approval-waiting[data-ref="${ref}"]`);
  await m.scrollIntoViewIfNeeded();
  const r = await m.evaluate((el) => {
    const boxes = [el, el.querySelector('.message-content')].filter(Boolean) as HTMLElement[];
    const ruled = boxes.find((b) => /inset/.test(getComputedStyle(b).boxShadow) || parseFloat(getComputedStyle(b).borderLeftWidth) > 0);
    if (!ruled) return null;
    const cs = getComputedStyle(ruled);
    const w = /inset/.test(cs.boxShadow) ? parseFloat(/(-?[\d.]+)px 0px 0px/.exec(cs.boxShadow)?.[1] ?? '0') : parseFloat(cs.borderLeftWidth);
    const firstGlyph = (root: Element | null) => {
      if (!root) return null;
      const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.textContent!.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) });
      const t = walk.nextNode() as Text | null;
      if (!t) return null;
      const range = document.createRange(); const i = t.textContent!.search(/\S/); range.setStart(t, i); range.setEnd(t, i + 1);
      return range.getBoundingClientRect().left;
    };
    return { ruleRight: ruled.getBoundingClientRect().left + w, name: firstGlyph(el.querySelector('.message-meta')), body: firstGlyph(el.querySelector('.md, .message-content p')) };
  });
  expect(r, 'the waiting message has its rule').not.toBeNull();
  expect(r!.name!, 'its name starts right of the rule').toBeGreaterThanOrEqual(r!.ruleRight);
  expect(r!.body!, 'its first line starts right of the rule').toBeGreaterThanOrEqual(r!.ruleRight);
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
  // two wait there: T-606, and T-607, which names the room by its old name (the registry's `was`) and so is the same room's
  await expect(row(page, ROOM.family).locator('.sh-row-hush')).toHaveAttribute('data-hushed', '2');
  // (the same private room by an old name no room on this device has: hidden, never in Uni's room)
  await expect(row(page, ROOM.uni).locator('.sh-ask')).toHaveCount(1);
  // an ask for a private place with no room of its own here: home says one more waits, and not a word of it
  await expect(page.locator('.sh-home-unseen')).toHaveAttribute('data-unseen', '1');
  await expect(page.locator('.sh-home-unseen')).toContainText("1 more thing waits in a private place. This device doesn't show it.");
  const dom = await page.evaluate(() => document.documentElement.outerHTML);
  for (const words of ['A line for a place this device lacks', 'T-608']) expect(dom, words).not.toContain(words);
  for (const words of ['Private words about the practice', 'A quiet line that stays in its room', 'T-605', 'A family line that stays at the table', 'T-606',
    'Family words about the seating', 'A kitchen line that stays private', 'T-607']) expect(dom, words).not.toContain(words);
  // the bar counts what wants you: five asks, the three waiting in private rooms, the pinned card, and Teaching's run that waits on you
  await expect(bar(page).getByRole('button', { name: /^Rooms, 10 things want you$/ })).toBeVisible();
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
  await expect(bar(page).getByRole('button', { name: /^Rooms, 8 things want you$/ })).toBeVisible();
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
  await expect(bar(page).getByRole('button', { name: /^Rooms, 9 things want you$/ })).toBeVisible();
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
  await expect(bar(page).getByRole('button', { name: /^Rooms, 9 things want you$/ })).toBeVisible();
});

test('T-335 copy: an ask in a room is words a long press selects (not a button\'s label); a tap on them still opens its sheet', async ({ page }) => {
  await bootShape(page);
  await openRoomFromHome(page, ROOM.uni);
  const ask = page.locator('.message-list .sh-ask-msg[data-id="ask-summary"]');
  const words = ask.locator('.sh-ask-what');
  await holdTouch(page, await wordPoint(words));
  expect((await page.evaluate(() => String(window.getSelection()))).trim()).not.toBe('');
  await expect(page.locator('.sh-ask-sheet')).toHaveCount(0);
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await words.click({ position: { x: 12, y: 8 } });
  await expect(page.locator('.sh-ask-sheet')).toBeVisible();
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
  // the places bar stays in a room (T-335 fixes)
  await expect(bar(page)).toBeVisible();
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
  // "Waits on you" opens the ask to its context (T-335 fixes)
  await strip.locator('.sh-run[data-run="waiting"]').click();
  await expect(page.getByRole('dialog', { name: 'The weekly summary is ready to read' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.sh-ask-sheet')).toHaveCount(0);
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
  await expect(want.locator('.sh-ask-open')).toHaveAttribute('aria-label', /^Wants you: The weekly summary is ready to read/);
  await expect(row(page, ROOM.uni).locator('.sh-run[data-run="moving"] .sh-run-dot')).toHaveCount(1);
  await expect(row(page, ROOM.uni).locator('.sh-run[data-run="moving"]')).toHaveAttribute('aria-label', /^Moving: Reading 14 notes/);
  // a private room's wordless mark: the same filled diamond, and words that say only that something waits
  await expect(row(page, ROOM.quiet).locator('.sh-row-hush .sh-mark-needs')).toHaveText(/^◆\uFE0E?$/);
  await expect(row(page, ROOM.quiet).locator('.sh-row-hush')).toContainText('Something waits in here');
  const count = bar(page).locator('.sh-place-rooms .sh-count');
  await expect(count).toHaveText('10');
  expect(await count.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(0, 0, 0)');
  expect(await page.locator('.sh-pin').first().evaluate((e) => getComputedStyle(e).borderTopColor)).toBe('rgb(0, 0, 0)');
  await shot(page, '11-home-ink');
  await openRoomFromHome(page, ROOM.uni);
  await expect(page.locator('.sh-strip .sh-run[data-run="waiting"] .sh-run-word')).toHaveText('Waits on you');
  await expect(page.locator('.sh-strip .sh-run[data-run="moving"] .sh-run-word')).toHaveText('Moving');
  await shot(page, '12-room-ink');
});

test("a waiting approval's rule sits clear of its message's first letters, in colour and on the ink screen", async ({ page }) => {
  await bootShape(page);
  await openRoomFromHome(page, ROOM.river);
  await ruleClearsText(page, 'rb-card');
  await page.evaluate(() => { document.documentElement.dataset.screen = 'ink'; });
  await ruleClearsText(page, 'rb-card');
});

test("after midnight the room's list starts below its strip: nothing is drawn under it", async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-11T00:20:00') });
  await bootShape(page);
  await openRoomFromHome(page, ROOM.uni);
  await expect(page.locator('.day-divider').first()).toHaveText('Yesterday');
  const [strip, list] = await Promise.all([page.locator('.sh-strip').boundingBox(), page.locator('.sh-room-chat .message-list').boundingBox()]);
  expect(list!.y).toBeGreaterThanOrEqual(strip!.y + strip!.height - 0.5);
  // scrolled to its top, the first divider is whole, under the strip
  await page.locator('.sh-room-chat .message-list').hover();
  await page.mouse.wheel(0, -2000);
  await expect.poll(() => page.locator('.sh-room-chat .message-list').evaluate((el) => el.scrollTop)).toBe(0);
  const d = await page.locator('.day-divider').first().boundingBox();
  expect(d!.y).toBeGreaterThanOrEqual(strip!.y + strip!.height);
});

test("one question, one set of buttons: an ask threaded under the room's newest message takes the place of its quick replies", async ({ page }) => {
  await bootShape(page);
  await openRoomFromHome(page, ROOM.river);
  // Mira's yes-or-no question is the newest message, and Uni's ask T-602 is threaded under it (reply_root)
  await expect(page.locator('.sh-ask-msg[data-id="ask-walk"]').getByRole('button', { name: 'Friday instead' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Quick replies' })).toHaveCount(0);
  // answered, the ask leaves: Mira's question offers its quick replies again
  await page.locator('.sh-ask-msg[data-id="ask-walk"]').getByRole('button', { name: 'Friday instead' }).click();
  await expect(page.locator('.sh-ask-msg[data-id="ask-walk"]')).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Quick replies' }).getByRole('button', { name: 'Yes' })).toBeVisible();
});

test("the composer's placeholder is never cut off: a room name that doesn't fit on a phone leaves just \"Message\"", async ({ page }) => {
  await bootShape(page);
  await openRoomFromHome(page, ROOM.river);
  const field = page.locator('.composer textarea');
  await expect(field).toHaveAttribute('placeholder', 'Message');
  await expect(field).toHaveAttribute('aria-label', /Riverbend Commons/);
  await page.locator('.sh-room').getByRole('button', { name: 'Back to rooms' }).click();
  await openRoomFromHome(page, ROOM.uni);
  await expect(field).toHaveAttribute('placeholder', 'Message Uni');
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
  // room for the whole name
  await expect(page.locator('.composer textarea')).toHaveAttribute('placeholder', 'Message Riverbend Commons');
  await ruleClearsText(page, 'rb-card');
  await page.evaluate(() => { document.documentElement.dataset.screen = 'ink'; });
  await ruleClearsText(page, 'rb-card');
  await page.evaluate(() => { delete document.documentElement.dataset.screen; });
  // a sheet covers the place, never the rail: Settings on the rail opens over an ask's sheet (T-335 fixes)
  await page.locator('.sh-room').getByRole('button', { name: 'Back to rooms' }).click();
  await openRoomFromHome(page, ROOM.uni);
  await page.locator('.sh-strip .sh-run[data-run="waiting"]').click();
  await expect(page.locator('.sh-ask-sheet')).toBeVisible();
  await bar(page).getByRole('button', { name: 'Settings' }).click();
  await expect(page.locator('.sh-ask-sheet')).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
});
});

test("Settings from the bar, Escape out of a room, a thread's Back steps to its room first", async ({ page }) => {
  await bootShape(page);
  await expect(home(page)).toBeVisible();
  await bar(page).getByRole('button', { name: 'Settings' }).click();
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

// ── T-335 fixes (11-11), from Aaron's first use of 0.4.0 ──

/** The bar is on screen and nothing is drawn over it: the topmost thing at its middle is the bar. */
const barOnTop = (page: Page) => page.evaluate(() => {
  const b = document.querySelector('.sh-bar')?.getBoundingClientRect();
  if (!b || !b.height) return false;
  const el = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
  return el?.closest('.sh-bar') ? true : `covered by ${el?.outerHTML.slice(0, 120)}`;
});
const bottomOf = async (page: Page, sel: string) => { const b = await page.locator(sel).first().boundingBox(); return b!.y + b!.height; };
const topOf = async (page: Page, sel: string) => (await page.locator(sel).first().boundingBox())!.y;

test('"Waits on you" opens to its context: the next action, why now, the body with live links, and its buttons', async ({ page }) => {
  await bootShape(page);
  await openRoomFromHome(page, ROOM.uni);
  await page.locator('.sh-strip .sh-run[data-run="waiting"]').click();
  const sheet = page.getByRole('dialog', { name: 'The weekly summary is ready to read' });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('.sh-ask-sheet-kind')).toHaveText(/Waits on you · For you to know · T-601 · in Uni/);
  await expect(sheet.locator('.sh-ask-next')).toHaveText('Read the summary of the week');
  await expect(sheet.locator('.sh-ask-facts')).toContainText('Read it now, or save it for Sunday.');
  // the body as tasks.py wrote it, rendered: its sections, its steps, its links live
  await expect(sheet.locator('.sh-ask-context .md-h')).toHaveText(['Why', 'Steps', 'Links', 'Time', 'Already answered']);
  await expect(sheet.locator('.sh-ask-context li').first()).toHaveText('Open the summary');
  expect((await calls(page, 'vault_note')).map((c) => c.args.noteRef)).toContain('ask-summary');
  await sheet.locator('.sh-ask-context a[href="https://example.com/notes/week-45"]').click();
  await expect.poll(async () => (await calls(page, 'open_link')).map((c) => c.args.url)).toContain('https://example.com/notes/week-45');
  // a tell: Seen, and Archive
  await expect(sheet.locator('.sh-ask-btn')).toHaveText(['Seen', 'Archive']);
  await shot(page, '06-ask-sheet');
  // a note it cites by id opens as the note, the sheet out of its way
  // (it cites the note by its bare id; the link reads as the note's title)
  expect(await page.evaluate(() => (window as any).__tasks.find((t: any) => t.id === 'ask-summary').content)).toContain(`uni:${PLOT_NOTE}`);
  await sheet.locator('.sh-ask-context').getByRole('link', { name: 'Plot map, printed' }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.locator('.note-sheet')).toContainText('The printed plot map for the shed wall.');
  await page.locator('.note-sheet .note-back').click();
  await expect(page.locator('.note-sheet')).toHaveCount(0);
  // Seen from the sheet: one write, its room told, the sheet and the ask gone
  await page.locator('.sh-strip .sh-run[data-run="waiting"]').click();
  await sheet.getByRole('button', { name: /^Seen:/ }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.locator('.sh-ask-msg[data-id="ask-summary"]')).toHaveCount(0);
  await expect.poll(async () => (await calls(page, 'post_message')).map((c) => [c.args.channel, c.args.body])).toContainEqual([ROOM.uni, 'T-601: seen.']);
  const seen = (await calls(page, 'vault_transition')).filter((c) => c.args.id === 'ask-summary');
  expect(seen).toHaveLength(1);
  expect(seen[0].args).toMatchObject({ from: 'open', to: 'done', metadata: { needs_aaron: false, needs_aaron_why: 'seen' } });
});

test('each kind has its buttons: Done hands a do ask back to its room, Not now puts one off, Archive takes one out of view; a run waiting on you opens its ask', async ({ page }) => {
  await bootShape(page);
  // a run that waits on you opens the ask on its task (it lives in another room), not a story with nothing to do
  await row(page, ROOM.teach).locator('.sh-run[data-run="waiting"]').click();
  const key = page.getByRole('dialog', { name: 'Paste the boiler portal key' });
  await expect(key).toBeVisible();
  await expect(key.locator('.sh-ask-sheet-kind')).toHaveText(/To do · T-609 · in House/);
  await expect(key.locator('.sh-ask-next')).toHaveText('Paste the portal key into the boiler page');
  await expect(key.locator('.sh-ask-facts')).toContainText('No default: it waits for you');
  await expect(key.locator('.sh-ask-btn')).toHaveText(['Done', 'Not now', 'Archive']);
  // Done: out of his view (Seen's write: it stays open), and its room is told, addressed to its Uni, to take it back
  await key.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(key).toHaveCount(0);
  await expect.poll(async () => (await calls(page, 'post_message')).map((c) => [c.args.channel, c.args.body, c.args.recipients]))
    .toContainEqual([ROOM.house, 'T-609: I did this. Hand it back to this room for any follow-up (tasks.py handback T-609), then post [done T-609].', [UNI]]);
  const done = (await calls(page, 'vault_patch_meta')).filter((c) => c.args.id === 'ask-key');
  expect(done).toHaveLength(1);
  expect(done[0].args.metadata).toMatchObject({ needs_aaron: false, needs_aaron_why: 'seen' });
  await expect(row(page, ROOM.house).locator('.sh-ask')).toHaveCount(0);
  // a choose ask: its options and Not now, inline on home too; Not now leaves it open with its room, quietly
  await expect(row(page, ROOM.river).locator('.sh-ask-btn')).toHaveText(['Yes, Thursday 2pm', 'Friday instead', 'Not now']);
  await row(page, ROOM.river).locator('.sh-ask-btn[data-act="notnow"]').click();
  await expect(row(page, ROOM.river).locator('.sh-ask')).toHaveCount(0);
  await expect.poll(async () => (await calls(page, 'post_message')).map((c) => [c.args.channel, c.args.body, c.args.recipients]))
    .toContainEqual([ROOM.river, 'T-602: not now. It stays open here; ask again when it needs my steer.', []]);
  expect((await calls(page, 'vault_patch_meta')).filter((c) => c.args.id === 'ask-walk')).toHaveLength(1);
  // a look ask: Open and Seen
  await row(page, ROOM.studio).locator('.sh-ask-open').click();
  const cut = page.getByRole('dialog', { name: 'Cut 3 is ready to watch' });
  await expect(cut.locator('.sh-ask-btn')).toHaveText(['Open ↗', 'Seen', 'Archive']);
  await cut.getByRole('button', { name: 'Close' }).click();
  // an ask with no body and no next action: what there is, said so, and its buttons all the same; Archive takes it out of view
  await row(page, ROOM.post).locator('.sh-ask-open').click();
  const sign = page.getByRole('dialog', { name: 'Sign What the garden taught us and post it?' });
  await expect(sign.locator('.sh-ask-fault')).toHaveText('This ask came without its context. You can still answer it or archive it.');
  await expect(sign.locator('.sh-ask-btn')).toHaveText(['Sign and post', 'Not yet', 'Not now', 'Archive']);
  await sign.getByRole('button', { name: 'Archive' }).click();
  await expect(sign).toHaveCount(0);
  const archived = (await calls(page, 'vault_transition')).filter((c) => c.args.id === 'ask-sign');
  expect(archived).toHaveLength(1);
  expect(archived[0].args).toMatchObject({ from: 'open', to: 'archived', metadata: null });
  await expect.poll(async () => (await calls(page, 'post_message')).map((c) => [c.args.channel, c.args.body, c.args.recipients]))
    .toContainEqual([ROOM.post, "T-604: archived. It's out of my view; open a new ask if it still needs me.", []]);
  await expect(row(page, ROOM.post).locator('.sh-ask')).toHaveCount(0);
});

test('the bar shows everywhere: inside a room, under its run story and an ask, on a phone and the Daylight; it steps aside only for the keyboard', async ({ page }) => {
  await bootShape(page);
  for (const size of [{ width: 390, height: 844 }, { width: 828, height: 1104 }]) {
    await page.setViewportSize(size);
    await openRoomFromHome(page, ROOM.uni);
    await expect(bar(page)).toBeVisible();
    expect(await barOnTop(page)).toBe(true);
    // the composer sits above the bar, whole
    expect(await bottomOf(page, '.composer')).toBeLessThanOrEqual(await topOf(page, '.sh-bar') + 0.5);
    // a run's story opens above it; the bar stays
    await page.locator('.sh-strip .sh-run[data-run="moving"]').click();
    const story = page.getByRole('dialog', { name: "Tidying the week's notes" });
    await expect(story).toBeVisible();
    expect(await barOnTop(page)).toBe(true);
    expect(await bottomOf(page, '.sh-story')).toBeLessThanOrEqual(await topOf(page, '.sh-bar') + 0.5);
    if (size.width === 390) await shot(page, '07-story-with-bar');
    await story.getByRole('button', { name: 'Close' }).click();
    // and an ask's sheet
    await page.locator('.sh-strip .sh-run[data-run="waiting"]').click();
    await expect(page.locator('.sh-ask-sheet')).toBeVisible();
    expect(await barOnTop(page)).toBe(true);
    // the bar is live under it: Settings from the bar puts the sheet away
    await bar(page).getByRole('button', { name: 'Settings' }).click();
    await expect(page.locator('.sh-ask-sheet')).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    await bar(page).getByRole('button', { name: 'Settings' }).click();
    await page.locator('.sh-strip .sh-run[data-run="waiting"]').click();
    await page.locator('.sh-ask-sheet').getByRole('button', { name: 'Close' }).click();
    // the keyboard: typing in the composer, the bar steps aside and the composer stays in view; done typing, it is back
    await page.locator('.composer textarea').focus();
    await expect(bar(page)).toBeHidden();
    const box = await page.locator('.composer textarea').boundingBox();
    expect(box!.y + box!.height).toBeLessThanOrEqual(size.height);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect(bar(page)).toBeVisible();
    if (size.width === 390) await shot(page, '08-room-with-bar');
    // the bar's Rooms takes you home from inside a room
    await bar(page).getByRole('button', { name: /^Rooms/ }).click();
    await expect(home(page)).toBeVisible();
  }
});

test('Settings is a place on the bar, from home and from inside a room, with Claude usage first and every screen it reached', async ({ page }) => {
  await bootShape(page);
  await expect(home(page)).toBeVisible();
  await bar(page).getByRole('button', { name: 'Settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  // Claude usage at the top
  await expect(settings.getByRole('region', { name: 'Claude accounts' })).toBeVisible();
  expect(await page.evaluate(() => document.querySelector('.sh-overlay .settings')?.firstElementChild?.matches('.usage-card') ?? false)).toBe(true);
  await expect(bar(page).getByRole('button', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');
  expect(await barOnTop(page)).toBe(true);
  await shot(page, '09-settings');
  // every screen the old Settings reached: approvals, motion, pairing, the vault, the self-test
  await expect(settings.getByRole('region', { name: 'Approvals' })).toBeVisible();
  await expect(settings.getByText('Calm screen')).toBeVisible();
  await expect(settings.getByRole('button', { name: 'Pair a device' })).toBeVisible();
  await expect(settings.getByRole('button', { name: 'Forget this device key' })).toBeVisible();
  await expect(settings.getByText('Areas and projects vault')).toBeVisible();
  await settings.getByText('Developer').click();
  await expect(settings.getByRole('button', { name: 'Run sandbox self-test' })).toBeVisible();
  // a second tap on Settings puts it away
  await bar(page).getByRole('button', { name: 'Settings' }).click();
  await expect(settings).toBeHidden();
  // from inside a room: the same place, over the room; Close goes back to the room
  await openRoomFromHome(page, ROOM.river);
  await bar(page).getByRole('button', { name: 'Settings' }).click();
  await expect(settings.getByRole('region', { name: 'Claude accounts' })).toBeVisible();
  await settings.getByRole('button', { name: 'Close' }).click();
  await expect(settings).toBeHidden();
  await expect(page.locator('.sh-room h1')).toHaveText('Riverbend Commons');
  // home has no gear of its own: one way in
  await bar(page).getByRole('button', { name: /^Rooms/ }).click();
  await expect(page.locator('.sh-home').getByRole('button', { name: 'Settings' })).toHaveCount(0);
});

test("a write that fails keeps the ask's sheet open, with why, and the next tap goes through", async ({ page }) => {
  await bootShape(page, { writeFails: 1 });
  await row(page, ROOM.house).locator('.sh-ask-open').click();
  const key = page.getByRole('dialog', { name: 'Paste the boiler portal key' });
  await key.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(key.getByRole('alert')).toHaveText(/^Couldn't mark it done: vault unreachable/);
  expect(await calls(page, 'post_message')).toEqual([]);
  await key.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(key).toHaveCount(0);
  await expect.poll(async () => (await calls(page, 'post_message')).map((c) => c.args.channel)).toEqual([ROOM.house]);
});

test("a public room's run that waits on a private room's ask opens its story, never the ask", async ({ page }) => {
  await bootShape(page, { leakRun: true });
  await row(page, ROOM.garden).locator('.sh-run[data-run="waiting"]').click();
  await expect(page.getByRole('dialog', { name: 'Checking the shed lock' })).toBeVisible();
  await expect(page.locator('.sh-ask-sheet')).toHaveCount(0);
  const dom = await page.evaluate(() => document.documentElement.outerHTML);
  for (const words of ['A quiet line that stays in its room', 'T-605']) expect(dom, words).not.toContain(words);
});

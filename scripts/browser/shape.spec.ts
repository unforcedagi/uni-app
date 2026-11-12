// T-335 one ask: removed the pinned approval's countdown clock (home no longer pins approvals: a waiting card is a card on its room's row)
// and the ask sheet's modal checks (Escape closing it, Settings over it), because an ask now opens in place, in its card (no sheet).
// T-335 the shape, end to end on the real build with Tauri faked (shapeFixture.ts, a made-up world): home is the rooms, newest first, with
// what moves and what wants you; answering an ask from home writes the vault once and tells that room (flat, never in a thread); an approval
// card waits on its room's row and leaves once approved; a room has its strip, its asks as cards and a run's story; Back goes home; the bar switches the
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

/** (T-335 one ask) Put the room's card out of view: the reader scrolls the list to its top, so "Waits on you" has to bring it back. */
async function cardOutOfView(page: Page, card: ReturnType<Page['locator']>) {
  await expect(card).toHaveCount(1);
  const list = page.locator('.sh-room-chat .message-list');
  await list.hover();
  await page.mouse.wheel(0, -4000);
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBe(0);
  await expect(card).not.toBeInViewport();
}
/** (T-335 one ask) Uni's room with a long chat (made-up lines), so its card can be out of view: added before the room is opened. */
const longUni = (page: Page) => page.evaluate((room) => {
  const w = window as any, l = w.__msgs[room], last = l[l.length - 1];
  for (let i = 1; i <= 30; i++) l.push({ ...last, ref: `u-long-${i}`, body: `A made-up line about the week, number ${i}.`, ts: last.ts + i });
}, ROOM.uni);

/** A waiting approval's message carries a rule down its left side: its text (the name, the first letter of its body) starts right of the
 *  rule, never under it. The rule is an inset box-shadow on the message or its content; its right edge is that box's left plus its width.
 *  (T-335 one ask: a waiting card's body is its one card, `.sh-card`, drawn at its message; a prompt's is still its markdown.) */
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
    return { ruleRight: ruled.getBoundingClientRect().left + w, name: firstGlyph(el.querySelector('.message-meta')), body: firstGlyph(el.querySelector('.sh-card, .md, .message-content p')) };
  });
  expect(r, 'the waiting message has its rule').not.toBeNull();
  expect(r!.body, 'its body is drawn').not.toBeNull();
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
  // the bar counts what wants you (T-335 one ask: the cards on the rows): five asks (T-601, T-602, T-603, T-604, T-609), the three waiting in
  // private rooms (T-605, T-606, T-607), and the approval card on Riverbend's row; Teaching's run that waits on you is not an ask, and T-608
  // (no room on this device) is said apart. The rows' own counts add up to it.
  await expect(row(page, ROOM.river).locator('[data-card="rb-card"]')).toHaveAttribute('data-source', 'card');
  await expect(bar(page).getByRole('button', { name: /^Rooms, 9 things want you$/ })).toBeVisible();
  expect(await page.locator('.sh-row[data-wants]').evaluateAll((els) => els.reduce((n, e) => n + Number(e.getAttribute('data-wants')), 0))).toBe(9);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await shot(page, '01-home');
});

test('answering from home: Seen and a choice each write the vault once, tell that room in its main line, and the ask leaves its row', async ({ page }) => {
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
  await expect(row(page, ROOM.river).locator('[data-card="ask-walk"]')).toHaveCount(0);
  await expect.poll(async () => (await calls(page, 'post_message')).map((c) => [c.args.channel, c.args.body, c.args.recipients])).toContainEqual([ROOM.river, 'T-602: Yes, Thursday 2pm', [UNI]]);
  // (T-335 one ask: flat, though T-602 names a reply_root: never a thread reply)
  expect((await calls(page, 'post_message')).map((c) => c.args.replyTo)).toEqual([null, null]);
  const answered = (await calls(page, 'vault_transition')).filter((c) => c.args.id === 'ask-walk');
  expect(answered).toHaveLength(1);
  expect(answered[0].args.metadata).toMatchObject({ answer: 'Yes, Thursday 2pm', decided: 'Yes, Thursday 2pm' });
  // nothing was posted anywhere else
  expect((await calls(page, 'post_message')).map((c) => c.args.channel).sort()).toEqual([ROOM.river, ROOM.uni]);
  await expect(bar(page).getByRole('button', { name: /^Rooms, 7 things want you$/ })).toBeVisible();
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
  await expect(bar(page).getByRole('button', { name: /^Rooms, 8 things want you$/ })).toBeVisible();
});

test('an approval card waits on its room\'s row, opens to its whole text, is approved in place, and leaves', async ({ page }) => {
  await bootShape(page);
  // (T-335 one ask: no pin over the rooms and no countdown: the card is one of Riverbend's cards, the card itself drawn in its frame)
  await expect(page.locator('.sh-pin')).toHaveCount(0);
  const card = row(page, ROOM.river).locator('[data-card="rb-card"]');
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('data-source', 'card');
  await expect(row(page, ROOM.river)).toHaveAttribute('data-wants', '2');
  // T-335 cards expand: on home, the card opens the same way it does in its room (moved here from cardsExpand.spec.ts: its world has no room
  // on Riverbend's row for an approval card)
  const sealed = card.getByRole('region', { name: 'Approve use of billing', exact: true });
  await sealed.getByRole('button', { name: 'Show all' }).click();
  await expect(sealed.getByRole('definition').filter({ hasText: 'Send the October invoice' }).first()).toBeVisible();
  await expect(sealed.getByRole('button', { name: 'Show less' })).toBeVisible();
  await sealed.getByRole('button', { name: 'Approve' }).click();
  await expect.poll(async () => (await calls(page, 'sealed_answer')).map((c) => c.args.decision)).toEqual(['approve']);
  await expect(card).toHaveCount(0);
  await expect(row(page, ROOM.river)).toHaveAttribute('data-wants', '1');
  await expect(bar(page).getByRole('button', { name: /^Rooms, 8 things want you$/ })).toBeVisible();
});

test('T-335 copy: an ask in a room is words a long press selects (not a button\'s label); a tap on them still opens it in place', async ({ page }) => {
  await bootShape(page);
  await openRoomFromHome(page, ROOM.uni);
  const ask = page.locator('.message-list [data-card="ask-summary"]');
  const words = ask.locator('.sh-ask-what');
  const toggle = ask.locator('[data-card-open]');
  await holdTouch(page, await wordPoint(words));
  expect((await page.evaluate(() => String(window.getSelection()))).trim()).not.toBe('');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(ask.locator('.sh-ask-facts')).toHaveCount(0);
  // a mouse's double-click selects a word and opens nothing; a single click (or a tap) opens it in place
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await words.dblclick({ position: { x: 30, y: 8 } });
  await page.waitForTimeout(500);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await words.click({ position: { x: 12, y: 8 } });
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(ask.locator('.sh-ask-facts')).toBeVisible();
});

test("a room: its strip, its ask as a message, the run's story from the moving line, the jump to the ask, and Back to home", async ({ page }) => {
  await bootShape(page);
  await longUni(page);
  await openRoomFromHome(page, ROOM.uni);
  const room = page.locator('.sh-room');
  await expect(room.getByRole('heading', { name: 'Uni', level: 1 })).toBeVisible();
  const strip = room.locator('.sh-strip');
  await expect(strip.locator('.sh-run[data-run="moving"]')).toContainText('MovingReading 14 notes from this week');
  await expect(strip.locator('.sh-run[data-run="waiting"]')).toContainText('Waits on youThe weekly summary is ready to read');
  // the ask (a task: it has no message here) is a card at the end of the room's chat, after its last message, inside the scroller
  const ask = page.locator('.message-list [data-card="ask-summary"]');
  await expect(ask).toContainText('The weekly summary is ready to read');
  await expect(ask.getByRole('button', { name: 'Seen', exact: true })).toHaveAttribute('title', /^Seen: /);
  const after = await page.evaluate(() => { const a = document.querySelector('[data-card="ask-summary"]')!, last = [...document.querySelectorAll('.message-list article.message')].pop()!; return !!(last.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING); });
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
  // "Waits on you" brings the ask's card into view (T-335 one ask: no sheet; it opens in place)
  await cardOutOfView(page, ask);
  await strip.locator('.sh-run[data-run="waiting"]').click();
  await expect(ask).toBeInViewport();
  await expect(page.getByRole('dialog')).toHaveCount(0);
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
  // wants you: a filled diamond plus its words (T-335 one ask: on home the card no longer says "wants you" in words, for a screen reader
  // either: reported, not asserted); moving: a dot plus its line; counts: black pills with numbers
  const want = row(page, ROOM.uni).locator('.sh-ask-wants');
  await expect(want.locator('.sh-ask-mark')).toHaveText('◆');
  // (T-335 one ask: the card is named by its words, and its open control says what it does)
  await expect(want).toHaveAccessibleName('The weekly summary is ready to read');
  await expect(want.locator('[data-card-open]')).toHaveAccessibleName('Open this ask');
  await expect(row(page, ROOM.uni).locator('.sh-run[data-run="moving"] .sh-run-dot')).toHaveCount(1);
  await expect(row(page, ROOM.uni).locator('.sh-run[data-run="moving"]')).toHaveAttribute('aria-label', /^Moving: Reading 14 notes/);
  // a private room's wordless mark: the same filled diamond, and words that say only that something waits
  await expect(row(page, ROOM.quiet).locator('.sh-row-hush .sh-mark-needs')).toHaveText(/^◆\uFE0E?$/);
  await expect(row(page, ROOM.quiet).locator('.sh-row-hush')).toContainText('Something waits in here');
  const count = bar(page).locator('.sh-place-rooms .sh-count');
  await expect(count).toHaveText('9');
  expect(await count.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(0, 0, 0)');
  // the approval card waiting on Riverbend's row (once pinned over the rooms) is outlined in black like every card
  expect(await row(page, ROOM.river).locator('[data-card="rb-card"]').evaluate((e) => getComputedStyle(e).borderTopColor)).toBe('rgb(0, 0, 0)');
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
  // Mira's yes-or-no question is the newest message, and Uni's ask T-602 was asked under it (reply_root)
  await expect(page.locator('[data-card="ask-walk"]').getByRole('button', { name: 'Friday instead' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Quick replies' })).toHaveCount(0);
  // answered, the ask leaves: Mira's question offers its quick replies again
  await page.locator('[data-card="ask-walk"]').getByRole('button', { name: 'Friday instead' }).click();
  await expect(page.locator('[data-card="ask-walk"]')).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Quick replies' }).getByRole('button', { name: 'Yes' })).toBeVisible();
  // its answer is in the room's main line, not threaded under Mira's question (T-335 one ask)
  await expect.poll(async () => (await calls(page, 'post_message')).map((c) => [c.args.channel, c.args.body, c.args.replyTo])).toEqual([[ROOM.river, 'T-602: Friday instead', null]]);
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
  // (T-335 one ask: the check that Settings on the rail opens over an ask's sheet is gone with the sheet)
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

test('"Waits on you" brings its card into view, and the card opens in place to its context: the next action, why now, the body with live links, and its buttons', async ({ page }) => {
  await bootShape(page);
  await longUni(page);
  await openRoomFromHome(page, ROOM.uni);
  const card = page.locator('.sh-room [data-card="ask-summary"]');
  await cardOutOfView(page, card);
  await page.locator('.sh-strip .sh-run[data-run="waiting"]').click();
  await expect(card).toBeInViewport();
  // (T-335 one ask: no sheet; the card opens where it is)
  await card.locator('[data-card-open]').click();
  await expect(card.locator('[data-card-open]')).toHaveAttribute('aria-expanded', 'true');
  await expect(card.locator('.sh-ask-meta')).toHaveText(/wants you · For you to know · T-601/);
  await expect(card.locator('.sh-ask-next')).toHaveText('Read the summary of the week');
  await expect(card.locator('.sh-ask-facts')).toContainText('Asked by#Uni');
  await expect(card.locator('.sh-ask-facts')).toContainText('Read it now, or save it for Sunday.');
  // the body as tasks.py wrote it, rendered: its sections, its steps, its links live
  await expect(card.locator('.sh-ask-context .md-h')).toHaveText(['Why', 'Steps', 'Links', 'Time', 'Already answered']);
  await expect(card.locator('.sh-ask-context li').first()).toHaveText('Open the summary');
  expect((await calls(page, 'vault_note')).map((c) => c.args.noteRef)).toContain('ask-summary');
  await card.locator('.sh-ask-context a[href="https://example.com/notes/week-45"]').click();
  await expect.poll(async () => (await calls(page, 'open_link')).map((c) => c.args.url)).toContain('https://example.com/notes/week-45');
  // a tell: Seen, Reply in the room and Archive
  await expect(card.locator('.sh-ask-btn')).toHaveText(['Seen', 'Reply in the room', 'Archive']);
  await shot(page, '06-ask-open');
  // a note it cites by id opens as the note
  // (it cites the note by its bare id; the link reads as the note's title)
  expect(await page.evaluate(() => (window as any).__tasks.find((t: any) => t.id === 'ask-summary').content)).toContain(`uni:${PLOT_NOTE}`);
  await card.locator('.sh-ask-context').getByRole('link', { name: 'Plot map, printed' }).click();
  await expect(page.locator('.note-sheet')).toContainText('The printed plot map for the shed wall.');
  await page.locator('.note-sheet .note-back').click();
  await expect(page.locator('.note-sheet')).toHaveCount(0);
  // Seen from the opened card: one write, its room told, the card gone
  await card.getByRole('button', { name: 'Seen', exact: true }).click();
  await expect(card).toHaveCount(0);
  await expect.poll(async () => (await calls(page, 'post_message')).map((c) => [c.args.channel, c.args.body])).toContainEqual([ROOM.uni, 'T-601: seen.']);
  const seen = (await calls(page, 'vault_transition')).filter((c) => c.args.id === 'ask-summary');
  expect(seen).toHaveLength(1);
  expect(seen[0].args).toMatchObject({ from: 'open', to: 'done', metadata: { needs_aaron: false, needs_aaron_why: 'seen' } });
});

test('T-335 asks in tune: each button says what it does; I did it hands a do ask back, Later puts one off to a day it names, Reply in the room makes its room\'s composer answer it (never a new chat), Archive takes one out of view', async ({ page }) => {
  await bootShape(page);
  // Later's day, as the page reckons it (three days on, local)
  const d = new Date(); d.setDate(d.getDate() + 3);
  const day = d.toLocaleDateString('en-US', { weekday: 'short' });
  const mmdd = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const later = `Later · ${day}`;
  // a run that waits on you, when its task is an ask, opens that ask's room (T-609 lives in House), not a story with nothing to do
  await row(page, ROOM.teach).locator('.sh-run[data-run="waiting"]').click();
  await expect(page.locator('.sh-room h1')).toHaveText('House');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const key = page.locator('.sh-room [data-card="ask-key"]');
  await expect(key).toBeVisible();
  await expect(key.locator('.sh-ask-meta')).toHaveText(/wants you · To do · T-609/);
  await key.locator('[data-card-open]').click();
  await expect(key.locator('.sh-ask-next')).toHaveText('Paste the portal key into the boiler page');
  await expect(key.locator('.sh-ask-facts')).toContainText('No default: it waits for you');
  // the words say what happens: no Done, no Not now
  await expect(key.locator('.sh-ask-btn')).toHaveText(['I did it', 'Seen', later, 'Reply in the room', 'Archive']);
  // and the opened card says it beside them, and that none of them starts a new chat or a thread
  await expect(key.locator('.sh-ask-does dt')).toHaveText(['I did it', 'Seen', later, 'Reply in the room', 'Archive']);
  await expect(key.locator('.sh-ask-does dd')).toHaveText([
    'Ends it and tells #House, which does any follow-up',
    'Ends it for good; #House sees it on its next turn',
    `Off your list until ${day} ${mmdd}, then back`,
    "Your words go to #House's main line, quoting this, and end it",
    'Off your list for good; #House sees it on its next turn',
  ]);
  await expect(key.locator('.sh-ask-nochat')).toHaveText("No button here starts a new chat or a thread. Your words go to #House's main line.");
  await key.locator('.sh-ask-does').scrollIntoViewIfNeeded();
  await shot(page, 'ask-open-buttons');
  // Reply in the room: House's composer answers it (T-335 one ask: a chip says so; nothing is put in the composer); nothing is sent or written
  const posted = (await calls(page, 'post_message')).length;
  await key.getByRole('button', { name: 'Reply in the room' }).click();
  await expect(page.locator('.sh-room h1')).toHaveText('House');
  await expect(page.locator('.composer textarea')).toHaveAttribute('placeholder', 'Message House');
  await expect(page.locator('.composer-answering')).toHaveText(/Answering Paste the boiler portal key: what you send goes to the main line as its answer\./);
  await expect(page.locator('.composer textarea')).toHaveValue('');
  await shot(page, 'ask-reply-in-room');
  expect((await calls(page, 'post_message')).length).toBe(posted);
  expect((await calls(page, 'vault_patch_meta')).filter((c) => c.args.id === 'ask-key')).toHaveLength(0);
  expect((await calls(page, 'vault_transition')).filter((c) => c.args.id === 'ask-key')).toHaveLength(0);
  // he can stop answering: the chip goes, the card still waits
  await page.getByRole('button', { name: 'Stop answering' }).click();
  await expect(page.locator('.composer-answering')).toHaveCount(0);
  // I did it: out of his view (Seen's write: it stays open), and its room is told, addressed to its Uni, to take it back, in its main line
  await key.getByRole('button', { name: 'I did it', exact: true }).click();
  await expect(key).toHaveCount(0);
  await expect.poll(async () => (await calls(page, 'post_message')).map((c) => [c.args.channel, c.args.body, c.args.recipients, c.args.replyTo]))
    .toContainEqual([ROOM.house, 'T-609: I did this. Hand it back to this room for any follow-up (tasks.py handback T-609), then post [done T-609].', [UNI], null]);
  const done = (await calls(page, 'vault_patch_meta')).filter((c) => c.args.id === 'ask-key');
  expect(done).toHaveLength(1);
  expect(done[0].args.metadata).toMatchObject({ needs_aaron: false, needs_aaron_why: 'seen' });
  await page.getByRole('button', { name: 'Back to rooms' }).click();
  await expect(home(page)).toBeVisible();
  await expect(row(page, ROOM.house).locator('.sh-ask')).toHaveCount(0);
  // a choose ask: its options, Seen and Later, inline on home too; Later writes the snooze alone and tells its room the day, quietly
  const walk = row(page, ROOM.river).locator('[data-card="ask-walk"]');
  await expect(walk.locator('.sh-ask-btn')).toHaveText(['Yes, Thursday 2pm', 'Friday instead', 'Seen', later]);
  await walk.locator('.sh-ask-btn[data-act="later"]').click();
  await expect(walk).toHaveCount(0);
  await expect.poll(async () => (await calls(page, 'post_message')).map((c) => [c.args.channel, c.args.body, c.args.recipients, c.args.replyTo]))
    .toContainEqual([ROOM.river, `T-602: later. It's back on my list ${day} ${mmdd}.`, [], null]);
  const put = (await calls(page, 'vault_patch_meta')).filter((c) => c.args.id === 'ask-walk');
  expect(put).toHaveLength(1);
  expect(put[0].args.metadata).toEqual({ snoozed_until: `${d.getFullYear()}-${mmdd}` });
  // it stays off after the next read, though the sweep hasn't written needs_aaron yet
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForTimeout(500);
  await expect(walk).toHaveCount(0);
  // a look ask: Open and Seen (and, opened, Reply in the room and Archive)
  const cut = row(page, ROOM.studio).locator('[data-card="ask-cut"]');
  await expect(cut.locator('.sh-ask-btn')).toHaveText(['Open ↗', 'Seen']);
  await cut.locator('[data-card-open]').click();
  await expect(cut.locator('.sh-ask-btn')).toHaveText(['Open ↗', 'Seen', 'Reply in the room', 'Archive']);
  await cut.getByRole('button', { name: 'Show less' }).click();
  await expect(cut.locator('.sh-ask-btn')).toHaveText(['Open ↗', 'Seen']);
  // an ask with no body and no next action: what there is, said so, and its buttons all the same; Archive takes it out of view
  const sign = row(page, ROOM.post).locator('[data-card="ask-sign"]');
  await sign.locator('[data-card-open]').click();
  await expect(sign.locator('.sh-ask-fault')).toHaveText('This ask came without its context. You can still answer it or archive it.');
  await expect(sign.locator('.sh-ask-btn')).toHaveText(['Sign and post', 'Not yet', 'Seen', later, 'Reply in the room', 'Archive']);
  await sign.getByRole('button', { name: 'Archive' }).click();
  await expect(sign).toHaveCount(0);
  const archived = (await calls(page, 'vault_transition')).filter((c) => c.args.id === 'ask-sign');
  expect(archived).toHaveLength(1);
  expect(archived[0].args).toMatchObject({ from: 'open', to: 'archived', metadata: null });
  await expect.poll(async () => (await calls(page, 'post_message')).map((c) => [c.args.channel, c.args.body, c.args.recipients]))
    .toContainEqual([ROOM.post, "T-604: archived. It's out of my view; open a new ask if it still needs me.", []]);
  await expect(row(page, ROOM.post).locator('.sh-ask')).toHaveCount(0);
});

test('T-335 one ask: Reply in the room on a task, from home: its room opens answering it; what he sends is its answer, one vault write and "T-NN: his words" in the main line', async ({ page }) => {
  await bootShape(page);
  const onHome = row(page, ROOM.studio).locator('[data-card="ask-cut"]');
  await onHome.locator('[data-card-open]').click();
  await onHome.getByRole('button', { name: 'Reply in the room' }).click();
  await expect(page.locator('.sh-room h1')).toHaveText('Studio');
  await expect(page.locator('.composer-answering')).toContainText('Cut 3 is ready to watch');
  await expect(page.locator('.composer textarea')).toHaveValue('');
  expect(await calls(page, 'post_message')).toEqual([]);
  const cut = page.locator('.sh-room [data-card="ask-cut"]');
  await page.locator('.composer textarea').fill('Watched it: trim the last shot');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(async () => (await calls(page, 'post_message')).map((c) => [c.args.channel, c.args.body, c.args.recipients, c.args.replyTo]))
    .toEqual([[ROOM.studio, 'T-603: Watched it: trim the last shot', [UNI], null]]);
  const answered = (await calls(page, 'vault_transition')).filter((c) => c.args.id === 'ask-cut');
  expect(answered).toHaveLength(1);
  expect(answered[0].args).toMatchObject({ from: 'open', to: 'done', metadata: { answer: 'Watched it: trim the last shot' } });
  await expect(cut).toHaveCount(0);
  await expect(page.locator('.composer-answering')).toHaveCount(0);
  // his words went once: as the answer, not also as a plain message
  expect(await calls(page, 'post_answer')).toEqual([]);
});

test('the bar shows everywhere: inside a room, under its run story and beside an opened ask, on a phone and the Daylight; it steps aside only for the keyboard', async ({ page }) => {
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
    // and an ask opened in place (T-335 one ask: no sheet); the bar is live beside it: Settings opens and a second tap puts it away
    await page.locator('.sh-strip .sh-run[data-run="waiting"]').click();
    const ask = page.locator('.sh-room [data-card="ask-summary"]');
    await expect(ask).toBeInViewport();
    await ask.locator('[data-card-open]').click();
    await expect(ask.locator('.sh-ask-facts')).toBeVisible();
    expect(await barOnTop(page)).toBe(true);
    await bar(page).getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    await bar(page).getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
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

test("a write that fails keeps the ask's card, with why, and the next tap goes through", async ({ page }) => {
  await bootShape(page, { writeFails: 1 });
  const key = row(page, ROOM.house).locator('[data-card="ask-key"]');
  await key.locator('[data-card-open]').click();
  await key.getByRole('button', { name: 'I did it', exact: true }).click();
  // (the card comes back with why; it comes back closed, since it left the list while the write was out: reported, not asserted)
  await expect(key.getByRole('alert')).toHaveText(/^Couldn't mark it done: vault unreachable/);
  expect(await calls(page, 'post_message')).toEqual([]);
  await key.getByRole('button', { name: 'I did it', exact: true }).click();
  await expect(key).toHaveCount(0);
  await expect.poll(async () => (await calls(page, 'post_message')).map((c) => c.args.channel)).toEqual([ROOM.house]);
});

test("a public room's run that waits on a private room's ask opens its story, never the ask", async ({ page }) => {
  await bootShape(page, { leakRun: true });
  await row(page, ROOM.garden).locator('.sh-run[data-run="waiting"]').click();
  await expect(page.getByRole('dialog', { name: 'Checking the shed lock' })).toBeVisible();
  // (T-335 one ask: an ask's run opens the ask's room; this one stays home, and no card of it is drawn)
  await expect(page.locator('.sh-room')).toHaveCount(0);
  await expect(page.locator('[data-card="ask-quiet"]')).toHaveCount(0);
  const dom = await page.evaluate(() => document.documentElement.outerHTML);
  for (const words of ['A quiet line that stays in its room', 'T-605']) expect(dom, words).not.toContain(words);
});

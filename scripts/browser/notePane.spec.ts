import { test, expect, type Page, type Locator } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { PLAN, installNotePaneFixture } from './notePaneFixture';
import { goJournal, leaveRoom, openRoom as openRoomRow } from './shapeNav';

// T-200: a note linked in chat opens beside the chat (wide screens) or as a sheet over it (narrow screens, and on Android when upright:
// the Daylight's portrait and landscape projects carry an Android user agent; T-273 put the note beside the chat on its side). Invented
// rooms and notes (notePaneFixture.ts); what is sent is recorded in window.__notePane.sent. The handle that resizes either: splitSheet.spec.ts.
const touch = () => !!test.info().project.use.hasTouch;
const android = () => test.info().project.name.startsWith('daylight');
const beside = () => test.info().project.name === 'desktop' || test.info().project.name === 'daylight-landscape';
const tap = (l: Locator) => (touch() ? l.tap() : l.click());

test.beforeEach(async ({ page }) => { await page.addInitScript(installNotePaneFixture); });

/** Opens the Orchard room and scrolls it the way a reader does (wheel) until the message linking the plan sits a third of the way down. */
async function openRoom(page: Page) {
  await page.goto('/');
  const box = page.getByRole('textbox', { name: 'Message Orchard' });
  await expect(box).toBeVisible();
  const list = page.locator('.message-list');
  const chip = list.locator('.note-chip', { hasText: 'Spring planting plan' }).first();
  await expect(chip).toHaveCount(1);
  await page.waitForTimeout(1700); // a room holds its newest message for 1.5 s after it opens (SETTLE_MS)
  const box0 = (await list.boundingBox())!;
  await page.mouse.move(box0.x + box0.width / 2, box0.y + box0.height / 2);
  for (let i = 0; i < 12; i++) {
    const d = await chip.evaluate((c) => { const l = c.closest('.message-list')!.getBoundingClientRect(), r = c.getBoundingClientRect(); return r.top - (l.top + l.height / 3); });
    if (Math.abs(d) < 30) break;
    await page.mouse.wheel(0, d);
    await page.waitForTimeout(120);
  }
  return { box, list, chip };
}

const scrollOf = (list: Locator) => list.evaluate((el) => el.scrollTop);
/** Where the linked message sits in the list's window, in px from its top: what the reader sees, whatever renders late above it. */
const spotOf = (chip: Locator) => chip.evaluate((c) => c.getBoundingClientRect().top - c.closest('.message-list')!.getBoundingClientRect().top);
/** The linked message is inside the visible part of the list (not scrolled away). */
const inView = (chip: Locator) => chip.evaluate((c) => {
  const l = c.closest('.message-list')!.getBoundingClientRect(), r = c.getBoundingClientRect();
  return r.bottom > l.top && r.top < l.bottom;
});

async function selectPassage(page: Page, text: string) {
  await page.evaluate((text) => {
    const li = [...document.querySelectorAll('.note-pane .note-body li')].find((x) => x.textContent!.includes(text))!;
    const r = document.createRange(); r.selectNodeContents(li);
    const s = getSelection()!; s.removeAllRanges(); s.addRange(r);
  }, text);
}

/** Back as this device has it: Android's Back button on the Daylight, Alt+← elsewhere. */
async function back(page: Page) {
  if (android()) expect(await page.evaluate(() => (window as any).__notePane.back())).toBeGreaterThan(0);
  else await page.locator('body').press('Alt+ArrowLeft');
}

/** T-335 the shape: another room, from home's rows. The keys go first, as a thumb on Back does. */
async function switchRoom(page: Page, name: string) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await tap(page.locator('.sh-room').getByRole('button', { name: 'Back to rooms' }));
  await openRoomRow(page, name.toLowerCase());
}

test('tap a note link, read it, quote and reply, send, close: same room, same draft, same scroll', async ({ page }) => {
  const { box, list, chip } = await openRoom(page);
  expect(await inView(chip)).toBe(true);
  const at = await scrollOf(list);
  expect(at).toBeLessThan(await list.evaluate((el) => el.scrollHeight - el.clientHeight - 100)); // really scrolled up, not at the newest
  await box.fill('Half-written reply.');

  await tap(chip);
  const pane = page.locator('.note-pane');
  await expect(pane.locator('.note-title')).toHaveText('Spring planting plan');
  await expect(pane.locator('.note-body')).toContainText('Two dwarf apple trees');
  await expect(pane).toHaveClass(beside() ? /note-pane-beside/ : /note-pane-sheet/);

  // The chat is still there: same room, composer live, draft and the tapped message where they were.
  await expect(box).toBeVisible();
  await expect(box).toHaveValue('Half-written reply.');
  await expect(list).toHaveCount(1);
  expect(await inView(chip)).toBe(true);
  if (beside()) {
    // beside a note the chat keeps the room: the note takes what is left, never squeezing the chat
    expect((await list.boundingBox())!.width).toBeGreaterThan(380);
  } else {
    // the sheet lies over the list: the list itself is not touched
    expect(Math.abs((await scrollOf(list)) - at)).toBeLessThanOrEqual(2);
  }

  // Select a passage: Quote in reply puts it in the draft as a > quote with the note's link.
  await selectPassage(page, 'Two dwarf apple trees');
  const quote = pane.getByRole('button', { name: 'Quote in reply' });
  await expect(quote).toBeEnabled();
  await tap(quote);
  await expect(box).toHaveValue(`Half-written reply.\n\n> Two dwarf apple trees by the south fence.\n> — uni:${PLAN}\n\n`);
  await expect(box).toBeFocused();
  // the six-line draft stays a three-line composer while the note is open (it scrolls inside), so the pane keeps its height
  const lines = await box.evaluate((el) => { const s = getComputedStyle(el); return (el.clientHeight - parseFloat(s.paddingTop) - parseFloat(s.paddingBottom)) / parseFloat(s.lineHeight); });
  expect(lines).toBeLessThanOrEqual(3.2);
  await box.evaluate((el: HTMLTextAreaElement) => { el.focus(); el.setSelectionRange(el.value.length, el.value.length); });
  await page.keyboard.type('Yes to both, and net half the currants.');

  // Send works with the note still open, and the quote arrives as a quote with the note chip.
  await tap(page.getByRole('button', { name: 'Send message', exact: true }));
  await expect(box).toHaveValue('');
  expect(await page.evaluate(() => (window as any).__notePane.sent)).toEqual([{ channel: 'orchard', body: `Half-written reply.\n\n> Two dwarf apple trees by the south fence.\n> — uni:${PLAN}\n\nYes to both, and net half the currants.` }]);
  const mine = list.locator('article.message').last();
  await expect(mine).toContainText('Yes to both, and net half the currants.');
  await expect(mine.locator('blockquote')).toContainText('Two dwarf apple trees by the south fence.');
  await expect(mine.locator('blockquote .note-chip')).toContainText('Spring planting plan');
  await expect(pane.locator('.note-title')).toHaveText('Spring planting plan');

  // Close the note: back exactly where you were (same room, same spot in it), the tree and companion as they were.
  await tap(pane.getByRole('button', { name: 'Close note' }).first());
  await expect(pane).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Message Orchard' })).toBeVisible();
  expect(await inView(chip)).toBe(true);
  expect(Math.abs((await scrollOf(list)) - at)).toBeLessThanOrEqual(2);
});

test('T-204: Download .md from the note beside the chat saves the note as stored, named by its title', async ({ page }) => {
  const { chip } = await openRoom(page);
  await tap(chip);
  const pane = page.locator('.note-pane');
  await expect(pane.locator('.note-body')).toContainText('Two dwarf apple trees');
  const go = pane.getByRole('button', { name: 'Download .md' });
  await expect(go).toBeInViewport();
  const [file] = await Promise.all([page.waitForEvent('download'), tap(go)]);
  expect(file.suggestedFilename()).toBe('Spring planting plan.md');
  const stored = await page.evaluate((id) => (window as any).__TAURI_INTERNALS__.invoke('vault_note', { vault: 'uni', noteRef: id }).then((d: any) => d.note.content), PLAN);
  expect((await readFile((await file.path())!)).equals(Buffer.from(stored, 'utf8'))).toBe(true);
  await expect(page.getByText('Saved to ~/Downloads/Spring planting plan.md')).toBeVisible();
});

test('the note stays with its room; Back closes it first and Forward brings it back', async ({ page }) => {
  const { chip } = await openRoom(page);
  await tap(chip);
  const pane = page.locator('.note-pane');
  await expect(pane.locator('.note-title')).toHaveText('Spring planting plan');
  await switchRoom(page, 'Workshop');
  await expect(page.getByRole('textbox', { name: 'Message Workshop' })).toBeVisible();
  await expect(pane).toHaveCount(0);
  // T-335: one room in focus at a time; back in Orchard, its note is open again
  await switchRoom(page, 'Orchard');
  await expect(page.getByRole('textbox', { name: 'Message Orchard' })).toBeVisible();
  await expect(pane.locator('.note-title')).toHaveText('Spring planting plan');
  // now Back closes the note before it leaves the room
  await back(page);
  await expect(pane).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Message Orchard' })).toBeVisible();
  await page.locator('body').press('Alt+ArrowRight');
  await expect(pane.locator('.note-title')).toHaveText('Spring planting plan');
  await expect(page.getByRole('textbox', { name: 'Message Orchard' })).toBeVisible();
});

test('Open as page shows today\'s full note, and its Back comes back to the chat with the note beside it', async ({ page }) => {
  const { chip } = await openRoom(page);
  await tap(chip);
  const pane = page.locator('.note-pane');
  await expect(pane.locator('.note-title')).toHaveText('Spring planting plan');
  const at = await spotOf(chip);
  await tap(pane.getByRole('button', { name: 'Open as page' }));
  const pageView = page.locator('.note-sheet');
  await expect(pageView.locator('.note-title')).toHaveText('Spring planting plan');
  // the full page, with its own tools (0.2: under its one More)
  await pageView.getByRole('button', { name: 'More for this note' }).click();
  await expect(pageView.getByRole('button', { name: 'Copy markdown' })).toBeVisible();
  await pageView.getByRole('button', { name: 'More for this note' }).click();
  await expect(pane).toHaveCount(0);
  await back(page);
  await expect(pageView).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Message Orchard' })).toBeVisible();
  await expect(pane.locator('.note-title')).toHaveText('Spring planting plan');
  // the room comes back at the same spot (a room otherwise reopens at its newest message)
  expect(Math.abs((await spotOf(chip)) - at)).toBeLessThanOrEqual(4);
});

test('a link inside the note opens in the same pane, and its Back returns to the first note', async ({ page }) => {
  const { chip } = await openRoom(page);
  await tap(chip);
  const pane = page.locator('.note-pane');
  await expect(pane.locator('.note-title')).toHaveText('Spring planting plan');
  await tap(pane.locator('.note-body a', { hasText: 'Bed layout' }));
  await expect(pane.locator('.note-title')).toHaveText('Bed layout');
  await back(page);
  await expect(pane.locator('.note-title')).toHaveText('Spring planting plan');
});

test('an unsaved edit in the note asks before the note closes', async ({ page }) => {
  const { chip } = await openRoom(page);
  await tap(chip);
  const pane = page.locator('.note-pane');
  await tap(pane.getByRole('button', { name: 'Edit' }));
  await pane.getByRole('textbox', { name: 'Note content' }).fill('# Spring planting plan\n\nA changed line.');
  await tap(pane.getByRole('button', { name: 'Close note' }));
  const ask = page.getByRole('alertdialog', { name: 'Unsaved changes' });
  await expect(ask).toContainText("changes you haven't saved");
  await tap(ask.getByRole('button', { name: 'Keep editing' }));
  await expect(pane.getByRole('textbox', { name: 'Note content' })).toHaveValue('# Spring planting plan\n\nA changed line.');
  await back(page);
  await expect(ask).toBeVisible();
  await tap(ask.getByRole('button', { name: 'Close note' }));
  await expect(pane).toHaveCount(0);
});

test('beside: the note\'s width is remembered', async ({ page }) => {
  test.skip(!beside(), 'the column beside the chat is for wide screens (Android on its side)');
  const { chip } = await openRoom(page);
  await tap(chip);
  const pane = page.locator('.note-pane');
  const w0 = (await pane.boundingBox())!.width;
  await pane.getByRole('separator', { name: /Resize the note/ }).press('Shift+ArrowLeft');
  await expect.poll(async () => (await pane.boundingBox())!.width).toBeGreaterThan(w0 + 60);
  const w1 = (await pane.boundingBox())!.width;
  await tap(pane.getByRole('button', { name: 'Close note' }));
  await page.reload();
  const again = await openRoom(page);
  await tap(again.chip);
  await expect(pane.locator('.note-title')).toHaveText('Spring planting plan');
  expect(Math.abs((await pane.boundingBox())!.width - w1)).toBeLessThanOrEqual(1);
});

test('sheet: half or full height, ending at the composer, with the composer in sight', async ({ page }) => {
  test.skip(beside(), 'the sheet is for narrow screens and Android upright');
  const { box, chip } = await openRoom(page);
  await tap(chip);
  const pane = page.locator('.note-pane-sheet');
  await expect(pane.locator('.note-title')).toHaveText('Spring planting plan');
  const composerTop = (await page.locator('.conversation .composer').boundingBox())!.y;
  const half = (await pane.boundingBox())!;
  await tap(pane.getByRole('button', { name: 'Full' }));
  const full = (await pane.boundingBox())!;
  expect(full.height).toBeGreaterThan(half.height * 1.8);
  for (const b of [half, full]) expect(Math.abs(b.y + b.height - composerTop)).toBeLessThanOrEqual(2); // ends at the composer's top edge
  await expect(box).toBeVisible();
  // no animation anywhere (e-ink)
  expect(await pane.evaluate((el) => [el, ...el.querySelectorAll('*')].filter((x) => { const s = getComputedStyle(x); return s.animationName !== 'none' || s.transitionDuration.split(',').some((d) => parseFloat(d) > 0); })
    .map((x) => `${x.tagName.toLowerCase()}.${[...x.classList].join('.')} ${getComputedStyle(x).animationName} ${getComputedStyle(x).transitionDuration}`))).toEqual([]);
});

test('sheet: with the Journal open in its own tab too, the sheet lies over the room, not the hidden Journal', async ({ page }) => {
  test.skip(beside(), 'the sheet is for narrow screens and Android upright');
  await openRoom(page);
  await leaveRoom(page); // the bar is hidden inside a room on a phone
  await goJournal(page);
  await expect(page.locator('.journal-list')).toBeVisible();
  await openRoomRow(page, 'orchard');
  await expect(page.getByRole('textbox', { name: 'Message Orchard' })).toBeVisible();
  await expect(page.locator('.journal-list')).toHaveCount(1); // still mounted, hidden
  const chip = page.locator('.message-list .note-chip', { hasText: 'Spring planting plan' }).first();
  await chip.scrollIntoViewIfNeeded();
  await tap(chip);
  const pane = page.locator('.note-pane-sheet');
  await expect(pane.locator('.note-title')).toHaveText('Spring planting plan');
  const list = (await page.locator('.sh-room .message-list').boundingBox())!, sheet = (await pane.boundingBox())!;
  expect(Math.abs(sheet.width - list.width)).toBeLessThanOrEqual(2);
  expect(Math.abs(sheet.x - list.x)).toBeLessThanOrEqual(2);
});

test('Open as page from far back in a long room comes back to the same spot, older messages and all', async ({ page }) => {
  await openRoom(page);
  await switchRoom(page, 'Archive');
  await expect(page.getByRole('textbox', { name: 'Message Archive' })).toBeVisible();
  await page.waitForTimeout(1700);
  await tap(page.getByRole('button', { name: 'Load older messages' }));
  const chip = page.locator('.message-list .note-chip', { hasText: 'Spring planting plan' }).first();
  await expect(chip).toHaveCount(1);
  await chip.scrollIntoViewIfNeeded();
  await tap(chip);
  const pane = page.locator('.note-pane');
  await expect(pane.locator('.note-title')).toHaveText('Spring planting plan');
  const at = await spotOf(chip);
  await tap(pane.getByRole('button', { name: 'Open as page' }));
  await expect(page.locator('.note-sheet .note-title')).toHaveText('Spring planting plan');
  await page.evaluate(() => { (window as any).__notePane.slowBig = true; }); // the room's first 300 come back before the older window
  await back(page);
  await expect(page.getByRole('textbox', { name: 'Message Archive' })).toBeVisible();
  await expect(pane.locator('.note-title')).toHaveText('Spring planting plan');
  await expect(chip).toHaveCount(1);
  expect(Math.abs((await spotOf(chip)) - at)).toBeLessThanOrEqual(4);
});

test('an edit in the note goes with it to Open as page: the page opens in the editor with the draft', async ({ page }) => {
  const { chip } = await openRoom(page);
  await tap(chip);
  const pane = page.locator('.note-pane');
  await tap(pane.getByRole('button', { name: 'Edit' }));
  await pane.getByRole('textbox', { name: 'Note content' }).fill('# Spring planting plan\n\nA changed line.');
  await tap(pane.getByRole('button', { name: 'Open as page' }));
  await expect(page.locator('.note-sheet').getByRole('textbox', { name: 'Note content' })).toHaveValue('# Spring planting plan\n\nA changed line.');
});

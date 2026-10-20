import { test, expect, type Page, type Locator } from '@playwright/test';

// T-200: read a note linked in chat and reply without losing either. Runs on the fixture build (playwright.t200.config.ts):
// invented rooms and notes, the stand-in relay records what is sent in window.__t200.sent.
const PLAN = `01JT2${'0'.repeat(20)}1`;
const phone = () => test.info().project.name === 'phone';
const tap = (l: Locator) => (phone() ? l.tap() : l.click());

/** Opens the Orchard room and scrolls it the way a reader does (wheel) until the message linking the plan sits a third of the way down. */
async function openRoom(page: Page, mode: 'a' | 'b' | 'c') {
  await page.goto(`/?t200=${mode}`);
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
/** The linked message is inside the visible part of the list (not scrolled away). */
const inView = (list: Locator, chip: Locator) => chip.evaluate((c) => {
  const l = c.closest('.message-list')!.getBoundingClientRect(), r = c.getBoundingClientRect();
  return r.bottom > l.top && r.top < l.bottom;
});

async function selectPassage(where: Page, text: string) {
  await where.evaluate((text) => {
    const li = [...document.querySelectorAll('.note-body li')].find((x) => x.textContent!.includes(text))!;
    const r = document.createRange(); r.selectNodeContents(li);
    const s = getSelection()!; s.removeAllRanges(); s.addRange(r);
  }, text);
}

for (const mode of ['a', 'b', 'c'] as const) {
  test(`${mode}: tap a note link, read it, quote and reply, close: chat, draft and scroll are kept`, async ({ page, context }) => {
    const { box, list, chip } = await openRoom(page, mode);
    expect(await inView(list, chip)).toBe(true);
    const at = await scrollOf(list);
    expect(at).toBeLessThan(await list.evaluate((el) => el.scrollHeight - el.clientHeight - 100)); // really scrolled up, not at the newest
    await box.fill('Half-written reply.');

    const popup = context.waitForEvent('page', { timeout: 4000 }).catch(() => null);
    await tap(chip);
    // C opens a second window on a desktop; on a phone it falls back to the sheet (B).
    const win = mode === 'c' && !phone() ? await popup : null;
    if (mode === 'c' && !phone()) expect(win).not.toBeNull();
    const where = win ?? page;
    const pane = where.locator('.t200-pane');
    await expect(pane.locator('.note-title')).toHaveText('Spring planting plan');
    await expect(pane.locator('.note-body')).toContainText('Two dwarf apple trees');
    await expect(pane).toHaveClass(new RegExp(mode === 'a' ? (phone() ? 't200-above' : 't200-beside') : mode === 'c' && !phone() ? 't200-window' : 't200-sheet'));

    // The chat is still there underneath: same room, composer live, draft and scroll as they were.
    await expect(box).toBeVisible();
    await expect(box).toHaveValue('Half-written reply.');
    await expect(list).toHaveCount(1);
    expect(await inView(list, chip)).toBe(true);
    // A changes the chat's size (a narrower column on a desktop, a shorter list on a phone), so there it is "still in view" that holds;
    // over the chat (B) or in another window (C) the list is not touched at all.
    if (mode !== 'a') expect(Math.abs((await scrollOf(list)) - at)).toBeLessThanOrEqual(2);

    // Bonus: select a passage, Quote in reply puts it in the draft as a > quote with the note's link.
    await selectPassage(where, 'Two dwarf apple trees');
    const quote = pane.getByRole('button', { name: 'Quote in reply' });
    await expect(quote).toBeEnabled();
    await tap(quote);
    await expect(box).toHaveValue(`Half-written reply.\n\n> Two dwarf apple trees by the south fence.\n> — uni:${PLAN}\n\n`);
    if (!win) await expect(box).toBeFocused();
    await box.evaluate((el: HTMLTextAreaElement) => { el.focus(); el.setSelectionRange(el.value.length, el.value.length); });
    await page.keyboard.type('Yes to both, and net half the currants.');

    // Send works with the note still open, and the quote arrives as a quote with the note chip.
    await tap(page.getByRole('button', { name: 'Send message', exact: true }));
    await expect(box).toHaveValue('');
    const sent = await page.evaluate(() => (window as any).__t200.sent);
    expect(sent).toEqual([{ channel: 'orchard', body: `Half-written reply.\n\n> Two dwarf apple trees by the south fence.\n> — uni:${PLAN}\n\nYes to both, and net half the currants.` }]);
    const mine = list.locator('article.message').last();
    await expect(mine).toContainText('Yes to both, and net half the currants.');
    await expect(mine.locator('blockquote')).toContainText('Two dwarf apple trees by the south fence.');
    await expect(mine.locator('blockquote .note-chip')).toContainText('Spring planting plan');
    await expect(pane.locator('.note-title')).toHaveText('Spring planting plan');

    // Close the note: back exactly where you were (same room, same spot in it).
    const closing = win ? win.waitForEvent('close') : null;
    await tap(pane.getByRole('button', { name: 'Close note' }).first());
    await closing;
    await expect(page.locator('.t200-pane')).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Message Orchard' })).toBeVisible();
    expect(await inView(list, chip)).toBe(true);
    expect(Math.abs((await scrollOf(list)) - at)).toBeLessThanOrEqual(2);
  });
}

test('a: a link inside the note opens in the same pane, and its Back returns to the first note', async ({ page }) => {
  const { chip } = await openRoom(page, 'a');
  await tap(chip);
  const pane = page.locator('.t200-pane');
  await expect(pane.locator('.note-title')).toHaveText('Spring planting plan');
  await tap(pane.locator('.note-body a', { hasText: 'Bed layout' }));
  await expect(pane.locator('.note-title')).toHaveText('Bed layout');
  await tap(pane.getByRole('button', { name: 'Back to Spring planting plan' }));
  await expect(pane.locator('.note-title')).toHaveText('Spring planting plan');
});

test('b: the sheet switches between half and full height and the composer stays visible', async ({ page }) => {
  const { box, chip } = await openRoom(page, 'b');
  await tap(chip);
  const pane = page.locator('.t200-sheet');
  await expect(pane.locator('.note-title')).toHaveText('Spring planting plan');
  const composerTop = (await page.locator('.conversation .composer').boundingBox())!.y;
  const half = (await pane.boundingBox())!;
  await tap(pane.getByRole('button', { name: 'Full' }));
  const full = (await pane.boundingBox())!;
  expect(full.height).toBeGreaterThan(half.height * 1.8);
  for (const b of [half, full]) expect(Math.abs(b.y + b.height - composerTop)).toBeLessThanOrEqual(2); // ends at the composer's top edge
  await expect(box).toBeVisible();
});

test('b: the note stays with its room: another room shows none, and Back returns to the room with the note still open', async ({ page }) => {
  const { chip } = await openRoom(page, 'b');
  await tap(chip);
  await expect(page.locator('.t200-pane .note-title')).toHaveText('Spring planting plan');
  // switch rooms through the room tree (on a phone it is behind the drawer)
  if (phone()) await tap(page.locator('.sr-drawer'));
  const tree = page.locator(phone() ? '.th-phone-tree' : '.th-roomnav');
  const fold = tree.locator('.th-others .th-fold');
  if (await fold.getAttribute('aria-expanded') !== 'true') await tap(fold);
  await tap(tree.locator('.th-other .th-go').filter({ hasText: '#Workshop' }));
  await expect(page.getByRole('textbox', { name: 'Message Workshop' })).toBeVisible();
  await expect(page.locator('.t200-pane')).toHaveCount(0);
  // Back is not swallowed by the hidden note: it goes back to Orchard, where the note is open again
  await page.locator('body').press('Alt+ArrowLeft');
  await expect(page.getByRole('textbox', { name: 'Message Orchard' })).toBeVisible();
  await expect(page.locator('.t200-pane .note-title')).toHaveText('Spring planting plan');
});

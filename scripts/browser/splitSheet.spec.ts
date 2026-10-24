import { test, expect, type Page, type Locator } from '@playwright/test';
import { installNotePaneFixture } from './notePaneFixture';

// T-273: the handle between the chat and a note (SplitHandle). On a phone and the Daylight upright the note is a sheet over the chat, and the
// handle on its top edge sets its height: dragged by touch, mouse or pen, snapping near a third, a half, two thirds and full, closing when
// pulled or flicked past its bottom, remembered on this device. On a wide screen (the desktop, the Daylight on its side) the same handle is
// the edge of the column beside the chat. Invented rooms and notes (notePaneFixture.ts). The drags are real input (Chromium's touch, mouse
// and pen events through CDP), not handler calls.
const project = () => test.info().project.name;
const beside = () => project() === 'desktop' || project() === 'daylight-landscape';
const touch = () => !!test.info().project.use.hasTouch;
const tap = (l: Locator) => (touch() ? l.tap() : l.click());
type Kind = 'touch' | 'mouse' | 'pen';
const kind = (): Kind => (touch() ? 'touch' : 'mouse');

test.beforeEach(async ({ page }) => { await page.addInitScript(installNotePaneFixture); });

async function openNote(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'Message Orchard' })).toBeVisible();
  const chip = page.locator('.message-list .note-chip', { hasText: 'Spring planting plan' }).first();
  await expect(chip).toHaveCount(1);
  await page.waitForTimeout(1700); // a room holds its newest message for 1.5 s after it opens (SETTLE_MS)
  await chip.scrollIntoViewIfNeeded();
  await tap(chip);
  const pane = page.locator('.note-pane');
  await expect(pane.locator('.note-title')).toHaveText('Spring planting plan');
  return { pane, handle: pane.getByRole('separator', { name: /Resize the note/ }) };
}

/** The sheet's height and the height it can take (the message list's top down to the composer's top edge). */
async function sheet(page: Page) {
  const list = (await page.locator('.message-list').boundingBox())!;
  const composerTop = (await page.locator('.conversation .composer').boundingBox())!.y;
  const box = (await page.locator('.note-pane-sheet').boundingBox())!;
  return { h: box.height, area: composerTop - list.y, bottom: box.y + box.height, composerTop };
}
const width = async (page: Page) => (await page.locator('.note-pane-beside').boundingBox())!.width;
const viewport = (page: Page) => page.viewportSize()!;

/**
 * Holds the handle's grip and moves it by (dx, dy) in `steps`, `gap` ms apart, then lets go after `rest` ms: with a finger, a mouse or a
 * pen, as Chromium gets them from the device. `during` runs while it is still held.
 */
async function drag(page: Page, handle: Locator, d: { dx?: number; dy?: number }, o: { by?: Kind; steps?: number; gap?: number; rest?: number; during?: () => Promise<void> } = {}) {
  const by = o.by ?? kind(), steps = o.steps ?? 12, gap = o.gap ?? 30, rest = o.rest ?? 150;
  const b = (await handle.boundingBox())!;
  const x0 = b.x + b.width / 2, y0 = b.y + b.height / 2;
  const cdp = await page.context().newCDPSession(page);
  const at = (i: number) => ({ x: x0 + ((d.dx ?? 0) * i) / steps, y: y0 + ((d.dy ?? 0) * i) / steps });
  const send = async (type: 'start' | 'move' | 'end', p: { x: number; y: number }) => {
    if (by === 'touch') await cdp.send('Input.dispatchTouchEvent', { type: type === 'start' ? 'touchStart' : type === 'move' ? 'touchMove' : 'touchEnd', touchPoints: type === 'end' ? [] : [{ ...p, id: 1 }] });
    else await cdp.send('Input.dispatchMouseEvent', { type: type === 'start' ? 'mousePressed' : type === 'move' ? 'mouseMoved' : 'mouseReleased', ...p, button: 'left', buttons: type === 'end' ? 0 : 1, clickCount: 1, pointerType: by });
  };
  await send('start', at(0));
  for (let i = 1; i <= steps; i++) { await send('move', at(i)); if (gap) await page.waitForTimeout(gap); }
  if (o.during) await o.during();
  if (rest) await page.waitForTimeout(rest);
  await send('end', at(steps));
  await cdp.detach();
}

test.describe('sheet', () => {
  test.beforeEach(() => { test.skip(beside(), 'the sheet is for narrow screens and the Daylight upright'); });

  test('the handle drags the sheet to any height, live, ending at the composer, with the chat above still scrolling', async ({ page }) => {
    const { pane, handle } = await openNote(page);
    await expect(handle).toHaveAttribute('aria-orientation', 'horizontal');
    const s0 = await sheet(page);
    expect(Math.abs(s0.h - s0.area / 2)).toBeLessThanOrEqual(2); // half, as before
    // up by a sixth plus 60 px: between the snap points, so it stays where it is let go; it grows while still held
    const up = Math.round(s0.area / 6 + 60);
    let held = 0;
    await drag(page, handle, { dy: -up }, { during: async () => { held = (await sheet(page)).h; } });
    expect(held).toBeGreaterThan(s0.h + up - 30);
    const s1 = await sheet(page);
    expect(Math.abs(s1.h - (s0.h + up))).toBeLessThanOrEqual(3);
    expect(Math.abs(s1.bottom - s1.composerTop)).toBeLessThanOrEqual(2);
    await expect(page.getByRole('textbox', { name: 'Message Orchard' })).toBeVisible();
    // the chat above the sheet scrolls on its own and the sheet stays put
    const list = page.locator('.message-list');
    const top0 = await list.evaluate((el) => el.scrollTop);
    const lb = (await list.boundingBox())!;
    await page.mouse.move(lb.x + lb.width / 2, lb.y + 40);
    await page.mouse.wheel(0, -400);
    await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeLessThan(top0 - 100);
    expect(Math.abs((await sheet(page)).h - s1.h)).toBeLessThanOrEqual(1);
    await expect(pane).not.toHaveClass(/resizing/);
  });

  test('let go near a third, two thirds or the top, it snaps there; Full and Half still work after', async ({ page }) => {
    const { pane, handle } = await openNote(page);
    const { area, h } = await sheet(page);
    // 20 px short of two thirds
    await drag(page, handle, { dy: -(area * 2 / 3 - h - 20) });
    expect(Math.abs((await sheet(page)).h - area * 2 / 3)).toBeLessThanOrEqual(2);
    // 20 px past a third
    await drag(page, handle, { dy: (await sheet(page)).h - area / 3 - 20 });
    expect(Math.abs((await sheet(page)).h - area / 3)).toBeLessThanOrEqual(2);
    // near the top: full, and the Full button says so
    await drag(page, handle, { dy: -(area - (await sheet(page)).h - 25) });
    expect(Math.abs((await sheet(page)).h - area)).toBeLessThanOrEqual(2);
    await expect(pane.getByRole('button', { name: 'Half' })).toHaveAttribute('aria-pressed', 'true');
    await tap(pane.getByRole('button', { name: 'Half' }));
    expect(Math.abs((await sheet(page)).h - area / 2)).toBeLessThanOrEqual(2);
    await tap(pane.getByRole('button', { name: 'Full' }));
    expect(Math.abs((await sheet(page)).h - area)).toBeLessThanOrEqual(2);
  });

  test('a pen drags it too', async ({ page }) => {
    const { handle } = await openNote(page);
    const s0 = await sheet(page);
    const up = Math.round(s0.area * 7 / 12 - s0.h); // halfway from a half to two thirds: no snap
    await drag(page, handle, { dy: -up }, { by: 'pen' });
    expect(Math.abs((await sheet(page)).h - (s0.h + up))).toBeLessThanOrEqual(3);
  });

  test('flicked down, or pulled down past its bottom, the sheet closes like Back; a slow drag down only lowers it', async ({ page }) => {
    let { pane, handle } = await openNote(page);
    const box = page.getByRole('textbox', { name: 'Message Orchard' });
    await box.fill('A draft that stays.');
    // a slow drag down to near a third lowers it and keeps it open (the list is measured again: on a phone the composer lets go of the
    // keyboard as the handle is touched)
    const third = async () => { const s = await sheet(page); return Math.abs(s.h - s.area / 3); };
    const { area, h } = await sheet(page);
    await drag(page, handle, { dy: h - area / 3 - 10 });
    await expect(pane).toHaveCount(1);
    expect(await third()).toBeLessThanOrEqual(2);
    // a quick flick down closes it, the chat and its draft untouched
    await drag(page, handle, { dy: 160 }, { steps: 4, gap: 0, rest: 0 });
    await expect(pane).toHaveCount(0);
    await expect(box).toHaveValue('A draft that stays.');
    // a slow pull past its bottom closes it as well, and the next note opens at the height it had before the pull
    ({ pane, handle } = await openNote(page));
    expect(await third()).toBeLessThanOrEqual(2);
    await drag(page, handle, { dy: (await sheet(page)).h + 40 }, { steps: 20, gap: 40 });
    await expect(pane).toHaveCount(0);
    ({ pane } = await openNote(page));
    expect(await third()).toBeLessThanOrEqual(2);
  });

  test('keyboard: arrows resize it, Home and End go to its least and full height, Escape still closes it', async ({ page }) => {
    const { pane, handle } = await openNote(page);
    const { area, h } = await sheet(page);
    await handle.focus();
    await expect(handle).toHaveAttribute('aria-valuenow', '50');
    await handle.press('ArrowUp');
    expect(Math.abs((await sheet(page)).h - (h + 24))).toBeLessThanOrEqual(2);
    await handle.press('Shift+ArrowDown');
    expect(Math.abs((await sheet(page)).h - (h + 24 - 80))).toBeLessThanOrEqual(2);
    await handle.press('End');
    expect(Math.abs((await sheet(page)).h - area)).toBeLessThanOrEqual(2);
    await expect(handle).toHaveAttribute('aria-valuenow', '100');
    await handle.press('Home');
    const least = (await sheet(page)).h;
    expect(least).toBeLessThan(area / 3);
    expect(least).toBeGreaterThanOrEqual(Math.min(120, area) - 1);
    await expect(handle).toHaveAttribute('aria-valuenow', String(Math.round(least / area * 100)));
    await expect(handle).toBeFocused();
    await handle.press('Escape');
    await expect(pane).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Message Orchard' })).toBeVisible();
  });

  test('the height is remembered on this device, and the old "full" setting still opens it full', async ({ page }) => {
    const { handle } = await openNote(page);
    const { area, h } = await sheet(page);
    await drag(page, handle, { dy: -Math.round(area / 6 + 60) });
    const kept = (await sheet(page)).h;
    expect(kept).toBeGreaterThan(h + 60);
    await page.reload();
    await openNote(page);
    expect(Math.abs((await sheet(page)).h - kept)).toBeLessThanOrEqual(2);
    await page.evaluate(() => localStorage.setItem('uni.notePane.sheet', 'full'));
    await page.reload();
    await openNote(page);
    expect(Math.abs((await sheet(page)).h - area)).toBeLessThanOrEqual(2);
  });
});

test.describe('beside', () => {
  test.beforeEach(() => { test.skip(!beside(), 'the column beside the chat is for wide screens'); });

  test('the same handle is the column\'s edge: drag it wider, it snaps near half the window, and the width is remembered', async ({ page }) => {
    const { pane, handle } = await openNote(page);
    await expect(pane).toHaveClass(/note-pane-beside/);
    await expect(handle).toHaveAttribute('aria-orientation', 'vertical');
    const w0 = await width(page), vw = viewport(page).width;
    // 15 px short of half the window
    let held = 0;
    await drag(page, handle, { dx: -(vw / 2 - w0 - 15) }, { during: async () => { held = await width(page); } });
    expect(held).toBeGreaterThan(w0 + 40);
    expect(Math.abs(await width(page) - vw / 2)).toBeLessThanOrEqual(2);
    // between the snap points it stays where it is let go
    await drag(page, handle, { dx: 70 });
    const w1 = await width(page);
    expect(Math.abs(w1 - (vw / 2 - 70))).toBeLessThanOrEqual(3);
    await page.reload();
    await openNote(page);
    expect(Math.abs(await width(page) - w1)).toBeLessThanOrEqual(2);
  });

  test('keyboard: arrows widen and narrow it, Home and End go to its least and most, the chat kept readable', async ({ page }) => {
    const { handle } = await openNote(page);
    const w0 = await width(page), vw = viewport(page).width;
    await handle.focus();
    await handle.press('ArrowLeft');
    expect(Math.abs(await width(page) - (w0 + 24))).toBeLessThanOrEqual(2);
    // End: as wide as it goes, the window less 520 px, or less if the chat's own list would get narrower than 380 px (the Daylight on its
    // side keeps its tree unfolded)
    await handle.press('End');
    const list = (await page.locator('.message-list').boundingBox())!.width, most = await width(page);
    expect(most).toBeGreaterThan(w0 + 100);
    expect(most).toBeLessThanOrEqual(vw - 520 + 1);
    expect(list).toBeGreaterThanOrEqual(378);
    expect(Math.min(Math.abs(most - (vw - 520)), Math.abs(list - 380))).toBeLessThanOrEqual(2);
    await handle.press('Home');
    expect(Math.abs(await width(page) - 320)).toBeLessThanOrEqual(2);
    await expect(handle).toHaveAttribute('aria-valuenow', String(Math.round(320 / vw * 100)));
  });
});

test('on Android only a tablet on its side gets the column: a phone turned sideways keeps the sheet', async ({ page }) => {
  test.skip(project() !== 'daylight-portrait', 'needs the Android user agent, at sizes set here');
  const { pane } = await openNote(page);
  await expect(pane).toHaveClass(/note-pane-sheet/);
  await page.setViewportSize({ width: 915, height: 412 }); // a phone on its side
  await expect(pane).toHaveClass(/note-pane-sheet/);
  await page.setViewportSize({ width: 1600, height: 1200 }); // the Daylight on its side
  await expect(pane).toHaveClass(/note-pane-beside/);
  await expect(pane.getByRole('separator', { name: /Resize the note/ })).toHaveAttribute('aria-orientation', 'vertical');
});

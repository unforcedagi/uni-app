import { mkdir } from 'node:fs/promises';
import { test, expect, type Locator } from '@playwright/test';
import { bootRail } from './railFixture';

test('All reading surfaces fit the screen', async ({ page }, info) => {
  await bootRail(page);
  const size = page.viewportSize()!;
  const phone = size.width < 600;
  const short = size.height < 500;
  const rail = page.getByRole('navigation', { name: 'Main navigation' });
  const dir = '/home/uni/Code/uni-sketches/t43/audit';
  await mkdir(dir, { recursive: true });
  const fits = async (target: Locator, touch = false) => {
    await expect(target).toBeVisible();
    const box = (await target.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(size.width + 1);
    expect(box.y + box.height).toBeLessThanOrEqual(size.height + 1);
    if (touch && size.width < 1200) {
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
  };
  const shot = async (view: string) => {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `${dir}/${info.project.name}-${view}.png` });
  };
  // The rail holds Uni, Journal, For you, Vault, Search and Settings at every width it shows. A short landscape screen hides the rail (r13):
  // a room's header opens the drawer with the app's places, the tree home shows them itself, and Journal goes back to Uni.
  const place = async (name: 'Uni' | 'Journal' | 'For you' | 'Settings' | 'Search') => {
    if (!short) { await rail.getByRole('button', { name, exact: true }).click(); return; }
    await expect(rail).toBeHidden();
    if (name === 'Uni') { const back = page.getByRole('button', { name: /^Back to / }); if (await back.isVisible()) await back.click(); return; }
    // from the Journal (not a room), Uni first
    if (!await page.locator('.sr-drawer, .th-places-short').first().isVisible()) { await page.getByRole('button', { name: /^Back to / }).click(); await page.locator('.sr-drawer, .th-places-short').first().waitFor(); }
    if (await page.locator('.sr-drawer').isVisible() && !await page.locator('.th-drawer').count()) await page.locator('.sr-drawer').click();
    await page.locator('.th-places:visible').getByRole('button', { name, exact: true }).click();
  };
  const openPanel = (name: 'Settings' | 'Search') => place(name);
  // the seeded Uni-room tab turns into Uni's own place once the tree is read (one remount): measure after that
  await expect(page.locator('.sr-title')).toHaveText('Uni');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('uni.tabs.v2') ?? '{"tabs":[]}').tabs[0]?.kind)).toBe('areas');
  await page.waitForTimeout(300);
  for (const control of [page.getByRole('textbox', { name: 'Message Uni' }), page.getByRole('button', { name: 'Record a voice message' }), page.getByRole('button', { name: 'Send message', exact: true })]) await fits(control, true);
  expect((await page.locator('.message-list').boundingBox())!.height).toBeGreaterThan(100);
  if (size.width >= 1280) {
    expect((await page.locator('.compose-row').boundingBox())!.width).toBeLessThanOrEqual(760);
    expect((await page.locator('.message-content').first().boundingBox())!.width).toBeLessThanOrEqual(760);
  }
  await shot('uni');
  await place('Journal');
  const writing = page.getByRole('textbox', { name: 'Journal entry', exact: true });
  await expect(writing).toBeVisible();
  await writing.fill('A little room to think.');
  await writing.blur();
  if (!short) await fits(writing);
  if (size.width >= 1280) expect((await writing.boundingBox())!.width).toBeLessThanOrEqual(760);
  if (size.width >= 1280) expect((await page.locator('.journal-list').boundingBox())!.width).toBeLessThanOrEqual(760);
  await shot('journal');
  await page.getByRole('button', { name: 'Focus', exact: true }).click();
  await expect(rail).toBeHidden();
  await shot('focus');
  await page.getByRole('button', { name: 'Focus', exact: true }).click();
  await place('For you');
  await expect(page.locator('.note-title')).toHaveText('For you');
  await fits(page.locator('.note-back'), true);
  await shot('for-you');
  await page.locator('.note-back').click();
  await place('Uni');
  // the rooms are the tree's: its last row ("Other rooms", then a room no node owns) fits and is a touch target on a phone
  const narrow = size.width < 900;
  if (narrow && await page.locator('.sr-drawer').count()) await page.locator('.sr-drawer').click();
  const tree = page.locator(narrow ? '.th-phone-tree' : '.th-roomnav');
  await tree.locator('.th-others .th-fold').click();
  const lastRoom = tree.locator('.th-other .th-go').last();
  await lastRoom.scrollIntoViewIfNeeded();
  await fits(lastRoom, phone);
  await shot('rooms');
  // the drawer (below 900px) closes before the rail is used again
  if (await page.locator('.th-drawer').count()) { await page.keyboard.press('Escape'); await expect(page.locator('.th-drawer')).toHaveCount(0); }
  await openPanel('Settings');
  await expect(page.locator('.settings')).toBeVisible();
  await expect(page.locator('.identity')).toContainText('Signed in as Aaron');
  await fits(page.locator('.identity'));
  expect(await page.locator('.identity').evaluate(el => el.scrollHeight <= el.clientHeight)).toBe(true);
  await shot('settings');
  const forget = page.getByRole('button', { name: 'Forget this device key', exact: true });
  await forget.scrollIntoViewIfNeeded();
  await fits(forget, true);
  await page.getByRole('button', { name: 'Close panel', exact: true }).click();
  await openPanel('Search');
  await expect(page.locator('.search-view')).toBeVisible();
  await fits(page.getByRole('searchbox'));
  await shot('search');
});

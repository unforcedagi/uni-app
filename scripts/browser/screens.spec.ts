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
  // r12: no Rooms drawer; the rail holds Uni, Journal, For you, Vault, Search and Settings at every width it shows. A short landscape screen
  // hides the rail and its room shell has no way to the navigation panel yet: the known failure of this spec (round 13 takes it).
  const openPanel = async (name: 'Settings' | 'Search') => { await rail.getByRole('button', { name, exact: true }).click(); };
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
  await rail.getByRole('button', { name: 'Journal', exact: true }).click();
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
  await rail.getByRole('button', { name: 'For you', exact: true }).click();
  await expect(page.locator('.note-title')).toHaveText('For you');
  await fits(page.locator('.note-back'), true);
  await shot('for-you');
  await page.locator('.note-back').click();
  await rail.getByRole('button', { name: 'Uni', exact: true }).click();
  // the rooms are the tree's: its last row ("Other rooms", then a room no node owns) fits and is a touch target on a phone
  const narrow = size.width < 900;
  if (narrow && await page.locator('.sr-back').count()) await page.locator('.sr-back').click();
  const tree = page.locator(narrow ? '.th-phone-tree' : '.th-roomnav');
  await tree.locator('.th-others .th-fold').click();
  const lastRoom = tree.locator('.th-other .th-go').last();
  await lastRoom.scrollIntoViewIfNeeded();
  await fits(lastRoom, phone);
  await shot('rooms');
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

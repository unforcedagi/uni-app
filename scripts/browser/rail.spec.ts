import { mkdir } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { bootRail } from './railFixture';

test.beforeEach(async ({ page }) => bootRail(page));

test('a saved Uni room opens as Uni\'s room at every width; on a phone it is the place shown (r12: no rooms sidebar beside it)', async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem('uni.lastSurface.v1'));
  for (const width of [390, 599, 600, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    // a saved Uni-room tab (v1; the v2 the first load wrote would win): it opens as Uni's own room
    await page.evaluate(() => { localStorage.removeItem('uni.tabs.v2'); localStorage.setItem('uni.tabs.v1', JSON.stringify({ v: 1, tabs: [{ id: 'room', kind: 'room', channel: 'uni-room', title: 'Uni' }], active: 'room', recent: ['room'] })); });
    await page.reload();
    await expect(page.getByRole('textbox', { name: 'Message Uni' })).toBeVisible();
    if (width < 600) await expect(page.locator('.shell')).toHaveClass(/in-room/);
    await expect(page.locator('aside.rooms')).toBeHidden();
  }
});

test('Rail surfaces, overlay panels, focus; rooms are in the tree (r12: no Rooms drawer)', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const rail = page.getByRole('navigation', { name: 'Main navigation' });
  const shot = async (name: string) => {
    if (!phone) {
      const dir = '/home/uni/Code/uni-sketches/t21/built';
      await mkdir(dir, { recursive: true });
      await page.mouse.move(page.viewportSize()!.width - 10, 10);
      await page.evaluate(async () => { await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))); });
      await page.screenshot({ path: `${dir}/${info.project.name}-${name}.png` });
    }
  };
  await expect(rail).toBeVisible();
  if (!phone) expect((await page.locator('.conversation').boundingBox())!.x).toBeLessThanOrEqual(80);
  await expect(rail.getByRole('button', { name: 'Rooms', exact: true })).toHaveCount(0);
  await shot('uni');
  if (phone) {
    const box = (await rail.boundingBox())!;
    expect(box.width).toBe(page.viewportSize()!.width);
    expect(box.y + box.height).toBe(page.viewportSize()!.height);
    const input = page.getByRole('textbox', { name: 'Message Uni' });
    await input.focus();
    await expect(rail).toBeHidden();
    await input.blur();
    await expect(rail).toBeVisible();
    // Uni, Journal, For you, Vault, Search and Settings: everything the drawer used to hold is on the rail or in the tree
    await expect(rail.getByRole('button').filter({ visible: true })).toHaveCount(6);
  }
  await rail.getByRole('button', { name: 'Journal', exact: true }).click();
  const writing = page.getByRole('textbox', { name: 'Journal entry', exact: true });
  await expect(writing).toBeVisible();
  expect((await writing.boundingBox())!.height).toBeGreaterThanOrEqual(page.viewportSize()!.height * .4);
  await writing.fill('A little room to think.');
  if (phone) {
    await expect(rail).toBeHidden();
    await writing.blur();
    await expect(rail).toBeVisible();
  }
  await shot('journal');
  await page.getByRole('button', { name: 'Focus', exact: true }).click();
  await expect(rail).toBeHidden();
  await expect(page.locator('.tab-strip')).toBeHidden();
  await shot('focus');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Focus' })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Focus' }).click();
  await page.getByRole('button', { name: 'Focus' }).click();
  const fy = rail.getByRole('button', { name: 'For you', exact: true });
  await expect(fy.locator('.rail-count')).toHaveCount(0); await expect(fy.locator('.rail-dot')).toBeVisible();
  await fy.click();
  await expect(page.locator('.note-title')).toHaveText('For you');
  await shot('for-you');
  {
    await expect(fy.locator('.rail-dot')).toHaveCount(0);
    await rail.getByRole('button', { name: 'Uni', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Uni', level: 1 })).toBeVisible();
    // a room no node owns is under "Other rooms" in the tree, and opens in the room shell
    const narrow = page.viewportSize()!.width < 900;
    if (narrow && await page.locator('.sr-back').count()) await page.locator('.sr-back').click();
    const tree = page.locator(narrow ? '.th-phone-tree' : '.th-roomnav');
    await tree.locator('.th-others .th-fold').click();
    await tree.locator('.th-other .th-go').filter({ hasText: '#garden' }).click();
    await expect(page.getByRole('textbox', { name: 'Message Garden' })).toBeVisible();
    await expect(page.locator('.sr-title')).toHaveText('#garden');
    await shot('other-room');
    await rail.getByRole('button', { name: 'Vault', exact: true }).click();
    await expect(rail.locator('[aria-current="page"], [aria-expanded="true"]')).toHaveCount(1);
    await page.getByRole('button', { name: 'Close panel', exact: true }).click();
    await rail.getByRole('button', { name: 'Journal', exact: true }).click();
    await page.reload();
    await expect(writing).toHaveValue('A little room to think.');
    await rail.getByRole('button', { name: 'Uni', exact: true }).click();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Uni', level: 1 })).toBeVisible();
    await page.evaluate(() => { (window as any).updated = '2026-10-02T12:00:00Z'; (window as any).content += '\n- A new suggestion'; document.dispatchEvent(new Event('visibilitychange')); });
    await expect(fy.locator('.rail-count')).toHaveCount(0);
    await expect(fy.locator('.rail-dot')).toBeVisible();
  }
});

test('Active For you renders the newer version before clearing its dot', async ({ page }, info) => {
  const fy = page.getByRole('navigation').getByRole('button', { name: 'For you', exact: true });
  await fy.click();
  await expect(page.locator('.note-sheet li').filter({ hasText: 'Read something slowly' })).toBeVisible();
  await page.evaluate(() => {
    const w = window as any;
    w.updated = '2026-10-02T12:00:00Z';
    w.content += '\n- A new suggestion';
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(fy.locator('.rail-count')).toHaveCount(0);
  await expect(fy.locator('.rail-dot')).toBeVisible();
  await page.evaluate(() => {
    const w = window as any;
    const invoke = w.__TAURI_INTERNALS__.invoke;
    w.releaseNote = null;
    w.__TAURI_INTERNALS__.invoke = async (cmd: string, args: any) => {
      if (cmd === 'vault_note') await new Promise(resolve => { w.releaseNote = resolve; });
      return invoke(cmd, args);
    };
  });
  await fy.click();
  await expect(fy.locator('.rail-dot')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('uni.forYou.opened.v1'))).toBe('2026-10-01T12:00:00Z');
  await page.waitForFunction(() => !!(window as any).releaseNote);
  await page.evaluate(() => (window as any).releaseNote());
  await expect(page.locator('.note-sheet li').filter({ hasText: 'A new suggestion' })).toBeVisible();
  await expect(fy.locator('.rail-count')).toHaveCount(0);
  await expect(fy.locator('.rail-dot')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('uni.forYou.opened.v1'))).toBe('2026-10-02T12:00:00Z');
});

for (const size of [{ width: 844, height: 390 }, { width: 1092, height: 600 }]) {
  test(`Rail buttons fully reachable at ${size.width}×${size.height}`, async ({ page }) => {
    await page.setViewportSize(size);
    const rail = page.getByRole('navigation', { name: 'Main navigation' });
    if (size.height < 500) {
      await expect(rail).toBeHidden();
      await expect(page.getByRole('textbox', { name: 'Message Uni' })).toBeVisible();
      return;
    }
    for (const button of await rail.getByRole('button').all()) {
      await button.scrollIntoViewIfNeeded();
      const box = (await button.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(size.height);
      const railBox = (await rail.boundingBox())!;
      expect(box.y + box.height).toBeLessThanOrEqual(railBox.y + railBox.height);
    }
    if (size.height === 390) await page.screenshot({ path: '/home/uni/Code/uni-sketches/t21/built/landscape-short.png' });
  });
}

test('For you opened after an old tab set (a note was active) returns to the reading surface; the note itself is not reopened (r7)', async ({ page }) => {
  await page.evaluate(() => {
    localStorage.removeItem('uni.lastSurface.v1');
    localStorage.removeItem('uni.tabs.v2');
    localStorage.setItem('uni.tabs.v1', JSON.stringify({ v: 1, tabs: [
      { id: 'uni', kind: 'room', channel: 'uni-room', title: 'Uni' },
      { id: 'stale', kind: 'note', title: 'ATLAS — Phase 02B', note: { hub: null, vault: 'uni', ref: 'stale-note' } },
    ], active: 'stale', recent: ['uni', 'stale'] }));
  });
  await page.reload();
  // 0.1.46: only places are restored, so the old set opens on its last place, not on the note
  await expect(page.getByRole('textbox', { name: 'Message Uni' })).toBeVisible();
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'For you', exact: true }).click();
  await expect(page.locator('.note-back-label')).toHaveText('Uni');
  await page.locator('.note-back').click();
  await expect(page.getByRole('textbox', { name: 'Message Uni' })).toBeVisible();
});

import { mkdir } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { bootRail } from './railFixture';
import { openRailMore, railGo } from './railGo';

test.beforeEach(async ({ page }) => {
  // the rail fixture answers every unknown command with null, `vault_query` too, which 0.2's home reads as a failed read of the places (and
  // then shows only "Couldn't read your places"); a vault with no area nodes answers an empty list, so that is what it gets here
  await page.addInitScript(() => {
    let v: any;
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, get: () => v, set: (x: any) => { const inv = x.invoke; x.invoke = async (cmd: string, args: any) => (cmd === 'vault_query' ? [] : inv(cmd, args)); v = x; } });
  });
  await bootRail(page);
});
/** 0.2.2: For you (the retired Aaron/For you note) is gone: not on the rail, in More, or in the home's drawer. */
const drawer = (page: import('@playwright/test').Page) => page.locator('#fd-drawer');
async function toHomeDrawer(page: import('@playwright/test').Page) {
  // Uni's own room in focus is Uni already (the rail's Uni leaves it be): its Back steps out to the home
  // (the home comes back with the room it had in focus, as All did: step out of it)
  const focus = page.getByRole('region', { name: /in focus$/ });
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Uni', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Uni', level: 1 })).toBeVisible();
  await page.waitForTimeout(300);
  if (await focus.isVisible()) { await focus.getByRole('button', { name: 'Back to Uni' }).first().click(); await expect(focus).toHaveCount(0); }
  const pull = page.locator('[data-place="front-door"] .fd-pull');
  if ((await pull.getAttribute('aria-expanded')) !== 'true') await pull.click();
  await expect(drawer(page)).toBeVisible();
}

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

test('Rail surfaces, overlay panels, focus; a room no area holds is on Uni\'s home, under Other rooms (r12: no Rooms drawer)', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const rail = page.getByRole('navigation', { name: 'Main navigation' });
  const focus = page.getByRole('region', { name: /in focus$/ });
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
    // 0.2: Uni, Journal, Mail and More on the bar; the rest one tap more
    await expect(rail.getByRole('button').filter({ visible: true })).toHaveCount(4);
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
  // 0.2.2: For you is gone everywhere: not on the rail, in More or in the home's drawer, and the retired note is never read
  await openRailMore(page);
  await expect(rail.getByRole('button', { name: 'For you', exact: true })).toHaveCount(0);
  if (page.viewportSize()!.width < 1100) await rail.getByRole('button', { name: 'More', exact: true }).click(); // More closes again
  {
    await toHomeDrawer(page);
    await expect(drawer(page).getByText('For you')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).forYouReads ?? 0)).toBe(0);
    // T-335: a room no node owns is under "Other rooms" on Uni's home, folded, and opens in focus over All
    const others = page.locator('details.fd-others');
    await others.locator('summary').click();
    await others.getByRole('button', { name: '#Garden', exact: true }).click();
    await expect(focus).toBeVisible();
    await expect(focus.getByRole('textbox', { name: 'Message Garden' })).toBeVisible();
    await expect(focus.locator('.all-focus-title')).toHaveText('#Garden'); // r13: the channel's own name
    await shot('other-room');
    await railGo(page, 'Vault');
    await expect(rail.locator('[aria-current="page"]:visible, [aria-expanded="true"]:visible')).toHaveCount(1);
    await page.getByRole('button', { name: 'Close panel', exact: true }).click();
    await rail.getByRole('button', { name: 'Journal', exact: true }).click();
    await page.reload();
    await expect(writing).toHaveValue('A little room to think.');
    // from the Journal, Uni goes home (0.2: there is no All tab to come back to the room by)
    await rail.getByRole('button', { name: 'Uni', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Uni', level: 1 })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Uni', level: 1 })).toBeVisible();
    expect(await page.evaluate(() => (window as any).forYouReads ?? 0)).toBe(0);
  }
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

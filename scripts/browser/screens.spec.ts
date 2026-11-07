import { mkdir } from 'node:fs/promises';
import { test, expect, type Locator } from '@playwright/test';
import { bootRail } from './railFixture';
import { railGo } from './railGo';

test('All reading surfaces fit the screen', async ({ page }, info) => {
  // the rail's world has no areas: its vault answers the areas read with none (the bare fake answers null, which reads as a failed read and
  // leaves the home with nothing but "Try again"), so the home has its drawer: the rooms no area holds
  await page.addInitScript(() => {
    let inner: any;
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, get: () => inner, set: (v: any) => {
      const invoke = v.invoke;
      v.invoke = async (cmd: string, args: any) => (cmd === 'vault_query' ? [] : invoke(cmd, args));
      inner = v;
    } });
  });
  await bootRail(page);
  const size = page.viewportSize()!;
  const phone = size.width < 600;
  const short = size.height < 500;
  const rail = page.getByRole('navigation', { name: 'Main navigation' });
  const dir = process.env.SCREENS_SHOTS ?? '/home/uni/Code/uni-sketches/t43/audit';
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
  // The rail holds Uni, Journal, Vault, Search and Settings at every width it shows (0.2.2: no For you). A short
  // landscape screen hides the rail (r13): Uni's home shows the app's places itself (T-335: a room is in focus over All; its Back goes home).
  const home = page.locator('[data-place="front-door"][data-view="all"]');
  const toHome = async () => {
    for (let i = 0; i < 4 && !(await home.isVisible() && !(await page.getByRole('region', { name: /in focus$/ }).count())); i++) {
      const focusBack = page.getByRole('region', { name: /in focus$/ }).getByRole('button', { name: 'Back to Uni' });
      if (await focusBack.isVisible()) { await focusBack.click(); continue; }
      const back = page.getByRole('button', { name: /^(← Back|Back to )/ }).filter({ visible: true }).first();
      // 0.2: a rail place (Journal) has no Back of its own; with the rail hidden the way out is the system Back (Android) or Alt+← here
      if (await back.count()) await back.click(); else await page.keyboard.press('Alt+ArrowLeft');
      await home.waitFor({ timeout: 2000 }).catch(() => {}); // one step at a time: a second Back before the first lands goes past the home
    }
    await expect(home).toBeVisible();
    await expect(page.getByRole('region', { name: /in focus$/ })).toHaveCount(0);
  };
  /** 0.2 one home: the drawer under the home's head (the places, the rooms no area holds); open already with no area room. */
  const drawer = async () => {
    const pull = home.locator('.fd-pull');
    if ((await pull.getAttribute('aria-expanded')) !== 'true') await pull.click();
    await expect(home.getByRole('region', { name: 'Your places' })).toBeVisible();
    return home.getByRole('region', { name: 'Your places' });
  };
  const place = async (name: 'Uni' | 'Journal' | 'Settings' | 'Search') => {
    if (!short) { await railGo(page, name); return; }
    await expect(rail).toBeHidden();
    await toHome();
    if (name === 'Uni') return;
    await page.locator('.th-places-short:visible').getByRole('button', { name, exact: true }).click();
  };
  const openPanel = (name: 'Settings' | 'Search') => place(name);
  // T-302 round 2 / T-335: the seeded Uni-room tab is the Uni room, in focus over All: measure once it is saved
  await expect(page.getByRole('region', { name: /in focus$/ }).locator('.all-focus-title')).toHaveText('Uni');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('uni.tabs.v2'))).not.toBeNull();
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
  // 0.2.2: For you (the retired note) is in neither the drawer nor the short screens' places row
  if (short) { await toHome(); await expect(page.locator('.th-places-short:visible').getByRole('button', { name: 'For you', exact: true })).toHaveCount(0); }
  else { await railGo(page, 'Uni'); await toHome(); await expect((await drawer()).getByRole('button', { name: /^For you/ })).toHaveCount(0); }
  await place('Uni');
  await toHome();
  // the rooms no area holds are folded on Uni's home: its last one fits and is a touch target on a phone
  const places = await drawer();
  await places.locator('.fd-others summary').click();
  const lastRoom = places.locator('.fd-others button').last();
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

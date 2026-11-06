// T-335: the update notice is a line at the top of the main pane, in the page's flow, so it never covers the composer or its Send button (it
// used to float bottom-right, over Send on an Android phone). Android: "Update available · Download APK"; desktop: "Update ready · Restart".
// "Later" hides it until the app restarts. The updater and the APK manifest are faked; the areas fixture gives the rooms.
// Run: ELSEWHERE_TEST_PORT=5781 npx playwright test --config playwright.elsewhere.config.ts
import { mkdir } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import { bootAreas } from './areasFixture';
import { railGo } from './railGo';

const SHOTS = process.env.ELSEWHERE_SHOTS ?? '';
const shot = async (page: Page, name: string) => { if (!SHOTS) return; await mkdir(SHOTS, { recursive: true }); await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${name}.png` }); };
const android = (page: Page) => page.evaluate(() => /Android/i.test(navigator.userAgent));
const APK = 'https://example.com/releases/uni-v0.1.99/uni.apk'; // made up: the app's own command checks the real host

async function boot(page: Page) {
  await page.addInitScript((apk) => {
    const w = window as any;
    w.__extraInvoke = async (cmd: string) => {
      if (cmd === 'plugin:app|version') return '0.1.98';
      if (cmd === 'android_update_manifest') return { version: '0.1.99', url: apk };
      if (cmd === 'plugin:updater|check') return { rid: 7, currentVersion: '0.1.98', version: '0.1.99', date: null, body: null, rawJson: {} };
      if (cmd === 'plugin:updater|download_and_install') return null;
      if (cmd === 'open_link') return null;
      return undefined;
    };
  }, APK);
  await bootAreas(page, 'seed', { world: 'unread' });
  await page.locator('[data-place="front-door"]').waitFor();
}

const overlap = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test('the update line is at the top, in the flow, and never over the composer or Send', async ({ page }) => {
  test.setTimeout(120_000);
  await boot(page);
  const notice = page.locator('.update-notice');
  const onAndroid = await android(page);
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(onAndroid ? 'Update available · Uni 0.1.99' : 'Update ready · Uni 0.1.99');
  // in the main pane's flow: it is not laid over anything
  expect(await notice.evaluate((el) => getComputedStyle(el).position)).toBe('static');

  await page.locator('.fd-door[data-path="Areas/Kiln Studio"]').click();
  await expect(page.locator('.sr-title').first()).toHaveText('Kiln Studio');
  const composer = page.locator('.sr-chat .composer').first();
  const send = composer.getByRole('button', { name: 'Send message' });
  await composer.locator('textarea').fill('Unload it after lunch.');
  await expect(send).toBeEnabled();
  const n = (await notice.boundingBox())!; const c = (await composer.boundingBox())!; const s = (await send.boundingBox())!;
  const vp = page.viewportSize()!;
  expect(overlap(n, c)).toBe(false);
  expect(overlap(n, s)).toBe(false);
  // at the top of the window, above the room's header; the composer and Send wholly on screen
  expect(n.y).toBeLessThan(40);
  expect(n.y + n.height).toBeLessThanOrEqual((await page.locator('.sr-head').first().boundingBox())!.y + 1);
  expect(s.y + s.height).toBeLessThanOrEqual(vp.height);
  expect(s.x + s.width).toBeLessThanOrEqual(vp.width);
  // what is at Send's centre is Send itself, not the notice
  expect(await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('button.send'), [s.x + s.width / 2, s.y + s.height / 2])).toBe(true);
  // a finger's target on a touch screen
  if (await page.evaluate(() => matchMedia('(pointer: coarse)').matches)) for (const b of await notice.getByRole('button').all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await shot(page, '05-update-line');

  await notice.getByRole('button', { name: onAndroid ? 'Download APK' : 'Restart' }).click();
  if (onAndroid) await expect.poll(() => page.evaluate(() => (window as any).__calls.filter((x: any) => x.cmd === 'open_link').map((x: any) => x.args.url))).toEqual([APK]);
  await notice.getByRole('button', { name: 'Later' }).click();
  await expect(notice).toHaveCount(0);
  // Settings still has it
  await railGo(page, 'Settings');
  await expect(page.locator('.update-settings')).toContainText(onAndroid ? 'Update 0.1.99 available — Download APK' : 'Update 0.1.99 ready — Restart');
});

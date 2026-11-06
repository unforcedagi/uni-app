import { expect, test, type Page } from '@playwright/test';
import { railGo } from './railGo';

// T-335 motion pass. What moves, where: the Mac and the Pixel keep the app's short motion; Settings → Calm screen (the Daylight, where
// every frame is a slow redraw) or the system's reduced motion stills all of it, script-driven scrolls included. Calm is the device's
// switch, never its user agent. And the "Copied" toast lands centred. Synthetic data only.
const ME = 'a'.repeat(64), UNI = 'b'.repeat(64);

async function boot(page: Page, opts: { history?: number; calm?: boolean } = {}) {
  await page.addInitScript(({ ME, UNI, history, calm }) => {
    const w = window as any;
    // the switch as a device remembers it; once only, so a reload reads what the test changed
    if (calm && !sessionStorage.getItem('booted')) localStorage.setItem('uni.motion', 'calm');
    sessionStorage.setItem('booted', '1');
    localStorage.setItem('uni.tabs.v1', JSON.stringify({ v: 1, tabs: [{ id: 'room', kind: 'room', channel: 'uni-room', title: 'Uni' }], active: 'room', recent: ['room'] }));
    const now = Math.floor(Date.now() / 1000);
    let n = 0;
    const msg = (author: string, ago: number, body: string) => ({ ref: `m${++n}`, channel: 'uni-room', author, author_name: author === ME ? 'Robin' : 'Uni', ts: now - ago, body, mentions: [], reactions: [] });
    w.__msgs = [];
    for (let i = history; i > 0; i--) w.__msgs.push(msg(i % 2 ? UNI : ME, 600 + i * 60, `Earlier note number ${i}: a line about the garden beds and the watering rota, long enough to wrap on a phone.`));
    w.__msgs.push(msg(ME, 42, 'Could you sort the seed list by sowing month?'));
    w.__cbs = []; w.__listeners = {};
    w.__live = (payload: any) => { for (const h of w.__listeners['uni://live'] ?? []) w.__cbs[h]?.({ event: 'uni://live', id: 1, payload }); };
    w.__say = (author: string, body: string) => { w.__msgs.push(msg(author, 0, body)); w.__live({ kind: 'message', channel: 'uni-room', author }); };
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: (cb: any) => { w.__cbs.push(cb); return w.__cbs.length - 1; },
      invoke: async (cmd: string, args: any) => {
        switch (cmd) {
          case 'plugin:event|listen': (w.__listeners[args.event] ??= []).push(args.handler); return args.handler;
          case 'identity_status': return { paired: true, pubkey: ME };
          case 'get_identity': return ME;
          case 'get_npub': return 'npub1example';
          case 'get_rooms': return [{ id: 'uni-room', name: 'Uni', unread: 0 }];
          case 'get_messages': return args.channel === 'uni-room' ? JSON.parse(JSON.stringify(w.__msgs)) : [];
          case 'get_members': return [{ pubkey: ME, name: 'Robin', named: true }, { pubkey: UNI, name: 'Uni', named: true }];
          case 'vault_paths': case 'journal_pending': case 'search_messages': case 'vault_search': case 'vault_tree': case 'journal_list': return [];
          case 'vault_list': return ['uni'];
          case 'journal_config': return { hub: 'https://example.invalid', vault: 'uni' };
          case 'journal_flush': return { sent: [], remaining: 0, error: null };
          case 'refresh': return { pubkey: ME, total_items: 0, channel_errors: {}, truncated_channels: [] };
          default: return null;
        }
      },
    };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  }, { ME, UNI, history: opts.history ?? 2, calm: !!opts.calm });
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'Message Uni' })).toBeVisible();
}

const openSettings = async (page: Page) => {
  await railGo(page, 'Settings');
  await expect(page.getByRole('checkbox', { name: /Calm screen/ })).toBeVisible();
};
const calmOnRoot = (page: Page) => page.evaluate(() => document.documentElement.dataset.motion ?? null);
/** Everything on the page that would move: running animations, and elements with a transition longer than zero. */
const moving = (page: Page) => page.evaluate(() => ({
  animations: document.getAnimations().length,
  transitions: [...document.querySelectorAll('*')].filter((el) => getComputedStyle(el).transitionDuration.split(',').some((d) => parseFloat(d) > 0)).length,
}));
const copyKey = async (page: Page) => {
  await page.getByRole('button', { name: 'Copy your public key' }).click();
  await expect(page.locator('.toast')).toBeVisible();
};

test('the Copied toast lands in the middle of the screen', async ({ page }) => {
  await boot(page);
  await openSettings(page);
  await copyKey(page);
  // once its entrance is over (200 ms), its centre is the window's
  await page.waitForTimeout(400);
  const box = (await page.locator('.toast').boundingBox())!;
  const width = page.viewportSize()!.width;
  expect(Math.abs(box.x + box.width / 2 - width / 2)).toBeLessThan(2);
});

test('the Mac and the Pixel keep their motion: buttons answer, the toast rises', async ({ page }, info) => {
  test.skip(info.project.name === 'daylight', 'the Mac and the Pixel (an Android phone: its user agent says Android too)');
  await boot(page);
  expect(await calmOnRoot(page)).toBeNull();
  const button = page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Settings', exact: true });
  expect(parseFloat(await button.evaluate((b) => getComputedStyle(b).transitionDuration))).toBeGreaterThan(0);
  await openSettings(page);
  await expect(page.getByRole('checkbox', { name: /Calm screen/ })).not.toBeChecked();
  await copyKey(page);
  expect(await page.locator('.toast').evaluate((t) => t.getAnimations().length)).toBe(1);
});

test('Calm screen in Settings stills everything, now and after a restart; off again, the motion is back', async ({ page }) => {
  await boot(page);
  await openSettings(page);
  await page.getByRole('checkbox', { name: /Calm screen/ }).check();
  expect(await calmOnRoot(page)).toBe('calm');
  await copyKey(page);
  expect(await moving(page)).toEqual({ animations: 0, transitions: 0 });
  // a restart: still calm, before anything is touched
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Message Uni' })).toBeVisible();
  expect(await calmOnRoot(page)).toBe('calm');
  expect(await moving(page)).toEqual({ animations: 0, transitions: 0 });
  await openSettings(page);
  await expect(page.getByRole('checkbox', { name: /Calm screen/ })).toBeChecked();
  await page.getByRole('checkbox', { name: /Calm screen/ }).uncheck();
  expect(await calmOnRoot(page)).toBeNull();
  expect((await moving(page)).transitions).toBeGreaterThan(0);
});

test('calm, Jump to latest jumps: a press takes you to the newest message at once, no glide', async ({ page }, info) => {
  await boot(page, { history: 80, calm: true });
  const list = page.getByRole('log', { name: 'Messages' });
  await list.hover();
  await page.mouse.wheel(0, -6000);
  const jump = page.getByRole('button', { name: /^Jump to latest/ });
  await expect(jump).toBeVisible();
  // a real press at its centre (a finger, or the mouse): with nothing moving, pressing it must not move it out from under the press
  const b = (await jump.boundingBox())!;
  if (info.project.use.hasTouch) await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
  else await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  // and at the end at once (a glide over this distance takes a few hundred ms)
  await page.waitForTimeout(100);
  expect(await list.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(2);
});

test('the system asking for reduced motion is calm without the switch, and Settings says so', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await boot(page);
  expect(await calmOnRoot(page)).toBe('calm');
  await openSettings(page);
  await expect(page.getByRole('checkbox', { name: /Calm screen/ })).not.toBeChecked();
  await expect(page.locator('.settings-check')).toContainText('Already calm');
  // the system changes its mind while the app is open: the app follows
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect.poll(() => calmOnRoot(page)).toBeNull();
});

test('storage refusing the choice still calms this session', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'logic, not layout');
  await boot(page);
  await openSettings(page);
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException('full', 'QuotaExceededError'); }; });
  await page.getByRole('checkbox', { name: /Calm screen/ }).check();
  await expect(page.getByRole('checkbox', { name: /Calm screen/ })).toBeChecked();
  expect(await calmOnRoot(page)).toBe('calm');
});

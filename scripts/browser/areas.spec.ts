import { mkdir } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import { bootAreas, GESTURE, navApp } from './areasFixture';
import { startListener } from './areasListener';

const rail = (page: Page) => page.getByRole('navigation', { name: 'Main navigation' });
const openAreas = async (page: Page) => { await rail(page).getByRole('button', { name: 'Areas', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Areas', level: 1 })).toBeVisible(); };
const card = (page: Page, name: string) => page.locator('.area-card', { has: page.locator('strong', { hasText: new RegExp(`^${name}$`) }) });
const openArea = async (page: Page, name: string) => { await card(page, name).click(); await expect(page.locator('.area-bar-title')).toHaveText(name); };
const calls = (page: Page, cmd: string) => page.evaluate((c) => (window as any).__calls.filter((x: any) => x.cmd === c), cmd);

test.describe('seed apps and navigation', () => {
  test.beforeEach(async ({ page }) => bootAreas(page, 'seed'));

  test('home lists areas foreground first, with room pulse', async ({ page }, info) => {
    await openAreas(page);
    const names = await page.locator('.area-card strong').allTextContents();
    expect(names).toEqual(['Techne', 'Unforced Development', 'Atlas', 'Expression', 'Relationships', 'Sanctum']);
    await expect(card(page, 'Techne').locator('.area-mark')).toHaveText(/Foreground/);
    await expect(card(page, 'Techne')).toContainText('Good. Ship Techne first');
    await expect(card(page, 'Relationships')).toContainText('No room linked');
    await expect(card(page, 'Techne')).toContainText('Aaron: Good. Ship Techne first');
    await expect(card(page, 'Atlas')).toContainText('Quiet so far');
    await expect(page.getByRole('button', { name: 'Refresh areas' })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await mkdir('shots/t73', { recursive: true });
    await page.screenshot({ path: `shots/t73/${info.project.name}-areas-home.png` });
  });

  test('techne app renders from bridge data and drafts without sending', async ({ page }, info) => {
    await openAreas(page);
    await openArea(page, 'Techne');
    const iframe = page.locator('iframe.area-frame');
    expect(await iframe.getAttribute('sandbox')).toBe('allow-scripts');
    const f = page.frameLocator('iframe.area-frame');
    await expect(f.locator('#title')).toHaveText('Techne');
    await expect(f.locator('#purpose')).toContainText('The craft of building');
    await expect(f.locator('#pulse li').first()).toContainText('Aaron');
    await expect(f.locator('#notes button')).toHaveCount(3);
    await expect(f.locator('#notes button').first()).toContainText('Workbench log');
    await mkdir('shots/t73', { recursive: true });
    await page.screenshot({ path: `shots/t73/${info.project.name}-area-techne.png` });
    // compose: the room opens with the text in the composer; nothing is posted
    await f.locator('#t').fill('Pairing on the bridge tonight');
    await f.locator('#go').click();
    const box = page.getByRole('textbox', { name: 'Message Techne' });
    await expect(box).toHaveValue('Pairing on the bridge tonight');
    expect(await calls(page, 'post_message')).toHaveLength(0);
    // The area tab stays open next to the room tab.
    await expect(page.locator('.tab-chip')).toHaveCount(2);
    await expect(page.locator('.tab-chip').first()).toContainText('Techne');
    await expect(page.locator('.tab-chip').first().locator('svg.mono-icon')).toHaveCount(1);
  });

  test('note.open uses the note sheet; Back returns to the area', async ({ page }) => {
    await openAreas(page);
    await openArea(page, 'Techne');
    await page.frameLocator('iframe.area-frame').locator('#notes button', { hasText: 'Plan' }).click();
    await expect(page.locator('.note-sheet')).toContainText('Techne plan body');
    await page.locator('.note-back').click();
    await expect(page.locator('.area-bar-title')).toHaveText('Techne');
  });

  test('unforced app renders a dashboard', async ({ page }, info) => {
    await openAreas(page);
    await openArea(page, 'Unforced Development');
    const f = page.frameLocator('iframe.area-frame');
    await expect(f.locator('#s-notes')).toHaveText('3');
    await expect(f.locator('#s-msgs')).toContainText('2');
    await expect(f.locator('#feed li').first()).toContainText('Aaron');
    await mkdir('shots/t73', { recursive: true });
    await page.screenshot({ path: `shots/t73/${info.project.name}-area-unforced.png` });
  });

  test('an area without an app shows the default view', async ({ page }) => {
    await openAreas(page);
    await openArea(page, 'Sanctum');
    await expect(page.locator('iframe')).toHaveCount(0);
    await expect(page.locator('.area-default')).toContainText('Daily practice');
    await expect(page.locator('.area-msg')).toContainText('Sat twenty minutes');
    await page.getByRole('button', { name: 'Open note' }).click();
    await expect(page.locator('.note-sheet')).toBeVisible();
    await page.locator('.note-back').click();
    await page.getByRole('button', { name: 'Open room' }).click();
    await expect(page.getByRole('textbox', { name: 'Message Sanctum' })).toBeVisible();
  });

  test('area tabs restore after reload and Back goes to Areas', async ({ page }) => {
    await openAreas(page);
    await openArea(page, 'Sanctum');
    await page.reload();
    // Launch lands on Uni; the area tab itself is restored in the strip.
    await page.getByRole('tab', { name: /Sanctum/ }).click();
    await expect(page.locator('.area-bar-title')).toHaveText('Sanctum');
    await page.locator('.area-bar .note-back').click();
    await expect(page.getByRole('heading', { name: 'Areas', level: 1 })).toBeVisible();
  });
});

test.describe('dark theme', () => {
  test.use({ colorScheme: 'dark' });
  test('areas home in dark', async ({ page }, info) => {
    await bootAreas(page, 'seed');
    await openAreas(page);
    await expect(card(page, 'Techne')).toBeVisible();
    await mkdir('shots/t73', { recursive: true });
    await page.screenshot({ path: `shots/t73/${info.project.name}-areas-home-dark.png` });
  });
});

test.describe('rail badge', () => {
  test('a zero For you count renders no badge', async ({ page }) => {
    await bootAreas(page, 'seed');
    await expect(rail(page).getByRole('button', { name: 'For you' })).toBeVisible();
    await expect(page.locator('.rail-count')).toHaveCount(0);
  });
});

const openSettings = async (page: Page) => { await rail(page).getByRole('button', { name: 'Settings' }).click(); await expect(page.getByRole('button', { name: 'Run sandbox self-test' })).toBeVisible(); };
const stored = (page: Page) => page.evaluate(() => localStorage.getItem('uni.areaApps.selftest.v1'));

test.describe('sandbox self-test', () => {
  test('a pass lists every check and opens the gate for this version', async ({ page }, info) => {
    await bootAreas(page, 'seed', { selftest: false });
    // Gate is closed by default: an area with an app shows the default view.
    await openAreas(page);
    await openArea(page, 'Techne');
    await expect(page.locator('iframe')).toHaveCount(0);
    expect(await stored(page)).toBeNull();
    await openSettings(page);
    await page.getByRole('button', { name: 'Run sandbox self-test' }).click();
    await expect(page.locator('.selftest-status.pass')).toContainText('Passed', { timeout: 15000 });
    const items = page.locator('.selftest-list li');
    expect(await items.count()).toBeGreaterThanOrEqual(18);
    await expect(page.locator('.selftest-list li.fail')).toHaveCount(0);
    await expect(items.filter({ hasText: 'webkit.messageHandlers.ipc' })).toHaveClass('pass');
    await expect(items.filter({ hasText: 'window.ipc' })).toHaveClass('pass');
    const pass = JSON.parse((await stored(page))!);
    expect(pass).toMatchObject({ platform: 'linux', appVersion: 'dev' });
    expect(pass.userAgent).toBe(await page.evaluate(() => navigator.userAgent));
    expect(Date.parse(pass.passedAt)).toBeGreaterThan(0);
    await mkdir('shots/t73', { recursive: true });
    await page.screenshot({ path: `shots/t73/${info.project.name}-selftest.png` });
    // The stored pass now opens the live frame.
    await page.getByRole('button', { name: 'Close panel' }).click();
    await openAreas(page);
    await openArea(page, 'Techne');
    await expect(page.locator('iframe.area-frame')).toHaveCount(1);
  });

  test('IPC reachable from the frame fails the test and stores nothing', async ({ page }) => {
    await bootAreas(page, 'seed', { selftest: false, ipcLeak: true });
    await openSettings(page);
    await page.getByRole('button', { name: 'Run sandbox self-test' }).click();
    await expect(page.locator('.selftest-status.fail')).toContainText('Failed', { timeout: 15000 });
    await expect(page.locator('.selftest-list li.fail')).toHaveCount(1);
    await expect(page.locator('.selftest-list li.fail')).toContainText('window.ipc');
    expect(await stored(page)).toBeNull();
  });

  test('a pass for another app version does not open the gate', async ({ page }) => {
    await bootAreas(page, 'seed', { selftest: false });
    await page.evaluate(() => localStorage.setItem('uni.areaApps.selftest.v1', JSON.stringify({ platform: 'linux', passedAt: '2026-01-01T00:00:00Z', appVersion: '0.0.1' })));
    await page.reload();
    await openAreas(page);
    await openArea(page, 'Techne');
    await expect(page.locator('iframe')).toHaveCount(0);
  });
});

test.describe('platform gate', () => {
  test.use({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36' });
  test('android stays on the default view even when an app exists', async ({ page }) => {
    await bootAreas(page, 'seed');
    await openAreas(page);
    await openArea(page, 'Techne');
    await expect(page.locator('iframe')).toHaveCount(0);
    await expect(page.locator('.area-default')).toContainText('The craft of building');
    expect(await calls(page, 'vault_note').then((c: any[]) => c.filter((x) => x.args.noteRef === 'app-techne'))).toHaveLength(0);
  });
});

test.describe('hostile and benign apps', () => {
  let L: Awaited<ReturnType<typeof startListener>>;
  test.beforeEach(async ({ page }) => { L = await startListener(); await bootAreas(page, 'test', { ports: L.ports }); });
  test.afterEach(async () => { await L.close(); });

  test('a benign app renders using bridge data', async ({ page }) => {
    await openAreas(page);
    await openArea(page, 'Benign');
    const f = page.frameLocator('iframe.area-frame');
    await expect(f.locator('#t')).toHaveText('Benign');
    await expect(f.locator('#n')).toHaveText('Alpha');
    await expect(f.locator('#th')).toContainText(/accent=#?\w+/);
  });

  test('a hostile app is contained', async ({ page }) => {
    const events: string[] = [];
    page.on('request', (r) => { if (r.url().includes(`:${L.ports.http}`)) events.push('request ' + r.url()); });
    page.on('requestfailed', (r) => { if (r.url().includes(`:${L.ports.http}`)) events.push('failed ' + r.url() + ' ' + r.failure()?.errorText); });
    const before = page.url();
    await openAreas(page);
    await openArea(page, 'Hostile');
    const out = page.frameLocator('iframe.area-frame').locator('#out');
    await expect(out).toContainText('"flood"', { timeout: 20000 });
    const R = JSON.parse((await out.textContent())!);

    for (const k of ['fetch', 'xhr', 'ws', 'img', 'topRead', 'parentDoc', 'cookie', 'storage', 'eval', 'beacon', 'rtcNew']) expect(R[k], k).toMatch(/^blocked/);
    expect(R.tauri).toBe('blocked:absent');
    expect(R.rtc, 'WebRTC is removed before app code runs').toBe('blocked:absent');
    expect(R.parentTauri).toMatch(/^blocked/);
    expect(R.popup).toMatch(/^blocked/);
    expect(String(R.topWrite)).not.toMatch(/^LEAK/);
    // Anything the frame tried to fetch was refused by the CSP before leaving the page.
    expect(events.filter((e) => e.startsWith('request')).length).toBe(events.filter((e) => /^failed .* csp$/.test(e)).length);
    expect(events.length).toBeGreaterThan(0);
    // A real listener on loopback (HTTP and the TURN UDP port) saw nothing: fetch, XHR, WebSocket, image, beacon,
    // popup, nested frame, dns-prefetch/preconnect/prefetch/prerender hints and RTCPeerConnection.
    expect(L.urls, 'no HTTP request reached the listener').toEqual([]);
    expect(L.datagrams, 'no UDP datagram reached the TURN port').toEqual([]);
    expect(page.url()).toBe(before);
    expect(await page.locator('iframe.area-frame').getAttribute('sandbox')).toBe('allow-scripts');

    expect(R['bridge:unk']).toBe('unknown_method');
    expect(R['bridge:big']).toBe('too_large');
    expect(R['bridge:out1']).toBe('out_of_scope');
    expect(R['bridge:out2']).toBe('out_of_scope');
    expect(R['bridge:out3']).toBe('out_of_scope');
    expect(R['bridge:extra']).toBe('bad_request');
    expect(R['bridge:v2']).toBe('bad_version');
    expect(R['bridge:longid']).toBe('none');
    expect(R.stray).toBe('none');
    // Every incoming message counts (11 above + the flood); over the limit the bridge goes silent.
    const flood = JSON.parse(R.flood);
    expect(flood.ok).toBeGreaterThan(0);
    expect(flood.ok).toBeLessThanOrEqual(60 - 11);
    expect(flood.err, 'over the limit nothing is answered').toBe(0);
    expect(flood.none).toBeGreaterThanOrEqual(40);
    // The out-of-scope paths never reached the vault.
    const notes = (await calls(page, 'vault_note')).map((c: any) => c.args.noteRef);
    expect(notes.filter((n: string) => /Atlas|passwd|\.\./.test(n))).toEqual([]);
    expect(await calls(page, 'post_message')).toHaveLength(0);
  });
});

const STOPPED = 'This area app tried to leave its sandbox and was stopped.';
test.describe('navigation', () => {
  let L: Awaited<ReturnType<typeof startListener>>;
  test.beforeEach(async () => { L = await startListener(); });
  test.afterEach(async () => { await L.close(); });

  for (const vector of ['self', 'meta', 'anchor', 'write'] as const) {
    test(`a late ${vector} navigation is blocked by frame-src and stops the frame`, async ({ page }) => {
      await bootAreas(page, 'seed', { ports: L.ports, apps: [{ name: 'Nav', html: navApp(vector, L.ports) }] });
      await openAreas(page);
      await openArea(page, 'Nav');
      await expect(page.getByText(STOPPED)).toBeVisible({ timeout: 10000 });
      await expect(page.locator('iframe.area-frame')).toHaveCount(0);
      await page.waitForTimeout(600);
      expect(L.urls, 'the navigation never reached the network').toEqual([]);
    });
  }

  test('with no host CSP the tripwire still unmounts the frame on a second load', async ({ page }) => {
    // Second line of defence only: without frame-src the request itself can't be stopped.
    await bootAreas(page, 'seed', { ports: L.ports, noHostCsp: true, apps: [{ name: 'Nav', html: navApp('self', L.ports) }] });
    expect(await page.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]'))).toBeNull();
    await openAreas(page);
    await openArea(page, 'Nav');
    await expect(page.getByText(STOPPED)).toBeVisible({ timeout: 10000 });
    await expect(page.locator('iframe.area-frame')).toHaveCount(0);
  });
});

test.describe('gestures', () => {
  test.beforeEach(async ({ page }) => bootAreas(page, 'seed', { apps: [{ name: 'Gesture', html: GESTURE }] }));

  test('compose and note.open on load are refused; a click in the frame allows a draft, once', async ({ page }) => {
    await openAreas(page);
    await openArea(page, 'Gesture');
    const f = page.frameLocator('iframe.area-frame');
    await expect(f.locator('#out')).toContainText('loadOpen', { timeout: 10000 });
    const R = JSON.parse((await f.locator('#out').textContent())!);
    expect(R.loadCompose).toEqual({ error: 'needs_gesture' });
    expect(R.loadOpen).toEqual({ error: 'needs_gesture' });
    await expect(page.locator('.note-sheet')).toHaveCount(0);
    await expect(page.locator('.tab-chip')).toHaveCount(2);
    // A tap on the host UI is not a tap in the frame; a real click inside is.
    await f.locator('#go').click();
    await expect(page.getByRole('textbox', { name: 'Message Techne' })).toHaveValue('from click');
    expect(await calls(page, 'post_message')).toHaveLength(0);
  });

  test('note.open outside Areas/<Name>/ is refused even with a gesture', async ({ page }) => {
    await openAreas(page);
    await openArea(page, 'Gesture');
    const f = page.frameLocator('iframe.area-frame');
    await expect(f.locator('#out')).toContainText('loadOpen', { timeout: 10000 });
    await f.locator('#open').click();
    await expect(f.locator('#out')).toContainText('"outOfScope":{"error":"out_of_scope"}');
    await expect(page.locator('.note-sheet')).toHaveCount(0);
  });
});

test.describe('listing cache', () => {
  test('vault_paths is shared and the focus reload is debounced', async ({ page }) => {
    await bootAreas(page, 'seed');
    await openAreas(page);
    await expect(card(page, 'Techne')).toBeVisible();
    const n0 = (await calls(page, 'vault_paths')).length;
    for (let i = 0; i < 4; i++) await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForTimeout(400);
    expect((await calls(page, 'vault_paths')).length, 'visibility reloads within 30 s are skipped').toBe(n0);
    await openArea(page, 'Techne');
    await expect(page.frameLocator('iframe.area-frame').locator('#notes button')).toHaveCount(3);
    expect((await calls(page, 'vault_paths')).length, 'the area view and notes.list reuse the cached listing').toBe(n0);
  });
});

test.describe('self-test hardening', () => {
  test('a stripped CSP fails the self-test (it needs a positive violation, not an absence of success)', async ({ page }) => {
    await bootAreas(page, 'seed', { selftest: false, stripCsp: true });
    await openSettings(page);
    await page.getByRole('button', { name: 'Run sandbox self-test' }).click();
    await expect(page.locator('.selftest-status.fail')).toContainText('Failed', { timeout: 25000 });
    const failed = await page.locator('.selftest-list li.fail').allTextContents();
    expect(failed.join('|')).toMatch(/fetch/);
    expect(failed.join('|')).toMatch(/XMLHttpRequest/);
    await expect(page.locator('.selftest-status.pass')).toHaveCount(0);
    expect(await stored(page)).toBeNull();
  });

  test('a failed re-run clears an earlier pass', async ({ page }) => {
    await bootAreas(page, 'seed', { selftest: true, ipcLeak: true });
    expect(await stored(page)).not.toBeNull();
    await openSettings(page);
    await expect(page.locator('.selftest-status').first()).toContainText('Live area apps enabled');
    await page.getByRole('button', { name: 'Run sandbox self-test' }).click();
    await expect(page.locator('.selftest-status.fail')).toContainText('Failed', { timeout: 25000 });
    expect(await stored(page)).toBeNull();
    await expect(page.locator('.selftest-status', { hasText: 'Live area apps enabled' })).toHaveCount(0);
  });

  test('a pass recorded under another user agent does not open the gate', async ({ page }) => {
    await bootAreas(page, 'seed', { selftest: true, passUa: 'Mozilla/5.0 (X11; Linux x86_64) WebKitGTK/0.0' });
    await openAreas(page);
    await openArea(page, 'Techne');
    await expect(page.locator('iframe')).toHaveCount(0);
  });

  test('a getVersion() failure keeps the gate closed', async ({ page }) => {
    await bootAreas(page, 'seed', { selftest: true, versionFails: true });
    await openAreas(page);
    await openArea(page, 'Techne');
    await expect(page.locator('iframe')).toHaveCount(0);
  });

  test('a pass opens an already-mounted area without a remount', async ({ page }) => {
    await bootAreas(page, 'seed', { selftest: false });
    await openAreas(page);
    await openArea(page, 'Techne');
    await expect(page.locator('iframe')).toHaveCount(0);
    await page.evaluate(() => document.querySelector('.area-view')?.setAttribute('data-keep', '1'));
    await openSettings(page);
    await page.getByRole('button', { name: 'Run sandbox self-test' }).click();
    await expect(page.locator('.selftest-status.pass')).toContainText('Passed', { timeout: 25000 });
    await expect(page.locator('.area-view[data-keep] iframe.area-frame')).toHaveCount(1);
  });
});

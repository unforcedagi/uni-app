import { mkdir } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import { bootAreas, FOCUS_STEAL, navApp, SUGGEST } from './areasFixture';
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
    await mkdir('shots/t74', { recursive: true });
    await page.screenshot({ path: `shots/t74/${info.project.name}-areas-home.png` });
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
    await mkdir('shots/t74', { recursive: true });
    await page.screenshot({ path: `shots/t74/${info.project.name}-area-techne.png` });
    // chat.draft is a pending suggestion in the host bar; only a tap on the host UI drafts it
    await f.locator('#t').fill('Pairing on the bridge tonight');
    await f.locator('#go').click();
    const bar = page.locator('.suggestion-bar');
    await expect(bar).toContainText('Techne suggests a draft for #Techne');
    await expect(bar).toContainText('Pairing on the bridge tonight');
    await mkdir('shots/t74', { recursive: true });
    await page.screenshot({ path: `shots/t74/${info.project.name}-suggestion-bar.png` });
    const box = page.getByRole('textbox', { name: 'Message Techne' });
    await expect(box, 'nothing reached a composer yet').toHaveCount(0);
    await bar.getByRole('button', { name: 'Add to draft' }).click();
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
    await expect(page.locator('.suggestion-bar')).toContainText('suggests opening Areas/Techne/Plan');
    await expect(page.locator('.note-sheet'), 'a tap in the frame does not open it').toHaveCount(0);
    await page.locator('.suggestion-bar').getByRole('button', { name: 'Open' }).click();
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
    await mkdir('shots/t74', { recursive: true });
    await page.screenshot({ path: `shots/t74/${info.project.name}-area-unforced.png` });
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
    await mkdir('shots/t74', { recursive: true });
    await page.screenshot({ path: `shots/t74/${info.project.name}-areas-home-dark.png` });
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
  test.describe.configure({ timeout: 120000 });
  test('a pass lists every check and opens the gate for this version', async ({ page }, info) => {
    await bootAreas(page, 'seed', { selftest: false });
    // Gate is closed by default: an area with an app shows the default view.
    await openAreas(page);
    await openArea(page, 'Techne');
    await expect(page.locator('iframe')).toHaveCount(0);
    expect(await stored(page)).toBeNull();
    await openSettings(page);
    await page.getByRole('button', { name: 'Run sandbox self-test' }).click();
    await expect(page.locator('.selftest-status.pass')).toContainText('Passed', { timeout: 60000 });
    const items = page.locator('.selftest-list li');
    expect(await items.count()).toBe(19);
    await expect(page.locator('.selftest-list li.fail')).toHaveCount(0);
    await expect(items.filter({ hasText: 'webkit.messageHandlers.ipc' })).toHaveClass('pass');
    await expect(items.filter({ hasText: 'window.ipc' })).toHaveClass('pass');
    const pass = JSON.parse((await stored(page))!);
    expect(pass).toMatchObject({ platform: 'linux', appVersion: 'dev' });
    expect(pass.userAgent).toBe(await page.evaluate(() => navigator.userAgent));
    expect(Date.parse(pass.passedAt)).toBeGreaterThan(0);
    await mkdir('shots/t74', { recursive: true });
    await page.screenshot({ path: `shots/t74/${info.project.name}-selftest.png` });
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
    await expect(page.locator('.selftest-status.fail')).toContainText('Failed', { timeout: 60000 });
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

  test('a benign app renders using the contract kits', async ({ page }) => {
    await openAreas(page);
    await openArea(page, 'Benign');
    const f = page.frameLocator('iframe.area-frame');
    await expect(f.locator('#t')).toHaveText('Benign');
    await expect(f.locator('#n')).toHaveText('Alpha');
    await expect(f.locator('#c')).toHaveText(/msgs=[1-9]/);
    await expect(f.locator('#th')).toContainText(/accent=#?\w+/);
  });

  test('a hostile app is contained', async ({ page, browserName }) => {
    test.setTimeout(90000);
    const events: string[] = [];
    page.on('request', (r) => { if (r.url().includes(`:${L.ports.http}`)) events.push('request ' + r.url()); });
    page.on('requestfailed', (r) => { if (r.url().includes(`:${L.ports.http}`)) events.push('failed ' + r.url() + ' ' + r.failure()?.errorText); });
    const before = page.url();
    await openAreas(page);
    await openArea(page, 'Hostile');
    const out = page.frameLocator('iframe.area-frame').locator('#out');
    await expect(out).toContainText('"flood"', { timeout: 60000 });
    const R = JSON.parse((await out.textContent())!);

    for (const k of ['fetch', 'xhr', 'ws', 'img', 'topRead', 'parentDoc', 'cookie', 'storage', 'eval', 'rtcNew']) expect(R[k], k).toMatch(/^blocked/);
    // sendBeacon reports "queued" even when the CSP then refuses it; the listener below is what proves nothing left.
    expect(R.tauri).toBe('blocked:absent');
    expect(R.rtc, 'WebRTC is removed before app code runs').toBe('blocked:absent');
    expect(R.parentTauri).toMatch(/^blocked/);
    expect(R.popup).toMatch(/^blocked/);
    expect(String(R.topWrite)).not.toMatch(/^LEAK/);
    // Anything the frame tried to fetch was refused by the CSP before leaving the page.
    // (Chromium names the failure `csp`; WebKit words it differently, and the listener below is the proof on both.)
    if (browserName === 'chromium') {
      expect(events.filter((e) => e.startsWith('request')).length).toBe(events.filter((e) => /^failed .* csp$/.test(e)).length);
      expect(events.length).toBeGreaterThan(0);
    }
    // A real listener on loopback (HTTP and the TURN UDP port) saw nothing: fetch, XHR, WebSocket, image, beacon,
    // popup, nested frame, dns-prefetch/preconnect/prefetch/prerender hints and RTCPeerConnection.
    expect(L.urls, 'no HTTP request reached the listener').toEqual([]);
    expect(L.datagrams, 'no UDP datagram reached the TURN port').toEqual([]);
    expect(page.url()).toBe(before);
    expect(await page.locator('iframe.area-frame').getAttribute('sandbox')).toBe('allow-scripts');

    expect(R['c:unk']).toBe('unknown_namespace');
    expect(R['c:unm']).toBe('unknown_method');
    expect(R['c:big']).toBe('too_large');
    expect(R['c:room']).toBe('out_of_scope');
    expect(R['c:out1']).toBe('out_of_scope');
    expect(R['c:out2']).toBe('out_of_scope');
    expect(R['c:out3']).toBe('out_of_scope');
    expect(R['c:extra']).toBe('bad_request');
    expect(R['c:ver']).toBe('bad_version');
    // vault over the frame: other areas are 403 (prefix) or 404 (note), POST is 405, search/id never return Atlas
    expect(R['c:v1']).toBe('http404');
    expect(R['c:v2']).toBe('http403');
    expect(R['c:v3']).toBe('http200');
    expect(R['c:v4']).toBe('http200');
    expect(R['c:v5']).toBe('http403');
    expect(R['c:v6']).toBe('http405');
    expect(R['c:v7']).toBe('http404');
    expect(R.vaultBodies).not.toMatch(/ATLAS-SECRET|Secret/);
    expect(R['c:longid']).toBe('none');
    expect(R.stray).toBe('none');
    // Pending suggestions are capped; a flood of drafts only ever reaches the host bar.
    expect(JSON.parse(R.suggest).filter((x: string) => x === 'result')).toHaveLength(3);
    // Every incoming message counts; over the limit the session goes silent.
    const flood = JSON.parse(R.flood);
    expect(flood.ok).toBeGreaterThan(0);
    expect(flood.ok).toBeLessThanOrEqual(60 - 26);
    expect(flood.err, 'over the limit nothing is answered').toBe(0);
    expect(flood.none).toBeGreaterThanOrEqual(40);
    // The out-of-scope notes were never fetched for the app's benefit: every vault_note the host made was in scope or by an id it then refused.
    const notes = (await calls(page, 'vault_note')).map((c: any) => c.args.noteRef);
    expect(notes.filter((n: string) => /passwd|\.\./.test(n))).toEqual([]);
    await expect(page.locator('.suggestion-bar .suggestion')).toHaveCount(3);
    await expect(page.getByRole('textbox', { name: /Message/ })).toHaveCount(0);
    expect(await calls(page, 'post_message')).toHaveLength(0);
  });
});

const STOPPED = 'This app tried to leave its sandbox and was stopped.';
test.describe('navigation', () => {
  let L: Awaited<ReturnType<typeof startListener>>;
  test.beforeEach(async () => { L = await startListener(); });
  test.afterEach(async () => { await L.close(); });

  for (const vector of ['self', 'meta', 'anchor', 'write', 'parse'] as const) {
    test(`a ${vector} navigation is blocked by frame-src and stops the frame`, async ({ page }) => {
      await bootAreas(page, 'seed', { ports: L.ports, apps: [{ name: 'Nav', html: navApp(vector, L.ports) }] });
      await openAreas(page);
      await openArea(page, 'Nav');
      await expect(page.getByText(STOPPED)).toBeVisible({ timeout: 10000 });
      await expect(page.locator('iframe.area-frame')).toHaveCount(0);
      await page.waitForTimeout(600);
      expect(L.urls, 'the navigation never reached the network').toEqual([]);
    });
  }

  test('with no host CSP the self-test fails: a reload is not proof, only a host-seen frame-src violation is', async ({ page }) => {
    await bootAreas(page, 'seed', { selftest: false, noHostCsp: true });
    await openSettings(page);
    await page.getByRole('button', { name: 'Run sandbox self-test' }).click();
    await expect(page.locator('.selftest-status.fail')).toContainText('Failed', { timeout: 60000 });
    const failed = (await page.locator('.selftest-list li.fail').allTextContents()).join('|');
    for (const what of ['Self-navigation', 'Meta refresh', 'Link navigation', 'Navigation during page parse']) expect(failed).toContain(what);
    expect(await stored(page)).toBeNull();
  });

  test('a benign #anchor link keeps the app mounted (no load tripwire to false-positive)', async ({ page }) => {
    await bootAreas(page, 'test');
    await openAreas(page);
    await openArea(page, 'Benign');
    const f = page.frameLocator('iframe.area-frame');
    await expect(f.locator('#t')).toHaveText('Benign');
    await f.locator('#jump').click();
    await page.waitForTimeout(500);
    await expect(page.locator('iframe.area-frame')).toHaveCount(1);
    await expect(page.getByText(STOPPED)).toHaveCount(0);
    await expect(f.locator('#t')).toHaveText('Benign');
  });
});

test.describe('suggestions: only a tap on host UI acts', () => {
  test('draft and open on load are pending suggestions; nothing opens, drafts or posts until a host tap', async ({ page }) => {
    await bootAreas(page, 'seed', { apps: [{ name: 'Suggest', html: SUGGEST }] });
    await openAreas(page);
    await openArea(page, 'Suggest');
    const f = page.frameLocator('iframe.area-frame');
    await expect(f.locator('#out')).toContainText('loadOpen', { timeout: 10000 });
    const R = JSON.parse((await f.locator('#out').textContent())!);
    expect(R.loadDraft).toEqual({ result: { pending: true, room: 'ch-techne' } });
    expect(R.loadOpen).toEqual({ result: { pending: true } });
    const bar = page.locator('.suggestion-bar');
    await expect(bar.locator('.suggestion')).toHaveCount(2);
    await expect(page.locator('.note-sheet')).toHaveCount(0);
    await expect(page.locator('.tab-chip'), 'no room tab was opened').toHaveCount(1);
    expect(await calls(page, 'post_message')).toHaveLength(0);
    await bar.getByRole('button', { name: 'Dismiss' }).first().click();
    await bar.getByRole('button', { name: 'Dismiss' }).first().click();
    await expect(bar).toHaveCount(0);
    await expect(page.locator('.tab-chip')).toHaveCount(1);
  });

  test('note.open outside Areas/<Name>/ is refused', async ({ page }) => {
    await bootAreas(page, 'seed', { apps: [{ name: 'Suggest', html: SUGGEST }] });
    await openAreas(page);
    await openArea(page, 'Suggest');
    const f = page.frameLocator('iframe.area-frame');
    await expect(f.locator('#out')).toContainText('loadOpen', { timeout: 10000 });
    await f.locator('#open').click();
    await expect(f.locator('#out')).toContainText('"outOfScope":{"error":"out_of_scope"}');
    await expect(page.locator('.suggestion-bar .suggestion')).toHaveCount(2);
  });

  test('focus stealing (review 2 P2-C): tapping the area card and an app that grabs focus and keeps asking drafts nothing', async ({ page }) => {
    await bootAreas(page, 'seed', { apps: [{ name: 'Steal', html: FOCUS_STEAL }] });
    await openAreas(page);
    await openArea(page, 'Steal');
    await page.waitForTimeout(2500);
    const tabs = await page.locator('.tab-chip').allTextContents();
    expect(tabs.join('|')).not.toMatch(/Techne\s*$/);
    expect(await page.locator('.tab-chip').count(), 'the view was not hijacked into a room').toBe(1);
    await expect(page.locator('.area-bar-title')).toHaveText('Steal');
    await expect(page.locator('.suggestion-bar .suggestion'), 'pending is capped').toHaveCount(3);
    expect(await calls(page, 'post_message')).toHaveLength(0);
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
    expect((await calls(page, 'vault_paths')).length, 'the area view and the vault module reuse the cached listing').toBe(n0);
  });
});

test.describe('self-test hardening', () => {
  test.describe.configure({ timeout: 120000 });
  test('a stripped CSP fails the self-test (it needs a positive violation, not an absence of success)', async ({ page }) => {
    await bootAreas(page, 'seed', { selftest: false, stripCsp: true });
    await openSettings(page);
    await page.getByRole('button', { name: 'Run sandbox self-test' }).click();
    await expect(page.locator('.selftest-status.fail')).toContainText('Failed', { timeout: 60000 });
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
    await expect(page.locator('.selftest-status.fail')).toContainText('Failed', { timeout: 60000 });
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
    await expect(page.locator('.selftest-status.pass')).toContainText('Passed', { timeout: 60000 });
    await expect(page.locator('.area-view[data-keep] iframe.area-frame')).toHaveCount(1);
  });
});

// ---- design (Uni's screenshot review)
const lum = (c: [number, number, number]) => { const f = c.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2]; };
const ratio = (a: [number, number, number], b: [number, number, number]) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
/** Foreground colour of `sel` against the first opaque background up its ancestors (alpha flattened onto the page). */
const contrastOf = (page: Page, sel: string) => page.evaluate(([s]) => {
  const parse = (v: string): [number, number, number, number] => {
    const m = /color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)/.exec(v);
    if (m) return [+m[1] * 255, +m[2] * 255, +m[3] * 255, m[4] === undefined ? 1 : +m[4]];
    const n = /rgba?\(([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:[,/ ]+([\d.]+))?\)/.exec(v)!;
    return [+n[1], +n[2], +n[3], n[4] === undefined ? 1 : +n[4]];
  };
  const el = document.querySelector(s)!;
  let bg: [number, number, number] = [255, 255, 255];
  const stack: Element[] = []; for (let e: Element | null = el; e; e = e.parentElement) stack.push(e);
  for (const e of stack.reverse()) { const c = parse(getComputedStyle(e).backgroundColor); if (c[3] > 0) bg = [0, 1, 2].map((i) => c[i] * c[3] + bg[i] * (1 - c[3])) as [number, number, number]; }
  const f = parse(getComputedStyle(el).color);
  return { fg: [f[0], f[1], f[2]] as [number, number, number], bg };
}, [sel]);

test.describe('design', () => {
  test.beforeEach(async ({ page }) => bootAreas(page, 'seed'));

  test('foreground cards: a straight inset rule, text aligned with background cards, elevated warm tint', async ({ page }) => {
    await openAreas(page);
    const fg = card(page, 'Techne'), bg = card(page, 'Atlas');
    const edge = await fg.evaluate((el) => getComputedStyle(el).borderLeftWidth);
    expect(edge, 'no bending border-left').toBe('1px');
    const rule = await fg.evaluate((el) => { const s = getComputedStyle(el, '::before'); return { radius: s.borderTopLeftRadius, width: s.width, left: s.left, content: s.content }; });
    expect(rule.radius).toBe('0px'); expect(rule.width).toBe('3px'); expect(rule.content).not.toBe('none');
    const x = async (c: ReturnType<typeof card>) => c.locator('.area-mark').evaluate((el) => el.getBoundingClientRect().left - (el.closest('.area-card') as HTMLElement).getBoundingClientRect().left);
    expect(await x(fg), 'text columns align across card kinds').toBe(await x(bg));
    const tint = await fg.evaluate((el) => getComputedStyle(el).backgroundColor);
    const plain = await bg.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(tint).not.toBe(plain);
  });

  test('snippets clamp to two lines instead of cutting mid-word with an ellipsis on one line', async ({ page }) => {
    await openAreas(page);
    const style = await card(page, 'Techne').locator('.area-latest > span').first().evaluate((el) => { const s = getComputedStyle(el); return { clamp: s.webkitLineClamp, ws: s.whiteSpace }; });
    expect(style.clamp).toBe('2');
    expect(style.ws).not.toBe('nowrap');
  });

  test('the active rail item is a pill behind the icon, not a square tile', async ({ page }) => {
    await openAreas(page);
    const active = rail(page).getByRole('button', { name: 'Areas', exact: true });
    const s = await active.evaluate((b) => { const i = b.querySelector('i')!; const a = getComputedStyle(b), c = getComputedStyle(i); return { btn: a.backgroundColor, pill: c.backgroundColor, radius: parseFloat(c.borderTopLeftRadius), h: i.getBoundingClientRect().height, w: i.getBoundingClientRect().width }; });
    expect(s.btn).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    expect(s.pill).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    expect(s.radius).toBeGreaterThanOrEqual(s.h / 2);
    expect(s.w).toBeGreaterThan(s.h);
  });

  test('phone top bar: the chip is on the 16px grid', async ({ page }, info) => {
    test.skip(info.project.name !== 'phone', 'phone strip only');
    await openAreas(page);
    const box = (await page.locator('.tab-chip').first().boundingBox())!, strip = (await page.locator('.tab-strip').boundingBox())!;
    expect(box.x - strip.x, 'left inset').toBeGreaterThanOrEqual(16);
    expect(box.y - strip.y, 'top inset').toBeGreaterThanOrEqual(8);
  });

  test('techne: bench sits in the hero, the note card sizes to its content, the first line sits on the first rule', async ({ page }, info) => {
    await openAreas(page);
    await openArea(page, 'Techne');
    const f = page.frameLocator('iframe.area-frame');
    await expect(f.locator('#notes button')).toHaveCount(3);
    const q = (sel: string) => f.locator(sel).first().boundingBox();
    const bench = await q('[aria-label="Notes on the bench"]'), title = await q('#title'), pulse = await q('[aria-label="Recent pulse"]'), note = await q('[aria-label="Say something"]');
    if (info.project.name === 'desktop') {
      expect(bench!.y, 'bench is up in the hero').toBeLessThan(pulse!.y);
      expect(bench!.y).toBeLessThan(title!.y + title!.height);
      expect(bench!.x).toBeGreaterThan(title!.x + 300);
    }
    expect(note!.height, 'the note card does not stretch to the pulse column').toBeLessThan(pulse!.height - 100);
    // Rule under the first text line: the rule's offset inside the textarea equals the baseline of line one.
    const geo = await f.locator('#t').evaluate((t: HTMLTextAreaElement) => {
      const s = getComputedStyle(t);
      const probe = document.createElement('span'); probe.style.cssText = 'position:absolute;visibility:hidden;font:' + s.font + ';line-height:' + s.lineHeight; probe.innerHTML = 'Hx<i style="display:inline-block;width:0;height:0;vertical-align:baseline"></i>';
      document.body.appendChild(probe); const base = (probe.querySelector('i') as HTMLElement).getBoundingClientRect().bottom - probe.getBoundingClientRect().top; probe.remove();
      return { base, img: s.backgroundImage, size: s.backgroundSize, origin: s.backgroundOrigin, clip: s.backgroundClip, attach: s.backgroundAttachment };
    });
    expect(geo.attach).toMatch(/^local/);
    expect(geo.origin, 'tiles start at the first line, not in the padding above it').toMatch(/^content-box/);
    expect(geo.clip, 'nothing is ruled above the first line').toMatch(/^content-box/);
    expect(geo.size).toMatch(/^100% 24px/);
    expect(geo.img, 'rule is the 18px-19px band of each 24px line').toMatch(/18px.*18px.*19px.*19px/);
    expect(Math.abs(geo.base - 18), 'baseline of line one is within 1px of the first rule').toBeLessThanOrEqual(1);
  });

  test.describe('dark', () => {
    test.use({ colorScheme: 'dark' });
    test('tiny caps and muted text are at least 4.5:1; the italic subtitle is weight 500', async ({ page }) => {
      await bootAreas(page, 'seed');
      await openAreas(page);
      for (const sel of ['.areas-head .eyebrow', '.area-card.background .area-mark', '.area-card.foreground .area-mark', '.areas-head p', '.area-card.background .area-latest', '.area-card.foreground .area-latest time']) {
        const { fg, bg } = await contrastOf(page, sel);
        expect(ratio(fg, bg), sel).toBeGreaterThanOrEqual(4.5);
      }
      expect(await page.locator('.areas-head p').evaluate((el) => getComputedStyle(el).fontWeight)).toBe('500');
    });
  });
});

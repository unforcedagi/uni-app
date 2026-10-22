// T-258: an attached video can be watched full screen on every platform. The webview's own full-screen control is
// unreliable (Android's WebView cancels it), so the app has its own Full screen button: the video fills the window,
// keeps its place, and ✕ / Escape / Android Back bring it back to the message. Synthetic clip and room only.
import { test, expect, type Page, type Locator } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MP4 = 'e'.repeat(64);
const O = 'https://relay.example';
const CLIP = readFileSync(fileURLToPath(new URL('./fixtures/t258-clip.webm', import.meta.url)));

const touch = () => test.info().project.name !== 'desktop';
const press = (target: Locator) => (touch() ? target.tap() : target.click());

async function open(page: Page) {
  // Byte ranges, as the app's loopback media server answers, so the clip can seek.
  await page.route('**/__t258/clip.webm', (r) => {
    const m = /bytes=(\d+)-(\d*)/.exec(r.request().headers()['range'] ?? '');
    if (!m) return r.fulfill({ status: 200, contentType: 'video/webm', headers: { 'accept-ranges': 'bytes' }, body: CLIP });
    const start = Number(m[1]), end = m[2] ? Math.min(Number(m[2]), CLIP.length - 1) : CLIP.length - 1;
    return r.fulfill({ status: 206, contentType: 'video/webm', body: CLIP.subarray(start, end + 1),
      headers: { 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${CLIP.length}` } });
  });
  await page.addInitScript(({ MP4, O }) => {
    const w = window as any;
    w.calls = [];
    w.backs = [];
    const now = Math.floor(Date.now() / 1000);
    const media = { url: `${O}/media/${MP4}.webm`, mime: 'video/webm', sha256: MP4, size: 92570, dim: '320x180', blurhash: null, alt: null, filename: 'garden walk.webm' };
    const messages = [{ ref: 'v1', channel: 'test', author: 'b'.repeat(64), author_name: 'Test member', ts: now - 60, body: 'A walk round the garden',
      mentions_me: false, root: null, parent: null, mentions: [], reply_count: 0, last_reply_ts: null, edited: false, reactions: [], media: [media] }];
    let cb = 0;
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: (f: unknown) => { const id = ++cb; w[`_cb${id}`] = f; return id; },
      convertFileSrc: (p: string, proto: string) => `${proto}://localhost/${p}`,
      invoke: async (cmd: string, args: any) => {
        w.calls.push({ cmd, args });
        switch (cmd) {
          case 'identity_status': return { paired: true, pubkey: 'a'.repeat(64) };
          case 'get_identity': return 'a'.repeat(64);
          case 'relay_origin': return O;
          case 'get_npub': return 'test';
          case 'get_rooms': return [{ id: 'test', name: 'Test room', unread: 0 }];
          case 'get_members': return [{ pubkey: 'b'.repeat(64), name: 'Test member' }];
          case 'get_messages': return messages;
          case 'vault_list': return [];
          case 'journal_config': return { hub: 'test' };
          case 'refresh': return { pubkey: 'a'.repeat(64), total_items: 1, channel_errors: {}, truncated_channels: [] };
          case 'media_stream': return { sha: MP4, url: `${location.origin}/__t258/clip.webm` };
          // Android Back: the app registers a handler; the test calls it as the system would.
          case 'plugin:app|register_listener': if (args?.event === 'back-button') w.backs.push(args.handler); return 1;
          default: return null;
        }
      },
    };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  }, { MP4, O });
  await page.goto('/');
  const play = page.getByRole('button', { name: /garden walk\.webm/ }).first();
  await expect(play).toBeVisible();
  await press(play);
  const inline = page.locator('video.attachment-video');
  await expect(inline).toBeVisible();
  await expect.poll(() => inline.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(1);
  return inline;
}

const layer = (page: Page) => page.getByRole('dialog', { name: 'garden walk.webm, full screen' });

test('Full screen fills the window with the video and keeps its place', async ({ page }) => {
  const inline = await open(page);
  await inline.evaluate((v: HTMLVideoElement) => { v.pause(); v.currentTime = 2.5; });
  await press(page.getByRole('button', { name: 'Full screen: garden walk.webm' }));
  const full = layer(page);
  await expect(full).toBeVisible();
  const player = full.locator('video');
  await expect.poll(() => player.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(1);
  // It covers the whole viewport, above everything else.
  const vp = page.viewportSize()!;
  const box = (await player.boundingBox())!;
  expect(Math.round(box.width)).toBe(vp.width);
  expect(Math.round(box.height)).toBe(vp.height);
  const top = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('.video-full') != null, [vp.width / 2, vp.height / 2]);
  expect(top).toBe(true);
  // Same moment in the clip; paused stays paused.
  await expect.poll(() => player.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(2.4);
  expect(await player.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeLessThan(2.6);
  expect(await player.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  // ✕ brings it back to the message, at the place it reached.
  await player.evaluate((v: HTMLVideoElement) => { v.currentTime = 4; });
  await press(full.getByRole('button', { name: 'Close full screen' }));
  await expect(full).toBeHidden();
  await expect.poll(() => inline.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(3.9);
  expect(await inline.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeLessThan(4.1);
});

test('A playing video keeps playing full screen, and only that one plays', async ({ page }) => {
  const inline = await open(page);
  await inline.evaluate(async (v: HTMLVideoElement) => { v.muted = true; v.currentTime = 1; await v.play(); });
  await expect.poll(() => inline.evaluate((v: HTMLVideoElement) => !v.paused)).toBe(true);
  await press(page.getByRole('button', { name: 'Full screen: garden walk.webm' }));
  const player = layer(page).locator('video');
  await player.evaluate((v: HTMLVideoElement) => { v.muted = true; });
  await expect.poll(() => player.evaluate((v: HTMLVideoElement) => !v.paused && v.currentTime > 1)).toBe(true);
  expect(await player.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeLessThan(5);
  expect(await inline.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
});

test('A playback failure closes full screen; Retry plays in the message', async ({ page }) => {
  await open(page);
  await press(page.getByRole('button', { name: 'Full screen: garden walk.webm' }));
  await layer(page).locator('video').evaluate((v: HTMLVideoElement) => { v.src = '/__t258/missing.webm'; });
  await expect(layer(page)).toBeHidden();
  const retry = page.getByRole('button', { name: /garden walk\.webm/ }).filter({ hasText: 'tap to retry' });
  await expect(retry).toBeVisible();
  await press(retry);
  await expect(page.locator('video.attachment-video')).toBeVisible();
  await page.waitForTimeout(300);
  await expect(layer(page)).toBeHidden();
});

test('Keyboard focus stays in the full-screen layer and returns to the button', async ({ page }) => {
  test.skip(touch(), 'keyboard');
  await open(page);
  const btn = page.getByRole('button', { name: 'Full screen: garden walk.webm' });
  await btn.focus();
  await page.keyboard.press('Enter');
  const full = layer(page);
  await expect(full.getByRole('button', { name: 'Close full screen' })).toBeFocused();
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('.video-full'))).toBe(true);
  }
  expect(await page.evaluate(() => (document.getElementById('root') as HTMLElement).inert)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(full).toBeHidden();
  await expect(btn).toBeFocused();
  expect(await page.evaluate(() => (document.getElementById('root') as HTMLElement).inert)).toBe(false);
});

test('Escape closes only the full-screen video', async ({ page }) => {
  await open(page);
  await press(page.getByRole('button', { name: 'Full screen: garden walk.webm' }));
  await expect(layer(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(layer(page)).toBeHidden();
  await expect(page.locator('video.attachment-video')).toBeVisible();
  await expect(page.getByText('A walk round the garden')).toBeVisible();
});

test('Android Back closes the full-screen video and stays in the room', async ({ page }) => {
  await open(page);
  await press(page.getByRole('button', { name: 'Full screen: garden walk.webm' }));
  await expect(layer(page)).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).backs.length)).toBeGreaterThan(0);
  await page.evaluate(() => { const w = window as any; w.backs[w.backs.length - 1].onmessage({ canGoBack: false }); });
  await expect(layer(page)).toBeHidden();
  await expect(page.getByText('A walk round the garden')).toBeVisible();
});

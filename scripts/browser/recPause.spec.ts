// Pause, resume and delete a section of a voice recording, in the real Chromium recorder with a fake mic.
// The bytes the app uploads are written out and ffprobe'd: one valid file, the right length.
// Run: COMPOSER_TEST_PORT=17561 npx playwright test scripts/browser/recPause.spec.ts
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { test, expect, type Page, type Locator } from '@playwright/test';

const press = (page: Page, target: Locator) => test.info().project.name === 'mobile' ? target.tap() : target.click();
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const wait = (page: Page, ms: number) => page.waitForTimeout(ms);
/** With REC_SHOTS set, the screens in light and dark. Never into the repo. */
async function shot(page: Page, name: string) {
  const dir = process.env.REC_SHOTS;
  if (!dir) return;
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await page.screenshot({ path: `${dir}/${test.info().project.name}-${name}-${colorScheme}.png` });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as any;
    w.calls = []; w.uploads = []; w.recorders = 0; w.spans = [];
    const Native = window.MediaRecorder;
    window.MediaRecorder = new Proxy(Native, { construct(target, args) { w.recorders++; return new (target as any)(...args); } });
    // when each real recorder ran: the box may be slow to tap, so what the file must match is what was really captured
    const start = Native.prototype.start, stop = Native.prototype.stop;
    Native.prototype.start = function (...a: any[]) { w.spans.push({ recorder: this, from: performance.now(), to: null }); return (start as any).apply(this, a); };
    Native.prototype.stop = function () { const span = w.spans.find((x: any) => x.recorder === this); if (span && span.to === null) span.to = performance.now(); return stop.call(this); };
    if (sessionStorage.getItem('noWebm')) { const real = Native.isTypeSupported.bind(Native); Native.isTypeSupported = (t: string) => !t.includes('webm') && real(t); }
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: () => 1,
      invoke: async (cmd: string, args: any, options: any) => {
        w.calls.push({ cmd });
        const keep = () => w.uploads.push({ cmd, bytes: Array.from(new Uint8Array(args)), headers: options?.headers });
        switch (cmd) {
          case 'plugin:app|version': return '0.1.98';
          case 'android_update_manifest': return { version: '0.1.99', url: 'https://example.com/releases/uni-v0.1.99/uni.apk' };
          case 'plugin:updater|check': return w.offerUpdate ? { rid: 7, currentVersion: '0.1.98', version: '0.1.99', date: null, body: null, rawJson: {} } : null;
          case 'identity_status': return { paired: true, pubkey: 'a'.repeat(64) };
          case 'get_identity': return 'a'.repeat(64);
          case 'relay_origin': return 'https://example.invalid';
          case 'get_npub': return 'test';
          case 'get_rooms': return [{ id: 'test', name: 'Test room', unread: 0 }];
          case 'get_members': return [{ pubkey: 'b'.repeat(64), name: 'Test member' }];
          case 'get_messages': return [];
          case 'vault_list': return [];
          case 'journal_config': return { hub: 'test', vault: 'test' };
          case 'journal_pending': case 'journal_list': return [];
          case 'journal_flush': return { sent: [], remaining: 0, error: null };
          case 'refresh': return { pubkey: 'a'.repeat(64), total_items: 0, channel_errors: {}, truncated_channels: [] };
          case 'media_upload': keep(); return { url: 'https://example.invalid/v.webm', mime: 'audio/webm', name: 'v.webm', size: 4 };
          case 'journal_save_voice': keep(); return { sent: ['entry'], remaining: 0, error: null };
          case 'prepare_voice_message': return JSON.stringify({ id: 'voice:' + crypto.randomUUID() });
          case 'post_message': return { ref: 'audio-message-ref', channel: args.channel };
          default: return null;
        }
      },
    };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  });
});

async function boot(page: Page, opts: { noWebm?: boolean } = {}) {
  if (opts.noWebm) { await page.goto('/'); await page.evaluate(() => sessionStorage.setItem('noWebm', '1')); }
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'Message Test room' })).toBeVisible();
}
const BETWEEN_TAPS = 400; // what a person takes; a quicker second tap is a slip, and is ignored
const startInRoom = async (page: Page) => {
  await press(page, button(page, 'Record a voice message'));
  await expect(button(page, 'Pause recording')).toBeVisible();
};
const pause = async (page: Page) => {
  await press(page, button(page, 'Pause recording'));
  await expect(page.getByRole('group', { name: 'Paused recording' })).toBeVisible();
  await expect(button(page, 'Resume recording')).toBeEnabled();
  await wait(page, BETWEEN_TAPS);
};
const resume = async (page: Page) => {
  await press(page, button(page, 'Resume recording'));
  await expect(button(page, 'Pause recording')).toBeVisible();
  await wait(page, BETWEEN_TAPS);
};
const uploads = (page: Page): Promise<{ cmd: string; bytes: number[]; headers: Record<string, string> }[]> => page.evaluate(() => (window as any).uploads);
const posts = (page: Page) => page.evaluate(() => (window as any).calls.filter((c: any) => c.cmd === 'post_message').length);

/** Seconds each recorder really ran, and the seconds between the first start and the last stop. */
const spans = async (page: Page) => {
  const all: { from: number; to: number }[] = await page.evaluate(() => (window as any).spans.map((x: any) => ({ from: x.from, to: x.to })));
  return { seconds: all.map((x) => (x.to - x.from) / 1000), wall: (all[all.length - 1].to - all[0].from) / 1000 };
};
/** A recorder takes a moment to start, longer on a busy box, so a file can run a little short of its recorders; never long. */
const matches = (duration: number, seconds: number[]) => {
  const ran = seconds.reduce((a, b) => a + b, 0);
  expect(duration, `the file against ${seconds.map((x) => x.toFixed(2))}`).toBeLessThan(ran + 0.25);
  expect(duration, `the file against ${seconds.map((x) => x.toFixed(2))}`).toBeGreaterThan(ran - 0.5 * seconds.length);
};

/** The whole of what ffmpeg sees in a file: its length, its streams, every packet, and a full decode that must be clean. */
function probe(bytes: number[], ext: string) {
  const path = test.info().outputPath(`recording.${ext}`);
  writeFileSync(path, Buffer.from(bytes));
  const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-show_packets', '-of', 'json', path], { encoding: 'utf8' }));
  const decoded = execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', path, '-f', 'wav', '-'], { maxBuffer: 1 << 28 });
  const pts = info.packets.map((p: any) => Number(p.pts_time));
  return {
    format: info.format.format_name as string, duration: Number(info.format.duration), streams: info.streams.length as number, codec: info.streams[0].codec_name as string,
    pts, packets: info.packets.length as number, decodedBytes: decoded.length,
    biggestGap: pts.slice(1).reduce((m: number, t: number, i: number) => Math.max(m, t - pts[i]), 0),
  };
}
/** Chromium itself can play it back to the same length. */
const chromiumDuration = (page: Page, bytes: number[], mime: string) => page.evaluate(async ([b]) => {
  const ctx = new OfflineAudioContext(1, 1, 16000);
  const buffer = await ctx.decodeAudioData(new Uint8Array(b as number[]).buffer);
  return buffer.duration;
}, [bytes, mime] as const);

test('No pause: one recorder and its file, sent as before', async ({ page }) => {
  await boot(page);
  await startInRoom(page);
  await wait(page, 700);
  await press(page, button(page, 'Stop recording voice message'));
  await expect.poll(() => posts(page)).toBe(1);
  expect(await page.evaluate(() => (window as any).recorders)).toBe(1);
  const [up] = await uploads(page);
  const out = probe(up.bytes, 'webm');
  expect(out.codec).toBe('opus');
  expect(out.decodedBytes).toBeGreaterThan(1000);
});

test('Record, pause, resume, stop: one clean file as long as the time recorded', async ({ page }) => {
  await boot(page);
  await startInRoom(page);
  await wait(page, 2000);
  await pause(page);
  await expect(page.getByRole('group', { name: 'Paused recording' }).getByRole('listitem')).toHaveCount(1);
  const shown = await page.getByRole('group', { name: 'Paused recording' }).locator('.rec-time').innerText();
  await wait(page, 1500); // not in the file
  expect(await page.getByRole('group', { name: 'Paused recording' }).locator('.rec-time').innerText()).toBe(shown);
  await resume(page);
  await wait(page, 2000);
  await press(page, button(page, 'Stop recording voice message'));
  await expect.poll(() => posts(page)).toBe(1);
  const all = await uploads(page);
  expect(all).toHaveLength(1);
  const out = probe(all[0].bytes, 'webm');
  expect(out.format).toContain('webm');
  expect(out.streams).toBe(1);
  expect(out.codec).toBe('opus');
  const ran = await spans(page);
  expect(ran.seconds).toHaveLength(2);
  matches(out.duration, ran.seconds);
  expect(ran.wall - out.duration).toBeGreaterThan(1.3); // the 1.5 s pause is not in it
  expect(out.pts.every((t: number, i: number) => i === 0 || t > out.pts[i - 1])).toBe(true);
  expect(out.biggestGap).toBeLessThan(0.2); // the join is seamless: no hole where the pause was
  expect(Math.abs(await chromiumDuration(page, all[0].bytes, 'audio/webm') - out.duration)).toBeLessThan(0.25);
  expect(await page.evaluate(() => (window as any).recorders)).toBe(2);
  await expect(page.getByRole('group', { name: 'Paused recording' })).toHaveCount(0);
});

test('Record, pause, resume, delete the last section, send: the deleted part is gone', async ({ page }) => {
  await boot(page);
  await startInRoom(page);
  await wait(page, 1500);
  await shot(page, 'running');
  await pause(page);
  await resume(page);
  await wait(page, 2500);
  await pause(page);
  const card = page.getByRole('group', { name: 'Paused recording' });
  await expect(card.getByRole('listitem')).toHaveCount(2);
  await wait(page, 400); // the waveforms draw
  await shot(page, 'paused-two');
  await press(page, button(page, 'Delete section 2'));
  await expect(card.getByRole('listitem')).toHaveCount(1);
  await expect(button(page, 'Undo delete')).toBeVisible();
  await shot(page, 'deleted');
  await resume(page);
  await wait(page, 1500);
  await press(page, page.getByRole('button', { name: 'Stop recording voice message', exact: true }));
  await expect.poll(() => posts(page)).toBe(1);
  const out = probe((await uploads(page))[0].bytes, 'webm');
  const ran = await spans(page);
  expect(ran.seconds).toHaveLength(3);
  expect(ran.seconds[1]).toBeGreaterThan(2.4);
  matches(out.duration, [ran.seconds[0], ran.seconds[2]]); // the second, deleted section is gone
  expect(out.biggestGap).toBeLessThan(0.2);
});

test('Delete any section, undo it, and stop from the card', async ({ page }) => {
  await boot(page);
  await startInRoom(page);
  for (const ms of [800, 1800]) { await wait(page, ms); await pause(page); await resume(page); }
  await wait(page, 800);
  await pause(page);
  const card = page.getByRole('group', { name: 'Paused recording' });
  await expect(card.getByRole('listitem')).toHaveCount(3);
  await press(page, button(page, 'Delete section 2')); // the long one in the middle
  await expect(card.getByRole('listitem')).toHaveCount(2);
  await press(page, button(page, 'Undo delete'));
  await expect(card.getByRole('listitem')).toHaveCount(3);
  await press(page, button(page, 'Delete section 2'));
  await press(page, button(page, 'Stop and send recording for Test room'));
  await expect.poll(() => posts(page)).toBe(1);
  const out = probe((await uploads(page))[0].bytes, 'webm');
  const ran = await spans(page);
  expect(ran.seconds).toHaveLength(3);
  expect(ran.seconds[1]).toBeGreaterThan(1.7);
  matches(out.duration, [ran.seconds[0], ran.seconds[2]]);
});

test('Delete every section and stop: nothing is sent and the composer is free again', async ({ page }) => {
  await boot(page);
  await startInRoom(page);
  await wait(page, 500);
  await pause(page);
  await press(page, button(page, 'Delete section 1'));
  await press(page, button(page, 'Discard recording'));
  await expect(button(page, 'Record a voice message')).toBeEnabled();
  await wait(page, 300);
  expect(await posts(page)).toBe(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  // and the next recording starts clean
  await startInRoom(page);
  await wait(page, 500);
  await press(page, button(page, 'Stop recording voice message'));
  await expect.poll(() => posts(page)).toBe(1);
});

test('A section can be heard before deciding', async ({ page }) => {
  await boot(page);
  await startInRoom(page);
  await wait(page, 1200);
  await pause(page);
  await page.evaluate(() => { (window as any).played = []; const play = HTMLMediaElement.prototype.play; HTMLMediaElement.prototype.play = function () { (window as any).played.push(this.src); return play.call(this); }; });
  await press(page, button(page, 'Play section 1'));
  await expect.poll(() => page.evaluate(() => (window as any).played.length)).toBe(1);
  await expect(button(page, 'Stop playing section 1')).toBeVisible();
  expect((await page.evaluate(() => (window as any).played[0])).startsWith('blob:')).toBe(true);
  await press(page, button(page, 'Stop playing section 1'));
  await expect(button(page, 'Play section 1')).toBeVisible();
});

test('A recorder that can only write MP4, in a room: each section on its own, never a WAV the relay would refuse', async ({ page }) => {
  await boot(page, { noWebm: true });
  await startInRoom(page);
  await wait(page, 800);
  await pause(page);
  await resume(page);
  await wait(page, 800);
  await press(page, button(page, 'Stop recording voice message'));
  await expect.poll(async () => (await uploads(page)).length, { timeout: 15000 }).toBe(2);
  for (const up of await uploads(page)) expect(up.headers['x-file-mime']).not.toContain('wav');
  await expect.poll(() => posts(page)).toBe(2);
});

test('A recorder that can only write MP4, in the Journal: one WAV', async ({ page }) => {
  await boot(page, { noWebm: true });
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await press(page, nav.getByRole('button', { name: 'Journal', exact: true }));
  await press(page, button(page, 'Record a journal entry'));
  await expect(button(page, 'Pause recording')).toBeVisible();
  await wait(page, 1200);
  await pause(page);
  await resume(page);
  await wait(page, 1200);
  await press(page, button(page, 'Stop recording and save'));
  await expect.poll(async () => (await uploads(page)).length, { timeout: 15000 }).toBe(1);
  const [up] = await uploads(page);
  expect(up.cmd).toBe('journal_save_voice');
  expect(up.headers['x-audio-mime']).toBe('audio/wav');
  const out = probe(up.bytes, 'wav');
  expect(out.format).toBe('wav');
  matches(out.duration, (await spans(page)).seconds);
});

test('Journal: pause and resume there too, saved as one recording', async ({ page }) => {
  await boot(page);
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  if (test.info().project.name === 'mobile' && !await nav.isVisible()) await page.locator('.back').first().tap();
  await press(page, nav.getByRole('button', { name: 'Journal', exact: true }));
  await press(page, button(page, 'Record a journal entry'));
  await expect(button(page, 'Pause recording')).toBeVisible();
  await wait(page, 1200);
  await pause(page);
  await expect(page.locator('.journal-status')).toContainText('Paused');
  await resume(page);
  await wait(page, 1200);
  await press(page, button(page, 'Stop recording and save'));
  await expect.poll(async () => (await uploads(page)).length).toBe(1);
  const [up] = await uploads(page);
  expect(up.cmd).toBe('journal_save_voice');
  const out = probe(up.bytes, 'webm');
  const ran = await spans(page);
  matches(out.duration, ran.seconds);
});

test('Two quick taps on Pause never send', async ({ page }) => {
  const touch = test.info().project.name === 'mobile';
  await boot(page);
  await startInRoom(page);
  for (const round of [1, 2]) { // from the second pause on, there are sections to send
    await wait(page, 700);
    const box = (await button(page, 'Pause recording').boundingBox())!;
    const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
    const tap = () => touch ? page.touchscreen.tap(x, y) : page.mouse.click(x, y);
    await tap();
    await tap();
    await wait(page, 500);
    await tap(); // and a slow third, once the card is ready
    await wait(page, 500);
    expect(await posts(page), `round ${round}`).toBe(0);
    // whatever the taps landed on, the recording is still open
    await expect(button(page, 'Stop recording voice message')).toBeVisible();
    if (await button(page, 'Resume recording').isVisible()) await resume(page);
  }
});

for (const view of ['upright', 'on its side'] as const) test(`Two quick taps on Resume never send (phone ${view})`, async ({ page }) => {
  test.skip(test.info().project.name !== 'mobile', 'a thumb');
  if (view === 'on its side') await page.setViewportSize({ width: 740, height: 360 });
  await boot(page);
  await startInRoom(page);
  await wait(page, 600);
  await pause(page);
  // at the point of Resume where, once it's running again, Stop will be: the pill's upright, the composer's mic on its side
  const target = view === 'upright' ? button(page, 'Stop recording for Test room') : button(page, 'Stop recording voice message');
  await resume(page);
  const stop = (await target.boundingBox())!;
  await pause(page);
  const resumeBox = (await button(page, 'Resume recording').boundingBox())!;
  const x = Math.max(resumeBox.x + 4, Math.min(stop.x + stop.width / 2, resumeBox.x + resumeBox.width - 4));
  const y = Math.max(resumeBox.y + 4, Math.min(stop.y + stop.height / 2, resumeBox.y + resumeBox.height - 4));
  // sent together: on a busy box two awaited taps can land further apart than a person's double tap
  await page.evaluate(() => { (window as any).taps = []; addEventListener('click', () => (window as any).taps.push(performance.now()), true); });
  await Promise.all([page.touchscreen.tap(x, y), page.touchscreen.tap(x, y)]);
  await wait(page, 600);
  const [first, second] = await page.evaluate(() => (window as any).taps);
  test.skip(second !== undefined && second - first > 300, 'the box spread the taps too far apart to be a double tap');
  expect(await posts(page)).toBe(0);
  await expect(button(page, 'Pause recording')).toBeVisible(); // still going
});

test('The mic going mid-section: a paused recording waits, says why, and carries on', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (c) => { const s = await gum(c); (window as any).mic = s; (window as any).micAsks = ((window as any).micAsks ?? 0) + 1; return s; };
  });
  await startInRoom(page);
  await wait(page, 1000);
  await pause(page);
  await resume(page);
  await wait(page, 1000);
  await page.evaluate(() => (window as any).mic.getTracks().forEach((t: MediaStreamTrack) => t.stop())); // what an unplugged mic does, in the real recorder
  const card = page.getByRole('group', { name: 'Paused recording' });
  await expect(card).toBeVisible();
  await expect(card.getByRole('alert')).toContainText('The microphone stopped');
  await expect(card.getByRole('listitem')).toHaveCount(2);
  expect(await posts(page)).toBe(0);
  await wait(page, BETWEEN_TAPS);
  await resume(page);
  expect(await page.evaluate(() => (window as any).micAsks)).toBe(2);
  await wait(page, 1000);
  await press(page, button(page, 'Stop recording voice message'));
  await expect.poll(() => posts(page)).toBe(1);
  const out = probe((await uploads(page))[0].bytes, 'webm');
  expect(out.duration).toBeGreaterThan(1.8); // all three sections
});

test('Two quick taps on delete take one section', async ({ page }) => {
  const touch = test.info().project.name === 'mobile';
  await boot(page);
  await startInRoom(page);
  for (let i = 0; i < 3; i++) { await wait(page, 300); await pause(page); if (i < 2) await resume(page); }
  const card = page.getByRole('group', { name: 'Paused recording' });
  await expect(card.getByRole('listitem')).toHaveCount(3);
  const box = (await button(page, 'Delete section 2').boundingBox())!;
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
  const tap = () => touch ? page.touchscreen.tap(x, y) : page.mouse.click(x, y);
  await tap();
  await tap();
  await wait(page, 300);
  await expect(card.getByRole('listitem')).toHaveCount(2);
});

test('An update waits for a recording: Restart says finish first, then restarts', async ({ page }) => {
  await page.addInitScript(() => { (window as any).offerUpdate = true; });
  await boot(page);
  const go = page.locator('.update-notice-go');
  await expect(go).toHaveText('Restart', { timeout: 30000 });
  await startInRoom(page);
  await wait(page, 300);
  await pause(page);
  await press(page, go);
  await expect(page.locator('.update-notice')).toContainText('Finish your recording first');
  await expect(page.locator('.update-notice')).toContainText('Update ready', { timeout: 8000 }); // it doesn't stick
  const restarted = () => page.evaluate(() => (window as any).calls.filter((c: any) => c.cmd.includes('restart')).length);
  await wait(page, 300);
  expect(await restarted()).toBe(0);
  await expect(page.getByRole('group', { name: 'Paused recording' }).getByRole('listitem')).toHaveCount(1); // still there
  await press(page, button(page, 'Stop recording voice message'));
  await expect.poll(() => posts(page)).toBe(1);
  await press(page, go);
  await expect.poll(restarted).toBe(1);
});

test.describe('On Android', () => {
  test.use({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36' });
  test('Download APK waits for a recording too: installing would lose it', async ({ page }) => {
    await page.addInitScript(() => { (window as any).offerUpdate = true; });
    await boot(page);
    const go = page.locator('.update-notice-go');
    await expect(go).toHaveText('Download APK', { timeout: 30000 });
    await startInRoom(page);
    await wait(page, 300);
    await pause(page);
    await press(page, go);
    await expect(page.locator('.update-notice')).toContainText('Finish your recording first');
    const opened = () => page.evaluate(() => (window as any).calls.filter((c: any) => c.cmd === 'open_link').length);
    expect(await opened()).toBe(0);
    await press(page, button(page, 'Stop recording voice message'));
    await expect.poll(() => posts(page)).toBe(1);
    await press(page, go);
    await expect.poll(opened).toBe(1);
  });
});

test('The card fits a phone on its side, and many sections scroll', async ({ page }) => {
  test.skip(test.info().project.name !== 'mobile', 'a phone');
  await page.setViewportSize({ width: 740, height: 360 });
  await boot(page);
  await startInRoom(page);
  for (let i = 0; i < 5; i++) { await wait(page, 250); await pause(page); await resume(page); }
  await wait(page, 250);
  await pause(page);
  await press(page, button(page, 'Delete section 1'));
  const stop = button(page, 'Stop and send recording for Test room');
  await stop.scrollIntoViewIfNeeded();
  const box = (await stop.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(360);
  await expect(button(page, 'Resume recording')).toBeVisible();
  await button(page, 'Delete section 1').scrollIntoViewIfNeeded();
  await expect(button(page, 'Delete section 1')).toBeInViewport();
});

test('On a phone the controls are big enough to hit and the card fits', async ({ page }) => {
  test.skip(test.info().project.name !== 'mobile', 'phone only');
  await boot(page);
  await startInRoom(page);
  for (const b of [button(page, 'Pause recording'), button(page, 'Stop recording for Test room')]) {
    const box = (await b.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
  }
  await wait(page, 400);
  await pause(page);
  await resume(page);
  await wait(page, 400);
  await pause(page);
  const card = page.getByRole('group', { name: 'Paused recording' });
  for (const b of await card.getByRole('button').all()) {
    const box = (await b.boundingBox())!;
    expect(box.height, await b.getAttribute('aria-label') ?? '').toBeGreaterThanOrEqual(44);
    expect(box.width, await b.getAttribute('aria-label') ?? '').toBeGreaterThanOrEqual(44);
  }
  const box = (await card.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(box.y).toBeGreaterThanOrEqual(0);
});

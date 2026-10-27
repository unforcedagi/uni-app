// T-260: a file published with uni-publish plays inside the note that is for it, inside a decision card whose note links it, in that
// decision's context (its note) and in its sheet: video and audio with their controls, images as images; pages and PDFs stay links.
// The hosts, notes and media are made up: ffmpeg makes the files, page.route serves them on a fixture publish origin (with ranges,
// as the real one does). Playback is real: metadata, a seek, `playing`, and time that moves.
// Run: MEDIA_TEST_PORT=5767 npx playwright test --config playwright.media.config.ts
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { bootAreas, leaveFrontDoor } from './areasFixture';

/** The fixture's made-up Garden project's room (areasFixture `garden`). */
const GARDEN = '5b0c4e8a-2f3d-4c1e-9a7b-6d8e0f1a2b3c';
const ORIGIN = 'https://uni.example.ts.net:8444';
const at = (name: string) => `${ORIGIN}/${name}`;
const VIDEO = at('garden-walk-0a1b2c3d.webm');
const AUDIO = at('bird-call-1b2c3d4e.mp3');
const IMAGE = at('garden-map-2c3d4e5f.png');
const PAGE = at('garden-plan-3d4e5f60.html');
const PAGE_B = at('garden-budget-3d4e5f61.html');
const DOC = at('garden-notes-4e5f6071.pdf');
const GONE_VIDEO = at('gone-walk-5f607182.webm');
const GONE_IMAGE = at('gone-map-60718293.png');
const ulid = (tail: string) => '01M5P' + '0'.repeat(21 - tail.length) + tail;
const PUB = ulid('V1'), DEC = ulid('D1'), ASSETS = ulid('A1'), GONE = ulid('G1');
const wide = (page: Page) => (page.viewportSize()?.width ?? 0) >= 900 && (page.viewportSize()?.height ?? 0) >= 400;

// ── synthetic media, made once per worker ─────────────────────────────────────────────────────────────────
type File = { path: string; mime: string };
let files: Record<string, File> = {};
test.beforeAll(({}, info) => {
  const dir = `test-results/media-fixture/w${info.workerIndex}`;
  mkdirSync(dir, { recursive: true });
  const make = (name: string, args: string[]) => { const out = `${dir}/${name}`; if (!existsSync(out)) execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args, out]); return out; };
  files = {
    // wider than a phone, so a player that isn't held to its column overflows
    'garden-walk-0a1b2c3d.webm': { mime: 'video/webm', path: make('walk640.webm', ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '6', '-c:v', 'libvpx-vp9', '-b:v', '150k', '-c:a', 'libopus', '-shortest']) },
    'bird-call-1b2c3d4e.mp3': { mime: 'audio/mpeg', path: make('call.mp3', ['-f', 'lavfi', '-i', 'sine=frequency=330:duration=5', '-c:a', 'libmp3lame', '-b:a', '64k']) },
    'garden-map-2c3d4e5f.png': { mime: 'image/png', path: make('map.png', ['-f', 'lavfi', '-i', 'testsrc2=size=640x360', '-frames:v', '1']) },
  };
});

/** The fixture publish origin: files with byte ranges (206), a page and a PDF, and the `gone-` ones unreachable (the tailnet down). */
async function serve(page: Page) {
  await page.route((u) => u.origin === ORIGIN, async (route) => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.slice(1));
    if (name.startsWith('gone-')) return route.abort('connectionrefused');
    const f = files[name];
    if (!f) return route.fulfill({ status: 404, body: 'not found' });
    const body = readFileSync(f.path);
    const r = /bytes=(\d+)-(\d*)/.exec(route.request().headers()['range'] ?? '');
    if (!r) return route.fulfill({ status: 200, headers: { 'content-type': f.mime, 'accept-ranges': 'bytes' }, body });
    const start = Number(r[1]), end = r[2] ? Math.min(Number(r[2]), body.length - 1) : body.length - 1;
    return route.fulfill({ status: 206, headers: { 'content-type': f.mime, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${body.length}` }, body: body.subarray(start, end + 1) });
  });
}

const T = '2026-10-20T09:00:00.000Z';
/** The notes: a Published note as uni-publish writes it, a decision whose note links the clip and a page, and two plain notes. */
const NOTES = [
  { id: PUB, path: 'Published/2026-10-20 Garden walk clip', extension: 'md', tags: ['published'], createdAt: T, updatedAt: T, lastUpdatedVia: 'api',
    content: `# Garden walk clip\n\n${VIDEO}\n\nA short clip of the garden walk.\n`,
    metadata: { url: VIDEO, sha256: 'ab'.repeat(32), bytes: 123456, mime: 'video/webm', kind: 'video', published: '2026-10-20', source_name: 'garden-walk.webm', node: 'Projects/Garden' } },
  { id: DEC, path: 'Decisions/2026-10-20 Which cut of the garden walk?', extension: 'md', tags: ['decision'], createdAt: T, updatedAt: T, lastUpdatedVia: 'api',
    // three links to pages and a PDF come first: they must not crowd the clip off the card
    content: `# Which cut of the garden walk?\n\nThe plan is ${PAGE}, the budget ${PAGE_B} and the notes ${DOC}. Watch ${VIDEO} before you pick.\n\n- Short\n- Long (default)\n`,
    metadata: { node: 'Projects/Garden', state: 'open', options: ['Short', 'Long'], default: 'Long', owner: 'aaron', asked: '2026-10-20', task: 'T-07',
      // the step names the clip (the task guards want what an ask names linked in it): the sheet has only the list's fields
      next: `Watch ${VIDEO} and look at ${IMAGE}, then pick a cut.` } },
  { id: ASSETS, path: 'Notes/Garden assets', extension: 'md', tags: [], createdAt: T, updatedAt: T, lastUpdatedVia: 'api',
    content: [`# Garden assets`, ``, `The map:`, ``, IMAGE, ``, `- The call: ${AUDIO}`, `- The notes: ${DOC}`,
      `- Not ours: https://www.example.org/garden-walk.webm`, `- Lookalike: https://uni.example.ts.net.evil.example:8444/garden-walk-0a1b2c3d.webm`,
      `- Other port: https://uni.example.ts.net:8445/garden-walk-0a1b2c3d.webm`, `- [Script link](javascript:alert(1))`, ``, '`' + VIDEO + '`', ``].join('\n') },
  { id: GONE, path: 'Notes/Off the tailnet', extension: 'md', tags: [], createdAt: T, updatedAt: T, lastUpdatedVia: 'api', content: `# Off the tailnet\n\n${GONE_VIDEO}\n\n${GONE_IMAGE}\n` },
];

async function open(page: Page, publish = true) {
  await page.addInitScript(([notes, origins]) => { (window as any).__seedTasks = notes; if (origins) (window as any).__publishOrigins = origins; }, [NOTES, publish ? [ORIGIN] : null] as const);
  await serve(page);
  await bootAreas(page, 'seed', { tree: true, tasks: true, garden: true, pinned: true });
  await toGarden(page);
}
/** The made-up Garden project's room, from the tree (the phone's drawer, or the rooms nav beside the chat). */
async function toGarden(page: Page) {
  const nav = wide(page) ? page.locator('.th-roomnav') : page.locator('.th-phone-tree');
  await leaveFrontDoor(page); // T-302: the tree is in a room
  if (!wide(page)) { await page.locator('.sr-drawer, .th-phone-tree').first().waitFor(); if (await page.locator('.sr-drawer').count() && !await page.locator('.th-drawer').count()) await page.locator('.sr-drawer').click(); }
  await nav.locator('.th-row.d1').first().waitFor();
  for (let i = 0; i < 12; i++) { const f = nav.locator('.th-fold[aria-expanded="false"]'); if (!await f.count()) break; await f.first().click(); }
  await nav.locator('.th-go[data-path="Projects/Garden"]').click();
  await expect(page.locator('.sr')).toHaveAttribute('data-node', 'Garden');
}
const arrive = (page: Page, body: string) => page.evaluate(([b, t]) => (window as any).__arrive(b, 'Uni', t), [GARDEN, body] as const);
/** Opens a note from a room message's chip: beside the chat (wide) or over it (phone). */
async function openNote(page: Page, id: string, words: string): Promise<Locator> {
  await arrive(page, `${words} uni:${id}`);
  await page.locator('.sr-chat .message').filter({ hasText: words }).locator('a.note-chip').first().click();
  const view = page.locator('.note-view').last();
  await expect(view.locator('.note-body')).toBeVisible();
  return view;
}

/** Real playback: metadata (duration, readyState), a seek to a nonzero time, `playing`, and time moving on. Never autoplays. */
async function plays(media: Locator) {
  await media.scrollIntoViewIfNeeded();
  const r = await media.evaluate(async (el: HTMLMediaElement) => {
    const wait = (ev: string) => new Promise<void>((ok, no) => { const t = setTimeout(() => no(new Error(`no ${ev}`)), 15000); el.addEventListener(ev, () => { clearTimeout(t); ok(); }, { once: true }); });
    if (el.readyState < 1) await wait('loadedmetadata');
    const meta = { duration: el.duration, readyState: el.readyState, autoplay: el.autoplay, paused: el.paused, controls: el.controls };
    const seeked = wait('seeked'); el.currentTime = 1.5; await seeked;
    const seekedTo = el.currentTime;
    const playing = wait('playing'); await el.play(); await playing;
    const t0 = el.currentTime; await new Promise((ok) => setTimeout(ok, 900)); const t1 = el.currentTime;
    el.pause();
    return { ...meta, seekedTo, t0, t1 };
  });
  expect(r.duration).toBeGreaterThan(3);
  expect(r.readyState).toBeGreaterThanOrEqual(1);
  expect([r.autoplay, r.paused, r.controls]).toEqual([false, true, true]);
  expect(r.seekedTo).toBeGreaterThan(1);
  expect(r.t1).toBeGreaterThan(r.t0);
  return r;
}

/** Nothing scrolls sideways, every player sits in the window, and its own buttons and links are big enough to tap. */
async function fits(page: Page, scope: Locator) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const vw = page.viewportSize()!.width;
  for (const s of await page.locator('.note-scroll, .sr-chat').all()) expect(await s.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
  for (const f of await scope.locator('figure.pub-media').all()) {
    const b = (await f.boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(-1);
    expect(b.x + b.width).toBeLessThanOrEqual(vw + 1);
    const player = f.locator('video, audio, img').first();
    if (await player.count()) { const p = (await player.boundingBox())!; expect(p.width).toBeGreaterThanOrEqual(Math.min(200, b.width - 1)); expect(p.x + p.width).toBeLessThanOrEqual(b.x + b.width + 1); }
    for (const c of await f.locator('.pub-act, .pub-open').all()) { const cb = (await c.boundingBox())!; expect(cb.height).toBeGreaterThanOrEqual(44); }
  }
}
/**
 * The image viewer is a dialog (Codex r2): Tab and Shift+Tab stay inside it, everything behind it is out of reach, Escape closes only
 * it, and focus goes back to the button that opened it.
 */
async function viewerContract(page: Page, opener: Locator) {
  await opener.click();
  const box = page.getByRole('dialog', { name: 'garden-map-2c3d4e5f.png' });
  await expect(box.locator('img')).toBeVisible();
  const inBox = () => page.evaluate(() => !!document.activeElement?.closest('.lightbox'));
  await expect.poll(inBox).toBe(true);
  for (let i = 0; i < 4; i++) { await page.keyboard.press('Tab'); expect(await inBox()).toBe(true); }
  for (let i = 0; i < 4; i++) { await page.keyboard.press('Shift+Tab'); expect(await inBox()).toBe(true); }
  // the app behind is inert while it is up (no tap, no screen reader)
  expect(await page.evaluate(() => (document.getElementById('root') as HTMLElement & { inert: boolean }).inert)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(box).toHaveCount(0);
  await expect(opener).toBeFocused();
  expect(await page.evaluate(() => (document.getElementById('root') as HTMLElement & { inert: boolean }).inert)).toBe(false);
}
/** No player ever asked the app for a file: the webview loads it, never the app with your credentials. */
const nativeFetches = (page: Page) => page.evaluate((o) => (window as any).__calls.filter((c: any) => /^media_/.test(c.cmd) || JSON.stringify(c.args ?? {}).includes(o) && c.cmd !== 'open_link').length, ORIGIN);

test.describe('published media in notes and decisions', () => {
  test('a Published note plays its own file, once, in place: metadata, seek, play; full screen and back; a way out to the browser', async ({ page }) => {
    await open(page);
    const view = await openNote(page, PUB, 'The garden walk clip is up:');
    await expect(view.locator('.note-title')).toHaveText('Garden walk clip');
    // one player (the note's metadata), the body's URL line not shown again, its sentence kept
    await expect(view.locator('video')).toHaveCount(1);
    await expect(view.locator('figure.pub-video')).toHaveAttribute('data-url', VIDEO);
    await expect(view.locator(`.note-body a[href="${VIDEO}"]`)).toHaveCount(0);
    await expect(view.locator('.note-body')).toContainText('A short clip of the garden walk.');
    await expect(view.locator('figure.pub-video .pub-name')).toHaveText('garden-walk-0a1b2c3d.webm');
    await plays(view.locator('video'));
    await fits(page, view);
    // full screen: the app's own layer (T-258's), from where it was; Escape closes only it, and the note carries on from there
    const inline = view.locator('video');
    await inline.evaluate((v: HTMLVideoElement) => { v.currentTime = 2; });
    await view.getByRole('button', { name: 'Full screen: garden-walk-0a1b2c3d.webm' }).click();
    const layer = page.getByRole('dialog', { name: 'garden-walk-0a1b2c3d.webm, full screen' });
    await expect(layer.locator('video')).toBeVisible();
    await expect.poll(() => layer.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(1.5);
    await page.keyboard.press('Escape');
    await expect(layer).toHaveCount(0);
    await expect(view).toBeVisible();
    await expect.poll(() => inline.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(1.5);
    // the way out: the system browser (open_link), never a page inside the app
    await view.locator('figure.pub-video').getByRole('link', { name: 'Open in browser ↗' }).click();
    expect(await page.evaluate(() => (window as any).__calls.filter((c: any) => c.cmd === 'open_link').map((c: any) => c.args.url))).toContain(VIDEO);
    expect(await nativeFetches(page)).toBe(0);
  });

  test('a decision card shows the clip its note links, playable in the card; the page stays a link; its Context plays the same clip', async ({ page }) => {
    await open(page);
    await arrive(page, `Your call on the garden walk cut. uni:${DEC}`);
    const card = page.locator('.sr-chat .message').filter({ hasText: 'Your call on the garden walk cut' }).getByRole('region', { name: 'Decision: Which cut of the garden walk?' });
    await expect(card).toBeVisible();
    await expect(card.locator('video')).toHaveCount(1);
    await expect(card.locator('figure.pub-video')).toHaveAttribute('data-url', VIDEO);
    await plays(card.locator('video'));
    // the page is a link to open, not a frame; the options are still the card's
    await expect(card.locator('iframe')).toHaveCount(0);
    await expect(card.locator('.pub-link')).toHaveCount(3);
    await expect(card.getByRole('link', { name: 'Open PDF: garden-notes-4e5f6071.pdf ↗' })).toBeVisible();
    await card.getByRole('link', { name: 'Open page: garden-plan-3d4e5f60.html ↗' }).click();
    expect(await page.evaluate(() => (window as any).__calls.filter((c: any) => c.cmd === 'open_link').map((c: any) => c.args.url))).toContain(PAGE);
    await expect(card.getByRole('group', { name: /^Pick one:/ }).getByRole('button')).toHaveText(['Short', 'Longdefault']);
    await fits(page, card);
    // its context: the decision's note, with the clip playing after the sentence that links it (the link stays), the page a link
    await card.getByRole('button', { name: 'Context ›' }).click();
    const view = page.locator('.note-view').last();
    await expect(view.locator('.note-body')).toBeVisible();
    await expect(view.locator('.note-body video')).toHaveCount(1);
    await expect(view.locator(`.note-body a[href="${VIDEO}"]:not(.pub-open)`)).toHaveCount(1);
    await expect(view.locator(`.note-body a[href="${PAGE}"]`)).toHaveCount(1);
    await expect(view.locator('.note-body figure.pub-media')).toHaveCount(1);
    await plays(view.locator('.note-body video'));
    await fits(page, view);
    expect(await nativeFetches(page)).toBe(0);
  });

  test('the decision\'s sheet (Needs you) plays the clip too', async ({ page }) => {
    test.skip(!wide(page), 'the sheet opens from the companion, beside the chat');
    await open(page);
    const row = page.locator('.cp').getByText('Which cut of the garden walk?').first();
    await row.click();
    const sheet = page.locator('.task-sheet[role="dialog"]');
    await expect(sheet.getByRole('heading', { name: 'Which cut of the garden walk?' })).toBeVisible();
    const media = sheet.locator('.task-media video');
    await expect(media).toHaveCount(1);
    await plays(media);
    await fits(page, sheet);
    // full screen over the sheet: Escape closes only the player's layer, the sheet stays (Codex r1)
    await sheet.getByRole('button', { name: 'Full screen: garden-walk-0a1b2c3d.webm' }).click();
    const layer = page.getByRole('dialog', { name: 'garden-walk-0a1b2c3d.webm, full screen' });
    await expect(layer.locator('video')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(layer).toHaveCount(0);
    await expect(sheet).toBeVisible();
    // the image the step links, opened full size over the sheet: a dialog of its own; the sheet stays and takes focus back
    await viewerContract(page, sheet.getByRole('button', { name: 'Open image garden-map-2c3d4e5f.png' }));
    await expect(sheet).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
  });

  test('a note\'s image shows (and opens large), its audio plays; a PDF, other hosts, lookalikes and script links stay links', async ({ page }) => {
    await open(page);
    const view = await openNote(page, ASSETS, 'Assets for the garden:');
    const img = view.locator('figure.pub-image img');
    await expect(img).toHaveCount(1);
    await img.scrollIntoViewIfNeeded();
    await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete ? i.naturalWidth : 0)).toBe(640);
    await viewerContract(page, view.getByRole('button', { name: 'Open image garden-map-2c3d4e5f.png' }));
    await plays(view.locator('figure.pub-audio audio'));
    // nothing else plays: one image, one audio, no video (code, other hosts, the lookalike and the other port are not ours)
    await expect(view.locator('.note-body video')).toHaveCount(0);
    await expect(view.locator('.note-body audio')).toHaveCount(1);
    await expect(view.locator('.note-body figure.pub-media')).toHaveCount(2);
    await expect(view.locator(`.note-body a[href="${DOC}"]`)).toHaveCount(1);
    await expect(view.locator('.note-body a[href="https://www.example.org/garden-walk.webm"]')).toHaveCount(1);
    await expect(view.locator('.note-body a[href^="https://uni.example.ts.net.evil.example"]')).toHaveCount(1);
    await expect(view.locator('.note-body a[href^="https://uni.example.ts.net:8445"]')).toHaveCount(1);
    await expect(view.locator('.note-body a[href^="javascript:"]')).toHaveCount(0);
    await expect(view.locator('.note-body code')).toHaveText(VIDEO);
    await fits(page, view);
    expect(await nativeFetches(page)).toBe(0);
  });

  test('off the tailnet: the player and the image say why, with Try again and the way to the browser', async ({ page }) => {
    await open(page);
    const view = await openNote(page, GONE, 'These need the tailnet:');
    const video = view.locator('figure.pub-video');
    await expect(video.getByRole('alert')).toContainText("Couldn't play this file here");
    await expect(video.getByRole('alert')).toContainText('this device needs to be on the tailnet');
    await expect(video.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(video.getByRole('link', { name: 'Open in browser ↗' })).toBeVisible();
    await expect(video.getByRole('button', { name: /^Full screen/ })).toHaveCount(0);
    const image = view.locator('figure.pub-image');
    await expect(image.getByRole('alert')).toContainText("This image didn't load");
    await expect(image.getByRole('link', { name: 'Open in browser ↗' })).toBeVisible();
    await fits(page, view);
  });

  test('a new hub in Settings is read again: a note that showed only a link plays once the hub serves published files', async ({ page }) => {
    test.skip(!wide(page), 'the Journal settings are reached from the rail');
    await open(page, false);
    const view = await openNote(page, PUB, 'The garden walk clip is up:');
    await expect(view.locator('.note-body a[href="' + VIDEO + '"]')).toHaveCount(1);
    await expect(view.locator('video')).toHaveCount(0);
    // the hub is changed to one that serves published files (the fixture answers with its origin from now on)
    await page.evaluate((o) => { (window as any).__publishOrigins = [o]; }, ORIGIN);
    await page.getByRole('button', { name: 'Journal', exact: true }).click();
    await page.getByRole('button', { name: 'Journal settings' }).click();
    await page.locator('.journal-settings').getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('.journal-settings')).toHaveCount(0);
    await page.getByRole('button', { name: 'Uni', exact: true }).first().click();
    await toGarden(page);
    const again = await openNote(page, PUB, 'Again, the garden walk clip:');
    await expect(again.locator('video')).toHaveCount(1);
    await plays(again.locator('video'));
  });

  test('with no publish origin (another hub, or none read), the same links are plain links', async ({ page }) => {
    await open(page, false);
    const view = await openNote(page, PUB, 'The garden walk clip is up:');
    await expect(view.locator('.note-body a[href="' + VIDEO + '"]')).toHaveCount(1);
    await expect(view.locator('video, audio, figure.pub-media')).toHaveCount(0);
  });
});

// T-335: opening a note never makes a network request its content asks for. A remote image would tell its server the note was
// opened (and when, and from where), so it shows as a link with a "Load image" tap for that one image; the vault's own attachments
// still show. Two walls: the renderer (no remote src ever reaches the DOM; raw HTML in a note is never rendered) and the app's CSP
// (tauri.conf.json, which vite serves here as the packaged app does), which refuses anything that slips past the renderer.
// The tracker is made up (`tracker.example`); page.route serves it, so any request the webview makes is seen and answered for real.
import { test, expect, type Page } from '@playwright/test';
import { startInRoom } from './startInRoom';

const TRACKER = 'https://tracker.example';
// a 1×1 PNG: what the tracker (and the vault, and the app's own fetch) answer with
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

type Seen = { tracker: string[] };

async function boot(page: Page, content: string, opts: { attachment?: string } = {}): Promise<Seen> {
  const seen: Seen = { tracker: [] };
  page.on('request', (r) => { if (r.url().startsWith(TRACKER)) seen.tracker.push(r.url()); });
  await page.route(`${TRACKER}/**`, (route) => route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from(PNG, 'base64') }));
  await page.addInitScript(({ content, png, attachment }) => {
    const w = window as any;
    const bytes = () => Uint8Array.from(atob(png), (c) => c.charCodeAt(0)).buffer;
    w.__calls = [];
    localStorage.setItem('uni.tabs.v2', JSON.stringify({ v: 1, tabs: [{ id: 'note', kind: 'note', title: 'Field notes', note: { hub: null, vault: 'uni', ref: 'n-field' } }], active: 'note', recent: ['note'] }));
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: () => 1,
      invoke: async (cmd: string, args: any) => {
        w.__calls.push({ cmd, args });
        switch (cmd) {
          case 'identity_status': return { paired: true, pubkey: 'a'.repeat(64) };
          case 'get_identity': return 'a'.repeat(64);
          case 'get_npub': return 'test';
          case 'get_rooms': return [{ id: 'test', name: 'Test room', unread: 0 }];
          case 'get_members': case 'get_messages': case 'search': return [];
          case 'vault_list': return ['uni'];
          case 'journal_config': return { hub: 'https://hub.example.ts.net' };
          case 'refresh': return { total_items: 0, channel_errors: {}, truncated_channels: [] };
          case 'vault_note':
            if (args.noteRef !== 'n-field') return { vault: 'uni', note: { id: args.noteRef, content: '' } };
            return { hub: 'https://hub.example.ts.net', vault: 'uni', note: { id: 'n-field', path: 'Field notes', extension: 'md', content, tags: [] } };
          case 'vault_attachment':
            if (args.vault === 'uni' && args.note === 'n-field' && args.path === attachment) return bytes();
            throw 'not an attachment of this note';
          case 'remote_image': return bytes();
          default: return null;
        }
      },
    };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  }, { content, png: PNG, attachment: opts.attachment ?? null });
  await startInRoom(page, 'test');
  await page.goto('/');
  await expect(page.locator('.note-body')).toBeVisible();
  return seen;
}

/** Give anything the page would fetch time to go out. */
const settle = async (page: Page) => { await page.waitForLoadState('networkidle'); await page.waitForTimeout(400); };
const calls = (page: Page, cmd: string) => page.evaluate((c) => (window as any).__calls.filter((x: any) => x.cmd === c).map((x: any) => x.args), cmd);

test('a remote image in a note is never fetched: it shows as a link with a Load image tap', async ({ page }) => {
  const seen = await boot(page, '# Field notes\n\nThe chart:\n\n![weekly chart](https://tracker.example/pixel.png?n=1)\n\nAfter.');
  await settle(page);
  expect(seen.tracker, 'opening the note told the image server nothing').toEqual([]);
  const body = page.locator('.note-body');
  await expect(body.locator('img')).toHaveCount(0);
  const link = body.getByRole('link', { name: /weekly chart/ });
  await expect(link).toHaveAttribute('href', 'https://tracker.example/pixel.png?n=1');
  await expect(body.getByRole('button', { name: 'Load image: weekly chart' })).toBeVisible();
  expect(await calls(page, 'remote_image')).toEqual([]);
});

test('Load image fetches that one image, through the app, and no other', async ({ page }) => {
  const seen = await boot(page, '![first](https://tracker.example/one.png)\n\n![second](https://tracker.example/two.png)\n\n[![linked](https://tracker.example/three.png)](https://www.example.org/)\n\n![ref][r]\n\n[r]: https://tracker.example/four.png');
  await settle(page);
  const body = page.locator('.note-body');
  await expect(body.getByRole('button', { name: /^Load image/ })).toHaveCount(4);
  await body.getByRole('button', { name: 'Load image: first' }).click();
  const img = body.locator('img');
  await expect(img).toHaveCount(1);
  await expect(img).toHaveAttribute('src', /^blob:/);
  await expect(img).toHaveAttribute('alt', 'first');
  expect(await img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(1);
  expect(await calls(page, 'remote_image')).toEqual([{ url: 'https://tracker.example/one.png' }]);
  await expect(body.getByRole('button', { name: /^Load image/ })).toHaveCount(3);
  await settle(page);
  expect(seen.tracker, 'the webview itself never fetched any of them').toEqual([]);
});

test('raw HTML in a note loads nothing: img, CSS url(), stylesheets, prefetch, audio, video, iframe, object, svg', async ({ page }) => {
  const T = TRACKER;
  const seen = await boot(page, [
    '# Raw', '',
    `<img src="${T}/img.png">`,
    `<div style="background:url(${T}/css-attr.png)">styled</div>`,
    `<style>@import url(${T}/import.css); body { background: url(${T}/css-style.png) } @font-face { font-family: x; src: url(${T}/font.woff2) }</style>`,
    `<link rel="stylesheet" href="${T}/sheet.css">`, `<link rel="prefetch" href="${T}/prefetch">`, `<link rel="preload" as="image" href="${T}/preload.png">`,
    `<audio src="${T}/audio.mp3" autoplay></audio>`, `<video src="${T}/video.mp4" poster="${T}/poster.png" autoplay muted></video>`,
    `<video><source src="${T}/source.mp4"></video>`, `<picture><source srcset="${T}/srcset.png"><img src="${T}/picture.png"></picture>`,
    `<iframe src="${T}/frame"></iframe>`, `<object data="${T}/object"></object>`, `<embed src="${T}/embed">`,
    `<svg><image href="${T}/svg.png"/></svg>`, '', 'Text after.',
  ].join('\n'));
  await settle(page);
  expect(seen.tracker).toEqual([]);
  await expect(page.locator('.note-body')).toContainText('Text after.');
  await expect(page.locator('.note-body').locator('img, iframe, audio, video, source, link, style, object, embed, image, picture')).toHaveCount(0);
});

test('the CSP refuses every content-driven load that reaches the page anyway', async ({ page }) => {
  const seen = await boot(page, '# Wall\n\nNothing here.');
  const violated = await page.evaluate(async (T) => {
    const v: string[] = [];
    document.addEventListener('securitypolicyviolation', (e) => v.push(`${e.effectiveDirective} ${e.blockedURI}`));
    const add = (html: string) => { const d = document.createElement('div'); d.innerHTML = html; document.body.appendChild(d); };
    add(`<img src="${T}/img.png">`);
    add(`<div style="width:10px;height:10px;background:url(${T}/css-attr.png)"></div>`);
    const s = document.createElement('style'); s.textContent = `@import url(${T}/import.css); .x-bg { background: url(${T}/css-style.png) } @font-face { font-family: tracked; src: url(${T}/font.woff2) } .x-font { font-family: tracked }`;
    document.head.appendChild(s);
    add('<div class="x-bg" style="width:10px;height:10px"></div><p class="x-font">font</p>');
    for (const [rel, extra] of [['stylesheet', ''], ['prefetch', ''], ['preload', ' as="image"'], ['preload', ' as="fetch" crossorigin']] as const) {
      add(`<link rel="${rel}"${extra} href="${T}/${rel}-${extra ? 'x' : 'plain'}">`);
    }
    add(`<audio src="${T}/audio.mp3" autoplay></audio><video src="${T}/video.mp4" poster="${T}/poster.png" muted autoplay></video>`);
    add(`<iframe src="${T}/frame"></iframe><object data="${T}/object" type="text/html"></object><embed src="${T}/embed" type="text/html">`);
    add(`<svg width="10" height="10"><image href="${T}/svg.png" width="10" height="10"/></svg>`);
    await new FontFace('tracked2', `url(${T}/fontface.woff2)`).load().catch(() => {});
    await fetch(`${T}/fetch`).catch(() => {});
    navigator.sendBeacon(`${T}/beacon`, 'x');
    await new Promise<void>((r) => { const x = new XMLHttpRequest(); x.open('GET', `${T}/xhr`); x.onloadend = () => r(); try { x.send(); } catch { r(); } });
    try { new EventSource(`${T}/events`); } catch { /* refused */ }
    try { new WebSocket('wss://tracker.example/ws'); } catch { /* refused */ }
    await new Promise((r) => setTimeout(r, 1200));
    return v;
  }, TRACKER);
  await settle(page);
  expect(seen.tracker, 'nothing reached the tracker').toEqual([]);
  const directives = new Set(violated.map((x) => x.split(' ')[0]));
  for (const d of ['img-src', 'style-src-elem', 'font-src', 'media-src', 'frame-src', 'object-src', 'connect-src']) expect([...directives], d).toContain(d);
});

test('an image attached to the note still shows, read through the app', async ({ page }) => {
  const seen = await boot(page, '# Field notes\n\n![diagram](/api/storage/2026-11-13/diagram.png)\n\n![other note\'s](/api/storage/2026-11-13/elsewhere.png)', { attachment: '2026-11-13/diagram.png' });
  const body = page.locator('.note-body');
  const img = body.locator('img[alt="diagram"]');
  await expect(img).toHaveAttribute('src', /^blob:/);
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(1);
  expect(await calls(page, 'vault_attachment')).toContainEqual({ vault: 'uni', note: 'n-field', path: '2026-11-13/diagram.png' });
  // a storage path the note doesn't own is refused by the app and says so; it is never tried as a remote image
  await expect(body.getByText(/elsewhere\.png|other note's/)).toBeVisible();
  await expect(body.locator('img[alt="other note\'s"]')).toHaveCount(0);
  await settle(page);
  expect(seen.tracker).toEqual([]);
  expect(await calls(page, 'remote_image')).toEqual([]);
});

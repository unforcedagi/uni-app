// T-335: opening a note never makes a network request its content asks for. A remote image would tell its server the note was
// opened (and when, and from where), so it shows as a link with a "Load image" tap for that one image; the vault's own attachments
// still show. Two walls: the renderer (no remote src ever reaches the DOM; raw HTML in a note is never rendered) and the app's CSP
// (tauri.conf.json, which vite serves here as the packaged app does), which refuses anything that slips past the renderer.
// The tracker is made up (`tracker.example`); page.route serves it, and a request counts only when it reaches that handler (Chromium
// reports a load the CSP blocked as a `request` event too, so those events prove nothing). The CSP test also aims every kind at a
// real HTTP server on this machine (`localhost`, which no CSP source names) and counts what arrives.
import http from 'node:http';
import { test, expect, type Page } from '@playwright/test';
import { startInRoom } from './startInRoom';

const TRACKER = 'https://tracker.example';
// a 1×1 PNG: what the tracker (and the vault, and the app's own fetch) answer with
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

type Seen = { tracker: string[] };

async function boot(page: Page, content: string, opts: { attachment?: string } = {}): Promise<Seen> {
  const seen: Seen = { tracker: [] };
  await page.route(`${TRACKER}/**`, (route) => { seen.tracker.push(route.request().url()); return route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from(PNG, 'base64') }); });
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
            return { hub: 'https://hub.example.ts.net', vault: 'uni', note: { id: 'n-field', path: 'Field notes', extension: 'md', content, tags: [], updatedAt: '2026-11-13T10:00:00Z' } };
          case 'vault_save': return { id: 'n-field', path: 'Field notes', extension: 'md', content: args.content, tags: [], updatedAt: '2026-11-13T10:05:00Z' };
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
const settle = async (page: Page) => { await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {}); await page.waitForTimeout(600); };
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
  // an image inside a link is that link's words only: no second link, no button inside a link; the link itself still works
  const linked = body.locator('a[href="https://www.example.org/"]');
  await expect(linked).toHaveText('linked');
  await expect(linked.locator('a, button, img')).toHaveCount(0);
  await expect(body.getByRole('button', { name: /^Load image/ })).toHaveCount(3);
  await body.getByRole('button', { name: 'Load image: first' }).click();
  const img = body.locator('img');
  await expect(img).toHaveCount(1);
  await expect(img).toHaveAttribute('src', /^blob:/);
  await expect(img).toHaveAttribute('alt', 'first');
  expect(await img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(1);
  expect(await calls(page, 'remote_image')).toEqual([{ url: 'https://tracker.example/one.png' }]);
  await expect(body.getByRole('button', { name: /^Load image/ })).toHaveCount(2);
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

/** A real server: every request it gets is logged, and answered as an image (so nothing fails for a reason other than the CSP). */
async function listener() {
  const urls: string[] = [];
  const server = http.createServer((req, res) => { urls.push(req.url ?? ''); res.writeHead(200, { 'content-type': 'image/png', 'access-control-allow-origin': '*' }); res.end(Buffer.from(PNG, 'base64')); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { origin: `http://localhost:${(server.address() as { port: number }).port}`, urls, close: () => { server.closeAllConnections?.(); return new Promise<void>((r) => server.close(() => r())); } };
}

for (const target of ['tracker', 'listener'] as const) {
  test(`the CSP refuses every content-driven load that reaches the page anyway (${target})`, async ({ page }) => {
    const L = await listener();
    try {
      const seen = await boot(page, '# Wall\n\nNothing here.');
      const T = target === 'tracker' ? TRACKER : L.origin;
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
        try { navigator.sendBeacon(`${T}/beacon`, 'x'); } catch { /* refused */ }
        await new Promise<void>((r) => { const x = new XMLHttpRequest(); x.open('GET', `${T}/xhr`); x.onloadend = () => r(); try { x.send(); } catch { r(); } });
        try { new EventSource(`${T}/events`); } catch { /* refused */ }
        try { new WebSocket(T.replace(/^http/, 'ws') + '/ws'); } catch { /* refused */ }
        await new Promise((r) => setTimeout(r, 1500));
        return v;
      }, T);
      await settle(page);
      expect(seen.tracker, 'nothing reached the tracker').toEqual([]);
      expect(L.urls, 'nothing reached the real server').toEqual([]);
      const directives = new Set(violated.map((x) => x.split(' ')[0]));
      for (const d of ['img-src', 'style-src-elem', 'font-src', 'media-src', 'frame-src', 'object-src', 'connect-src']) expect([...directives], d).toContain(d);
    } finally { await L.close(); }
  });
}

test('an image attached to the note still shows, read through the app', async ({ page }) => {
  const seen = await boot(page, '# Field notes\n\n![diagram](/api/storage/2026-11-13/diagram.png)\n\n![other note\'s](/api/storage/2026-11-13/elsewhere.png)', { attachment: '2026-11-13/diagram.png' });
  const body = page.locator('.note-body');
  const img = body.locator('img[alt="diagram"]');
  await expect(img).toHaveAttribute('src', /^blob:/);
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(1);
  // the note is edited and saved: it shows again from the copy the app already has, never read again
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByRole('textbox', { name: 'Note content' }).fill('# Field notes\n\n![diagram](/api/storage/2026-11-13/diagram.png)\n\n![other note\'s](/api/storage/2026-11-13/elsewhere.png)\n\nEdited.');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(body).toContainText('Edited.');
  await expect(body.locator('img[alt="diagram"]')).toHaveAttribute('src', /^blob:/);
  await settle(page);
  // read once: a redraw of the note never reads its attachments again
  expect((await calls(page, 'vault_attachment')).filter((c: any) => c.path === '2026-11-13/diagram.png')).toEqual([{ vault: 'uni', note: 'n-field', path: '2026-11-13/diagram.png' }]);
  // a storage path the note doesn't own is refused by the app and says so; it is never tried as a remote image
  await expect(body.getByText(/elsewhere\.png|other note's/)).toBeVisible();
  await expect(body.locator('img[alt="other note\'s"]')).toHaveCount(0);
  await settle(page);
  expect(seen.tracker).toEqual([]);
  expect(await calls(page, 'remote_image')).toEqual([]);
});

// Chat follows the same rule: an image link in a message (or an image attachment off the relay) used to preview on sight; now it is a
// "Load image" tap, fetched through the app, and opens large from that copy.
test('an image link in a chat message is not fetched until its Load image tap', async ({ page }) => {
  const seen: Seen = { tracker: [] };
  await page.route(`${TRACKER}/**`, (route) => { seen.tracker.push(route.request().url()); return route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from(PNG, 'base64') }); });
  await page.addInitScript(({ png }) => {
    const w = window as any;
    const bytes = () => Uint8Array.from(atob(png), (c) => c.charCodeAt(0)).buffer;
    w.__calls = [];
    const now = Math.floor(Date.now() / 1000);
    const msg = (ref: string, ts: number, body: string, media: unknown[]) => ({ ref, channel: 'test', author: 'b'.repeat(64), author_name: 'Test member', ts, body,
      mentions_me: false, root: null, parent: null, mentions: [], reply_count: 0, last_reply_ts: null, edited: false, reactions: [], media });
    const messages = [
      msg('m1', now - 60, 'Look at this https://tracker.example/photo.jpg', []),
      msg('m2', now - 30, 'And this one', [{ url: 'https://tracker.example/attached.png', mime: 'image/png', sha256: null, size: 70, dim: null, blurhash: null, alt: null, filename: 'attached.png' }]),
    ];
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: () => 1,
      invoke: async (cmd: string, args: any) => {
        w.__calls.push({ cmd, args });
        switch (cmd) {
          case 'identity_status': return { paired: true, pubkey: 'a'.repeat(64) };
          case 'get_identity': return 'a'.repeat(64);
          case 'relay_origin': return 'https://relay.example';
          case 'get_npub': return 'test';
          case 'get_rooms': return [{ id: 'test', name: 'Test room', unread: 0 }];
          case 'get_members': return [{ pubkey: 'b'.repeat(64), name: 'Test member' }];
          case 'get_messages': return messages;
          case 'vault_list': return [];
          case 'journal_config': return { hub: 'test' };
          case 'refresh': return { total_items: 2, channel_errors: {}, truncated_channels: [] };
          case 'remote_image': return bytes();
          default: return null;
        }
      },
    };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  }, { png: PNG });
  await startInRoom(page, 'test');
  await page.goto('/');
  const load = page.getByRole('button', { name: 'Load image from tracker.example' });
  await expect(load).toHaveCount(2);
  await settle(page);
  expect(seen.tracker, 'showing the room told the image server nothing').toEqual([]);
  await expect(page.locator('.attachments img')).toHaveCount(0);
  await load.first().click();
  const shown = page.getByRole('button', { name: 'Open image https://tracker.example/photo.jpg' });
  await expect(shown.locator('img')).toHaveAttribute('src', /^blob:/);
  expect(await calls(page, 'remote_image')).toEqual([{ url: 'https://tracker.example/photo.jpg' }]);
  await expect(load).toHaveCount(1);
  await shown.click();
  await expect(page.locator('.lightbox img')).toHaveAttribute('src', /^blob:/);
  await settle(page);
  expect(seen.tracker).toEqual([]);
});

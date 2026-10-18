// T-174: saving and opening attachments. "Save" puts the file where the user finds it and says where;
// any failure shows on the card. The Tauri commands are mocked here; the Rust save path has its own
// tests (uni-core `saved_attachment_lands_in_downloads_under_its_name`).
import { test, expect, type Page, type Locator } from '@playwright/test';

const PDF = '6'.repeat(64), MP4 = 'f'.repeat(64), JPG = '7'.repeat(64);
const O = 'https://relay.example';

async function press(page: Page, target: Locator) {
  if (test.info().project.name === 'mobile') await target.tap();
  else await target.click();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ PDF, MP4, JPG, O }) => {
    const w = window as any;
    w.calls = [];
    w.replies = {}; // cmd → Error message to reject with
    const now = Math.floor(Date.now() / 1000);
    const media = (sha: string, ext: string, mime: string, filename: string, size: number) =>
      ({ url: `${O}/media/${sha}.${ext}`, mime, sha256: sha, size, dim: ext === 'jpg' ? '1200x800' : null, blurhash: null, alt: null, filename });
    const msg = (ref: string, ts: number, body: string, m: unknown) => ({ ref, channel: 'test', author: 'b'.repeat(64), author_name: 'Test member', ts, body,
      mentions_me: false, root: null, parent: null, mentions: [], reply_count: 0, last_reply_ts: null, edited: false, reactions: [], media: [m] });
    const messages = [
      msg('m1', now - 180, 'The report', media(PDF, 'pdf', 'application/pdf', 'Q3 report.pdf', 70563)),
      msg('m2', now - 120, 'Class recording', media(MP4, 'mp4', 'video/mp4', 'class.mp4', 36665525)),
      msg('m3', now - 60, 'The garden', media(JPG, 'jpg', 'image/jpeg', 'garden.jpg', 51421)),
    ];
    // 1x1 PNG, so the image card has something to show.
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='), (c) => c.charCodeAt(0)).buffer;
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: () => 1,
      convertFileSrc: (p: string, proto: string) => `${proto}://localhost/${p}`,
      invoke: async (cmd: string, args: any) => {
        w.calls.push({ cmd, args });
        if (w.replies[cmd]) throw w.replies[cmd];
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
          case 'refresh': return { pubkey: 'a'.repeat(64), total_items: 3, channel_errors: {}, truncated_channels: [] };
          case 'media_bytes':
            if (args.sha === JPG) return png;
            throw 'no preview in this test';
          case 'media_save': return `Downloads/${args.name}`;
          case 'media_open': return null;
          default: return null;
        }
      },
    };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  }, { PDF, MP4, JPG, O });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Open Q3 report.pdf' })).toBeVisible();
});

const calls = (page: Page, cmd: string) => page.evaluate((cmd) => (window as any).calls.filter((c: any) => c.cmd === cmd).map((c: any) => c.args), cmd);
const failNext = (page: Page, cmd: string, message: string) => page.evaluate(([cmd, message]) => { (window as any).replies[cmd] = message; }, [cmd, message]);

test('Save on a file says where it went', async ({ page }) => {
  await press(page, page.getByRole('button', { name: 'Save Q3 report.pdf to Downloads' }));
  await expect(page.getByRole('status').filter({ hasText: 'Saved to Downloads/Q3 report.pdf' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save Q3 report.pdf to Downloads' })).toHaveText('✓ Saved');
  expect(await calls(page, 'media_save')).toEqual([{ url: `${O}/media/${PDF}.pdf`, sha: PDF, name: 'Q3 report.pdf', mime: 'application/pdf' }]);
});

test('A failed save shows why on the card, and can be tried again', async ({ page }) => {
  await failNext(page, 'media_save', "Couldn't save to Downloads: No space left on device");
  const save = page.getByRole('button', { name: 'Save Q3 report.pdf to Downloads' });
  await press(page, save);
  await expect(page.getByRole('alert').filter({ hasText: "⚠ Not saved: Couldn't save to Downloads: No space left on device" })).toBeVisible();
  await expect(save).toBeEnabled();
  await failNext(page, 'media_save', '');
  await press(page, save);
  await expect(page.getByRole('status').filter({ hasText: 'Saved to Downloads/Q3 report.pdf' })).toBeVisible();
});

test('A failed open shows why on the card', async ({ page }) => {
  await failNext(page, 'media_open', 'No app on this device opens this kind of file. Save it to Downloads instead');
  await press(page, page.getByRole('button', { name: 'Open Q3 report.pdf' }));
  await expect(page.getByRole('alert').filter({ hasText: '⚠ No app on this device opens this kind of file. Save it to Downloads instead · tap to retry' })).toBeVisible();
  expect(await calls(page, 'media_open')).toEqual([{ url: `${O}/media/${PDF}.pdf`, sha: PDF, mime: 'application/pdf' }]);
});

test('Videos can be saved too', async ({ page }) => {
  await press(page, page.getByRole('button', { name: 'Save class.mp4 to Downloads' }));
  await expect(page.getByRole('status').filter({ hasText: 'Saved to Downloads/class.mp4' })).toBeVisible();
  // Saving does not start playback.
  expect(await calls(page, 'media_stream')).toEqual([]);
});

test('Images can be saved from the full-screen view', async ({ page }) => {
  await press(page, page.getByRole('button', { name: 'Open image garden.jpg' }));
  const dialog = page.getByRole('dialog', { name: 'garden.jpg' });
  await expect(dialog).toBeVisible();
  await failNext(page, 'media_save', 'download failed: connection reset');
  await press(page, dialog.getByRole('button', { name: 'Save garden.jpg to Downloads' }));
  await expect(dialog.getByRole('alert')).toHaveText('⚠ Not saved: Download failed: connection reset');
  await failNext(page, 'media_save', '');
  await press(page, dialog.getByRole('button', { name: 'Save garden.jpg to Downloads' }));
  await expect(dialog.getByRole('status')).toHaveText('✓ Saved to Downloads/garden.jpg');
  // Tapping Save did not close the image.
  await expect(dialog).toBeVisible();
});

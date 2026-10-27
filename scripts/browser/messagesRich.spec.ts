// T-313: a conversation as a chat app shows it. A link in a message opens in the system browser (and only a web link
// does); a voice message plays inline, can be scrubbed, and shows its words under it, asked for once; a picture shows
// and opens large; a file opens; a reply quotes what it answers and goes to it; reactions sit under the bubble; a long
// message folds. An attachment declared as SVG shows as a file, never as a picture. Messages' door is faked with
// made-up people and sounds (no homeserver); what the app does with them is its own.
// Run: npx playwright test --config playwright.messagestabs.config.ts messagesRich
import { expect, test, type Page } from '@playwright/test';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAAf0lEQVR42u3PsQmAMBRFUcdxCIdwHCdxOmtrRxBBECXEpPJLDrzyvuJ0y7r9eh0AAAAAAAAAAAAAQLuAYR6qDtH6A1D1idafgPJPtP4CFH6i9TdAySda/wS8fqL1CUD+E61PAzKfaD0AAAAAQOOAaex/PQAAAAAAAAAAAIDvtgO+CzGaBKHRAgAAAABJRU5ErkJggg==';
const WORDS = 'Bring the green umbrella, it might rain later.';
const LONG_END = 'and that is the whole plan for the beds.';

/** The app's IPC with Messages' door faked: one conversation holding every kind of message. Calls are counted in
 * `__calls`; `__failWords` makes the next transcript ask fail once. */
async function boot(page: Page, signedOut = false) {
  await page.addInitScript(([png, words, longEnd, out]) => {
    const w = window as any;
    localStorage.setItem('uni.tabs.v1', JSON.stringify({ v: 1, tabs: [{ id: 'messages', kind: 'messages', title: 'Messages' }], active: 'messages', recent: ['messages'] }));
    localStorage.setItem('uni.messages.seen.v1', '1');
    w.__calls = [] as { cmd: string; args: any }[];
    w.__signedOut = out;
    const now = Date.now(), min = 60_000;
    const room = (id: string, name: string, ago: number, preview: string) =>
      ({ id: `!${id}:example.org`, name, preview, preview_own: false, ts: now - ago * min, unread: 0, encrypted: true, invited: false, inviter: null, direct: true, network: 'signal' });
    w.__rooms = [room('robin', 'Robin Vale', 1, 'Voice message (0:02)'), room('kit', 'Kit Sample', 30, 'Thanks!')];
    // a 2 s tone, as a WAV the browser plays
    const tone = (() => {
      const rate = 8000, n = rate * 2, b = new ArrayBuffer(44 + n * 2), v = new DataView(b);
      const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
      str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 2, true);
      for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin(i * 0.3) * 6000, true);
      return b;
    })();
    const picture = Uint8Array.from(atob(png), (c) => c.charCodeAt(0)).buffer;
    const R = '!robin:example.org';
    const base = { sender: '@robin:example.org', sender_name: 'Robin', own: false, state: 'remote', encrypted: true, edited: false, kind: 'text', media: null, reply: null, reactions: [] };
    const media = (over: object) => ({ kind: 'file', name: '', mime: 'application/octet-stream', size: null, duration_ms: null, width: null, height: null, caption: null, ...over });
    let i = 0;
    const m = (over: object) => { i++; return { ...base, key: `k${i}`, event_id: `$e${i}`, ts: now - (30 - i) * min, body: '', ...over }; };
    const longText = Array.from({ length: 300 }, (_, k) => `bed${k}`).join(' ') + ' ' + longEnd;
    w.__thread = [
      m({ body: 'The menu is at https://example.com/menu, see you at noon.' }),
      m({ body: 'not a link: javascript:alert(1) or file:///etc/passwd' }),
      m({ kind: 'media', body: 'Voice message (0:02)', media: media({ kind: 'voice', name: 'Voice message.ogg', mime: 'audio/wav', size: tone.byteLength, duration_ms: 2000 }) }),
      m({ kind: 'media', body: 'Photo: seedlings.png', media: media({ kind: 'image', name: 'seedlings.png', mime: 'image/png', size: picture.byteLength, width: 640, height: 480, caption: 'Seedlings by the window' }) }),
      m({ kind: 'media', body: 'File: planting-plan.pdf', media: media({ kind: 'file', name: 'planting-plan.pdf', size: 3.4 * 1024 * 1024 }) }),
      m({ kind: 'media', body: 'Photo: drawing.svg', media: media({ kind: 'image', name: 'drawing.svg', size: 900 }) }),
      m({ body: longText }),
      m({ own: true, sender: '@pat:example.org', sender_name: 'Pat', state: 'sent', body: 'Saturday works.', reply: { event_id: '$e1', sender_name: 'Robin', text: 'The menu is at https://example.com/menu, see you at noon.' },
        reactions: [{ key: '🌱', count: 2, own: true }, { key: '👍', count: 1, own: false }] }),
      m({ kind: 'media', body: 'Voice message (0:02)', media: media({ kind: 'voice', name: 'Voice message.ogg', mime: 'audio/wav', size: tone.byteLength, duration_ms: 2000 }) }),
    ];
    const callbacks = new Map<number, (e: unknown) => void>();
    const listeners = new Map<number, { event: string; handler: number }>();
    let nextId = 1;
    w.__push = (payload: unknown) => { for (const [id, l] of listeners) if (l.event === 'messages://update') callbacks.get(l.handler)?.({ event: l.event, id, payload }); };
    const me = { user_id: '@pat:example.org', homeserver: 'https://matrix.example.org', error: null };
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: (cb: (e: unknown) => void) => { const id = nextId++; callbacks.set(id, cb); return id; },
      invoke: async (cmd: string, args: any) => {
        w.__calls.push({ cmd, args });
        switch (cmd) {
          case 'messages_status': return w.__signedOut ? { state: 'signed_out', user_id: null, homeserver: null, error: null } : { state: 'live', ...me };
          // the core starts syncing as it signs in, and says "live" (on a change only) before its answer is back
          case 'messages_sign_in': w.__signedOut = false; w.__push({ kind: 'status', status: { state: 'live', ...me } }); await new Promise((r) => setTimeout(r, 150)); return { state: 'connecting', ...me };
          case 'messages_rooms': return w.__rooms;
          case 'messages_open': return args.roomId === R ? w.__thread : [m({ body: 'Thanks!', sender_name: 'Kit' })];
          case 'messages_media': {
            const row = w.__thread.find((r: any) => r.event_id === args.eventId);
            await new Promise((r) => setTimeout(r, 50));
            return row?.media?.kind === 'image' ? picture.slice(0) : tone.slice(0);
          }
          case 'messages_transcript': {
            await new Promise((r) => setTimeout(r, 80));
            if (w.__failWords) { w.__failWords = false; throw { kind: 'unreachable', message: 'Transcription is away.' }; }
            return { text: args.eventId === '$e3' ? words : 'See you soon.' };
          }
          case 'messages_open_file': case 'open_link': case 'messages_close': case 'messages_read': return null;
          case 'messages_links': return [];
          case 'plugin:event|listen': { const id = nextId++; listeners.set(id, { event: args.event, handler: args.handler }); return id; }
          case 'plugin:event|unlisten': listeners.delete(args.eventId); return null;
          case 'identity_status': return { paired: true, pubkey: 'a'.repeat(64) };
          case 'get_identity': return 'a'.repeat(64);
          case 'get_rooms': case 'get_messages': case 'get_members': case 'vault_paths': case 'journal_pending': case 'journal_list': case 'vault_list': return [];
          case 'journal_flush': return { sent: [], remaining: 0, error: null };
          case 'journal_config': return { hub: 'https://example.invalid', vault: 'uni' };
          case 'refresh': return { pubkey: 'a'.repeat(64), total_items: 0, channel_errors: {}, truncated_channels: [] };
          default: return null;
        }
      },
    };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_event: string, id: number) => listeners.delete(id) };
  }, [PNG, WORDS, LONG_END, signedOut] as const);
  await page.goto('/');
  if (signedOut) return;
  await page.getByRole('navigation', { name: 'Conversations' }).getByRole('button', { name: /Robin Vale/ }).click({ timeout: 15_000 });
  await expect(log(page).getByText('Saturday works.')).toBeVisible();
}

const log = (page: Page) => page.getByRole('log', { name: 'Messages with Robin Vale' });
const msg = (page: Page, event: string) => log(page).locator(`[data-event="${event}"]`);
const calls = (page: Page, cmd: string) => page.evaluate((c) => (window as any).__calls.filter((x: any) => x.cmd === c).map((x: any) => x.args), cmd);

test('a link in a message opens in the system browser; nothing but a web link is one', async ({ page }) => {
  await boot(page);
  const link = msg(page, '$e1').getByRole('link', { name: 'https://example.com/menu' });
  await expect(link).toHaveAttribute('href', 'https://example.com/menu');
  // the comma after it is the sentence's, and the words are as sent
  await expect(msg(page, '$e1').locator('.msgs-body')).toHaveText('The menu is at https://example.com/menu, see you at noon.');
  await link.click();
  expect(await calls(page, 'open_link')).toEqual([{ url: 'https://example.com/menu' }]);
  // the page itself didn't go anywhere
  await expect(log(page)).toBeVisible();
  await expect(msg(page, '$e2').getByRole('link')).toHaveCount(0);
});

test('a voice message plays inline, scrubs, and shows its words under it, asked for once', async ({ page }) => {
  await boot(page);
  const voice = msg(page, '$e3');
  await expect(voice.getByRole('button', { name: 'Play voice message, 0:02' })).toBeAttached();
  // the conversation opens at its end; a voice message is transcribed once it comes on screen, not before
  expect((await calls(page, 'messages_transcript')).filter((a: any) => a.eventId === '$e3')).toHaveLength(0);
  await voice.scrollIntoViewIfNeeded();
  // and then without a tap
  await expect(voice.getByText(WORDS)).toBeVisible();
  // the clip is fetched on the first play, not before
  expect((await calls(page, 'messages_media')).filter((a: any) => a.eventId === '$e3')).toHaveLength(0);
  await voice.getByRole('button', { name: /^Play voice message/ }).click();
  await expect(voice.getByRole('button', { name: 'Pause voice message' })).toBeVisible();
  await expect.poll(() => voice.locator('audio').evaluate((a: HTMLAudioElement) => a.currentTime), { timeout: 5_000 }).toBeGreaterThan(0.2);
  await voice.getByRole('button', { name: 'Pause voice message' }).click();
  await expect(voice.getByRole('button', { name: /^Play voice message/ })).toBeVisible();
  // scrubbing moves the clip
  await voice.getByRole('slider', { name: 'Position in voice message' }).fill('1.5');
  await expect.poll(() => voice.locator('audio').evaluate((a: HTMLAudioElement) => a.currentTime)).toBeGreaterThan(1.4);
  await expect(voice.locator('.msgs-time')).toHaveText('0:01 / 0:02');
  // the second voice message starting stops the first
  await voice.getByRole('button', { name: /^Play voice message/ }).click();
  const second = msg(page, '$e9');
  await second.scrollIntoViewIfNeeded();
  await second.getByRole('button', { name: /^Play voice message/ }).click();
  await expect(second.getByRole('button', { name: 'Pause voice message' })).toBeVisible();
  await expect(voice.getByRole('button', { name: /^Play voice message/ })).toBeVisible();
  // leaving the conversation and coming back: the words are known, not asked for again; the clip isn't fetched again
  const narrow = (page.viewportSize()?.width ?? 0) < 700;
  const nav = page.getByRole('navigation', { name: 'Conversations' });
  if (narrow) await page.getByRole('button', { name: '← Conversations' }).click();
  await nav.getByRole('button', { name: /Kit Sample/ }).click();
  await expect(page.getByRole('log', { name: 'Messages with Kit Sample' })).toBeVisible();
  if (narrow) await page.getByRole('button', { name: '← Conversations' }).click();
  await nav.getByRole('button', { name: /Robin Vale/ }).click();
  await expect(msg(page, '$e3').getByText(WORDS)).toBeVisible();
  expect((await calls(page, 'messages_transcript')).filter((a: any) => a.eventId === '$e3')).toHaveLength(1);
  await msg(page, '$e3').getByRole('button', { name: /^Play voice message/ }).click();
  await expect(msg(page, '$e3').getByRole('button', { name: 'Pause voice message' })).toBeVisible();
  expect((await calls(page, 'messages_media')).filter((a: any) => a.eventId === '$e3')).toHaveLength(1);
});

test('a transcript that fails says so and can be asked for again', async ({ page }) => {
  await page.addInitScript(() => { (window as any).__failWords = true; });
  await boot(page);
  // which of the two voice messages asks first is the layout's; one of them fails once
  await msg(page, '$e3').scrollIntoViewIfNeeded();
  const failed = log(page).locator('.msgs-words', { hasText: 'No transcript: Transcription is away.' });
  await expect(failed).toBeVisible();
  await failed.getByRole('button', { name: 'Try again' }).click();
  await expect(log(page).getByText('No transcript')).toHaveCount(0);
  await expect(msg(page, '$e3').getByText(WORDS)).toBeVisible();
  await msg(page, '$e9').scrollIntoViewIfNeeded();
  await expect(msg(page, '$e9').getByText('See you soon.')).toBeVisible();
});

test('a picture shows in its shape and opens large; a file opens; an SVG is only ever a file', async ({ page }) => {
  await boot(page);
  const photo = msg(page, '$e4').getByRole('button', { name: 'Photo: Seedlings by the window. Open large' });
  await photo.scrollIntoViewIfNeeded();
  await expect.poll(() => photo.locator('img').evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBe(64);
  // its box keeps the picture's 4:3 shape
  const box = (await photo.boundingBox())!;
  expect(Math.abs(box.width / box.height - 4 / 3)).toBeLessThan(0.05);
  await expect(msg(page, '$e4').getByText('Seedlings by the window')).toBeVisible();
  await photo.click();
  const large = page.getByRole('dialog', { name: 'Photo: Seedlings by the window' });
  await expect(large).toBeVisible();
  await expect(large.getByRole('button', { name: 'Close' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(large).toHaveCount(0);

  const file = msg(page, '$e5');
  await expect(file).toContainText('planting-plan.pdf');
  await expect(file).toContainText('PDF · 3.4 MB');
  await file.getByRole('button', { name: 'Open planting-plan.pdf' }).click();
  expect(await calls(page, 'messages_open_file')).toEqual([{ roomId: '!robin:example.org', eventId: '$e5' }]);

  // declared as an image, but the core didn't pass its type (it's SVG): a file card, no <img>, and its bytes never fetched
  const svg = msg(page, '$e6');
  await expect(svg.getByRole('button', { name: 'Open drawing.svg' })).toBeVisible();
  await expect(svg.locator('img')).toHaveCount(0);
  expect((await calls(page, 'messages_media')).filter((a: any) => a.eventId === '$e6')).toHaveLength(0);
});

test('a reply quotes what it answers and goes to it; reactions sit under the bubble; a long message folds', async ({ page }) => {
  await boot(page);
  const reply = msg(page, '$e8');
  const quote = reply.getByRole('button', { name: /^In reply to Robin/ });
  await expect(quote).toContainText('The menu is at https://example.com/menu');
  await quote.click();
  await expect(msg(page, '$e1')).toHaveClass(/marked/);
  await expect(msg(page, '$e1')).toBeInViewport();
  const reactions = reply.getByRole('list', { name: 'Reactions' }).getByRole('listitem');
  await expect(reactions).toHaveText(['🌱 2', '👍']);
  await expect(reactions.first()).toHaveAccessibleName('🌱, 2 people, you too');
  await expect(reactions.first()).toHaveClass(/own/);

  const long = msg(page, '$e7');
  await long.scrollIntoViewIfNeeded();
  await expect(long.getByText(LONG_END)).toHaveCount(0);
  await long.getByRole('button', { name: 'Read more' }).click();
  await expect(long.getByText(LONG_END, { exact: false })).toBeVisible();
  await expect(long.getByRole('button', { name: 'Read more' })).toHaveCount(0);
  // nothing in the conversation is wider than the screen
  const overflow = await log(page).evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test('signing in: a "live" that arrives before the sign-in answer is not undone by it', async ({ page }) => {
  await boot(page, true);
  const form = page.getByRole('form', { name: 'Sign in to Messages' });
  await form.getByLabel('Homeserver').fill('https://matrix.example.org');
  await form.getByLabel('Username').fill('pat');
  await form.getByLabel('Password').fill('made-up-password');
  await form.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Conversations' }).getByRole('button', { name: /Robin Vale/ })).toBeVisible();
  // nothing more will come: the core sends a status only when it changes
  await page.waitForTimeout(500);
  await expect(page.locator('.msgs-live')).toHaveText('LIVE');
});

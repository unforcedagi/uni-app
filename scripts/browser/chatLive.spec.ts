import { expect, test, type Page } from '@playwright/test';

// T-132: Uni's gateway puts 👀 on the message it took, then is silent until it answers. The chat shows "Uni is working · m:ss" from that 👀
// until the reply; and a reader scrolled up gets a button back to the newest message that counts what came in meanwhile. Synthetic data only.
const ME = 'a'.repeat(64), UNI = 'b'.repeat(64);

async function boot(page: Page, opts: { history?: number; eyes?: boolean } = {}) {
  await page.addInitScript(({ ME, UNI, history, eyes }) => {
    const w = window as any;
    localStorage.setItem('uni.tabs.v1', JSON.stringify({ v: 1, tabs: [{ id: 'room', kind: 'room', channel: 'uni-room', title: 'Uni' }], active: 'room', recent: ['room'] }));
    const now = Math.floor(Date.now() / 1000);
    let n = 0;
    const msg = (author: string, ago: number, body: string, extra: Record<string, unknown> = {}) => ({ ref: `m${++n}`, channel: 'uni-room', author, author_name: author === ME ? 'Robin' : 'Uni', ts: now - ago, body, mentions_me: false, root: null, parent: null, mentions: [], reply_count: 0, last_reply_ts: null, edited: false, reactions: [], ...extra });
    w.__msgs = [];
    for (let i = history; i > 0; i--) w.__msgs.push(msg(i % 2 ? UNI : ME, 600 + i * 60, `Earlier note number ${i}: a line about the garden beds and the watering rota, long enough to wrap on a phone.`));
    w.__msgs.push(msg(ME, 42, 'Could you sort the seed list by sowing month?', eyes ? { reactions: [{ emoji: '👀', count: 1, mine: null, by: [{ pubkey: UNI, ts: now - 40 }] }] } : {}));
    w.__cbs = []; w.__listeners = {};
    w.__live = (payload: any) => { for (const h of w.__listeners['uni://live'] ?? []) w.__cbs[h]?.({ event: 'uni://live', id: 1, payload }); };
    w.__say = (author: string, body: string) => { const m = msg(author, 0, body); w.__msgs.push(m); w.__live({ kind: 'message', channel: 'uni-room', author }); return m.ref; };
    w.__eyes = (ref: string) => { const m = w.__msgs.find((x: any) => x.ref === ref); m.reactions = [{ emoji: '👀', count: 1, mine: null, by: [{ pubkey: UNI, ts: Math.floor(Date.now() / 1000) }] }]; w.__live({ kind: 'delete', channel: 'uni-room' }); };
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: (cb: any) => { w.__cbs.push(cb); return w.__cbs.length - 1; },
      invoke: async (cmd: string, args: any) => {
        switch (cmd) {
          case 'plugin:event|listen': (w.__listeners[args.event] ??= []).push(args.handler); return args.handler;
          case 'identity_status': return { paired: true, pubkey: ME };
          case 'get_identity': return ME;
          case 'get_npub': return 'test';
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
  }, { ME, UNI, history: opts.history ?? 2, eyes: opts.eyes ?? true });
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'Message Uni' })).toBeVisible();
  await expect(page.getByText('Could you sort the seed list by sowing month?')).toBeVisible();
}

const working = (page: Page) => page.locator('.working-line');
const seconds = (text: string | null) => { const [m, s] = (text ?? '').split(' · ')[1].split(':').map(Number); return m * 60 + s; };

test('Uni is working · m:ss from its 👀 on your message, through a progress ping, until its reply', async ({ page }) => {
  await boot(page);
  await expect(working(page)).toBeVisible();
  // counted from the 👀 (40 s before the room opened)
  await expect(working(page)).toHaveText(/^Uni is working · \d+:\d\d$/);
  expect(seconds(await working(page).textContent())).toBeGreaterThanOrEqual(40);
  await expect(working(page)).toHaveAttribute('role', 'status');
  // the clock runs
  const first = await working(page).textContent();
  await expect.poll(() => working(page).textContent(), { timeout: 4000 }).not.toBe(first);
  // it sits under the last message, in sight
  await expect(working(page)).toBeInViewport();
  // a progress ping is not the answer
  await page.evaluate(() => (window as any).__say('b'.repeat(64), '⏳ Working — 3 min — iteration 4/90, terminal'));
  await expect(page.getByText('⏳ Working — 3 min')).toBeVisible();
  await expect(working(page)).toBeVisible();
  // the reply is
  await page.evaluate(() => (window as any).__say('b'.repeat(64), 'Here is the list, sorted by sowing month.'));
  await expect(page.getByText('Here is the list, sorted by sowing month.')).toBeVisible();
  await expect(working(page)).toHaveCount(0);
});

test('no 👀 yet: no working line; it shows as the 👀 lands, counted from the 👀 and not from the message 42 s before', async ({ page }) => {
  await boot(page, { eyes: false });
  await page.waitForTimeout(1200);
  await expect(working(page)).toHaveCount(0);
  await page.evaluate(() => (window as any).__eyes((window as any).__msgs.at(-1).ref));
  await expect(working(page)).toHaveText(/^Uni is working · \d+:\d\d$/);
  expect(seconds(await working(page).textContent())).toBeLessThan(15);
});

test('scrolled up: Jump to latest, counting what came in; a tap goes to the newest', async ({ page }) => {
  await boot(page, { history: 60, eyes: false });
  const list = page.getByRole('log', { name: 'Messages' });
  const jump = page.getByRole('button', { name: /^Jump to latest/ });
  await expect(jump).toHaveCount(0);
  // the reader scrolls up on purpose
  await list.hover();
  await page.mouse.wheel(0, -4000);
  await expect(jump).toBeVisible();
  await expect(jump).toHaveAccessibleName('Jump to latest');
  // two messages arrive while they read back: the button counts them and the list stays where they were
  const top = await list.evaluate((el) => el.scrollTop);
  await page.evaluate(() => { (window as any).__say('b'.repeat(64), 'First of two new lines.'); (window as any).__say('b'.repeat(64), 'Second of two new lines.'); });
  await expect(jump).toHaveAccessibleName('Jump to latest, 2 new messages');
  await expect(jump).toHaveText(/2 new messages/);
  expect(Math.abs((await list.evaluate((el) => el.scrollTop)) - top)).toBeLessThan(4);
  await jump.click();
  await expect(page.getByText('Second of two new lines.')).toBeInViewport();
  // the tap takes no focus, so the phone's bottom bar stays (focus in the composer hides it, moving the button from under the finger)
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  await expect.poll(() => list.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(2);
  await expect(jump).toHaveCount(0);
  // following the end again: the next message glides in, no button
  await page.evaluate(() => (window as any).__say('b'.repeat(64), 'A third line, read as it lands.'));
  await expect(page.getByText('A third line, read as it lands.')).toBeInViewport();
  await expect(jump).toHaveCount(0);
  // up again: a message in the same second as the last one seen still counts as new
  await page.waitForTimeout(800);
  await list.hover();
  await page.mouse.wheel(0, -4000);
  await expect(jump).toHaveAccessibleName('Jump to latest');
  await page.evaluate(() => (window as any).__say('b'.repeat(64), 'A fourth line, in the same second.'));
  expect(await page.evaluate(() => { const m = (window as any).__msgs; return m.at(-1).ts === m.at(-2).ts; })).toBe(true); // __say stamps the boot second
  await expect(jump).toHaveAccessibleName('Jump to latest, 1 new message');
});

test('following the newest message, the list stays at it when it gets shorter (a bar arriving above it, a smaller window)', async ({ page }) => {
  await boot(page, { history: 30 });
  const list = page.getByRole('log', { name: 'Messages' });
  const fromEnd = () => list.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  await expect.poll(fromEnd).toBeLessThan(2);
  await page.waitForTimeout(1800); // past the open's settling, when only the reader's own scrolling or the follow keeps it there
  // the window gets 160 px shorter (a phone's keyboard opening, a bar arriving): no content moved
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: size.width, height: size.height - 160 });
  await expect.poll(fromEnd).toBeLessThan(2);
  await expect(working(page)).toBeInViewport();
  await expect(page.getByRole('button', { name: /^Jump to latest/ })).toHaveCount(0);
});

test('scrolled up, then away and back: the room reopens at its newest, with no Jump to latest', async ({ page }) => {
  await boot(page, { history: 60, eyes: false });
  const list = page.getByRole('log', { name: 'Messages' });
  const jump = page.getByRole('button', { name: /^Jump to latest/ });
  await list.hover();
  await page.mouse.wheel(0, -4000);
  await expect(jump).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await nav.getByRole('button', { name: 'Journal' }).click();
  await expect(list).toHaveCount(0);
  await nav.getByRole('button', { name: 'Uni' }).click();
  await expect(page.getByText('Could you sort the seed list by sowing month?')).toBeInViewport();
  await page.waitForTimeout(2000);
  await expect(jump).toHaveCount(0);
});

test('Uni silent for over an hour with no progress ping: the working line lets go on its own', async ({ page }) => {
  await page.clock.install();
  await boot(page);
  await expect(working(page)).toBeVisible();
  await page.clock.fastForward('01:01:00');
  await expect(working(page)).toHaveCount(0);
});

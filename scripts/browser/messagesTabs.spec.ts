// T-310: Messages grouped as tabs. All (every conversation, newest first), then one tab per network that is linked or
// has conversations, each with how many conversations wait for you; "Link another network" quietly at the end. The
// device remembers its tab. A phone scrolls the tabs sideways above the list; the Daylight and a desktop show them all
// in one row. Messages' door is faked here with made-up people (no homeserver); the grouping itself is the app's.
// Run: npx playwright test --config playwright.messagestabs.config.ts
import { expect, test, type Page } from '@playwright/test';

/** The app's Tauri IPC with Messages' door faked: signed in, seven conversations on five networks, sent out of order
 * (the app sorts them), and the Link screen's cards. `__push` sends a live update, as the core does. */
async function boot(page: Page, before?: () => void) {
  await page.addInitScript(() => {
    const w = window as any;
    localStorage.setItem('uni.tabs.v1', JSON.stringify({ v: 1, tabs: [{ id: 'messages', kind: 'messages', title: 'Messages' }], active: 'messages', recent: ['messages'] }));
    localStorage.setItem('uni.messages.seen.v1', '1');
    const now = Date.now(), min = 60_000;
    const room = (id: string, name: string, network: string, ago: number, preview: string | null, over: object = {}) =>
      ({ id: `!${id}:example.org`, name, preview, preview_own: false, ts: now - ago * min, unread: 0, encrypted: true, invited: false, inviter: null, direct: true, network, ...over });
    w.__rooms = [
      room('book', 'Book club', 'signal', 120, 'Chapter four for Thursday', { direct: false }),
      room('jun', 'Jun Park', 'telegram', 180, 'Photo'),
      room('robin', 'Robin Vale', 'signal', 5, 'Running ten minutes late', { unread: 1 }),
      room('bakery', 'Corner Bakery', 'gmessages', 30, 'Your order is ready', { encrypted: false }),
      room('allot', 'Allotment group', 'whatsapp', 1440, 'The tomatoes are in', { direct: false }),
      room('sam', 'Sam Example', 'matrix', 10, null, { invited: true, inviter: 'Sam Example' }),
      room('mara', 'Mara Quill', 'whatsapp', 1, 'Can you bring the folding chairs?', { unread: 2 }),
    ];
    const card = (network: string, name: string, state: string, rev = 1) => ({ network, name, state, accounts: [], step: null, note: null, rev });
    w.__links = [card('signal', 'Signal', 'linked'), card('telegram', 'Telegram', 'needs_attention'), card('whatsapp', 'WhatsApp', 'linked'),
      card('gmessages', 'Google Messages', 'linked'), card('messenger', 'Messenger', 'not_linked'), card('instagram', 'Instagram', 'unavailable')];
    const callbacks = new Map<number, (e: unknown) => void>();
    const listeners = new Map<number, { event: string; handler: number }>();
    let nextId = 1;
    w.__push = (payload: unknown) => { for (const [id, l] of listeners) if (l.event === 'messages://update') callbacks.get(l.handler)?.({ event: l.event, id, payload }); };
    const line = (i: number, roomId: string) => ({ key: `${roomId}-${i}`, event_id: `$${roomId}-${i}`, sender: '@someone:example.org', sender_name: 'Someone', own: false, ts: now - (5 - i) * min, kind: 'text', body: `Line ${i + 1}`, state: 'remote', encrypted: true, edited: false });
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: (cb: (e: unknown) => void) => { const id = nextId++; callbacks.set(id, cb); return id; },
      invoke: async (cmd: string, args: any) => {
        switch (cmd) {
          case 'messages_status': return { state: 'live', user_id: '@pat:example.org', homeserver: 'https://matrix.example.org', error: null };
          case 'messages_rooms': return w.__rooms;
          case 'messages_sign_out': return { state: 'signed_out', user_id: null, homeserver: null, error: null };
          case 'messages_sign_in_device': return { state: 'live', user_id: '@lee:example.org', homeserver: 'https://matrix.example.org', error: null };
          case 'messages_open': return Array.from({ length: 4 }, (_, i) => line(i, args.roomId));
          case 'messages_links': w.__linkReads = (w.__linkReads ?? 0) + 1; return w.__links;
          case 'messages_link_check': return w.__links.find((l: any) => l.network === args.network);
          // a send can be held, to fail later (w.__failSend()), as one on its way when the account ends
          case 'messages_send': return w.__holdSends ? new Promise((_, no) => { w.__failSend = () => no({ kind: 'unreachable', message: 'The homeserver went away.' }); }) : null;
          case 'messages_close': case 'messages_read': return null;
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
  });
  // a test's own changes to the made-up world, before the app starts
  if (before) await page.addInitScript(before);
  await page.goto('/');
  await expect(tablist(page).or(page.getByText('No conversations yet.')).first()).toBeVisible({ timeout: 15_000 });
}

const tablist = (page: Page) => page.getByRole('tablist', { name: 'Networks' });
const tab = (page: Page, name: string) => tablist(page).getByRole('tab', { name: new RegExp(`^${name}(,|$)`) });
const list = (page: Page) => page.getByRole('navigation', { name: 'Conversations' });
const names = (page: Page) => list(page).locator('.msgs-row-name');
const phone = (page: Page) => (page.viewportSize()?.width ?? 0) < 700;

test('All, then one tab per linked network in a fixed order, each with how many conversations wait', async ({ page }) => {
  await boot(page);
  // Messenger and Instagram aren't linked and have nothing: no tab. Telegram's link needs doing again: its "!".
  await expect(tablist(page).getByRole('tab')).toHaveText([/^All\s*3$/, /^Signal\s*1$/, /^Telegram\s*!$/, /^WhatsApp\s*1$/, /^SMS$/, /^Matrix\s*1$/]);
  await expect(tab(page, 'All')).toHaveAttribute('aria-selected', 'true');
  await expect(tab(page, 'WhatsApp')).toHaveAccessibleName('WhatsApp, 1 new'); // Mara's two messages are one conversation
  // All: every conversation, newest first, each with its network's word
  await expect(names(page)).toHaveText(['Mara Quill', 'Robin Vale', 'Sam Example', 'Corner Bakery', 'Book club', 'Jun Park', 'Allotment group']);
  await expect(list(page).locator('.msgs-net')).toHaveText(['WA', 'SIG', 'MX', 'SMS', 'SIG', 'TG', 'WA']);
  // "Link another network" is the strip's last thing
  const link = page.getByRole('button', { name: 'Link another network' });
  const [last, linkBox] = [await tab(page, 'Matrix').boundingBox(), await link.boundingBox()];
  expect(linkBox!.x).toBeGreaterThan(last!.x + last!.width - 1);
});

test('a tab shows its network only, newest first, without the network words; the device keeps the tab', async ({ page }) => {
  await boot(page);
  await tab(page, 'Signal').click();
  await expect(tab(page, 'Signal')).toHaveAttribute('aria-selected', 'true');
  await expect(names(page)).toHaveText(['Robin Vale', 'Book club']);
  await expect(list(page).locator('.msgs-net')).toHaveCount(0);
  await tab(page, 'WhatsApp').click();
  await expect(names(page)).toHaveText(['Mara Quill', 'Allotment group']);
  // the app is closed and opened again: the same tab
  await page.reload();
  await expect(tab(page, 'WhatsApp')).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });
  await expect(names(page)).toHaveText(['Mara Quill', 'Allotment group']);
  await expect(tab(page, 'WhatsApp')).toBeInViewport();
});

test('the tabs fit their screen: one row on the Daylight and a desktop; a phone scrolls them sideways', async ({ page }) => {
  await boot(page);
  const strip = page.locator('.msgs-tabs');
  const tabs = tablist(page).getByRole('tab');
  const tops = await tabs.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  expect(new Set(tops).size, 'every tab on one line').toBe(1);
  for (const box of await tabs.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))) expect(box).toBeGreaterThanOrEqual(40);
  const { scroll, client } = await strip.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  if (phone(page)) {
    expect(scroll, 'more tabs than a phone is wide: they scroll').toBeGreaterThan(client);
    // the page itself never scrolls sideways
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  } else {
    expect(scroll, 'all in sight, nothing to scroll').toBeLessThanOrEqual(client);
    await expect(page.getByRole('button', { name: 'Link another network' })).toBeInViewport({ ratio: 1 });
  }
});

test('a conversation from a tab, and back: the same tab, the same list; the composer names the network', async ({ page }) => {
  await boot(page);
  await tab(page, 'WhatsApp').click();
  await list(page).getByRole('button', { name: /Mara Quill/ }).click();
  const thread = page.getByRole('region', { name: 'Conversation: Mara Quill' });
  await expect(thread.getByRole('textbox', { name: 'Message Mara Quill on WhatsApp' })).toBeVisible();
  if (phone(page)) {
    // the conversation fills a phone; the tabs give way, and come back with the list
    await expect(tablist(page)).toBeHidden();
    await thread.getByRole('button', { name: '← Conversations' }).click();
  }
  await expect(tab(page, 'WhatsApp')).toHaveAttribute('aria-selected', 'true');
  await expect(names(page)).toHaveText(['Mara Quill', 'Allotment group']);
});

test('a link that needs doing again shows on its tab and in it; a network linked since gets its tab', async ({ page }) => {
  await boot(page);
  await page.getByRole('button', { name: 'Link another network' }).click();
  const screen = page.getByRole('region', { name: 'Link an account' });
  await expect(screen.getByRole('listitem', { name: 'Telegram', exact: true })).toContainText('NEEDS ATTENTION');
  await screen.getByRole('button', { name: '← Conversations' }).click();
  await expect(tab(page, 'Telegram')).toHaveAccessibleName('Telegram, needs linking again');
  await expect(tab(page, 'Telegram')).toContainText('!');
  await tab(page, 'Telegram').click();
  await expect(list(page).getByRole('note')).toHaveText(/Telegram needs linking again/);
  await list(page).getByRole('button', { name: 'Link again' }).click();
  await expect(screen).toBeVisible();
  // Instagram is linked while Messages is open (its card's update): its tab comes, empty until its chats arrive
  await page.evaluate(() => (window as any).__push({ kind: 'link', link: { network: 'instagram', name: 'Instagram', state: 'linked', accounts: [], step: null, note: null, rev: 2 } }));
  await screen.getByRole('button', { name: '← Conversations' }).click();
  await tab(page, 'Instagram').click();
  await expect(list(page)).toContainText('Nothing from Instagram yet.');
});

test('a message arriving moves its conversation up and counts on its tab and on All, live', async ({ page }) => {
  await boot(page);
  await tab(page, 'Signal').click();
  await page.evaluate(() => {
    const w = window as any;
    const rooms = w.__rooms.map((r: any) => (r.id === '!book:example.org' ? { ...r, ts: Date.now(), unread: 1, preview: 'Who has the snacks?' } : r));
    w.__push({ kind: 'rooms', rooms });
  });
  await expect(names(page)).toHaveText(['Book club', 'Robin Vale']);
  await expect(tab(page, 'Signal')).toHaveAccessibleName('Signal, 2 new');
  await expect(tab(page, 'All')).toHaveAccessibleName('All, 4 new');
});

test('signing out forgets the tab: the next sign-in starts on All', async ({ page }) => {
  await boot(page);
  await tab(page, 'WhatsApp').click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('button', { name: 'Sign in with this device' }).click();
  await expect(tab(page, 'All')).toHaveAttribute('aria-selected', 'true');
  await page.reload();
  await expect(tab(page, 'All')).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });
});

test('review tnli7wiq P2: how each link stands is asked as Messages opens, once, without opening the Link screen', async ({ page }) => {
  await boot(page);
  // Telegram's link needs doing again: its tab and the tab itself say so, though the Link screen was never opened
  await expect(tab(page, 'Telegram')).toHaveAccessibleName('Telegram, needs linking again');
  await tab(page, 'Telegram').click();
  await expect(list(page).getByRole('note')).toHaveText(/Telegram needs linking again/);
  // asked once on the way in, not on every render
  await tab(page, 'Signal').click(); await tab(page, 'All').click();
  expect(await page.evaluate(() => (window as any).__linkReads)).toBe(1);
  // Instagram linked elsewhere, nothing from it yet: coming back to Messages, it has its tab
  // (init scripts run in the order added: boot's has made the cards by now)
  await page.addInitScript(() => { const w = window as any; w.__links = w.__links.map((l: any) => (l.network === 'instagram' ? { ...l, state: 'linked' } : l)); });
  await page.reload();
  await tab(page, 'Instagram').click({ timeout: 15_000 });
  await expect(list(page)).toContainText('Nothing from Instagram yet.');
});

test('review tnli7wiq P1: a sign-out from the homeserver drops the drafts, a failed send\'s words, and the tab, as the Sign out button does', async ({ page }, info) => {
  await boot(page);
  const conv = (name: string) => page.getByRole('region', { name: `Conversation: ${name}` });
  const openConv = async (name: string) => {
    if (phone(page) && await page.getByRole('button', { name: '← Conversations' }).isVisible()) await page.getByRole('button', { name: '← Conversations' }).click();
    await list(page).getByRole('button', { name: new RegExp(name) }).click();
    await expect(conv(name)).toBeVisible();
  };
  await tab(page, 'WhatsApp').click();
  // a send to Mara is on its way when the account ends
  await page.evaluate(() => { (window as any).__holdSends = true; });
  await openConv('Mara Quill');
  const toMara = conv('Mara Quill').getByRole('textbox');
  await toMara.fill('Words that never went');
  if (info.project.use.hasTouch) await conv('Mara Quill').getByRole('button', { name: 'Send' }).click(); else await toMara.press('Enter');
  await expect(toMara).toHaveValue('');
  // and half a reply waits in another conversation
  await openConv('Allotment group');
  await conv('Allotment group').getByRole('textbox').fill('Half a reply about the shed');
  // the homeserver ends the session (another device signed it out, or the token was revoked)
  await page.evaluate(() => (window as any).__push({ kind: 'status', status: { state: 'signed_out', user_id: null, homeserver: null, error: null } }));
  await expect(page.getByRole('button', { name: 'Sign in with this device' })).toBeVisible();
  // the send fails only now
  await page.evaluate(() => { const w = window as any; w.__holdSends = false; w.__failSend(); });
  // someone signs in on this device: nothing of the last account's is there
  await page.getByRole('button', { name: 'Sign in with this device' }).click();
  await expect(tab(page, 'All')).toHaveAttribute('aria-selected', 'true');
  await openConv('Mara Quill');
  await expect(conv('Mara Quill').getByRole('textbox')).toHaveValue('');
  await openConv('Allotment group');
  await expect(conv('Allotment group').getByRole('textbox')).toHaveValue('');
});

test('review y6zqabu2: with no conversations yet, linked networks still have their tabs and a link to redo still says so', async ({ page }) => {
  await boot(page, () => { (window as any).__rooms = []; });
  await expect(tablist(page).getByRole('tab')).toHaveText([/^All$/, /^Signal$/, /^Telegram\s*!$/, /^WhatsApp$/, /^SMS$/]);
  // All: the link to redo, with its way to fix it; and no "Link an account" call, since apps are linked
  await expect(list(page).getByRole('note')).toHaveText(/Telegram needs linking again/);
  await expect(list(page)).toContainText('Chats from your linked apps show here as they come in.');
  await list(page).getByRole('button', { name: 'Link again' }).click();
  await expect(page.getByRole('region', { name: 'Link an account' })).toBeVisible();
  await page.getByRole('region', { name: 'Link an account' }).getByRole('button', { name: '← Conversations' }).click();
  await tab(page, 'Signal').click();
  await expect(list(page)).toContainText('Nothing from Signal yet.');
});

test('with no conversations and nothing linked, the first step is to link an account', async ({ page }) => {
  await boot(page, () => { const w = window as any; w.__rooms = []; w.__links = w.__links.map((l: any) => ({ ...l, state: 'not_linked' })); });
  await expect(list(page).getByRole('button', { name: 'Link an account' })).toBeVisible();
  await expect(tablist(page)).toHaveCount(0);
});

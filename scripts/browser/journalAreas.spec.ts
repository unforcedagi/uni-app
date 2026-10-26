import { expect, test, type Page } from '@playwright/test';

// T-263: after a journal entry is saved, a quiet "Send to an area?" row offers the area rooms as chips. Each tap posts one short
// message with the entry's link to that room, addressed to the room's Uni (Hermes in a group room wakes only on a mention); a room
// with no Uni gets the plain line. DMs, rooms of unknown kind and #Uni are not offered (archived rooms never reach the room list:
// the core drops them, see crates/uni-core/tests/mock_relay.rs). Dismissing posts nothing. Synthetic rooms, people and words only.
const ME = 'a'.repeat(64), UNI = 'b'.repeat(64), SAM = 'c'.repeat(64);
const HUB = 'https://hub.example.com', VAULT = 'demo';

type Post = { channel: string; body: string; recipients: string[] };

async function boot(page: Page, hub = HUB) {
  await page.addInitScript(({ ME, UNI, SAM, HUB, VAULT }) => {
    const w = window as any;
    localStorage.setItem('uni.tabs.v1', JSON.stringify({ v: 1, tabs: [{ id: 'j', kind: 'journal', title: 'Journal' }], active: 'j', recent: ['j'] }));
    w.__posts = []; w.__notes = []; w.__cbs = []; w.__listeners = {};
    const robin = { pubkey: ME, name: 'Robin', named: true }, uni = { pubkey: UNI, name: 'Uni', named: true }, sam = { pubkey: SAM, name: 'Sam', named: true };
    const rooms = [
      { id: 'uni-room', name: 'Uni', unread: 0, dm: false },
      { id: 'garden-room', name: 'garden', unread: 0, dm: false },
      { id: 'dm-room', name: 'DM', unread: 0, dm: true },
      { id: 'workshop-room', name: 'workshop', unread: 0, dm: false },
      { id: 'group-dm-room', name: 'Group DM (3)', unread: 0, dm: true },
      { id: 'library-room', name: 'library', unread: 0, dm: false },
      // kind not known yet (cached before the app knew DMs, or just joined), and a row from a list an older app cached: never offered
      { id: 'porch-room', name: 'porch', unread: 0, dm: null },
      { id: 'attic-room', name: 'attic', unread: 0 },
    ];
    w.__rooms = rooms;
    w.__live = () => { for (const h of w.__listeners['uni://live'] ?? []) w.__cbs[h]?.({ event: 'uni://live', id: 1, payload: { kind: 'rooms', channel: null, status: null, author: null } }); };
    const members: Record<string, unknown[]> = { 'uni-room': [robin, uni], 'garden-room': [robin, uni, sam], 'workshop-room': [robin, uni], 'library-room': [robin, sam], 'porch-room': [robin, uni], 'attic-room': [robin, uni], 'dm-room': [robin, sam], 'group-dm-room': [robin, sam, uni] };
    let n = 0;
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: (cb: any) => { w.__cbs.push(cb); return w.__cbs.length - 1; },
      invoke: async (cmd: string, args: any) => {
        switch (cmd) {
          case 'plugin:event|listen': (w.__listeners[args.event] ??= []).push(args.handler); return args.handler;
          case 'identity_status': return { paired: true, pubkey: ME };
          case 'get_identity': return ME;
          case 'get_npub': return 'test';
          case 'get_rooms': return JSON.parse(JSON.stringify(rooms));
          case 'get_messages': return [];
          case 'get_members': return members[args.channel] ?? [];
          case 'post_message': {
            // as the core does: the room list is ordered by the latest message
            rooms.unshift(...rooms.splice(rooms.findIndex((r) => r.id === args.channel), 1));
            w.__posts.push({ channel: args.channel, body: args.body, recipients: args.recipients });
            return { ref: `p${w.__posts.length}`, channel: args.channel, author: ME, author_name: 'Robin', ts: Math.floor(Date.now() / 1000), body: args.body, mentions_me: false, root: null, parent: null, mentions: [], reply_count: 0, last_reply_ts: null, edited: false, reactions: [] };
          }
          case 'journal_config': return { hub: HUB, vault: VAULT };
          case 'journal_save_text': {
            const e = args.entry;
            const id = `01JTESTNOTE${String(++n).padStart(4, '0')}`;
            w.__notes.unshift({ id, path: e.path, created_at: e.created_at, content: e.content, source: 'text', entry_id: e.entry_id, tags: ['journal'], pending: false });
            return { sent: [id], remaining: 0, error: null };
          }
          case 'journal_list': return w.__notes.slice(args.offset, args.offset + args.limit);
          case 'journal_entry': return w.__notes.find((x: any) => x.id === args.id);
          case 'journal_flush': return { sent: [], remaining: 0, error: null };
          case 'journal_pending': case 'vault_paths': case 'search_messages': case 'vault_search': case 'vault_tree': return [];
          case 'vault_list': return [VAULT];
          case 'refresh': return { pubkey: ME, total_items: 0, channel_errors: {}, truncated_channels: [] };
          default: return null;
        }
      },
    };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  }, { ME, UNI, SAM, HUB: hub, VAULT });
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'Journal entry' })).toBeVisible();
}

async function save(page: Page, words: string) {
  await page.getByRole('textbox', { name: 'Journal entry' }).fill(words);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const entry = page.locator('.journal-entry', { hasText: words });
  await expect(entry).toBeVisible();
  return entry;
}

const posts = (page: Page) => page.evaluate(() => (window as any).__posts as Post[]);
const link = (id: string) => `${HUB}/surface/parachute/v/${VAULT}/n/${id}`;

test('two area chips after a save post two messages, each with the link, addressed to that room\'s Uni', async ({ page }) => {
  await boot(page);
  const entry = await save(page, 'The bean rows came up overnight after the rain.');
  const offer = entry.getByRole('group', { name: 'Send to an area' });
  await expect(offer).toBeVisible();
  // only the area rooms: no DM, no group DM, not #Uni
  await expect(offer.getByRole('button', { name: /^Send to #/ })).toHaveText(['#garden', '#library', '#workshop']);
  // nothing is sent until a chip is tapped
  expect(await posts(page)).toEqual([]);

  await offer.getByRole('button', { name: 'Send to #garden' }).click();
  await expect(offer.getByRole('button', { name: '#garden, sent' })).toBeDisabled();
  await offer.getByRole('button', { name: 'Send to #workshop' }).click();
  await expect(offer.getByRole('button', { name: '#workshop, sent' })).toBeDisabled();
  // the chips keep their places while the room list reorders behind them
  await expect(offer.getByRole('button', { name: /^(Send to )?#/ })).toHaveText(['✓ #garden', '#library', '✓ #workshop']);

  const id = await page.evaluate(() => (window as any).__notes[0].id as string);
  const sent = await posts(page);
  expect(sent.map((p) => p.channel)).toEqual(['garden-room', 'workshop-room']);
  for (const p of sent) {
    expect(p.recipients).toEqual([UNI]);
    expect(p.body).toBe(`@Uni New journal entry.\n\n${link(id)}`);
  }
  // the tag names every room it went to; the row stays until dismissed and says so
  await expect(entry.locator('.queued-tag')).toHaveText('shared · garden, workshop');
  await offer.getByRole('button', { name: 'Done' }).click();
  await expect(offer).toHaveCount(0);
  expect(await posts(page)).toHaveLength(2);
});

test('a room with no Uni gets the plain line, with the link and no mention', async ({ page }) => {
  await boot(page);
  const entry = await save(page, 'Borrowed two books on pruning.');
  await entry.getByRole('button', { name: 'Send to #library' }).click();
  await expect(entry.getByRole('button', { name: '#library, sent' })).toBeVisible();
  const id = await page.evaluate(() => (window as any).__notes[0].id as string);
  const [p] = await posts(page);
  expect(p.channel).toBe('library-room');
  expect(p.recipients).toEqual([]);
  expect(p.body).toMatch(new RegExp(`^Journal entry · .+\\n\\n${link(id).replace(/[.]/g, '\\.')}$`));
  expect(p.body).not.toContain('@');
});

test('dismissing posts nothing, and the next save brings the offer back for the new entry only', async ({ page }) => {
  await boot(page);
  const first = await save(page, 'Quiet morning, nothing to report.');
  await first.getByRole('button', { name: 'Not now' }).click();
  await expect(page.getByRole('group', { name: 'Send to an area' })).toHaveCount(0);
  expect(await posts(page)).toEqual([]);
  await expect(first.locator('.queued-tag')).toHaveCount(0);

  const second = await save(page, 'Afternoon: fixed the gate latch.');
  await expect(second.getByRole('group', { name: 'Send to an area' })).toBeVisible();
  await expect(first.getByRole('group', { name: 'Send to an area' })).toHaveCount(0);
  expect(await posts(page)).toEqual([]);
});

test('the entry menu offers the same area rooms, and Pass to Uni still goes to #Uni', async ({ page }) => {
  await boot(page);
  const entry = await save(page, 'Notes on the compost temperature.');
  await entry.getByRole('button', { name: 'Not now' }).click();
  await entry.getByRole('button', { name: 'More for this entry' }).click();
  await entry.getByRole('button', { name: 'Share to a room…' }).click();
  const picker = entry.getByRole('group', { name: 'Choose a room' });
  await expect(picker.getByRole('button')).toHaveText(['#garden', '#library', '#workshop']);
  await picker.getByRole('button', { name: 'Send to #workshop' }).click();
  await expect(entry.locator('.queued-tag')).toHaveText('shared · workshop');

  await entry.getByRole('button', { name: 'More for this entry' }).click();
  await entry.getByRole('button', { name: 'Pass to Uni' }).click();
  await expect(entry.locator('.queued-tag')).toHaveText('shared · workshop, Uni');
  const sent = await posts(page);
  expect(sent.map((p) => p.channel)).toEqual(['workshop-room', 'uni-room']);
  expect(sent[1].recipients).toEqual([UNI]);
  expect(sent[1].body.startsWith("@Uni here's a journal entry.")).toBe(true);
});

test('with no hub set there is no link, so no room is offered and the entry\'s words are never posted', async ({ page }) => {
  await boot(page, '');
  const entry = await save(page, 'A private line that must stay in the journal.');
  await expect(entry.getByRole('group', { name: 'Send to an area' })).toHaveCount(0);
  await entry.getByRole('button', { name: 'More for this entry' }).click();
  await entry.getByRole('button', { name: 'Share to a room…' }).click();
  const picker = entry.getByRole('group', { name: 'Choose a room' });
  await expect(picker.getByRole('button')).toHaveCount(0);
  await expect(picker).toContainText('Set the Parachute hub');
  expect(await posts(page)).toEqual([]);
});

test('a room the core learns is a DM leaves the chips when the room list is told, and is checked again before a send', async ({ page }) => {
  await boot(page);
  const entry = await save(page, 'Moved the seed trays to the porch shelf.');
  const offer = entry.getByRole('group', { name: 'Send to an area' });
  await expect(offer.getByRole('button', { name: /^Send to #/ })).toHaveText(['#garden', '#library', '#workshop']);

  // the relay's metadata lands while the row is up: workshop is a DM; the live event re-reads the rooms
  await page.evaluate(() => { const w = window as any; w.__rooms.find((r: any) => r.id === 'workshop-room').dm = true; w.__live(); });
  await expect(offer.getByRole('button', { name: /^Send to #/ })).toHaveText(['#garden', '#library']);

  // the core knows before the screen does (no event yet): the tap is refused, nothing is posted, and the chip goes
  await page.evaluate(() => { (window as any).__rooms.find((r: any) => r.id === 'garden-room').dm = true; });
  await offer.getByRole('button', { name: 'Send to #garden' }).click();
  await expect(page.getByRole('alert')).toContainText("isn't an area room any more");
  await expect(offer.getByRole('button', { name: /^Send to #/ })).toHaveText(['#library']);
  expect(await posts(page)).toEqual([]);
  await expect(entry.locator('.queued-tag')).toHaveCount(0);
});

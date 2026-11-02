// T-305 interface platform spike: the Garden interface (interfaces/garden) reads rooms and sends a letter through the
// shell API only, steps aside on another shell API, and goes back to Uni. The shell is mocked; the real shell run is
// scripts/t305/iface-e2e-desktop.sh. Synthetic rooms and people.
import { expect, test, type Page } from '@playwright/test';

const SHOTS = process.env.GARDEN_SHOTS;

async function boot(page: Page, opts: { shellApi?: number; deny?: string[] } = {}) {
  await page.addInitScript(({ shellApi, deny }) => {
    const w = window as any;
    const now = Math.floor(Date.now() / 1000);
    const room = (id: string, name: string, ago: number, unread: number, last: string, mentions = false) => ({ id, name, last_message: last, last_ts: now - ago, mentions, unread });
    w.__rooms = [
      room('r-seeds', 'Seed Library', 300, 3, 'The beans came up overnight.'),
      room('r-walks', 'Night Walks', 1200, 1, 'Owls by the north gate again.', true),
      room('r-kitchen', 'Kitchen Table', 3600, 0, 'Soup on Thursday?'),
      room('r-shop', 'Workshop', 7200, 2, 'The bench vise is fixed.'),
      room('r-pond', 'Pond', 86400, 0, 'Frogspawn, finally.'),
    ];
    let n = 0;
    const letter = (channel: string, who: string, ago: number, body: string) => ({ ref: `l${++n}`, channel, author: who[0].repeat(64), author_name: who, ts: now - ago, body, mentions_me: false, root: null, parent: null, mentions: [], reply_count: 0, last_reply_ts: null, edited: false, reactions: [] });
    w.__letters = {
      'r-seeds': [letter('r-seeds', 'Maren', 5400, 'I left the squash seeds in the blue tin. Take what you need and write the variety on the lid.'), letter('r-seeds', 'Tobias', 900, 'Took six. Planting them by the fence where the light stays longest.'), letter('r-seeds', 'Ilse', 300, 'The beans came up overnight.')],
      'r-walks': [letter('r-walks', 'Juniper', 1200, 'Owls by the north gate again.')],
    };
    w.calls = [];
    w.__cbs = []; w.__listeners = {};
    w.__live = (payload: any) => { for (const h of w.__listeners['uni://live'] ?? []) w.__cbs[h]?.({ event: 'uni://live', id: 1, payload }); };
    w.__arrive = (channel: string, who: string, body: string) => {
      (w.__letters[channel] ??= []).push(letter(channel, who, 0, body));
      const r = w.__rooms.find((x: any) => x.id === channel); r.unread += 1; r.last_ts = Math.floor(Date.now() / 1000); r.last_message = body;
      w.__live({ kind: 'message', channel, status: null, author: who });
    };
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: (cb: any) => { w.__cbs.push(cb); return w.__cbs.length - 1; },
      invoke: async (cmd: string, args: any) => {
        w.calls.push({ cmd, args });
        const cap = ({ get_rooms: 'rooms.read', get_messages: 'rooms.read', refresh: 'rooms.read', mark_read: 'rooms.read', live_start: 'rooms.read', post_message: 'rooms.send' } as Record<string, string>)[cmd];
        if (cap && deny.includes(cap)) throw `not granted: ${cap} (interface garden)`;
        switch (cmd) {
          case 'plugin:event|listen': (w.__listeners[args.event] ??= []).push(args.handler); return args.handler;
          case 'ota_status': return { shell_api: shellApi, iface: 'garden', builtin: '0.1.84', active: { version: '0.1.0', api: 1 }, channel: null };
          case 'get_rooms': return JSON.parse(JSON.stringify(w.__rooms));
          case 'get_messages': return JSON.parse(JSON.stringify(w.__letters[args.channel] ?? []));
          case 'mark_read': { const r = w.__rooms.find((x: any) => x.id === args.channel); if (r) r.unread = 0; return null; }
          case 'post_message': { const l = letter(args.channel, 'Robin', 0, args.body); (w.__letters[args.channel] ??= []).push(l); return l; }
          case 'refresh': return { pubkey: 'a'.repeat(64), total_items: 0, channel_errors: {}, truncated_channels: [] };
          default: return null;
        }
      },
    };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  }, { shellApi: opts.shellApi ?? 1, deny: opts.deny ?? [] });
  await page.goto('/');
}

const place = (page: Page, name: string) => page.getByRole('button', { name: new RegExp(`^${name}`) });
const flies = (page: Page, id: string) => page.locator(`[data-room="${id}"] .fly`);
const shot = async (page: Page, name: string) => { if (SHOTS) await page.waitForTimeout(700), await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${name}.png` }); };

test('rooms grow as places; new letters are fireflies; the shell is told the bundle started', async ({ page }) => {
  await boot(page);
  for (const name of ['Seed Library', 'Night Walks', 'Kitchen Table', 'Workshop', 'Pond']) await expect(place(page, name)).toBeVisible();
  await expect(place(page, 'Seed Library')).toHaveAccessibleName('Seed Library, 3 new letters');
  await expect(flies(page, 'r-seeds')).toHaveCount(3);
  await expect(flies(page, 'r-pond')).toHaveCount(0);
  await expect(page.getByText('5 places, 3 with new letters')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).calls.map((c: any) => c.cmd))).toContain('ota_ready');
  await shot(page, '01-meadow');
});

test('a place opens to its letters, and a letter sent goes to that room through the shell', async ({ page }) => {
  await boot(page);
  await place(page, 'Seed Library').click();
  const letters = page.getByRole('region', { name: 'Letters in Seed Library' });
  await expect(letters.getByText('I left the squash seeds in the blue tin.', { exact: false })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).calls.filter((c: any) => c.cmd === 'mark_read').map((c: any) => c.args.channel))).toEqual(['r-seeds']);
  await expect(flies(page, 'r-seeds')).toHaveCount(0);
  await shot(page, '02-letters');
  await letters.getByRole('textbox', { name: 'Write a letter to Seed Library' }).fill('Saving two squash seeds for the spring swap.');
  await letters.getByRole('button', { name: 'Send letter' }).click();
  await expect(letters.getByText('Saving two squash seeds for the spring swap.')).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Sent to Seed Library.');
  const sent = await page.evaluate(() => (window as any).calls.filter((c: any) => c.cmd === 'post_message').map((c: any) => c.args));
  expect(sent).toEqual([{ channel: 'r-seeds', body: 'Saving two squash seeds for the spring swap.', replyTo: null, recipients: [] }]);
  await shot(page, '03-sent');
});

test('a letter arriving live adds a firefly to its place and shows in the open room', async ({ page }) => {
  await boot(page);
  await expect(flies(page, 'r-shop')).toHaveCount(2);
  await page.evaluate(() => (window as any).__arrive('r-shop', 'Ilse', 'Clamps are back on the wall.'));
  await expect(flies(page, 'r-shop')).toHaveCount(3);
  await place(page, 'Night Walks').click();
  await page.evaluate(() => (window as any).__arrive('r-walks', 'Juniper', 'Two owls tonight.'));
  await expect(page.getByRole('region', { name: 'Letters in Night Walks' }).getByText('Two owls tonight.')).toBeVisible();
});

test('Back to Uni asks the shell to switch interfaces', async ({ page }) => {
  await boot(page);
  await page.getByRole('button', { name: 'Back to Uni' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).calls.filter((c: any) => c.cmd === 'iface_use').map((c: any) => c.args))).toEqual([{ id: 'uni' }]);
});

test('a capability the person did not grant is said plainly, and the letter stays in the box', async ({ page }) => {
  await boot(page, { deny: ['rooms.send'] });
  await place(page, 'Pond').click();
  const box = page.getByRole('textbox', { name: 'Write a letter to Pond' });
  await box.fill('Is the frogspawn hatching?');
  await page.getByRole('button', { name: 'Send letter' }).click();
  await expect(page.getByRole('status')).toHaveText("This garden may not send letters. Allow it in Uni's settings.");
  await expect(box).toHaveValue('Is the frogspawn hatching?');
});

test('on a shell with another API the bundle steps aside before drawing anything', async ({ page }) => {
  await boot(page, { shellApi: 2 });
  await expect.poll(() => page.evaluate(() => (window as any).calls.map((c: any) => c.cmd))).toContain('ota_reject');
  await expect(page.getByRole('heading', { name: 'Garden' })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).calls.map((c: any) => c.cmd))).not.toContain('get_rooms');
});

import { test, expect, type Page } from '@playwright/test';

// T-234: Settings → Approvals on the real built frontend, with the Tauri backend faked. The fake stands in for Rust
// (`sealed_status`, `sealed_enroll`; the signing, the key and the relay are tested for real in uni-core: sealed.rs and
// tests/mock_relay.rs). Proves: nothing is posted without the confirm, Cancel posts nothing, a double press posts
// once, a relay failure says so and Try again posts, the webview never names the Uni key or any key to Rust, and the
// enrollment shows in the room as words, not JSON. Synthetic keys only.

const ME = 'a'.repeat(64);
const UNI = 'c'.repeat(64);
const SEAL = '5e'.repeat(32);
const now = () => Math.floor(Date.now() / 1000);
const msg = (ref: string, body: string, ts: number, author = UNI, name = 'Uni') => ({ ref, channel: 'test', author, author_name: name, ts, body,
  mentions_me: false, root: null, parent: null, mentions: [], reply_count: 0, last_reply_ts: null, edited: false, reactions: [] });

type Room = { id: string; name: string; members: number };
type Opts = { rooms?: Room[]; roomsLater?: Room[]; enrolled?: boolean; failures?: number; messages?: unknown[]; statusFails?: boolean; verified?: string[] };
async function boot(page: Page, o: Opts = {}) {
  await page.addInitScript(({ ME, UNI, SEAL, o, at }) => {
    const w = window as any;
    w.calls = [];
    w.failures = o.failures ?? 0;
    w.statusFails = !!o.statusFails;
    const record = { identity: ME, uni: UNI, seal_pub: SEAL, event_id: '9b13b2ae' + 'e'.repeat(56), channel: 'test', created_at: at };
    w.enrolled = o.enrolled ? record : null;
    let rooms = o.rooms ?? [{ id: 'test', name: 'Test room', members: 2 }];
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: () => 1,
      invoke: async (cmd: string, args: any) => {
        w.calls.push({ cmd, args });
        switch (cmd) {
          case 'identity_status': return { paired: true, pubkey: ME };
          case 'get_identity': return ME;
          case 'relay_origin': return 'https://example.invalid';
          case 'get_npub': return 'test';
          case 'get_rooms': return [{ id: 'test', name: 'Test room', unread: 0 }];
          case 'get_members': return [{ pubkey: UNI, name: 'Uni' }, { pubkey: ME, name: 'Robin' }];
          case 'get_messages': return o.messages ?? [];
          case 'vault_list': return [];
          case 'journal_config': return { hub: 'test' };
          case 'refresh': return { pubkey: ME, total_items: 0, channel_errors: {}, truncated_channels: [] };
          case 'secret_requesters': return [];
          case 'sealed_status':
            if (w.statusFails) { w.statusFails = false; throw 'identity: keyring locked'; }
            { const out = { uni: UNI, seal_pub: SEAL, rooms, enrolled: w.enrolled }; if (o.roomsLater) rooms = o.roomsLater; return out; }
          case 'sealed_enrollment_line': return (o.verified ?? []).includes(args.reference) ? ME : null;
          case 'sealed_enroll':
            await new Promise((r) => setTimeout(r, 400));
            if (w.failures > 0) { w.failures--; throw 'relay unreachable: connection refused'; }
            w.enrolled = { ...record, channel: args.channel };
            return w.enrolled;
          default: return null;
        }
      },
    };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  }, { ME, UNI, SEAL, o, at: now() });
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'Message Test room' })).toBeVisible();
}
// APPROVALS_SHOTS=<dir> also writes screenshots of the confirm and the enabled state there (synthetic data only).
const shot = async (page: Page, name: string) => { if (process.env.APPROVALS_SHOTS) await page.screenshot({ path: `${process.env.APPROVALS_SHOTS}/${test.info().project.name}-${name}.png` }); };
const calls = (page: Page) => page.evaluate(() => (window as any).calls as { cmd: string; args: any }[]);
const enrolls = async (page: Page) => (await calls(page)).filter((c) => c.cmd === 'sealed_enroll');
const settings = async (page: Page) => {
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Settings', exact: true }).click();
  const s = page.getByRole('region', { name: 'Approvals' });
  await s.scrollIntoViewIfNeeded();
  return s;
};

test('enable: one confirm, then the enrollment is posted once and Settings says approvals are on', async ({ page }) => {
  await boot(page);
  const s = await settings(page);
  await s.getByRole('button', { name: 'Enable approvals for Uni' }).click();
  const confirm = s.getByRole('group', { name: 'Enable approvals for Uni' });
  await expect(confirm).toBeVisible();
  await expect(confirm.getByText('Test room')).toBeVisible();
  await expect(confirm.getByText('cccc cccc cccc cccc')).toBeVisible();
  await expect(confirm.getByText('5e5e 5e5e 5e5e 5e5e')).toBeVisible();
  expect(await enrolls(page)).toHaveLength(0); // nothing until the confirm
  await shot(page, '01-confirm');
  await confirm.getByRole('button', { name: 'Enable approvals', exact: true }).click();
  await expect(confirm.getByRole('button', { name: 'Enabling…' })).toBeDisabled();
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  await expect(s.getByText('Approvals for Uni are on')).toBeVisible();
  await expect(s.getByText('9b13 b2ae')).toBeVisible();
  await shot(page, '02-enabled');
  await expect(s.getByRole('button', { name: /Enable approvals/ })).toHaveCount(0);
  // the webview names only the room: no Uni key, no identity, no seal key
  expect((await enrolls(page)).map((c) => c.args)).toEqual([{ channel: 'test' }]);
});

test('cancel: back to the start, nothing posted', async ({ page }) => {
  await boot(page);
  const s = await settings(page);
  await s.getByRole('button', { name: 'Enable approvals for Uni' }).click();
  await s.getByRole('group', { name: 'Enable approvals for Uni' }).getByRole('button', { name: 'Cancel' }).click();
  await expect(s.getByRole('group', { name: 'Enable approvals for Uni' })).toHaveCount(0);
  await expect(s.getByRole('button', { name: 'Enable approvals for Uni' })).toBeVisible();
  expect(await enrolls(page)).toHaveLength(0);
});

test('a double press posts once; once on, Settings offers no Enable again', async ({ page }) => {
  await boot(page);
  let s = await settings(page);
  await s.getByRole('button', { name: 'Enable approvals for Uni' }).click();
  // two presses in the same tick, before React has drawn "Enabling…"
  await s.getByRole('button', { name: 'Enable approvals', exact: true }).evaluate((b: HTMLButtonElement) => { b.click(); b.click(); });
  await expect(s.getByText('Approvals for Uni are on')).toBeVisible();
  expect(await enrolls(page)).toHaveLength(1);
  // Settings closed and opened again: the record comes from Rust, still no button
  await page.getByRole('button', { name: 'Close panel' }).click();
  s = await settings(page);
  await expect(s.getByText('Approvals for Uni are on')).toBeVisible();
  await expect(s.getByRole('button', { name: /Enable approvals/ })).toHaveCount(0);
  expect(await enrolls(page)).toHaveLength(1);
});

test('already enrolled at launch: the record, no button', async ({ page }) => {
  await boot(page, { enrolled: true });
  const s = await settings(page);
  await expect(s.getByText('Approvals for Uni are on')).toBeVisible();
  await expect(s.getByRole('button', { name: /Enable approvals/ })).toHaveCount(0);
});

test('relay failure: it says nothing was enabled, and Try again posts', async ({ page }) => {
  await boot(page, { failures: 1 });
  const s = await settings(page);
  await s.getByRole('button', { name: 'Enable approvals for Uni' }).click();
  const confirm = s.getByRole('group', { name: 'Enable approvals for Uni' });
  await confirm.getByRole('button', { name: 'Enable approvals', exact: true }).click();
  await expect(confirm.getByRole('alert')).toBeVisible();
  await shot(page, '03-failed');
  await expect(confirm.getByRole('alert')).toHaveText(/Couldn't post it: relay unreachable: connection refused\. Nothing was enabled\./);
  await expect(s.getByText('Approvals for Uni are on')).toHaveCount(0);
  await confirm.getByRole('button', { name: 'Try again' }).click();
  await expect(s.getByText('Approvals for Uni are on')).toBeVisible();
  expect((await enrolls(page)).map((c) => c.args)).toEqual([{ channel: 'test' }, { channel: 'test' }]);
});

test('no room shared with Uni: no button, and why; Check again finds the room once it has synced', async ({ page }) => {
  await boot(page, { rooms: [], roomsLater: [{ id: 'test', name: 'Test room', members: 2 }] });
  const s = await settings(page);
  await expect(s.getByText("You and Uni don't share a room yet")).toBeVisible();
  await expect(s.getByRole('button', { name: /Enable approvals/ })).toHaveCount(0);
  await s.getByRole('button', { name: 'Check again' }).click();
  await expect(s.getByRole('button', { name: 'Enable approvals for Uni' })).toBeVisible();
});

test('several rooms with Uni: the chosen one is where it is posted', async ({ page }) => {
  await boot(page, { rooms: [{ id: 'test', name: 'Test room', members: 2 }, { id: 'other', name: 'Other room', members: 3 }] });
  const s = await settings(page);
  await s.getByRole('button', { name: 'Enable approvals for Uni' }).click();
  const confirm = s.getByRole('group', { name: 'Enable approvals for Uni' });
  await confirm.getByLabel('Posted in').selectOption('other');
  await confirm.getByRole('button', { name: 'Enable approvals', exact: true }).click();
  await expect(s.getByText('Approvals for Uni are on')).toBeVisible();
  expect((await enrolls(page)).map((c) => c.args)).toEqual([{ channel: 'other' }]);
});

test('status failure: says so and checks again', async ({ page }) => {
  await boot(page, { statusFails: true });
  const s = await settings(page);
  await expect(s.getByText("Couldn't check approvals: identity: keyring locked")).toBeVisible();
  await s.getByRole('button', { name: 'Check again' }).click();
  await expect(s.getByRole('button', { name: 'Enable approvals for Uni' })).toBeVisible();
});

test('your verified enrollment shows in the room as words; a look-alike body stays an ordinary message', async ({ page }) => {
  const body = JSON.stringify({ v: 1, seal_pub: SEAL, for: UNI });
  const fake = JSON.stringify({ v: 1, seal_pub: 'ab'.repeat(32), for: 'cd'.repeat(32) });
  await boot(page, { verified: ['d'.repeat(64)], messages: [
    msg('d'.repeat(64), body, now() - 90, ME, 'Robin'),       // yours, verified in Rust
    msg('e'.repeat(64), fake, now() - 60, ME, 'Robin'),       // yours, but Rust says it isn't an enrollment for Uni
    msg('f'.repeat(64), body, now() - 30, 'b'.repeat(64), 'Mallory'), // another member's copy
  ] });
  await expect(page.getByText('You enabled approvals for Uni')).toHaveCount(1);
  await expect(page.locator('.message', { hasText: 'abababab' })).toHaveCount(1);
  await expect(page.locator('.message', { hasText: 'Mallory' }).filter({ hasText: 'seal_pub' })).toHaveCount(1);
  expect((await calls(page)).filter((c) => c.cmd === 'sealed_enrollment_line').map((c) => c.args.reference).sort())
    .toEqual(['d'.repeat(64), 'e'.repeat(64)]); // only your own messages are asked about
});

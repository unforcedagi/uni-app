import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';

// T-176: the secret-request card on the real built frontend, with the Tauri backend faked. Proves the value goes
// only to `send_secret` (never `post_message`), the field is masked, and nothing of it is left in the page.
// The fake `secret_request` stands in for Rust's signature check (tested for real in uni-core: secret.rs and
// tests/mock_relay.rs): `signed` maps a message ref to the key that really signed it; a ref not in it doesn't verify.
// The fake keeps only the value's length, never the value, so the page check below also covers the fake.
// T176_SHOTS=1 also writes the walkthrough screenshots (walkthrough/0N-*.png).

const fx = JSON.parse(readFileSync(new URL('../fixtures/t176-messages.json', import.meta.url), 'utf8'));
const UNI = 'c'.repeat(64);
const DUMMY = 't176-dummy-' + Math.random().toString(16).slice(2, 14);
const shots = !!process.env.T176_SHOTS;
const now = () => Math.floor(Date.now() / 1000);
const msg = (ref: string, body: string, ts: number, author = UNI, name = 'Uni') => ({ ref, channel: 'test', author, author_name: name, ts, body,
  mentions_me: false, root: null, parent: null, mentions: [], reply_count: 0, last_reply_ts: null, edited: false, reactions: [] });
const request = (fx.request.content as string).replace(/"expires":\d+/, `"expires":${now() + 900}`);
const ask = msg('e'.repeat(64), 'Robin: can you list my tailnet devices?', now() - 120, 'a'.repeat(64), 'Robin');

const parse = (body: string) => JSON.parse(/```uni-secret-request\n([^\n]*)\n```/.exec(body)![1]);

async function boot(page: Page, opts: { messages: { ref: string; body: string }[]; signed?: Record<string, string>; trusted?: boolean; optOut?: boolean; value?: string }) {
  const signed = opts.signed ?? Object.fromEntries(opts.messages.filter((m) => m.body.includes('uni-secret-request')).map((m) => [m.ref, UNI]));
  const requests = Object.fromEntries(opts.messages.filter((m) => m.body.includes('uni-secret-request')).map((m) => [m.ref, parse(m.body)]));
  await page.addInitScript(({ messages, trusted, optOut, signed, requests, value }) => {
    const w = window as any;
    if (optOut) localStorage.setItem('uni:secret-cards', 'off');
    w.calls = [];
    w.sentValueMatches = null;
    w.requesters = trusted ? ['c'.repeat(64)] : [];
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: () => 1,
      invoke: async (cmd: string, args: any) => {
        if (cmd === 'send_secret') {
          w.sentValueMatches = args.value === value;
          w.calls.push({ cmd, args: { ...args, value: `<${String(args.value).length} chars>` } });
        } else w.calls.push({ cmd, args });
        switch (cmd) {
          case 'identity_status': return { paired: true, pubkey: 'a'.repeat(64) };
          case 'get_identity': return 'a'.repeat(64);
          case 'relay_origin': return 'https://example.invalid';
          case 'get_npub': return 'test';
          case 'get_rooms': return [{ id: 'test', name: 'Test room', unread: 0 }];
          case 'get_members': return [{ pubkey: 'c'.repeat(64), name: 'Uni' }, { pubkey: 'a'.repeat(64), name: 'Robin' }];
          case 'get_messages': return messages;
          case 'vault_list': return [];
          case 'journal_config': return { hub: 'test' };
          case 'refresh': return { pubkey: 'a'.repeat(64), total_items: 0, channel_errors: {}, truncated_channels: [] };
          case 'secret_requesters': return w.requesters;
          case 'secret_request':
            if (!signed[args.request]) throw "this request can't be verified; ask Uni for a new one";
            return { author: signed[args.request], request: requests[args.request] };
          case 'secret_pin': if (!signed[args.request]) throw "this request can't be verified"; w.requesters = [signed[args.request]]; return null;
          case 'send_secret': await new Promise((r) => setTimeout(r, 400)); return 'f'.repeat(64);
          case 'forget_secret': return 'f'.repeat(64);
          default: return null;
        }
      },
    };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  }, { messages: opts.messages, trusted: !!opts.trusted, optOut: !!opts.optOut, signed, requests, value: opts.value ?? null });
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'Message Test room' })).toBeVisible();
}
const shot = async (page: Page, name: string) => { if (shots) await page.screenshot({ path: `walkthrough/${name}.png` }); };
const calls = (page: Page) => page.evaluate(() => (window as any).calls as { cmd: string; args: any }[]);

test('a request becomes a masked card; the value goes only to send_secret and leaves no trace in the page', async ({ page }) => {
  await boot(page, { messages: [ask, msg('d'.repeat(64), request, now() - 60)], value: DUMMY });
  const card = page.getByRole('region', { name: 'Secret request: Tailscale API token' });
  await expect(card).toBeVisible();
  await expect(page.locator('.message', { hasText: 'uni-secret-request' })).toHaveCount(0); // the machine block is not shown
  // T-335: one row (what, where it's kept), the facts behind details
  await expect(card.locator('.cc-what')).toHaveText('Tailscale API token');
  await expect(card.locator('dl')).toHaveCount(0);
  // Not yet trusted: a fingerprint and a Trust button, no field.
  await expect(card.getByRole('button', { name: /Trust Uni \(cccc cccc cccc cccc\)/ })).toBeVisible();
  await expect(card.locator('input')).toHaveCount(0);
  await card.scrollIntoViewIfNeeded();
  await shot(page, '01-request-untrusted');
  await card.getByRole('button', { name: /Trust Uni/ }).click();
  const field = card.getByRole('textbox', { name: 'Value for Tailscale API token' }).or(card.locator('input[type=password]'));
  await expect(field).toBeVisible();
  expect(await field.getAttribute('type')).toBe('password');
  expect(await field.getAttribute('autocomplete')).toBe('off');
  await shot(page, '02-request-trusted');
  await field.fill(DUMMY);
  await shot(page, '03-typed-masked');
  await card.getByRole('button', { name: 'Send sealed' }).click();
  await expect(card.getByText('Sealed and sent to Uni')).toBeVisible();
  await shot(page, '04-sent-waiting');
  await card.getByRole('button', { name: 'details' }).click();
  await expect(card.locator('dt', { hasText: /^Sealed to$/ }).locator('+ dd')).toHaveText('Uni · cccc cccc cccc cccc');

  const c = await calls(page);
  expect(c.find((x) => x.cmd === 'secret_pin')?.args).toEqual({ channel: 'test', request: 'd'.repeat(64) }); // the key comes from Rust
  const sends = c.filter((x) => x.cmd === 'send_secret');
  expect(sends).toHaveLength(1);
  expect(sends[0].args).toEqual({ channel: 'test', request: 'd'.repeat(64), value: `<${DUMMY.length} chars>` });
  expect(await page.evaluate(() => (window as any).sentValueMatches)).toBe(true);
  // never post_message, never a log_line: nothing the page passed anywhere holds the value (the fake kept none either)
  expect(JSON.stringify(c)).not.toContain(DUMMY);
  const page_has = await page.evaluate((d) => document.documentElement.outerHTML.includes(d)
    || [...document.querySelectorAll('input,textarea')].some((e) => (e as HTMLInputElement).value.includes(d))
    || JSON.stringify({ ...localStorage }).includes(d) || JSON.stringify({ ...sessionStorage }).includes(d), DUMMY);
  expect(page_has).toBe(false);
});

test('a stored receipt flips the card; Forget asks Uni to delete it', async ({ page }) => {
  const stored = msg('b'.repeat(64), fx.stored.content, now() - 30);
  await boot(page, { messages: [ask, msg('d'.repeat(64), request, now() - 60), stored], trusted: true });
  const card = page.getByRole('region', { name: 'Secret request: Tailscale API token' });
  // T-335: stored is one closed line; it opens to what was stored and the Forget button
  await expect(card.locator('summary')).toHaveText(/^🔒Stored · Tailscale API token · until \w{3} \d{1,2}, \d{4}$/);
  await expect(card.locator('details')).not.toHaveAttribute('open');
  await expect(card.getByRole('button', { name: 'Ask Uni to forget it' })).toBeHidden();
  await card.locator('summary').click();
  await expect(card.getByText(/Stored as tailscale-api until/)).toBeVisible();
  await expect(card.locator('input')).toHaveCount(0);
  await expect(page.locator('.message', { hasText: 'uni-secret-stored' })).toHaveCount(0);
  await expect(page.getByText('I only see the handle.')).toBeVisible();
  await page.getByText('I only see the handle.').scrollIntoViewIfNeeded();
  await shot(page, '05-stored');
  await card.getByRole('button', { name: 'Ask Uni to forget it' }).click();
  await expect(card.getByText('Asked Uni to forget it')).toBeVisible();
  expect((await calls(page)).filter((x) => x.cmd === 'forget_secret').map((x) => x.args)).toEqual([{ channel: 'test', request: 'd'.repeat(64) }]);
});

test('once Uni is trusted, someone else named "Uni" gets no field and no Trust button, and their receipts do not count', async ({ page }) => {
  const impostor = '9'.repeat(64);
  const fake = msg('d'.repeat(64), request, now() - 60, impostor, 'Uni');
  const fakeStored = msg('b'.repeat(64), fx.stored.content, now() - 30, UNI, 'Uni'); // a receipt by the real Uni for a request it never made
  await boot(page, { messages: [fake, fakeStored], signed: { ['d'.repeat(64)]: impostor }, trusted: true });
  const card = page.getByRole('region', { name: 'Secret request: Tailscale API token' });
  await expect(card.getByText(/This isn't the key you trust for secrets/)).toBeVisible();
  await expect(card.getByRole('button', { name: /Trust|Send/ })).toHaveCount(0);
  await expect(card.locator('input')).toHaveCount(0);
  await expect(card.getByText(/Stored as/)).toHaveCount(0);
});

test('a request whose signature does not verify gets no field and no Trust button, even under a trusted name', async ({ page }) => {
  // What a lying relay could have put in an older build's cache: a row that says Uni wrote it, with no valid signature.
  const forged = msg('d'.repeat(64), request.replace(/"rpk":"[0-9a-f]{64}"/, `"rpk":"${'7'.repeat(64)}"`), now() - 60);
  await boot(page, { messages: [forged], signed: {}, trusted: true });
  const card = page.getByRole('region', { name: 'Secret request (unverified)' });
  await expect(card.getByText(/Can't answer: this request can't be verified/)).toBeVisible();
  await expect(page.getByRole('region', { name: /Secret request: / })).toHaveCount(0);
  await expect(card.locator('input')).toHaveCount(0);
  await expect(card.getByRole('button')).toHaveCount(0);
  await card.scrollIntoViewIfNeeded();
  await shot(page, '06-unverified');
  expect((await calls(page)).filter((x) => ['send_secret', 'secret_pin'].includes(x.cmd))).toEqual([]);
});

test('opted out (uni:secret-cards = off), a request is just a message', async ({ page }) => {
  await boot(page, { messages: [msg('d'.repeat(64), request, now() - 60)], trusted: true, optOut: true });
  await expect(page.getByRole('region', { name: /Secret request/ })).toHaveCount(0);
  await expect(page.getByText('Uni is asking for a secret:')).toBeVisible();
  expect((await calls(page)).some((x) => x.cmd === 'secret_requesters')).toBe(false);
});

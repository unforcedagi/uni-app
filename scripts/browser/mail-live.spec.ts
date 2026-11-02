// T-335 live proof: approve a held send with two files in the Mail view, against a real mail bridge and mail server.
// The webview's mail commands go to crates/uni-core/examples/mail_ipc_proxy.rs, which runs the same uni_core::mail
// calls the Tauri commands run, signed with the owner's test key. Nothing here is mocked below the IPC line.
// Recipe (all test accounts and throwaway keys; a scratch copy of the bridge with its own ledger, spool and rules):
//   1. a scratch bridge whose rules hold mail to the test owner's address for approval;
//   2. scripts/browser/mail-live-park.py parks a send with two files as the test "uni" key -> park.json;
//   3. mail_ipc_proxy <port> <scratch bridge> <owner key file> <cache dir> http://127.0.0.1:<MAIL_LIVE_PORT or 1436>;
//   4. MAIL_LIVE_PROXY=http://127.0.0.1:<port> MAIL_LIVE_PARK=park.json MAIL_LIVE_FILES=<dir of the two files>
//      [MAIL_LIVE_SHOTS=<dir>] npx playwright test --config playwright.maillive.config.ts
// It checks: the files are listed with their names, kinds and sizes; opening one hands the opener exactly the listed
// bytes; Send it sends; and the sent copy (Uni's Sent) and the delivered copy (the owner's Inbox) carry both files with
// the SHA-256 of the files that were parked.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const PROXY = process.env.MAIL_LIVE_PROXY ?? '';
test.skip(!PROXY, 'set MAIL_LIVE_PROXY (see the recipe at the top of this file)');
const park = PROXY ? JSON.parse(readFileSync(process.env.MAIL_LIVE_PARK!, 'utf8')) : null;
const sha = (name: string) => createHash('sha256').update(readFileSync(join(process.env.MAIL_LIVE_FILES!, name))).digest('hex');
const shot = async (page: Page, name: string) => { if (process.env.MAIL_LIVE_SHOTS) await page.screenshot({ path: `${process.env.MAIL_LIVE_SHOTS}/${name}.png` }); };

async function proxy(cmd: string, args: unknown): Promise<any> {
  const r = await fetch(PROXY, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd, args }) });
  const out = await r.json();
  if ('err' in out) throw new Error(`${cmd}: ${JSON.stringify(out.err)}`);
  return out.ok;
}

test('a held send with two files: listed, opened as the listed bytes, approved, and delivered with both files byte for byte', async ({ page }) => {
  const subject: string = (await proxy('mail_parked', { accountId: park.account })).find((p: any) => p.op_id === park.opId)?.fields.subject;
  expect(subject, 'the parked send is listed by the bridge').toBeTruthy();
  await page.addInitScript((url) => {
    const w = window as any;
    localStorage.setItem('uni.tabs.v1', JSON.stringify({ v: 1, tabs: [{ id: 'mail', kind: 'mail', title: 'Mail' }], active: 'mail', recent: ['mail'] }));
    w.__calls = [];
    w.__opened = [];
    w.__TAURI_INTERNALS__ = {
      transformCallback: (cb: any) => cb, metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      invoke: async (cmd: string, args: any) => {
        w.__calls.push({ cmd, args });
        if (cmd.startsWith('mail_')) {
          const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd, args }) });
          const out = await r.json();
          if ('err' in out) throw out.err;
          if (cmd === 'mail_held_file_open') { w.__opened.push(out.ok); return null; }
          return out.ok;
        }
        switch (cmd) {
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
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  }, PROXY);
  await page.goto('/');
  await page.getByRole('button', { name: /waits? for you · Review$/ }).click();
  const row = page.locator('.mail-held-row').filter({ hasText: subject });
  await expect(row).toContainText('📎 2 · ');
  await row.click();
  const h = page.getByRole('region', { name: `Held send: ${subject}` });
  const files = h.getByRole('list', { name: 'Files it sends (2)' });
  const [csv, pdf] = park.files;
  await expect(files.getByRole('button', { name: `Open ${csv.name}` })).toContainText(`${csv.name}CSV · ${csv.size} B · Open`);
  await expect(files.getByRole('button', { name: `Open ${pdf.name}` })).toContainText(`${pdf.name}PDF · 13 KB · Open`);
  await expect(h.getByRole('button', { name: /^Send it with 2 files, from Uni's address/ })).toBeVisible();
  await shot(page, 'live-1-held-with-files');

  // opening each one hands the opener the listed bytes, which are the bytes that were parked
  for (const f of park.files) {
    await files.getByRole('button', { name: `Open ${f.name}` }).click();
    await expect(files.getByRole('listitem').filter({ hasText: f.name }).getByRole('status')).toHaveText('Passed the attachment checks; opened.');
  }
  const opened = await page.evaluate(() => (window as any).__opened);
  expect(opened.map((o: any) => [o.opened, o.sha256])).toEqual([[csv.name, sha(csv.name)], [pdf.name, sha(pdf.name)]]);
  await shot(page, 'live-2-opened');

  await h.getByRole('button', { name: /^Send it with 2 files/ }).click();
  await expect(h.getByRole('group', { name: 'Confirm sending' })).toContainText('with its 2 files? It goes out exactly as shown, files included.');
  await shot(page, 'live-3-confirm');
  await h.getByRole('button', { name: "Yes, send from Uni's address" }).click();
  await expect(h.getByRole('status').filter({ hasText: /^Sent from Uni's address/ })).toBeVisible({ timeout: 60_000 });
  const approve = (await page.evaluate(() => (window as any).__calls)).filter((c: any) => c.cmd === 'mail_send_approve');
  expect(approve).toEqual([{ cmd: 'mail_send_approve', args: { accountId: park.account, opId: park.opId, fingerprint: park.fingerprint } }]);
  await shot(page, 'live-4-sent');

  // the sent copy in Uni's Sent and the copy delivered to the owner's Inbox: both files, byte for byte
  const want = park.files.map((f: any) => [f.name, f.size, sha(f.name)]);
  let found: any[] = [];
  for (let i = 0; i < 30; i++) {
    found = await proxy('t335_fetch_back', { text: subject });
    if (found.some((m) => m.who === 'owner' && m.mailboxes.includes('inbox'))) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  const sent = found.find((m) => m.who === 'uni' && m.mailboxes.includes('sent') && !m.draft);
  const delivered = found.find((m) => m.who === 'owner' && m.mailboxes.includes('inbox'));
  expect(sent, 'a copy in Uni\'s Sent').toBeTruthy();
  expect(delivered, 'a copy in the owner\'s Inbox').toBeTruthy();
  for (const m of [sent, delivered]) expect(m.files.map((f: any) => [f.name, f.size, f.sha256])).toEqual(want);
  expect(found.filter((m) => m.who === 'uni' && m.draft), 'no draft left behind').toEqual([]);
  console.log('fetch-back:', JSON.stringify(found.map((m) => ({ who: m.who, mailboxes: m.mailboxes, draft: m.draft, files: m.files }))));
});

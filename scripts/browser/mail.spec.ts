// T-45 Mail view against a mocked command layer: what the Rust commands return (see crates/uni-core/tests/mail_bridge.rs for
// the commands against a fake bridge over real HTTP). Run: npx playwright test --config playwright.mail.config.ts
import { expect, test, type Page } from '@playwright/test';

const KEY = 'c0ffee'.repeat(10) + 'c0ff';

async function boot(page: Page, mode: 'ok' | 'not_allowed' | 'unreachable' = 'ok') {
  await page.addInitScript(([mode, KEY]) => {
    const w = window as any;
    localStorage.setItem('uni.tabs.v1', JSON.stringify({ v: 1, tabs: [{ id: 'mail', kind: 'mail', title: 'Mail' }], active: 'mail', recent: ['mail'] }));
    w.__mailMode = mode;
    w.__calls = [] as { cmd: string; args: any }[];
    const from = (name: string, email: string) => [{ name, email }];
    const rows = [
      { id: 'm1', thread_id: 't1', from: from('Stalwart test', 'test@mail.example.com'), subject: 'Mail is live on mail.example.com', preview: 'Hi Uni, this is a test message.', received_at: '2026-10-18T07:12:00Z', unread: true, has_attachment: false },
      { id: 'm2', thread_id: 't2', from: from('Hilltop Tech Night', 'events@example.org'), subject: 'This week: three demos and a pizza', preview: 'This week at Hilltop Tech Night', received_at: '2026-10-17T16:30:00Z', unread: true, has_attachment: false },
      { id: 'm4', thread_id: 't4', from: from('Ada (test)', 'ada@example.org'), subject: 'Notes from Thursday', preview: 'Notes attached as a PDF.', received_at: '2026-10-16T21:05:00Z', unread: false, has_attachment: true },
    ];
    const base = { thread_id: null, to: from('Uni', 'owner@example.com'), cc: [], reply_to: [], sent_at: null, remote_images: 0, links: [], truncated: false, attachments: [] };
    const messages: Record<string, any> = {
      m1: { ...base, id: 'm1', from: rows[0].from, subject: rows[0].subject, received_at: rows[0].received_at, unread: true, text: 'Hi Uni,\n\nThis is a test message. See https://mail.example.com/help for more.', html: null },
      // as if the Rust sanitizer had missed everything: the sealed frame must still run no script and load nothing remote
      m2: { ...base, id: 'm2', from: rows[1].from, subject: rows[1].subject, received_at: rows[1].received_at, unread: true, text: null, remote_images: 2, links: [{ url: 'https://bouldernewtech.example/rsvp', text: 'RSVP here' }],
        html: '<h1>This week at Hilltop Tech Night</h1><p id="p">Three demos.</p><img src="/remote-pixel.gif"><img src="http://127.0.0.1:1434/remote-banner.png"><script>document.getElementById("p").textContent="SCRIPT RAN";parent.postMessage("script-ran","*")</script>' },
      m4: { ...base, id: 'm4', from: rows[2].from, subject: rows[2].subject, received_at: rows[2].received_at, unread: false, text: 'Notes attached as a PDF.', html: '<p>Notes attached as a <b>PDF</b>.</p>',
        attachments: [{ blob_id: 'Bnotes-pdf', name: 'thursday-notes.pdf', mime: 'application/pdf', size: 412, cid: null }, { blob_id: 'Bexe', name: 'invoice.exe', mime: 'application/octet-stream', size: 9000, cid: null }, { blob_id: 'Binvoice-svg', name: 'invoice.png', mime: 'image/png', size: 160, cid: null }, { blob_id: 'Bbudget-docx', name: 'budget.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 5113, cid: null }] },
    };
    const fail = () => {
      if (w.__mailMode === 'not_allowed') throw { kind: 'not_allowed', message: 'pubkey not allowed', pubkey: KEY };
      if (w.__mailMode === 'unreachable') throw { kind: 'unreachable', message: 'https://uni-1.example.ts.net:8452 is not answering (tailnet only)' };
    };
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } }, transformCallback: () => 1,
      invoke: async (cmd: string, args: any) => {
        w.__calls.push({ cmd, args });
        switch (cmd) {
          case 'mail_mailboxes': fail(); return { account: 'owner@example.com', mailboxes: [
            { id: 'mb-inbox', name: 'INBOX', role: 'inbox', parent_id: null, total: 3, unread: 2 },
            { id: 'mb-archive', name: 'Archive', role: 'archive', parent_id: null, total: 0, unread: 0 },
            { id: 'mb-junk', name: 'Junk Mail', role: 'junk', parent_id: null, total: 1, unread: 1 }] };
          case 'mail_messages': fail(); return args.mailbox === 'mb-inbox' ? { account: 'owner@example.com', mailbox: 'mb-inbox', position: 0, total: 3, messages: rows } : { account: 'owner@example.com', mailbox: args.mailbox, position: 0, total: 0, messages: [] };
          case 'mail_message': fail(); if (w.__messageFails) throw { kind: 'server', message: 'mail server: URLError' }; return messages[args.id];
          // Rust decides (uni_core::mail::open_attachment, tested in crates/uni-core/tests/mail_attachment.rs);
          // this stand-in returns its refusals word for word so the UI's handling of them is checked here
          case 'mail_attachment_open':
            if (args.name === 'invoice.exe') throw { kind: 'invalid', message: "Uni doesn't open .exe files from mail: they could run as a program. Open it in your mail client if you trust the sender." };
            if (args.blobId === 'Binvoice-svg') throw { kind: 'invalid', message: "Uni didn't open this attachment: it is named .png but its contents are an SVG image (which can run script). Open it in your mail client if you trust the sender." };
            if (args.blobId === 'Bbudget-docx') throw { kind: 'invalid', message: "Uni didn't open this attachment: it is named .docx but it is an Office file with macros, an embedded object, unsupported fields, or a link that loads from outside. Open it in your mail client if you trust the sender." };
            return null;
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
  }, [mode, KEY] as const);
  await page.goto('/');
}

const phone = (page: Page) => (page.viewportSize()?.width ?? 1000) < 700;

test('the inbox lists newest first with unread state and says it is read-only', async ({ page }) => {
  await boot(page);
  const mail = page.getByRole('region', { name: 'Mail' }).last();
  await expect(mail.getByText('owner@example.com · read-only')).toBeVisible();
  const rows = mail.locator('.mail-row');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toHaveAccessibleName(/^Unread\. Stalwart test: Mail is live/);
  await expect(rows.nth(2)).toHaveAccessibleName(/^Ada \(test\): Notes from Thursday/);
  await expect(mail.getByText('3 messages')).toBeVisible();
  if (!phone(page)) await expect(mail.getByRole('button', { name: /Inbox/ })).toHaveAttribute('aria-current', 'page');
});

test('a plain message reads as text, and reading writes nothing', async ({ page }) => {
  await boot(page);
  await page.locator('.mail-row').first().click();
  const reader = page.getByRole('article', { name: 'Mail is live on mail.example.com' });
  await expect(reader.getByText('This is a test message.', { exact: false })).toBeVisible();
  await expect(reader.getByText('Stalwart test <test@mail.example.com>')).toBeVisible();
  await expect(reader.getByRole('link', { name: 'https://mail.example.com/help' })).toBeVisible();
  const cmds: string[] = await page.evaluate(() => (window as any).__calls.map((c: any) => c.cmd).filter((c: string) => c.startsWith('mail_')));
  expect(new Set(cmds)).toEqual(new Set(['mail_mailboxes', 'mail_messages', 'mail_message']));
});

test('HTML renders sealed: no script runs and nothing remote loads', async ({ page }) => {
  // Chromium reports a CSP-blocked image as a request that fails ("csp"); none may finish
  const loaded: string[] = [];
  const blocked: string[] = [];
  page.on('requestfinished', (r) => { if (/remote-(pixel|banner)/.test(r.url())) loaded.push(r.url()); });
  page.on('requestfailed', (r) => { if (/remote-(pixel|banner)/.test(r.url())) blocked.push(r.failure()?.errorText ?? ''); });
  let scriptRan = false;
  await page.exposeFunction('__scriptRan', () => { scriptRan = true; });
  await boot(page);
  await page.evaluate(() => window.addEventListener('message', (e) => { if (e.data === 'script-ran') (window as any).__scriptRan(); }));
  await page.locator('.mail-row').nth(1).click();
  const frame = page.locator('iframe.mail-html');
  await expect(frame).toBeVisible();
  await expect(frame).toHaveAttribute('sandbox', '');
  await expect(page.getByText('2 remote images not loaded')).toBeVisible();
  const body = page.frameLocator('iframe.mail-html');
  await expect(body.getByRole('heading', { name: 'This week at Hilltop Tech Night' })).toBeVisible();
  await expect(body.locator('#p')).toHaveText('Three demos.');
  await page.waitForTimeout(500);
  expect(scriptRan).toBe(false);
  expect(loaded).toEqual([]);
  expect(blocked).toEqual(['csp', 'csp']);
});

test('plain text first when there is both; formatted on request; attachments open through Rust', async ({ page }) => {
  await boot(page);
  await page.locator('.mail-row').nth(2).click();
  const reader = page.getByRole('article', { name: 'Notes from Thursday' });
  await expect(reader.locator('.mail-text')).toHaveText('Notes attached as a PDF.');
  await expect(page.locator('iframe.mail-html')).toHaveCount(0);
  await reader.getByRole('button', { name: 'Show formatted' }).click();
  await expect(page.frameLocator('iframe.mail-html').locator('b')).toHaveText('PDF');
  await reader.getByRole('button', { name: 'Open thursday-notes.pdf' }).click();
  const open = await page.evaluate(() => (window as any).__calls.find((c: any) => c.cmd === 'mail_attachment_open')?.args);
  expect(open).toEqual({ blobId: 'Bnotes-pdf', name: 'thursday-notes.pdf', mime: 'application/pdf' }, 'the declared type goes to Rust, which checks it against the name and the bytes');
});

test('an empty mailbox says so', async ({ page }) => {
  await boot(page);
  if (phone(page)) await page.getByRole('button', { name: '☰ Mailboxes' }).click();
  await page.getByRole('button', { name: 'Archive' }).click();
  await expect(page.getByText('No messages in Archive.')).toBeVisible();
});

test('a device the bridge does not allow is told so, with its key, and Retry recovers', async ({ page }) => {
  await boot(page, 'not_allowed');
  const alert = page.getByRole('alert');
  await expect(alert.getByText("This device isn't allowed to read mail yet.")).toBeVisible();
  await expect(alert.getByText(KEY)).toBeVisible();
  await expect(alert.getByRole('button', { name: 'Copy key' })).toBeVisible();
  await page.evaluate(() => { (window as any).__mailMode = 'ok'; });
  await alert.getByRole('button', { name: 'Retry' }).click();
  await expect(page.locator('.mail-row')).toHaveCount(3);
});

test('a bridge that is down is named, not shown as an empty inbox', async ({ page }) => {
  await boot(page, 'unreachable');
  await expect(page.getByRole('alert').getByText("Mail isn't reachable right now.")).toBeVisible();
  await expect(page.getByText(/No messages/)).toHaveCount(0);
});

test('on a phone one pane shows at a time', async ({ page }) => {
  test.skip(!phone(page), 'phone layout');
  await boot(page);
  await expect(page.locator('.mail-boxes')).toBeHidden();
  await page.locator('.mail-row').first().click();
  await expect(page.locator('.mail-list')).toBeHidden();
  await expect(page.getByRole('article', { name: 'Mail is live on mail.example.com' })).toBeVisible();
  await page.getByRole('button', { name: '← Messages' }).click();
  await expect(page.locator('.mail-row').first()).toBeVisible();
});

test('an HTML message lists its links, and a link opens in the browser', async ({ page }) => {
  await boot(page);
  await page.locator('.mail-row').nth(1).click();
  await page.getByText('Links in this message (1)').click();
  await page.getByRole('link', { name: /RSVP here/ }).click();
  const opened = await page.evaluate(() => (window as any).__calls.find((c: any) => c.cmd === 'open_link')?.args);
  expect(opened).toEqual({ url: 'https://bouldernewtech.example/rsvp' });
});

test('an attachment that could run as a program is not opened, and says why', async ({ page }) => {
  await boot(page);
  await page.locator('.mail-row').nth(2).click();
  await page.getByRole('button', { name: 'Open invoice.exe' }).click();
  await expect(page.getByText(/doesn't open \.exe files from mail/)).toBeVisible();
});

test('a disguised attachment is refused, and says what it really is', async ({ page }) => {
  await boot(page);
  await page.locator('.mail-row').nth(2).click();
  await page.getByRole('button', { name: 'Open invoice.png' }).click();
  await expect(page.getByText(/named \.png but its contents are an SVG image/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open invoice.png' })).toContainText('Not opened');
  const open = await page.evaluate(() => (window as any).__calls.filter((c: any) => c.cmd === 'mail_attachment_open').map((c: any) => c.args));
  expect(open).toEqual([{ blobId: 'Binvoice-svg', name: 'invoice.png', mime: 'image/png' }]);
});

test('an Office file with an embedded object is refused, and says so', async ({ page }) => {
  await boot(page);
  await page.locator('.mail-row').nth(2).click();
  await page.getByRole('button', { name: 'Open budget.docx' }).click();
  await expect(page.getByText(/named \.docx but it is an Office file with macros, an embedded object/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open budget.docx' })).toContainText('Not opened');
  await expect(page.getByRole('button', { name: 'Open invoice.png' })).not.toContainText('Not opened');
});

test('a message that failed to open leaves no error behind after switching mailbox', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => { (window as any).__messageFails = true; });
  await page.locator('.mail-row').first().click();
  await expect(page.getByRole('alert').getByText("The mail server didn't answer.")).toBeVisible();
  if (phone(page)) { await page.getByRole('button', { name: '← Messages' }).click(); await page.getByRole('button', { name: '☰ Mailboxes' }).click(); }
  await page.getByRole('button', { name: 'Archive' }).click();
  await expect(page.getByText('No messages in Archive.')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('leaving Mail and coming back returns to the same message', async ({ page }) => {
  await boot(page);
  await page.locator('.mail-row').nth(2).click();
  await expect(page.getByRole('article', { name: 'Notes from Thursday' })).toBeVisible();
  const rail = page.getByRole('navigation', { name: 'Main navigation' });
  await rail.getByRole('button', { name: 'Journal', exact: true }).click();
  await expect(page.locator('.mail')).toHaveCount(0);
  await rail.getByRole('button', { name: 'Mail', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Notes from Thursday' })).toBeVisible();
});

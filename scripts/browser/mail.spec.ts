// T-45 v2 Mail view (both mailboxes, read-only) against a mocked command layer that answers as the Rust commands do
// (crates/uni-core/tests/mail_accounts.rs runs those commands against a two-account JMAP double over real HTTP). The
// made-up mail matches that double: Robin Vale's account A (YOU) and Uni's account U (UNI), shared with each other.
// Run: npx playwright test --config playwright.mail.config.ts (desktop, phone, and the Daylight upright and sideways)
import { expect, test, type Page } from '@playwright/test';

const KEY = 'c0ffee'.repeat(10) + 'c0ff';
type Mode = 'ok' | 'not_allowed' | 'unreachable' | 'one_account';

async function boot(page: Page, mode: Mode = 'ok') {
  await page.addInitScript(([mode, KEY]) => {
    const w = window as any;
    localStorage.setItem('uni.tabs.v1', JSON.stringify({ v: 1, tabs: [{ id: 'mail', kind: 'mail', title: 'Mail' }], active: 'mail', recent: ['mail'] }));
    w.__mailMode = mode;
    w.__calls = [] as { cmd: string; args: any }[];
    const a = (name: string | null, email: string) => ({ name, email });
    const robin = a('Robin Vale', 'robin@example.com'), uni = a('Uni', 'uni@example.com');
    const mara = a('Mara Quill', 'mara@example.org'), theo = a('Theo Brandt', 'theo@example.net'), ada = a('Ada Moss', 'ada@example.org');
    const box = (acct: string, role: string, name: string, total: number, unread: number) => ({ id: `${acct}-${role}`, name, role, parent_id: null, total, unread });
    const accounts = [
      { id: 'A', name: 'robin@example.com', who: 'owner', mailboxes: [box('A', 'inbox', 'Inbox', 4, 2), box('A', 'drafts', 'Drafts', 1, 0), box('A', 'sent', 'Sent', 1, 0), box('A', 'archive', 'Archive', 0, 0), box('A', 'junk', 'Junk', 1, 1), box('A', 'trash', 'Trash', 0, 0)] },
      { id: 'U', name: 'uni@example.com', who: 'uni', mailboxes: [box('U', 'inbox', 'Inbox', 3, 2), box('U', 'drafts', 'Drafts', 1, 0), box('U', 'sent', 'Sent', 1, 0), box('U', 'archive', 'Archive', 0, 0)] },
    ];
    const msg = (id: string, acct: string, thread: string, box: string, from: any, to: any, subject: string, at: string, o: any = {}) => ({
      id, thread_id: thread, account: acct, box, from: [from], to: [to], cc: [], reply_to: [], subject, received_at: at, sent_at: null,
      unread: false, draft: false, uni_drafted: false, mailbox_ids: [box], text: null, html: null, remote_images: 0, links: [], truncated: false, attachments: [], ...o,
    });
    const att = (blob_id: string, name: string, mime: string, size: number, refused: string | null = null) => ({ blob_id, part_id: '3', name, mime, size, cid: null, refused });
    const msgs = [
      msg('a1', 'A', 'TA-plan', 'A-inbox', mara, robin, 'Planning the garden week', '2026-10-18T09:00:00Z', { text: 'Hi Robin,\n\nShall we plan the garden week? I can bring the marmalade jars on Saturday.\n\nMara' }),
      msg('a2', 'A', 'TA-plan', 'A-sent', robin, mara, 'Re: Planning the garden week', '2026-10-18T11:00:00Z', { text: 'Saturday works. Bring the jars.\n\nRobin' }),
      msg('a3', 'A', 'TA-plan', 'A-inbox', mara, robin, 'Re: Planning the garden week', '2026-10-19T08:30:00Z', { unread: true, text: 'Great. One question: which day should we start the beds, Monday or Tuesday?\n\nMara' }),
      msg('a6', 'A', 'TA-plan', 'A-drafts', robin, mara, 'Re: Planning the garden week', '2026-10-19T09:00:00Z', { draft: true, uni_drafted: true, text: 'Monday suits me. See you then.\n\nRobin' }),
      msg('a4', 'A', 'Ta4', 'A-inbox', theo, robin, 'Workshop photos and slides', '2026-10-17T15:00:00Z', { unread: true, text: 'Here are the notes from the workshop, a proof of the poster, and the installer I mentioned.\n\nTheo',
        attachments: [att('Bnotes-pdf', 'workshop-notes.pdf', 'application/pdf', 13401), att('Bproof-svg', 'poster-proof.png', 'image/png', 160),
          att('Bsetup-exe', 'setup.exe', 'application/octet-stream', 9000, "Uni doesn't open .exe files from mail: they could run as a program. Open it in your mail client if you trust the sender.")] }),
      // as if the Rust sanitizer had missed everything: the sealed frame must still run no script and load nothing remote
      msg('a5', 'A', 'Ta5', 'A-inbox', a('Riverside Library', 'library@example.org'), robin, 'Your hold is ready', '2026-10-16T10:00:00Z', { remote_images: 2, links: [{ url: 'https://library.example/holds', text: 'See your holds' }],
        html: '<h2>Your hold is ready</h2><p id="p">Pick it up within seven days.</p><img src="/remote-pixel.gif"><img src="http://127.0.0.1:1434/remote-banner.png"><script>document.getElementById("p").textContent="SCRIPT RAN";parent.postMessage("script-ran","*")</script>' }),
      msg('a7', 'A', 'Ta7', 'A-junk', a('Prize Desk', 'winner@spam.example'), robin, 'Free marmalade for life', '2026-10-15T03:00:00Z', { unread: true, text: 'Claim now.' }),
      msg('u1', 'U', 'Tu1', 'U-inbox', a('Monitor', 'monitor@example.net'), uni, 'Server report for Tuesday', '2026-10-18T10:30:00Z', { unread: true, text: 'All checks passed. The lighthouse job ran twice.' }),
      msg('u2', 'U', 'TU-read', 'U-inbox', ada, uni, 'Question about the reading group', '2026-10-17T18:00:00Z', { text: 'Hello Uni, is the reading group still on Thursday?\n\nAda' }),
      msg('u3', 'U', 'TU-read', 'U-sent', uni, ada, 'Re: Question about the reading group', '2026-10-17T19:00:00Z', { text: 'Yes, Thursday at six.' }),
      msg('u5', 'U', 'TU-read', 'U-drafts', uni, ada, 'Re: Question about the reading group', '2026-10-18T08:00:00Z', { draft: true, text: 'A reminder for Thursday at six.' }),
      msg('u4', 'U', 'Tu4', 'U-inbox', a('Billing', 'billing@example.com'), uni, 'Invoice for October', '2026-10-15T12:00:00Z', { unread: true, text: 'Your invoice is attached.', attachments: [att('Binvoice-pdf', 'invoice-october.pdf', 'application/pdf', 13401)] }),
    ];
    const notes: Record<string, string> = w.__notes = { 'A/a3': 'Needs you: Mara asks which day to start.', 'A/a4': '<b>Two files</b> pass the checks; setup.exe won\'t open.', 'U/u1': 'Routine. Nothing to do.' };
    const hay = (m: any) => [m.subject, m.text, m.html, ...m.from.map((x: any) => `${x.name} ${x.email}`), ...m.attachments.map((x: any) => x.name)].join(' ').toLowerCase();
    // Email/query with collapseThreads, per source, merged by time (what uni_core::mail::accounts::merge does)
    const threads = (sources: any[], text: string | null) => {
      const rows = sources.flatMap((s) => {
        const hits = msgs.filter((m) => m.account === s.account_id && (s.mailbox_id ? m.box === s.mailbox_id : !s.exclude.includes(m.box)) && (!text || hay(m).includes(text.toLowerCase())))
          .sort((x, y) => y.received_at.localeCompare(x.received_at));
        const seen = new Set<string>();
        return hits.filter((m) => !seen.has(m.thread_id) && seen.add(m.thread_id)).map((m) => {
          const all = msgs.filter((x) => x.account === m.account && x.thread_id === m.thread_id);
          return { account_id: m.account, thread_id: m.thread_id, email_id: m.id, from: m.from, to: m.to, subject: m.subject, preview: (m.text ?? m.subject).replace(/\s+/g, ' ').slice(0, 120),
            received_at: m.received_at, count: all.length, unread: all.some((x) => x.unread && !x.draft), has_attachment: all.some((x) => x.attachments.length > 0), draft: m.draft, uni_drafted: m.uni_drafted };
        });
      }).sort((x, y) => y.received_at.localeCompare(x.received_at));
      return { threads: rows, next: sources.map((s) => ({ ...s, position: rows.filter((r) => r.account_id === s.account_id).length })), more: false, total: rows.length };
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
          case 'mail_overview': fail();
            return w.__mailMode === 'one_account' ? { login: 'robin@example.com', multi: false, accounts: [accounts[0]] } : { login: 'robin@example.com', multi: true, accounts };
          case 'mail_threads': fail(); return threads(args.sources, args.text);
          case 'mail_thread': {
            fail(); if (w.__threadFails) throw { kind: 'server', message: 'mail server: URLError' };
            const list = msgs.filter((m) => m.account === args.accountId && m.thread_id === args.threadId).sort((x, y) => x.received_at.localeCompare(y.received_at));
            if (!list.length) throw { kind: 'invalid', message: 'that thread is no longer in the mailbox' };
            return { account_id: args.accountId, thread_id: args.threadId, messages: list };
          }
          case 'mail_triage': return Object.fromEntries(args.emailIds.filter((id: string) => notes[`${args.accountId}/${id}`]).map((id: string) => [id, notes[`${args.accountId}/${id}`]]));
          // Rust decides (uni_core::mail::open_attachment_in, tested in crates/uni-core/tests/mail_attachment.rs and mail_accounts.rs);
          // this stand-in returns its refusal word for word so the UI's handling of it is checked here
          case 'mail_attachment_open':
            if (args.blobId === 'Bproof-svg') throw { kind: 'invalid', message: "Uni didn't open this attachment: it is named .png but its contents are an SVG image (which can run script). Open it in your mail client if you trust the sender." };
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

const width = (page: Page) => page.viewportSize()?.width ?? 1440;
/** One pane at a time (a phone). */
const stacked = (page: Page) => width(page) < 700;
/** The mailboxes sit behind ☰ (a phone, or the Daylight upright). */
const boxesHidden = (page: Page) => width(page) < 1100;
const mail = (page: Page) => page.getByRole('region', { name: 'Mail' }).last();
const rows = (page: Page) => page.locator('.mail-row');

async function pickBox(page: Page, group: "Your mailboxes" | "Uni's mailboxes" | null, name: string) {
  if (boxesHidden(page)) await page.getByRole('button', { name: '☰ Mailboxes' }).click();
  const nav = page.getByRole('navigation', { name: 'Mailboxes' });
  await (group ? nav.getByRole('group', { name: group }) : nav).getByRole('button', { name: new RegExp(`^${name}`) }).click();
}

async function backToThreads(page: Page) {
  if (stacked(page)) await page.getByRole('button', { name: '← Threads' }).first().click();
}

/** MAIL_SHOTS=<dir>: keep a screenshot of each step, for looking at (never committed). */
async function shot(page: Page, name: string) {
  const dir = process.env.MAIL_SHOTS;
  if (dir) await page.screenshot({ path: `${dir}/${test.info().project.name}-${name}.png` });
}

const mailCmds = (page: Page): Promise<string[]> => page.evaluate(() => (window as any).__calls.map((c: any) => c.cmd).filter((c: string) => c.startsWith('mail_')));

test('the full flow: switch accounts and the combined view, open a thread, search, attachments, Send disabled', async ({ page }) => {
  await boot(page);
  const m = mail(page);
  await expect(m.getByText('robin@example.com · read-only')).toBeVisible();

  // 1. the combined view: both inboxes, newest first, every row tagged
  await expect(rows(page)).toHaveCount(6);
  const order = ["Your mail. Mara Quill: Re: Planning the garden week", "Uni's mail. Monitor: Server report", "Uni's mail. Ada Moss: Question about the reading group",
    "Your mail. Theo Brandt: Workshop photos", "Your mail. Riverside Library: Your hold", "Uni's mail. Billing: Invoice for October"];
  for (const [i, name] of order.entries()) await expect(rows(page).nth(i)).toHaveAccessibleName(new RegExp(name.replace(/[.?]/g, '\\$&')));
  await expect(rows(page).nth(0).locator('.mail-who')).toHaveText('YOU');
  await expect(rows(page).nth(1).locator('.mail-who')).toHaveText('UNI');
  await expect(rows(page).nth(0)).toContainText('Uni: Needs you: Mara asks which day to start.');
  await expect(rows(page).nth(3)).toContainText('<b>Two files</b> pass the checks', { useInnerText: true });
  await expect(rows(page).nth(3).locator('b')).toHaveCount(0, { timeout: 1 });
  await expect(m.getByRole('heading', { level: 2 })).toHaveCount(0);
  if (!boxesHidden(page)) await expect(page.getByRole('button', { name: /^All inboxes/ })).toHaveAttribute('aria-current', 'page');
  await shot(page, '1-combined');

  // switch accounts: Uni's Inbox, then yours, then back to both
  await pickBox(page, "Uni's mailboxes", 'Inbox');
  await expect(m.locator('.mail-list-head strong')).toHaveText('Uni · Inbox');
  await expect(rows(page)).toHaveCount(3);
  for (const t of await rows(page).locator('.mail-who').allInnerTexts()) expect(t).toBe('UNI');
  await pickBox(page, 'Your mailboxes', 'Inbox');
  await expect(m.locator('.mail-list-head strong')).toHaveText('Your · Inbox');
  await expect(rows(page)).toHaveCount(3);
  for (const t of await rows(page).locator('.mail-who').allInnerTexts()) expect(t).toBe('YOU');
  await pickBox(page, "Uni's mailboxes", 'Drafts');
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toHaveAccessibleName(/^Uni's mail\. Draft\. To Ada Moss/);
  await pickBox(page, null, 'All inboxes');
  await expect(rows(page)).toHaveCount(6);
  // each group has its tag in its head
  if (boxesHidden(page)) await page.getByRole('button', { name: '☰ Mailboxes' }).click();
  const nav = page.getByRole('navigation', { name: 'Mailboxes' });
  await expect(nav.getByRole('group', { name: 'Your mailboxes' }).locator('.mail-acct-head')).toHaveText(/YOU\s*robin@example\.com/);
  await expect(nav.getByRole('group', { name: "Uni's mailboxes" }).locator('.mail-acct-head')).toHaveText(/UNI\s*uni@example\.com/);
  await expect(nav.getByRole('group', { name: "Uni's mailboxes" }).locator('.who-uni').first()).toHaveCSS('border-top-style', 'dashed');
  await shot(page, '2-mailboxes');
  if (boxesHidden(page)) await nav.getByRole('button', { name: /^All inboxes/ }).click();

  // 2. a thread: oldest first, Uni's draft says it was not sent, Uni's note is labelled as Uni's, Reply is disabled
  await rows(page).nth(0).click();
  const thread = page.getByRole('region', { name: 'Thread: Planning the garden week' });
  await expect(thread.getByRole('heading', { name: 'Planning the garden week' })).toBeVisible();
  await expect(thread.locator('.mail-thread-where')).toContainText('YOU');
  await expect(thread.locator('.mail-thread-where')).toContainText('In your mail · 3 messages');
  await expect(thread.locator('.mail-card')).toHaveCount(4);
  await expect(thread.locator('.mail-card').nth(0)).toContainText('marmalade jars');
  await expect(thread.locator('.mail-card').nth(3)).toContainText('DRAFT · BY UNI · NOT SENT');
  await expect(thread.locator('.mail-card').nth(3)).toContainText("Uni can't send as you");
  await expect(thread.getByRole('note').filter({ hasText: "Uni's triage note" })).toContainText('Needs you: Mara asks which day to start.');
  await expect(thread.getByRole('button', { name: /^Reply/ })).toBeDisabled();
  await expect(thread.getByText('Sending comes later', { exact: true })).toBeVisible();
  await shot(page, '3-thread');
  await thread.locator('.mail-card').nth(3).scrollIntoViewIfNeeded();
  await shot(page, '3b-uni-draft');
  await backToThreads(page);

  // 3. search: both mailboxes, one word in one account
  await page.getByRole('searchbox', { name: 'Search mail' }).fill('lighthouse');
  await page.getByRole('searchbox', { name: 'Search mail' }).press('Enter');
  await expect(m.locator('.mail-list-head strong')).toHaveText('Search: both mailboxes');
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toHaveAccessibleName(/^Unread\. Uni's mail\. Monitor: Server report/);
  await shot(page, '4-search');
  await page.getByRole('searchbox', { name: 'Search mail' }).fill('marmalade');
  await page.getByRole('searchbox', { name: 'Search mail' }).press('Enter');
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toHaveAccessibleName(/Your mail\. Mara Quill: Planning the garden week/, { timeout: 5000 });
  const searches = await page.evaluate(() => (window as any).__calls.filter((c: any) => c.cmd === 'mail_threads' && c.args.text).map((c: any) => c.args));
  expect(searches.at(-1)).toEqual({ text: 'marmalade', sources: [
    { account_id: 'A', mailbox_id: null, exclude: ['A-junk', 'A-trash'], position: 0 },
    { account_id: 'U', mailbox_id: null, exclude: [], position: 0 },
  ] });
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(rows(page)).toHaveCount(6);

  // 4. attachments: a refusal by name shows at once and fetches nothing; one that passes opens; a disguised one is refused on Open
  await rows(page).nth(3).click();
  const files = page.getByRole('region', { name: 'Thread: Workshop photos and slides' }).getByRole('list', { name: 'Attachments' });
  await expect(files.getByRole('button', { name: "setup.exe won't open" })).toBeDisabled();
  await expect(files.getByText(/doesn't open \.exe files from mail/)).toBeVisible();
  await files.getByRole('button', { name: 'Open workshop-notes.pdf' }).click();
  await expect(files.getByText('Passed the attachment checks; opened.')).toBeVisible();
  await files.getByRole('button', { name: 'Open poster-proof.png' }).click();
  await expect(files.getByText(/named \.png but its contents are an SVG image/)).toBeVisible();
  await expect(files.getByRole('button', { name: 'Open poster-proof.png' })).toContainText('Not opened');
  await shot(page, '5-attachments');
  const opens = await page.evaluate(() => (window as any).__calls.filter((c: any) => c.cmd === 'mail_attachment_open').map((c: any) => c.args));
  expect(opens).toEqual([
    { accountId: 'A', blobId: 'Bnotes-pdf', name: 'workshop-notes.pdf', mime: 'application/pdf' },
    { accountId: 'A', blobId: 'Bproof-svg', name: 'poster-proof.png', mime: 'image/png' },
  ], 'setup.exe never reached Rust; each open names its account');
  await backToThreads(page);

  // an attachment in Uni's mail opens from Uni's account
  await rows(page).nth(5).click();
  await page.getByRole('button', { name: 'Open invoice-october.pdf' }).click();
  const last = await page.evaluate(() => (window as any).__calls.filter((c: any) => c.cmd === 'mail_attachment_open').at(-1).args);
  expect(last.accountId).toBe('U');
  await backToThreads(page);

  // 5. Send is disabled: New (in the bottom bar on a phone) and Reply, both saying sending comes later
  const news = page.getByRole('button', { name: /^New/ }).filter({ visible: true });
  await expect(news).toHaveCount(1);
  await expect(news).toBeDisabled();
  await expect(news).toHaveAccessibleName('New: sending comes later');
  if (stacked(page)) await expect(page.getByRole('navigation', { name: 'Mail actions' }).getByText('Sending comes later')).toBeVisible();

  // only reads were asked of Rust
  expect(new Set(await mailCmds(page))).toEqual(new Set(['mail_overview', 'mail_threads', 'mail_thread', 'mail_triage', 'mail_attachment_open']));
});

test('on the Daylight nothing in Mail moves, and every target is at least 44 px', async ({ page }, info) => {
  test.skip(!info.project.name.startsWith('daylight'), 'the Daylight');
  await boot(page);
  await expect(rows(page)).toHaveCount(6);
  if (boxesHidden(page)) await page.getByRole('button', { name: '☰ Mailboxes' }).click();
  const moving = await page.evaluate(() => [...document.querySelectorAll('.mail *')].filter((el) => {
    const s = getComputedStyle(el);
    return s.transitionDuration.split(',').some((d) => parseFloat(d) > 0) || (s.animationName !== 'none' && parseFloat(s.animationDuration) > 0);
  }).map((el) => el.className));
  expect(moving).toEqual([]);
  const small = await page.evaluate(() => [...document.querySelectorAll('.mail button, .mail input')].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.height < 44;
  }).map((el) => `${el.className}: ${(el as HTMLElement).innerText.slice(0, 20)}`));
  expect(small).toEqual([]);
});

test('elsewhere the app keeps its motion (the Daylight check above can fail)', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop');
  await boot(page);
  await expect(rows(page)).toHaveCount(6);
  const d = await page.locator('.mail-box').first().evaluate((el) => getComputedStyle(el).transitionDuration);
  expect(d.split(',').some((x) => parseFloat(x) > 0)).toBe(true);
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
  await rows(page).nth(4).click();
  const frame = page.locator('iframe.mail-html');
  await expect(frame).toBeVisible();
  await expect(frame).toHaveAttribute('sandbox', '');
  await expect(page.getByText('2 remote images not loaded')).toBeVisible();
  const body = page.frameLocator('iframe.mail-html');
  await expect(body.getByRole('heading', { name: 'Your hold is ready' })).toBeVisible();
  await expect(body.locator('#p')).toHaveText('Pick it up within seven days.');
  await page.waitForTimeout(500);
  expect(scriptRan).toBe(false);
  expect(loaded).toEqual([]);
  expect(blocked).toEqual(['csp', 'csp']);
  await page.getByText('Links in this message (1)').click();
  await page.getByRole('link', { name: /See your holds/ }).click();
  const opened = await page.evaluate(() => (window as any).__calls.find((c: any) => c.cmd === 'open_link')?.args);
  expect(opened).toEqual({ url: 'https://library.example/holds' });
});

/** Codex review 1, P1: a note Uni removed or changed is not left on screen after Refresh. */
test("Refresh replaces Uni's triage notes: a removed one goes, a changed one changes", async ({ page }) => {
  await boot(page);
  await expect(rows(page).nth(0)).toContainText('Uni: Needs you: Mara asks which day to start.');
  await expect(rows(page).nth(1)).toContainText('Uni: Routine. Nothing to do.');
  await page.evaluate(() => { const n = (window as any).__notes; delete n['A/a3']; n['U/u1'] = 'Checked again: still routine.'; });
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(rows(page).nth(1)).toContainText('Uni: Checked again: still routine.');
  await expect(rows(page).nth(0)).not.toContainText('Needs you');
  await expect(rows(page).nth(0).locator('.mail-row-preview')).toBeVisible();
});

test("Uni's own draft, in Uni's mail, reads as Uni's and not sent", async ({ page }) => {
  await boot(page);
  await rows(page).nth(2).click();
  const thread = page.getByRole('region', { name: 'Thread: Question about the reading group' });
  await expect(thread.locator('.mail-thread-where')).toContainText('UNI');
  await expect(thread.locator('.mail-thread-where')).toContainText("In Uni's mail · 2 messages");
  await expect(thread.locator('.mail-card-draft')).toContainText("UNI'S OWN DRAFT · NOT SENT");
  await expect(thread.getByRole('note').filter({ hasText: "Uni's triage note" })).toHaveCount(0);
});

test('a v1 bridge shows one mailbox, says so, and has no combined view', async ({ page }) => {
  await boot(page, 'one_account');
  await expect(rows(page)).toHaveCount(3);
  await expect(mail(page).locator('.mail-list-head strong')).toHaveText('Inbox');
  if (boxesHidden(page)) await page.getByRole('button', { name: '☰ Mailboxes' }).click();
  await expect(page.getByRole('button', { name: /^All inboxes/ })).toHaveCount(0);
  await expect(page.getByText("This bridge reads one mailbox. Uni's appears here once it is shared.")).toBeVisible();
  const sources = await page.evaluate(() => (window as any).__calls.find((c: any) => c.cmd === 'mail_threads').args.sources);
  expect(sources).toEqual([{ account_id: 'A', mailbox_id: 'A-inbox', exclude: [], position: 0 }]);
});

test('a device the bridge does not allow is told so, with its key, and Retry recovers', async ({ page }) => {
  await boot(page, 'not_allowed');
  const alert = page.getByRole('alert');
  await expect(alert.getByText("This device isn't allowed to read mail yet.")).toBeVisible();
  await expect(alert.getByText(KEY)).toBeVisible();
  await expect(alert.getByRole('button', { name: 'Copy key' })).toBeVisible();
  await page.evaluate(() => { (window as any).__mailMode = 'ok'; });
  await alert.getByRole('button', { name: 'Retry' }).click();
  await expect(rows(page)).toHaveCount(6);
});

test('a bridge that is down is named, not shown as an empty inbox', async ({ page }) => {
  await boot(page, 'unreachable');
  await expect(page.getByRole('alert').getByText("Mail isn't reachable right now.")).toBeVisible();
  await expect(page.getByText('Nothing here.')).toHaveCount(0);
});

test('a thread that failed to open leaves no error behind after switching mailbox', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => { (window as any).__threadFails = true; });
  await rows(page).first().click();
  await expect(page.getByRole('alert').getByText("The mail server didn't answer.")).toBeVisible();
  await backToThreads(page);
  await pickBox(page, 'Your mailboxes', 'Archive');
  await expect(page.getByText('Nothing here.')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('on a phone one pane shows at a time, with Search and New at the bottom', async ({ page }) => {
  test.skip(!stacked(page), 'phone layout');
  await boot(page);
  await expect(page.locator('.mail-boxes')).toBeHidden();
  const bar = page.getByRole('navigation', { name: 'Mail actions' });
  await expect(bar).toBeVisible();
  const barBox = (await bar.boundingBox())!;
  const listBox = (await page.locator('.mail-list').boundingBox())!;
  expect(barBox.y).toBeGreaterThanOrEqual(listBox.y + listBox.height - 1);
  await rows(page).first().click();
  await expect(page.locator('.mail-list')).toBeHidden();
  await bar.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByRole('searchbox', { name: 'Search mail' })).toBeFocused();
});

test('leaving Mail and coming back returns to the same thread', async ({ page }) => {
  await boot(page);
  await rows(page).nth(3).click();
  await expect(page.getByRole('region', { name: 'Thread: Workshop photos and slides' })).toBeVisible();
  const rail = page.getByRole('navigation', { name: 'Main navigation' });
  await rail.getByRole('button', { name: 'Journal', exact: true }).click();
  await expect(page.locator('.mail')).toHaveCount(0);
  await rail.getByRole('button', { name: 'Mail', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Thread: Workshop photos and slides' })).toBeVisible();
});

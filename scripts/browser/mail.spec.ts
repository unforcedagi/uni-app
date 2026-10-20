// T-45 v2 Mail view (both mailboxes, read-only) against a mocked command layer that answers as the Rust commands do
// (crates/uni-core/tests/mail_accounts.rs runs those commands against a two-account JMAP double over real HTTP). The
// made-up mail matches that double: Robin Vale's account A (YOU) and Uni's account U (UNI), shared with each other.
// Run: npx playwright test --config playwright.mail.config.ts (desktop, phone, and the Daylight upright and sideways)
import { expect, test } from '@playwright/test';
import { backToThreads, boot, boxesHidden, KEY, mail, mailCmds, pickBox, rows, shot, stacked } from './mailMock';

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

/** T-208 follow-up (Codex r3 P2): a triage answer for the list before a Refresh, landing after it, is dropped. */
test("an old triage answer that lands after Refresh doesn't bring back the old note", async ({ page }) => {
  await page.addInitScript(() => { (window as any).__triageDelays = [2000]; });
  await boot(page);
  await expect(rows(page)).toHaveCount(6);
  await page.evaluate(() => { (window as any).__notes['A/a3'] = 'Changed: Mara picked Monday.'; });
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(rows(page).nth(0)).toContainText('Uni: Changed: Mara picked Monday.');
  await page.waitForTimeout(2300);
  await expect(rows(page).nth(0)).toContainText('Uni: Changed: Mara picked Monday.');
  await expect(rows(page).nth(0)).not.toContainText('Needs you');
});

/** Codex review 2, P1: when Uni's mailbox leaves the session, Refresh drops its rows and its open thread; none turns YOU. */
test("Refresh after Uni's mailbox stops being shared shows none of it, and never as YOU", async ({ page }) => {
  await boot(page);
  await rows(page).nth(1).click();
  await expect(page.getByRole('region', { name: 'Thread: Server report for Tuesday' })).toBeVisible();
  await backToThreads(page);
  // the list's reload is slow: until it lands, what is shown must already be only the mail of accounts still named
  await page.evaluate(() => { (window as any).__uniGone = true; (window as any).__threadsDelay = 2500; });
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(rows(page)).toHaveCount(3, { timeout: 1500 });
  for (const t of await rows(page).locator('.mail-who').allInnerTexts()) expect(t).toBe('YOU');
  await page.waitForTimeout(1500);
  await expect(rows(page)).toHaveCount(3);
  for (const t of await rows(page).locator('.mail-who').allInnerTexts()) expect(t).toBe('YOU');
  await expect(page.getByText('Monitor')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Thread: Server report for Tuesday' })).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

/** /code-review: a thread can reach into Junk; a message there says so. */
test('a message of a thread that sits in Junk says so', async ({ page }) => {
  await boot(page);
  await rows(page).nth(4).click();
  const thread = page.getByRole('region', { name: 'Thread: Your hold is ready' });
  await expect(thread.locator('.mail-card')).toHaveCount(2);
  await expect(thread.locator('.mail-card').nth(0).locator('.mail-place')).toHaveCount(0);
  await expect(thread.locator('.mail-card').nth(1)).toContainText('IN JUNK');
  await expect(thread.locator('.mail-card').nth(1)).toContainText('filed this message as junk');
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

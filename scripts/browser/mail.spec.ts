// T-45 Mail view (read-only here) against a mocked command layer that answers as the Rust commands do
// (crates/uni-core/tests/mail_accounts.rs runs those commands against a two-account JMAP double over real HTTP). The
// made-up mail matches that double: Robin Vale's account A and Uni's account U, shared with each other.
// T-335 v2: your Inbox is your account only; Uni's mail is its own tab. Ported from the v1 combined view.
// Run: npx playwright test --config playwright.mail.config.ts mail.spec (desktop, phone, and the Daylight upright and sideways)
import { expect, test, type Page } from '@playwright/test';
import { leaveMail, returnToMail } from './mailNav';
import { backToThreads, boot, KEY, mail, mailCmds, pickTab, rows, shot, stacked, tab } from './mailMock';


const thread = (page: Page, subject: string) => page.getByRole('region', { name: `Thread: ${subject}` });
const calls = (page: Page, cmd: string): Promise<any[]> => page.evaluate((c) => (window as any).__calls.filter((x: any) => x.cmd === c).map((x: any) => x.args), cmd);
const searches = (page: Page) => page.evaluate(() => (window as any).__calls.filter((c: any) => c.cmd === 'mail_threads' && c.args.text).map((c: any) => c.args));

test('the full flow: your Inbox, Uni\'s mail tab, open a thread, search, attachments, no writes offered', async ({ page }) => {
  await boot(page);
  const m = mail(page);
  await expect(m.getByText('robin@example.com · reading only')).toBeVisible();

  // 1. your Inbox: your account only, newest first
  await expect(tab(page, 'Inbox')).toHaveAttribute('aria-selected', 'true');
  await expect(rows(page)).toHaveCount(3);
  const order = ['Unread\\. Draft by Uni\\. Mara Quill: Re: Planning the garden week', 'Unread\\. Theo Brandt: Workshop photos', 'Riverside Library: Your hold'];
  for (const [i, name] of order.entries()) await expect(rows(page).nth(i)).toHaveAccessibleName(new RegExp(name));
  // no combined view, no mailbox column, no You/Uni chip on a row
  await expect(rows(page).locator('.mail-who')).toHaveCount(0);
  await expect(m.getByRole('navigation', { name: 'Mailboxes' })).toHaveCount(0);
  await expect(m.getByText('Server report')).toHaveCount(0);
  await expect(rows(page).nth(0)).toContainText('Uni: Needs you: Mara asks which day to start.');
  await expect(rows(page).nth(1)).toContainText('<b>Two files</b> pass the checks', { useInnerText: true });
  await expect(rows(page).nth(1).locator('b')).toHaveCount(0, { timeout: 1 });
  await expect(m.getByRole('heading', { level: 2 })).toHaveCount(0);
  await shot(page, '1-inbox');

  // Uni's mail is its own tab: only Uni's rows there, and back to your Inbox they are gone again
  await tab(page, "Uni's mail").click();
  await expect(tab(page, "Uni's mail")).toHaveAttribute('aria-selected', 'true');
  await expect(rows(page)).toHaveCount(3);
  await expect(rows(page).nth(0)).toHaveAccessibleName(/^Unread\. Monitor: Server report/);
  await expect(rows(page).nth(1)).toHaveAccessibleName(/Ada Moss: Question about the reading group/);
  await expect(rows(page).nth(2)).toHaveAccessibleName(/^Unread\. Billing: Invoice for October/);
  await expect(rows(page).filter({ hasText: 'garden week' })).toHaveCount(0);
  await expect(rows(page).nth(0)).toContainText('Uni: Routine. Nothing to do.');
  await shot(page, '2-unis-mail');
  // Uni's draft threads have no folder tab now: they are found by searching in Uni's mail
  await m.getByRole('searchbox', { name: 'Search mail' }).fill('reminder for thursday');
  await expect(m.locator('.mail-list-title strong')).toHaveText("Search in Uni's mail");
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toHaveAccessibleName(/Draft\. .*Ada Moss/);
  await m.getByRole('searchbox', { name: 'Search mail' }).fill('');
  await expect(rows(page)).toHaveCount(3);
  await tab(page, 'Inbox').click();
  await expect(rows(page)).toHaveCount(3);
  await expect(rows(page).filter({ hasText: 'Server report' })).toHaveCount(0);

  // 2. a thread: earlier messages fold, Uni's draft sits at the foot and says it was not sent, Uni's note is labelled
  // as Uni's, there is no Reply and no Edit and send
  await rows(page).nth(0).click();
  const t = thread(page, 'Planning the garden week');
  await expect(t.getByRole('heading', { name: 'Planning the garden week' })).toBeVisible();
  await expect(t.locator('.mail-thread-where')).toContainText('3 messages');
  await expect(t.locator('article.mail-msg')).toHaveCount(3);
  await expect(t.locator('article.mail-msg').nth(0)).toHaveAttribute('data-folded', 'true');
  await expect(t.locator('article.mail-msg').nth(2)).toContainText('which day should we start the beds');
  const foot = t.getByRole('region', { name: "Uni's draft reply" });
  await expect(foot).toContainText('Monday suits me. See you then.');
  await expect(foot).toContainText('not sent');
  await expect(foot).toContainText("Uni can't send as you");
  await expect(t.getByRole('note').filter({ hasText: "Uni's note" })).toContainText('Needs you: Mara asks which day to start.');
  await expect(t.getByRole('button', { name: /^Reply/ })).toHaveCount(0); // T-335 as Aaron: no grey button; the header says reading only
  await expect(foot.getByRole('button', { name: 'Edit and send' })).toHaveCount(0);
  await expect(t.getByText('Sending comes later', { exact: true })).toHaveCount(0);
  await shot(page, '3-thread');
  await foot.scrollIntoViewIfNeeded();
  await shot(page, '3b-uni-draft');
  await backToThreads(page);

  // 3. search: your mail only, one word; the Uni's mail tab searches Uni's account only
  const box = m.getByRole('searchbox', { name: 'Search mail' });
  await tab(page, "Uni's mail").click();
  await box.fill('lighthouse');
  await box.press('Enter');
  await expect(m.locator('.mail-list-title strong')).toHaveText("Search in Uni's mail");
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toHaveAccessibleName(/^Unread\. Monitor: Server report/);
  expect((await searches(page)).at(-1).sources.map((s: any) => s.account_id)).toEqual(['U']);
  await shot(page, '4-search');
  await tab(page, 'Inbox').click();
  await box.fill('marmalade');
  await box.press('Enter');
  await expect(m.locator('.mail-list-title strong')).toHaveText('Search in your mail');
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toHaveAccessibleName(/Mara Quill: Planning the garden week/, { timeout: 5000 });
  const last = (await searches(page)).at(-1);
  expect(last).toMatchObject({ text: 'marmalade' });
  expect(last.sources).toHaveLength(1);
  expect(last.sources[0]).toMatchObject({ account_id: 'A', mailbox_id: null, exclude: ['A-junk', 'A-trash'], position: 0 });
  await box.fill('');
  await expect(rows(page)).toHaveCount(3);

  // 4. attachments: a refusal by name shows at once and fetches nothing; one that passes opens; a disguised one is refused on Open
  await rows(page).nth(1).click();
  const files = thread(page, 'Workshop photos and slides').getByRole('list', { name: 'Attachments' });
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
  await pickTab(page, "Uni's mail");
  await rows(page).nth(2).click();
  await page.getByRole('button', { name: 'Open invoice-october.pdf' }).click();
  const lastOpen = await page.evaluate(() => (window as any).__calls.filter((c: any) => c.cmd === 'mail_attachment_open').at(-1).args);
  expect(lastOpen.accountId).toBe('U');
  await backToThreads(page);

  // 5. nothing to send: no New (not offered, not greyed)
  await expect(page.getByRole('button', { name: /^New/ })).toHaveCount(0);

  // only reads were asked of Rust
  expect(new Set(await mailCmds(page))).toEqual(new Set(['mail_overview', 'mail_threads', 'mail_thread', 'mail_triage', 'mail_attachment_open']));
});

test('on the Daylight nothing in Mail moves, and every target is at least 44 px', async ({ page }, info) => {
  test.skip(!info.project.name.startsWith('daylight'), 'the Daylight');
  // T-335: the Daylight is calm by its Settings switch (Calm screen), not by its user agent
  await page.addInitScript(() => localStorage.setItem('uni.motion', 'calm'));
  await boot(page);
  await expect(rows(page)).toHaveCount(3);
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
  await expect(rows(page)).toHaveCount(3);
  const moving = await page.evaluate(() => [...document.querySelectorAll('.mail *')].some((el) => {
    const s = getComputedStyle(el);
    return s.transitionDuration.split(',').some((d) => parseFloat(d) > 0) || (s.animationName !== 'none' && parseFloat(s.animationDuration) > 0);
  }));
  expect(moving).toBe(true);
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
  await rows(page).nth(2).click();
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
  await expect(rows(page).nth(1)).toContainText('Uni: <b>Two files</b> pass the checks');
  await page.evaluate(() => { const n = (window as any).__notes; delete n['A/a3']; n['A/a4'] = 'Checked again: the files still pass.'; n['U/u1'] = 'Checked again: still routine.'; });
  await mail(page).getByRole('button', { name: 'Refresh' }).click();
  await expect(rows(page).nth(1)).toContainText('Uni: Checked again: the files still pass.');
  await expect(rows(page).nth(0)).not.toContainText('Needs you');
  await expect(rows(page).nth(0).locator('.mail-row-preview')).toBeVisible();
  // and in Uni's mail
  await tab(page, "Uni's mail").click();
  await expect(rows(page).nth(0)).toContainText('Uni: Checked again: still routine.');
});

/** T-208 follow-up (Codex r3 P2): a triage answer for the list before a Refresh, landing after it, is dropped. */
test("an old triage answer that lands after Refresh doesn't bring back the old note", async ({ page }) => {
  await page.addInitScript(() => { (window as any).__triageDelays = [2000]; });
  await boot(page);
  await expect(rows(page)).toHaveCount(3);
  await page.evaluate(() => { (window as any).__notes['A/a3'] = 'Changed: Mara picked Monday.'; });
  await mail(page).getByRole('button', { name: 'Refresh' }).click();
  await expect(rows(page).nth(0)).toContainText('Uni: Changed: Mara picked Monday.');
  await page.waitForTimeout(2300);
  await expect(rows(page).nth(0)).toContainText('Uni: Changed: Mara picked Monday.');
  await expect(rows(page).nth(0)).not.toContainText('Needs you');
});

/** T-208 item 3: a slow triage answer for the first page, landing after Load older brought a newer note for the same
 *  row (new mail moved the account's position back over it), doesn't put the old note back. */
test("a stale triage answer doesn't overwrite a newer one for the same row", async ({ page }) => {
  // one thread per page, so your Inbox (three threads) has an older page to load
  await page.addInitScript(() => { (window as any).__triageDelays = [2500]; (window as any).__pageSize = 1; });
  await boot(page);
  await expect(rows(page)).toHaveCount(1);
  await page.evaluate(() => {
    const w = window as any;
    w.__notes['A/a3'] = 'Changed: Mara picked Monday.';
    // new mail in your Inbox: your account's next page now starts at the garden thread again
    w.__msgs.push({ id: 'a11', account: 'A', thread_id: 'Ta11', box: 'A-inbox', from: [{ name: 'Theo Brandt', email: 'theo@example.net' }], to: [{ name: 'Robin Vale', email: 'robin@example.com' }],
      cc: [], reply_to: [], subject: 'Tools for Saturday', received_at: '2026-10-19T10:00:00Z', sent_at: null, unread: true, flagged: false, draft: false, uni_drafted: false,
      mailbox_ids: ['A-inbox'], text: 'Bring the spades.', html: null, remote_images: 0, links: [], truncated: false, attachments: [], dmarc: null });
  });
  await mail(page).getByRole('button', { name: 'Load older' }).click();
  await expect(rows(page).nth(0)).toContainText('Uni: Changed: Mara picked Monday.');
  expect((await calls(page, 'mail_threads')).length, 'the older page was asked for').toBeGreaterThan(1);
  await page.waitForTimeout(2800);
  await expect(rows(page).nth(0)).toContainText('Uni: Changed: Mara picked Monday.');
  await expect(rows(page).nth(0)).not.toContainText('Needs you');
});

/** Codex review 2, P1: when Uni's mailbox leaves the session, Refresh drops its tab, its rows and its open thread. */
test("Refresh after Uni's mailbox stops being shared shows none of it, and never as yours", async ({ page }) => {
  await boot(page);
  await tab(page, "Uni's mail").click();
  await rows(page).nth(0).click();
  await expect(thread(page, 'Server report for Tuesday')).toBeVisible();
  await backToThreads(page);
  // the list's reload is slow: until it lands, what is shown must already be only the mail of accounts still named
  await page.evaluate(() => { (window as any).__uniGone = true; (window as any).__threadsDelay = 2500; });
  await mail(page).getByRole('button', { name: 'Refresh' }).click();
  await expect(tab(page, "Uni's mail")).toHaveCount(0, { timeout: 1500 });
  await expect(rows(page).filter({ hasText: 'Server report' })).toHaveCount(0);
  await page.waitForTimeout(1500);
  await expect(tab(page, 'Inbox')).toHaveAttribute('aria-selected', 'true');
  await expect(rows(page)).toHaveCount(3);
  for (const t of await rows(page).allInnerTexts()) expect(t).not.toMatch(/Monitor|Server report|reading group|Invoice for October/);
  await expect(page.getByText('Monitor')).toHaveCount(0);
  await expect(thread(page, 'Server report for Tuesday')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

/** /code-review: a thread can reach into Junk; a message there says so. */
test('a message of a thread that sits in Junk says so', async ({ page }) => {
  await boot(page);
  await rows(page).nth(2).click();
  const t = thread(page, 'Your hold is ready');
  await expect(t.locator('article.mail-msg')).toHaveCount(2);
  await expect(t.locator('article.mail-msg').nth(0).locator('.mail-place')).toHaveCount(0);
  await expect(t.locator('article.mail-msg').nth(1)).toContainText('In Junk');
  await expect(t.locator('article.mail-msg').nth(1)).toContainText('Filed as junk. Treat its links and files with care.');
});

test("Uni's own draft, in Uni's mail, reads as Uni's and not sent", async ({ page }) => {
  await boot(page);
  await tab(page, "Uni's mail").click();
  await rows(page).filter({ hasText: 'reading group' }).click();
  const t = thread(page, 'Question about the reading group');
  await expect(t.locator('.mail-thread-where')).toContainText("In Uni's mail · 2 messages");
  await expect(t.locator('article.mail-msg').filter({ hasText: "Uni's own draft · not sent" })).toHaveCount(1);
  await expect(t.getByRole('note').filter({ hasText: "Uni's note" })).toHaveCount(0);
});

test('a v1 bridge shows one mailbox and no Uni\'s mail tab', async ({ page }) => {
  await boot(page, 'one_account');
  await expect(rows(page)).toHaveCount(3);
  await expect(tab(page, 'Inbox')).toHaveAttribute('aria-selected', 'true');
  await expect(tab(page, "Uni's mail")).toHaveCount(0);
  await expect(page.getByText('Server report')).toHaveCount(0);
  const sources = await page.evaluate(() => (window as any).__calls.find((c: any) => c.cmd === 'mail_threads').args.sources);
  expect(sources).toHaveLength(1);
  expect(sources[0]).toMatchObject({ account_id: 'A', exclude: [], position: 0 });
  expect(sources.every((s: any) => s.account_id === 'A')).toBe(true);
});

test('a device the bridge does not allow is told so, with its key, and Retry recovers', async ({ page }) => {
  await boot(page, 'not_allowed');
  const alert = page.getByRole('alert');
  await expect(alert.getByText("This device isn't allowed to read mail yet.")).toBeVisible();
  await expect(alert.getByText(KEY)).toBeVisible();
  await expect(alert.getByRole('button', { name: 'Copy key' })).toBeVisible();
  await page.evaluate(() => { (window as any).__mailMode = 'ok'; });
  await alert.getByRole('button', { name: 'Retry' }).click();
  await expect(rows(page)).toHaveCount(3);
});

test('a bridge that is down is named, not shown as an empty inbox', async ({ page }) => {
  await boot(page, 'unreachable');
  await expect(page.getByRole('alert').getByText("Mail isn't reachable right now.")).toBeVisible();
  await expect(page.getByText('Nothing here.')).toHaveCount(0);
  await expect(page.getByText('Nothing new. The Inbox is clear.')).toHaveCount(0);
});

test('a thread that failed to open leaves no error behind after switching tab', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => { (window as any).__threadFails = true; });
  await rows(page).first().click();
  await expect(page.getByRole('alert').getByText("The mail server didn't answer.")).toBeVisible();
  await pickTab(page, 'Archive');
  await expect(page.getByText('Nothing here.')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('on a phone one pane shows at a time; Search sits at the top of the list; Back returns to it', async ({ page }) => {
  test.skip(!stacked(page), 'phone layout');
  await boot(page);
  await expect(page.locator('.mail-boxes')).toHaveCount(0);
  // the bottom Search/New bar is gone; the list has its own search field
  await expect(page.getByRole('navigation', { name: 'Mail actions' })).toHaveCount(0);
  await expect(mail(page).getByRole('searchbox', { name: 'Search mail' })).toBeVisible();
  await rows(page).first().click();
  await expect(page.locator('.mail-list')).toBeHidden();
  await expect(mail(page).getByRole('tablist', { name: 'Mail places' })).toBeHidden();
  await expect(mail(page).locator('.mail-thread-back:visible')).toHaveText('← Inbox');
  await mail(page).locator('.mail-thread-back:visible').click();
  await expect(page.locator('.mail-list')).toBeVisible();
  await expect(tab(page, 'Inbox')).toBeVisible();
  await expect(mail(page).getByRole('searchbox', { name: 'Search mail' })).toBeVisible();
});

test('leaving Mail and coming back returns to the same thread', async ({ page }) => {
  await boot(page);
  await rows(page).nth(1).click();
  await expect(thread(page, 'Workshop photos and slides')).toBeVisible();
  await leaveMail(page);
  await returnToMail(page);
  await expect(thread(page, 'Workshop photos and slides')).toBeVisible();
});

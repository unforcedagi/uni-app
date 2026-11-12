// T-335 Mail v2: Mail shaped like the job (triage a morning inbox, read, answer with Uni's draft, search, archive), not
// like the server's folders. Your Inbox first, places as tabs like Messages, Uni's own mail out of your morning, a thread
// that reads like a conversation, Uni's draft as the reply, Archive and Later that open the next thread.
// Against the mocked command layer (mailMock.ts: Robin Vale's account A and Uni's account U, made up), on the desktop,
// a phone and the Daylight both ways. Run: npx playwright test --config playwright.mail.config.ts mail-v2
import { expect, test, type Page } from '@playwright/test';
import { backToThreads as back, boot, mail, rows, shot, stacked, tab } from './mailMock';

const thread = (page: Page, subject: string) => page.getByRole('region', { name: `Thread: ${subject}` });
const calls = (page: Page, cmd: string): Promise<any[]> => page.evaluate((c) => (window as any).__calls.filter((x: any) => x.cmd === c).map((x: any) => x.args), cmd);

test('the morning: your Inbox first, as tabs, in two-line rows, with Uni\'s own mail left out', async ({ page }) => {
  await boot(page, 'ok', { writes: true, held: true });
  const m = mail(page);
  await expect(tab(page, 'Inbox')).toHaveAttribute('aria-selected', 'true');
  for (const t of ['Later', 'Waiting', 'Drafts', 'Sent', 'Archive', 'Junk', "Uni's mail"]) await expect(tab(page, t)).toBeVisible();
  await expect(tab(page, 'Waiting')).toHaveAccessibleName(/2 waiting/);
  // your Inbox only: no row of Uni's account, no folder tree, no You/Uni chip on a row
  await expect(rows(page)).toHaveCount(3);
  await expect(rows(page).nth(0)).toHaveAccessibleName(/^Unread\. Draft by Uni\. Mara Quill: Re: Planning the garden week/);
  await expect(rows(page).filter({ hasText: 'Server report' })).toHaveCount(0);
  await expect(m.getByRole('navigation', { name: 'Mailboxes' })).toHaveCount(0);
  await expect(rows(page).locator('.mail-who')).toHaveCount(0);
  await expect(rows(page).nth(0)).toContainText('Uni: Needs you: Mara asks which day to start.');
  // compact: the first row starts close under the frame's head
  const top = await rows(page).first().evaluate((e) => e.getBoundingClientRect().top);
  expect(top, 'little chrome before the first row').toBeLessThan(200);
  await shot(page, 'v2-1-inbox');
  // Uni's mail is one tab away, and only there
  await tab(page, "Uni's mail").click();
  await expect(rows(page).filter({ hasText: 'Server report' })).toHaveCount(1);
  await expect(rows(page).filter({ hasText: 'garden week' })).toHaveCount(0);
});

test('reading: earlier messages fold, the newest is open, headers are one line, quoted text folds', async ({ page }) => {
  await boot(page, 'ok', { writes: true });
  await rows(page).filter({ hasText: 'garden week' }).click();
  const t = thread(page, 'Planning the garden week');
  await expect(t.getByRole('heading', { name: 'Planning the garden week' })).toBeVisible();
  // the two read messages fold to one line each; the unread newest is open
  await expect(t.locator('.mail-msg[data-folded="true"]')).toHaveCount(2);
  await expect(t.getByText('which day should we start the beds')).toBeVisible();
  await expect(t.locator('.mail-text', { hasText: 'marmalade jars' })).toHaveCount(0);
  await t.getByRole('button', { name: /^Mara Quill, Sun/ }).click();
  await expect(t.locator('.mail-text', { hasText: 'marmalade jars' })).toBeVisible();
  // one line of who and when; the addresses on request
  const open = t.locator('.mail-msg[data-folded="false"]').last();
  await expect(open.locator('.mail-msg-who')).toContainText('Mara Quill');
  await expect(open.locator('.mail-msg-who')).toContainText('to you');
  await expect(open.getByText('mara@example.org')).toBeHidden();
  await open.getByRole('button', { name: 'Details' }).click();
  await expect(open.getByText('mara@example.org')).toBeVisible();
  // the quoted history under her reply folds
  await expect(open.getByText('> Saturday works. Bring the jars.')).toHaveCount(0);
  await open.getByRole('button', { name: 'Show quoted text' }).click();
  await expect(open.getByText('> Saturday works. Bring the jars.')).toBeVisible();
  await shot(page, 'v2-2-thread');
});

test('Uni\'s draft is the reply: it sits at the foot of the thread, and Reply opens it under the conversation', async ({ page }) => {
  await boot(page, 'ok', { writes: true });
  await rows(page).filter({ hasText: 'garden week' }).click();
  const t = thread(page, 'Planning the garden week');
  const foot = t.getByRole('region', { name: "Uni's draft reply" });
  await expect(foot).toContainText('Monday suits me. See you then.');
  await expect(foot).toContainText('not sent');
  await expect(foot).toContainText('1 older draft');
  // the draft is said once: no hint box at the top, no draft card per draft
  await expect(t.locator('.mail-draft-hint')).toHaveCount(0);
  await t.getByRole('button', { name: /^Reply/ }).first().click();
  const composer = page.getByRole('region', { name: "Review Uni's draft" });
  await expect(composer.getByRole('textbox', { name: 'Message' })).toHaveValue('Monday suits me. See you then.\n\nRobin');
  // written under the conversation: the thread is still there above it
  await expect(t.getByRole('heading', { name: 'Planning the garden week' })).toBeAttached();
  await expect(t.getByText('which day should we start the beds')).toBeAttached();
  const order = await page.evaluate(() => {
    const h = document.querySelector('.mail-subject'), c = document.querySelector('.mail-compose');
    return !!h && !!c && !!(h.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(order, 'the composer comes after the thread').toBe(true);
  await shot(page, 'v2-3-reply-draft');
  // Write my own: a blank reply to the same thread
  await composer.getByRole('button', { name: /Close/ }).click();
  await t.getByRole('button', { name: 'Write my own' }).click();
  const own = page.getByRole('region', { name: 'Reply' });
  await expect(own.getByRole('textbox', { name: 'Message' })).toHaveValue('');
  await expect(own.getByRole('textbox', { name: 'To' })).toHaveValue('Mara Quill <mara@example.org>');
});

test('search runs as you type, closes the open thread, and Files lists mail with attachments', async ({ page }) => {
  await boot(page, 'ok', { writes: true });
  await rows(page).filter({ hasText: 'garden week' }).click();
  await back(page);
  const box = mail(page).getByRole('searchbox', { name: 'Search mail' });
  await box.fill('marmalade');
  // no Enter: it searches after a pause, in your mail, less Junk
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toHaveAccessibleName(/Mara Quill: Planning the garden week/);
  await expect(page.getByRole('region', { name: /^Thread: / })).toHaveCount(0);
  const last = (await calls(page, 'mail_threads')).at(-1);
  expect(last.text).toBe('marmalade');
  expect(last.sources.map((s: any) => s.account_id)).toEqual(['A']);
  await shot(page, 'v2-4-search');
  await box.fill('');
  await expect(rows(page)).toHaveCount(3);
  await mail(page).getByRole('button', { name: 'Files', exact: true }).click();
  await expect(mail(page).getByRole('button', { name: 'Files', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toHaveAccessibleName(/Theo Brandt: Workshop photos and slides/);
  expect((await calls(page, 'mail_threads')).at(-1).sources[0].with_files).toBe(true);
  await rows(page).first().click();
  await expect(thread(page, 'Workshop photos and slides').getByRole('button', { name: /^Open workshop-notes\.pdf/ })).toBeVisible();
});

test('Archive takes the thread out and opens the next one; Later moves it to Later and back', async ({ page }) => {
  await boot(page, 'ok', { writes: true });
  await rows(page).filter({ hasText: 'Workshop photos' }).click();
  const t = thread(page, 'Workshop photos and slides');
  await t.getByRole('button', { name: 'Archive' }).click();
  await expect(thread(page, 'Your hold is ready')).toBeVisible();
  await expect(rows(page).filter({ hasText: 'Workshop photos' })).toHaveCount(0);
  expect((await calls(page, 'mail_archive')).at(-1)).toEqual({ accountId: 'A', emailIds: ['a4'] });
  await shot(page, 'v2-5-archived-next');
  // Later: out of the Inbox, into Later (the flag on each of its messages), and the next thread opens (none left
  // below it: the one above)
  await thread(page, 'Your hold is ready').getByRole('button', { name: 'Later' }).click();
  await expect(thread(page, 'Planning the garden week')).toBeVisible();
  await expect(rows(page).filter({ hasText: 'hold is ready' })).toHaveCount(0);
  expect((await calls(page, 'mail_flag')).at(-1)).toMatchObject({ accountId: 'A', flagged: true, emailIds: ['a5', 'a9'] });
  await back(page);
  await expect(tab(page, 'Later')).toHaveAccessibleName(/1 put off/);
  await tab(page, 'Later').click();
  await expect(rows(page)).toHaveCount(1);
  await rows(page).first().click();
  await thread(page, 'Your hold is ready').getByRole('button', { name: 'Back to Inbox' }).click();
  // nothing left in Later: back to its (empty) list
  await expect(rows(page)).toHaveCount(0);
  await expect(mail(page).getByText('Nothing put off for later.')).toBeVisible();
  await expect(tab(page, 'Later')).toHaveAccessibleName('Later');
  await tab(page, 'Inbox').click();
  await expect(rows(page).filter({ hasText: 'hold is ready' })).toHaveCount(1);
});

test('Waiting holds Uni\'s held sends, one tab away', async ({ page }) => {
  await boot(page, 'ok', { writes: true, held: true });
  await tab(page, 'Waiting').click();
  await expect(page.locator('.mail-held-row')).toHaveCount(2);
  await page.locator('.mail-held-row').first().click();
  await expect(page.getByRole('region', { name: /^Held send: / })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Send it/ })).toBeVisible();
});

// ── T-335 review: each a bug the fresh review found, reproduced ─────────────────────────────────────────────────────

test('a reply being written waits with Resume when a tab, a search or Files takes its thread away', async ({ page }) => {
  await boot(page, 'ok', { writes: true });
  await rows(page).filter({ hasText: 'garden week' }).click();
  await thread(page, 'Planning the garden week').getByRole('button', { name: 'Write my own' }).click();
  await page.getByRole('region', { name: 'Reply' }).getByRole('textbox', { name: 'Message' }).fill('Tuesday, then.');
  await back(page);
  await tab(page, 'Later').click();
  const resume = mail(page).getByRole('button', { name: /A message in progress · Resume/ });
  await expect(resume).toBeVisible();
  await resume.click();
  // it comes back under its own thread, with what was typed
  await expect(thread(page, 'Planning the garden week')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Reply' }).getByRole('textbox', { name: 'Message' })).toHaveValue('Tuesday, then.');
});

test('your own draft stays in sight beside Uni\'s at the foot of the thread', async ({ page }) => {
  await boot(page, 'ok', { writes: true });
  await page.evaluate(() => {
    const w = window as any;
    w.__msgs.push({ ...w.__msgs.find((m: any) => m.id === 'a6'), id: 'a11', uni_drafted: false, received_at: '2026-10-19T09:10:00Z', text: 'Half a thought about the beds.' });
  });
  await rows(page).filter({ hasText: 'garden week' }).click();
  const t = thread(page, 'Planning the garden week');
  await expect(t.getByRole('region', { name: 'Your draft' })).toContainText('Half a thought about the beds.');
  await expect(t.getByRole('region', { name: "Uni's draft reply" })).toContainText('Monday suits me.');
});

test('a thread another client flagged in part is in Later, not the Inbox, until something new arrives', async ({ page }) => {
  await boot(page, 'ok', { writes: true });
  // only the oldest message of the garden thread is flagged, and its newest is read: put off, nothing new
  await page.evaluate(() => { const w = window as any; for (const m of w.__msgs) { if (m.id === 'a1') m.flagged = true; if (m.id === 'a3') m.unread = false; } });
  await mail(page).getByRole('button', { name: 'Refresh' }).click();
  await expect(rows(page).filter({ hasText: 'garden week' })).toHaveCount(0);
  await tab(page, 'Later').click();
  await expect(rows(page).filter({ hasText: 'garden week' })).toHaveCount(1);
  // a new message arrives on it: back in the Inbox, marked Later
  await page.evaluate(() => { const w = window as any; w.__msgs.push({ ...w.__msgs.find((m: any) => m.id === 'a3'), id: 'a12', flagged: false, unread: true, received_at: '2026-10-19T12:00:00Z', text: 'Also: bring gloves.' }); });
  await tab(page, 'Inbox').click();
  await expect(rows(page).filter({ hasText: 'garden week' })).toHaveAccessibleName(/^Unread\. Later\./);
  // reading it takes it out of Later, so it stays in the Inbox once read
  await rows(page).filter({ hasText: 'garden week' }).click();
  await expect.poll(async () => (await calls(page, 'mail_flag')).at(-1)).toMatchObject({ accountId: 'A', flagged: false, emailIds: ['a1'] });
  await back(page);
  await mail(page).getByRole('button', { name: 'Refresh' }).click();
  await expect(rows(page).filter({ hasText: 'garden week' })).toHaveCount(1);
  await expect(tab(page, 'Later')).toHaveAccessibleName('Later');
});

test('unread messages stay open once opening the thread marks them read', async ({ page }) => {
  await boot(page, 'ok', { writes: true });
  await page.evaluate(() => { const w = window as any; w.__msgs.push({ ...w.__msgs.find((m: any) => m.id === 'a3'), id: 'a12', received_at: '2026-10-19T12:00:00Z', text: 'Also: bring gloves.' }); });
  await mail(page).getByRole('button', { name: 'Refresh' }).click();
  await rows(page).filter({ hasText: 'garden week' }).click();
  await expect.poll(async () => (await calls(page, 'mail_mark_seen')).length).toBe(1);
  const t = thread(page, 'Planning the garden week');
  await expect(t.locator('.mail-msg[data-folded="false"]')).toHaveCount(2);
  await expect(t.getByText('which day should we start the beds')).toBeVisible();
});

test('Later from a search keeps the thread in the results; Later says what it holds and counts with one row', async ({ page }) => {
  await boot(page, 'ok', { writes: true });
  const box = mail(page).getByRole('searchbox', { name: 'Search mail' });
  await box.fill('marmalade');
  await expect(rows(page)).toHaveCount(1);
  await rows(page).first().click();
  await thread(page, 'Planning the garden week').getByRole('button', { name: 'Later' }).click();
  await expect.poll(async () => (await calls(page, 'mail_flag')).length).toBe(1);
  await back(page);
  await expect(rows(page)).toHaveCount(1);
  await box.fill('');
  await tab(page, 'Later').click();
  await expect(mail(page).getByText(/^Flagged mail: put off here, or flagged in another mail app/)).toBeVisible();
  const counts = (await calls(page, 'mail_threads')).filter((c) => c.limit === 1);
  expect(counts.length).toBeGreaterThan(0);
  expect(counts[0].sources[0].flagged).toBe(true);
});

test('an archive that lands while taking it out of Later fails says so, and the archive stands', async ({ page }) => {
  await boot(page, 'ok', { writes: true });
  await rows(page).filter({ hasText: 'Workshop photos' }).click();
  await thread(page, 'Workshop photos and slides').getByRole('button', { name: 'Later' }).click();
  await back(page);
  await tab(page, 'Later').click();
  await rows(page).filter({ hasText: 'Workshop photos' }).click();
  await page.evaluate(() => { (window as any).__flagFails = 1; });
  await thread(page, 'Workshop photos and slides').getByRole('button', { name: 'Archive' }).click();
  await expect(mail(page).getByRole('alert')).toContainText('Archived, but it is still in Later');
  expect((await calls(page, 'mail_archive')).length).toBe(1);
});

test('Enter searches at once, and the pause after typing doesn\'t close the thread opened from the results', async ({ page }) => {
  await boot(page, 'ok', { writes: true });
  const box = mail(page).getByRole('searchbox', { name: 'Search mail' });
  await box.fill('marmalade');
  await box.press('Enter');
  await rows(page).first().click();
  await expect(thread(page, 'Planning the garden week')).toBeVisible();
  await page.waitForTimeout(700);
  await expect(thread(page, 'Planning the garden week')).toBeVisible();
});

// ── T-335 third review ──────────────────────────────────────────────────────────────────────────────────────────────

test('a search from Junk finds what is in Junk', async ({ page }) => {
  await boot(page, 'ok', { writes: true });
  await back(page);
  await tab(page, 'Junk').click();
  await expect(rows(page).filter({ hasText: 'Free marmalade for life' })).toHaveCount(1);
  await mail(page).getByRole('searchbox', { name: 'Search mail' }).fill('prize');
  await expect(mail(page).locator('.mail-list-title')).toContainText('Search in your mail');
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toHaveAccessibleName(/Prize Desk: Free marmalade for life/);
});

test('Archive from a search keeps the thread in the results, filed', async ({ page }) => {
  await boot(page, 'ok', { writes: true });
  await mail(page).getByRole('searchbox', { name: 'Search mail' }).fill('workshop');
  await expect(rows(page)).toHaveCount(1);
  await rows(page).first().click();
  await thread(page, 'Workshop photos and slides').getByRole('button', { name: 'Archive' }).click();
  await expect.poll(async () => (await calls(page, 'mail_archive')).length).toBe(1);
  await expect(thread(page, 'Workshop photos and slides')).toBeVisible();
  await back(page);
  await expect(rows(page)).toHaveCount(1);
});

test('the thread opened after an Archive is not taken out of Later: only one you open yourself is', async ({ page }) => {
  await boot(page, 'ok', { writes: true });
  // the hold thread is a Later thread with something new on it, just below the workshop thread
  await page.evaluate(() => { const w = window as any; w.__msgs.find((m: any) => m.id === 'a5').flagged = true;
    w.__msgs.push({ ...w.__msgs.find((m: any) => m.id === 'a5'), id: 'a13', flagged: false, unread: true, html: null, text: 'Your hold expires Friday.', received_at: '2026-10-16T18:00:00Z' }); });
  await mail(page).getByRole('button', { name: 'Refresh' }).click();
  await expect(rows(page).filter({ hasText: 'hold is ready' })).toHaveAccessibleName(/^Unread\. Later\./);
  await rows(page).filter({ hasText: 'Workshop photos' }).click();
  await thread(page, 'Workshop photos and slides').getByRole('button', { name: 'Archive' }).click();
  await expect(thread(page, 'Your hold is ready')).toBeVisible();
  await page.waitForTimeout(400);
  expect((await calls(page, 'mail_flag')).filter((c) => c.flagged === false)).toHaveLength(0);
});

test('a Refresh keeps the messages you just read open', async ({ page }) => {
  test.skip(stacked(page), 'Refresh sits on the list on a phone');
  await boot(page, 'ok', { writes: true });
  await page.evaluate(() => { const w = window as any; w.__msgs.push({ ...w.__msgs.find((m: any) => m.id === 'a3'), id: 'a12', received_at: '2026-10-19T12:00:00Z', text: 'Also: bring gloves.' }); });
  await mail(page).getByRole('button', { name: 'Refresh' }).click();
  await rows(page).filter({ hasText: 'garden week' }).click();
  await expect.poll(async () => (await calls(page, 'mail_mark_seen')).length).toBe(1);
  const t = thread(page, 'Planning the garden week');
  await expect(t.locator('.mail-msg[data-folded="false"]')).toHaveCount(2);
  await mail(page).getByRole('button', { name: 'Refresh' }).click();
  await expect.poll(async () => (await calls(page, 'mail_thread')).length).toBeGreaterThan(1);
  await page.waitForTimeout(300);
  await expect(t.locator('.mail-msg[data-folded="false"]')).toHaveCount(2);
});

// ── T-335 fourth review ─────────────────────────────────────────────────────────────────────────────────────────────

test('Load older after a Later still brings every thread: none is skipped', async ({ page }) => {
  await page.addInitScript(() => { (window as any).__pageSize = 2; });
  await boot(page, 'ok', { writes: true });
  await expect(rows(page)).toHaveCount(2);
  await rows(page).filter({ hasText: 'garden week' }).click();
  await thread(page, 'Planning the garden week').getByRole('button', { name: 'Later' }).click();
  await expect(thread(page, 'Workshop photos and slides')).toBeVisible();
  await back(page);
  await mail(page).getByRole('button', { name: 'Load older' }).click();
  await expect(rows(page).filter({ hasText: 'hold is ready' })).toHaveCount(1);
});

test('the thread that opens after an Archive stays unread until you open it', async ({ page }) => {
  await boot(page, 'ok', { writes: true });
  await page.evaluate(() => { (window as any).__msgs.find((m: any) => m.id === 'a5').unread = true; });
  await mail(page).getByRole('button', { name: 'Refresh' }).click();
  await rows(page).filter({ hasText: 'Workshop photos' }).click();
  await expect.poll(async () => (await calls(page, 'mail_mark_seen')).length).toBe(1);
  await thread(page, 'Workshop photos and slides').getByRole('button', { name: 'Archive' }).click();
  await expect(thread(page, 'Your hold is ready')).toBeVisible();
  await page.waitForTimeout(400);
  expect((await calls(page, 'mail_mark_seen')).filter((c) => c.emailIds.includes('a5'))).toHaveLength(0);
});

test('where the bridge offers no flag there is no Later: the Inbox is whole, and opening a flagged thread reads it', async ({ page }) => {
  await boot(page, 'ok', { ops: { A: ['mark_seen', 'archive'], U: [] } });
  await page.evaluate(() => { const w = window as any; w.__msgs.find((m: any) => m.id === 'a1').flagged = true; w.__msgs.find((m: any) => m.id === 'a3').unread = false; });
  await mail(page).getByRole('button', { name: 'Refresh' }).click();
  await expect(tab(page, 'Later')).toHaveCount(0);
  // flagged elsewhere and read: still in the Inbox (nothing here could bring it back from a Later)
  await expect(rows(page).filter({ hasText: 'garden week' })).toHaveCount(1);
  expect((await calls(page, 'mail_threads')).at(-1).sources[0].flagged).toBeUndefined();
});
// ── T-335 fifth review ──────────────────────────────────────────────────────────────────────────────────────────────

test('an Archive from a search that lands after you opened another thread leaves that one on screen', async ({ page }) => {
  await boot(page, 'ok', { writes: true });
  await mail(page).getByRole('searchbox', { name: 'Search mail' }).fill('example');
  await expect(mail(page).locator('.mail-list-title')).toContainText('Search in your mail');
  await expect(rows(page).filter({ hasText: 'Workshop photos' })).toHaveCount(1);
  await rows(page).filter({ hasText: 'Workshop photos' }).click();
  await page.evaluate(() => { (window as any).__archiveDelay = 800; });
  await thread(page, 'Workshop photos and slides').getByRole('button', { name: 'Archive' }).click();
  await back(page);
  await rows(page).filter({ hasText: 'hold is ready' }).click();
  await expect(thread(page, 'Your hold is ready')).toBeVisible();
  await expect.poll(async () => (await calls(page, 'mail_archive')).length).toBe(1);
  await page.waitForTimeout(1200);
  await expect(thread(page, 'Your hold is ready')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Thread: Workshop photos and slides' })).toHaveCount(0);
});

test('Later puts a thread off as seen: no unread count is left with no row to clear it', async ({ page }) => {
  await boot(page, 'ok', { writes: true });
  await rows(page).filter({ hasText: 'garden week' }).click();
  const t = thread(page, 'Planning the garden week');
  await t.getByRole('button', { name: 'Unread', exact: true }).click();
  await expect(t.getByRole('button', { name: 'Mark read' })).toBeVisible();
  await t.getByRole('button', { name: 'Later', exact: true }).click();
  await expect.poll(async () => (await calls(page, 'mail_mark_seen')).at(-1)).toEqual({ accountId: 'A', emailIds: ['a3'], seen: true });
  expect((await calls(page, 'mail_flag')).at(-1)).toMatchObject({ flagged: true });
});

test('Mark read on a Later thread that new mail brought back takes it out of Later first', async ({ page }) => {
  await boot(page, 'ok', { writes: true });
  await page.evaluate(() => { const w = window as any; w.__msgs.find((m: any) => m.id === 'a5').flagged = true;
    w.__msgs.push({ ...w.__msgs.find((m: any) => m.id === 'a5'), id: 'a13', flagged: false, unread: true, html: null, text: 'Your hold expires Friday.', received_at: '2026-10-16T18:00:00Z' }); });
  await mail(page).getByRole('button', { name: 'Refresh' }).click();
  await rows(page).filter({ hasText: 'Workshop photos' }).click();
  await thread(page, 'Workshop photos and slides').getByRole('button', { name: 'Archive' }).click();
  // opened after the Archive: not chosen, so still unread and still in Later
  const hold = thread(page, 'Your hold is ready');
  await hold.getByRole('button', { name: 'Mark read' }).click();
  await expect.poll(async () => (await calls(page, 'mail_mark_seen')).length).toBeGreaterThan(1);
  const flags = await calls(page, 'mail_flag');
  expect(flags.at(-1)).toMatchObject({ accountId: 'A', flagged: false, emailIds: ['a5'] });
  await expect(hold.getByRole('button', { name: 'Later', exact: true })).toBeVisible();
});

// ── T-335 ship review: should-fix ───────────────────────────────────────────────────────────────────────────────────

for (const late of [false, true]) test(`an Archive while Load older is on its way (${late ? 'the archive reaches the server first' : 'the page is read first'}): the archived thread stays out, and nothing is skipped`, async ({ page }) => {
  test.skip(stacked(page), 'the list and the thread side by side');
  await page.addInitScript(() => { (window as any).__pageSize = 1; });
  await boot(page, 'ok', { writes: true });
  await expect(rows(page)).toHaveCount(1);
  await rows(page).first().click();
  await expect(thread(page, 'Planning the garden week')).toBeVisible();
  await page.evaluate((late) => { (window as any).__threadsDelay = 1200; (window as any).__threadsLate = late; }, late);
  await mail(page).getByRole('button', { name: 'Load older' }).click();
  await thread(page, 'Planning the garden week').getByRole('button', { name: 'Archive' }).click();
  await expect.poll(async () => (await calls(page, 'mail_archive')).length).toBe(1);
  await expect(rows(page).filter({ hasText: 'Workshop photos' })).toHaveCount(1, { timeout: 5000 });
  await expect(rows(page).filter({ hasText: 'garden week' })).toHaveCount(0);
  await page.evaluate(() => { (window as any).__threadsDelay = 0; (window as any).__threadsLate = false; });
  await mail(page).getByRole('button', { name: 'Load older' }).click();
  await expect(rows(page).filter({ hasText: 'hold is ready' })).toHaveCount(1);
  // newest first, wherever a thread came back from
  const order = await rows(page).locator('.mail-row-subject').allInnerTexts();
  expect(order).toEqual(['Workshop photos and slides', 'Your hold is ready']);
});

test('Later on a thread of 150 messages flags them a hundred at a time', async ({ page }) => {
  await boot(page, 'ok', { writes: true });
  await page.evaluate(() => { const w = window as any; const a3 = w.__msgs.find((m: any) => m.id === 'a3');
    for (let i = 0; i < 147; i++) w.__msgs.push({ ...a3, id: `long${i}`, unread: false, received_at: `2026-10-18T${String(10 + (i % 10)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00Z` }); });
  await mail(page).getByRole('button', { name: 'Refresh' }).click();
  await rows(page).filter({ hasText: 'garden week' }).click();
  await thread(page, 'Planning the garden week').getByRole('button', { name: 'Later', exact: true }).click();
  await expect.poll(async () => (await calls(page, 'mail_flag')).length).toBe(2);
  expect((await calls(page, 'mail_flag')).map((c) => c.emailIds.length)).toEqual([100, 50]);
});

test('in the Inbox, Later on a thread new mail brought back puts it off again', async ({ page }) => {
  await boot(page, 'ok', { writes: true });
  await page.evaluate(() => { const w = window as any; w.__msgs.find((m: any) => m.id === 'a5').flagged = true;
    w.__msgs.push({ ...w.__msgs.find((m: any) => m.id === 'a5'), id: 'a13', flagged: false, unread: true, html: null, text: 'Your hold expires Friday.', received_at: '2026-10-16T18:00:00Z' }); });
  await mail(page).getByRole('button', { name: 'Refresh' }).click();
  await rows(page).filter({ hasText: 'Workshop photos' }).click();
  await thread(page, 'Workshop photos and slides').getByRole('button', { name: 'Archive' }).click();
  const hold = thread(page, 'Your hold is ready');
  await expect(hold.getByRole('button', { name: 'Back to Inbox' })).toHaveCount(0);
  await hold.getByRole('button', { name: 'Later', exact: true }).click();
  await expect.poll(async () => (await calls(page, 'mail_flag')).at(-1)).toMatchObject({ flagged: true });
  await back(page);
  await expect(rows(page).filter({ hasText: 'hold is ready' })).toHaveCount(0);
});

// T-335 Mail v2: Mail shaped like the job (triage a morning inbox, read, answer with Uni's draft, search, archive), not
// like the server's folders. Your Inbox first, places as tabs like Messages, Uni's own mail out of your morning, a thread
// that reads like a conversation, Uni's draft as the reply, Archive and Later that open the next thread.
// Against the mocked command layer (mailMock.ts: Robin Vale's account A and Uni's account U, made up), on the desktop,
// a phone and the Daylight both ways. Run: npx playwright test --config playwright.mail.config.ts mail-v2
import { expect, test, type Page } from '@playwright/test';
import { backToThreads as back, boot, mail, rows, shot, tab } from './mailMock';

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

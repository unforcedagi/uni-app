// T-210 Mail writes against the two-account double that accepts writes (mailMock.ts, `{ writes: true }`): reading
// state, flags and archive; a Uni draft reviewed and sent by you; a new message whose sender you must pick; replies
// that go from the thread's mailbox; a retry that is the same send; outcomes that block; the "not verified" badge.
// Run: npx playwright test --config playwright.mail.config.ts (desktop, phone, and the Daylight upright and sideways)
import { expect, test, type Page } from '@playwright/test';
import { backToThreads, boot, mail, rows, shot, stacked } from './mailMock';

const calls = (page: Page, cmd: string): Promise<any[]> => page.evaluate((c) => (window as any).__calls.filter((x: any) => x.cmd === c).map((x: any) => x.args), cmd);
const submissions = (page: Page): Promise<any[]> => page.evaluate(() => (window as any).__submissions);
const row = (page: Page, text: string) => rows(page).filter({ hasText: text });
const writeCmds = ['mail_mark_seen', 'mail_flag', 'mail_archive', 'mail_draft_save', 'mail_draft_review', 'mail_draft_discard', 'mail_send', 'mail_send_as_uni', 'mail_send_check'];

/** The New button in reach: the list head on a wide screen, the bottom bar on a phone. */
const newButton = (page: Page) => (stacked(page) ? page.getByRole('navigation', { name: 'Mail actions' }) : page.locator('.mail-list-new')).getByRole('button', { name: /^New/ });

test('with no writes offered, nothing in Mail writes and opening a thread leaves it unread', async ({ page }) => {
  await boot(page);
  await expect(mail(page).locator('.mail-account')).toHaveText('robin@example.com · read-only');
  await rows(page).nth(0).click();
  const thread = page.getByRole('region', { name: 'Thread: Planning the garden week' });
  await expect(thread.locator('.mail-card').last()).toContainText('DRAFT · BY UNI · NOT SENT');
  await expect(thread.getByRole('button', { name: /Review and send/ })).toHaveCount(0);
  for (const name of ['Mark unread', 'Mark read', '⚐ Flag', 'Archive']) await expect(thread.getByRole('button', { name, exact: true })).toHaveCount(0);
  await expect(thread.getByRole('button', { name: /^Reply/ })).toBeDisabled();
  await expect(newButton(page)).toBeDisabled();
  await page.waitForTimeout(300);
  for (const cmd of writeCmds) expect(await calls(page, cmd), cmd).toEqual([]);
});

test('opening a thread marks it read, Mark unread undoes it, flags show on the row, and Archive files your own thread', async ({ page }) => {
  await boot(page, 'ok', { writes: true });
  await expect(mail(page).locator('.mail-account')).toHaveText('robin@example.com');
  await expect(rows(page)).toHaveCount(7);
  await expect(rows(page).nth(0)).toHaveAccessibleName(/^Unread\. Your mail\. Mara Quill/);
  await rows(page).nth(0).click();
  const thread = page.getByRole('region', { name: 'Thread: Planning the garden week' });
  await expect(thread.getByRole('button', { name: 'Mark unread' })).toBeVisible();
  expect(await calls(page, 'mail_mark_seen')).toEqual([{ accountId: 'A', emailIds: ['a3'], seen: true }]);
  await thread.getByRole('button', { name: 'Mark unread' }).click();
  await expect(thread.getByRole('button', { name: 'Mark read' })).toBeVisible();
  expect((await calls(page, 'mail_mark_seen')).at(-1)).toEqual({ accountId: 'A', emailIds: ['a3'], seen: false });
  await thread.getByRole('button', { name: '⚐ Flag' }).click();
  await expect(thread.getByRole('button', { name: '⚑ Unflag' })).toHaveAttribute('aria-pressed', 'true');
  expect(await calls(page, 'mail_flag')).toEqual([{ accountId: 'A', emailIds: ['a3'], flagged: true }]);
  await shot(page, 'w1-thread-actions');
  await backToThreads(page);
  await expect(rows(page).nth(0)).toHaveAccessibleName(/^Unread\. Flagged\. Your mail\. Mara Quill/);
  await expect(rows(page).nth(0).locator('.mail-row-flag')).toBeVisible();

  // Uni's mail: you can mark and flag it, never move it
  await row(page, 'Server report').click();
  const uniThread = page.getByRole('region', { name: 'Thread: Server report for Tuesday' });
  await expect(uniThread.getByRole('button', { name: 'Mark unread' })).toBeVisible();
  await expect(uniThread.getByRole('button', { name: 'Archive' })).toHaveCount(0);
  await expect(uniThread.getByRole('button', { name: '⚐ Flag' })).toBeVisible();
  await backToThreads(page);

  // Archive: out of the Inbox, into Archive
  await row(page, 'Workshop photos').click();
  await page.getByRole('region', { name: 'Thread: Workshop photos and slides' }).getByRole('button', { name: 'Archive' }).click();
  await expect(row(page, 'Workshop photos')).toHaveCount(0);
  expect(await calls(page, 'mail_archive')).toEqual([{ accountId: 'A', emailIds: ['a4'] }]);
  await expect(rows(page)).toHaveCount(6);
});

test("Uni's draft: you review exactly what will go, send it yourself once, and the sent copy says who drafted it", async ({ page }) => {
  await boot(page, 'ok', { writes: true });
  await rows(page).nth(0).click();
  const thread = page.getByRole('region', { name: 'Thread: Planning the garden week' });
  await expect(thread.locator('.mail-card-draft')).toHaveCount(2);
  await thread.locator('.mail-card').last().getByRole('button', { name: 'Review and send it yourself…' }).click();
  const draft = page.getByRole('region', { name: "Review Uni's draft" });
  await expect(draft.getByRole('group', { name: 'From' })).toContainText('YOU');
  await expect(draft.getByRole('group', { name: 'From' })).toContainText('robin@example.com');
  await expect(draft.getByRole('group', { name: 'From' }).getByRole('radio')).toHaveCount(0);
  await expect(draft).toContainText('DRAFT · BY UNI · NOT SENT');
  await expect(draft).toContainText("Sending this discards Uni's 1 earlier draft in this thread.");
  await expect(draft.getByRole('textbox', { name: 'To' })).toHaveValue('Mara Quill <mara@example.org>');
  await draft.getByRole('textbox', { name: 'Message' }).fill('Monday suits me. See you at nine.\n\nRobin');
  // Enter in a field never sends (or saves)
  await draft.getByRole('textbox', { name: 'Subject' }).press('Enter');
  await draft.getByRole('textbox', { name: 'To' }).press('Enter');
  await page.waitForTimeout(200);
  expect(await calls(page, 'mail_draft_save')).toEqual([]);
  await shot(page, 'w2-uni-draft');
  await draft.getByRole('button', { name: 'Send as you: review first, from robin@example.com' }).click();
  const review = page.getByRole('region', { name: 'Review before sending' });
  await expect(review.getByText('Mara Quill <mara@example.org>')).toBeVisible();
  await expect(review.locator('.mail-review-text')).toHaveText('Monday suits me. See you at nine.\n\nRobin');
  await expect(review).toContainText("Sending this discards Uni's 1 earlier draft in this thread.");
  const saved = await calls(page, 'mail_draft_save');
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ accountId: 'A', replaces: 'a6' });
  expect(saved[0].base).toMatch(/^[0-9a-f]{64}$/);
  await shot(page, 'w3-review');
  await review.getByRole('button', { name: 'Send as you, from robin@example.com' }).click();
  await expect(review.getByRole('status').filter({ hasText: 'Sent as you.' })).toBeVisible();
  const sent = await calls(page, 'mail_send');
  expect(sent).toHaveLength(1);
  expect(sent[0].reviewed).toMatchObject({ account_id: 'A', discard: ['a8'] });
  expect(sent[0].opId).toMatch(/^op-[0-9a-f]{32}$/);
  expect(await submissions(page)).toEqual([{ account: 'A', draft: sent[0].reviewed.draft_id, to: ['mara@example.org'] }]);
  await review.getByRole('button', { name: 'Close' }).click();
  // the thread again: the sent copy says Uni drafted it and you sent it; Uni's older draft went with it
  await expect(thread.locator('.mail-card-draft')).toHaveCount(0);
  await expect(thread.locator('.mail-card').last()).toContainText('DRAFTED BY UNI · SENT BY YOU');
  await shot(page, 'w4-sent');
});

test("a new message from the combined view has no sender until you pick one, and as Uni it goes through Uni's rules", async ({ page }) => {
  await boot(page, 'ok', { writes: true });
  await expect(rows(page)).toHaveCount(7);
  await newButton(page).click();
  const c = page.getByRole('region', { name: 'New message' });
  await expect(c.getByRole('group', { name: 'From' })).toContainText("Choose who it's from:");
  await expect(c.getByRole('button', { name: "Choose who it's from" })).toBeDisabled();
  await expect(c.getByRole('radio')).toHaveCount(2);
  for (const r of await c.getByRole('radio').all()) await expect(r).not.toBeChecked();
  await shot(page, 'w5-new-unpicked');
  await c.getByRole('radio', { name: /uni@example\.com/ }).check();
  await expect(c.getByRole('button', { name: 'Send as Uni: review first, from uni@example.com' })).toBeEnabled();
  await expect(c.locator('.mail-send-from')).toHaveText('from uni@example.com');
  await expect(c.getByRole('button', { name: 'Save draft' })).toHaveCount(0);
  await c.getByRole('textbox', { name: 'To' }).fill('Ada Moss <ada@example.org>');
  await c.getByRole('textbox', { name: 'To' }).press('Enter');
  await c.getByRole('textbox', { name: 'Subject' }).fill('Reading group: Thursday at six');
  await c.getByRole('textbox', { name: 'Subject' }).press('Enter');
  await c.getByRole('textbox', { name: 'Message' }).fill('See you there.');
  await page.waitForTimeout(200);
  expect(await calls(page, 'mail_send_as_uni')).toEqual([]);
  await c.getByRole('button', { name: /^Send as Uni/ }).click();
  const review = page.getByRole('region', { name: 'Review before sending' });
  await expect(review).toContainText("Uni's outbound rules check this before it goes.");
  await expect(review.getByRole('group', { name: 'From' })).toContainText('UNI');
  await review.getByRole('button', { name: 'Send as Uni, from uni@example.com' }).click();
  await expect(review.getByText('Sent as Uni.')).toBeVisible();
  const asUni = await calls(page, 'mail_send_as_uni');
  expect(asUni).toEqual([{ accountId: 'U', opId: asUni[0].opId, fields: { to: [{ name: 'Ada Moss', email: 'ada@example.org' }], cc: [], bcc: [], subject: 'Reading group: Thursday at six', text: 'See you there.', in_reply_to: null } }]);
  expect(await calls(page, 'mail_draft_save')).toEqual([], 'mail as Uni is never saved in your Drafts');
  await review.getByRole('button', { name: 'Close' }).click();

  // a bad address is named, never dropped
  await newButton(page).click();
  const c2 = page.getByRole('region', { name: 'New message' });
  await c2.getByRole('radio', { name: /robin@example\.com/ }).check();
  await c2.getByRole('textbox', { name: 'To' }).fill('mara@example.org, nobody');
  await c2.getByRole('button', { name: /^Send as you/ }).click();
  await expect(c2.getByText('Not an email address: nobody')).toBeVisible();
  expect(await calls(page, 'mail_draft_save')).toEqual([]);
});

test("a reply goes from the thread's mailbox; a retry is the same send; an unknown outcome blocks; a refusal can be edited", async ({ page }) => {
  await boot(page, 'ok', { writes: true });
  // Uni's thread: the reply is as Uni, locked
  await row(page, 'Question about the reading group').click();
  await page.getByRole('region', { name: 'Thread: Question about the reading group' }).getByRole('button', { name: 'Reply as Uni, from uni@example.com' }).click();
  let c = page.getByRole('region', { name: 'Reply' });
  await expect(c.getByRole('group', { name: 'From' })).toContainText('UNI');
  await expect(c.getByRole('group', { name: 'From' })).toContainText('the mailbox this thread is in');
  await expect(c.getByRole('radio')).toHaveCount(0);
  await expect(c.getByRole('textbox', { name: 'To' })).toHaveValue('Ada Moss <ada@example.org>');
  await expect(c.getByRole('textbox', { name: 'Subject' })).toHaveValue('Re: Question about the reading group');
  await c.getByRole('button', { name: '✕ Close' }).click();
  await backToThreads(page);

  // your thread: the answer is lost once; Send again is the same opId, and one message goes
  await rows(page).nth(0).click();
  await page.getByRole('region', { name: 'Thread: Planning the garden week' }).getByRole('button', { name: 'Reply as you, from robin@example.com' }).click();
  c = page.getByRole('region', { name: 'Reply' });
  await expect(c.getByRole('textbox', { name: 'To' })).toHaveValue('Mara Quill <mara@example.org>');
  await c.getByRole('textbox', { name: 'Message' }).fill('Tuesday, then.');
  await c.getByRole('button', { name: /^Send as you/ }).click();
  const review = page.getByRole('region', { name: 'Review before sending' });
  await page.evaluate(() => { (window as any).__sendFails = 1; });
  await review.getByRole('button', { name: /^Send as you/ }).click();
  await expect(review.getByRole('alert')).toContainText("Mail isn't reachable right now.");
  await expect(review).toContainText("Trying again is safe: it is the same send, and it can't go out twice.");
  await review.getByRole('button', { name: /^Send as you/ }).click();
  await expect(review.getByText('Sent as you.')).toBeVisible();
  const sends = await calls(page, 'mail_send');
  expect(sends).toHaveLength(2);
  expect(sends[1].opId).toBe(sends[0].opId);
  expect(await submissions(page)).toHaveLength(1);
  await review.getByRole('button', { name: 'Close' }).click();

  // an unknown outcome: no Send button, only Check again
  await page.getByRole('region', { name: 'Thread: Planning the garden week' }).getByRole('button', { name: /^Reply as you/ }).click();
  c = page.getByRole('region', { name: 'Reply' });
  await c.getByRole('textbox', { name: 'Message' }).fill('One more thing.');
  await c.getByRole('button', { name: /^Send as you/ }).click();
  await page.evaluate(() => { (window as any).__forceSend = ['unknown', 'no answer from the mail server']; });
  await review.getByRole('button', { name: /^Send as you/ }).click();
  await expect(review.getByText("Outcome unknown, checking. It won't be sent twice.")).toBeVisible();
  await expect(review.getByRole('button', { name: /^Send as/ })).toHaveCount(0);
  await expect(review.getByRole('button', { name: '← Edit' })).toHaveCount(0);
  await shot(page, 'w6-unknown');
  await review.getByRole('button', { name: 'Check again' }).click();
  await expect(review.getByText('Sent as you.')).toBeVisible();
  expect((await calls(page, 'mail_send_check')).length).toBe(1);
  await review.getByRole('button', { name: 'Close' }).click();

  // a refusal: said in words, and you can edit and try again (a new review, a new opId)
  await page.getByRole('region', { name: 'Thread: Planning the garden week' }).getByRole('button', { name: /^Reply as you/ }).click();
  c = page.getByRole('region', { name: 'Reply' });
  await c.getByRole('textbox', { name: 'Message' }).fill('Last one.');
  await c.getByRole('button', { name: /^Send as you/ }).click();
  await page.evaluate(() => { (window as any).__forceSend = ['refused', 'the draft changed since it was reviewed']; });
  await review.getByRole('button', { name: /^Send as you/ }).click();
  await expect(review.getByText('Not sent: the draft changed since it was reviewed.')).toBeVisible();
  await review.getByRole('button', { name: '← Edit' }).click();
  c = page.getByRole('region', { name: 'Reply' });
  await c.getByRole('button', { name: /^Send as you/ }).click();
  await review.getByRole('button', { name: /^Send as you/ }).click();
  await expect(review.getByText('Sent as you.')).toBeVisible();
  const all = await calls(page, 'mail_send');
  expect(new Set(all.map((s) => s.opId)).size).toBe(4, 'the lost answer reused its opId; every other review had its own');
  expect(await submissions(page)).toHaveLength(3);
});

test('mail that says it is from you but failed DMARC says "not verified"; mail that passed or came from inside does not', async ({ page }) => {
  await boot(page, 'ok', { writes: true });
  await row(page, 'Please send the deposit').click();
  const t = page.getByRole('region', { name: 'Thread: Please send the deposit to my new account' });
  await expect(t.getByRole('note').filter({ hasText: 'NOT VERIFIED' })).toContainText("This says it is from you, but the server that received it couldn't confirm that (DMARC: fail).");
  await shot(page, 'w7-not-verified');
  await backToThreads(page);
  await rows(page).nth(0).click();
  await expect(page.getByRole('region', { name: 'Thread: Planning the garden week' }).getByText('NOT VERIFIED')).toHaveCount(0);
});

test('on the Daylight the thread tools and the composer move nothing, and every target is at least 44 px', async ({ page }, info) => {
  test.skip(!info.project.name.startsWith('daylight'), 'the Daylight');
  await boot(page, 'ok', { writes: true });
  const check = async () => {
    const moving = await page.evaluate(() => [...document.querySelectorAll('.mail *')].filter((el) => {
      const s = getComputedStyle(el);
      return s.transitionDuration.split(',').some((d) => parseFloat(d) > 0) || (s.animationName !== 'none' && parseFloat(s.animationDuration) > 0);
    }).map((el) => el.className));
    expect(moving).toEqual([]);
    // a radio's target is its whole label
    const small = await page.evaluate(() => [...document.querySelectorAll('.mail button, .mail input:not([type=radio]), .mail textarea, .mail label.mail-from-pick')].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.height < 44;
    }).map((el) => `${el.className}: ${(el as HTMLElement).innerText?.slice(0, 20)}`));
    expect(small).toEqual([]);
  };
  await rows(page).nth(0).click();
  await expect(page.getByRole('button', { name: 'Mark unread' })).toBeVisible();
  await check();
  await page.getByRole('button', { name: /^Reply as you/ }).click();
  await expect(page.getByRole('region', { name: 'Reply' })).toBeVisible();
  await check();
  await page.getByRole('button', { name: '✕ Close' }).click();
  await newButton(page).click();
  await page.getByRole('button', { name: 'Cc / Bcc' }).click();
  await check();
  await page.getByRole('radio', { name: /robin@example\.com/ }).check();
  await page.getByRole('textbox', { name: 'To' }).fill('mara@example.org');
  await page.getByRole('button', { name: /^Send as you/ }).click();
  await expect(page.getByRole('region', { name: 'Review before sending' })).toBeVisible();
  await check();
});

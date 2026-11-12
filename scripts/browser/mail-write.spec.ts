// T-210 Mail writes against the two-account double that accepts writes (mailMock.ts, `{ writes: true }`): reading
// state, flags and archive; a Uni draft reviewed and sent by you; a new message whose sender you must pick; replies
// that go from the thread's mailbox; a retry that is the same send; outcomes that block; the "not verified" badge.
// Run: npx playwright test --config playwright.mail.config.ts (desktop, phone, and the Daylight upright and sideways)
import { expect, test, type Page } from '@playwright/test';
import { expectMailCount, leaveMail, returnToMail } from './mailNav';
import { backToThreads, boot, mail, pickTab, rows, shot, stacked, tab } from './mailMock';


const calls = (page: Page, cmd: string): Promise<any[]> => page.evaluate((c) => (window as any).__calls.filter((x: any) => x.cmd === c).map((x: any) => x.args), cmd);
const submissions = (page: Page): Promise<any[]> => page.evaluate(() => (window as any).__submissions);
const row = (page: Page, text: string) => rows(page).filter({ hasText: text });
const thread = (page: Page, subject: string) => page.getByRole('region', { name: `Thread: ${subject}` });
const writeCmds = ['mail_mark_seen', 'mail_flag', 'mail_archive', 'mail_draft_save', 'mail_draft_review', 'mail_draft_discard', 'mail_send', 'mail_send_as_uni', 'mail_send_check'];

/** The New button, in the row above the list (wide screen and phone alike). */
const newButton = (page: Page) => mail(page).getByRole('button', { name: 'New', exact: true });

test('with no writes offered, nothing in Mail writes and opening a thread leaves it unread', async ({ page }) => {
  await boot(page);
  await expect(mail(page).locator('.mail-readonly')).toHaveText('robin@example.com · reading only');
  await rows(page).nth(0).click();
  const t = thread(page, 'Planning the garden week');
  await expect(t.getByRole('region', { name: "Uni's draft reply" })).toContainText('not sent');
  for (const name of ['Edit and send', 'Write my own', 'Edit draft']) await expect(t.getByRole('button', { name, exact: true })).toHaveCount(0);
  for (const name of ['Unread', 'Mark read', 'Later', 'Back to Inbox', 'Not later', 'Archive']) await expect(t.getByRole('button', { name, exact: true })).toHaveCount(0);
  await expect(t.getByRole('button', { name: /^Reply/ })).toHaveCount(0);
  await expect(newButton(page)).toHaveCount(0);
  await page.waitForTimeout(300);
  for (const cmd of writeCmds) expect(await calls(page, cmd), cmd).toEqual([]);
});

test('opening a thread marks it read, Unread undoes it, Later puts every message of the thread off and opens the next, and Archive files your own thread', async ({ page }) => {
  await boot(page, 'ok', { writes: true });
  await expect(mail(page).locator('.mail-readonly')).toHaveCount(0);
  await expect(rows(page)).toHaveCount(3);
  await expect(rows(page).nth(0)).toHaveAccessibleName(/^Unread\. Draft by Uni\. Mara Quill/);
  await rows(page).nth(0).click();
  const plan = thread(page, 'Planning the garden week');
  await expect(plan.getByRole('button', { name: 'Unread', exact: true })).toBeVisible();
  expect(await calls(page, 'mail_mark_seen')).toEqual([{ accountId: 'A', emailIds: ['a3'], seen: true }]);
  await plan.getByRole('button', { name: 'Unread', exact: true }).click();
  await expect(plan.getByRole('button', { name: 'Mark read' })).toBeVisible();
  expect((await calls(page, 'mail_mark_seen')).at(-1)).toEqual({ accountId: 'A', emailIds: ['a3'], seen: false });
  await shot(page, 'w1-thread-actions');
  // Later flags every message of the thread (not only the newest), takes it out of the Inbox and opens the next thread
  await plan.getByRole('button', { name: 'Later', exact: true }).click();
  await expect(thread(page, 'Workshop photos and slides')).toBeVisible();
  expect(await calls(page, 'mail_flag')).toEqual([{ accountId: 'A', emailIds: ['a1', 'a2', 'a3'], flagged: true }]);
  await expect(row(page, 'garden week')).toHaveCount(0);
  await expect(rows(page)).toHaveCount(2);
  await backToThreads(page);
  await expect(tab(page, 'Later')).toHaveAccessibleName(/1 put off/);
  await pickTab(page, 'Later');
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).nth(0)).toHaveAccessibleName(/^Unread\. Draft by Uni\. Mara Quill/);
  await rows(page).nth(0).click();
  await expect(thread(page, 'Planning the garden week').getByRole('button', { name: 'Back to Inbox', exact: true })).toBeVisible();
  await shot(page, 'w1-later');

  // Uni's mail (its own tab): opening it leaves it as Uni left it; you can mark it, never move it, and it is not yours to put off
  await pickTab(page, "Uni's mail");
  await row(page, 'Server report').click();
  const uniThread = thread(page, 'Server report for Tuesday');
  await expect(uniThread.getByRole('button', { name: 'Mark read' })).toBeVisible();
  expect((await calls(page, 'mail_mark_seen')).filter((c) => c.accountId === 'U')).toEqual([]);
  await uniThread.getByRole('button', { name: 'Mark read' }).click();
  await expect(uniThread.getByRole('button', { name: 'Unread', exact: true })).toBeVisible();
  expect((await calls(page, 'mail_mark_seen')).at(-1)).toEqual({ accountId: 'U', emailIds: ['u1'], seen: true });
  await expect(uniThread.getByRole('button', { name: 'Archive' })).toHaveCount(0);
  await expect(uniThread.getByRole('button', { name: 'Later', exact: true })).toHaveCount(0);
  expect((await calls(page, 'mail_flag')).filter((c) => c.accountId === 'U')).toEqual([]);

  // Archive: out of the Inbox, into Archive, and the next thread opens
  await pickTab(page, 'Inbox');
  await row(page, 'Workshop photos').click();
  await thread(page, 'Workshop photos and slides').getByRole('button', { name: 'Archive' }).click();
  await expect(row(page, 'Workshop photos')).toHaveCount(0);
  await expect(thread(page, 'Your hold is ready')).toBeVisible();
  expect(await calls(page, 'mail_archive')).toEqual([{ accountId: 'A', emailIds: ['a4'] }]);
  await expect(rows(page)).toHaveCount(1);

  // Back to Inbox from Later: the flag goes from every message that carries it
  await pickTab(page, 'Later');
  await rows(page).nth(0).click();
  await thread(page, 'Planning the garden week').getByRole('button', { name: 'Back to Inbox', exact: true }).click();
  expect((await calls(page, 'mail_flag')).at(-1)).toEqual({ accountId: 'A', emailIds: ['a1', 'a2', 'a3'], flagged: false });
  await expect(rows(page)).toHaveCount(0);
  await pickTab(page, 'Inbox');
  await expect(rows(page)).toHaveCount(2);
});

test("Uni's draft: you review exactly what will go, send it yourself once, and the sent copy says who drafted it", async ({ page }) => {
  await boot(page, 'ok', { writes: true });
  await rows(page).nth(0).click();
  const t = thread(page, 'Planning the garden week');
  // Uni's two drafts are said once, at the foot: the newer one, and a note that an older one waits
  const foot = t.getByRole('region', { name: "Uni's draft reply" });
  await expect(foot).toContainText('1 older draft');
  await expect(t.locator('.mail-msg-draft')).toHaveCount(0);
  await foot.getByRole('button', { name: 'Edit and send' }).click();
  const draft = page.getByRole('region', { name: "Review Uni's draft" });
  await expect(draft.getByRole('group', { name: 'From' })).toContainText('You');
  await expect(draft.getByRole('group', { name: 'From' })).toContainText('robin@example.com');
  await expect(draft.getByRole('group', { name: 'From' }).getByRole('radio')).toHaveCount(0);
  await expect(draft).toContainText('Draft by Uni · not sent');
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
  // the thread again: Uni's drafts went with the send, and the sent copy says Uni drafted it and you sent it
  await expect(t.getByRole('region', { name: "Uni's draft reply" })).toHaveCount(0);
  await expect(t.locator('.mail-msg').last()).toContainText('Drafted by Uni · sent by you');
  await shot(page, 'w4-sent');
});

test("a new message starts from the sender of the tab you are in, you can pick the other, and as Uni it goes through Uni's rules", async ({ page }) => {
  await boot(page, 'ok', { writes: true });
  // from Uni's tab, New is from Uni's address already
  await pickTab(page, "Uni's mail");
  await newButton(page).click();
  const c = page.getByRole('region', { name: 'New message' });
  await expect(c.getByRole('radio')).toHaveCount(2);
  await expect(c.getByRole('radio', { name: /uni@example\.com/ })).toBeChecked();
  await expect(c.getByRole('radio', { name: /robin@example\.com/ })).not.toBeChecked();
  await shot(page, 'w5-new-from-uni-tab');
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
  await expect(review.getByRole('group', { name: 'From' })).toContainText('Uni');
  await review.getByRole('button', { name: 'Send as Uni, from uni@example.com' }).click();
  await expect(review.getByText('Sent as Uni.')).toBeVisible();
  const asUni = await calls(page, 'mail_send_as_uni');
  expect(asUni).toEqual([{ accountId: 'U', opId: asUni[0].opId, fields: { to: [{ name: 'Ada Moss', email: 'ada@example.org' }], cc: [], bcc: [], subject: 'Reading group: Thursday at six', text: 'See you there.', in_reply_to: null } }]);
  expect(await calls(page, 'mail_draft_save')).toEqual([], 'mail as Uni is never saved in your Drafts');
  await review.getByRole('button', { name: 'Close' }).click();

  // from your Inbox, New is from you; picking Uni's address is one tap. A bad address is named, never dropped
  await pickTab(page, 'Inbox');
  await newButton(page).click();
  const c2 = page.getByRole('region', { name: 'New message' });
  await expect(c2.getByRole('radio', { name: /robin@example\.com/ })).toBeChecked();
  await expect(c2.getByRole('radio', { name: /uni@example\.com/ })).not.toBeChecked();
  await c2.getByRole('radio', { name: /uni@example\.com/ }).check();
  await expect(c2.getByRole('button', { name: /^Send as Uni/ })).toBeEnabled();
  await c2.getByRole('radio', { name: /robin@example\.com/ }).check();
  await c2.getByRole('textbox', { name: 'To' }).fill('mara@example.org, nobody');
  await c2.getByRole('button', { name: /^Send as you/ }).click();
  await expect(c2.getByText('Not an email address: nobody')).toBeVisible();
  expect(await calls(page, 'mail_draft_save')).toEqual([]);
});

test("a reply goes from the thread's mailbox; a retry is the same send; an unknown outcome blocks; a refusal can be edited", async ({ page }) => {
  await boot(page, 'ok', { writes: true });
  // Uni's thread: the reply is as Uni, locked
  await pickTab(page, "Uni's mail");
  await row(page, 'Question about the reading group').click();
  await thread(page, 'Question about the reading group').getByRole('button', { name: 'Reply', exact: true }).click();
  let c = page.getByRole('region', { name: 'Reply' });
  await expect(c.getByRole('group', { name: 'From' })).toContainText('Uni');
  await expect(c.getByRole('group', { name: 'From' })).toContainText('the mailbox this thread is in');
  await expect(c.getByRole('radio')).toHaveCount(0);
  await expect(c.getByRole('textbox', { name: 'To' })).toHaveValue('Ada Moss <ada@example.org>');
  await expect(c.getByRole('textbox', { name: 'Subject' })).toHaveValue('Re: Question about the reading group');
  // written under the conversation, in the thread's own pane
  await expect(thread(page, 'Question about the reading group').getByRole('region', { name: 'Reply' })).toBeVisible();
  await c.getByRole('button', { name: '✕ Close' }).click();

  // your thread: Reply opens Uni's draft when there is one; Write my own is the blank reply, from the thread's mailbox.
  // The answer is lost once. The outcome is unknown: no edit, no new send; Check finds the bridge never
  // got it, and the same send (the same opId) goes once
  await pickTab(page, 'Inbox');
  await rows(page).nth(0).click();
  const plan = thread(page, 'Planning the garden week');
  await plan.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(page.getByRole('region', { name: "Review Uni's draft" })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Reply', exact: true })).toHaveCount(0);
  await page.getByRole('region', { name: "Review Uni's draft" }).getByRole('button', { name: '✕ Close' }).click();
  await plan.getByRole('button', { name: 'Write my own' }).click();
  c = page.getByRole('region', { name: 'Reply' });
  await expect(c.getByRole('group', { name: 'From' })).toContainText('robin@example.com');
  await expect(c.getByRole('textbox', { name: 'To' })).toHaveValue('Mara Quill <mara@example.org>');
  await c.getByRole('textbox', { name: 'Message' }).fill('Tuesday, then.');
  await c.getByRole('button', { name: /^Send as you/ }).click();
  const review = page.getByRole('region', { name: 'Review before sending' });
  await page.evaluate(() => { (window as any).__sendFails = 1; });
  await review.getByRole('button', { name: /^Send as you/ }).click();
  await expect(review.getByText("Outcome unknown, checking. It won't be sent twice.")).toBeVisible();
  await expect(review.getByRole('button', { name: '← Edit' })).toHaveCount(0);
  await expect(review.getByRole('button', { name: /^Send as/ })).toHaveCount(0);
  await review.getByRole('button', { name: 'Check again' }).click();
  await expect(review.getByText('The mail bridge has no record of this send: it never arrived, and nothing was sent.')).toBeVisible();
  await review.getByRole('button', { name: 'Send it again (the same send)' }).click();
  await expect(review.getByText('Sent as you.')).toBeVisible();
  const sends = await calls(page, 'mail_send');
  expect(sends).toHaveLength(2);
  expect(sends[1].opId).toBe(sends[0].opId);
  expect(await submissions(page)).toHaveLength(1);
  await review.getByRole('button', { name: 'Close' }).click();

  // an unknown outcome: no Send button, only Check again
  await plan.getByRole('button', { name: 'Write my own' }).click();
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
  expect((await calls(page, 'mail_send_check')).length).toBe(2, 'one after the lost answer, one here');
  await review.getByRole('button', { name: 'Close' }).click();

  // a refusal: said in words, and you can edit and try again (a new review, a new opId)
  await plan.getByRole('button', { name: 'Write my own' }).click();
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
  await pickTab(page, "Uni's mail");
  await row(page, 'Please send the deposit').click();
  const t = thread(page, 'Please send the deposit to my new account');
  await expect(t.getByRole('note').filter({ hasText: 'Not verified' })).toContainText("Says it is from you, but the receiving server couldn't confirm it (DMARC: fail).");
  await shot(page, 'w7-not-verified');
  await pickTab(page, 'Inbox');
  await rows(page).nth(0).click();
  await expect(thread(page, 'Planning the garden week').getByText('Not verified')).toHaveCount(0);
});

test('on the Daylight the thread tools and the composer move nothing, and every target is at least 44 px', async ({ page }, info) => {
  test.skip(!info.project.name.startsWith('daylight'), 'the Daylight');
  // T-335: the Daylight is calm by its Settings switch (Calm screen), not by its user agent
  await page.addInitScript(() => localStorage.setItem('uni.motion', 'calm'));
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
    }).map((el) => `${el.className}: ${(el as HTMLElement).innerText?.slice(0, 20)} ${Math.round(el.getBoundingClientRect().height)}px`));
    expect(small).toEqual([]);
  };
  await rows(page).nth(0).click();
  await expect(page.getByRole('button', { name: 'Unread', exact: true })).toBeVisible();
  await check();
  await thread(page, 'Planning the garden week').getByRole('button', { name: 'Write my own' }).click();
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

test('a message being written survives opening a thread, New and leaving Mail; Close asks before dropping it', async ({ page }) => {
  await boot(page, 'ok', { writes: true });
  await newButton(page).click();
  let c = page.getByRole('region', { name: 'New message' });
  await c.getByRole('radio', { name: /robin@example\.com/ }).check();
  await c.getByRole('textbox', { name: 'To' }).fill('mara@example.org');
  await c.getByRole('textbox', { name: 'Message' }).fill('A long message I am still writing.');
  if (!stacked(page)) {
    // beside the list (a phone shows the composer alone): open a thread, and the message waits behind it
    await row(page, 'Workshop photos').click();
    await expect(page.getByRole('region', { name: 'Thread: Workshop photos and slides' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'New message' })).toBeHidden();
    await page.locator('.mail-read').getByRole('button', { name: '✎ A message in progress · Resume' }).click();
    c = page.getByRole('region', { name: 'New message' });
    await expect(c.getByRole('textbox', { name: 'Message' })).toHaveValue('A long message I am still writing.');
    // New brings this one back instead of replacing it
    await row(page, 'Your hold is ready').click();
    await newButton(page).click();
    await expect(page.getByText('Finish or close this message first.')).toBeVisible();
    await expect(c.getByRole('textbox', { name: 'Message' })).toHaveValue('A long message I am still writing.');
  }
  // leave Mail and come back
  await leaveMail(page);
  await returnToMail(page);
  c = page.getByRole('region', { name: 'New message' });
  await expect(c.getByRole('textbox', { name: 'Message' })).toHaveValue('A long message I am still writing.');
  await expect(c.getByRole('group', { name: 'From' })).toContainText('robin@example.com');
  // Close asks first
  await c.getByRole('button', { name: '✕ Close' }).click();
  const ask = page.getByRole('alertdialog', { name: 'Close without saving?' });
  await expect(ask).toBeVisible();
  await ask.getByRole('button', { name: 'Keep writing' }).click();
  await expect(c.getByRole('textbox', { name: 'Message' })).toHaveValue('A long message I am still writing.');
  await c.getByRole('button', { name: '✕ Close' }).click();
  await ask.getByRole('button', { name: 'Save draft and close' }).click();
  await expect(page.getByRole('region', { name: 'New message' })).toHaveCount(0);
  const saved = await calls(page, 'mail_draft_save');
  expect(saved).toHaveLength(1);
  expect(saved[0].fields.text).toBe('A long message I am still writing.');
});

test("a send as Uni that got no answer can't be edited or sent under a new id, and is checked after the composer closes", async ({ page }) => {
  await boot(page, 'ok', { writes: true });
  await newButton(page).click();
  const c = page.getByRole('region', { name: 'New message' });
  await c.getByRole('radio', { name: /uni@example\.com/ }).check();
  await c.getByRole('textbox', { name: 'To' }).fill('ada@example.org');
  await c.getByRole('textbox', { name: 'Message' }).fill('Thursday.');
  await c.getByRole('button', { name: /^Send as Uni/ }).click();
  const review = page.getByRole('region', { name: 'Review before sending' });
  // the bridge takes it, and the answer is lost on the way back
  await page.evaluate(() => { (window as any).__loseAnswer = true; });
  await review.getByRole('button', { name: /^Send as Uni/ }).click();
  await expect(review.getByText("Outcome unknown, checking. It won't be sent twice.")).toBeVisible();
  await expect(review.getByRole('button', { name: '← Edit' })).toHaveCount(0);
  await expect(review.getByRole('button', { name: /^Send/ })).toHaveCount(0);
  await review.getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('.mail-pending')).toContainText("A message you sent hasn't confirmed yet.");
  await page.locator('.mail-pending').getByRole('button', { name: 'Check' }).click();
  await expect(page.locator('.mail-pending-note')).toHaveText('Sent as Uni.');
  await expect(page.locator('.mail-pending')).toHaveCount(0);
  const sent = await calls(page, 'mail_send_as_uni');
  expect(sent).toHaveLength(1);
  expect((await calls(page, 'mail_send_check'))[0].opId).toBe(sent[0].opId);
  expect(await submissions(page)).toHaveLength(1);
});

test('the composer offers only what the bridge offers', async ({ page }) => {
  // your account offers save and send but not review: nothing can be sent from it, so neither New nor Reply opens
  await boot(page, 'ok', { ops: { A: ['mark_seen', 'draft.save', 'send', 'send.check'], U: ['mark_seen'] } });
  await expect(newButton(page)).toHaveCount(0);
  await rows(page).nth(0).click();
  const t = thread(page, 'Planning the garden week');
  await expect(t.getByRole('button', { name: /^Reply/ })).toHaveCount(0);
  await expect(t.getByRole('button', { name: /^Edit/ })).toHaveCount(0);
  await expect(t.getByRole('button', { name: 'Write my own' })).toHaveCount(0);
  await expect(t.getByRole('button', { name: 'Archive' })).toHaveCount(0);
  for (const name of ['Later', 'Back to Inbox', 'Not later']) await expect(t.getByRole('button', { name, exact: true })).toHaveCount(0);
  for (const cmd of ['mail_draft_save', 'mail_draft_review', 'mail_send', 'mail_archive', 'mail_flag']) expect(await calls(page, cmd), cmd).toEqual([]);
});

test('when the bridge stops offering sending while you write, Send turns off and says why', async ({ page }) => {
  await boot(page, 'ok', { writes: true });
  await newButton(page).click();
  const c = page.getByRole('region', { name: 'New message' });
  await c.getByRole('radio', { name: /robin@example\.com/ }).check();
  await expect(c.getByRole('button', { name: /^Send as you/ })).toBeEnabled();
  await expect(c.getByRole('button', { name: 'Save draft' })).toBeVisible();
  await page.evaluate(() => { (window as any).__ops.A = ['mark_seen']; });
  if (stacked(page)) { await leaveMail(page); await returnToMail(page); } // the composer fills a phone: Mail reads its session again on return
  else await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(c.getByRole('button', { name: /^Send as you/ })).toBeDisabled();
  await expect(c.getByText("The mail bridge doesn't offer sending from this mailbox now.")).toBeVisible();
  await expect(c.getByRole('button', { name: 'Save draft' })).toHaveCount(0);
});

test("a draft with formatting isn't offered for sending here, and one that can't be opened can't be edited", async ({ page }) => {
  await boot(page, 'ok', { writes: true });
  await pickTab(page, 'Drafts');
  await row(page, 'Flyer for the garden week').click();
  const flyer = thread(page, 'Flyer for the garden week');
  await expect(flyer.getByText("It has formatting or files this app can't show in full: send it from your mail client.")).toBeVisible();
  await expect(flyer.getByRole('button', { name: 'Edit draft' })).toHaveCount(0);
  // Uni's draft, when the bridge doesn't answer the review: no fields to edit, so no second draft can be made
  await pickTab(page, 'Inbox');
  await rows(page).nth(0).click();
  await page.evaluate(() => { (window as any).__reviewFails = 1; });
  await thread(page, 'Planning the garden week').getByRole('button', { name: 'Edit and send' }).click();
  const c = page.getByRole('region', { name: "Review Uni's draft" });
  await expect(c.getByText("The draft couldn't be opened for review, so it can't be edited or sent yet.")).toBeVisible();
  await expect(c.getByRole('textbox')).toHaveCount(0);
  await c.getByRole('button', { name: 'Retry' }).click();
  await expect(c.getByRole('textbox', { name: 'Message' })).toHaveValue('Monday suits me. See you then.\n\nRobin');
  expect(await calls(page, 'mail_draft_save')).toEqual([]);
});

test('Unread stays after Refresh; an archive that finishes late leaves the thread you opened since', async ({ page }) => {
  await boot(page, 'ok', { writes: true });
  await rows(page).nth(0).click();
  const plan = thread(page, 'Planning the garden week');
  await plan.getByRole('button', { name: 'Unread', exact: true }).click();
  await expect(plan.getByRole('button', { name: 'Mark read' })).toBeVisible();
  // a phone shows the list or the thread: Refresh sits with the list, and reloads the open thread from there
  await backToThreads(page);
  await page.getByRole('button', { name: 'Refresh' }).click();
  if (stacked(page)) await expect(rows(page).nth(0)).toHaveAccessibleName(/^Unread\./);
  else await expect(plan.getByRole('button', { name: 'Mark read' })).toBeVisible();
  await page.waitForTimeout(300);
  expect((await calls(page, 'mail_mark_seen')).map((c) => c.seen)).toEqual([true, false], 'the reload did not mark it read again');
  await backToThreads(page);
  await row(page, 'Workshop photos').click();
  await page.evaluate(() => { (window as any).__archiveDelay = 1500; });
  await thread(page, 'Workshop photos and slides').getByRole('button', { name: 'Archive' }).click();
  await backToThreads(page);
  await row(page, 'Your hold is ready').click();
  await page.waitForTimeout(1800);
  await expect(page.getByRole('region', { name: 'Thread: Your hold is ready' })).toBeVisible();
  await expect(row(page, 'Workshop photos')).toHaveCount(0);
});

test('a new message saved as a draft keeps its sender: From locks once it is saved', async ({ page }) => {
  await boot(page, 'ok', { writes: true });
  await newButton(page).click();
  const c = page.getByRole('region', { name: 'New message' });
  await c.getByRole('radio', { name: /robin@example\.com/ }).check();
  await c.getByRole('textbox', { name: 'To' }).fill('mara@example.org');
  await c.getByRole('button', { name: 'Save draft' }).click();
  await expect(c.getByText('Saved in your Drafts.')).toBeVisible();
  await expect(c.getByRole('radio')).toHaveCount(0);
  await expect(c.getByRole('group', { name: 'From' })).toContainText("saved in this mailbox's Drafts");
  await c.getByRole('button', { name: 'Discard draft' }).click();
  expect((await calls(page, 'mail_draft_discard'))[0].accountId).toBe('A');
});

/** Codex review 2, P0: what the review shows and the fingerprint it sends are one version of the draft. */
test('a draft is opened as the bridge reads it now, and a change made elsewhere after that is never sent unseen', async ({ page }) => {
  await boot(page, 'ok', { writes: true });
  await rows(page).nth(0).click();
  const t = thread(page, 'Planning the garden week');
  await expect(t.getByRole('region', { name: "Uni's draft reply" })).toContainText('Monday suits me. See you then.');
  // changed in another mail client after the thread loaded: the composer shows the stored version, not the thread's
  await page.evaluate(() => { (window as any).__msgs.find((m: any) => m.id === 'a6').text = 'Monday suits me. Bring the jars.\n\nRobin'; });
  await t.getByRole('button', { name: 'Edit and send' }).click();
  const c = page.getByRole('region', { name: "Review Uni's draft" });
  await expect(c.getByRole('textbox', { name: 'Message' })).toHaveValue('Monday suits me. Bring the jars.\n\nRobin');
  // changed again after it was opened: the review shows what was opened, and the bridge refuses the changed one
  await page.evaluate(() => { (window as any).__msgs.find((m: any) => m.id === 'a6').text = 'Send the deposit to the new account.'; });
  await c.getByRole('button', { name: /^Send as you/ }).click();
  const review = page.getByRole('region', { name: 'Review before sending' });
  await expect(review.locator('.mail-review-text')).toHaveText('Monday suits me. Bring the jars.\n\nRobin');
  await review.getByRole('button', { name: /^Send as you/ }).click();
  await expect(review.getByText('Not sent: the draft changed since it was reviewed.')).toBeVisible();
  expect(await submissions(page)).toEqual([]);
  expect(await calls(page, 'mail_draft_review')).toHaveLength(1, 'reviewing unchanged fields fetched no fresh fingerprint');
});

/** Codex review 2, P0: leaving Mail while a send is under way never comes back as an editable composer. */
test('leaving Mail while a send is under way comes back as an unknown outcome, never editable', async ({ page }) => {
  await boot(page, 'ok', { writes: true });
  await newButton(page).click();
  const c = page.getByRole('region', { name: 'New message' });
  await c.getByRole('radio', { name: /uni@example\.com/ }).check();
  await c.getByRole('textbox', { name: 'To' }).fill('ada@example.org');
  await c.getByRole('textbox', { name: 'Message' }).fill('Thursday.');
  await c.getByRole('button', { name: /^Send as Uni/ }).click();
  await page.evaluate(() => { (window as any).__sendDelay = 1500; });
  await page.getByRole('region', { name: 'Review before sending' }).getByRole('button', { name: /^Send as Uni/ }).click();
  await leaveMail(page);
  await page.waitForTimeout(2000);
  await returnToMail(page);
  const review = page.getByRole('region', { name: 'Review before sending' });
  await expect(review.getByText("Outcome unknown, checking. It won't be sent twice.")).toBeVisible();
  await expect(review.getByRole('button', { name: '← Edit' })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveCount(0);
  await review.getByRole('button', { name: 'Check again' }).click();
  await expect(review.getByText('Sent as Uni.')).toBeVisible();
  expect(await submissions(page)).toHaveLength(1);
  expect(await calls(page, 'mail_send_as_uni')).toHaveLength(1);
});

test("while a draft is saving it can't be typed into, and a pending send's Check needs the bridge to offer it", async ({ page }) => {
  await boot(page, 'ok', { writes: true });
  await newButton(page).click();
  let c = page.getByRole('region', { name: 'New message' });
  await c.getByRole('radio', { name: /robin@example\.com/ }).check();
  await c.getByRole('textbox', { name: 'Message' }).fill('First words.');
  await page.evaluate(() => { (window as any).__saveDelay = 1200; });
  await c.getByRole('button', { name: 'Save draft' }).click();
  await expect(c.getByRole('textbox', { name: 'Message' })).not.toBeEditable();
  await expect(c.getByText('Saved in your Drafts.')).toBeVisible();
  await expect(c.getByRole('textbox', { name: 'Message' })).toBeEditable();
  await c.getByRole('button', { name: 'Discard draft' }).click();
  // a send as Uni whose answer is lost, then the bridge stops offering checks: the banner keeps it, Check is off
  await page.evaluate(() => { (window as any).__saveDelay = 0; });
  await newButton(page).click();
  c = page.getByRole('region', { name: 'New message' });
  await c.getByRole('radio', { name: /uni@example\.com/ }).check();
  await c.getByRole('textbox', { name: 'To' }).fill('ada@example.org');
  await c.getByRole('button', { name: /^Send as Uni/ }).click();
  await page.evaluate(() => { (window as any).__loseAnswer = true; });
  const review = page.getByRole('region', { name: 'Review before sending' });
  await review.getByRole('button', { name: /^Send as Uni/ }).click();
  await review.getByRole('button', { name: 'Close' }).click();
  await page.evaluate(() => { (window as any).__ops.U = ['mark_seen']; });
  await page.getByRole('button', { name: 'Refresh' }).click();
  const banner = page.locator('.mail-pending');
  await expect(banner.getByRole('button', { name: 'Check' })).toBeDisabled();
  await expect(banner).toContainText("The mail bridge doesn't offer checking sends now; they stay listed.");
  expect(await calls(page, 'mail_send_check')).toEqual([]);
});

/** Codex review 3: a review without the draft's content (a bridge that returns only a fingerprint) opens nothing. */
test("a draft whose review doesn't say what it holds isn't opened; while saving, Close can't be chosen", async ({ page }) => {
  await boot(page, 'ok', { writes: true });
  await rows(page).nth(0).click();
  await page.evaluate(() => { (window as any).__reviewNoContent = true; });
  await thread(page, 'Planning the garden week').getByRole('button', { name: 'Edit and send' }).click();
  const c = page.getByRole('region', { name: "Review Uni's draft" });
  await expect(c.getByText("This app can't show all of this draft")).toBeVisible();
  await expect(c.getByRole('textbox')).toHaveCount(0);
  await expect(c.getByRole('button', { name: /^Send/ })).toHaveCount(0);
  await c.getByRole('button', { name: '✕ Close' }).click();
  await backToThreads(page);
  await page.evaluate(() => { (window as any).__reviewNoContent = false; (window as any).__saveDelay = 1200; });
  await newButton(page).click();
  const n = page.getByRole('region', { name: 'New message' });
  await n.getByRole('radio', { name: /robin@example\.com/ }).check();
  await n.getByRole('textbox', { name: 'Message' }).fill('Half a thought.');
  await n.getByRole('button', { name: '✕ Close' }).click();
  await page.getByRole('alertdialog', { name: 'Close without saving?' }).getByRole('button', { name: 'Save draft and close' }).click();
  const ask = page.getByRole('alertdialog', { name: 'Close without saving?' });
  await expect(ask.getByRole('button', { name: 'Close without saving' })).toBeDisabled();
  await expect(ask.getByRole('button', { name: 'Keep writing' })).toBeDisabled();
  await expect(page.getByRole('region', { name: 'New message' })).toHaveCount(0);
  expect((await calls(page, 'mail_draft_save'))[0].fields.text).toBe('Half a thought.');
});

/** Codex review 4, P1: a save-and-close still running when Mail is left and opened again is finished by the composer
 *  that comes back, and the message being written is still kept afterwards. */
test('a save-and-close under way when you leave Mail finishes when you come back, and nothing written is lost', async ({ page }) => {
  await boot(page, 'ok', { writes: true });
  await newButton(page).click();
  let c = page.getByRole('region', { name: 'New message' });
  await c.getByRole('radio', { name: /robin@example\.com/ }).check();
  await c.getByRole('textbox', { name: 'Message' }).fill('Saved on the way out.');
  await page.evaluate(() => { (window as any).__saveDelay = 1500; });
  await c.getByRole('button', { name: '✕ Close' }).click();
  await page.getByRole('alertdialog', { name: 'Close without saving?' }).getByRole('button', { name: 'Save draft and close' }).click();
  await leaveMail(page);
  await returnToMail(page);
  c = page.getByRole('region', { name: 'New message' });
  await expect(c.getByRole('textbox', { name: 'Message' })).not.toBeEditable();
  await expect(page.getByRole('region', { name: 'New message' })).toHaveCount(0, { timeout: 4000 });
  expect(await calls(page, 'mail_draft_save')).toHaveLength(1);
  // a new message after that is still kept across leaving Mail
  await page.evaluate(() => { (window as any).__saveDelay = 0; });
  await newButton(page).click();
  c = page.getByRole('region', { name: 'New message' });
  await c.getByRole('radio', { name: /robin@example\.com/ }).check();
  await c.getByRole('textbox', { name: 'Message' }).fill('Still here after leaving.');
  await leaveMail(page);
  await returnToMail(page);
  await expect(page.getByRole('region', { name: 'New message' }).getByRole('textbox', { name: 'Message' })).toHaveValue('Still here after leaving.');
});

/** T-208 item 5: Mail's count (its drawer tile, and the bar's Applets button) is your Inbox's unread (not Uni's, not Junk or Trash), kept
 *  current as you read. */
test("Mail's count shows your Inbox's unread, and follows reading", async ({ page }) => {
  await boot(page, 'ok', { writes: true });
  // a3 and a4 in your Inbox; Uni's two unread and your Junk's one don't count
  await expectMailCount(page, 2);
  await row(page, 'Planning the garden week').click();
  await expect(page.getByRole('region', { name: 'Thread: Planning the garden week' })).toBeVisible();
  await expectMailCount(page, 1);
  await backToThreads(page);
  await row(page, 'Workshop photos').click();
  await expect(page.getByRole('region', { name: 'Thread: Workshop photos and slides' })).toBeVisible();
  await expectMailCount(page, 0);
});

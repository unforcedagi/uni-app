// T-213: Uni's sends held for you, against the double that parks, approves and declines (mailMock.ts, `{ held: true }`).
// "Waiting for you" in Uni's mailboxes lists what each held send says and why it waits; Send it (bound to the
// fingerprint of what is shown) and Don't send each take one confirm, never from Enter; a double tap sends once; a draft
// that changed is refused; what happened stays shown; and none of it appears unless the bridge offers it.
// Run: npx playwright test --config playwright.mail.config.ts mail-approve (desktop, phone, and the Daylight both ways)
import { expect, test, type Page } from '@playwright/test';
import { boot, mail, shot } from './mailMock';
import { expectMailCount, leaveMail, returnToMail } from './mailNav';

const calls = (page: Page, cmd: string): Promise<any[]> => page.evaluate((c) => (window as any).__calls.filter((x: any) => x.cmd === c).map((x: any) => x.args), cmd);
const submissions = (page: Page): Promise<any[]> => page.evaluate(() => (window as any).__submissions);
const parkedFp = (page: Page, n: number): Promise<string> => page.evaluate((i) => (window as any).__parked[i].fp, n);
// Mail's count (on its drawer tile and the bar's Applets button) is the held sends plus your Inbox's unread; the made-up Inbox has two unread
const UNREAD = 2;
const expectHeld = (page: Page, held: number) => expectMailCount(page, held + UNREAD);
const heldRows = (page: Page) => page.locator('.mail-held-row');
const held = (page: Page, subject: string) => page.getByRole('region', { name: `Held send: ${subject}` });
const BARN = 'Booking the barn for the harvest supper', QUOTE = 'A quote for your newsletter';

/** Into "Waiting for you" by the banner over the list (in reach on every size), then open one held send. */
async function openHeld(page: Page, subject: string) {
  // on a phone a held send fills the screen: back to the list first
  const back = page.getByRole('button', { name: '← Waiting' }).filter({ visible: true });
  if (await back.count()) await back.first().click();
  if (!(await page.locator('.mail-held-row').count())) await page.getByRole('button', { name: /wait for you · Review$|waits for you · Review$/ }).click();
  await expect(mail(page).locator('.mail-list-head strong')).toHaveText('Waiting for you');
  await heldRows(page).filter({ hasText: subject }).click();
  await expect(held(page, subject)).toBeVisible();
  return held(page, subject);
}

test("a held send shows what it sends and why; Send it takes a confirm, never Enter, and a double tap sends it once", async ({ page }) => {
  await boot(page, 'ok', { writes: true, held: true });
  await expectHeld(page, 2);
  await expect(page.getByRole('button', { name: '2 sends from Uni\'s address wait for you · Review' })).toBeVisible();
  await page.getByRole('button', { name: /wait for you · Review$/ }).click();
  await expect(heldRows(page)).toHaveCount(2);
  await expect(heldRows(page).first()).toHaveAccessibleName(`Waiting for you. From Uni's address to orchard@example.org: ${BARN}`);
  await shot(page, 'a1-waiting-list');
  const h = await openHeld(page, BARN);
  await expect(h.locator('.mail-headers')).toContainText('Uni <uni@example.com>');
  await expect(h.locator('.mail-headers')).toContainText('Orchard Barn <orchard@example.org>');
  await expect(h.locator('.mail-text')).toContainText('Could we book the barn for the harvest supper on Saturday the 7th');
  await expect(h.getByRole('note').filter({ hasText: 'Why it waits' })).toContainText("Uni's outbound rules want Robin to approve mail to orchard@example.org");
  const send = h.getByRole('button', { name: "Send it, from Uni's address (uni@example.com)" });
  await expect(send).toContainText("from Uni's address, uni@example.com");
  await expect(h.getByRole('button', { name: "Don't send it from Uni's address (uni@example.com)" })).toContainText('nothing goes out from Uni\'s address');
  await shot(page, 'a2-held-send');

  // Enter on Send it opens nothing; a tap opens the confirm, and Enter there sends nothing either
  await send.focus();
  await page.keyboard.press('Enter');
  await expect(h.getByRole('group', { name: 'Confirm sending' })).toHaveCount(0);
  await send.click();
  const confirm = h.getByRole('group', { name: 'Confirm sending' });
  await expect(confirm).toContainText("Send this from Uni's address (uni@example.com) to orchard@example.org? It goes out exactly as shown.");
  await expect(confirm).toBeFocused();
  await page.keyboard.press('Enter');
  const yes = confirm.getByRole('button', { name: "Yes, send from Uni's address" });
  await yes.focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  expect(await calls(page, 'mail_send_approve')).toEqual([]);
  await shot(page, 'a3-confirm-send');

  // two taps while the first is on its way (back to back, before the screen can change): one approval, one message
  await page.evaluate(() => { (window as any).__decideDelay = 400; });
  await yes.evaluate((b: HTMLElement) => { b.click(); b.click(); });
  await expect(h.getByRole('status')).toHaveText("Sent from Uni's address (uni@example.com).");
  await expect(h.locator('.mail-held-where')).toContainText("Sent from Uni's address");
  expect(await calls(page, 'mail_send_approve')).toEqual([{ accountId: 'U', opId: 'op-held-1-00000000000000', fingerprint: await parkedFp(page, 0) }]);
  expect(await submissions(page)).toEqual([{ account: 'U', draft: 'h1', to: ['orchard@example.org'] }]);
  await expect(h.getByRole('button', { name: /^Send it/ })).toHaveCount(0);
  await expect(h.getByRole('button', { name: /^Don't send/ })).toHaveCount(0);
  await expectHeld(page, 1);
  await shot(page, 'a4-sent');

  // the outcome stays when Mail is left and opened again
  await leaveMail(page);
  await returnToMail(page);
  await expect(heldRows(page).filter({ hasText: BARN })).toContainText('Sent');
  await expect(heldRows(page).filter({ hasText: QUOTE })).toContainText('Waiting');
  expect(await submissions(page)).toHaveLength(1);
});

test('a decision still on its way when you leave Mail shows its outcome in the Mail you come back to, without Refresh', async ({ page }) => {
  await boot(page, 'ok', { writes: true, held: true });
  const h = await openHeld(page, BARN);
  await page.evaluate(() => { (window as any).__decideDelay = 2500; });
  await h.getByRole('button', { name: /^Send it/ }).click();
  await h.getByRole('button', { name: "Yes, send from Uni's address" }).click();
  await leaveMail(page);
  await returnToMail(page);
  const back = page.getByRole('button', { name: '← Waiting' }).filter({ visible: true });
  if (await back.count()) await back.first().click();
  await expect(heldRows(page).filter({ hasText: BARN })).toContainText('Sent', { timeout: 8000 });
  await expectHeld(page, 1);
  expect(await calls(page, 'mail_send_approve')).toHaveLength(1);
  expect(await submissions(page)).toHaveLength(1);
  // a failure leaves the count as it was, so nothing else redraws Mail: the store's own notice must
  const q = await openHeld(page, QUOTE);
  await page.evaluate(() => { (window as any).__decideFails = 1; });
  await q.getByRole('button', { name: /^Send it/ }).click();
  await q.getByRole('button', { name: "Yes, send from Uni's address" }).click();
  await leaveMail(page);
  await returnToMail(page);
  if (await back.count()) await back.first().click();
  await expect(heldRows(page).filter({ hasText: QUOTE })).toContainText("Couldn't send: the mail server didn't answer. Ask #systems.", { timeout: 8000 });
  await expectHeld(page, 1);
});

test("Don't send takes a confirm, Cancel keeps it waiting, and declining sends nothing", async ({ page }) => {
  await boot(page, 'ok', { writes: true, held: true });
  const h = await openHeld(page, QUOTE);
  const dont = h.getByRole('button', { name: /^Don't send it from Uni's address/ });
  await dont.click();
  const confirm = h.getByRole('group', { name: 'Confirm not sending' });
  await expect(confirm).toContainText("Don't send this? Nothing goes out from Uni's address (uni@example.com)");
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toHaveCount(0);
  expect(await calls(page, 'mail_send_decline')).toEqual([]);
  await dont.click();
  await h.getByRole('group', { name: 'Confirm not sending' }).getByRole('button', { name: "Yes, don't send it" }).click();
  await expect(h.getByRole('status')).toHaveText("Declined. Nothing was sent from Uni's address.");
  expect(await calls(page, 'mail_send_decline')).toEqual([{ accountId: 'U', opId: 'op-held-2-00000000000000' }]);
  expect(await calls(page, 'mail_send_approve')).toEqual([]);
  expect(await submissions(page)).toEqual([]);
  await expectHeld(page, 1);
  await expect(heldRows(page).filter({ hasText: QUOTE })).toContainText('Not sent');
  await shot(page, 'a5-declined');
});

test('a held draft that changed after you saw it is refused and never sent; one listed as changed offers only Don\'t send', async ({ page }) => {
  await boot(page, 'ok', { writes: true, held: true });
  const h = await openHeld(page, BARN);
  const shown = await parkedFp(page, 0);
  // the stored draft changes under the reservation after the list was read
  await page.evaluate(() => { (window as any).__msgs.find((m: any) => m.id === 'h1').text += '\nP.S. Bring the account number.'; });
  await h.getByRole('button', { name: /^Send it/ }).click();
  await h.getByRole('button', { name: "Yes, send from Uni's address" }).click();
  await expect(h.getByRole('status')).toHaveText("Couldn't send: the draft changed since it was reviewed. Ask #systems.");
  expect((await calls(page, 'mail_send_approve'))[0].fingerprint).toBe(shown);
  expect(await submissions(page)).toEqual([]);
  await shot(page, 'a6-changed-refused');
  // the refused send has left the bridge's list; what happened stays on it
  await mail(page).getByRole('button', { name: 'Refresh' }).click();
  await expect(heldRows(page).filter({ hasText: BARN })).toContainText('Ask #systems');
  await expectHeld(page, 1);
  // another held draft changes before you open it: the bridge lists it as changed, with what it says now, and only
  // Don't send is offered
  await page.evaluate(() => { (window as any).__msgs.find((m: any) => m.id === 'h2').text += '\nP.S. And our bank details.'; });
  await mail(page).getByRole('button', { name: 'Refresh' }).click();
  const other = await openHeld(page, QUOTE);
  await expect(other.locator('.mail-unverified')).toContainText("ChangedThis draft changed after Uni's rules held it, so the bridge won't send it.");
  await expect(other.locator('.mail-text')).toContainText('P.S. And our bank details.');
  await expect(other.getByRole('button', { name: /^Send it/ })).toHaveCount(0);
  await expect(other.getByRole('button', { name: /^Don't send/ })).toBeVisible();
  expect(await calls(page, 'mail_send_approve')).toHaveLength(1);
});

test('a send that fails says to ask #systems and can be tried again, and is sent once', async ({ page }) => {
  await boot(page, 'ok', { writes: true, held: true });
  const h = await openHeld(page, BARN);
  await page.evaluate(() => { (window as any).__decideFails = 1; });
  await h.getByRole('button', { name: /^Send it/ }).click();
  await h.getByRole('button', { name: "Yes, send from Uni's address" }).click();
  await expect(h.getByRole('status')).toHaveText("Couldn't send: the mail server didn't answer. Ask #systems.");
  await expectHeld(page, 2);
  await h.getByRole('button', { name: /^Send it/ }).click();
  await h.getByRole('button', { name: "Yes, send from Uni's address" }).click();
  await expect(h.getByRole('status')).toHaveText("Sent from Uni's address (uni@example.com).");
  const asked = await calls(page, 'mail_send_approve');
  expect(asked).toHaveLength(2);
  expect(asked[0]).toEqual(asked[1]);
  expect(await submissions(page)).toHaveLength(1);
});

test("nothing about held sends shows unless the bridge offers deciding them; each button only where it is offered", async ({ page }) => {
  const own = ['mark_seen', 'flag', 'archive', 'draft.save', 'draft.review', 'draft.discard', 'send', 'send.check'];
  // listing offered, deciding not: no group, no banner, no held count, nothing asked
  await boot(page, 'ok', { writes: true, held: true, ops: { A: own, U: ['mark_seen', 'flag', 'send.parked', 'send.check'] } });
  await expect(mail(page).locator('.mail-account')).toHaveText('robin@example.com');
  await page.waitForTimeout(4500); // past the first check of held sends
  await expect(page.getByText('Waiting for you')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /wait for you · Review$/ })).toHaveCount(0);
  await expectHeld(page, 0); // only your Inbox's unread counts: no held sends
  expect(await calls(page, 'mail_parked')).toEqual([]);

  // both offered, Send it's confirm open; then the bridge stops offering approving: the confirm goes with it
  await page.evaluate(() => { (window as any).__ops.U = ['mark_seen', 'flag', 'send.parked', 'send.approve', 'send.decline']; });
  await mail(page).getByRole('button', { name: 'Refresh' }).click();
  const h = await openHeld(page, BARN);
  await h.getByRole('button', { name: /^Send it/ }).click();
  await expect(h.getByRole('group', { name: 'Confirm sending' })).toBeVisible();
  await page.evaluate(() => { (window as any).__ops.U = ['mark_seen', 'flag', 'send.parked', 'send.decline']; });
  await mail(page).getByRole('button', { name: 'Refresh' }).click();
  await expect(h.getByRole('group', { name: 'Confirm sending' })).toHaveCount(0);
  await expect(h.getByRole('button', { name: "Yes, send from Uni's address" })).toHaveCount(0);
  // declining only: Don't send, no Send it
  await expect(h.getByRole('button', { name: /^Don't send/ })).toBeVisible();
  await expect(h.getByRole('button', { name: /^Send it/ })).toHaveCount(0);
  expect(await calls(page, 'mail_send_approve')).toEqual([]);

  // the bridge stops offering them: the group goes
  await page.evaluate(() => { (window as any).__ops.U = ['mark_seen', 'flag']; });
  await mail(page).getByRole('button', { name: 'Refresh' }).click();
  await expect(page.locator('.mail-box-waiting')).toHaveCount(0);
  await expect(mail(page).locator('.mail-list-head strong')).not.toHaveText('Waiting for you');
});

test('on the Daylight the held send and its confirm move nothing, and every target is at least 44 px', async ({ page }, info) => {
  test.skip(!info.project.name.startsWith('daylight'), 'the Daylight');
  // T-335: the Daylight is calm by its Settings switch (Calm screen), not by its user agent
  await page.addInitScript(() => localStorage.setItem('uni.motion', 'calm'));
  await boot(page, 'ok', { writes: true, held: true });
  const check = async () => {
    const moving = await page.evaluate(() => [...document.querySelectorAll('.mail *')].filter((el) => {
      const s = getComputedStyle(el);
      return s.transitionDuration.split(',').some((d) => parseFloat(d) > 0) || (s.animationName !== 'none' && parseFloat(s.animationDuration) > 0);
    }).map((el) => el.className));
    expect(moving).toEqual([]);
    const small = await page.evaluate(() => [...document.querySelectorAll('.mail button')].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.height < 44;
    }).map((el) => `${el.className}: ${(el as HTMLElement).innerText?.slice(0, 20)}`));
    expect(small).toEqual([]);
  };
  const h = await openHeld(page, BARN);
  await check();
  await h.getByRole('button', { name: /^Send it/ }).click();
  await expect(h.getByRole('group', { name: 'Confirm sending' })).toBeVisible();
  await check();
});

// T-335: a held send with files. Each file is listed (name, type, size) and opens with a tap; Send it is offered as for
// plain text, says it sends the files, and approves by the one fingerprint that covers them.
const ROTA = 'The rota and the budget for the harvest supper';

test('a held send with files lists each file, opens one with a tap, and Send it sends it with its files under the one fingerprint', async ({ page }) => {
  await boot(page, 'ok', { writes: true, held: true, heldFiles: true });
  await expectHeld(page, 3);
  await page.getByRole('button', { name: /wait for you · Review$/ }).click();
  await expect(heldRows(page).filter({ hasText: ROTA })).toHaveAccessibleName(`Waiting for you. From Uni's address to bookings@example.org: ${ROTA}, with 2 files`);
  await expect(heldRows(page).filter({ hasText: ROTA })).toContainText('📎 2 · ');
  const h = await openHeld(page, ROTA);
  const files = h.getByRole('list', { name: 'Files it sends (2)' });
  await expect(files.getByRole('listitem')).toHaveCount(2);
  await expect(files.getByRole('button', { name: 'Open volunteer-rota.csv, CSV · 412 B' })).toContainText('volunteer-rota.csvCSV · 412 B · Open');
  await expect(files.getByRole('button', { name: 'Open supper-budget.pdf' })).toContainText('supper-budget.pdfPDF · 13 KB · Open');
  await expect(h.getByText("only Don't send is offered here")).toHaveCount(0);
  await shot(page, 'f1-held-with-files');

  // a tap opens that file: by the draft, its place and what the listing said, so Rust checks the bytes are those
  await files.getByRole('button', { name: 'Open volunteer-rota.csv' }).click();
  await expect(files.getByRole('status')).toHaveText('Passed the attachment checks; opened.');
  expect(await calls(page, 'mail_held_file_open')).toEqual([{ accountId: 'U', draftId: 'h3', index: 0, file: { name: 'volunteer-rota.csv', mime: 'text/csv', size: 412, sha256: '1f'.repeat(32), refused: null } }]);

  const send = h.getByRole('button', { name: "Send it with 2 files, from Uni's address (uni@example.com)" });
  await expect(send).toContainText("with 2 files, from Uni's address, uni@example.com");
  await send.click();
  const confirm = h.getByRole('group', { name: 'Confirm sending' });
  await expect(confirm).toContainText("Send this from Uni's address (uni@example.com) to bookings@example.org, with its 2 files? It goes out exactly as shown, files included.");
  await shot(page, 'f2-confirm-with-files');
  await confirm.getByRole('button', { name: "Yes, send from Uni's address" }).click();
  await expect(h.getByRole('status').filter({ hasText: 'Sent' })).toHaveText("Sent from Uni's address (uni@example.com).");
  expect(await calls(page, 'mail_send_approve')).toEqual([{ accountId: 'U', opId: 'op-held-3-00000000000000', fingerprint: await parkedFp(page, 2) }]);
  expect(await submissions(page)).toEqual([{ account: 'U', draft: 'h3', to: ['bookings@example.org'] }]);
  await expectHeld(page, 2);
  await shot(page, 'f3-sent-with-files');
});

test("a file whose bytes aren't the listed ones doesn't open, and says so", async ({ page }) => {
  await boot(page, 'ok', { writes: true, held: true, heldFiles: true });
  const h = await openHeld(page, ROTA);
  await page.evaluate(() => { (window as any).__heldChanged = true; });
  await h.getByRole('button', { name: 'Open supper-budget.pdf' }).click();
  await expect(h.getByRole('list', { name: 'Files it sends (2)' }).getByRole('status')).toHaveText('This held send changed since it was listed: refresh Mail and look again.');
  await expect(h.getByRole('button', { name: 'Open supper-budget.pdf' })).toContainText('PDF · 13 KB · Not opened');
  // the listing it was shown is stale: Send it waits for a new one, Don't send stays
  await expect(h.getByRole('button', { name: /^Send it/ })).toHaveCount(0);
  await expect(h.getByRole('note').filter({ hasText: 'File not checked' })).toContainText("so Send it isn't offered");
  await expect(h.getByRole('button', { name: /^Don't send/ })).toBeVisible();
});

test("a file whose contents don't match its name withholds Send it; a network failure doesn't", async ({ page }) => {
  await boot(page, 'ok', { writes: true, held: true, heldFiles: true });
  const h = await openHeld(page, ROTA);
  await page.evaluate(() => { (window as any).__heldBadBytes = true; });
  await h.getByRole('button', { name: 'Open volunteer-rota.csv' }).click();
  await expect(h.getByRole('list', { name: 'Files it sends (2)' }).getByRole('status')).toContainText("contents don't match its name");
  await expect(h.getByRole('button', { name: /^Send it/ })).toHaveCount(0);
  // another held send is a fresh view: nothing carried over
  const q = await openHeld(page, QUOTE);
  await expect(q.getByRole('button', { name: /^Send it/ })).toBeVisible();
  // coming back to the first doesn't offer Send it again
  const again = await openHeld(page, ROTA);
  await expect(again.getByRole('note').filter({ hasText: 'File not checked' })).toBeVisible();
  await expect(again.getByRole('button', { name: /^Send it/ })).toHaveCount(0);
});

test("a file this app won't open is still listed with its kind, size and whole name, and the send can be approved", async ({ page }) => {
  await page.addInitScript(() => { (window as any).__heldRefusedFile = true; });
  await boot(page, 'ok', { writes: true, held: true, heldFiles: true });
  const h = await openHeld(page, ROTA);
  const json = 'harvest-supper-volunteer-contacts-and-dietary-notes-for-the-kitchen-team.json';
  const row = h.getByRole('list', { name: 'Files it sends (3)' }).getByRole('listitem').filter({ hasText: json });
  await expect(row.getByRole('button', { name: `${json} won't open, JSON · 3.0 MB` })).toBeDisabled();
  await expect(row).toContainText('JSON · 3.0 MB · Not opened');
  await expect(row.getByRole('status')).toHaveText("This app doesn't open this kind of file, so you can't look inside it here. It is sent as listed.");
  // the whole name shows (wrapped), never cut off
  const name = row.locator('.attachment-name');
  expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await expect(h.getByRole('button', { name: "Send it with 3 files, from Uni's address (uni@example.com)" })).toBeVisible();
  await shot(page, 'f4-file-that-wont-open');
});

test("a held send whose files the bridge doesn't list (an older bridge) offers only Don't send", async ({ page }) => {
  await page.addInitScript(() => { (window as any).__oldBridge = true; });
  await boot(page, 'ok', { writes: true, held: true, heldFiles: true });
  const h = await openHeld(page, ROTA);
  await expect(h.getByRole('note').filter({ hasText: "only Don't send is offered here" })).toBeVisible();
  await expect(h.getByRole('list', { name: /^Files it sends/ })).toHaveCount(0);
  await expect(h.getByRole('button', { name: /^Send it/ })).toHaveCount(0);
  await expect(h.getByRole('button', { name: /^Don't send/ })).toBeVisible();
});

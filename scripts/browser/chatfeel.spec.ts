// T-335 chat feel: what makes a room's chat feel alive, built from the chat-feel spec's ranked gaps. The send moment (the composer clears
// in the same frame, Send turns into Stop, a plain-words line says what Uni is doing), the answer anchored under its question (the view
// doesn't follow the text down), message actions beyond Copy, reading rhythm, the New line, quick replies under a question, and the All
// view's routed composer (a sure route is named on Send; with no good signal nothing is chosen for you). Phone, Daylight and desktop.
// Made-up world only (the fixture's `world: 'unread'` with `glow`). Run: CHATFEEL_TEST_PORT=1471 npx playwright test --config playwright.chatfeel.config.ts
import { test, expect, type Page } from '@playwright/test';
import { bootAreas } from './areasFixture';

const SHOTS = process.env.CHATFEEL_SHOTS ?? 'test-results/chatfeel-shots';
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${name}.png` });
const project = () => test.info().project.name;
const touch = () => project() !== 'desktop';
const daylight = () => project() === 'daylight';
const UNI = 'c'.repeat(64);

async function boot(page: Page, unread: Record<string, number> = {}, view: 'places' | 'all' = 'places') {
  await page.addInitScript((v) => {
    if (sessionStorage.getItem('feel.booted')) return;
    sessionStorage.setItem('feel.booted', '1');
    if (navigator.userAgent.includes('SM-T') || (window.innerWidth === 828 && window.innerHeight === 1104)) localStorage.setItem('uni.motion', 'calm');
  }, view);
  await bootAreas(page, 'seed', { world: 'unread', glow: true, uniMember: true, unread });
  await page.locator('[data-place="front-door"]').waitFor();
  if (view === 'all') { await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'All', exact: true }).click(); await page.locator('[data-view="all"]').waitFor(); }
}
async function openRoom(page: Page, name: string) {
  await page.locator(`.fd-door[data-path="Areas/${name}"]`).click();
  await page.getByRole('textbox', { name: /^Message / }).first().waitFor();
  await page.waitForTimeout(300);
}
const box = (page: Page) => page.getByRole('textbox', { name: /^Message / }).first();
const list = (page: Page) => page.locator('.message-list').first();
const posts = (page: Page) => page.evaluate(() => (window as any).__calls.filter((c: any) => c.cmd === 'post_message').map((c: any) => ({ channel: c.args.channel, body: c.args.body, recipients: c.args.recipients })));
const calls = (page: Page, cmd: string) => page.evaluate((c) => (window as any).__calls.filter((x: any) => x.cmd === c).map((x: any) => x.args), cmd);
const status = (page: Page) => page.locator('[data-status-line]');
/** A long answer, made up: a heading, prose and a list, long enough to run past any screen. */
const LONG = ['## Firing plan for the week', ...Array.from({ length: 14 }, (_, i) => `Paragraph ${i + 1}. The kiln log and the glaze notes agree: the bisque load goes on Monday at cone 04, slow start, and the test tiles follow on Wednesday once the shelf by the window is free.`)].join('\n\n');

/** Types `text` into the room's composer and sends it the way this device does (Enter on a keyboard, the Send button on touch), then
 *  reports, one frame later, what was on screen: the composer's value, whether Stop is there, and whether the message is in the list. */
async function sendAndLook(page: Page, text: string) {
  await box(page).fill(text);
  return page.evaluate(async ({ text, touch }) => {
    const ta = [...document.querySelectorAll<HTMLTextAreaElement>('textarea')].find((t) => t.getAttribute('aria-label')?.startsWith('Message '))!;
    const listEl = document.querySelector('.message-list')!;
    const inList = () => (listEl.textContent ?? '').includes(text);
    // when the message enters the list, timed by the DOM change itself (a frame's length on a busy machine is not the app's delay)
    let seenAt: number | null = null;
    const mo = new MutationObserver(() => { if (seenAt === null && inList()) seenAt = performance.now() - t0; });
    mo.observe(listEl, { childList: true, subtree: true, characterData: true });
    const t0 = performance.now();
    if (touch) document.querySelector<HTMLButtonElement>('.composer button.send')!.click();
    else ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    if (seenAt === null && inList()) seenAt = performance.now() - t0;
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    mo.disconnect();
    const value = ta.value;
    const stop = !!document.querySelector('.composer button[aria-label="Stop Uni"]');
    return { value, stop, seenAt };
  }, { text, touch: touch() });
}

test('the send moment: the composer clears in the same frame, Send becomes Stop, the question rises under the header, and a plain line says what Uni is doing', async ({ page }) => {
  await boot(page);
  await openRoom(page, 'Kiln Studio');
  await page.evaluate(() => { (window as any).__postDelay = 900; });
  const before = (await posts(page)).length;
  const q = 'Can you draft the firing plan for the week?';
  const look = await sendAndLook(page, q);
  expect(look.value).toBe('');
  expect(look.stop).toBe(true);
  expect(look.seenAt).not.toBeNull();
  expect(look.seenAt!).toBeLessThan(50);
  // within half a second a line says, in words, what is happening; no machine words
  await expect(status(page)).toBeVisible({ timeout: 500 });
  // the receipt under the question: Sending, then Sent
  const mine = page.locator('.message-list article.message.mine').filter({ hasText: q }).last();
  await expect(mine.locator('.msg-receipt')).toHaveText('Sending');
  await page.waitForTimeout(400);
  // the question sits just under the top of the chat
  const gap = await page.evaluate((q) => {
    const l = document.querySelector('.message-list')!.getBoundingClientRect();
    const m = [...document.querySelectorAll('.message-list article.message.mine')].filter((a) => a.textContent!.includes(q)).pop()!.getBoundingClientRect();
    return m.top - l.top;
  }, q);
  expect(gap).toBeGreaterThanOrEqual(0);
  expect(gap).toBeLessThanOrEqual(24);
  await expect(mine.locator('.msg-receipt')).toHaveText('Sent', { timeout: 3000 });
  expect((await posts(page)).slice(before)).toEqual([{ channel: 'ch-kiln', body: q, recipients: [UNI] }]);
  await shot(page, '01-sent');
  // Uni picks it up (its 👀): the line reads it in plain words, the receipt goes
  await page.evaluate(() => (window as any).__react('ch-kiln', '👀'));
  await expect(status(page)).toContainText(/Reading/);
  await expect(mine.locator('.msg-receipt')).toHaveCount(0);
  // a progress ping: what it is doing, in words; never the iteration count or a tool's raw name, and never a message in the thread
  await page.evaluate(() => (window as any).__arrive('ch-kiln', 'Uni', '⏳ Working — 3 min — iteration 4/90, terminal'));
  await expect(status(page)).toContainText(/Running a command/);
  await expect(status(page)).not.toContainText(/iteration|terminal|⏳/);
  await expect(list(page).locator('article.message', { hasText: '⏳' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Stop Uni' })).toBeVisible();
  await shot(page, '02-working');
  // typing again gives Send back (steer: a message to Uni while it works)
  await box(page).fill('and the glaze load');
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
  await box(page).fill('');
  await expect(page.getByRole('button', { name: 'Stop Uni' })).toBeVisible();
});

test('a long answer anchors under its question: the view does not follow it down, "More below" waits above the composer, the work folds into one line', async ({ page }) => {
  await boot(page);
  await openRoom(page, 'Kiln Studio');
  const q = 'Plan the firing week, please';
  await sendAndLook(page, q);
  await page.evaluate(() => (window as any).__react('ch-kiln', '👀'));
  await page.evaluate(() => (window as any).__arrive('ch-kiln', 'Uni', '⏳ Working — 1 min — iteration 2/90, read_file'));
  await expect(status(page)).toContainText(/Reading/);
  await page.evaluate((b) => (window as any).__arrive('ch-kiln', 'Uni', b), LONG);
  const reply = list(page).locator('article.message:not(.mine)', { hasText: 'Firing plan for the week' }).last();
  await expect(reply).toBeVisible();
  await page.waitForTimeout(700);
  const where = await page.evaluate((q) => {
    const l = document.querySelector('.message-list') as HTMLElement;
    const lr = l.getBoundingClientRect();
    const mine = [...l.querySelectorAll('article.message.mine')].filter((a) => a.textContent!.includes(q)).pop()!.getBoundingClientRect();
    const first = [...l.querySelectorAll('article.message:not(.mine)')].filter((a) => a.textContent!.includes('Firing plan for the week')).pop()!.querySelector('p')!.getBoundingClientRect();
    return { qTop: mine.top - lr.top, firstTop: first.top - lr.top, firstBottom: first.bottom - lr.top, height: lr.height, left: l.scrollHeight - l.scrollTop - l.clientHeight };
  }, q);
  // the question stays on top, the answer's first line is in view, and the end is still below
  expect(where.qTop).toBeGreaterThanOrEqual(-4);
  expect(where.qTop).toBeLessThanOrEqual(24);
  expect(where.firstTop).toBeGreaterThan(0);
  expect(where.firstBottom).toBeLessThan(where.height);
  expect(where.left).toBeGreaterThan(100);
  await expect(page.getByRole('button', { name: /More below/ })).toBeVisible();
  // done: no status line, Send is back, and the work is one quiet line above the reply
  await expect(status(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Stop Uni' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();
  await expect(reply.locator('.work-receipt')).toContainText(/^Worked \d+s/);
  await expect(list(page).locator('article.message', { hasText: '⏳' })).toHaveCount(0);
  await shot(page, '03-anchored');
  // the reply settles in (paragraph by paragraph) where motion is on; on the Daylight it is simply there
  if (!daylight()) expect(await reply.evaluate((el) => el.classList.contains('arrived'))).toBe(true);
  await page.getByRole('button', { name: /More below/ }).click();
  await expect.poll(() => list(page).evaluate((l) => l.scrollHeight - l.scrollTop - l.clientHeight)).toBeLessThan(4);
});

test('Stop: one tap asks Uni to stop, and the room says so, with Continue', async ({ page }) => {
  await boot(page);
  await openRoom(page, 'Kiln Studio');
  await sendAndLook(page, 'Sort every glaze note by date');
  await page.evaluate(() => (window as any).__react('ch-kiln', '👀'));
  await expect(status(page)).toBeVisible();
  const before = (await posts(page)).length;
  await page.getByRole('button', { name: 'Stop Uni' }).click();
  expect((await posts(page)).slice(before)).toEqual([{ channel: 'ch-kiln', body: '/stop', recipients: [UNI] }]);
  // the command is not a bubble: one quiet row says it, with Continue
  const row = list(page).locator('.uni-stopped');
  await expect(row).toContainText('You stopped Uni');
  await expect(list(page).locator('article.message.mine', { hasText: '/stop' })).toHaveCount(0);
  await expect(status(page)).toHaveCount(0);
  await row.getByRole('button', { name: 'Continue' }).click();
  const after = (await posts(page)).slice(before + 1);
  expect(after.length).toBe(1);
  expect(after[0].body).toMatch(/^Continue/);
});

test('message actions: the latest reply has a quiet row (Copy, Try again, 👍, Reply, Save as note); no ⋯ on every message', async ({ page }) => {
  await boot(page);
  await openRoom(page, 'Kiln Studio');
  const latest = list(page).locator('article.message[data-ref="k3"]');
  const row = latest.getByRole('group', { name: 'Message actions' });
  await expect(row).toBeVisible();
  for (const n of ['Copy', 'Ask Uni to try again', 'Thumbs up', 'Reply', 'Save as note']) await expect(row.getByRole('button', { name: n, exact: true })).toBeVisible();
  await expect(page.locator('.message-more-go')).toHaveCount(0);
  if (touch()) for (const b of await row.getByRole('button').all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await shot(page, '04-actions');
  // 👍 is a reaction, made from the app; a second tap takes it back
  await row.getByRole('button', { name: 'Thumbs up', exact: true }).click();
  await expect.poll(() => calls(page, 'react_message')).toEqual([{ channel: 'ch-kiln', target: 'k3', emoji: '👍' }]);
  await expect(latest.locator('.reactions .pill.mine')).toContainText('👍');
  // Try again asks this room's Uni for another answer
  const before = (await posts(page)).length;
  await row.getByRole('button', { name: 'Ask Uni to try again', exact: true }).click();
  expect((await posts(page)).slice(before)).toEqual([{ channel: 'ch-kiln', body: '/retry', recipients: [UNI] }]);
  await expect(list(page).locator('article.message.mine', { hasText: '/retry' })).toHaveCount(0);
  await expect(list(page).locator('.uni-retried')).toContainText('You asked Uni to try again');
  // Save as note keeps the words in the vault, saying where they came from
  await row.getByRole('button', { name: 'Save as note', exact: true }).click();
  await expect.poll(async () => (await calls(page, 'vault_create')).length).toBe(1);
  const made = (await calls(page, 'vault_create'))[0];
  expect(made.content).toContain('Three glaze tiles came out glossy');
  expect(made.content).toContain('Kiln Studio');
  await expect(page.getByText(/Saved as a note/)).toBeVisible();
  // an older message: its row on hover (desktop), its sheet on a long press (touch), which Back closes first
  const older = list(page).locator('article.message[data-ref="k1"]');
  if (!touch()) {
    const olderRow = older.getByRole('group', { name: 'Message actions' });
    await page.mouse.move(1, 1);
    await expect(olderRow).toHaveCSS('opacity', '0');
    await older.hover();
    await expect(olderRow).toHaveCSS('opacity', '1');
    await expect(olderRow.getByRole('button', { name: 'Copy', exact: true })).toBeVisible();
    // a keyboard reaches it too: focus inside shows the row
    await page.mouse.move(1, 1);
    await olderRow.getByRole('button', { name: 'Reply', exact: true }).focus();
    await expect(olderRow).toHaveCSS('opacity', '1');
    const own = list(page).locator('article.message[data-ref="k2"]');
    await own.hover();
    await expect(own.getByRole('group', { name: 'Message actions' }).getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
  } else {
    await older.scrollIntoViewIfNeeded();
    const b = (await older.locator('p').first().boundingBox())!;
    await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y)!;
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, pointerType: 'touch', isPrimary: true }));
    }, { x: b.x + 20, y: b.y + 8 });
    // the finger stays down until the sheet is up, as a person's does
    const sheet = page.getByRole('dialog', { name: 'Message actions' });
    await expect(sheet).toBeVisible();
    await page.evaluate(({ x, y }) => { document.elementFromPoint(x, y)!.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y, pointerType: 'touch', isPrimary: true })); }, { x: b.x + 20, y: b.y + 8 });
    for (const e of ['👍', '❤️', '✓', '❓']) await expect(sheet.getByRole('button', { name: `React ${e}` })).toBeVisible();
    for (const n of ['Reply', 'Copy', 'Save as note', 'Select text']) {
      const btn = sheet.getByRole('button', { name: n, exact: true });
      await expect(btn).toBeVisible();
      expect((await btn.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await shot(page, '05-sheet');
    await page.evaluate(() => { const w = window as any; w.__cbs[w.__backHandler.id]({ message: {}, index: w.__backIndex ?? 0 }); w.__backIndex = (w.__backIndex ?? 0) + 1; });
    await expect(sheet).toHaveCount(0);
    await expect(box(page)).toBeVisible();
  }
});

test('reading: a long answer has a book page\'s rhythm; tables keep their words whole; the phone composer gives the text the width', async ({ page }) => {
  await boot(page);
  await openRoom(page, 'Kiln Studio');
  const body = '## Shelf plan\n\nThe first paragraph says what changed this week in the studio.\n\nThe second paragraph says what is left to do before Friday.\n\n- Wax the feet\n- Load the shelf\n\n| tile | glaze | shrinkage | weight |\n| --- | --- | --- | --- |\n| A | celadon | Shrinkage twelve percent | 1240 |\n| B | tenmoku | Shrinkage eleven percent | 980 |\n\n```\ncone 6  1222C  ok\n```';
  await page.evaluate((b) => (window as any).__arrive('ch-kiln', 'Uni', b), body);
  const m = list(page).locator('article.message', { hasText: 'Shelf plan' }).last();
  await expect(m).toBeVisible();
  await m.scrollIntoViewIfNeeded();
  const r = await m.evaluate((el) => {
    const ps = [...el.querySelectorAll('.md > p:not(.md-h)')] as HTMLElement[];
    const h = el.querySelector('.md-h') as HTMLElement;
    const cells = [...el.querySelectorAll('td, th')] as HTMLElement[];
    const wrap = el.querySelector('.md-table-wrap') as HTMLElement;
    const content = el.querySelector('.message-content') as HTMLElement;
    const lis = [...el.querySelectorAll('li')] as HTMLElement[];
    const num = cells.find((c) => c.textContent === '1240')!;
    return {
      gap: ps[1].getBoundingClientRect().top - ps[0].getBoundingClientRect().bottom,
      hSize: parseFloat(getComputedStyle(h).fontSize), pSize: parseFloat(getComputedStyle(ps[0]).fontSize), hWeight: Number(getComputedStyle(h).fontWeight),
      breaks: cells.map((c) => `${getComputedStyle(c).wordBreak}/${getComputedStyle(c).overflowWrap}`).filter((s) => /break-all|anywhere|break-word/.test(s)),
      cellsOver: cells.filter((c) => c.scrollWidth > c.clientWidth + 1).length,
      wrapInside: wrap.getBoundingClientRect().right <= content.getBoundingClientRect().right + 1,
      numAlign: getComputedStyle(num).textAlign,
      liGap: lis[1].getBoundingClientRect().top - lis[0].getBoundingClientRect().bottom,
      code: getComputedStyle(el.querySelector('pre')!).fontFamily,
    };
  });
  expect(r.gap).toBeGreaterThanOrEqual(12);
  expect(r.hSize).toBe(r.pSize);
  expect(r.hWeight).toBeGreaterThanOrEqual(600);
  expect(r.breaks).toEqual([]);
  expect(r.cellsOver).toBe(0);
  expect(r.wrapInside).toBe(true);
  expect(r.numAlign).toBe('right');
  expect(r.liGap).toBeGreaterThanOrEqual(4);
  expect(r.code).toContain('JetBrains Mono');
  await shot(page, '06-reading');
  if (project() === 'phone') {
    // the spec asks 280 px; with the menu, the mic and Send kept (earlier contracts) and the listening ring moved inside the field, the
    // field box is 240 px at 390, its text 202 px (measured on 0.1.90: 194 and 190)
    await box(page).click();
    expect((await box(page).boundingBox())!.width).toBeGreaterThanOrEqual(236);
    for (const b of await page.locator('.composer .compose-row button:visible').all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
});

test('the New line: a room opened on unread lands on the first unread message, under "New · since …"', async ({ page }) => {
  await boot(page, { 'ch-kiln': 0 });
  // three long unread answers, so landing at the end would show only the last one's tail
  await page.evaluate((b) => { const w = window as any; for (let i = 0; i < 3; i++) w.__arrive('ch-kiln', 'Uni', `Unread ${i + 1}. ${b}`, 600 - i * 60); }, LONG);
  await openRoom(page, 'Kiln Studio');
  const line = list(page).locator('.new-line');
  await expect(line).toHaveText(/^New · since \d{1,2}:\d{2}/);
  const pos = await page.evaluate(() => {
    const l = document.querySelector('.message-list')!.getBoundingClientRect();
    const n = document.querySelector('.message-list .new-line')!.getBoundingClientRect();
    const next = document.querySelector('.message-list .new-line + article.message')?.textContent ?? '';
    return { top: n.top - l.top, next };
  });
  expect(pos.top).toBeGreaterThanOrEqual(0);
  expect(pos.top).toBeLessThanOrEqual(80);
  expect(pos.next).toContain('Unread 1.');
  await shot(page, '07-new-line');
});

test('quick replies: a question with plain answers shows them as chips; a tap sends it as you and the chips go', async ({ page }) => {
  await boot(page);
  await openRoom(page, 'Bee Garden');
  const chips = page.getByRole('group', { name: 'Quick replies' });
  await expect(chips.getByRole('button')).toHaveText(['Yes', 'No', 'Not now']);
  if (touch()) for (const b of await chips.getByRole('button').all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await shot(page, '08-chips');
  const before = (await posts(page)).length;
  await chips.getByRole('button', { name: 'Yes' }).click();
  expect((await posts(page)).slice(before)).toEqual([{ channel: 'ch-bees', body: 'Yes', recipients: [UNI] }]);
  await expect(chips).toHaveCount(0);
});

test('Daylight: the send moment has no motion: nothing animates longer than 120 ms, and the status is a ring in words', async ({ page }) => {
  test.skip(!daylight(), 'the e-ink device');
  await boot(page);
  await openRoom(page, 'Kiln Studio');
  await sendAndLook(page, 'Is the shelf by the window free?');
  await page.waitForTimeout(60);
  const long = await page.evaluate(() => document.getAnimations().map((a) => Number((a.effect as KeyframeEffect | null)?.getComputedTiming().duration ?? 0)).filter((d) => d > 120));
  expect(long).toEqual([]);
  await expect(status(page)).toBeVisible();
  await expect(status(page).locator('.uni-status-ring')).toBeVisible();
  await page.evaluate((b) => (window as any).__arrive('ch-kiln', 'Uni', b), LONG);
  await page.waitForTimeout(60);
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
});

test('All: a sure route is named on Send; with no good signal nothing is chosen and Send waits; the feed reads in runs, long replies clamped, no pings', async ({ page }) => {
  await boot(page, {}, 'all');
  const field = page.getByRole('textbox', { name: 'Message for your rooms' });
  const feed = page.getByRole('log', { name: 'All rooms, by time' });
  await expect(feed.locator('article.all-msg')).toHaveCount(13);
  // runs: a room's label only where the room changes (choir, north, kiln, bees, table, north, bees, kiln, choir)
  await expect(feed.locator('.all-place')).toHaveCount(9);
  // a ping never shows; a long reply shows its start and a way into its room
  await page.evaluate(() => (window as any).__arrive('ch-north', 'Uni', '⏳ Working — 3 min — iteration 4/90, terminal'));
  await page.evaluate((b) => (window as any).__arrive('ch-kiln', 'Uni', b), LONG);
  await expect(feed.getByRole('button', { name: 'Read the rest in Kiln Studio ›' })).toBeVisible();
  await expect(feed).not.toContainText('⏳');
  // a sure route: chosen, and Send says where
  await field.fill('Is the honey ready to jar?');
  await expect(page.locator('.all-chip.chosen .all-chip-name')).toHaveText(['Bee Garden']);
  await expect(page.locator('.all-send')).toHaveText('Send to Bee Garden');
  // no good signal: a suggestion to tap, nothing chosen, Send waits
  await field.fill('Something quick before the weekend');
  await expect(page.locator('.all-chip.chosen')).toHaveCount(0);
  await expect(page.locator('.all-chip.suggested').first()).toBeVisible();
  await expect(page.locator('.all-send')).toBeDisabled();
  await expect(page.locator('.all-send')).toHaveText('Choose a room');
  const before = (await posts(page)).length;
  if (!touch()) await field.press('Enter');
  expect((await posts(page)).length).toBe(before);
  await expect(page.locator('.all-note')).toContainText('Pick a room, or keep typing');
  await shot(page, '09-all-choose');
  await page.locator('.all-chip.suggested').first().click();
  await expect(page.locator('.all-chip.chosen')).toHaveCount(1);
  await expect(page.locator('.all-send')).toBeEnabled();
  await expect(page.locator('.all-send')).toHaveText(/^Send to /);
});

// T-335 review (fresh reviewer, NO-SHIP → fixed): a failed send never freezes the room, the buttons' words post once, Stop waits for the
// question to be posted, your own message can be deleted from the sheet
test('review: a failed send puts the text back and the room follows new messages again', async ({ page }) => {
  await boot(page);
  await openRoom(page, 'Kiln Studio');
  await page.evaluate(() => { const w = window as any; w.__failOnce = 1; w.__extraInvoke = async (cmd: string) => { if (cmd === 'post_message' && w.__failOnce-- > 0) { await new Promise((r) => setTimeout(r, 300)); throw new Error('relay unreachable'); } return undefined; }; });
  const q = 'This one will not go';
  const look = await sendAndLook(page, q);
  expect(look.value).toBe('');
  await expect(page.locator('.composer .error')).toContainText('relay unreachable');
  await expect(box(page)).toHaveValue(q);
  await expect(status(page)).toHaveCount(0);
  // a message from Uni now: the room follows it to the end, as before the send
  await page.evaluate(() => (window as any).__arrive('ch-kiln', 'Uni', 'The kiln is cooling; I will check it at six.'));
  await expect(list(page).getByText('The kiln is cooling')).toBeInViewport();
  await expect.poll(() => list(page).evaluate((l) => l.scrollHeight - l.scrollTop - l.clientHeight)).toBeLessThan(4);
});

test('review: Stop waits for the question to be posted, and two taps post one stop', async ({ page }) => {
  await boot(page);
  await openRoom(page, 'Kiln Studio');
  await page.evaluate(() => { (window as any).__postDelay = 900; });
  await sendAndLook(page, 'Count the cones on the shelf');
  const stop = page.getByRole('button', { name: 'Stop Uni' });
  await expect(stop).toBeDisabled();
  await expect(stop).toBeEnabled({ timeout: 5000 });
  await page.evaluate(() => (window as any).__react('ch-kiln', '👀'));
  const before = (await posts(page)).length;
  await page.evaluate(() => { const b = document.querySelector<HTMLButtonElement>('.composer button[aria-label="Stop Uni"]')!; b.click(); b.click(); });
  await expect(list(page).locator('.uni-stopped')).toBeVisible();
  await page.waitForTimeout(1200);
  expect((await posts(page)).slice(before).filter((p) => p.body === '/stop')).toHaveLength(1);
});

test('review: on touch, your own message can be deleted from its sheet (a second tap confirms)', async ({ page }) => {
  test.skip(!touch(), 'the long-press sheet');
  await boot(page);
  await openRoom(page, 'Kiln Studio');
  const own = list(page).locator('article.message[data-ref="k2"]');
  await own.scrollIntoViewIfNeeded();
  const b = (await own.locator('p').first().boundingBox())!;
  await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, pointerType: 'touch', isPrimary: true })), { x: b.x + 10, y: b.y + 8 });
  const sheet = page.getByRole('dialog', { name: 'Message actions' });
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveAttribute('aria-modal', 'true');
  await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)!.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y, pointerType: 'touch', isPrimary: true })), { x: b.x + 10, y: b.y + 8 });
  await expect(sheet.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
  await page.waitForTimeout(450); // the sheet takes no tap in its first 400 ms (the lift of the finger that opened it)
  await sheet.getByRole('button', { name: 'Delete your message' }).click();
  await expect(sheet.getByRole('button', { name: 'Tap again to delete your message' })).toBeVisible();
  expect(await calls(page, 'delete_message')).toHaveLength(0);
  await sheet.getByRole('button', { name: 'Tap again to delete your message' }).click();
  await expect.poll(() => calls(page, 'delete_message')).toEqual([{ channel: 'ch-kiln', target: 'k2' }]);
  await expect(sheet).toHaveCount(0);
});

// T-335 /code-review: the relay took it but this device's copy failed: it was sent, so the text stays gone; Uni at work on someone
// else's question still says so; Continue goes once something has been said since the stop
test('review: a send the relay accepted is sent; a ping in someone else\'s turn is a line in words', async ({ page }) => {
  await boot(page);
  await openRoom(page, 'Kiln Studio');
  await page.evaluate(() => { const w = window as any; w.__acceptOnce = 1; w.__extraInvoke = async (cmd: string) => { if (cmd === 'post_message' && w.__acceptOnce-- > 0) { await new Promise((r) => setTimeout(r, 200)); throw { accepted: true, eventId: 'e'.repeat(64), message: 'accepted, local copy missing' }; } return undefined; }; });
  await sendAndLook(page, 'Already on the relay');
  await page.waitForTimeout(600);
  await expect(box(page)).toHaveValue('');
  await expect(page.locator('.composer .error')).toHaveCount(0);
  // someone else's turn: Rowan asked, Uni pings
  await page.evaluate(() => { (window as any).__arrive('ch-kiln', 'Rowan', 'Uni, can you weigh the clay?'); (window as any).__arrive('ch-kiln', 'Uni', '⏳ Working — 2 min — iteration 3/90, terminal'); });
  await expect(status(page)).toContainText('Running a command');
  await expect(list(page).getByText(/⏳ Working/)).toHaveCount(0);
});

test('review: after your own stop, a late ping says nothing; someone else\'s wait never says "you can leave"', async ({ page }) => {
  await boot(page);
  await openRoom(page, 'Kiln Studio');
  await sendAndLook(page, 'Weigh every bag of clay');
  await page.evaluate(() => (window as any).__react('ch-kiln', '👀'));
  await page.getByRole('button', { name: 'Stop Uni' }).click();
  await expect(list(page).locator('.uni-stopped')).toBeVisible();
  await page.evaluate(() => (window as any).__arrive('ch-kiln', 'Uni', '⏳ Working — 1 min — iteration 2/90, terminal'));
  await page.waitForTimeout(800);
  await expect(status(page)).toHaveCount(0);
  // Rowan's turn, its ping three minutes old: the line says what Uni is doing, but no "you can leave" (it isn't your wait)
  await page.evaluate(() => { (window as any).__arrive('ch-kiln', 'Rowan', 'Uni, can you check the cones?'); (window as any).__arrive('ch-kiln', 'Uni', '⏳ Working — 3 min — iteration 4/90, read_file', 180, true); });
  await expect(status(page)).toContainText('Reading files');
  await expect(status(page).locator('.uni-status-leave')).toHaveCount(0);
});

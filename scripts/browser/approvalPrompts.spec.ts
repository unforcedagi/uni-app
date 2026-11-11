// T-161: a Hermes approval prompt posted in a room is told once, shows in its room as a prompt with a banner over the composer, and goes when Hermes says
// it was approved, denied or timed out, or when its own window ends. T-335 the shape: a prompt ending within 15 minutes is also a pin on home (`.sh-pin`);
// the retired "Needs you" list is gone: its row assertions in tests 1-3 are dropped, and 2 and 2b now check the pin. A message
// that only talks about approving is never one. The prompts are synthetic copies of the gateway's shapes (scripts/fixtures).
// Run: PROMPTS_TEST_PORT=5741 npx playwright test --config playwright.prompts.config.ts
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import { bootAreas } from './areasFixture';
import { homeHead, openRoom } from './shapeNav';

const fx = JSON.parse(readFileSync(new URL('../fixtures/approval-prompts.json', import.meta.url), 'utf8'));
const ROOM = 'ch-garden';
/** the fixture's user, by a made-up name */
const ME = 'Kit (you)';
const SHOTS = 'scripts/browser/__shots__/prompts';
const android = (page: Page) => page.evaluate(() => /Android/i.test(navigator.userAgent));

async function boot(page: Page) {
  // the clock runs as usual until a test moves it on; notifications are recorded, not shown
  await page.clock.install();
  await page.addInitScript(() => {
    const w = window as any; w.__notes = [];
    w.Notification = class { static permission = 'granted'; static requestPermission = async () => 'granted'; constructor(title: string, o: { body?: string } = {}) { w.__notes.push({ title, body: o.body ?? '' }); } };
  });
  await bootAreas(page, 'seed', { tree: true, tasks: true, briefs: true, strayRoom: true });
  await expect(homeHead(page)).toBeVisible();
}
/** the pins on home: a prompt or card that ends within 15 minutes */
const pins = (page: Page) => page.locator('.sh-pin');
/** the room, from home, then (when the prompt is in a thread) its thread */
async function intoRoom(page: Page, thread: string | null = null) {
  await openRoom(page, ROOM);
  if (thread) { await page.locator(`article.message[data-ref="${thread}"]`).locator('.thread-summary').click(); await expect(page.locator('.sh-room h1')).toContainText('thread'); }
}
/** a message over the live socket, each one second (and `later` more) after the one before (the fixture's own clock is the boot time) */
const arrive = (page: Page, body: string, who = 'Uni', room = ROOM, root: string | null = null, later = 0) => page.evaluate(([c, n, b, r, l]) => { const w = window as any; w.__k = (w.__k ?? 0) + 1 + l; return w.__arrive(c, n, b, -w.__k, false, r); }, [room, who, body, root, later] as const);
/** the app has read the store since the last message arrived (the hook re-reads on each live message) */
const reads = (page: Page) => page.evaluate(() => (window as any).__calls.filter((c: any) => c.cmd === 'approval_messages').length);
async function settled(page: Page, before: number) { await expect.poll(() => reads(page)).toBeGreaterThan(before); await page.waitForTimeout(150); }
const shot = async (page: Page, name: string) => { await mkdir(SHOTS, { recursive: true }); await page.screenshot({ path: `${SHOTS}/${name}-${page.viewportSize()!.width}x${page.viewportSize()!.height}.png` }); };

test.describe('a Hermes approval prompt, loudly', () => {
  test.describe.configure({ timeout: 120_000 });
  test('1. a prompt in a room is told once; its room shows it marked, with the banner over the composer', async ({ page }) => {
    await boot(page);
    await expect(pins(page)).toHaveCount(0);
    const ref = await arrive(page, fx.prompts.two_answers_30min);
    // 30 minutes out: not pinned yet; it waits in its room
    await expect(pins(page)).toHaveCount(0);
    // one notification, on the desktop (Android has no notification path from the app yet)
    if (await android(page)) expect(await page.evaluate(() => (window as any).__notes.length)).toBe(0);
    else await expect.poll(() => page.evaluate(() => (window as any).__notes)).toEqual([{ title: 'Uni in #garden-club', body: 'Needs your OK to run: git branch -D feature/example-cleanup' }]);
    // read again (a message elsewhere): still one row, and no second notification
    const n = await reads(page);
    await arrive(page, 'Unrelated chatter in another room.', ME, 'ch-unf');
    await settled(page, n);
    expect((await page.evaluate(() => (window as any).__notes.length))).toBeLessThanOrEqual(1);
    await shot(page, '01-home');
    // the room shows the prompt, marked, with the banner over the composer; nothing is sent for the user
    await intoRoom(page);
    const prompt = page.locator(`.message.approval-waiting[data-ref="${ref}"]`);
    await expect(prompt).toBeVisible();
    await expect(page.locator('.approval-banner')).toContainText('Uni needs your OK to run git branch -D feature/example-cleanup. Reply /approve, /approve session or /deny below');
    expect(await page.evaluate(() => (window as any).__calls.filter((c: any) => c.cmd === 'post_message').length)).toBe(0);
    await shot(page, '02-room');
    // T-335: in the room the prompt is one short row: the command, how to answer; the full command and why behind details
    const pc = prompt.getByRole('region', { name: 'Uni needs your OK: git branch -D feature/example-cleanup' });
    await expect(pc.locator('.cc-what')).toHaveText('git branch -D feature/example-cleanup');
    await expect(pc.locator('.cc-meta')).toHaveText(/^Uni needs your OK · reply \/approve, \/approve session or \/deny · ends \d{1,2}:\d{2}\s?[AP]M · details$/);
    await expect(pc.getByText(/Why it was flagged/)).toHaveCount(0);
    await pc.getByRole('button', { name: 'details' }).click();
    await expect(pc.getByText('Why it was flagged: git branch force delete')).toBeVisible();
    // still answered in words: no approve button in the chat
    await expect(pc.getByRole('button', { name: /approve|deny/i })).toHaveCount(0);
    // Hermes says it was approved: the banner and the mark go
    await arrive(page, '/approve', ME);
    await arrive(page, fx.outcomes.approved);
    await expect(page.locator('.approval-banner')).toHaveCount(0);
    await expect(page.locator('.message.approval-waiting')).toHaveCount(0);
    // T-335: and the prompt folds to one line saying how it ended
    const done = page.locator(`.message[data-ref="${ref}"] .cc-done`);
    await expect(done.locator('summary')).toHaveText(/^✓Approved · git branch -D feature\/example-cleanup · \d{2}:\d{2}/);
    await expect(done.locator('details')).not.toHaveAttribute('open');
    await shot(page, '03-room-answered');
  });

  test('2. a prompt ending within 15 minutes is pinned on home with its room and command, and leaves when Hermes says approved, denied or timed out', async ({ page }) => {
    await boot(page);
    await arrive(page, fx.prompts.three_answers_5min);
    await expect(pins(page)).toHaveCount(1);
    await expect(pins(page).locator('.sh-pin-room')).toHaveText('garden-club');
    await expect(pins(page).locator('h3')).toHaveText('OK to run rm -rf /tmp/example-build/cache?');
    await shot(page, '01-pin');
    for (const outcome of ['approved', 'denied'] as const) {
      if (outcome === 'denied') await arrive(page, fx.prompts.three_answers_5min);
      await expect(pins(page)).toHaveCount(1);
      // the user's own reply is not the outcome: it waits until Hermes answers
      const n = await reads(page);
      await arrive(page, outcome === 'denied' ? '/deny' : '/approve', ME);
      await settled(page, n);
      await expect(pins(page)).toHaveCount(1);
      await arrive(page, fx.outcomes[outcome]);
      await expect(pins(page), outcome).toHaveCount(0);
    }
    // the timeout notice comes when the window it stated is up (five minutes on), and settles that prompt
    await arrive(page, fx.prompts.three_answers_5min);
    await expect(pins(page)).toHaveCount(1);
    await arrive(page, fx.outcomes.timed_out_5, 'Uni', ROOM, null, 299);
    await expect(pins(page), 'timed out').toHaveCount(0);
    // two at once: one approval settles the older, a plural one both
    await arrive(page, fx.prompts.three_answers_5min);
    await arrive(page, fx.prompts.multiline_why);
    await expect(pins(page)).toHaveCount(2);
    await arrive(page, fx.outcomes.approved);
    await expect(pins(page)).toHaveCount(1);
    await arrive(page, fx.outcomes.denied);
    await expect(pins(page)).toHaveCount(0);
  });

  test('2b. withdrawn with no message, a pinned prompt stays until the window it stated is up, then goes by itself', async ({ page }) => {
    await boot(page);
    await arrive(page, fx.prompts.three_answers_5min);
    await expect(pins(page)).toHaveCount(1);
    await page.clock.fastForward('04:00');
    await expect(pins(page)).toHaveCount(1);
    await page.clock.fastForward('01:30');
    await expect(pins(page)).toHaveCount(0);
  });

  test('3. a message that only mentions approving is not flagged; a real prompt still is', async ({ page }) => {
    await boot(page);
    const n = await reads(page);
    for (const body of Object.values(fx.not_prompts) as string[]) await arrive(page, body);
    // the user pasting a prompt is not Hermes asking
    await arrive(page, fx.prompts.three_answers_5min, ME);
    await settled(page, n);
    await page.waitForTimeout(400);
    await expect(pins(page)).toHaveCount(0);
    await intoRoom(page);
    await expect(page.locator('.approval-banner')).toHaveCount(0);
    await expect(page.locator('.message.approval-waiting')).toHaveCount(0);
    if (!(await android(page))) expect(await page.evaluate(() => (window as any).__notes.length)).toBe(0);
    await arrive(page, fx.prompts.smart_deny);
    await expect(page.locator('.message.approval-waiting')).toHaveCount(1);
    await expect(page.locator('.approval-banner')).toContainText('Uni needs your OK');
  });

  test('4. a prompt posted as a reply is shown in its thread', async ({ page }) => {
    await boot(page);
    const top = await arrive(page, 'Cleaning up the old example branches now.');
    const ref = await arrive(page, fx.prompts.two_answers_30min, 'Uni', ROOM, top);
    await intoRoom(page, top);
    await expect(page.locator(`.message.approval-waiting[data-ref="${ref}"]`)).toBeVisible();
    await expect(page.locator('.message.thread-root')).toContainText('Cleaning up the old example branches now.');
    await expect(page.getByRole('status').filter({ hasText: "isn't in the loaded history" })).toHaveCount(0);
    // answered in the thread: it goes
    await arrive(page, '/approve', ME, ROOM, top);
    await arrive(page, fx.outcomes.approved, 'Uni', ROOM, top);
    await expect(page.locator('.approval-banner')).toHaveCount(0);
    await expect(page.locator('.message.approval-waiting')).toHaveCount(0);
    await expect(page.locator(`.message[data-ref="${ref}"] .cc-done`).getByRole('status')).toHaveText('Approved');
  });
  test('5. T-335: a prompt in a thread answered at the top of the room shows how it ended, in the thread', async ({ page }) => {
    await boot(page);
    const top = await arrive(page, 'Tidying the example branches next.');
    const ref = await arrive(page, fx.prompts.two_answers_30min, 'Uni', ROOM, top);
    await intoRoom(page, top);
    const card = page.locator(`.message[data-ref="${ref}"] .cc`);
    await expect(card).toHaveClass(/cc-pending/);
    // Hermes answers at the top of the room (nothing else waits there): the thread's own messages don't hold that answer
    await arrive(page, fx.outcomes.denied);
    await expect(page.locator('.approval-banner')).toHaveCount(0);
    await expect(card.getByRole('status')).toHaveText('Denied');
    await expect(card.locator('summary')).toHaveText(/^✕Denied · git branch -D feature\/example-cleanup · \d{1,2}:\d{2}/);
  });
  test('6. T-335: a prompt older than the store\'s day is no longer waiting, with no outcome guessed; one the store couldn\'t read is unknown, never waiting', async ({ page }) => {
    await boot(page);
    const fresh = await arrive(page, fx.prompts.two_answers_30min);
    // two days ago, its window long over; the store's read (a day) never sees it
    const old = await page.evaluate(([c, b]) => (window as any).__arrive(c, 'Uni', b, 2 * 86400), [ROOM, fx.prompts.once_or_deny_30min] as const);
    await intoRoom(page);
    const oldCard = page.locator(`.message[data-ref="${old}"] .cc`);
    await expect(oldCard.getByRole('status')).toHaveText('No longer waiting');
    await expect(oldCard.locator('summary')).toHaveText('–No longer waiting · chmod -R 777 /srv/example');
    await expect(page.locator(`.message[data-ref="${fresh}"] .cc`)).toHaveClass(/cc-pending/);
    // the store can't be read: a new prompt says so, and is not drawn as waiting
    await page.evaluate(() => { (window as any).__approvalsFail = true; });
    const next = await arrive(page, fx.prompts.smart_deny);
    const nextCard = page.locator(`.message[data-ref="${next}"] .cc`);
    await expect(nextCard.getByRole('status')).toHaveText("Couldn't check whether it still waits");
    await expect(nextCard).not.toHaveClass(/cc-pending/);
    // and the one the list still holds as waiting may have been answered since: unknown too, not waiting
    await expect(page.locator(`.message[data-ref="${fresh}"] .cc`).getByRole('status')).toHaveText("Couldn't check whether it still waits");
    await expect(page.locator(`.message[data-ref="${fresh}"] .cc`)).not.toHaveClass(/cc-pending/);
    // read again: it waits
    await page.evaluate(() => { (window as any).__approvalsFail = false; });
    await arrive(page, 'Chatter that makes the app read again.', ME);
    await expect(nextCard).toHaveClass(/cc-pending/);
  });
  test('7. T-335: an older read that lands after a newer one failed leaves the state unknown', async ({ page }) => {
    await boot(page);
    const ref = await arrive(page, fx.prompts.two_answers_30min);
    await intoRoom(page);
    const card = page.locator(`.message[data-ref="${ref}"] .cc`);
    await expect(card).toHaveClass(/cc-pending/);
    // the next read is slow and succeeds; the one after it fails at once
    await page.evaluate(() => { (window as any).__approvalsPlan = [{ ms: 1500, fail: false }, { ms: 0, fail: true }]; });
    const n = await reads(page);
    await arrive(page, 'First chatter.', ME);
    await expect.poll(() => reads(page)).toBe(n + 1);
    await arrive(page, 'Second chatter.', ME);
    await expect.poll(() => reads(page)).toBe(n + 2);
    await expect(card.getByRole('status')).toHaveText("Couldn't check whether it still waits");
    // the slow, older read lands now: still unknown
    await page.waitForTimeout(1800);
    await expect(card.getByRole('status')).toHaveText("Couldn't check whether it still waits");
    await expect(card).not.toHaveClass(/cc-pending/);
  });
});

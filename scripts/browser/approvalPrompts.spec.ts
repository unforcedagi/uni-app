// T-161: a Hermes approval prompt posted in a room is in Needs you at once (the room and the exact command), opens its room at the prompt
// with the composer focused, and leaves when Hermes says it was approved, denied or timed out, or when its own window ends. A message
// that only talks about approving is never one. The prompts are synthetic copies of the gateway's shapes (scripts/fixtures).
// Run: PROMPTS_TEST_PORT=5741 npx playwright test --config playwright.prompts.config.ts
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import { bootAreas } from './areasFixture';

const fx = JSON.parse(readFileSync(new URL('../fixtures/approval-prompts.json', import.meta.url), 'utf8'));
const ROOM = 'ch-garden';
const SHOTS = 'scripts/browser/__shots__/prompts';
const wide = (page: Page) => (page.viewportSize()?.width ?? 0) >= 900 && (page.viewportSize()?.height ?? 0) >= 400;
const android = (page: Page) => page.evaluate(() => /Android/i.test(navigator.userAgent));

async function boot(page: Page) {
  // the clock runs as usual until a test moves it on; notifications are recorded, not shown
  await page.clock.install();
  await page.addInitScript(() => {
    const w = window as any; w.__notes = [];
    w.Notification = class { static permission = 'granted'; static requestPermission = async () => 'granted'; constructor(title: string, o: { body?: string } = {}) { w.__notes.push({ title, body: o.body ?? '' }); } };
  });
  await bootAreas(page, 'seed', { tree: true, tasks: true, briefs: true, strayRoom: true });
  // Uni's level holds every room's prompts: beside the tree on a wide screen, the tree home itself on a phone
  if (wide(page)) {
    const nav = page.locator('.th-roomnav');
    await nav.locator('.th-row.d1').first().waitFor();
    await nav.locator('.th-go[aria-label^="Uni,"]').first().click();
    await expect(page.locator('.sr')).toHaveAttribute('data-node', 'Uni');
  } else await page.locator('.th-phone-tree, .cp.strip').first().waitFor();
}
/** the Daylight upright opens on Uni's level with Needs you folded to one line: open it */
const strip = (page: Page) => page.locator('.cp-line[aria-expanded="false"]');
async function unfold(page: Page) { if (await strip(page).count()) await strip(page).click(); }
const rows = (page: Page) => page.locator('.cp-approval');
/** a message over the live socket, each one second after the one before (the fixture's own clock is the boot time) */
const arrive = (page: Page, body: string, who = 'Uni', room = ROOM) => page.evaluate(([c, n, b]) => { const w = window as any; w.__k = (w.__k ?? 0) + 1; return w.__arrive(c, n, b, -w.__k); }, [room, who, body] as const);
/** the app has read the store since the last message arrived (the hook re-reads on each live message) */
const reads = (page: Page) => page.evaluate(() => (window as any).__calls.filter((c: any) => c.cmd === 'approval_messages').length);
async function settled(page: Page, before: number) { await expect.poll(() => reads(page)).toBeGreaterThan(before); await page.waitForTimeout(150); }
const shot = async (page: Page, name: string) => { await mkdir(SHOTS, { recursive: true }); await page.screenshot({ path: `${SHOTS}/${name}-${page.viewportSize()!.width}x${page.viewportSize()!.height}.png` }); };
const composerFocused = (page: Page) => page.evaluate(() => document.activeElement?.tagName === 'TEXTAREA' && !!document.activeElement.closest('.composer'));

test.describe('a Hermes approval prompt, loudly', () => {
  test.describe.configure({ timeout: 120_000 });
  test('1. a prompt in a room is in Needs you at once with its room and command; it opens the room at the prompt', async ({ page }) => {
    await boot(page);
    await expect(rows(page)).toHaveCount(0);
    const ref = await arrive(page, fx.prompts.two_answers_30min);
    // folded, its one line leads with the prompt
    if (await strip(page).count()) await expect(strip(page)).toContainText('OK to run git branch -D feature/example-cleanup?');
    await unfold(page);
    const row = rows(page);
    await expect(row).toHaveCount(1);
    await expect(row.locator('.cp-approval-lead')).toHaveText('Needs your OK in #garden-club');
    await expect(row.locator('.cp-approval-cmd')).toHaveText('git branch -D feature/example-cleanup');
    await expect(row.locator('.cp-approval-why')).toHaveText('git branch force delete');
    await expect(row.locator('.cp-approval-how')).toHaveText(/^Reply \/approve, \/approve session or \/deny · ends \d{1,2}:\d{2}\s?[AP]M$/);
    // one notification, on the desktop (Android has no notification path from the app yet)
    if (await android(page)) expect(await page.evaluate(() => (window as any).__notes.length)).toBe(0);
    else await expect.poll(() => page.evaluate(() => (window as any).__notes)).toEqual([{ title: 'Hermes in #garden-club', body: 'Needs your OK to run: git branch -D feature/example-cleanup' }]);
    // read again (a message elsewhere): still one row, and no second notification
    const n = await reads(page);
    await arrive(page, 'Unrelated chatter in another room.', 'Aaron', 'ch-unf');
    await settled(page, n);
    await expect(row).toHaveCount(1);
    expect((await page.evaluate(() => (window as any).__notes.length))).toBeLessThanOrEqual(1);
    await shot(page, '01-needs-you');
    // the row opens the room at the prompt, marked, with the banner over a focused composer; nothing is sent for the user
    await row.getByRole('button').click();
    const prompt = page.locator(`.message.approval-waiting[data-ref="${ref}"]`);
    await expect(prompt).toBeVisible();
    await expect(page.locator('.approval-banner')).toContainText('Hermes needs your OK to run git branch -D feature/example-cleanup. Reply /approve, /approve session or /deny below');
    await expect.poll(() => composerFocused(page)).toBe(true);
    expect(await page.evaluate(() => (window as any).__calls.filter((c: any) => c.cmd === 'post_message').length)).toBe(0);
    await shot(page, '02-room');
    // Hermes says it was approved: the banner and the mark go
    await arrive(page, '/approve', 'Aaron');
    await arrive(page, fx.outcomes.approved);
    await expect(page.locator('.approval-banner')).toHaveCount(0);
    await expect(page.locator('.message.approval-waiting')).toHaveCount(0);
  });

  test('2. it leaves Needs you when Hermes says approved, denied or timed out, and when its own window ends', async ({ page }) => {
    await boot(page); await unfold(page);
    for (const outcome of ['approved', 'denied', 'timed_out_30'] as const) {
      await arrive(page, fx.prompts.three_answers_5min);
      await expect(rows(page)).toHaveCount(1);
      // the user's own reply is not the outcome: it waits until Hermes answers
      const n = await reads(page);
      await arrive(page, outcome === 'denied' ? '/deny' : '/approve', 'Aaron');
      await settled(page, n);
      await expect(rows(page)).toHaveCount(1);
      await arrive(page, fx.outcomes[outcome]);
      await expect(rows(page), outcome).toHaveCount(0);
    }
    // two at once: one approval settles the older, a plural one both
    await arrive(page, fx.prompts.three_answers_5min);
    await arrive(page, fx.prompts.once_or_deny_30min);
    await expect(rows(page)).toHaveCount(2);
    await arrive(page, fx.outcomes.approved);
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).locator('.cp-approval-cmd')).toHaveText('chmod -R 777 /srv/example');
    await arrive(page, fx.outcomes.denied);
    await expect(rows(page)).toHaveCount(0);
    // withdrawn with no message: it stays until the window it stated is up, then goes by itself
    await arrive(page, fx.prompts.once_or_deny_30min);
    await expect(rows(page)).toHaveCount(1);
    await page.clock.fastForward('29:00');
    await expect(rows(page)).toHaveCount(1);
    await page.clock.fastForward('01:30');
    await expect(rows(page)).toHaveCount(0);
  });

  test('3. a message that only mentions approving is not flagged; a real prompt still is', async ({ page }) => {
    await boot(page); await unfold(page);
    const n = await reads(page);
    for (const body of Object.values(fx.not_prompts) as string[]) await arrive(page, body);
    // the user pasting a prompt is not Hermes asking
    await arrive(page, fx.prompts.three_answers_5min, 'Aaron');
    await settled(page, n);
    await page.waitForTimeout(400);
    await expect(rows(page)).toHaveCount(0);
    if (!(await android(page))) expect(await page.evaluate(() => (window as any).__notes.length)).toBe(0);
    await arrive(page, fx.prompts.smart_deny);
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).locator('.cp-approval-lead')).toHaveText('Override needs your OK in #garden-club');
  });
});

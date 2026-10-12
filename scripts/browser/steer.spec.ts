// T-122: "Steer, don't chat". The node page is the room's state (Needs you, Moved, Running, Drafts, Tasks), a steering bar replaces the
// talk bar, what a steer changed is marked in place, and the conversation is a Log strip that opens over the page.
// Run: STEER_TEST_PORT=5711 npx playwright test --config playwright.steer.config.ts
import { mkdir } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import { bootAreas } from './areasFixture';

const SHOTS = 'scripts/browser/__shots__/steer';
const BUILD = '7dcea809-25cd-4160-ba99-f0a56386adcb';
const wide = (page: Page) => (page.viewportSize()?.width ?? 0) >= 900;
const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const calls = (page: Page, cmd: string) => page.evaluate((c) => (window as any).__calls.filter((x: any) => x.cmd === c).map((x: any) => x.args), cmd);
const shot = async (page: Page, name: string) => {
  await mkdir(SHOTS, { recursive: true });
  const s = page.viewportSize()!;
  await page.screenshot({ path: `${SHOTS}/${name}-${s.width}x${s.height}.png` });
};
const base = { briefs: true, tree: true, tasks: true, atlas: true, steer: true, pinned: true, layout: 'rooms' } as const;
const boot = async (page: Page, extra: Parameters<typeof bootAreas>[2] = {}) => {
  await page.addInitScript(() => { (window as any).__STEER_POLL_MS = 1000; });
  await bootAreas(page, 'seed', { ...base, ...extra });
};
const scope = (page: Page) => (wide(page) ? page.locator('.th-roomnav') : page.locator('.th-phone-tree'));
/** Open a node from the room tree (phone: from the tree home; wide: the column beside the page). */
async function openNode(page: Page, name: string) {
  if (!wide(page) && await page.locator('.th-back').count()) await page.locator('.th-back').click();
  await scope(page).locator(`.th-go[aria-label^="${name},"]`).click();
  await expect(page.locator('.th-head h1')).toHaveText(name);
}
const panel = (page: Page) => page.locator('.th-panel');
const t07 = (page: Page) => panel(page).locator('.wr-row[data-id="T-07"]');

test.describe('steer', () => {
  test('the node page is the room\'s state: header, Needs you, Moved, Running, Drafts, Tasks, a Log strip and the steering bar', async ({ page }) => {
    await boot(page);
    await openNode(page, 'ATLAS');
    const head = page.locator('.th-head');
    await expect(head.locator('.th-door')).toHaveText('atlas/build');
    await expect(head.getByText("this node's context window")).toBeVisible();
    await expect(head.getByRole('region', { name: 'Where we are' })).toBeVisible();
    await expect(head.locator('.wr-counts')).toContainText('need you');
    const needs = panel(page).getByRole('region', { name: 'Needs you' });
    await expect(needs).toContainText('T-07');
    await expect(needs).toContainText('SOW for the commons grant');
    await expect(needs).toContainText('Decide the ATLAS hosting');
    await expect(needs.locator('.wr-open')).toHaveCount(1);
    await expect(panel(page).getByRole('region', { name: 'Moved this week' })).toBeVisible();
    const running = panel(page).getByRole('region', { name: 'Running', exact: true });
    await expect(running).toContainText('Draft the SOW');
    await expect(running.locator('.run-chip[data-state="running"]')).toHaveCount(1);
    await expect(running.locator('.run-chip[data-state="queued"]')).toHaveCount(1);
    await expect(running.locator('.run-chip[data-state="done"]')).toHaveCount(1);
    const drafts = panel(page).getByRole('region', { name: 'Drafts' });
    await expect(drafts).toContainText('SOW commons grant');
    await expect(drafts.locator('.draft[data-status="ready"]')).toHaveCount(1);
    await expect(panel(page).getByRole('region', { name: 'What needs doing here' })).toContainText('T-08');
    await expect(panel(page).getByRole('region', { name: 'What needs doing here' }).locator('.work-head')).toContainText('Tasks');
    await expect(page.locator('.talk, .th-sec.th-room, .th-ledger')).toHaveCount(0);
    await expect(page.locator('.logstrip')).toContainText(/Log · #atlas\/build · \d+ messages? today/);
    await expect(page.getByRole('textbox', { name: 'Steer ATLAS (#atlas/build)' })).toHaveAttribute('placeholder', 'Steer ATLAS (#atlas/build)…');
    if (wide(page)) {
      // two columns: Needs you on the left, Running on the right
      const l = (await needs.boundingBox())!, r = (await running.boundingBox())!;
      expect(r.x).toBeGreaterThan(l.x + l.width - 2);
      expect(Math.abs(r.y - l.y)).toBeLessThan(40);
    }
    // the bar is docked: it stays on screen while the page scrolls
    const bar = page.locator('.steer');
    await page.locator('.th-scroll').evaluate((e) => { e.scrollTop = e.scrollHeight; });
    const bb = (await bar.boundingBox())!;
    expect(bb.y + bb.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
    for (const b of [page.locator('.steer-mic'), page.locator('.steer-go'), page.locator('.logstrip')]) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await fits(page)).toBe(true);
    await page.locator('.th-scroll').evaluate((e) => { e.scrollTop = 0; });
    await shot(page, 'state');
  });

  test('a node held by an ancestor\'s room says so in the header and the bar', async ({ page }) => {
    await boot(page);
    await openNode(page, 'Atlas Institute');
    await expect(page.locator('.th-head .th-door')).toHaveText('held by #atlas');
    await expect(page.locator('.th-head').getByText("this node's context window")).toHaveCount(0);
    await expect(page.locator('.steer-line')).toHaveAttribute('placeholder', 'Steer Atlas Institute (held by #atlas)…');
    await expect(panel(page).getByRole('region', { name: 'Running', exact: true })).toHaveCount(0);
    await expect(panel(page).getByRole('region', { name: 'Drafts' })).toHaveCount(0);
    await shot(page, 'held');
  });

  test('steer: posts once to this node\'s room, then the item a room changed is marked in place with its old value', async ({ page }) => {
    await boot(page);
    await openNode(page, 'ATLAS');
    await expect(t07(page)).toContainText('due Oct 13');
    await expect(t07(page).locator('.chg')).toHaveCount(0);
    await page.getByRole('textbox', { name: 'Steer ATLAS (#atlas/build)' }).fill('push T-07 to Thursday');
    await page.getByRole('button', { name: 'Steer', exact: true }).click();
    await expect(page.locator('.steer-status')).toContainText('Sent to #atlas/build');
    const posts = (await calls(page, 'post_message')).filter((a: any) => a.body);
    expect(posts).toHaveLength(1);
    expect(posts[0].channel).toBe(BUILD);
    expect(posts[0].body).toBe('push T-07 to Thursday');
    await expect(page.locator('.steer-line')).toHaveValue('');
    // nothing marked yet: the room has not done anything
    await expect(page.locator('.chg')).toHaveCount(0);
    // the room moves the due date; the page re-reads on its own and marks it
    await page.evaluate(() => (window as any).__setDue('st7', '2026-10-15'));
    await expect(t07(page)).toHaveClass(/changed/, { timeout: 15000 });
    await expect(t07(page).locator('.chg')).toContainText('changed just now · was Tue 10-13');
    await expect(t07(page)).toContainText('due Oct 15');
    // nothing else is marked, and no reordering happened under him
    await expect(page.locator('.changed')).toHaveCount(1);
    expect(await page.locator('.wr-needs .wr-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-id')))).toContain('T-07');
    await shot(page, 'changed');
    // it stays marked while he looks around the page ...
    await page.getByRole('button', { name: /^Mark done/ }).first().isVisible();
    // ... and clears when the node is reopened
    await openNodeAway(page);
    await openNode(page, 'ATLAS');
    await expect(t07(page)).toContainText('due Oct 15');
    await expect(page.locator('.chg')).toHaveCount(0);
    expect(await page.evaluate(() => document.getAnimations().filter((a) => !Number.isFinite(a.effect?.getComputedTiming().endTime as number)).length)).toBe(0);
  });

  test('the Log is a collapsed strip: it opens over the page with the room\'s messages as slips and closes back to the state', async ({ page }) => {
    await boot(page);
    await openNode(page, 'ATLAS');
    const strip = page.locator('.logstrip');
    await expect(strip).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('dialog', { name: 'Log #atlas/build' })).toHaveCount(0);
    await strip.click();
    const log = page.getByRole('dialog', { name: 'Log #atlas/build' });
    await expect(log).toBeVisible();
    await expect(log.locator('.message')).toHaveCount(3);
    await expect(log).toContainText('Where are we on the SOW?');
    await expect(log.locator('.message-avatar').first()).toBeHidden();
    await expect(log.locator('.composer')).toBeHidden();
    // an entry is a ruled slip; Aaron's is boxed (a wider left rule)
    const mine = log.locator('.message.mine').first();
    expect(await mine.evaluate((e) => getComputedStyle(e).borderLeftWidth)).toBe('6px');
    expect(await log.locator('.message:not(.mine)').first().evaluate((e) => getComputedStyle(e).borderLeftWidth)).toBe('2px');
    // the steering bar stays under the Log
    await expect(page.locator('.steer-line')).toBeVisible();
    expect(await fits(page)).toBe(true);
    await shot(page, 'log');
    await log.getByRole('button', { name: 'Close' }).click();
    await expect(log).toHaveCount(0);
    await expect(page.locator('.th-head h1')).toHaveText('ATLAS');
    // Escape closes it too
    await strip.click();
    await expect(log).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(log).toHaveCount(0);
  });

  test('Open #room opens the Log, not a tab; the full room tab stays reachable from the Log header', async ({ page }) => {
    await boot(page);
    await openNode(page, 'ATLAS');
    const tabsBefore = await page.locator('.tab-title').count();
    await page.getByRole('button', { name: 'Open #atlas/build' }).click();
    const log = page.getByRole('dialog', { name: 'Log #atlas/build' });
    await expect(log).toBeVisible();
    await expect(page.locator('.tab-title')).toHaveCount(tabsBefore);
    await expect(page.locator('.th-head h1')).toHaveText('ATLAS');
    await log.getByRole('button', { name: 'Open as tab' }).click();
    await expect.poll(() => page.evaluate((id) => (window as any).__calls.some((c: any) => c.cmd === 'get_messages' && c.args?.channel === id), BUILD)).toBe(true);
    await expect(page.locator('.tab-title', { hasText: 'build' }).first()).toBeVisible();
  });

  test('the task sheet\'s "Open in #room" opens the Log about that task; the bar says About T-07 and the line carries it', async ({ page }) => {
    await boot(page);
    await openNode(page, 'ATLAS');
    await t07(page).locator('.wr-main').click();
    await page.getByRole('button', { name: 'Open in #atlas/build' }).click();
    const log = page.getByRole('dialog', { name: 'Log #atlas/build' });
    await expect(log).toBeVisible();
    await expect(log).toContainText('about T-07');
    const line = page.locator('.steer-line');
    await expect(line).toHaveAttribute('placeholder', 'About T-07…');
    await line.fill('Can this wait for Kevin?');
    await page.getByRole('button', { name: 'Steer', exact: true }).click();
    await expect.poll(async () => (await calls(page, 'post_message')).filter((a: any) => a.body).length).toBe(1);
    expect((await calls(page, 'post_message')).find((a: any) => a.body).body).toBe('About T-07: Can this wait for Kevin?');
    await log.getByRole('button', { name: 'Close' }).click();
    await expect(line).toHaveAttribute('placeholder', 'Steer ATLAS (#atlas/build)…');
  });

  test('chat off (profile chat.provider null): no steering bar, no Log, no room door', async ({ page }) => {
    await boot(page, { profileNote: { chat: { provider: null } } });
    await openNode(page, 'ATLAS');
    await expect(panel(page).getByRole('region', { name: 'Needs you' })).toContainText('T-07');
    await expect(page.locator('.steer, .logstrip, .steer-log, .th-door, .th-ctx, .talk')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Open #|Hold to talk/ })).toHaveCount(0);
    expect(await fits(page)).toBe(true);
    await shot(page, 'chat-off');
  });
});

/** Leave the node: wide, pick another node in the column; phone, back to the tree and into another. */
async function openNodeAway(page: Page) {
  await openNode(page, 'Atlas Institute');
}

// T-124: simple first. A room opens to its conversation (the app's own chat, clean); the state is a quiet companion beside it (desktop) or a
// one-line strip above it (phone): one sentence, at most three that need you, what is running. Nothing under a message; its actions are a ⋯ menu.
// "Everything here" goes one level deeper, to the full node page.
// Run: SIMPLE_TEST_PORT=5711 npx playwright test --config playwright.simple.config.ts
import { mkdir } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import { bootAreas } from './areasFixture';

const SHOTS = 'scripts/browser/__shots__/simple';
const BUILD = '7dcea809-25cd-4160-ba99-f0a56386adcb';
const wide = (page: Page) => (page.viewportSize()?.width ?? 0) >= 900;
const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const calls = (page: Page, cmd: string) => page.evaluate((c) => (window as any).__calls.filter((x: any) => x.cmd === c).map((x: any) => x.args), cmd);
const shot = async (page: Page, name: string) => {
  const s = page.viewportSize()!;
  if (s.width !== 1440 && s.width !== 390) return;
  await mkdir(SHOTS, { recursive: true });
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/${name}-${theme}-${s.width}x${s.height}.png` });
  }
  await page.emulateMedia({ colorScheme: 'light' });
};
const base = { briefs: true, tree: true, tasks: true, atlas: true, steer: true, pinned: true, layout: 'rooms' } as const;
const boot = (page: Page, extra: Parameters<typeof bootAreas>[2] = {}) => bootAreas(page, 'seed', { ...base, ...extra });
const scope = (page: Page) => (wide(page) ? page.locator('.th-roomnav') : page.locator('.th-phone-tree'));
/** Open a room from the rooms list (phone: back to the list first when a room is open). */
async function openRoom(page: Page, name: string) {
  if (!wide(page)) { await page.locator('.sr-back, .th-phone-tree').first().waitFor(); if (await page.locator('.sr-back').count()) await page.locator('.sr-back').click(); }
  await unfoldAll(page);
  await scope(page).locator(`.th-go[aria-label^="${name},"]`).click();
  await expect(page.locator('.sr-title')).toHaveText(name);
}
/** Areas start folded (all but the one holding the open room): open every fold so any row can be clicked. */
async function unfoldAll(page: Page) {
  await scope(page).locator('.th-row.d1').first().waitFor(); // the tree has loaded
  for (let i = 0; i < 12; i++) {
    const f = scope(page).locator('.th-fold[aria-expanded="false"]');
    if (!await f.count()) return;
    await f.first().click();
  }
}
const companion = (page: Page) => page.getByRole('region', { name: 'Where this stands' }).or(page.getByRole('complementary', { name: 'Where this stands' }));
/** The phone's strip opens on a tap; the side panel is open already. */
async function openCompanion(page: Page) {
  if (!wide(page) && await page.locator('.cp-line[aria-expanded="false"]').count()) await page.locator('.cp-line').click();
  await expect(page.locator('.cp-body')).toBeVisible();
}

test.describe('simple', () => {
  test('a room opens to its conversation, not a state page', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'ATLAS');
    const chat = page.locator('.sr-chat');
    await expect(chat.locator('.message')).toHaveCount(3);
    await expect(chat).toContainText('Where are we on the SOW?');
    await expect(chat.getByRole('textbox', { name: /^Message / })).toHaveAttribute('placeholder', 'Message #atlas/build');
    await expect(page.locator('.sr-door')).toHaveText('#atlas/build');
    // none of the state page's furniture is on this screen
    await expect(page.locator('.wr-counts, .th-sec, .wr-needs, .logstrip, .steer, .talk, .th-ledger')).toHaveCount(0);
    await expect(page.locator('.compose-hint')).toBeHidden();
    expect(await fits(page)).toBe(true);
    await shot(page, 'room');
  });

  test('the companion: where it stands (one sentence, quiet time), at most three that need you, what is running; each item opens its task', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'ATLAS');
    await openCompanion(page);
    const cp = page.locator('.cp-body');
    await expect(cp.locator('.cp-lede')).toContainText('The SOW is drafted and waits on Casey.');
    await expect(cp.locator('.cp-lede')).not.toContainText('The map comes next');
    await expect(cp.locator('.cp-ago')).toHaveText('2 days ago');
    const needs = cp.getByRole('region', { name: 'Needs you' });
    await expect(needs.locator('.cp-need')).toHaveCount(2);
    // the decision on this very node leads and carries its options as buttons
    // Now before Soon: the dated Now task first, then the decision (Soon), which carries its options as buttons
    await expect(needs.locator('.cp-need').first()).toContainText('SOW for the commons grant');
    await expect(needs.locator('.cp-need').nth(1)).toContainText('Decide the ATLAS hosting');
    await expect(needs.locator('.cp-opt')).toHaveText(['Self-host', 'Managed']);
    await expect(needs).toContainText('SOW for the commons grant');
    await expect(needs).toContainText('Confirm scope with Casey');
    await expect(needs).toContainText('due Oct 13');
    const running = cp.getByRole('region', { name: 'Running', exact: true });
    await expect(running).toContainText('Draft the SOW');
    await expect(running).not.toContainText(/scratch|Runs\//);
    await expect(running.locator('.cp-run')).toHaveCount(2); // running (T-125 shape) + queued (0.1.44 ledger); the finished one is not "running"
    await expect(running).not.toContainText('Summarise the grant call');
    // no count badges, counters row, moved list, drafts or tasks here, and no "+N more"
    await expect(cp.locator('.wr-counts, .th-h, .wr-h, em, .cp-more')).toHaveCount(0);
    await expect(cp.getByText(/Moved this week|Drafts|\d+ more|\d+ of \d+/)).toHaveCount(0);
    await shot(page, 'companion');
    // an item opens its task sheet
    await needs.locator('.cp-need[data-id="T-07"]').click();
    await expect(page.getByRole('dialog').first()).toContainText('T-07');
    await page.keyboard.press('Escape');
  });

  test('where it stands is the node\'s own sentence, never a count or the description', async ({ page }) => {
    await boot(page);
    await scope(page).locator('.th-go[aria-label^="Uni,"]').click();
    await expect(page.locator('.sr-title')).toHaveText('Uni');
    await openCompanion(page);
    await expect(page.locator('.cp-lede')).toContainText('Atlas and COhere are moving');
    await expect(page.locator('.cp-lede')).not.toContainText(/need you|areas/);
    await openRoom(page, 'Learn Vibe Build');
    await openCompanion(page);
    await expect(page.locator('.cp-lede')).toContainText('Cohort two starts Oct 15');
    await expect(page.locator('.cp-lede')).not.toHaveText(/^Learn Vibe Build\.?$/);
    // a node with no `stands` says the latest thing in plain words, or nothing: never the description's first sentence
    await openRoom(page, 'Atlas Institute');
    await openCompanion(page);
    const lede = page.locator('.cp-lede');
    if (await lede.count()) await expect(lede).not.toHaveText('Atlas Institute.');
  });

  test('every item that needs you is listed (no cap, no "+N more"); "Everything here" goes to the full page', async ({ page }) => {
    await boot(page);
    if (!wide(page)) await expect(page.locator('.th-phone-tree')).toBeVisible();
    await scope(page).locator('.th-go[aria-label^="Uni,"]').click();
    await expect(page.locator('.sr-title')).toHaveText('Uni');
    await openCompanion(page);
    const needs = page.locator('.cp-body').getByRole('region', { name: 'Needs you' });
    expect(await needs.locator('.cp-need').count()).toBeGreaterThanOrEqual(3);
    await expect(page.locator('.cp-more')).toHaveCount(0);
    await expect(page.locator('.cp-body')).not.toContainText(/\+\d+ more/);
    await page.getByRole('button', { name: /^All of .*'s work/ }).click();
    await expect(page.locator('.th-panel')).toBeVisible();
    await expect(page.locator('.wr-needs')).toBeVisible();
  });

  test('one tap on an option decides: a compare-and-set with the decided metadata', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'ATLAS');
    await openCompanion(page);
    const needs = page.locator('.cp-body').getByRole('region', { name: 'Needs you' });
    await needs.getByRole('button', { name: 'Self-host' }).click();
    await expect.poll(async () => (await calls(page, 'vault_decide')).length).toBe(1);
    const a = (await calls(page, 'vault_decide'))[0];
    expect(a).toMatchObject({ id: 'dq2', from: 'open', to: 'decided', metadata: { decided: 'Self-host', decided_by: expect.any(String) } });
    expect(Date.parse(a.metadata.decided_at)).not.toBeNaN();
    await expect(needs).not.toContainText('Decide the ATLAS hosting');
    await expect(needs).toContainText('SOW for the commons grant');
  });

  test('a decision someone else already decided says so and refreshes', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'ATLAS');
    await openCompanion(page);
    const needs = page.locator('.cp-body').getByRole('region', { name: 'Needs you' });
    await expect(needs.getByRole('button', { name: 'Managed' })).toBeVisible();
    await page.evaluate(() => (window as any).__decideElsewhere('dq2'));
    await needs.getByRole('button', { name: 'Managed' }).click();
    await expect(page.getByRole('status').filter({ hasText: /already decided/i })).toBeVisible();
    await expect(needs).not.toContainText('Decide the ATLAS hosting');
    await expect.poll(async () => (await calls(page, 'vault_decide')).length).toBe(1);
  });

  test('needs-you rows: the action, then its next step in full; raw links become short link text; the foot stays on screen at 1280x720', async ({ page }) => {
    test.skip(!wide(page), 'side panel');
    await page.setViewportSize({ width: 1280, height: 720 });
    await boot(page);
    await scope(page).locator('.th-go[aria-label^="Uni,"]').click();
    await openCompanion(page);
    expect(await page.locator('.cp-body .cp-item').count()).toBeGreaterThanOrEqual(2);
    await expect(page.locator('.cp-body')).not.toContainText(/https?:\/\//);
    const item = page.locator('.cp-item').filter({ hasText: 'COhere festival readiness' });
    await expect(item.locator('.cp-next')).toContainText('Check-in PR by Oct 12, see example.invalid for the diff');
    await expect(item.locator('.cp-link')).toHaveText('example.invalid');
    await expect(item.locator('.cp-link')).toHaveAttribute('href', 'https://example.invalid/pr/12');
    for (const el of await page.locator('.cp-body .cp-title').all()) expect(await el.evaluate((e) => e.getBoundingClientRect().height < 48)).toBeTruthy();
    const link = page.getByRole('button', { name: /^All of .*'s work/ });
    await page.locator('.cp.side').evaluate((e) => { e.scrollTop = e.scrollHeight; });
    const all = await link.boundingBox();
    expect(all!.y + all!.height).toBeLessThanOrEqual(720);
    expect(all!.height).toBeLessThan(48);
    await page.screenshot({ path: `${SHOTS}/fold-1280x720.png` }).catch(() => {});
  });

  test('a decision is a button row: its title on one line, its options as buttons', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'ATLAS');
    await openCompanion(page);
    const item = page.locator('.cp-item').filter({ hasText: 'Decide the ATLAS hosting' });
    await expect(item.locator('.cp-title')).toHaveText('Decide the ATLAS hosting');
    expect(await item.locator('.cp-title').evaluate((e) => e.scrollHeight <= e.clientHeight + 1), 'a decision is never clipped').toBe(true);
    await expect(item.locator('.cp-opt')).toHaveText(['Self-host', 'Managed']);
    for (const b of await item.locator('.cp-opt').all()) expect(await b.evaluate((e) => getComputedStyle(e).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
  });

  test('a decision without options has no Decide button; the row itself opens it. Running fits above the footer', async ({ page }) => {
    test.skip(!wide(page), 'side panel');
    await page.setViewportSize({ width: 1280, height: 720 });
    await boot(page);
    await scope(page).locator('.th-go[aria-label^="Uni,"]').click();
    await openCompanion(page);
    await expect(page.locator('.cp-body').getByRole('button', { name: 'Decide', exact: true })).toHaveCount(0);
    const dec = page.locator('.cp-item').filter({ hasText: 'Decide the COhere venue' }).locator('.cp-need.decision');
    if (await dec.count()) {
      await expect(dec.locator('.cp-go')).toBeVisible();
      expect(await dec.locator('.cp-title').evaluate((e) => e.scrollHeight <= e.clientHeight + 1)).toBe(true);
    }
    await openRoom(page, 'ATLAS');
    expect(await page.locator('.cp-run').count()).toBeLessThanOrEqual(2);
    const side = page.locator('.cp.side');
    await side.evaluate((e) => { e.scrollTop = e.scrollHeight; });
    const foot = (await page.locator('.cp-foot').boundingBox())!;
    for (const r of await page.locator('.cp-run, .cp-item').all()) { const b = (await r.boundingBox())!; expect(b.y + b.height).toBeLessThanOrEqual(foot.y + 20); }
  });

  test('the "All of X\'s work" link sticks to the panel bottom, wraps to at most two lines when the name is long', async ({ page }) => {
    test.skip(!wide(page), 'side panel');
    await page.setViewportSize({ width: 1280, height: 600 });
    await boot(page);
    await scope(page).locator('.th-go[aria-label^="Uni,"]').click();
    await openCompanion(page);
    const foot = page.locator('.cp-all');
    const side = (await page.locator('.cp.side').boundingBox())!;
    const box = (await foot.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(side.y + side.height + 1);
    expect(box.height).toBeLessThan(48);
    await page.locator('.cp-all-t').evaluate((e) => { e.textContent = "All of A very long project name that cannot possibly fit on a single line's work"; });
    const after = (await foot.boundingBox())!;
    expect(after.height).toBeLessThan(80);
    expect(after.y + after.height).toBeLessThanOrEqual(side.y + side.height + 1);
    expect(await page.locator('.cp-all-arrow').isVisible()).toBe(true);
    const arrow = (await page.locator('.cp-all-arrow').boundingBox())!;
    expect(arrow.x + arrow.width).toBeLessThanOrEqual(side.x + side.width);
  });

  test('the quiet marks say what they are', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'ATLAS');
    if (wide(page)) {
      await expect(page.getByRole('button', { name: 'Hide where this stands' })).toHaveAttribute('title', 'Hide where this stands');
      await page.getByRole('button', { name: 'Hide where this stands' }).click();
      await expect(page.getByRole('button', { name: 'Show where this stands' })).toHaveAttribute('title', 'Show where this stands');
      await expect(page.locator('.cp-unfold .cp-dot')).toHaveAttribute('title', 'Needs you');
    } else await expect(page.locator('.cp-line .cp-dot')).toHaveAttribute('title', 'Needs you');
    if (wide(page)) await expect(scope(page).locator('.th-dot').first()).toHaveAttribute('title', 'Needs you');
  });

  test('a decision titled "Decision (default yes): …" shows only the ask; the opened item keeps the full title', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'ATLAS');
    await openCompanion(page);
    await expect(page.locator('.cp-body')).not.toContainText(/Decision \(/);
    await page.locator('.cp-item').filter({ hasText: 'Decide the ATLAS hosting' }).locator('.cp-need').click();
    await expect(page.getByRole('dialog').or(page.locator('.sheet, .task-sheet')).first()).toContainText('Decision (default yes)');
  });

  test('teaching lists what waits on the user: a room task waiting on them, and their own; not what waits on someone else', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'Learn Vibe Build');
    await openCompanion(page);
    const needs = page.getByRole('region', { name: 'Needs you' });
    await expect(needs.locator('.cp-item')).toHaveCount(2);
    await expect(needs).toContainText('Canvas Week 7 brief draft');
    await expect(needs).toContainText('Grade the Week 6 reflections');
    await expect(needs).not.toContainText('Final brief');
  });

  test('the "where this stands" row folds and unfolds the panel', async ({ page }) => {
    test.skip(!wide(page), 'side panel');
    await boot(page);
    await openRoom(page, 'ATLAS');
    await expect(page.locator('.cp.side.open')).toBeVisible();
    const w = (await page.locator('.cp.side').boundingBox())!.width;
    await page.getByRole('button', { name: 'Hide where this stands' }).click();
    await expect(page.locator('.cp.side.folded')).toBeVisible();
    expect((await page.locator('.cp.side').boundingBox())!.width).toBeLessThan(w - 150);
    await page.getByRole('button', { name: 'Show where this stands' }).click();
    await expect(page.locator('.cp.side.open')).toBeVisible();
  });

  test('a worker status ping is one muted line; a marker-only line mid-message is a chip', async ({ page }) => {
    await boot(page, { longChat: true, tallLast: true });
    await openRoom(page, 'Learn Vibe Build');
    const status = page.locator('.sr-chat .message.status-line');
    await expect(status).toHaveCount(1);
    await expect(status).toHaveAttribute('title', '⏳ Working — 6 min — iteration 7');
    expect((await status.boundingBox())!.height).toBeLessThan(32);
    await expect(page.locator('.sr-chat .md-mark')).toHaveText('done · T-123');
    await expect(page.locator('.sr-chat').getByText('[done T-123]')).toHaveCount(0);
    await shot(page, 'midmessage');
  });

  test('the footer link keeps the long form at any width; detail lines wrap; the sentence clamps', async ({ page }) => {
    test.skip(!wide(page), 'side panel');
    await boot(page);
    await scope(page).locator('.th-go[aria-label^="Uni,"]').click();
    await openCompanion(page);
    await expect(page.locator('.cp-all-t')).toContainText('All of');
    await page.setViewportSize({ width: 900, height: 700 });
    await page.evaluate(() => { document.querySelector('.cp.side')!.setAttribute('style', 'width:130px'); });
    await expect(page.locator('.cp-all-t')).toHaveText(/^All of .+'s work$/);
    await page.evaluate(() => { document.querySelector('.cp.side')!.removeAttribute('style'); });
    const lede = page.locator('.cp-stands').first();
    if (await lede.count()) expect(await lede.evaluate((e) => getComputedStyle(e).webkitLineClamp)).toBe('3');
    if (await lede.count()) { await lede.click(); expect(await lede.evaluate((e) => getComputedStyle(e).webkitLineClamp)).not.toBe('3'); await lede.click(); expect(await lede.evaluate((e) => getComputedStyle(e).webkitLineClamp)).toBe('3'); }
    for (const d of await page.locator('.cp-detail').all()) expect(await d.evaluate((e) => getComputedStyle(e).whiteSpace)).not.toBe('nowrap');
  });

  test('a room never says "No messages" while its first fetch is pending; a confirmed empty room does', async ({ page }) => {
    await boot(page, { messagesDelay: 1200 });
    await openRoom(page, 'Learn Vibe Build');
    const none = page.locator('.sr-chat').getByText('No messages in this room yet.');
    await page.waitForTimeout(500);
    await expect(none).toHaveCount(0);
    await expect(none).toBeVisible({ timeout: 4000 });
    await openRoom(page, 'ATLAS');
    await page.waitForTimeout(500);
    await expect(none).toHaveCount(0);
    await expect(page.locator('.sr-chat .message')).toHaveCount(3, { timeout: 4000 });
    await expect(none).toHaveCount(0);
  });

  test('a room with nothing owed to the user says so, quietly', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'Atlas Institute');
    await openCompanion(page);
    await expect(page.locator('.cp-h', { hasText: 'Needs you' })).toHaveCount(1);
    await expect(page.locator('.cp-none')).toHaveText('Nothing needs you here.');
    await expect(page.locator('.cp-need')).toHaveCount(0);
  });

  test('the top of the conversation fades instead of cutting a line, and the panel scrolls on its own', async ({ page }) => {
    test.skip(!wide(page), 'side panel');
    await boot(page);
    await openRoom(page, 'ATLAS');
    expect(await page.locator('.sr-chat .message-list').evaluate((e) => { const c = getComputedStyle(e); return parseFloat(c.paddingTop) >= 20 && (c.maskImage || (c as any).webkitMaskImage || '').includes('gradient'); })).toBe(true);
    expect(await page.locator('.cp.side').evaluate((e) => getComputedStyle(e).overflowY)).toBe('auto');
  });

  test('the fold is remembered on this device', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'ATLAS');
    if (wide(page)) {
      await expect(page.locator('.cp.side')).toHaveClass(/open/);
      await page.getByRole('button', { name: 'Hide where this stands' }).click();
      await expect(page.locator('.cp.side')).toHaveClass(/folded/);
      const w = (await page.locator('.cp.side').boundingBox())!.width;
      expect(w).toBeLessThan(80);
      await page.reload();
      await openRoom(page, 'ATLAS');
      await expect(page.locator('.cp.side')).toHaveClass(/folded/);
      await page.getByRole('button', { name: 'Show where this stands' }).click();
      await expect(page.locator('.cp.side')).toHaveClass(/open/);
    } else {
      await expect(page.locator('.cp-line')).toHaveAttribute('aria-expanded', 'false');
      expect((await page.locator('.cp-line').boundingBox())!.height).toBeLessThan(60);
      await page.locator('.cp-line').click();
      await expect(page.locator('.cp-body')).toBeVisible();
      await shot(page, 'strip-open');
      await page.reload();
      await openRoom(page, 'ATLAS');
      await expect(page.locator('.cp-line')).toHaveAttribute('aria-expanded', 'true');
    }
  });

  test('nothing under a message; its actions are in a ⋯ menu', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'ATLAS');
    const first = page.locator('.sr-chat .message').first();
    await expect(page.locator('.sr-chat .message-actions')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^(⤓ )?Keep/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Ask Uni about|Copy .* message|Reply in thread/ })).toHaveCount(0);
    // the ⋯ is on the message's edge and quiet (hidden until hover with a mouse)
    const more = first.getByRole('button', { name: /^More actions for/ });
    if (wide(page)) await expect(more).toHaveCSS('opacity', '0'); else expect(Number(await more.evaluate((e) => getComputedStyle(e).opacity))).toBeLessThan(0.6);
    await first.hover();
    await more.click();
    const menu = page.getByRole('menu', { name: 'Message actions' });
    await expect(menu).toBeVisible();
    for (const n of [/React to/, /Keep .* as a note/, /Ask Uni about/, /Copy .* as markdown/, /Reply in thread to/]) await expect(menu.getByRole('menuitem', { name: n })).toBeVisible();
    await shot(page, 'menu');
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    expect(await fits(page)).toBe(true);
  });

  test('"Everything here" is the full node page; Open #room comes back to the conversation', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'ATLAS');
    await openCompanion(page);
    await page.getByRole('button', { name: /^All of .*'s work/ }).click();
    const panel = page.locator('.th-panel');
    await expect(panel).toBeVisible();
    await expect(page.locator('.th-head h1')).toHaveText('ATLAS');
    await expect(panel.getByRole('region', { name: 'Needs you' })).toContainText('T-07');
    await expect(panel.getByRole('region', { name: 'Running', exact: true })).toContainText('Draft the SOW');
    await expect(panel.getByRole('region', { name: 'Drafts' })).toContainText('SOW commons grant');
    await expect(page.locator('.steer, .logstrip, .steer-log')).toHaveCount(0);
    expect(await fits(page)).toBe(true);
    await shot(page, 'everything');
    await page.getByRole('button', { name: 'Open #atlas/build' }).click();
    await expect(page.locator('.sr-chat .message')).toHaveCount(3);
  });

  test('the task sheet\'s "Open in #room" returns to the conversation', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'ATLAS');
    await openCompanion(page);
    await page.getByRole('button', { name: /^All of .*'s work/ }).click();
    await page.locator('.wr-row[data-id="T-07"] .wr-main').click();
    await page.getByRole('button', { name: 'Open in #atlas/build' }).click();
    await expect(page.locator('.sr-chat .message')).toHaveCount(3);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('typing in the composer posts once to this room\'s channel', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'ATLAS');
    await page.getByRole('textbox', { name: /^Message / }).fill('push T-07 to Thursday');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect.poll(async () => (await calls(page, 'post_message')).filter((a: any) => a.body).length).toBe(1);
    const post = (await calls(page, 'post_message')).find((a: any) => a.body);
    expect(post.channel).toBe(BUILD);
    expect(post.body).toBe('push T-07 to Thursday');
  });

  test('nested rooms still nest, and jumping to a child and back works', async ({ page }) => {
    await boot(page);
    await unfoldAll(page);
    const rows = scope(page).locator('.th-row');
    expect(await rows.evaluateAll((els) => els.map((e) => [e.querySelector('b')?.textContent, [...e.classList].find((c) => /^d\d$/.test(c))]))).toEqual(expect.arrayContaining([['Atlas', 'd1'], ['ATLAS', 'd2'], ['Learn Vibe Build', 'd2'], ['Techne', 'd1'], ['COhere 2026', 'd2']]));
    await openRoom(page, 'ATLAS');
    await expect(page.locator('.sr-chat').getByRole('textbox', { name: /^Message / })).toHaveAttribute('placeholder', 'Message #atlas/build');
    await openRoom(page, 'Learn Vibe Build');
    await expect(page.locator('.sr-door')).toHaveText('#atlas/teach');
    await expect(page.locator('.sr-chat').getByRole('textbox', { name: /^Message / })).toHaveAttribute('placeholder', 'Message #atlas/teach');
    // back: wide, the parent in the crumbs or the list; phone, the ‹ and the list
    if (wide(page)) await page.locator('.sr .th-crumb', { hasText: 'Atlas' }).click(); else { await page.locator('.sr-back').click(); await scope(page).locator('.th-go[aria-label^="Atlas,"]').click(); }
    await expect(page.locator('.sr-title')).toHaveText('Atlas');
    await openRoom(page, 'ATLAS');
    await expect(page.locator('.sr-title')).toHaveText('ATLAS');
  });

  test('a node held by an ancestor\'s room says so and writes to that room', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'Atlas Institute');
    await expect(page.locator('.sr-door')).toHaveCount(0);
    await expect(page.locator('.sr-chat').getByRole('textbox', { name: /^Message / })).toHaveAttribute('placeholder', 'Message #atlas');
  });

  test('the rooms list is quiet: names, rooms in small type, one dot for "needs you", no counters', async ({ page }) => {
    await boot(page);
    await expect(scope(page).locator('.th-tag, .th-open, .th-stump, .th-door')).toHaveCount(0);
    await expect(scope(page).locator('.th-dot').first()).toBeVisible();
    // folded, an area still shows the dot for what is under it
    await expect(scope(page).locator('.th-go[aria-label^="Atlas,"] .th-dot')).toHaveCount(1);
    await unfoldAll(page);
    await expect(scope(page).locator('.th-go[aria-label^="ATLAS,"] .th-sub')).toHaveText('#atlas/build');
    await expect(scope(page).locator('.th-go[aria-label^="Atlas Institute,"] .th-sub')).toHaveCount(0);
    await expect(scope(page)).not.toContainText('held by');
    // a dot only where the room's OWN node has something that needs you: ATLAS holds T-07, its parent Atlas holds nothing itself
    await expect(scope(page).locator('.th-go[aria-label^="ATLAS,"] .th-dot')).toHaveCount(1);
    await expect(scope(page).locator('.th-go[aria-label^="Atlas,"] .th-dot')).toHaveCount(0);
    await expect(scope(page).locator('.th-go[aria-label^="Techne,"] .th-dot')).toHaveCount(1);
    await expect(scope(page).locator('.th-summary, .th-cap')).toHaveCount(0);
    await shot(page, 'rooms');
  });

  test('one look: the journal, settings and a room opened from the drawer read as the same app (shots, light and dark)', async ({ page }) => {
    await boot(page);
    const rail = page.getByRole('navigation', { name: 'Main navigation' });
    await rail.getByRole('button', { name: 'Journal' }).click();
    await expect(page.locator('.journal-tab-content')).toBeVisible();
    await shot(page, 'journal');
    await rail.getByRole('button', { name: 'Settings' }).click();
    await expect(page.locator('.settings')).toBeVisible();
    await shot(page, 'settings');
    if (await page.locator('.panel-close').count()) await page.locator('.panel-close').first().click();
    await rail.getByRole('button', { name: 'Rooms' }).click();
    await page.locator('.rooms nav .room', { has: page.locator('strong', { hasText: /^ATLAS$/ }) }).click();
    // from the drawer, a node's room opens as that node: the same view as from the tree
    await expect(page.locator('.sr-title')).toHaveText('ATLAS');
    await expect(page.locator('.sr-door')).toHaveText('#atlas/build');
    await expect(page.locator('.message').first()).toBeVisible();
    await shot(page, 'plain-room');
    expect(await fits(page)).toBe(true);
  });

  test('chat off (profile chat.provider null): the full node page, no composer, no room', async ({ page }) => {
    await boot(page, { profileNote: { chat: { provider: null } } });
    await unfoldAll(page);
    await scope(page).locator('.th-go[aria-label^="ATLAS"]').click();
    await expect(page.locator('.th-panel').getByRole('region', { name: 'Needs you' })).toContainText('T-07');
    await expect(page.locator('.sr, .cp, .composer, .th-door, .th-ctx, .talk, .sr-door')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Open #|Hold to talk/ })).toHaveCount(0);
    expect(await fits(page)).toBe(true);
    await shot(page, 'chat-off');
  });

  test('the side panel is narrow (about 270px) and the conversation gets the space', async ({ page }) => {
    test.skip(!wide(page), 'side panel is a desktop surface');
    await boot(page);
    await openRoom(page, 'ATLAS');
    const side = (await page.locator('.cp.side').boundingBox())!;
    expect(side.width).toBeGreaterThanOrEqual(250);
    expect(side.width).toBeLessThanOrEqual(290);
    const chat = (await page.locator('.sr').boundingBox())!;
    expect(chat.width).toBeGreaterThan(side.width * 2);
    expect(await fits(page)).toBe(true);
  });

  test('below 1100px wide the panel starts folded, and what the user chooses is remembered', async ({ page }) => {
    test.skip(!wide(page), 'side panel is a desktop surface');
    await page.setViewportSize({ width: 1000, height: 800 });
    await boot(page);
    await openRoom(page, 'ATLAS');
    await expect(page.locator('.cp.side')).toHaveClass(/folded/);
    await page.getByRole('button', { name: 'Show where this stands' }).click();
    await expect(page.locator('.cp.side')).toHaveClass(/open/);
    await page.reload();
    await openRoom(page, 'ATLAS');
    await expect(page.locator('.cp.side')).toHaveClass(/open/);
  });

  test('For you has no number, at most a quiet dot', async ({ page }) => {
    await boot(page);
    await expect(page.locator('.rail-count')).toHaveCount(0);
  });

  test('rooms open at the latest message, on open and on switching, and stay there while late layout lands', async ({ page }) => {
    await boot(page, { longChat: true });
    const atEnd = () => page.locator('.sr-chat .message-list').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
    await openRoom(page, 'ATLAS');
    await expect(page.locator('.sr-chat')).toContainText('The newest line of this room.');
    await expect.poll(atEnd).toBeLessThan(6);
    // late layout (an image, older rows) grows the list above the reader: still at the end
    await page.locator('.sr-chat .message-list').evaluate((el) => { const pad = document.createElement('div'); pad.style.height = '900px'; pad.dataset.late = '1'; el.firstElementChild?.prepend(pad); });
    await expect.poll(atEnd).toBeLessThan(6);
    await openRoom(page, 'Learn Vibe Build');
    await expect(page.locator('.sr-chat')).toContainText('The newest line of this room.');
    await expect.poll(atEnd).toBeLessThan(6);
    await page.waitForTimeout(1700);
    expect(await atEnd()).toBeLessThan(6);
    // and back to the first room: its newest message again, not where it was left
    await page.locator('.sr-chat .message-list').evaluate((el) => { el.scrollTop = 0; });
    await openRoom(page, 'ATLAS');
    await expect.poll(atEnd).toBeLessThan(6);
  });

  test('the rooms drawer uses the tree\'s names; sync and sign-in status live in Settings', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await boot(page);
    const rail = page.getByRole('navigation', { name: 'Main navigation' });
    await rail.getByRole('button', { name: 'Rooms' }).click();
    const drawer = page.locator('aside.rooms');
    await expect(drawer.locator('nav .room strong', { hasText: 'Learn Vibe Build' })).toBeVisible();
    await expect(drawer.locator('nav .room strong', { hasText: /^teach$/ })).toHaveCount(0);
    await expect(drawer.locator('nav .room strong', { hasText: /^ATLAS$/ })).toBeVisible();
    await expect(drawer.locator('.connection, .identity')).toHaveCount(0);
    // no slide: the drawer and the conversation do not animate
    await expect(drawer).toHaveCSS('animation-name', 'none');
    await expect(page.locator('section.conversation')).toHaveCSS('animation-name', 'none');
    if (!wide(page)) await page.locator('.panel-close').first().click();
    await rail.getByRole('button', { name: 'Settings' }).click();
    await expect(page.locator('.settings .connection')).toBeVisible();
    await expect(page.locator('.settings .identity')).toBeVisible();
  });

  test('back from a child goes to its parent with no sliding drawer over the conversation', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await boot(page);
    await openRoom(page, 'Learn Vibe Build');
    if (wide(page)) await page.locator('.sr .th-crumb', { hasText: 'Atlas' }).click(); else await page.locator('.sr-back').click();
    if (!wide(page)) await expect(scope(page)).toBeVisible();
    await expect(page.locator('aside.rooms')).toBeHidden();
    await expect(page.locator('.sr-head, .th-phone-tree').first()).toBeVisible();
    await expect(page.locator('.sr-head, .th-phone-tree').first()).toHaveCSS('animation-name', 'none');
  });

  // ---------------------------------------------------------------------------------------------- r7: one model, one navigation
  const roomsDrawer = (page: Page) => page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Rooms' });

  test('r7: no tab strip anywhere; the tree is the navigation', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'ATLAS');
    await expect(page.locator('.tab-strip, .tab-chip, [role="tablist"], .tab-add')).toHaveCount(0);
    await expect(page.getByRole('tab')).toHaveCount(0);
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Journal' }).click();
    await expect(page.locator('.tab-strip, .tab-chip, [role="tablist"]')).toHaveCount(0);
  });

  test('r7: a room reads the same from the tree and from the rooms list (one view per room)', async ({ page }) => {
    test.skip(!wide(page), 'rooms list drawer');
    await boot(page);
    const view = async () => ({ title: await page.locator('.sr-title').textContent(), door: await page.locator('.sr-door').textContent(), crumbs: await page.locator('.sr .th-crumbs').textContent(),
      placeholder: await page.locator('.sr-chat').getByRole('textbox', { name: /^Message / }).getAttribute('placeholder'), companion: await page.locator('.cp.side').count(), conversation: await page.locator('.conversation-header').count() });
    await openRoom(page, 'ATLAS');
    const fromTree = await view();
    await openRoom(page, 'Learn Vibe Build');
    await roomsDrawer(page).click();
    await page.locator('.rooms nav .room', { has: page.locator('strong', { hasText: /^ATLAS$/ }) }).click();
    await expect(page.locator('.sr-title')).toHaveText('ATLAS');
    expect(await view()).toEqual(fromTree);
    expect(fromTree.conversation).toBe(0);
    expect(fromTree.companion).toBe(1);
    // the sidebar followed: the open room is the selected row
    await expect(scope(page).locator('.th-row.sel .th-go')).toHaveAttribute('aria-label', /^ATLAS,/);
  });

  test('r7: a room line is the room\'s real name; no constructed slash path in the DOM', async ({ page }) => {
    await boot(page, { multiRoom: true });
    await unfoldAll(page);
    await expect(page.locator('body')).not.toContainText('boulder/cohere');
    await expect(scope(page).locator('.th-go[aria-label^="COhere"] .th-sub').first()).toHaveText('#cohere');
    await expect(scope(page).locator('.th-go[aria-label^="ATLAS,"] .th-sub')).toHaveText('#atlas/build');
    await scope(page).locator('.th-go[aria-label^="COhere"]').first().click();
    await expect(page.locator('.sr-door')).toHaveText('#cohere');
    await expect(page.locator('.sr-chat').getByRole('textbox', { name: /^Message / })).toHaveAttribute('placeholder', 'Message #cohere');
    await expect(page.locator('body')).not.toContainText('boulder/cohere');
    if (wide(page)) await expect(page.locator('.sr .th-crumbs')).toHaveText(/Uni\s*›\s*Techne\s*›\s*COhere/);
  });

  test('r7: areas fold with a chevron; the choice is remembered; the name opens the room, the chevron only folds; a folded area keeps its dot', async ({ page }) => {
    test.skip(!wide(page), 'sidebar column');
    await boot(page);
    const nav = scope(page);
    // default: folded, except the area holding the open room (Uni is open: no area holds it)
    await expect(nav.locator('.th-row.d2')).toHaveCount(0);
    await expect(nav.locator('.th-fold[aria-expanded="false"]').first()).toBeVisible();
    // a folded area shows the dot for what is under it
    await expect(nav.locator('.th-go[aria-label^="Atlas,"] .th-dot')).toHaveCount(1);
    await nav.locator('.th-fold[data-path="Areas/Atlas"]').click();
    await expect(nav.locator('.th-go[aria-label^="ATLAS,"]')).toBeVisible();
    await expect(page.locator('.sr-title')).toHaveText('Uni'); // the chevron did not open the room
    await expect(nav.locator('.th-go[aria-label^="Atlas,"] .th-dot')).toHaveCount(0);
    await nav.locator('.th-go[aria-label^="Atlas,"]').click(); // the name opens it
    await expect(page.locator('.sr-title')).toHaveText('Atlas');
    // remembered per device
    await page.reload();
    await expect(page.locator('.sr-title')).toHaveText('Atlas');
    await expect(nav.locator('.th-go[aria-label^="ATLAS,"]')).toBeVisible();
    await nav.locator('.th-fold[data-path="Areas/Atlas"]').click();
    await expect(nav.locator('.th-go[aria-label^="ATLAS,"]')).toHaveCount(0);
    await page.reload();
    await expect(page.locator('.th-row .th-go').first()).toBeVisible();
    await expect(nav.locator('.th-go[aria-label^="ATLAS,"]')).toHaveCount(0);
    // another area, opened from elsewhere, is revealed
    await nav.locator('.th-go[aria-label^="Techne,"]').click();
    await expect(page.locator('.sr-title')).toHaveText('Techne');
  });

  test('r7: the sidebar is narrow, resizes by dragging (180 to 360, remembered) and hides', async ({ page }) => {
    test.skip(!wide(page), 'sidebar column');
    await boot(page);
    const nav = page.locator('.th-roomnav');
    const width = async () => Math.round((await nav.boundingBox())!.width);
    expect(await width()).toBeLessThanOrEqual(222);
    expect(await width()).toBeGreaterThanOrEqual(218);
    await expect(nav.locator('.th-colname')).toHaveCount(0); // no big "Rooms" heading
    const handle = nav.getByRole('separator', { name: 'Resize the sidebar' });
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 200);
    await page.mouse.down(); await page.mouse.move(box.x + 500, box.y + 200, { steps: 4 }); await page.mouse.up();
    expect(await width()).toBe(360); // clamped at the max
    const b2 = (await handle.boundingBox())!;
    await page.mouse.move(b2.x + b2.width / 2, b2.y + 200);
    await page.mouse.down(); await page.mouse.move(b2.x - 500, b2.y + 200, { steps: 4 }); await page.mouse.up();
    expect(await width()).toBe(180); // and at the min
    await handle.focus(); await page.keyboard.press('ArrowRight');
    expect(await width()).toBe(196);
    await page.reload();
    await expect(page.locator('.th-roomnav')).toBeVisible();
    expect(await width()).toBe(196);
    // hide down to a strip, and bring it back
    await nav.getByRole('button', { name: 'Hide the sidebar' }).click();
    expect(await width()).toBeLessThanOrEqual(40);
    await expect(nav.locator('.th-go')).toHaveCount(0);
    await page.reload();
    expect(await width()).toBeLessThanOrEqual(40);
    await page.locator('.th-roomnav').getByRole('button', { name: 'Show the sidebar' }).click();
    expect(await width()).toBe(196);
    // about 20 rows fit at 720px once every area is open
    await page.setViewportSize({ width: 1280, height: 720 });
    await unfoldAll(page);
    const rows = await nav.locator('.th-row').count();
    const fit = await nav.locator('.th-rows-wrap').evaluate((e) => e.scrollHeight <= e.clientHeight + 1 ? e.querySelectorAll('.th-row').length : Math.floor(e.clientHeight / (e.scrollHeight / e.querySelectorAll('.th-row').length)));
    expect(Math.min(rows, fit)).toBeGreaterThanOrEqual(Math.min(rows, 18));
  });

  test('r7: Back and Forward over the places visited (Alt+←/→ and the two buttons), with a short Recent list', async ({ page }) => {
    test.skip(!wide(page), 'sidebar column');
    await boot(page);
    await openRoom(page, 'ATLAS');
    await openRoom(page, 'Learn Vibe Build');
    const nav = page.locator('.th-roomnav');
    await expect(nav.getByRole('button', { name: 'Forward' })).toBeDisabled();
    await nav.getByRole('button', { name: 'Back' }).click();
    await expect(page.locator('.sr-title')).toHaveText('ATLAS');
    await page.keyboard.press('Alt+ArrowRight');
    await expect(page.locator('.sr-title')).toHaveText('Learn Vibe Build');
    await page.keyboard.press('Alt+ArrowLeft');
    await page.keyboard.press('Alt+ArrowLeft');
    await expect(page.locator('.sr-title')).toHaveText('Uni');
    await expect(nav.getByRole('button', { name: 'Back' })).toBeDisabled();
    await expect(nav.getByRole('button', { name: 'Forward' })).toBeEnabled();
    const recent = nav.getByRole('region', { name: 'Recent' });
    await expect(recent.locator('button')).toHaveText(['Learn Vibe Build', 'ATLAS']);
    await recent.getByRole('button', { name: 'ATLAS' }).click();
    await expect(page.locator('.sr-title')).toHaveText('ATLAS');
  });

  test('r7: the app reopens to the room you were in; an old uni.tabs.v1 set is ignored beyond its active room', async ({ page }) => {
    test.skip(!wide(page), 'sidebar column');
    await boot(page);
    await openRoom(page, 'ATLAS');
    await page.reload();
    await expect(page.locator('.sr-title')).toHaveText('ATLAS');
    expect(await page.evaluate(() => localStorage.getItem('uni.tabs.v2'))).toContain('Projects/ATLAS');
    await page.evaluate(() => { localStorage.removeItem('uni.tabs.v2'); localStorage.setItem('uni.tabs.v1', JSON.stringify({ v: 1, tabs: [{ id: 'a', kind: 'area', path: 'Areas/Techne', title: 'Techne' }, { id: 'b', kind: 'areas', title: 'Uni' }, { id: 'c', kind: 'journal', title: 'Journal' }], active: 'a', recent: ['b', 'a'] })); });
    await page.reload();
    await expect(page.locator('.sr-title')).toHaveText('Techne');
    await expect(page.locator('.tab-strip')).toHaveCount(0);
  });

  test('r7: needs you is the feed: Aaron\'s own, Now and Soon, not snoozed, plus decisions; someday and done are not there; an empty room says so', async ({ page }) => {
    await boot(page);
    await scope(page).locator('.th-go[aria-label^="Uni,"]').click();
    await openCompanion(page);
    const needs = page.getByRole('region', { name: 'Needs you' });
    await expect(needs).toContainText('COhere festival readiness'); // waiting on aaron, now
    await expect(needs).toContainText('Casey call: book it'); // now
    await expect(needs).not.toContainText('Send the Q4 invoice'); // someday
    await expect(needs).not.toContainText('FableJi'); // someday
    await expect(needs).not.toContainText('Already finished'); // done
    await expect(needs).not.toContainText('Put away'); // archived
    await expect(needs).not.toContainText('A snoozed one'); // snoozed
    await expect(needs).not.toContainText('Wire the usage guard'); // Uni's, not Aaron's
    // Now before Soon
    const order = await needs.locator('.cp-need').evaluateAll((els) => els.map((e) => e.textContent ?? ''));
    expect(order.findIndex((t) => t.includes('COhere festival readiness'))).toBeLessThan(order.findIndex((t) => t.includes('Sponsorship invoice draft')));
    // the next step is shown in full, below the action
    await expect(needs.locator('.cp-item').filter({ hasText: 'Sponsorship invoice draft' }).locator('.cp-next')).toHaveText('Send to Casey for the numbers');
  });

  test('r7: a long next step wraps to four lines and "More" opens it in place', async ({ page }) => {
    test.skip(!wide(page), 'side panel');
    await boot(page, { longNext: true });
    await scope(page).locator('.th-go[aria-label^="Uni,"]').click();
    await openCompanion(page);
    const item = page.locator('.cp-item').filter({ hasText: 'COhere festival readiness' });
    const next = item.locator('.cp-next');
    const h = async () => (await next.boundingBox())!.height;
    const closed = await h();
    await item.getByRole('button', { name: 'More' }).click();
    expect(await h()).toBeGreaterThan(closed + 10);
    await expect(item.getByRole('button', { name: 'Less' })).toBeVisible();
    await expect(next).toContainText('third question');
    await item.getByRole('button', { name: 'Less' }).click();
    expect(await h()).toBe(closed);
  });

  test('r7: opening a task without a title worth reading or a next step says to open it', async ({ page }) => {
    test.skip(!wide(page), 'side panel');
    await boot(page, { bareTask: true });
    await scope(page).locator('.th-go[aria-label^="Uni,"]').click();
    await openCompanion(page);
    const item = page.locator('.cp-item').filter({ hasText: 'Taxes' });
    await expect(item.locator('.cp-open-to-see')).toHaveText("Open to see what's needed");
  });

  test('r8: a room opened by Back, Forward or Recent shows its messages, not a blank chat', async ({ page }) => {
    test.skip(!wide(page), 'sidebar column');
    await boot(page, { longChat: true });
    await openRoom(page, 'ATLAS');
    await expect(page.locator('.sr-chat .message').first()).toBeVisible();
    await openRoom(page, 'Learn Vibe Build');
    await expect(page.locator('.sr-chat .message').first()).toBeVisible();
    const nav = page.locator('.th-roomnav');
    await nav.getByRole('button', { name: 'Back' }).click();
    await expect(page.locator('.sr-title')).toHaveText('ATLAS');
    await expect(page.locator('.sr-chat .message').first()).toBeVisible();
    await nav.getByRole('button', { name: 'Forward' }).click();
    await expect(page.locator('.sr-title')).toHaveText('Learn Vibe Build');
    await expect(page.locator('.sr-chat .message').first()).toBeVisible();
    await nav.getByRole('region', { name: 'Recent' }).getByRole('button', { name: 'ATLAS' }).click();
    await expect(page.locator('.sr-title')).toHaveText('ATLAS');
    await expect(page.locator('.sr-chat .message').first()).toBeVisible();
    await expect(page.locator('.sr-chat [aria-label="Loading messages"]')).toHaveCount(0);
  });

  test('r8: Uni opens as its chat room even when the rooms list arrives late; Recent never lists the current place or one twice', async ({ page }) => {
    test.skip(!wide(page), 'sidebar column');
    await boot(page, { roomsDelay: 1500 });
    await scope(page).locator('.th-go[aria-label^="Uni"]').first().click();
    // no dashboard while the rooms load: the room, then its conversation and the companion
    await expect(page.locator('.sr-title')).toHaveText('Uni');
    await expect(page.locator('[data-view="room"]')).toBeVisible();
    await expect(page.getByText('no room', { exact: true })).toHaveCount(0);
    await expect(page.locator('.sr-door')).toHaveText('#uni', { timeout: 8000 });
    await expect(page.locator('.sr-chat textarea')).toBeVisible();
    await expect(page.getByText('Opening the room…')).toHaveCount(0);
    await expect(companion(page)).toBeVisible();
    const recent = page.locator('.th-roomnav').getByRole('region', { name: 'Recent' });
    const names = await recent.locator('button').allTextContents();
    expect(new Set(names).size).toBe(names.length);
    expect(names).not.toContain('Uni');
  });

  test('r8: a decision whose title was cut short shows the full question from its note', async ({ page }) => {
    test.skip(!wide(page), 'side panel');
    await boot(page, { cutDecision: true });
    await scope(page).locator('.th-go[aria-label^="Uni,"]').click();
    await openCompanion(page);
    const item = page.locator('.cp-item').filter({ hasText: 'after-event' });
    await expect(item.locator('.cp-title')).toContainText('Uni adds the after-event "were you there?" prompt to the companion on Wed. Say no to skip it.');
    await expect(item.locator('.cp-title')).not.toContainText('Decision (default yes)');
    await expect(item.locator('.cp-title')).not.toContainText('Converted from');
    await expect(item.locator('.cp-title')).not.toContainText('…');
  });

  test('r9: cached messages and rooms paint, with the composer, before the first fetch answers', async ({ page }) => {
    test.skip(!wide(page), 'sidebar column');
    const who = 'a'.repeat(64);
    await page.addInitScript(([who]) => {
      localStorage.setItem('uni.cache.who.v1', who);
      localStorage.setItem(`uni.cache.rooms.v1:${who}`, JSON.stringify([{ id: 'uni-room', name: 'Uni', last_message: 'hi', last_ts: 1, mentions: false, unread: 0 }]));
      localStorage.setItem(`uni.cache.msgs.v1:${who}:uni-room`, JSON.stringify([{ ref: 'c1', channel: 'uni-room', author: 'bbbb', author_name: 'Uni', ts: 1760000000, body: 'Cached hello from last time', mentions_me: false, root: null, parent: null, mentions: [], reply_count: 0, last_reply_ts: null, edited: false, reactions: [] }]));
    }, [who]);
    await boot(page, { roomsDelay: 8000, messagesDelay: 8000 });
    // nothing has answered yet (8 s): the conversation is already there, and the composer is live
    await expect(page.locator('.sr-chat')).toContainText('Cached hello from last time', { timeout: 3000 });
    await expect(page.locator('.sr-chat textarea')).toBeEnabled();
    expect(await page.evaluate(() => (window as any).__roomsResolved ?? false)).toBe(false);
    await expect(page.getByText('Opening the room…')).toHaveCount(0);
  });

  test('r9: a decision without options asks for a yes or no, and a tap decides through the CAS path', async ({ page }) => {
    test.skip(!wide(page), 'side panel');
    await boot(page, { cutDecision: true });
    await scope(page).locator('.th-go[aria-label^="Uni,"]').click();
    await openCompanion(page);
    const item = page.locator('.cp-item').filter({ hasText: 'after-event' });
    await expect(item.getByText('Your call: yes or no')).toBeVisible();
    await expect(item.getByRole('button', { name: 'Yes' })).toBeVisible();
    await expect(item.getByRole('button', { name: 'No', exact: true })).toBeVisible();
    await item.getByRole('button', { name: 'Yes' }).click();
    const [call] = await calls(page, 'vault_decide');
    expect(call.metadata.decided).toBe('yes');
    expect(call.from).toBe('open'); expect(call.to).toBe('decided');
    // a decision with real options keeps them, and no yes/no
    const opts = page.locator('.cp-item').filter({ hasText: 'hosting' });
    if (await opts.count()) await expect(opts.getByText('Your call: yes or no')).toHaveCount(0);
  });

  test('r9: a note id in a next step reads as the note\'s title, never the id', async ({ page }) => {
    test.skip(!wide(page), 'side panel');
    await boot(page, { ulidNext: true });
    await scope(page).locator('.th-go[aria-label^="Techne,"]').click();
    await openCompanion(page);
    const item = page.locator('.cp-item').filter({ hasText: 'ATLAS follow-up' });
    await expect(item.getByRole('button', { name: 'Follow-up notes' })).toBeVisible();
    await expect(item.locator('.cp-next')).toContainText('a note');
    await expect(item.locator('.cp-next')).not.toContainText('01M3ZK2R6A6C62M1ANJCSQNG3');
    await expect(item.locator('.cp-next')).not.toContainText('uni:');
  });

  test('r9: an overdue task stays listed, first, with a quiet "was due" line', async ({ page }) => {
    test.skip(!wide(page), 'side panel');
    await boot(page, { pastDue: true });
    await scope(page).locator('.th-go[aria-label^="Uni,"]').click();
    await openCompanion(page);
    const first = page.locator('.cp-item').first();
    await expect(first).toContainText('COhere festival readiness');
    await expect(first.locator('.cp-detail')).toContainText('was due Oct 7');
    await expect(first.locator('.cp-detail')).not.toContainText(/^due/);
  });

  test('r9: the footer always reads "All of <name>\'s work", wrapping rather than shortening', async ({ page }) => {
    test.skip(!wide(page), 'side panel');
    await boot(page);
    await scope(page).locator('.th-go[aria-label^="Unforced Dev"]').first().click().catch(() => {});
    await openCompanion(page);
    const label = page.locator('.cp-all-t');
    await expect(label).toHaveText(/^All of .+'s work$/);
    await expect(label).not.toHaveText('All work');
    expect(await label.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  });
});

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
  if (!wide(page) && await page.locator('.sr-back').count()) await page.locator('.sr-back').click();
  await scope(page).locator(`.th-go[aria-label^="${name},"]`).click();
  await expect(page.locator('.sr-title')).toHaveText(name);
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
    await expect(needs.locator('.cp-need').first()).toContainText('Decide the ATLAS hosting');
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

  test('at most three need you, no "+N more"; "Everything here" goes to the full page', async ({ page }) => {
    await boot(page);
    if (!wide(page)) await expect(page.locator('.th-phone-tree')).toBeVisible();
    await scope(page).locator('.th-go[aria-label^="Uni,"]').click();
    await expect(page.locator('.sr-title')).toHaveText('Uni');
    await openCompanion(page);
    const needs = page.locator('.cp-body').getByRole('region', { name: 'Needs you' });
    expect(await needs.locator('.cp-need').count()).toBeGreaterThanOrEqual(1); expect(await needs.locator('.cp-need').count()).toBeLessThanOrEqual(3);
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

  test('needs-you rows are one line each, raw links removed, and fit above the fold at 1280x720', async ({ page }) => {
    test.skip(!wide(page), 'side panel');
    await page.setViewportSize({ width: 1280, height: 720 });
    await boot(page);
    await scope(page).locator('.th-go[aria-label^="Uni,"]').click();
    await openCompanion(page);
    const items = page.locator('.cp-body .cp-item');
    await expect(items).toHaveCount(2);
    await expect(page.locator('.cp-body')).not.toContainText(/https?:\/\//);
    for (const el of await page.locator('.cp-body .cp-title').all()) expect(await el.evaluate((e) => e.getBoundingClientRect().height < 48)).toBeTruthy();
    for (const el of await page.locator('.cp-body .cp-detail').all()) {
      expect(await el.evaluate((e) => getComputedStyle(e).whiteSpace === 'nowrap' && e.getBoundingClientRect().height < 24)).toBeTruthy();
    }
    const link = page.getByRole('button', { name: /^All of .*'s work/ });
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
    const dec = page.locator('.cp-need.decision').first();
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

  test('the "All of X\'s work" link sticks to the panel bottom, on one line, even when the panel is long and the name is long', async ({ page }) => {
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
    expect(after.height).toBeLessThan(48);
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

  test('a room with nothing owed to the user shows no empty "Needs you" heading', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'Atlas Institute');
    await openCompanion(page);
    await expect(page.locator('.cp-h', { hasText: 'Needs you' })).toHaveCount(0);
    await expect(page.locator('.cp-sec')).not.toHaveCount(-1);
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

  test('one look: the journal, settings and the plain room tab read as the same app (shots, light and dark)', async ({ page }) => {
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
    await expect(page.locator('.conversation-header')).toContainText('atlas/build');
    await expect(page.locator('.message').first()).toBeVisible();
    await shot(page, 'plain-room');
    expect(await fits(page)).toBe(true);
  });

  test('chat off (profile chat.provider null): the full node page, no composer, no room', async ({ page }) => {
    await boot(page, { profileNote: { chat: { provider: null } } });
    if (!wide(page)) await scope(page).locator('.th-go[aria-label^="ATLAS"]').click(); else await scope(page).locator('.th-go[aria-label^="ATLAS"]').click();
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
});

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

  test('the companion: one sentence, at most three that need you, what is running; each item opens its task', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'ATLAS');
    await openCompanion(page);
    const cp = page.locator('.cp-body');
    const lede = await cp.locator('.cp-lede').innerText();
    expect(lede.trim().length).toBeGreaterThan(0);
    expect((lede.match(/[.!?](\s|$)/g) ?? []).length).toBeLessThanOrEqual(1);
    const needs = cp.getByRole('region', { name: 'Needs you' });
    await expect(needs.locator('.cp-need')).toHaveCount(2);
    await expect(needs).toContainText('SOW for the commons grant');
    await expect(needs).toContainText('Decide the ATLAS hosting');
    const running = cp.getByRole('region', { name: 'Running', exact: true });
    await expect(running).toContainText('Draft the SOW');
    await expect(running.locator('.cp-run')).toHaveCount(2); // running + queued; the finished one is not "running"
    await expect(running).not.toContainText('Summarise the grant call');
    // no count badges, counters row, moved list, drafts or tasks here
    await expect(cp.locator('.wr-counts, .th-h, .wr-h, em')).toHaveCount(0);
    await expect(cp.getByText(/Moved this week|Drafts/)).toHaveCount(0);
    await shot(page, 'companion');
    // an item opens its task sheet
    await needs.locator('.cp-need[data-id="T-07"]').click();
    await expect(page.getByRole('dialog').first()).toContainText('T-07');
    await page.keyboard.press('Escape');
  });

  test('more than three need you: three show, Now first, and "+N more" goes to the full page', async ({ page }) => {
    await boot(page);
    if (!wide(page)) await expect(page.locator('.th-phone-tree')).toBeVisible();
    await scope(page).locator('.th-go[aria-label^="Uni,"]').click();
    await expect(page.locator('.sr-title')).toHaveText('Uni');
    await openCompanion(page);
    const needs = page.locator('.cp-body').getByRole('region', { name: 'Needs you' });
    await expect(needs.locator('.cp-need')).toHaveCount(3);
    await expect(needs.locator('.cp-more')).toContainText(/^\+\d+ more$/);
    await needs.locator('.cp-more').click();
    await expect(page.locator('.th-panel')).toBeVisible();
    await expect(page.locator('.wr-needs')).toBeVisible();
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
    await page.getByRole('button', { name: /^Everything here/ }).click();
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
    await page.getByRole('button', { name: /^Everything here/ }).click();
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
    await expect(page.locator('.sr-door')).toHaveText('held by #atlas');
    await expect(page.locator('.sr-chat').getByRole('textbox', { name: /^Message / })).toHaveAttribute('placeholder', 'Message #atlas');
  });

  test('the rooms list is quiet: names, rooms in small type, one dot for "needs you", no counters', async ({ page }) => {
    await boot(page);
    await expect(scope(page).locator('.th-tag, .th-open, .th-stump, .th-door')).toHaveCount(0);
    await expect(scope(page).locator('.th-dot').first()).toBeVisible();
    await expect(scope(page).locator('.th-go[aria-label^="ATLAS,"] .th-sub')).toHaveText('#atlas/build');
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
    await page.locator('.rooms nav .room', { hasText: 'build' }).first().click();
    await expect(page.locator('.conversation-header')).toContainText('build');
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
});

// T-111: the tree home. Wide (Daylight, tablets): the map with a level panel; phone: a room tree, then a level. Rooms as slash names,
// held projects, an archived room's fallback, check-off with undo, the composer going to the steward room, calm motion, the layout switch.
import { mkdir } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import { areaCard, bootAreas } from './areasFixture';

const SHOTS = 'scripts/browser/__shots__/t111';
const BOULDER = '9f5dd143-96b1-440a-ab71-812219cdfaa1';
const wide = (page: Page) => (page.viewportSize()?.width ?? 0) >= 900;
const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const calls = (page: Page, cmd: string) => page.evaluate((c) => (window as any).__calls.filter((x: any) => x.cmd === c).map((x: any) => x.args), cmd);
const infinite = (page: Page) => page.evaluate(() => document.getAnimations().filter((a) => { const t = a.effect?.getComputedTiming(); return !t || t.iterations === Infinity || !Number.isFinite(t.endTime as number); }).length);
const panel = (page: Page) => page.locator('.th-panel');
const boot = (page: Page, o: Parameters<typeof bootAreas>[2] = {}) => bootAreas(page, 'seed', { briefs: true, tree: true, tasks: true, boulder: true, underBoulder: true, ricki: true, pinned: true, layout: 'tree', ...o });

/** Open a node by name from wherever we are: an arm of the map (wide), a row of the tree or a child in the panel (phone). */
/** r7: areas start folded; open every fold so any row can be clicked. */
async function unfoldTree(page: Page) {
  const tree = page.locator('.th-roomnav, .th-phone-tree').first();
  if (!await tree.count()) return;
  await tree.locator('.th-row.d1').first().waitFor().catch(() => {});
  for (let i = 0; i < 12; i++) { const f = tree.locator('.th-fold[aria-expanded="false"]'); if (!await f.count()) return; await f.first().click(); }
}
async function openNode(page: Page, name: string) {
  const arm = areaCard(page, name);
  if (wide(page) && await arm.count()) { await arm.click(); return; }
  const kid = page.locator(`.th-kid[data-name="${name}"]`);
  if (await kid.count()) { await kid.click(); return; }
  await unfoldTree(page);
  await page.getByRole('button', { name: new RegExp(`^${name},`) }).first().click();
}
const here = async (page: Page, name: string) => {
  if (wide(page)) await expect(page.locator('.node-core h1')).toHaveText(name); else await expect(page.locator('.th-head h1')).toHaveText(name);
};
const shot = async (page: Page, name: string) => {
  await mkdir(SHOTS, { recursive: true });
  const size = page.viewportSize()!;
  const file = `${SHOTS}/${name}-${size.width}x${size.height}`;
  await page.screenshot({ path: `${file}.png` });
  const tag = await page.addStyleTag({ content: 'html{filter:grayscale(1)}' });
  await page.screenshot({ path: `${file}-gray.png` });
  await tag.evaluate((n) => n.remove());
};
/** Phone only: back to the room tree. */
const toTree = async (page: Page) => { await page.getByRole('button', { name: 'Back to the room tree' }).click(); await expect(page.locator('.th-phone-tree')).toBeVisible(); };

test.describe('tree home', () => {
  test.beforeEach(async ({ page }) => { await boot(page); });

  test('renders: a room tree on the phone, the map with its level panel on wide screens; nothing overflows', async ({ page }) => {
    if (wide(page)) {
      await expect(page.locator('.th-level.wide .th-stage .node-stage:not(.node-stage-measure)')).toBeVisible();
      await expect(panel(page)).toBeVisible();
      await expect(page.locator('.node-core h1')).toHaveText('Uni');
      await expect(page.locator('.area-view h1')).toHaveCount(1);
      await expect(areaCard(page, 'Boulder')).toBeVisible();
      // the panel is the level's page: alive, needs you, rooms below, areas, tasks, room
      for (const name of ['What is alive here', 'Needs you', 'From the rooms below', 'Areas', 'What needs doing here', 'Room']) await expect(panel(page).getByRole('region', { name }).first()).toBeVisible();
      await expect(page.getByRole('button', { name: /Hold to talk to #Uni/ })).toBeVisible();
      // the composer is pinned: it stays on screen while the panel's page scrolls
      const before = (await page.locator('.th-foot').boundingBox())!;
      await page.locator('.th-scroll').evaluate((e) => { e.scrollTop = e.scrollHeight; });
      const after = (await page.locator('.th-foot').boundingBox())!;
      expect(after.y).toBe(before.y);
      expect(before.y + before.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
      await page.locator('.th-scroll').evaluate((e) => { e.scrollTop = 0; });
    } else {
      await expect(page.getByRole('heading', { name: 'Uni', level: 1 })).toBeVisible();
      await unfoldTree(page);
      const rows = page.locator('.th-row');
      await expect(rows.first()).toContainText('Uni');
      // indented by depth: Boulder (area) < COhere 2026 (project) < nothing deeper here
      const x = async (n: string) => (await page.locator(`.th-go[aria-label^="${n},"] .th-name`).boundingBox())!.x;
      expect(await x('COhere 2026')).toBeGreaterThan(await x('Boulder'));
      await expect(page.locator('.th-go[aria-label^="COhere 2026,"]')).toContainText('cohere');
      await expect(page.locator('.th-go[aria-label^="Boulder Civic Calendar,"]')).not.toContainText('held by');
      await expect(page.locator('.th-go[aria-label^="Techne,"]')).toHaveAttribute('aria-label', /2 need you|need/);
      await expect(page.locator('.th-go[aria-label^="Techne,"] .th-dot')).toBeVisible();
      for (const b of await page.locator('.th-go').all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    expect(await fits(page)).toBe(true);
    await shot(page, 'root');
  });

  test('zoom Uni → Boulder → COhere 2026 and back up', async ({ page }) => {
    if (!wide(page)) await page.locator('.th-go[data-path=""]').click();
    await here(page, 'Uni');
    await openNode(page, 'Boulder');
    await here(page, 'Boulder');
    await expect(panel(page).getByRole('region', { name: 'What is alive here' })).toContainText('council agenda is out');
    await expect(panel(page).locator('.th-door').first()).toHaveText('boulder');
    // rooms below: COhere's room posted within the day, shown as sap climbing the tree
    await expect(panel(page).getByRole('region', { name: 'From the rooms below' })).toContainText('cohere');
    await expect(panel(page).getByRole('region', { name: 'From the rooms below' })).toContainText('Festival crew list needs a second pass');
    await shot(page, 'boulder');
    await openNode(page, 'COhere 2026');
    await here(page, 'COhere 2026');
    await expect(panel(page).locator('.th-roomline .th-door')).toHaveText('cohere');
    await expect(panel(page).getByRole('region', { name: 'What is alive here' })).toContainText('Venue is held for Oct 15');
    await expect(panel(page).getByRole('region', { name: 'Needs you' })).toContainText('Confirm the venue deposit');
    await expect(panel(page).locator('.work-head .brief-count')).toHaveText('4');
    await expect(panel(page).locator('.th-slip').first()).toBeVisible();
    await shot(page, 'cohere');
    // up: the breadcrumb, then (wide) the parent chip
    await panel(page).getByRole('navigation', { name: 'Where you are' }).getByRole('button', { name: 'Boulder' }).click();
    await here(page, 'Boulder');
    if (wide(page)) { await page.getByRole('button', { name: 'Zoom out to Uni' }).click(); await here(page, 'Uni'); }
    else { await toTree(page); }
    expect(await fits(page)).toBe(true);
  });

  test('phone: Back returns to the room tree; Android back does too', async ({ page }) => {
    test.skip(wide(page), 'the room tree is the phone home');
    await page.getByRole('button', { name: /^Boulder,/ }).click();
    await here(page, 'Boulder');
    await page.evaluate(() => { const w = window as any; w.__cbs[w.__backHandler.id]({ message: {}, index: 0 }); });
    await expect(page.locator('.th-phone-tree')).toBeVisible();
    await shot(page, 'tree');
  });

  test('check off a task and take it back: a state_transition and its reverse', async ({ page }) => {
    if (!wide(page)) await page.locator('.th-go[data-path=""]').click();
    await openNode(page, 'Boulder');
    await here(page, 'Boulder');
    await openNode(page, 'COhere 2026');
    await here(page, 'COhere 2026');
    await page.getByRole('button', { name: 'Mark done: T-65 Sponsorship invoice draft' }).click();
    await expect(panel(page).locator('.task-title', { hasText: 'T-65' })).toHaveCount(0);
    expect(await calls(page, 'vault_transition')).toEqual([{ vault: 'uni', id: 'k3', from: 'open', to: 'done' }]);
    await expect(panel(page).locator('.work-head .brief-count')).toHaveText('3');
    const undo = page.getByRole('button', { name: 'Undo' });
    await expect(undo).toBeVisible();
    await shot(page, 'undo');
    await undo.click();
    await expect(panel(page).locator('.task-title', { hasText: 'T-65' })).toHaveCount(1);
    expect(await calls(page, 'vault_transition')).toEqual([{ vault: 'uni', id: 'k3', from: 'open', to: 'done' }, { vault: 'uni', id: 'k3', from: 'done', to: 'open' }]);
    // the five seconds run out
    await page.getByRole('button', { name: 'Mark done: T-65 Sponsorship invoice draft' }).click();
    await expect(page.getByRole('button', { name: 'Undo' })).toHaveCount(0, { timeout: 7000 });
  });

  test('the composer goes to the steward room: a project with its own room, a held project (its area room), Uni', async ({ page }) => {
    if (!wide(page)) await page.locator('.th-go[data-path=""]').click();
    await openNode(page, 'Boulder');
    await here(page, 'Boulder');
    await openNode(page, 'COhere 2026');
    await here(page, 'COhere 2026');
    await expect(page.getByRole('button', { name: /Hold to talk to #Cohere/ })).toBeVisible();
    // typing: tap the bar, write a line, send: it goes to #cohere
    await page.locator('.talk-hold').click();
    await page.getByRole('textbox', { name: 'Note to #Cohere' }).fill('Crew list: second pass done');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(async () => (await calls(page, 'post_message')).length).toBe(1);
    expect((await calls(page, 'post_message'))[0]).toMatchObject({ channel: 'ch-cohere', body: 'Crew list: second pass done' });
    // the room's ledger shows it, as the user's own slip
    await expect(panel(page).locator('.th-slip.me', { hasText: 'Crew list: second pass done' })).toBeVisible();
    // a held project talks to its area's room
    await panel(page).getByRole('navigation', { name: 'Where you are' }).getByRole('button', { name: 'Boulder' }).click();
    await here(page, 'Boulder');
    await openNode(page, 'Boulder Civic Calendar');
    await here(page, 'Boulder Civic Calendar');
    await expect(panel(page).locator('.th-roomline .th-door')).toHaveText('held by #boulder');
    await expect(page.getByRole('button', { name: /Hold to talk to #boulder/ })).toBeVisible();
    await page.locator('.talk-hold').click();
    await page.getByRole('textbox', { name: 'Note to #boulder' }).fill('Add the November dates');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(async () => (await calls(page, 'post_message')).length).toBe(2);
    expect((await calls(page, 'post_message'))[1]).toMatchObject({ channel: BOULDER, body: 'Add the November dates' });
    await shot(page, 'held');
  });

  test('an archived room is skipped: its fallback holds the project, and talk goes to the fallback room', async ({ page }) => {
    if (!wide(page)) await page.locator('.th-go[data-path=""]').click();
    await openNode(page, 'Unforced Development');
    await here(page, 'Unforced Development');
    await openNode(page, 'Ricki');
    await here(page, 'Ricki');
    await expect(panel(page).locator('.th-roomline .th-door')).toHaveText('held by #unforced-dev');
    await expect(page.getByRole('button', { name: /Hold to talk to #Unforced Dev/ })).toBeVisible();
    await page.locator('.talk-hold').click();
    await page.getByRole('textbox', { name: 'Note to #Unforced Dev' }).fill('Ricki: call Thursday');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(async () => (await calls(page, 'post_message')).length).toBe(1);
    expect((await calls(page, 'post_message'))[0]).toMatchObject({ channel: 'ch-unf' });
    await shot(page, 'archived');
  });

  test('private areas: the phone tree and the panel show counts, no task titles on rows; rooms below show the time only', async ({ page }) => {
    if (!wide(page)) {
      await expect(page.locator('.th-row', { hasText: 'Sadhana' })).not.toContainText(/T-\d/);
      await expect(page.locator('.th-phone-tree')).not.toContainText('T-03');
    } else {
      // from Uni the rooms below name no task titles; Sadhana's room posted within the day shows the time only
      const below = panel(page).getByRole('region', { name: 'From the rooms below' });
      await expect(below).not.toContainText('Sat twenty minutes');
    }
  });

  test('calm motion: reduced motion plays no transition; otherwise one zoom of at most 300 ms, and nothing loops', async ({ page }) => {
    test.skip(!wide(page), 'the zoom is the map');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await areaCard(page, 'Boulder').click();
    await here(page, 'Boulder');
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.getByRole('button', { name: 'Zoom out to Uni' }).click();
    // the home's own animations (the host's off-screen room pane has one of its own when the room changes)
    const anims = await page.evaluate(() => document.getAnimations().filter((a) => !!(a.effect as KeyframeEffect).target?.closest?.('.th-level')).map((a) => { const t = a.effect!.getComputedTiming(); return { d: Number(t.duration), i: t.iterations, delay: Number(t.delay), on: (a.effect as KeyframeEffect).target?.className + '' }; }));
    expect(anims.length).toBeGreaterThan(0);
    for (const a of anims) { expect(a.d + a.delay).toBeLessThanOrEqual(300); expect(a.i).toBe(1); }
    await here(page, 'Uni');
    await page.waitForTimeout(400);
    expect(await infinite(page)).toBe(0);
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
  });

  test('the layout switch: Settings → Home layout, Map selectable; Octopus and Classic stay a tap away', async ({ page }) => {
    expect(await page.evaluate(() => localStorage.getItem('uni.home.layout.v1'))).toBe('tree');
    const setting = async (label: string) => {
      await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('radio', { name: new RegExp(label) }).check();
      // wide: the rail's Uni is still there; phone: the settings panel covers the bar, so the home is read again at the next open
      if (wide(page)) await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Uni', exact: true }).click(); else await page.reload();
      await expect(page.locator('.area-view h1, .th-phone-tree h1').first()).toBeVisible();
    };
    await setting('Octopus');
    expect(await page.evaluate(() => localStorage.getItem('uni.home.layout.v1'))).toBe('octopus');
    await expect(page.locator('.tree-home')).toHaveCount(0);
    await expect(page.locator('.node-arm').first()).toBeVisible();
    await expect(page.locator('.work-head')).toBeVisible();
    await setting('Classic');
    await expect(page.locator('.node-stage')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Uni', level: 1 })).toBeVisible();
    await expect(page.locator('.th-kid[data-name="Boulder"]')).toBeVisible();
    await page.locator('.th-kid[data-name="Boulder"]').click();
    await expect(page.getByRole('heading', { name: 'Boulder', level: 1 })).toBeVisible();
    await expect(page.locator('.work-head')).toBeVisible();
    await setting('Map');
    expect(await page.evaluate(() => localStorage.getItem('uni.home.layout.v1'))).toBe('tree');
    await expect(page.locator('.tree-home').first()).toBeVisible();
    // stored on the device: the next open reads it
    await setting('Octopus');
    await page.reload();
    await expect(page.locator('.node-arm').first()).toBeVisible();
  });
});

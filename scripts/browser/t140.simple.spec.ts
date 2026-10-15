// T-140: the area tree from node links, and the Rooms / Projects / Areas views.
// Run: SIMPLE_TEST_PORT=5711 npx playwright test --config playwright.simple.config.ts t140
import { test, expect, type Page } from '@playwright/test';
import { bootAreas } from './areasFixture';

const wide = (page: Page) => (page.viewportSize()?.width ?? 0) >= 900;
const treeBeside = (page: Page) => wide(page) && (page.viewportSize()?.height ?? 0) >= 400;
const boot = (page: Page) => bootAreas(page, 'seed', { briefs: true, tree: true, tasks: true, atlas: true, boulder: true, links: true, pinned: true });
const scope = (page: Page) => (treeBeside(page) ? page.locator('.th-roomnav') : page.locator('.th-phone-tree'));
async function showTree(page: Page) {
  if (!treeBeside(page)) {
    await page.locator('.sr-drawer, .th-phone-tree').first().waitFor();
    if (await page.locator('.sr-drawer').count() && !await page.locator('.th-drawer').count()) await page.locator('.sr-drawer').click();
  }
  await scope(page).locator('.th-views').waitFor();
}
async function view(page: Page, v: 'rooms' | 'projects' | 'areas') {
  await showTree(page);
  await scope(page).locator(`.th-view[data-view="${v}"]`).click();
  await expect(scope(page).locator(`.th-view[data-view="${v}"]`)).toHaveAttribute('aria-pressed', 'true');
}
async function unfoldAll(page: Page) {
  await scope(page).locator('.th-row.d1').first().waitFor();
  for (let i = 0; i < 12; i++) { const f = scope(page).locator('.th-fold[aria-expanded="false"]'); if (!await f.count()) return; await f.first().click(); }
}
const nodeOf = (page: Page) => page.locator('.sr');

test.describe('T-140 links', () => {
  test('1: a project linked to two areas is under both, as one node: either row opens the same room and both highlight', async ({ page }) => {
    await boot(page);
    await showTree(page);
    await unfoldAll(page);
    const app = scope(page).locator('.th-go[data-path="Projects/uni-app"]');
    await expect(app).toHaveCount(2);
    await expect(app.nth(0)).toHaveAttribute('data-via', 'Areas/Parachute');
    await expect(app.nth(1)).toHaveAttribute('data-via', 'Areas/Sadhana');
    // RegenHub is listed by Boulder's project only and by Techne's note only: the link reads from either end
    const regen = scope(page).locator('.th-go[data-path="Projects/RegenHub"]');
    await expect(regen).toHaveCount(2);
    await expect(regen.nth(0)).toHaveAttribute('data-via', 'Areas/Boulder');
    await expect(regen.nth(1)).toHaveAttribute('data-via', 'Areas/Techne');
    // Mail names only a legacy `parent`, no room: it is under Parachute and talks in its room
    await expect(scope(page).locator('.th-go[data-path="Projects/Mail"]')).toHaveCount(1);
    await app.nth(1).click();                               // reached through Sadhana
    await expect(nodeOf(page)).toHaveAttribute('data-node', 'uni-app');
    await expect(page.locator('.sr-door')).toContainText('uni-os');
    if (!treeBeside(page)) await showTree(page);
    await unfoldAll(page);
    await expect(scope(page).locator('.th-row.sel .th-go[data-path="Projects/uni-app"]')).toHaveCount(2);
    await expect(page.locator('.th-crumbs')).toContainText(/Sadhana/);
    await app.nth(0).click();                               // the same node through Parachute
    await expect(nodeOf(page)).toHaveAttribute('data-node', 'uni-app');
    await expect(page.locator('.sr-door')).toContainText('uni-os');
    await expect(page.locator('.th-crumbs')).toContainText(/Parachute/);
  });

  test('2: Rooms view: newest message first, archived rooms behind one line, remembered after a reload', async ({ page }) => {
    await boot(page);
    await view(page, 'rooms');
    const names = () => scope(page).locator('.th-roomlist .th-room-go').evaluateAll((els) => els.map((e) => (e.getAttribute('aria-label') ?? '').replace(/^#/, '')));
    await expect(scope(page).locator('.th-room-go[aria-label="#uni-os"]')).toBeVisible();
    const live = await names();
    const at = (n: string) => live.indexOf(n);
    expect(at('uni-os')).toBeGreaterThanOrEqual(0);
    expect(at('uni-os')).toBeLessThan(at('regenhub'));
    expect(at('regenhub')).toBeLessThan(at('parachute'));
    expect(at('parachute')).toBeLessThan(at('boulder'));
    expect(at('boulder')).toBeLessThan(at('Sadhana'));
    expect(live).not.toContain('old-client');
    await expect(scope(page).locator('.th-showarch')).toHaveText(/Show archived \(1\)/);
    await scope(page).locator('.th-showarch').click();
    await expect(scope(page).locator('.th-room-go[aria-label="#old-client"]')).toBeVisible();
    await scope(page).locator('.th-room-go[aria-label="#regenhub"]').click();
    await expect(nodeOf(page)).toHaveAttribute('data-node', 'RegenHub');
    if (!treeBeside(page)) return;                          // the choice is per device: it survives a reload
    await page.reload();
    await expect(scope(page).locator('.th-view[data-view="rooms"]')).toHaveAttribute('aria-pressed', 'true');
  });

  test('3: Projects view: cards by room activity, "talks in" for a roomless project, and every chip opens the right room', async ({ page }) => {
    await boot(page);
    await view(page, 'projects');
    const cards = scope(page).locator('.th-card');
    await expect(cards.first()).toBeVisible();
    const order = await cards.evaluateAll((els) => els.map((e) => e.getAttribute('data-card')));
    const at = (p: string) => order.indexOf(`Projects/${p}`);
    expect(at('uni-app')).toBeLessThan(at('RegenHub'));
    expect(at('RegenHub')).toBeLessThan(at('Mail'));
    expect(order).not.toContain('Projects/Old Client');
    await expect(scope(page).locator('[data-card="Projects/Mail"] .th-cardroom')).toHaveText('talks in #parachute');
    await expect(scope(page).locator('[data-card="Projects/uni-app"] .th-cardroom')).toHaveText('#uni-os');
    const regenChips = scope(page).locator('[data-card="Projects/RegenHub"] .th-chip');
    await expect(regenChips).toHaveText([/Boulder/, /Techne/]);
    await expect(scope(page).locator('[data-card="Projects/uni-app"] .th-chip')).toHaveText([/Parachute/, /Sadhana/, /Mail/]);
    // each chip opens its own room (Mail has none: its chip opens #parachute, where it talks)
    for (const [card, chip, node] of [['RegenHub', 'Areas/Boulder', 'Boulder'], ['RegenHub', 'Areas/Techne', 'Techne'], ['uni-app', 'Areas/Sadhana', 'Sadhana'], ['uni-app', 'Projects/Mail', 'Parachute'], ['uni-app', 'Areas/Parachute', 'Parachute']] as const) {
      await view(page, 'projects');
      await scope(page).locator(`[data-card="Projects/${card}"] .th-chip[data-chip="${chip}"]`).click();
      await expect(nodeOf(page)).toHaveAttribute('data-node', node);
    }
    await view(page, 'projects');
    await scope(page).locator('[data-card="Projects/RegenHub"] .th-cardroom').click();
    await expect(nodeOf(page)).toHaveAttribute('data-node', 'RegenHub');
  });

  test('4: Areas view: RegenHub under Boulder and Techne, uni-app under Parachute and Sadhana', async ({ page }) => {
    await boot(page);
    await view(page, 'areas');
    await unfoldAll(page);
    for (const [a, p] of [['Boulder', 'RegenHub'], ['Techne', 'RegenHub'], ['Parachute', 'uni-app'], ['Sadhana', 'uni-app'], ['Parachute', 'Mail']] as const)
      await expect(scope(page).locator(`.th-go[data-path="Projects/${p}"][data-via="Areas/${a}"]`)).toBeVisible();
  });
});

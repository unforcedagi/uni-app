// T-140: the area tree from node links. (T-302: the Rooms / Projects / Areas views are gone: projects live in their area's room.)
// Run: SIMPLE_TEST_PORT=5711 npx playwright test --config playwright.simple.config.ts t140
import { test, expect, type Page } from '@playwright/test';
import { bootAreas, leaveFrontDoor, toOldHome } from './areasFixture';

const wide = (page: Page) => (page.viewportSize()?.width ?? 0) >= 900;
const treeBeside = (page: Page) => wide(page) && (page.viewportSize()?.height ?? 0) >= 400;
/** T-302: the app opens on the front door; a test starts where the old home put it (toOldHome) */
const boot = async (page: Page) => { await bootAreas(page, 'seed', { briefs: true, tree: true, tasks: true, atlas: true, boulder: true, links: true, pinned: true }); await toOldHome(page); };
const scope = (page: Page) => (treeBeside(page) ? page.locator('.th-roomnav') : page.locator('.th-phone-tree'));
async function showTree(page: Page) {
  if (!treeBeside(page)) {
    await leaveFrontDoor(page); // T-302: the tree is in a room
    await page.locator('.sr-drawer, .th-phone-tree').first().waitFor();
    if (await page.locator('.sr-drawer').count() && !await page.locator('.th-drawer').count()) await page.locator('.sr-drawer').click();
  }
  await scope(page).locator('.th-row.d1').first().waitFor();
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
    await expect(app.nth(1)).toHaveAttribute('data-via', 'Areas/Sanctum');
    // RegenHub is listed by Boulder's project only and by Techne's note only: the link reads from either end
    const regen = scope(page).locator('.th-go[data-path="Projects/RegenHub"]');
    await expect(regen).toHaveCount(2);
    await expect(regen.nth(0)).toHaveAttribute('data-via', 'Areas/Boulder');
    await expect(regen.nth(1)).toHaveAttribute('data-via', 'Areas/Techne');
    // Mail names only a legacy `parent`, no room: it is under Parachute and talks in its room
    await expect(scope(page).locator('.th-go[data-path="Projects/Mail"]')).toHaveCount(1);
    await app.nth(1).click();                               // reached through Sanctum
    await expect(nodeOf(page)).toHaveAttribute('data-node', 'uni-app');
    await expect(page.locator('.sr-door')).toContainText('uni-os');
    if (!treeBeside(page)) await showTree(page);
    await unfoldAll(page);
    await expect(scope(page).locator('.th-row.sel .th-go[data-path="Projects/uni-app"]')).toHaveCount(2);
    await expect(page.locator('.th-crumbs')).toContainText(/Sanctum/);
    await app.nth(0).click();                               // the same node through Parachute
    await expect(nodeOf(page)).toHaveAttribute('data-node', 'uni-app');
    await expect(page.locator('.sr-door')).toContainText('uni-os');
    await expect(page.locator('.th-crumbs')).toContainText(/Parachute/);
  });

  test('4: the tree: RegenHub under Boulder and Techne, uni-app under Parachute and Sanctum', async ({ page }) => {
    await boot(page);
    await showTree(page);
    await unfoldAll(page);
    for (const [a, p] of [['Boulder', 'RegenHub'], ['Techne', 'RegenHub'], ['Parachute', 'uni-app'], ['Sanctum', 'uni-app'], ['Parachute', 'Mail']] as const)
      await expect(scope(page).locator(`.th-go[data-path="Projects/${p}"][data-via="Areas/${a}"]`)).toBeVisible();
  });
});

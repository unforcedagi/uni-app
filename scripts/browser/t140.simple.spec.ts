// T-140: the area tree from node links. (T-302: the Rooms / Projects / Areas views are gone: projects live in their area's room.)
// T-335 one surface: the places inside an area are in its room's details ("Inside <Name>"); a project linked to two areas is inside both.
// Run: SIMPLE_TEST_PORT=5711 npx playwright test --config playwright.simple.config.ts t140
import { test, expect, type Page } from '@playwright/test';
import { bootAreas, focusSheet, openAreasHome, openDetails } from './areasFixture';

const boot = async (page: Page) => { await bootAreas(page, 'seed', { briefs: true, tree: true, tasks: true, atlas: true, boulder: true, links: true, pinned: true }); };
const home = (page: Page) => page.locator('[data-place="front-door"][data-view="places"]');
/** An area's details, from its door on Uni's home; the places inside it are its "Inside <Name>" list. */
async function inside(page: Page, area: string) {
  if (!(await home(page).isVisible())) await openAreasHome(page);
  await home(page).locator(`.fd-door[data-path="Areas/${area}"]`).click();
  await expect(focusSheet(page).locator('.all-focus-title')).toHaveText(area);
  await openDetails(page);
  return focusSheet(page).getByRole('region', { name: `Inside ${area}` });
}
const place = (list: ReturnType<Page['locator']>, name: string) => list.locator('.fx-place').filter({ has: list.page().getByText(name, { exact: true }) });

test.describe('T-140 links', () => {
  test('1: a project linked to two areas is inside both, as one node: either way in opens the same room', async ({ page }) => {
    await boot(page);
    // reached through Sanctum
    await place(await inside(page, 'Sanctum'), 'uni-app').click();
    await expect(focusSheet(page).locator('.all-focus-title')).toHaveText('uni-app');
    await expect(focusSheet(page).getByRole('textbox', { name: /^Message uni-os/ })).toBeVisible();
    // the same node through Parachute
    await place(await inside(page, 'Parachute'), 'uni-app').click();
    await expect(focusSheet(page).locator('.all-focus-title')).toHaveText('uni-app');
    await expect(focusSheet(page).getByRole('textbox', { name: /^Message uni-os/ })).toBeVisible();
    // Mail names only a legacy `parent`, no room: it is inside Parachute, once, and talks in its room
    const parachute = await inside(page, 'Parachute');
    await expect(place(parachute, 'Mail')).toHaveCount(1);
    await expect(place(parachute, 'Mail')).toContainText('talks in #parachute');
    await expect(place(parachute, 'uni-app')).toHaveCount(1);
  });

  test('4: the places: RegenHub inside Boulder and Techne, uni-app inside Parachute and Sanctum, Mail inside Parachute', async ({ page }) => {
    await boot(page);
    // RegenHub is listed by Boulder's project only and by Techne's note only: the link reads from either end
    for (const [a, p] of [['Boulder', 'RegenHub'], ['Techne', 'RegenHub'], ['Parachute', 'uni-app'], ['Sanctum', 'uni-app'], ['Parachute', 'Mail']] as const)
      await expect(place(await inside(page, a), p), `${p} inside ${a}`).toBeVisible();
  });
});

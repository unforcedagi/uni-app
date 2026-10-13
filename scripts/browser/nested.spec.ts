// T-111 nested rooms: ATLAS → ATLAS (atlas/build), Learn Vibe Build (atlas/teach), Atlas Institute (held by #atlas); the Open #room action; the nested conversation list.
// Run: NESTED_TEST_PORT=5681 npx playwright test --config playwright.nested.config.ts
import { mkdir } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import { bootAreas } from './areasFixture';

const SHOTS = 'scripts/browser/__shots__/nested';
const BUILD = '7dcea809-25cd-4160-ba99-f0a56386adcb';
const wide = (page: Page) => (page.viewportSize()?.width ?? 0) >= 900;
const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const shot = async (page: Page, name: string) => {
  await mkdir(SHOTS, { recursive: true });
  const s = page.viewportSize()!;
  await page.screenshot({ path: `${SHOTS}/${name}-${s.width}x${s.height}.png` });
};
const boot = (page: Page) => bootAreas(page, 'seed', { briefs: true, tree: true, tasks: true, atlas: true, pinned: true, layout: 'rooms' });

test.describe('nested rooms', () => {
  test('the tree names the project rooms under atlas without doubling, and the Open action opens that room', async ({ page }) => {
    await boot(page);
    const scope = wide(page) ? page.locator('.th-roomnav') : page.locator('.th-phone-tree');
    await expect(scope.locator('.th-go[aria-label^="Atlas,"]')).toContainText('atlas');
    await expect(scope.locator('.th-go[aria-label^="ATLAS,"]')).toContainText('atlas/build');
    await expect(scope.locator('.th-go[aria-label^="ATLAS,"]')).not.toContainText('atlas/atlas');
    await expect(scope.locator('.th-go[aria-label^="Learn Vibe Build,"]')).toContainText('atlas/teach');
    await expect(scope.locator('.th-go[aria-label^="Atlas Institute,"]')).toContainText('held by Atlas');
    expect(await fits(page)).toBe(true);
    await shot(page, 'tree');
    // T-124: a node held by an ancestor's room opens that room's conversation, and says whose it is
    await scope.locator('.th-go[aria-label^="Atlas Institute,"]').click();
    await expect(page.locator('.sr-door')).toHaveText('held by Atlas');
    await expect(page.locator('.sr-chat').getByRole('textbox', { name: /^Message / })).toHaveAttribute('placeholder', 'Message #atlas');
    if (!wide(page)) await page.locator('.sr-back').click();
    await scope.locator('.th-go[aria-label^="ATLAS,"]').click();
    await expect(page.locator('.sr-door')).toHaveText('#atlas/build');
    await shot(page, 'project');
    // the conversation is in place (no new tab); "Everything here" is the node page, whose Open #room returns to it
    const tabs = await page.locator('.tab-title').count();
    if (!wide(page)) await page.locator('.cp-line').click();
    await page.getByRole('button', { name: /^Everything here/ }).click();
    const open = page.getByRole('button', { name: 'Open #atlas/build' });
    await expect(open).toBeVisible();
    expect((await open.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await open.click();
    await expect(page.locator('.sr-chat')).toBeVisible();
    await expect(page.locator('.tab-title')).toHaveCount(tabs);
    await shot(page, 'opened');
  });

  test('the conversation list nests build and teach under atlas', async ({ page }) => {
    await boot(page);
    await page.getByRole('button', { name: 'Rooms', exact: true }).click();
    const list = page.locator('.rooms nav');
    await expect(list).toBeVisible();
    await expect(list.locator('.room.child').first()).toBeVisible();
    const names = await list.locator('.room strong').allTextContents();
    const i = names.indexOf('Atlas');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(names.slice(i + 1, i + 3).sort()).toEqual(['ATLAS', 'Learn Vibe Build']);
    const build = list.locator('.room.child', { has: page.locator('strong', { hasText: /^ATLAS$/ }) });
    await expect(build).toHaveAttribute('title', 'atlas/build');
    await expect(build).toHaveAttribute('aria-label', '#atlas/build');
    await expect(list.locator('.room', { hasText: 'Techne' }).first()).not.toHaveClass(/child/);
    await shot(page, 'list');
  });
});

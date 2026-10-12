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
    await expect(scope.locator('.th-go[aria-label^="Atlas Institute,"]')).toContainText('held by #atlas');
    expect(await fits(page)).toBe(true);
    await shot(page, 'tree');
    // a node held by an ancestor's room opens the holding room
    await scope.locator('.th-go[aria-label^="Atlas Institute,"]').click();
    await expect(page.getByRole('button', { name: 'Open #atlas', exact: true })).toBeVisible();
    if (!wide(page)) await page.locator('.th-back').click();
    await scope.locator('.th-go[aria-label^="ATLAS,"]').click();
    const open = page.getByRole('button', { name: 'Open #atlas/build' });
    await expect(open).toBeVisible();
    expect((await open.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await shot(page, 'project');
    // T-122: Open #room opens the Log over the node page, not a new tab; the room tab is "Open as tab" in the Log header
    const tabs = await page.locator('.tab-title').count();
    await open.click();
    const log = page.getByRole('dialog', { name: 'Log #atlas/build' });
    await expect(log).toBeVisible();
    await expect(page.locator('.tab-title')).toHaveCount(tabs);
    await shot(page, 'opened');
    await log.getByRole('button', { name: 'Open as tab' }).click();
    await expect.poll(() => page.evaluate((id) => (window as any).__calls.some((c: any) => c.args?.channel === id), BUILD)).toBe(true);
    await expect(page.locator('.tab-title', { hasText: 'atlas/build' }).or(page.locator('.tab-title', { hasText: 'build' })).first()).toBeVisible();
  });

  test('the conversation list nests build and teach under atlas', async ({ page }) => {
    await boot(page);
    await page.getByRole('button', { name: 'Rooms', exact: true }).click();
    const list = page.locator('.rooms nav');
    await expect(list).toBeVisible();
    await expect(list.locator('.room.child').first()).toBeVisible();
    const names = await list.locator('.room strong').allTextContents();
    const i = names.indexOf('atlas');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(names.slice(i + 1, i + 3).sort()).toEqual(['build', 'teach']);
    const build = list.locator('.room.child', { hasText: 'build' });
    await expect(build).toHaveAttribute('title', 'atlas/build');
    await expect(build).toHaveAttribute('aria-label', '#atlas/build');
    await expect(list.locator('.room', { hasText: 'Techne' }).first()).not.toHaveClass(/child/);
    await shot(page, 'list');
  });
});

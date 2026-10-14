// T-111 nested rooms: ATLAS → ATLAS (atlas/build), Learn Vibe Build (atlas/teach), Atlas Institute (held by #atlas); the Open #room action; no second room list (r12).
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
const boot = (page: Page) => bootAreas(page, 'seed', { briefs: true, tree: true, tasks: true, atlas: true, pinned: true });

test.describe('nested rooms', () => {
  test('the tree names the project rooms under atlas without doubling, and the Open action opens that room', async ({ page }) => {
    await boot(page);
    const scope = wide(page) ? page.locator('.th-roomnav') : page.locator('.th-phone-tree');
    for (let i = 0; i < 12; i++) { await scope.locator('.th-row.d1').first().waitFor(); const f = scope.locator('.th-fold[aria-expanded="false"]'); if (!await f.count()) break; await f.first().click(); }
    await expect(scope.locator('.th-go[aria-label^="Atlas,"]')).toContainText('atlas');
    await expect(scope.locator('.th-go[aria-label^="ATLAS,"]')).toContainText('atlas/build');
    await expect(scope.locator('.th-go[aria-label^="ATLAS,"]')).not.toContainText('atlas/atlas');
    await expect(scope.locator('.th-go[aria-label^="Learn Vibe Build,"]')).toContainText('atlas/teach');
    await expect(scope.locator('.th-go[aria-label^="Atlas Institute,"]')).not.toContainText('held by');
    expect(await fits(page)).toBe(true);
    await shot(page, 'tree');
    // T-124: a node held by an ancestor's room opens that room's conversation, and says whose it is
    await scope.locator('.th-go[aria-label^="Atlas Institute,"]').click();
    await expect(page.locator('.sr-title')).toHaveText('#atlas'); // r15: the real room is the heading
    await expect(page.locator('.sr-context')).toHaveText('Atlas Institute · no room of its own yet, talking in #atlas');
    await expect(page.locator('.sr-chat').getByRole('textbox', { name: /^Message / })).toHaveAttribute('placeholder', 'Message #atlas');
    if (!wide(page)) await page.locator('.sr-drawer').click();
    await scope.locator('.th-go[aria-label^="ATLAS,"]').click();
    await expect(page.locator('.sr-door')).toHaveText('#atlas/build');
    await shot(page, 'project');
    // the conversation is in place (no new tab); "All of X's work" is a view in the same shell, whose "Back to chat" returns to it (r13)
    const tabs = await page.locator('.tab-title').count();
    if (!wide(page)) await page.locator('.cp-line').click();
    await page.getByRole('button', { name: /^All of .*'s work/ }).click();
    await expect(page.locator('.sr-door')).toHaveText('#atlas/build');
    const open = page.getByRole('button', { name: 'Back to chat' });
    await expect(open).toBeVisible();
    expect((await open.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await open.click();
    await expect(page.locator('.sr-chat')).toBeVisible();
    await expect(page.locator('.tab-title')).toHaveCount(tabs);
    await shot(page, 'opened');
  });

  test('r12: build and teach are only rooms of the tree (no separate conversation list); a room only a node owns is never an "Other room"', async ({ page }) => {
    await boot(page);
    await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Rooms', exact: true })).toHaveCount(0);
    await expect(page.locator('.rooms nav .room')).toHaveCount(0);
    const scope = wide(page) ? page.locator('.th-roomnav') : page.locator('.th-phone-tree');
    for (let i = 0; i < 12; i++) { await scope.locator('.th-row.d1').first().waitFor(); const f = scope.locator('.th-fold[aria-expanded="false"]'); if (!await f.count()) break; await f.first().click(); }
    for (const t of await scope.locator('.th-other .th-go').allInnerTexts()) expect(t).not.toMatch(/atlas/);
    await shot(page, 'list');
  });
});

// T-335 Uni 0.2: one home, fewer controls, one calm language. Every main screen at a 360 px phone, the Daylight in Calm screen (judged in
// greyscale) and a desktop:
// - there is one home: the rail's Uni opens All's stream with what needs you and the places folded under its head; no second home, no All tab;
// - each screen's visible controls stay at or under the targets the audit set (before → after counts in the report);
// - nothing runs past the edge or overlaps at 360 px, and every word reads in greyscale (contrast 4.5:1, 3:1 for large type).
// Made-up world only. Run: V02_TEST_PORT=17611 npx playwright test --config playwright.v02.config.ts
// V02_COUNTS=<file>: each screen's measures are appended there as one JSON line (the report's before/after table).
import { test, expect, type Page } from '@playwright/test';
import { focusSheet } from './areasFixture';
import { boot, check, go, openHead, openPlace, phone, project, rail } from './v02Measure';
import * as mailMock from './mailMock';

test.describe('one home', () => {
  test('the rail has one home: Uni opens All\'s stream, with what needs you and the places folded under its head', async ({ page }) => {
    await boot(page);
    // no second home: never the places page, no All tab, no For you tab
    await expect(page.locator('[data-view="places"]')).toHaveCount(0);
    await expect(rail(page).getByRole('button', { name: 'All', exact: true })).toHaveCount(0);
    await expect(rail(page).getByRole('button', { name: 'For you', exact: true })).toHaveCount(0);
    await rail(page).getByRole('button', { name: 'Uni', exact: true }).click();
    await expect(page.locator('[data-place="front-door"][data-view="all"]')).toBeVisible();
    await expect(page.locator('[data-view="places"]')).toHaveCount(0);
    await expect(rail(page).getByRole('button', { name: 'Uni', exact: true })).toHaveAttribute('aria-current', 'page');
    // one composer, at the foot of the stream
    await expect(page.getByRole('region', { name: 'Talk to Uni' })).toHaveCount(1);
    await expect(page.locator('article.all-msg').first()).toBeVisible();
    // the head says the day, and opens to what needs you and every place
    const pull = page.locator('[data-place="front-door"] .fd-pull');
    await expect(pull).toHaveText(/(thing|things) needs? you\./);
    await expect(page.locator('.fd-door')).toHaveCount(0);
    await check(page, 'home');
    await openHead(page);
    await expect(page.getByRole('region', { name: 'Needs you' })).toContainText('Find jars for the honey');
    await expect(page.locator('.fd-door[data-path="Areas/Kiln Studio"]')).toBeVisible();
    await expect(page.getByRole('button', { name: /^For you/ })).toBeVisible();
    await check(page, 'home-open');
    // a place opens its room in focus over the home; Back comes home with the head as it was
    await page.locator('.fd-door[data-path="Areas/Kiln Studio"]').click();
    await expect(focusSheet(page).locator('.all-focus-title')).toHaveText('Kiln Studio');
    await expect(page.locator('.all-behind [data-view="all"]')).toHaveCount(1);
    if (phone(page) || project() === 'daylight') await page.evaluate(() => { const w = window as any; w.__cbs[w.__backHandler.id]({ message: {}, index: 0 }); });
    else await page.keyboard.press('Escape');
    await expect(focusSheet(page)).toHaveCount(0);
    await expect(page.locator('[data-place="front-door"][data-view="all"]')).toBeVisible();
  });

  test('For you opens from the home and comes back to it', async ({ page }) => {
    await boot(page);
    await openHead(page);
    await page.getByRole('button', { name: /^For you/ }).click();
    await expect(page.getByText('Worth a look')).toBeVisible();
    await check(page, 'for-you');
    await page.locator('.note-sheet').getByRole('button', { name: /Uni/ }).first().click();
    await expect(page.locator('[data-place="front-door"][data-view="all"]')).toBeVisible();
  });
});

test.describe('every screen, measured', () => {
  test('a room, its details and a task', async ({ page }) => {
    await boot(page);
    await openPlace(page, 'Kiln Studio');
    await expect(focusSheet(page).locator('.message-list article.message').first()).toBeVisible();
    await check(page, 'room');
    await openPlace(page, 'Bee Garden');
    await focusSheet(page).getByRole('button', { name: /: room details$/ }).click();
    await expect(focusSheet(page).locator('.all-focus-details')).toBeVisible();
    await check(page, 'room-details');
    await focusSheet(page).locator('.cp-need').filter({ hasText: 'Find jars for the honey' }).first().click();
    await expect(page.getByRole('dialog').filter({ has: page.locator('.task-kind') }).first()).toBeVisible();
    await check(page, 'task');
  });

  test('Journal', async ({ page }) => {
    await page.addInitScript(() => { (window as any).__journal = [1, 2].map((i) => ({ id: `j${i}`, path: `Journal/2026/10-1${i}/09-00 Entry ${i}`, created_at: `2026-10-1${i}T15:00:00Z`, content: `A made-up morning entry, number ${i}. The kiln was warm.`, source: 'text', entry_id: `e${i}` })); });
    await boot(page);
    await go(page, 'Journal');
    await expect(page.locator('.journal-tab-content')).toBeVisible();
    await check(page, 'journal');
  });

  test('Mail', async ({ page }) => {
    await mailMock.boot(page, 'ok');
    await expect(mailMock.mail(page)).toBeVisible();
    await mailMock.rows(page).first().waitFor();
    await check(page, 'mail');
  });

  test('the vault and a note', async ({ page }) => {
    await boot(page);
    await go(page, 'Vault');
    await expect(page.locator('.vault-browser').first()).toBeVisible();
    await check(page, 'vault');
    await page.locator('.vault-browser').getByRole('button', { name: /^\W*Areas$/ }).first().click();
  await page.locator('.vault-browser').getByRole('button', { name: /Bee Garden/ }).first().click();
    await expect(page.getByRole('button', { name: 'Copy markdown' })).toBeVisible();
    await check(page, 'note');
  });

  test('Search', async ({ page }) => {
    await boot(page);
    await go(page, 'Search');
    await page.getByRole('searchbox').fill('bisque');
    await expect(page.locator('.search-hit').first()).toBeVisible();
    await check(page, 'search');
  });

  test('Settings', async ({ page }) => {
    await boot(page);
    await go(page, 'Settings');
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await check(page, 'settings');
  });

  test('Arcade', async ({ page }) => {
    await boot(page);
    await go(page, 'Arcade');
    await expect(page.getByRole('region', { name: 'Arcade' })).toBeVisible();
    await check(page, 'arcade');
  });

  test('More, on a phone', async ({ page }) => {
    test.skip(!phone(page), 'a phone\'s bar');
    await boot(page);
    await rail(page).getByRole('button', { name: 'More', exact: true }).click();
    await expect(rail(page).getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
    await check(page, 'more');
  });
});

// 0.3.1 home layout: For you folds to one head (what is yours, to look at, moving, and the first ask) so the rooms' stream has most of the
// screen; it opens to its bands and one tap still takes a default. The stream is one stream with a scope: every area's rooms, or one area's
// (its own room and the rooms of the places inside it), one tap on All (or Back, or Escape) from every room again; an area's room opens from
// its stream and Back from it comes back to that stream. Phone 360, Daylight 828, desktop 1440. Made-up world only (forYouFixture.ts).
// Run: FORYOU_TEST_PORT=17631 npx playwright test --config playwright.foryou.config.ts homeLayout
import { test, expect, type Page } from '@playwright/test';
import { bootForYou } from './forYouFixture';
import { focusSheet } from './areasFixture';

const calls = (page: Page, cmd: string) => page.evaluate((c) => (window as any).__calls.filter((x: any) => x.cmd === c).map((x: any) => x.args), cmd);
const forYou = (page: Page) => page.getByRole('region', { name: 'For you' });
const toggle = (page: Page) => forYou(page).locator('.fy-toggle');
const stream = (page: Page) => page.getByRole('log', { name: 'All rooms, by time' });
const chip = (page: Page, name: string) => page.getByRole('navigation', { name: 'Show in the stream' }).getByRole('button', { name, exact: true });
/** The rooms the stream's messages come from, by their label. */
const roomsShown = (page: Page) => stream(page).locator('article.all-msg[data-room]').evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute('data-room')))].sort());

test.describe('home layout', () => {
  test('For you is folded to one head; the stream has most of the screen', async ({ page }) => {
    await bootForYou(page);
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
    // the head: how many are his, to look at, moving; and the first ask, by itself
    await expect(toggle(page)).toHaveText(/^8 for you · 1 to look at · 3 moving$/);
    await expect(forYou(page).locator('.fy-first')).toContainText('Bring the soup pot on Saturday');
    await expect(forYou(page).locator('article.fy-item')).toHaveCount(0);
    await expect(stream(page).locator('article.all-msg').first()).toBeVisible();
    const m = await page.evaluate(() => {
      const h = innerHeight, r = (s: string) => document.querySelector(s)!.getBoundingClientRect();
      return { h, fy: r('.fy-wrap').height, stream: r('.fd-stream').height };
    });
    // For you is a head, not a page; the stream (and its scope row) holds most of what the screen shows
    expect(m.fy).toBeLessThan(m.h * 0.15);
    expect(m.stream).toBeGreaterThan(m.h * 0.5);
  });

  test('For you opens to its bands, and one tap still takes the default', async ({ page }) => {
    await bootForYou(page);
    await forYou(page).locator('.fy-first').click();
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(forYou(page).locator('.fy-band > h2')).toHaveText([/^Yours/, /^Ready to look at/, /^Moving/]);
    await forYou(page).locator('article.fy-item[data-id="fy-glaze"] .fy-default').click();
    await expect(forYou(page).getByRole('region', { name: 'Answered today' }).locator('.fy-done[data-post="sent"]')).toHaveCount(1);
    expect((await calls(page, 'vault_transition')).map((a: any) => [a.id, a.metadata.answer])).toEqual([['fy-glaze', 'Celadon']]);
    expect((await calls(page, 'post_message')).map((a: any) => [a.channel, a.replyTo, a.body])).toEqual([['ch-kiln', 'k3', 'T-501: Celadon']]);
    // folded again, the head counts one fewer
    await toggle(page).click();
    await expect(toggle(page)).toHaveText(/^7 for you/);
  });

  test("an area's stream: its rooms by time, its For you; one tap on All for every room", async ({ page }) => {
    await bootForYou(page);
    await expect(stream(page).locator('article.all-msg').first()).toBeVisible();
    expect(await roomsShown(page)).toEqual(['ch-bees', 'ch-choir', 'ch-kiln', 'ch-north', 'ch-table']);
    await expect(chip(page, 'All')).toHaveAttribute('aria-pressed', 'true');
    await chip(page, 'Kiln Studio').click();
    await expect(chip(page, 'Kiln Studio')).toHaveAttribute('aria-pressed', 'true');
    // the area's own room and the room of the project inside it, woven by time; nothing else
    await expect(stream(page).locator('article.all-msg[data-room="ch-glaze"]').first()).toBeVisible();
    expect(await roomsShown(page)).toEqual(['ch-glaze', 'ch-kiln']);
    await expect(page.locator('.all-scope-line')).toContainText('#kiln-studio and #glaze-tests, by time');
    // For you, here: only what is Kiln Studio's
    await expect(toggle(page)).toHaveText(/^1 for you · 1 to look at · 1 moving$/);
    await expect(forYou(page).locator('.fy-first')).toContainText('Pick the glaze for the test tiles');
    // one tap back to every area's rooms
    await chip(page, 'All').click();
    await expect(chip(page, 'All')).toHaveAttribute('aria-pressed', 'true');
    await expect(stream(page).locator('article.all-msg[data-room="ch-north"]').first()).toBeVisible();
    expect(await roomsShown(page)).toEqual(['ch-bees', 'ch-choir', 'ch-kiln', 'ch-north', 'ch-table']);
    await expect(toggle(page)).toHaveText(/^8 for you/);
    // Escape does the same
    await chip(page, 'Choir').click();
    expect(await roomsShown(page)).toEqual(['ch-choir']);
    await page.keyboard.press('Escape');
    await expect(chip(page, 'All')).toHaveAttribute('aria-pressed', 'true');
  });

  test("the area's room opens from its stream, and Back comes back to the stream", async ({ page }) => {
    await bootForYou(page);
    await chip(page, 'Kiln Studio').click();
    await page.locator('.all-scope-line').getByRole('button', { name: 'Open Kiln Studio ›' }).click();
    await expect(focusSheet(page).locator('.all-focus-title')).toHaveText('Kiln Studio');
    // from the area's room, one step back is its stream (its rooms woven), one more is every room
    await focusSheet(page).getByRole('button', { name: 'Back to Uni' }).click();
    await expect(focusSheet(page)).toHaveCount(0);
    await expect(chip(page, 'Kiln Studio')).toHaveAttribute('aria-pressed', 'true');
    await expect(stream(page).locator('article.all-msg[data-room="ch-glaze"]').first()).toBeVisible();
    await chip(page, 'All').click();
    await expect(stream(page).locator('article.all-msg[data-room="ch-north"]').first()).toBeVisible();
  });

  test("a reply sent in an area's stream stays in that stream: no stray row in All, none in another area's", async ({ page }) => {
    await bootForYou(page);
    await chip(page, 'Kiln Studio').click();
    // reply to the project's room from the area's stream
    await stream(page).locator('article.all-msg[data-room="ch-glaze"] .message-content').first().click();
    await page.getByRole('textbox', { name: 'Message for your rooms' }).fill('Probe words for the tiles.');
    await page.getByRole('region', { name: 'Talk to Uni' }).getByRole('button', { name: /^(Send|Reply)/ }).click();
    await expect.poll(async () => (await calls(page, 'post_message')).map((a: any) => a.channel)).toEqual(['ch-glaze']);
    await expect(stream(page)).toContainText('Probe words for the tiles.');
    // All doesn't hold the project's room: the reply isn't there, as itself or as a stand-in
    await chip(page, 'All').click();
    await expect(stream(page).locator('article.all-msg[data-room="ch-north"]').first()).toBeVisible();
    await expect(stream(page)).not.toContainText('Probe words for the tiles.');
    await chip(page, 'Choir').click();
    await expect(stream(page)).not.toContainText('Probe words for the tiles.');
  });

  test('nothing in the head or the scope row runs past the edge', async ({ page }) => {
    await bootForYou(page);
    await chip(page, 'Long Table').click();
    const over = await page.evaluate(() => { const W = innerWidth; return Array.from(document.querySelectorAll('.fy-top *, .fy-first, .fy-first *, .all-scope-line, .all-scope-line *')).filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.right > W + 1 || r.left < -1); }).map((e) => (e as HTMLElement).className); });
    expect(over).toEqual([]);
  });
});

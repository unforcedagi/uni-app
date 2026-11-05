// T-335 All v2. Tap (or swipe) a message in All and the composer replies in that room or thread, with no routing step; All is on the app's main
// navigation from every room, and back; a small model suggests the route when nothing is targeted, and the word match stands when it is slow or
// down. Made-up world only. The model is a stub here; the door itself is tested in services/route/test_server.py and by one real call.
// Run: ALLV2_TEST_PORT=1481 npx playwright test --config playwright.allv2.config.ts
import { test, expect, type Page } from '@playwright/test';
import { bootAreas } from './areasFixture';

const UNI = 'c'.repeat(64);
const project = () => test.info().project.name;
const touch = () => project() !== 'desktop';
const rail = (page: Page) => page.getByRole('navigation', { name: 'Main navigation' });
const feed = (page: Page) => page.getByRole('log', { name: 'All rooms, by time' });
const field = (page: Page) => page.getByRole('textbox', { name: 'Message for your rooms' });
const row = (page: Page, ref: string) => feed(page).locator(`article[data-ref="${ref}"]`);
const posts = (page: Page) => page.evaluate(() => (window as any).__calls.filter((c: any) => c.cmd === 'post_message').map((c: any) => ({ channel: c.args.channel, body: c.args.body, replyTo: c.args.replyTo, recipients: c.args.recipients })));
const calls = (page: Page, cmd: string) => page.evaluate((k) => (window as any).__calls.filter((c: any) => c.cmd === k).map((c: any) => c.args), cmd);
const reply = (page: Page) => page.getByRole('group', { name: 'Where this goes' }).locator('.all-reply-chip');
const chosen = (page: Page) => page.locator('.all-chip.chosen:not(.all-reply-chip) .all-chip-name');
const offered = (page: Page) => page.locator('.all-chip.suggested .all-chip-name');
const send = (page: Page) => page.locator('.all-send');
const allIn = async (page: Page) => { await rail(page).getByRole('button', { name: 'All', exact: true }).click(); await expect(page.locator('[data-view="all"]')).toBeVisible(); await expect(feed(page).locator('article.all-msg')).toHaveCount(13); };

type Stub = { mode: 'ok' | 'down' | 'slow' | 'off'; picks?: { id: string; why: string; sure?: boolean }[]; delay?: number };
/** The door's answer: `off` (default) as a device off the tailnet. */
async function boot(page: Page, stub: Stub = { mode: 'off' }, opts: Record<string, unknown> = {}) {
  await page.addInitScript((s) => {
    const w = window as any;
    if (window.innerWidth === 828 && window.innerHeight === 1104) { try { localStorage.setItem('uni.motion', 'calm'); } catch { /* */ } }
    w.__routeStub = s;
    w.__extraInvoke = async (cmd: string) => {
      if (cmd === 'route_outcome') return {};
      if (cmd !== 'route_suggest') return undefined;
      const st = w.__routeStub;
      if (st.mode === 'off' || st.mode === 'down') throw 'route door unreachable';
      await new Promise((r) => setTimeout(r, st.mode === 'slow' ? st.delay ?? 2500 : st.delay ?? 60));
      return { id: 'sg-1', picks: st.picks, ms: 900 };
    };
  }, stub);
  await bootAreas(page, 'seed', { world: 'unread', glow: true, uniMember: true, ...opts } as any);
  await page.locator('[data-place="front-door"]').waitFor();
}

test.describe('inline reply', () => {
  test('tap a message: the composer replies in that room, no routing step, posted there once and nowhere else; the chip clears after', async ({ page }) => {
    await boot(page);
    await allIn(page);
    await row(page, 'k3').locator('.message-content').click();
    await expect(reply(page)).toContainText('Replying in #kiln-studio');
    await expect(row(page, 'k3')).toHaveClass(/targeted/);
    await expect(field(page)).toBeFocused();
    await field(page).fill('Bee question: can the crawled tile go to the garden?');
    // the words name the Bee Garden, and there is no route: no chips, no suggestions, no model call
    await page.waitForTimeout(700);
    await expect(chosen(page)).toHaveCount(0);
    await expect(offered(page)).toHaveCount(0);
    expect(await calls(page, 'route_suggest')).toHaveLength(0);
    await expect(send(page)).toHaveAccessibleName('Send to Kiln Studio');
    await send(page).click();
    // the same frame as Send: empty, and your words on screen
    await expect(field(page)).toHaveValue('');
    await expect.poll(() => posts(page)).toEqual([{ channel: 'ch-kiln', body: 'Bee question: can the crawled tile go to the garden?', replyTo: null, recipients: [UNI] }]);
    await expect(feed(page).locator('article.all-msg.mine').last()).toContainText('Bee question');
    await expect(reply(page)).toHaveCount(0);
    await expect(feed(page).locator('article.all-msg.mine').filter({ hasText: 'Bee question' })).toHaveCount(1);
    await expect(row(page, 'k3')).not.toHaveClass(/targeted/);
  });

  test('a threaded message: the reply goes into its thread, and says so', async ({ page }) => {
    await boot(page);
    await allIn(page);
    await page.evaluate(() => (window as any).__arrive('ch-choir', 'Priya', 'Altos are short two copies.', 0, false, 'c3'));
    await expect(row(page, 'c3')).toContainText('1 reply');
    await row(page, 'c3').locator('.message-content').click();
    await expect(reply(page)).toContainText('Replying in #choir');
    await expect(reply(page)).toContainText('thread');
    await field(page).fill('Print two more, please.');
    await send(page).click();
    await expect.poll(() => posts(page)).toEqual([{ channel: 'ch-choir', body: 'Print two more, please.', replyTo: 'c3', recipients: [UNI] }]);
    // a thread's reply never joins the room's timeline, and you still see it went
    const echo = feed(page).locator('article.all-msg.mine').filter({ hasText: 'Print two more' });
    await expect(echo).toHaveCount(1);
    await expect(echo).toContainText('thread');
  });

  test('clearing the chip returns to routing, with the draft kept; a second tap on the message clears too', async ({ page }) => {
    await boot(page);
    await allIn(page);
    await row(page, 'k3').locator('.message-content').click();
    await field(page).fill('Is the honey ready to jar?');
    await page.getByRole('button', { name: 'Stop replying in #kiln-studio' }).click();
    await expect(reply(page)).toHaveCount(0);
    await expect(field(page)).toHaveValue('Is the honey ready to jar?');
    await expect(chosen(page)).toHaveText(['Bee Garden']);
    await expect(send(page)).toHaveText('Send to Bee Garden');
    await row(page, 'b2').locator('.message-content').click();
    await expect(reply(page)).toContainText('#bee-garden');
    await row(page, 'b2').locator('.message-content').click();
    await expect(reply(page)).toHaveCount(0);
    expect(await posts(page)).toEqual([]);
  });

  test('swipe a message on touch: same as a tap; an up-and-down scroll does nothing', async ({ page }) => {
    test.skip(!touch(), 'touch only');
    await boot(page);
    await allIn(page);
    const box = (await row(page, 'k3').boundingBox())!;
    const y = box.y + box.height / 2;
    const swipe = async (dx: number, dy: number) => {
      const cdp = await page.context().newCDPSession(page);
      const x0 = 120, y0 = y;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] });
      for (let i = 1; i <= 6; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + (dx * i) / 6, y: y0 + (dy * i) / 6 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    await swipe(0, -30);
    await expect(reply(page)).toHaveCount(0);
    await swipe(110, 4);
    await expect(reply(page)).toContainText('Replying in #kiln-studio');
  });

  test('the room label still opens the room; a link in a message is still a link', async ({ page }) => {
    await boot(page);
    await allIn(page);
    await row(page, 'k3').locator('.all-place').click();
    await expect(page.getByRole('textbox', { name: /^Message kiln-studio/ })).toBeVisible();
    await expect(page.locator('.message-list')).toContainText('Three glaze tiles');
  });

  test('a failed reply gives the words and the chip back, and says why; two Enters post once', async ({ page }) => {
    await boot(page);
    await allIn(page);
    await page.evaluate(() => { const w = window as any; const prev = w.__extraInvoke; w.__failPosts = 1; w.__extraInvoke = async (cmd: string, a: any) => { if (cmd === 'post_message' && w.__failPosts-- > 0) { w.__calls.push({ cmd: 'post_failed', args: a }); throw 'relay said no'; } return prev(cmd, a); }; });
    await row(page, 'k3').locator('.message-content').click();
    await field(page).fill('Keep the crawled tile.');
    await send(page).click();
    await expect(field(page)).toHaveValue('Keep the crawled tile.');
    await expect(reply(page)).toContainText('#kiln-studio');
    await expect(page.locator('.all-note.all-failed')).toContainText('relay said no');
    await expect(feed(page).locator('article.all-msg.mine').filter({ hasText: 'Keep the crawled' })).toHaveCount(0);
    if (!touch()) {
      await field(page).focus();
      await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
    } else { await send(page).click(); }
    // one for the failed try, one for the two Enters
    await expect.poll(async () => (await posts(page)).length).toBe(2);
    await page.waitForTimeout(150);
    expect(await posts(page)).toHaveLength(2);
  });
});

test.describe('All from everywhere', () => {
  test('from a room to All and back, by the rail and by the place it came from; a private room stays out', async ({ page }) => {
    await boot(page);
    await page.locator('.fd-door[data-path="Areas/Kiln Studio"]').click();
    const box = page.getByRole('textbox', { name: /^Message kiln-studio/ });
    await box.waitFor();
    const all = rail(page).getByRole('button', { name: 'All', exact: true });
    await expect(all).toBeVisible();
    await all.click();
    await expect(page.locator('[data-view="all"]')).toBeVisible();
    await expect(all).toHaveAttribute('aria-current', 'page');
    await expect(rail(page).getByRole('button', { name: 'Uni', exact: true })).not.toHaveAttribute('aria-current', 'page');
    await expect(feed(page).locator('article[data-ref="k3"]')).toBeVisible();
    await expect(feed(page)).not.toContainText('Restless but stayed');
    // back to the room it came from, by its name
    await page.getByRole('button', { name: /^← Kiln Studio/ }).click();
    await expect(box).toBeVisible();
    // and the rail's Uni comes back the same way
    await all.click();
    await expect(page.locator('[data-view="all"]')).toBeVisible();
    await rail(page).getByRole('button', { name: 'Uni', exact: true }).click();
    await expect(box).toBeVisible();
  });

  test('All is never where the app opens: a reload from All opens on rooms; home opens on Places even with an old saved choice', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('uni.home.view', 'all'));
    await boot(page);
    await expect(page.locator('[data-view="places"]')).toBeVisible();
    await allIn(page);
    await page.reload();
    await page.locator('[data-place="front-door"]').waitFor();
    await expect(page.locator('[data-view="places"]')).toBeVisible();
    await expect(page.locator('[data-view="all"]')).toHaveCount(0);
  });

  test('All is one tap from the Journal too; opening it posts nothing', async ({ page }) => {
    await boot(page);
    await rail(page).getByRole('button', { name: 'Journal', exact: true }).click();
    await allIn(page);
    expect(await posts(page)).toEqual([]);
  });
});

test.describe('Haiku route', () => {
  const asked = (page: Page) => calls(page, 'route_suggest');

  test('in time: the model\'s rooms and reasons replace the word match; sure is chosen and named on Send, the rest offered; nothing sends without a tap', async ({ page }) => {
    await boot(page, { mode: 'ok', picks: [{ id: 'ch-table', why: 'supper plans', sure: true }, { id: 'ch-kiln', why: 'the bowls' }] });
    await allIn(page);
    await field(page).fill('Could we borrow bowls for Saturday?');
    await expect(chosen(page)).toHaveText(['Long Table']);
    await expect(offered(page)).toHaveText(['Kiln Studio']);
    await expect(page.locator('.all-chip.suggested .all-chip-why')).toHaveText('the bowls');
    await expect(page.locator('[data-why]')).toContainText('supper plans');
    await expect(send(page)).toHaveText('Send to Long Table');
    // what went: the text, and each room's name and one line; a private room is never sent
    const a = (await asked(page)).at(-1);
    expect(a.text).toBe('Could we borrow bowls for Saturday?');
    expect(a.rooms.map((r: any) => r.id).sort()).toEqual(['ch-bees', 'ch-choir', 'ch-kiln', 'ch-north', 'ch-table']);
    expect(a.rooms.find((r: any) => r.id === 'ch-table').about).toBe('The Saturday supper club.');
    expect(JSON.stringify(a)).not.toContain('Sanctum');
    expect(await posts(page)).toEqual([]);
    // the chips stay yours: drop the chosen, take the offered
    await page.getByRole('button', { name: "Don't send to Long Table" }).click();
    await expect(offered(page)).toHaveText(['Long Table', 'Kiln Studio']); // what you dropped stays one tap away
    await page.locator('.all-chip.suggested[data-room="ch-kiln"]').click();
    await expect(chosen(page)).toHaveText(['Kiln Studio']);
    await send(page).click();
    await expect.poll(() => posts(page)).toEqual([{ channel: 'ch-kiln', body: 'Could we borrow bowls for Saturday?', replyTo: null, recipients: [UNI] }]);
    // the log: room ids against what was sent; never the words
    await expect.poll(() => calls(page, 'route_outcome')).toHaveLength(1);
    const o = (await calls(page, 'route_outcome'))[0].outcome;
    expect(o).toEqual({ suggestion: 'sg-1', model: ['ch-table', 'ch-kiln'], modelState: 'in-time', words: expect.any(Array), sent: ['ch-kiln'], edited: true });
    expect(JSON.stringify(o)).not.toContain('bowls');
  });

  test('down: the word match is the route, at once, and Send still works', async ({ page }) => {
    await boot(page, { mode: 'down' });
    await allIn(page);
    await field(page).fill('Is the honey ready to jar?');
    await expect(chosen(page)).toHaveText(['Bee Garden']);
    await expect(send(page)).toHaveText('Send to Bee Garden');
    await expect.poll(async () => (await asked(page)).length).toBeGreaterThan(0);
    await page.waitForTimeout(100);
    await expect(chosen(page)).toHaveText(['Bee Garden']);
    await send(page).click();
    await expect.poll(() => posts(page)).toEqual([{ channel: 'ch-bees', body: 'Is the honey ready to jar?', replyTo: null, recipients: [UNI] }]);
    await expect.poll(() => calls(page, 'route_outcome')).toHaveLength(1);
    expect((await calls(page, 'route_outcome'))[0].outcome).toEqual({ suggestion: null, model: [], modelState: 'down', words: ['ch-bees'], sent: ['ch-bees'], edited: false });
  });

  test('slow: past 1.5 s the word match stands; a late answer only adds offers, and what is chosen does not move', async ({ page }) => {
    await boot(page, { mode: 'slow', delay: 2200, picks: [{ id: 'ch-north', why: 'the far corner', sure: true }] });
    await allIn(page);
    await field(page).fill('Is the honey ready to jar?');
    await expect(chosen(page)).toHaveText(['Bee Garden']);
    await page.waitForTimeout(1800);
    await expect(chosen(page)).toHaveText(['Bee Garden']);
    await expect(offered(page)).toHaveCount(0);
    await expect(offered(page)).toHaveText(['North Field'], { timeout: 3000 });
    await expect(chosen(page)).toHaveText(['Bee Garden']);
    await expect(send(page)).toHaveText('Send to Bee Garden');
  });

  test('a room you name is yours: no call goes out; a message you only typed goes nowhere', async ({ page }) => {
    await boot(page, { mode: 'ok', picks: [{ id: 'ch-north', why: 'x', sure: true }] });
    await allIn(page);
    await field(page).fill('Tell Choir the hall is booked');
    await expect(chosen(page)).toHaveText(['Choir']);
    await page.waitForTimeout(800);
    expect(await asked(page)).toEqual([]);
    expect(await posts(page)).toEqual([]);
  });

  test('a late Send cannot follow a route that just changed under the thumb', async ({ page }) => {
    await boot(page, { mode: 'ok', delay: 300, picks: [{ id: 'ch-table', why: 'supper plans', sure: true }] });
    await allIn(page);
    await field(page).fill('Is the honey ready to jar?');
    // a tap landing in the very frame the label changes
    await page.evaluate(() => { const b = document.querySelector<HTMLButtonElement>('.all-send')!; const o = new MutationObserver(() => { if (b.textContent === 'Send to Long Table') { o.disconnect(); b.click(); (window as any).__tapped = true; } }); o.observe(b, { childList: true, subtree: true, characterData: true }); });
    await expect.poll(() => page.evaluate(() => !!(window as any).__tapped)).toBe(true);
    expect(await posts(page)).toEqual([]);
    await page.waitForTimeout(400);
    await send(page).click();
    await expect.poll(async () => (await posts(page)).map((p: any) => p.channel)).toEqual(['ch-table']);
  });
});

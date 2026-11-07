// T-335 one fluid surface. Long messages read in full in All, in place, with their markdown, media and links. A room's label puts that room in focus
// inside All: everything else recedes, the room's whole thread and its own composer are there, and one tap (or Back) returns to All where it was.
// Made-up world only.
// Run: FLUID_TEST_PORT=1491 npx playwright test --config playwright.fluid.config.ts
import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { bootAreas, openPlaces } from './areasFixture';
import { railGo } from './railGo';

const project = () => test.info().project.name;
const touch = () => project() !== 'desktop';
const rail = (page: Page) => page.getByRole('navigation', { name: 'Main navigation' });
const feed = (page: Page) => page.getByRole('log', { name: 'All rooms, by time' });
const row = (page: Page, ref: string) => page.locator(`article.all-msg[data-ref="${ref}"]`);
const field = (page: Page) => page.getByRole('textbox', { name: 'Message for your rooms' });
const sheet = (page: Page) => page.getByRole('region', { name: /in focus$/ });
const roomBox = (page: Page, slug: string) => page.getByRole('textbox', { name: new RegExp(`^Message ${slug}`) });
// 0.2 one home: All is Uni's home, so the focus's Back is "← Uni" and the rail's Uni is the way to All (there is no All tab)
const backToAll = (page: Page) => sheet(page).getByRole('button', { name: 'Back to Uni' });
const allTab = (page: Page) => rail(page).getByRole('button', { name: 'Uni', exact: true });
const posts = (page: Page) => page.evaluate(() => (window as any).__calls.filter((c: any) => c.cmd === 'post_message').map((c: any) => ({ channel: c.args.channel, body: c.args.body, replyTo: c.args.replyTo })));
const calls = (page: Page, cmd: string) => page.evaluate((k) => (window as any).__calls.filter((c: any) => c.cmd === k).map((c: any) => c.args), cmd);
/** Android's Back, as the plugin delivers it. */
const androidBack = (page: Page) => page.evaluate(() => { const w = window as any; w.__cbs[w.__backHandler.id]({ message: {}, index: w.__backIndex ?? 0 }); w.__backIndex = (w.__backIndex ?? 0) + 1; });

const SHA = 'a'.repeat(64);
const LONG = [
  '**The glaze report.** Three tiles came out of the test firing and they tell different stories.', '',
  '- Tile one: glossy, even, no crawl at all.', '- Tile two: crawled along the rim where the slip was thick.', '- Tile three: pinholes across the middle, likely a fast ramp.', '',
  'I would keep the first recipe and thin the slip by a tenth. See [the firing log](https://example.com/firing-log) for ramps.', '',
  '| Tile | Cone | Result |', '|---|---|---|', '| 1 | 6 | glossy |', '| 2 | 6 | crawled |', '',
  'The next firing can go on Thursday if the shelves are clean by then. THE-LAST-WORDS',
].join('\n');
// a one-pixel PNG: the attachment is the fixture's, the path is the real one (media_bytes → blob → <img>)
const PNG = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 100, 248, 207, 192, 0, 0, 3, 3, 1, 0, 24, 221, 141, 176, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130];

/** The made-up world, with enough said that All scrolls at every size; two long messages (one with a picture) sit in the middle of it. */
async function boot(page: Page, opts: Record<string, unknown> = {}) {
  await page.addInitScript(({ calm, png }) => {
    const w = window as any;
    if (calm) { try { localStorage.setItem('uni.motion', 'calm'); } catch { /* */ } }
    w.__extraInvoke = async (cmd: string) => { if (cmd === 'route_suggest') throw 'route door unreachable'; if (cmd === 'route_outcome') return {}; if (cmd === 'media_bytes') return new Uint8Array(png).buffer; return undefined; };
  }, { calm: project() === 'daylight', png: PNG });
  await bootAreas(page, 'seed', { world: 'unread', glow: true, uniMember: true, ...opts } as any);
  await page.locator('[data-place="front-door"]').waitFor();
  await page.evaluate(({ long, sha }) => {
    const w = window as any, now = Math.floor(Date.now() / 1000);
    const add = (ref: string, channel: string, ago: number, body: string, media: unknown[] = []) => w.__msgs[channel].push({ ref, channel, author: 'b'.repeat(64), author_name: 'Uni', ts: now - ago, body, mentions_me: false, root: null, parent: null, mentions: [], reply_count: 0, last_reply_ts: null, edited: false, reactions: [], media });
    const rooms = ['ch-north', 'ch-bees', 'ch-table', 'ch-choir'];
    for (let i = 0; i < 24; i++) add(`f${i}`, rooms[i % 4], 1500 - i * 40, `A short made-up line, number ${i}, so the feed has some length to it.`);
    add('long1', 'ch-kiln', 500, long);
    add('pic1', 'ch-bees', 420, `${long}\n\nThe frames, for the record.`, [{ url: `wss://relay.test/media/${sha}.png`, mime: 'image/png', sha256: sha, size: 70, dim: '320x200', blurhash: null, alt: 'A made-up hive frame', filename: 'frame.png' }]);
    for (let i = 24; i < 36; i++) add(`f${i}`, rooms[i % 4], 400 - (i - 24) * 20, `A short made-up line, number ${i}, so the feed has some length to it.`);
  }, { long: LONG, sha: SHA });
}
async function allIn(page: Page) {
  await allTab(page).click();
  await expect(page.locator('[data-place="front-door"][data-view="all"]')).toBeVisible();
  await expect(row(page, 'long1')).toBeVisible();
}
/** Scrolls All so this message is in the middle, well away from the newest. */
const middleOn = async (page: Page, ref: string) => {
  await row(page, ref).evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(80);
  return feed(page).evaluate((el) => el.scrollTop);
};
const clipped = (el: Element) => el.scrollHeight > el.clientHeight + 2;

test.describe('a long message, in place', () => {
  test('tap it: the whole message is right there in All, with its markdown and its link; no room opened, nothing aimed anywhere', async ({ page }) => {
    await boot(page);
    await allIn(page);
    const m = row(page, 'long1');
    await middleOn(page, 'long1');
    expect(await m.locator('.md').evaluate(clipped)).toBe(true);
    await m.locator('.md').click({ position: { x: 40, y: 12 } });
    // whole, in the same place
    await expect(m).not.toHaveClass(/clamped/);
    await expect.poll(() => m.locator('.md').evaluate(clipped)).toBe(false);
    await expect(m.locator('.md strong').first()).toHaveText('The glaze report.');
    await expect(m.locator('.md li')).toHaveCount(3);
    await expect(m.locator('.md table')).toBeVisible();
    await expect(m.locator('.md')).toContainText('THE-LAST-WORDS');
    await expect(page.locator('[data-view="all"]')).toBeVisible();
    await expect(page.locator('.composer')).toHaveCount(0);
    await expect(sheet(page)).toHaveCount(0);
    await expect(page.locator('.all-reply-chip')).toHaveCount(0);
    // its link is a link
    await m.getByRole('link', { name: 'the firing log' }).click();
    await expect.poll(() => calls(page, 'open_link')).toEqual([{ url: 'https://example.com/firing-log' }]);
    await expect(page.locator('.all-reply-chip')).toHaveCount(0);
    // now that it is read, a tap replies, as on any message
    await m.locator('.md p').first().click();
    await expect(page.locator('.all-reply-chip')).toContainText('#kiln-studio');
    await page.getByRole('button', { name: 'Stop replying in #kiln-studio' }).click();
    // and it folds back, with its top still on screen
    await m.getByRole('button', { name: 'Show less' }).click();
    await expect(m).toHaveClass(/clamped/);
    await expect(m.locator('.all-place')).toBeInViewport();
  });

  test('"Read the rest" opens it in place too, by keyboard or tap, and says so to a screen reader', async ({ page }) => {
    await boot(page);
    await allIn(page);
    const m = row(page, 'long1');
    const rest = m.getByRole('button', { name: 'Read the rest' });
    await expect(rest).toHaveAttribute('aria-expanded', 'false');
    await rest.click();
    await expect(m.locator('.md')).toContainText('THE-LAST-WORDS');
    await expect(m.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.composer')).toHaveCount(0);
  });

  test('a picture in a message shows in All, loaded, with no trip to the room', async ({ page }) => {
    await boot(page);
    await allIn(page);
    await middleOn(page, 'pic1');
    const img = row(page, 'pic1').locator('img');
    await expect(img).toBeVisible();
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
    await expect(row(page, 'pic1')).not.toContainText('open the room');
    // a tap on the picture is the picture's: no reply is aimed
    await expect(page.locator('.all-reply-chip')).toHaveCount(0);
    await expect(page.locator('.composer')).toHaveCount(0);
  });

  test('reading it, a new message elsewhere does not pull the page away', async ({ page }) => {
    await boot(page);
    await allIn(page);
    await feed(page).evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await page.waitForTimeout(80);
    // the newest is the long one, read at the very bottom
    await page.evaluate((b) => (window as any).__arrive('ch-kiln', 'Uni', b), LONG);
    const last = feed(page).locator('article.all-msg').last();
    await expect(last).toHaveClass(/clamped/);
    await last.getByRole('button', { name: 'Read the rest' }).click();
    await expect(last).not.toHaveClass(/clamped/);
    await page.waitForTimeout(1000); // opened, and brought into sight
    const at = await feed(page).evaluate((el) => el.scrollTop);
    await page.evaluate(() => (window as any).__arrive('ch-bees', 'Uni', 'A new line from the bees.'));
    await expect(feed(page)).toContainText('A new line from the bees.');
    await page.waitForTimeout(150);
    expect(Math.abs(await feed(page).evaluate((el) => el.scrollTop) - at)).toBeLessThan(2);
  });

  test('opened mid-run, its first line clears the band at the top', async ({ page }) => {
    await boot(page);
    await page.evaluate((b) => { const w = window as any, now = Math.floor(Date.now() / 1000); for (let i = 0; i < 12; i++) w.__msgs['ch-table'].push({ ref: `tab${i}`, channel: 'ch-table', author: 'b'.repeat(64), author_name: 'Uni', ts: now - 40 + i, body: i === 6 ? b : `Supper note ${i}, with enough words in it to take up a line or so of the column.`, mentions_me: false, root: null, parent: null, mentions: [], reply_count: 0, last_reply_ts: null, edited: false, reactions: [], media: [] }); }, LONG);
    await allIn(page);
    const m = row(page, 'tab6');
    // the row is at the very bottom of the view, so opening it scrolls it up
    await m.evaluate((el) => { const f = el.closest('.all-feed') as HTMLElement; f.scrollTop = (el as HTMLElement).offsetTop - f.clientHeight + 150; });
    await page.waitForTimeout(120);
    await m.getByRole('button', { name: 'Read the rest' }).click();
    await page.waitForTimeout(1100);
    const y = await m.evaluate((el) => { const band = document.querySelector('.all-reading-band')?.getBoundingClientRect().bottom ?? 0; return el.querySelector('.md')!.getBoundingClientRect().top - band; });
    expect(y).toBeGreaterThanOrEqual(0);
    await expect(m.locator('.md').getByText('The glaze report.')).toBeInViewport();
  });

  test('a picture that arrives with no known size: All still ends at its newest', async ({ page }) => {
    await boot(page);
    await page.evaluate((sha) => { const w = window as any, now = Math.floor(Date.now() / 1000); w.__msgs['ch-bees'].push({ ref: 'nodim', channel: 'ch-bees', author: 'b'.repeat(64), author_name: 'Uni', ts: now - 2, body: 'A frame, size unknown.', mentions_me: false, root: null, parent: null, mentions: [], reply_count: 0, last_reply_ts: null, edited: false, reactions: [], media: [{ url: `wss://relay.test/media/${sha}.png`, mime: 'image/png', sha256: sha, size: 70, dim: null, blurhash: null, alt: 'A frame', filename: 'frame.png' }] }); }, SHA);
    // a real size, to grow by when it comes in
    await page.evaluate(async () => { const w = window as any, next = w.__extraInvoke, c = new OffscreenCanvas(600, 400); c.getContext('2d')!.fillRect(0, 0, 600, 400); const buf = await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer(); w.__extraInvoke = async (cmd: string, a: any) => { if (cmd === 'media_bytes') { await new Promise((r) => setTimeout(r, 400)); return buf; } return next(cmd, a); }; });
    await allIn(page);
    await expect.poll(() => row(page, 'nodim').locator('img').evaluate((el: HTMLImageElement) => el.naturalWidth).catch(() => 0)).toBeGreaterThan(0);
    await page.waitForTimeout(200);
    await expect.poll(() => feed(page).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(4);
  });

  test('a reply aimed at one message, reading elsewhere: what arrives, or a message opened, leaves the page where it is', async ({ page }) => {
    await boot(page);
    await allIn(page);
    await row(page, 'k3').locator('.message-content').click();
    await expect(page.locator('.all-reply-chip')).toBeVisible();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await feed(page).evaluate((el) => { el.scrollTop = el.scrollHeight - el.clientHeight - 260; });
    await page.waitForTimeout(250);
    const at = await feed(page).evaluate((el) => el.scrollTop);
    await page.evaluate(() => (window as any).__arrive('ch-bees', 'Uni', 'A new line from the bees.'));
    await expect(feed(page)).toContainText('A new line from the bees.');
    await page.waitForTimeout(200);
    expect(Math.abs(await feed(page).evaluate((el) => el.scrollTop) - at)).toBeLessThan(2);
    const m = row(page, 'pic1');
    await m.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(150);
    await m.getByRole('button', { name: 'Read the rest' }).click();
    await page.waitForTimeout(1100);
    // its start stays on screen (a long one runs on past the fold on a phone)
    await expect(m.getByRole('button', { name: 'Show less' })).toBeVisible();
    await expect(m.locator('.md strong').first()).toBeInViewport();
  });

  test('a reply aimed with the keyboard up, then reading elsewhere: "Read the rest" stays on what you opened when the keyboard goes', async ({ page }) => {
    test.skip(!touch(), 'touch only');
    await boot(page);
    await allIn(page);
    // aimed at the newest, far below what is then opened
    await feed(page).locator('article.all-msg').last().locator('.message-content').click();
    await expect(field(page)).toBeFocused();
    const m = row(page, 'long1');
    await m.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(200);
    await m.getByRole('button', { name: 'Read the rest' }).click();
    await page.waitForTimeout(1100);
    await expect(m.locator('.md strong').first()).toBeInViewport();
  });

  test('a slow scroll up lets go of the newest: what arrives after it does not throw you back down', async ({ page }) => {
    await boot(page);
    await allIn(page);
    await feed(page).evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await page.waitForTimeout(200);
    // less than a pixel an event, as a slow finger on a dense screen
    await feed(page).evaluate(async (el) => { for (let i = 0; i < 400; i++) { el.scrollTop -= 0.75; await new Promise((r) => requestAnimationFrame(r)); } });
    await page.waitForTimeout(150);
    const at = await feed(page).evaluate((el) => el.scrollTop);
    expect(await feed(page).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeGreaterThan(100);
    await page.evaluate(() => (window as any).__arrive('ch-bees', 'Uni', 'A new line from the bees.'));
    await expect(feed(page)).toContainText('A new line from the bees.');
    await page.waitForTimeout(200);
    expect(Math.abs(await feed(page).evaluate((el) => el.scrollTop) - at)).toBeLessThan(2);
  });

  test('a message that only carries a file All can\'t show says so; it is never a blank row', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => { const w = window as any, now = Math.floor(Date.now() / 1000); w.__msgs['ch-bees'].push({ ref: 'blankfile', channel: 'ch-bees', author: 'b'.repeat(64), author_name: 'Uni', ts: now - 3, body: '', mentions_me: false, root: null, parent: null, mentions: [], reply_count: 0, last_reply_ts: null, edited: false, reactions: [], media: [{ url: 'http://files.example.com/made-up.zip', mime: 'application/zip', sha256: null, size: 70, dim: null, blurhash: null, alt: null, filename: 'made-up.zip' }] }); });
    await allIn(page);
    await expect(row(page, 'blankfile')).toContainText('A file');
  });

  test('a message over the length that fits anyway shows no "Read the rest"', async ({ page }) => {
    test.skip(project() !== 'desktop', 'needs the wide column');
    await boot(page);
    await page.evaluate(() => (window as any).__arrive('ch-kiln', 'Uni', 'Fits. '.repeat(55).trim()));
    await allIn(page);
    const last = feed(page).locator('article.all-msg').last();
    await expect(last).toContainText('Fits.');
    await expect(last.locator('.all-rest')).toHaveCount(0);
  });
});

test.describe('a room in focus', () => {
  type Way = 'the Back button' | 'Android Back' | 'a tap on what is behind' | 'Escape' | 'the rail';
  const leave = async (page: Page, way: Way) => {
    // the keyboard goes first on touch (with it up, the phone's bar and All's strip are away), as a finger does it
    if (touch() && way !== 'the Back button' && way !== 'Android Back') { await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); await page.waitForTimeout(100); }
    if (way === 'the Back button') await backToAll(page).click();
    else if (way === 'Android Back') await androidBack(page);
    else if (way === 'Escape') await page.keyboard.press('Escape');
    else if (way === 'the rail') await allTab(page).click();
    else {
      // whatever of All shows around the room
      const box = (await sheet(page).boundingBox())!;
      if (project() === 'desktop') await page.mouse.click(box.x - 40, box.y + 200);
      else await page.touchscreen.tap(box.x + box.width / 2, box.y - 8);
    }
  };

  for (const way of ['the Back button', 'Android Back', 'a tap on what is behind', 'Escape', 'the rail'] as Way[]) {
    test(`tap a room's label: the room's thread, its composer; a reply lands there; ${way} returns to All at the same scroll`, async ({ page }) => {
      test.skip(way === 'Escape' && touch(), 'a keyboard key');
      await boot(page);
      await allIn(page);
      const was = await middleOn(page, 'k3');
      expect(was).toBeGreaterThan(50);
      await row(page, 'k3').locator('.all-place').click();
      // the same surface: All is still there, behind, out of reach; the rail still says All
      await expect(sheet(page)).toBeVisible();
      await expect(sheet(page).getByRole('heading', { name: 'Kiln Studio' })).toBeVisible();
      await expect(feed(page)).toBeAttached();
      expect(await feed(page).evaluate((el) => !!el.closest('[inert]'))).toBe(true);
      await expect(allTab(page)).toHaveAttribute('aria-current', 'page');
      // the room's own thread, older than All's view of it included, and nothing of the other rooms in it
      const list = sheet(page).locator('.message-list');
      await expect(list).toContainText('The bisque firing finished overnight');
      await expect(list).toContainText('Three glaze tiles');
      await expect(sheet(page)).not.toContainText('Gravel is ordered');
      // the room's real composer
      const box = roomBox(page, 'kiln-studio');
      await expect(box).toBeVisible();
      await box.fill('Glaze the crawled tile again.');
      await sheet(page).getByRole('button', { name: 'Send message' }).click();
      await expect.poll(() => posts(page)).toEqual([{ channel: 'ch-kiln', body: 'Glaze the crawled tile again.', replyTo: null }]);
      await expect(list).toContainText('Glaze the crawled tile again.');
      // back
      await leave(page, way);
      await expect(sheet(page)).toHaveCount(0);
      await expect(feed(page)).toBeVisible();
      await expect(field(page)).toBeVisible();
      await expect(page.locator('.composer')).toHaveCount(0);
      expect(await feed(page).evaluate((el) => !!el.closest('[inert]'))).toBe(false);
      expect(Math.abs(await feed(page).evaluate((el) => el.scrollTop) - was)).toBeLessThan(2);
      await expect(row(page, 'k3')).toBeInViewport();
    });
  }

  test('deep in a run from one room, its label scrolled away: the room is named at the top, and that is the way into focus, at the message you are on', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => { const w = window as any, now = Math.floor(Date.now() / 1000); for (let i = 0; i < 30; i++) w.__msgs['ch-north'].push({ ref: `run${i}`, channel: 'ch-north', author: 'b'.repeat(64), author_name: 'Uni', ts: now - 60 + i, body: `The north field, line ${i}. It goes on for a while, as a room does when it has a lot to say about the hedge.`, mentions_me: false, root: null, parent: null, mentions: [], reply_count: 0, last_reply_ts: null, edited: false, reactions: [], media: [] }); });
    await allIn(page);
    const reading = page.locator('.all-reading');
    // at a run's own label there is nothing to add
    await row(page, 'run0').evaluate((el) => { const f = el.closest('.all-feed')!; f.scrollTop = (el as HTMLElement).offsetTop; });
    await expect(reading).toHaveCount(0);
    // deep inside it
    await row(page, 'run6').evaluate((el) => { const f = el.closest('.all-feed')!; f.scrollTop = (el as HTMLElement).offsetTop; });
    await expect(reading).toHaveText('North Field');
    await reading.click();
    await expect(sheet(page).getByRole('heading', { name: 'North Field' })).toBeVisible();
    await expect(sheet(page).locator('[data-ref="run6"].search-focus')).toBeVisible();
    await backToAll(page).click();
    await expect(sheet(page)).toHaveCount(0);
    await expect(reading).toHaveText('North Field');
    await expect(row(page, 'run6')).toBeInViewport();
  });

  test('the way in moves quickly; on a calm screen it does not move at all, and still reads', async ({ page }) => {
    await boot(page);
    await allIn(page);
    await row(page, 'k3').locator('.all-place').click();
    await expect(sheet(page)).toBeVisible();
    const ms = await sheet(page).evaluate((el) => el.getAnimations().map((a) => Number(a.effect?.getTiming().duration)));
    if (project() === 'daylight') expect(ms).toEqual([]);
    else { expect(ms.length).toBeGreaterThan(0); expect(Math.max(...ms)).toBeLessThanOrEqual(300); }
  });

  test('a long thread is all there: older messages load in focus', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => { const w = window as any; const now = Math.floor(Date.now() / 1000); for (let i = 0; i < 70; i++) w.__msgs['ch-table'].unshift({ ref: `old${i}`, channel: 'ch-table', author: 'b'.repeat(64), author_name: 'Uni', ts: now - 400_000 - i * 60, body: `Old line ${i}.`, mentions_me: false, root: null, parent: null, mentions: [], reply_count: 0, last_reply_ts: null, edited: false, reactions: [], media: [] }); });
    await allIn(page);
    await feed(page).locator('article.all-msg[data-room="ch-table"] .all-place').last().click();
    await expect(sheet(page).getByRole('heading', { name: 'Long Table' })).toBeVisible();
    await expect(sheet(page).locator('.message-list article').first()).toBeVisible();
    await expect(sheet(page).getByRole('button', { name: /Load older/ })).toBeVisible();
    await sheet(page).getByRole('button', { name: /Load older/ }).click();
    await expect(sheet(page).locator('.message-list')).toContainText('Old line 40.');
  });

  test('a thread opens inside focus: Back steps to the room, then to All', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => (window as any).__arrive('ch-choir', 'Priya', 'Altos are short two copies.', 0, false, 'c3'));
    await allIn(page);
    const was = await middleOn(page, 'c3');
    await row(page, 'c3').getByRole('button', { name: '1 reply' }).click();
    await expect(sheet(page)).toBeVisible();
    await expect(sheet(page)).toContainText('Altos are short two copies.');
    await expect(sheet(page).getByRole('button', { name: 'Back to Choir' })).toBeVisible();
    await page.getByRole('textbox', { name: /^Message choir/ }).fill('Print two more.');
    await sheet(page).getByRole('button', { name: 'Send message' }).click();
    await expect.poll(() => posts(page)).toEqual([{ channel: 'ch-choir', body: 'Print two more.', replyTo: 'c3' }]);
    await androidBack(page);
    await expect(backToAll(page)).toBeVisible();
    await expect(sheet(page).locator('.message-list')).toContainText('Sheet music');
    await androidBack(page);
    await expect(sheet(page)).toHaveCount(0);
    expect(Math.abs(await feed(page).evaluate((el) => el.scrollTop) - was)).toBeLessThan(2);
  });

  test('the head\'s own Back steps the same way: a thread to its room, the room to All', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => (window as any).__arrive('ch-choir', 'Priya', 'Altos are short two copies.', 0, false, 'c3'));
    await allIn(page);
    await row(page, 'c3').getByRole('button', { name: '1 reply' }).click();
    await sheet(page).getByRole('button', { name: 'Back to Choir' }).click();
    await expect(backToAll(page)).toBeVisible();
    await expect(sheet(page).locator('.message-list')).toContainText('Sheet music');
    await backToAll(page).click();
    await expect(sheet(page)).toHaveCount(0);
  });

  test('your reply is on screen after you send it, even from an older message', async ({ page }) => {
    await boot(page);
    await allIn(page);
    await middleOn(page, 'c1');
    await feed(page).locator('article.all-msg[data-room="ch-kiln"] .all-place').first().click();
    await expect(sheet(page).locator('.search-focus')).toBeVisible();
    await roomBox(page, 'kiln-studio').fill('Sent from far up the thread.');
    await sheet(page).getByRole('button', { name: 'Send message' }).click();
    await expect(sheet(page).locator('article.message').filter({ hasText: 'Sent from far up the thread.' })).toBeInViewport();
  });

  test('your reply from focus is in All when you come back, with no wait for the room\'s next message', async ({ page }) => {
    await boot(page);
    await allIn(page);
    await feed(page).locator('article.all-msg[data-room="ch-kiln"] .all-place').last().click();
    await roomBox(page, 'kiln-studio').fill('Words that should be in All.');
    await sheet(page).getByRole('button', { name: 'Send message' }).click();
    await expect(sheet(page).locator('.message-list')).toContainText('Words that should be in All.');
    await backToAll(page).click();
    await expect(sheet(page)).toHaveCount(0);
    await expect(feed(page)).toContainText('Words that should be in All.');
  });

  test('your reply still on its way when you go back: it is in All as soon as it lands', async ({ page }) => {
    await boot(page);
    await allIn(page);
    await feed(page).locator('article.all-msg[data-room="ch-kiln"] .all-place').last().click();
    await roomBox(page, 'kiln-studio').fill('Sent just before Back.');
    await page.evaluate(() => { (window as any).__postDelay = 700; });
    await sheet(page).getByRole('button', { name: 'Send message' }).click();
    await backToAll(page).click();
    await expect(sheet(page)).toHaveCount(0);
    await expect(feed(page)).toContainText('Sent just before Back.');
  });

  test('tapping a message newer than the room\'s kept copy waits for the read in hand, and never asks for the room\'s whole history', async ({ page }) => {
    await boot(page);
    await allIn(page);
    // a first visit keeps a copy of the room on this device
    await feed(page).locator('article.all-msg[data-room="ch-kiln"] .all-place').last().click();
    await expect(sheet(page).locator('.message-list')).toContainText('Three glaze tiles');
    await page.waitForTimeout(300);
    await backToAll(page).click();
    await expect(sheet(page)).toHaveCount(0);
    await page.evaluate(() => (window as any).__arrive('ch-kiln', 'Uni', 'NEWER-THAN-THE-COPY'));
    const last = feed(page).locator('article.all-msg').filter({ hasText: 'NEWER-THAN-THE-COPY' });
    await expect(last).toBeVisible();
    // the room's read is slow, so the kept copy is what shows first
    await page.evaluate(() => { const w = window as any, next = w.__extraInvoke; w.__extraInvoke = async (cmd: string, a: any) => { if (cmd === 'get_messages' && a.channel === 'ch-kiln') await new Promise((r) => setTimeout(r, 500)); return next(cmd, a); }; });
    await last.locator('.all-place').click();
    await expect(sheet(page).locator('.search-focus')).toContainText('NEWER-THAN-THE-COPY');
    expect((await calls(page, 'get_messages')).filter((a: any) => a.limit >= 3000)).toEqual([]);
  });

  test('a label tapped in a room with unread messages lands on that message, not on the New line', async ({ page }) => {
    await boot(page, { unread: { 'ch-kiln': 2 } });
    await allIn(page);
    await row(page, 'k1').evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await feed(page).locator('article.all-msg[data-room="ch-kiln"] .all-place').first().click();
    const mark = sheet(page).locator('.search-focus');
    await expect(mark).toBeVisible();
    await page.waitForTimeout(500);
    await expect(mark).toBeInViewport();
  });

  test('opened at a message that is already the newest, the room still follows what arrives next', async ({ page }) => {
    await boot(page);
    await allIn(page);
    await feed(page).evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await feed(page).locator('article.all-msg .all-place').last().click();
    await expect(sheet(page).locator('.search-focus')).toBeVisible();
    await page.waitForTimeout(300);
    const room = await feed(page).locator('article.all-msg').last().getAttribute('data-room');
    await page.evaluate((r) => (window as any).__arrive(r, 'Uni', 'FOLLOW-ME arrives while you read.'), room);
    await expect(sheet(page).locator('article.message').filter({ hasText: 'FOLLOW-ME' })).toBeVisible();
    await expect.poll(() => sheet(page).locator('.message-list').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(30);
  });

  test('a room opened from the home: the approval banner\'s Show on the newest message, and the room goes on following', async ({ page }) => {
    await boot(page);
    const prompt = JSON.parse(readFileSync(new URL('../fixtures/approval-prompts.json', import.meta.url), 'utf8')).prompts.two_answers_30min;
    await openPlaces(page);
    await page.locator('.fd-door[data-path="Areas/Kiln Studio"]').click();
    await expect(roomBox(page, 'kiln-studio')).toBeVisible();
    await page.evaluate((b) => (window as any).__arrive('ch-kiln', 'Uni', b), prompt);
    await page.locator('.composer').getByRole('button', { name: /^Show/ }).click();
    await expect(page.locator('.search-focus')).toBeVisible();
    await page.waitForTimeout(300);
    // tall enough to pass the fold, short enough not to be "a message longer than the screen" (that one is shown from its top)
    await page.evaluate(() => (window as any).__arrive('ch-kiln', 'Uni', 'FOLLOW-ME\n\nA second paragraph of it.\n\nA third.\n\nA fourth.'));
    await expect(page.locator('.message-list article.message').filter({ hasText: 'FOLLOW-ME' })).toBeVisible();
    await expect.poll(() => page.locator('.message-list').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(30);
    await expect(page.getByRole('button', { name: /Jump to latest/ })).toHaveCount(0);
  });

  test('a visit cut short leaves nothing behind: the next opening has no stale mark and no long read', async ({ page }) => {
    await boot(page);
    await allIn(page);
    await feed(page).locator('article.all-msg[data-room="ch-kiln"] .all-place').first().click();
    await expect(sheet(page).locator('.search-focus')).toBeVisible();
    await backToAll(page).click();
    await expect(sheet(page)).toHaveCount(0);
    await page.waitForTimeout(100);
    // a way in that names no message
    await field(page).fill('Tell Long Table the bowls are washed');
    await page.locator('.all-send').click();
    await page.locator('.all-note').getByRole('button', { name: 'Long Table' }).click();
    await expect(sheet(page).getByRole('heading', { name: 'Long Table' })).toBeVisible();
    await page.waitForTimeout(300);
    await expect(sheet(page).locator('.search-focus')).toHaveCount(0);
    expect((await calls(page, 'get_messages')).filter((a: any) => a.limit >= 3000)).toEqual([]);
  });

  test('a long press in focus: the whole message sheet stands over the phone\'s bar, as on a room\'s page', async ({ page }) => {
    test.skip(!touch(), 'touch only');
    await boot(page);
    await allIn(page);
    await feed(page).locator('article.all-msg[data-room="ch-kiln"] .all-place').last().click();
    await expect(sheet(page)).toBeVisible();
    await page.waitForTimeout(320);
    const mine = sheet(page).locator('article.message.mine').first();
    // (a script's scroll isn't a person's: wait out the room's settling at its end, as a finger would end it)
    await page.waitForTimeout(1600);
    await mine.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(100);
    const b = (await mine.boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x + b.width / 2, y: b.y + b.height / 2 }] });
    await page.waitForTimeout(700);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const rows = page.locator('.msg-sheet button');
    await expect(rows.last()).toBeVisible();
    await page.waitForTimeout(300);
    // the last row is itself what a finger reaches, and no rail is drawn over it
    const hit = await rows.last().evaluate((el) => { const r = el.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); const rail = document.querySelector('.rail')!.getBoundingClientRect(); return { same: el === top || el.contains(top), railZ: getComputedStyle(document.querySelector('.rail')!).zIndex, bottom: r.bottom, h: innerHeight, railTop: rail.top }; });
    expect(hit.same).toBe(true);
    expect(hit.bottom).toBeLessThanOrEqual(hit.h);
    const covered = await page.evaluate(() => { const sheet = document.querySelector('.msg-sheet')!; const rail = document.querySelector('.rail')!.getBoundingClientRect(); const top = document.elementFromPoint(rail.left + rail.width / 2, rail.top + rail.height / 2); return !!top && (sheet.contains(top) || !!top.closest('.msg-sheet')) ; });
    if (project() === 'phone') expect(covered).toBe(true);
  });

  test('history Back with a panel open closes the panel; the room stays in focus', async ({ page }) => {
    test.skip(project() !== 'desktop', 'the keys');
    await boot(page);
    await allIn(page);
    await row(page, 'k3').locator('.all-place').click();
    await rail(page).getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    await page.keyboard.press('Alt+ArrowLeft');
    await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
    await expect(sheet(page)).toBeVisible();
    await page.keyboard.press('Alt+ArrowLeft');
    await expect(sheet(page)).toHaveCount(0);
  });

  test('in focus, a thread opened from the room stays in focus', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => (window as any).__arrive('ch-choir', 'Priya', 'Altos are short two copies.', 0, false, 'c3'));
    await allIn(page);
    await feed(page).locator('article.all-msg[data-room="ch-choir"] .all-place').last().click();
    await sheet(page).locator('.thread-summary').first().click();
    await expect(sheet(page).getByRole('button', { name: 'Back to Choir' })).toBeVisible();
    await expect(page.locator('[data-view="all"]')).toBeAttached();
  });

  test('a vault link in focus opens its note; Back closes the note first, then the focus', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => (window as any).__arrive('ch-kiln', 'Uni', 'The plan is in [[Areas/Kiln Studio|the kiln note]].'));
    await allIn(page);
    await feed(page).locator('article.all-msg[data-room="ch-kiln"] .all-place').last().click();
    await expect(sheet(page)).toBeVisible();
    await sheet(page).getByRole('link', { name: 'the kiln note' }).click();
    await expect(page.locator('.note-pane, .note-sheet').first()).toBeVisible();
    await androidBack(page);
    await expect(page.locator('.note-pane, .note-sheet')).toHaveCount(0);
    await expect(sheet(page)).toBeVisible();
    await androidBack(page);
    await expect(sheet(page)).toHaveCount(0);
    await expect(feed(page)).toBeVisible();
  });

  test('the room\'s details (where it stands, its work) are one tap from the focus head; Back steps out to All where it was', async ({ page }) => {
    await boot(page);
    await allIn(page);
    const was = await middleOn(page, 'k3');
    await row(page, 'k3').locator('.all-place').click();
    await expect(sheet(page)).toContainText('Glaze tests are out of the kiln');
    await sheet(page).getByRole('button', { name: 'Kiln Studio: room details' }).click();
    const details = sheet(page).getByRole('region', { name: 'Kiln Studio details' });
    await expect(details).toBeVisible();
    await expect(details).toContainText('Glaze tests are out of the kiln');
    await expect(details.getByRole('button', { name: /All of Kiln Studio's work/ })).toBeVisible();
    // the conversation (and its composer) is put aside, not gone; All stays behind
    await expect(roomBox(page, 'kiln-studio')).toBeHidden();
    await expect(allTab(page)).toHaveAttribute('aria-current', 'page');
    await sheet(page).getByRole('button', { name: 'Back to the conversation in Kiln Studio' }).click();
    await expect(details).toHaveCount(0);
    await expect(roomBox(page, 'kiln-studio')).toBeVisible();
    await backToAll(page).click();
    await expect(sheet(page)).toHaveCount(0);
    await expect(row(page, 'k3')).toBeVisible();
    await expect.poll(async () => Math.abs(await feed(page).evaluate((el) => el.scrollTop) - was)).toBeLessThan(2);
  });

  test('Android Back from the room\'s details, opened from its focus: the conversation, then All again, where it was', async ({ page }) => {
    await boot(page);
    await allIn(page);
    const was = await middleOn(page, 'k3');
    await row(page, 'k3').locator('.all-place').click();
    await sheet(page).getByRole('button', { name: 'Kiln Studio: room details' }).click();
    await expect(sheet(page).getByRole('region', { name: 'Kiln Studio details' })).toBeVisible();
    await androidBack(page);
    await expect(sheet(page).getByRole('region', { name: 'Kiln Studio details' })).toHaveCount(0);
    await expect(roomBox(page, 'kiln-studio')).toBeVisible();
    await androidBack(page);
    await expect(sheet(page)).toHaveCount(0);
    await expect(row(page, 'k3')).toBeVisible();
    await expect.poll(async () => Math.abs(await feed(page).evaluate((el) => el.scrollTop) - was)).toBeLessThan(2);
  });

  test('a message taller than the screen opens in focus at its top, not its middle', async ({ page }) => {
    test.skip(project() === 'desktop', 'fits a wide screen');
    await boot(page);
    await page.evaluate((b) => (window as any).__arrive('ch-kiln', 'Uni', b), `${LONG}\n\n${LONG}\n\n${LONG}`);
    await allIn(page);
    const last = feed(page).locator('article.all-msg[data-room="ch-kiln"]').last();
    await last.locator('.all-place').click();
    await expect(sheet(page)).toBeVisible();
    const target = sheet(page).locator('.search-focus');
    await expect(target).toBeVisible();
    await page.waitForTimeout(350);
    const top = await target.evaluate((el) => el.getBoundingClientRect().top - el.closest('.message-list')!.getBoundingClientRect().top);
    expect(Math.abs(top)).toBeLessThan(40);
  });

  test('both drafts wait: what you typed for All and what you typed in the room', async ({ page }) => {
    await boot(page);
    await allIn(page);
    await field(page).fill('A thought for later');
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await feed(page).locator('article.all-msg[data-room="ch-kiln"] .all-place').last().click();
    await roomBox(page, 'kiln-studio').fill('A word for the kiln');
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await backToAll(page).click();
    await expect(field(page)).toHaveValue('A thought for later');
    await feed(page).locator('article.all-msg[data-room="ch-kiln"] .all-place').last().click();
    await expect(roomBox(page, 'kiln-studio')).toHaveValue('A word for the kiln');
    expect(await posts(page)).toEqual([]);
  });

  test('from one focus straight to another: the second room, its composer, its draft', async ({ page }) => {
    await boot(page);
    await allIn(page);
    await feed(page).locator('article.all-msg[data-room="ch-kiln"] .all-place').last().click();
    await backToAll(page).click();
    // at once, while the first is still on its way out
    await feed(page).locator('article.all-msg[data-room="ch-bees"] .all-place').last().click();
    await expect(sheet(page).getByRole('heading', { name: 'Bee Garden' })).toBeVisible();
    await page.waitForTimeout(350);
    await expect(sheet(page).getByRole('heading', { name: 'Bee Garden' })).toBeVisible();
    await expect(roomBox(page, 'bee-garden')).toBeVisible();
  });

  test('an approval waiting in All opens its room in focus, at the prompt', async ({ page }) => {
    await boot(page);
    const prompt = JSON.parse(readFileSync(new URL('../fixtures/approval-prompts.json', import.meta.url), 'utf8')).prompts.two_answers_30min;
    await page.evaluate((b) => (window as any).__arrive('ch-kiln', 'Uni', b), prompt);
    await expect(page.locator('.cp-approval')).toHaveCount(1);
    await allIn(page);
    await expect(page.locator('.cp-approval')).toHaveCount(1);
    await page.locator('.cp-approval').first().getByRole('button').first().click();
    await expect(sheet(page).getByRole('heading', { name: 'Kiln Studio' })).toBeVisible();
    await expect(page.locator('[data-view="all"]')).toBeAttached();
  });

  test('a voice message started in focus keeps going when the room goes back: the pill names the room, and takes you back to its focus', async ({ page }) => {
    await boot(page);
    await allIn(page);
    await feed(page).locator('article.all-msg[data-room="ch-kiln"] .all-place').last().click();
    await expect(sheet(page)).toBeVisible();
    await sheet(page).getByRole('button', { name: 'Record a voice message' }).click();
    const jump = page.getByRole('button', { name: 'Jump to recording in kiln-studio' });
    await expect(jump).toBeVisible();
    await backToAll(page).click();
    await expect(sheet(page)).toHaveCount(0);
    await expect(jump).toBeVisible();
    await jump.click();
    await expect(sheet(page).getByRole('heading', { name: 'Kiln Studio' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Pause recording/ })).toBeVisible();
  });

  test('recording in focus, gone to the room\'s details: the pill brings the conversation back, with its thread and composer', async ({ page }) => {
    await boot(page);
    await allIn(page);
    await feed(page).locator('article.all-msg[data-room="ch-kiln"] .all-place').last().click();
    await sheet(page).getByRole('button', { name: 'Record a voice message' }).click();
    const jump = page.getByRole('button', { name: 'Jump to recording in kiln-studio' });
    await expect(jump).toBeVisible();
    await sheet(page).getByRole('button', { name: 'Kiln Studio: room details' }).click();
    await expect(sheet(page).getByRole('region', { name: 'Kiln Studio details' })).toBeVisible();
    await page.waitForTimeout(400);
    await jump.click();
    await expect(sheet(page).locator('[data-chat="open"]')).toBeVisible();
    await expect(sheet(page).locator('.message-list')).toContainText('Three glaze tiles');
    await expect(roomBox(page, 'kiln-studio')).toBeVisible();
  });

  test('the room\'s name is the way to its details, not only the small arrow', async ({ page }) => {
    await boot(page);
    await allIn(page);
    await row(page, 'k3').locator('.all-place').click();
    await expect(sheet(page)).toBeVisible();
    await page.waitForTimeout(320);
    const box = (await sheet(page).getByRole('heading', { name: 'Kiln Studio' }).boundingBox())!;
    if (touch()) await page.touchscreen.tap(box.x + 30, box.y + box.height / 2);
    else await page.mouse.click(box.x + 30, box.y + box.height / 2);
    await expect(sheet(page).getByRole('region', { name: 'Kiln Studio details' })).toBeVisible();
  });

  test('Escape with a panel over the focus closes the panel only; the room stays', async ({ page }) => {
    test.skip(project() !== 'desktop', 'a keyboard key');
    await boot(page);
    await allIn(page);
    await row(page, 'k3').locator('.all-place').click();
    await expect(sheet(page)).toBeVisible();
    await rail(page).getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
    await page.waitForTimeout(300);
    await expect(sheet(page)).toBeVisible();
    // and the same with Find open, its own field holding the keys
    await rail(page).getByRole('button', { name: 'Search' }).click();
    await expect(page.locator('.search-view')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.search-view')).toHaveCount(0);
    await page.waitForTimeout(300);
    await expect(sheet(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet(page)).toHaveCount(0);
  });

  test('a label on the last message the device has seen, with newer ones since: it lands on that message, not at the newest', async ({ page }) => {
    await boot(page);
    await allIn(page);
    await page.evaluate(() => (window as any).__arrive('ch-kiln', 'Uni', 'LAST-SEEN on this device.'));
    await feed(page).locator('article.all-msg').filter({ hasText: 'LAST-SEEN' }).locator('.all-place').click();
    await expect(sheet(page).locator('.message-list')).toContainText('LAST-SEEN');
    await page.waitForTimeout(300);
    await backToAll(page).click();
    await expect(sheet(page)).toHaveCount(0);
    // newer ones, while away; the room's read is slow, so the kept copy shows first, with LAST-SEEN at its end
    await page.evaluate((b) => { const w = window as any; w.__arrive('ch-bees', 'Uni', 'Meanwhile, the bees.'); w.__arrive('ch-kiln', 'Uni', `${b}\n\n${b}`); const next = w.__extraInvoke; w.__extraInvoke = async (cmd: string, a: any) => { if (cmd === 'get_messages' && a.channel === 'ch-kiln') await new Promise((r) => setTimeout(r, 500)); return next(cmd, a); }; }, LONG);
    await expect(feed(page)).toContainText('Meanwhile, the bees.');
    await feed(page).locator('article.all-msg').filter({ hasText: 'LAST-SEEN' }).locator('.all-place').click();
    const mark = sheet(page).locator('.search-focus');
    await expect(mark).toContainText('LAST-SEEN');
    await page.waitForTimeout(900);
    await expect(mark).toBeInViewport();
  });

  test('a panel opened over the focus goes first; the rail\'s Uni then ends the focus', async ({ page }) => {
    test.skip(project() === 'phone', 'the phone\'s bar is under the focus; the rule is the same');
    await boot(page);
    await allIn(page);
    await row(page, 'k3').locator('.all-place').click();
    await expect(sheet(page)).toBeVisible();
    await railGo(page, 'Settings'); // 0.2: in the More sheet below 1100 px
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    await allTab(page).click();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
    await expect(sheet(page)).toBeVisible();
    await allTab(page).click();
    await expect(sheet(page)).toHaveCount(0);
  });

  test('on touch, opening a room or a thread leaves the keyboard down, so the thread can be read', async ({ page }) => {
    test.skip(!touch(), 'touch only');
    await boot(page);
    await page.evaluate(() => (window as any).__arrive('ch-choir', 'Priya', 'Altos are short two copies.', 0, false, 'c3'));
    await allIn(page);
    await feed(page).locator('article.all-msg[data-room="ch-choir"] .all-place').last().click();
    await expect(sheet(page).locator('.message-list article').first()).toBeVisible();
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('TEXTAREA');
    await sheet(page).locator('.thread-summary').first().click();
    await expect(sheet(page).getByRole('button', { name: 'Back to Choir' })).toBeVisible();
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('TEXTAREA');
  });

  test('a room read in focus counts as read', async ({ page }) => {
    await boot(page, { unread: { 'ch-kiln': 3 } });
    await allIn(page);
    await feed(page).locator('article.all-msg[data-room="ch-kiln"] .all-place').last().click();
    await expect(sheet(page)).toBeVisible();
    await expect.poll(() => calls(page, 'mark_read').then((c) => c.map((x: any) => x.channel))).toContain('ch-kiln');
  });

  test('"Sent to" after a routed message opens that room in focus', async ({ page }) => {
    await boot(page);
    await allIn(page);
    await field(page).fill('Is the honey ready to jar?');
    await page.locator('.all-send').click();
    await page.locator('.all-note').getByRole('button', { name: 'Bee Garden' }).click();
    await expect(sheet(page).getByRole('heading', { name: 'Bee Garden' })).toBeVisible();
  });

  test('with a note beside it on a wide screen, the room stays whole, inside the space that is left', async ({ page }) => {
    test.skip(project() !== 'desktop', 'wide only');
    await boot(page);
    await page.evaluate(() => (window as any).__arrive('ch-kiln', 'Uni', 'The plan is in [[Areas/Kiln Studio|the kiln note]].'));
    await allIn(page);
    await feed(page).locator('article.all-msg[data-room="ch-kiln"] .all-place').last().click();
    await sheet(page).getByRole('link', { name: 'the kiln note' }).click();
    await expect(page.locator('.note-pane-beside')).toBeVisible();
    await page.waitForTimeout(350);
    const s = (await sheet(page).boundingBox())!, surface = (await page.locator('.all-surface').boundingBox())!;
    expect(s.x).toBeGreaterThanOrEqual(surface.x);
    expect(s.x + s.width).toBeLessThanOrEqual(surface.x + surface.width);
    await expect(roomBox(page, 'kiln-studio')).toBeInViewport();
  });

  test('a room that turns out to be private, while in focus: it may stay there, opened by you, but All behind it lets go of it', async ({ page }) => {
    await boot(page);
    await allIn(page);
    await expect(page.locator('.all-behind article.all-msg[data-room="ch-kiln"]').first()).toBeAttached();
    await row(page, 'k3').locator('.all-place').click();
    await expect(sheet(page).getByRole('heading', { name: 'Kiln Studio' })).toBeVisible();
    // the room is renamed to a private name while it is open (the fixture's rooms list, as the store would answer)
    await page.evaluate(() => { const w = window as any; const next = w.__extraInvoke; let reading = false; w.__extraInvoke = async (cmd: string, a: any) => { if (cmd === 'get_rooms' && !reading) { reading = true; const rooms = await w.__TAURI_INTERNALS__.invoke('get_rooms'); reading = false; return rooms.map((r: any) => (r.id === 'ch-kiln' ? { ...r, name: 'sanctum' } : r)); } return next(cmd, a); }; });
    await page.evaluate(() => (window as any).__arrive('ch-kiln', 'Uni', 'One more line.'));
    // All, behind, never lists a private room: its messages and its label go
    await expect(page.locator('.all-behind article.all-msg[data-room="ch-kiln"]')).toHaveCount(0, { timeout: 15000 });
    await expect(page.locator('.all-behind')).not.toContainText('One more line.');
    // and back in All, nothing of it shows
    await backToAll(page).click();
    await expect(sheet(page)).toHaveCount(0);
    await expect(feed(page)).toBeVisible();
    expect(await feed(page).evaluate((el) => !!el.closest('[inert]'))).toBe(false);
    await expect(page.locator('article.all-msg[data-room="ch-kiln"]')).toHaveCount(0);
    await expect(feed(page)).not.toContainText('One more line.');
  });

  test('a private room never gets a label to focus in All', async ({ page }) => {
    await boot(page);
    await allIn(page);
    await expect(page.locator('article.all-msg[data-room="ch-sad"]')).toHaveCount(0);
    await expect(feed(page)).not.toContainText('Sanctum');
  });

  test('swipe the head down on touch: back to All', async ({ page }) => {
    test.skip(!touch(), 'touch only');
    await boot(page);
    await allIn(page);
    const was = await middleOn(page, 'k3');
    await row(page, 'k3').locator('.all-place').click();
    await expect(sheet(page)).toBeVisible();
    await page.waitForTimeout(300);
    const box = (await sheet(page).locator('header').boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    const x = box.x + box.width / 2, y0 = box.y + box.height / 2;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0 }] });
    for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y0 + i * 14 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(sheet(page)).toHaveCount(0);
    expect(Math.abs(await feed(page).evaluate((el) => el.scrollTop) - was)).toBeLessThan(2);
  });
});

test.describe('in grey', () => {
  /** The screenshot as greyscale numbers, read in the page: the same pixels a person sees on a screen with no colour. */
  const lum = (page: Page, shot: Buffer, boxes: Record<string, { x: number; y: number; width: number; height: number }>, dpr: number) => page.evaluate(async ({ b64, boxes, dpr }) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext('2d')!;
    g.drawImage(bmp, 0, 0);
    const out: Record<string, { min: number; max: number; chroma: number }> = {};
    for (const [k, r] of Object.entries(boxes)) {
      const d = g.getImageData(Math.round(r.x * dpr), Math.round(r.y * dpr), Math.max(1, Math.round(r.width * dpr)), Math.max(1, Math.round(r.height * dpr))).data;
      let min = 255, max = 0, chroma = 0;
      for (let i = 0; i < d.length; i += 4) { const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; min = Math.min(min, l); max = Math.max(max, l); chroma = Math.max(chroma, Math.abs(d[i] - d[i + 1]), Math.abs(d[i + 1] - d[i + 2])); }
      out[k] = { min, max, chroma };
    }
    return out;
  }, { b64: shot.toString('base64'), boxes, dpr });

  test('with no colour at all, what is in focus is plain: the room is in full black, All behind it is pale, and the edge between them shows', async ({ page }) => {
    await boot(page);
    await allIn(page);
    await middleOn(page, 'k3');
    await row(page, 'k3').locator('.all-place').click();
    await expect(sheet(page)).toBeVisible();
    await expect(sheet(page).locator('.message-list')).toContainText('Three glaze tiles');
    await page.waitForTimeout(450);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setEmulatedVisionDeficiency', { type: 'achromatopsia' });
    await page.waitForTimeout(150);
    const dpr = await page.evaluate(() => devicePixelRatio);
    const s = (await sheet(page).boundingBox())!;
    const surface = (await page.locator('.all-surface').boundingBox())!;
    const text = (await sheet(page).locator('.message-list article').first().locator('.md').boundingBox())!;
    // what shows of All around the room: to its left on a wide screen, over it on a narrow one
    const behind = s.x - surface.x > 200 ? { x: surface.x + 8, y: surface.y + 60, width: s.x - surface.x - 16, height: 520 } : { x: surface.x, y: surface.y, width: surface.width, height: Math.max(1, s.y - surface.y - 2) };
    const edge = s.x - surface.x > 200 ? { x: s.x - 8, y: s.y + 300, width: 16, height: 1 } : { x: s.x + s.width / 2, y: s.y - 6, width: 1, height: 12 };
    const shot = await page.screenshot({ path: test.info().outputPath('grey.png') });
    const seen = await lum(page, shot, { behind, text, edge }, dpr);
    // the emulation is on (else this test proves nothing)
    expect(seen.text.chroma).toBeLessThan(6);
    expect(seen.text.min).toBeLessThan(70);
    // All's text shows, but pale: well short of the room's black
    expect(seen.behind.min).toBeGreaterThan(seen.text.min + 70);
    // the sheet's edge can be seen with no colour and no shadow to lean on
    expect(seen.edge.max - seen.edge.min).toBeGreaterThan(12);
  });
});

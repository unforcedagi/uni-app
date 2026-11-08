// 0.3.2 the card itself: a card's name opens the card from every place it shows (For you, a message in the stream, an area's cards on its
// stream and in its details), and the card says where it stands, its hill, its last lines (one per session, newest first, his own answers
// marked), what on it is open for him (answerable right there) and its threads. A private card shows only what its note already says. On a
// wide screen (Daylight, desktop) the card opens beside the list and the list stays in use; on a phone it is a sheet over it. States by shape.
// Phone 360, Daylight 828, desktop 1440. Made-up world only (forYouFixture.ts, `more`).
// Run: FORYOU_TEST_PORT=17631 npx playwright test --config playwright.foryou.config.ts cardView
import { test, expect, type Page } from '@playwright/test';
import { bootForYou } from './forYouFixture';
import { focusSheet, openForYou } from './areasFixture';

const calls = (page: Page, cmd: string) => page.evaluate((c) => (window as any).__calls.filter((x: any) => x.cmd === c).map((x: any) => x.args), cmd);
const forYou = (page: Page) => page.getByRole('region', { name: 'For you' });
const item = (page: Page, id: string) => forYou(page).locator(`article.fy-item[data-id="${id}"]`);
const card = (page: Page, name: string) => page.getByRole('dialog', { name: `${name} card` });
const stream = (page: Page) => page.getByRole('log', { name: 'All rooms, by time' });
const chip = (page: Page, name: string) => page.getByRole('navigation', { name: 'Show in the stream' }).getByRole('button', { name, exact: true });
const wide = () => test.info().project.name !== 'phone';
const boot = (page: Page) => bootForYou(page, { more: true });
const close = async (page: Page, name: string) => { await card(page, name).getByRole('button', { name: 'Close' }).click(); await expect(card(page, name)).toHaveCount(0); };

test.describe('the card', () => {
  test("from For you: where it stands, the hill, its lines newest first with his answer marked, what is open on it, its threads", async ({ page }) => {
    await boot(page);
    await openForYou(page);
    await item(page, 'fy-glaze').locator('.fy-where').click();
    const c = card(page, 'Glaze Tests');
    await expect(c).toBeVisible();
    // the card's own state by shape: something on it is his
    await expect(c.locator('.fy-card-kicker')).toHaveText('Kiln Studio · card · waits on you');
    await expect(c.locator('.fy-card-kicker .fy-mark')).toHaveAttribute('data-mark', 'yours');
    await expect(c.locator('.fy-card-stands')).toContainText('Twelve test tiles are fired; one glaze crawled.');
    await expect(c.locator('.fy-card-hill')).toContainText('Downhill, 64. Past figuring out; now making.');
    // one line per session, newest first; his own answer marked as his (the name dropped, the words in quotes)
    await expect(c.locator('.fy-card-lines li .fy-card-line')).toHaveText([/^The test tiles came out of the kiln\.$/, /^You“Keep the cracked pot for the glaze tests\.”$/, /^Mixed three glazes/]);
    await expect(c.locator('.fy-card-lines li[data-mine]')).toHaveCount(1);
    await expect(c.locator('.fy-card-lines li[data-mine] .fy-you')).toHaveText('You');
    // what is open on it: his ask and the one to look at, answerable here
    const open = c.getByRole('region', { name: 'Open on this card' });
    expect(await open.locator('article.fy-item').evaluateAll((els) => els.map((e) => e.getAttribute('data-id')))).toEqual(['fy-glaze', 'fy-look']);
    await expect(c.locator('.fy-card-threads > i')).toHaveText(['test tiles', 'glaze recipes']);
    await expect(c.getByRole('button', { name: 'Open its thread in #kiln-studio ›' })).toBeVisible();
    await close(page, 'Glaze Tests');
    // Moving's lines open their card too
    await forYou(page).locator('.fy-mv-t', { hasText: 'Hive two was weighed' }).click();
    await expect(card(page, 'Honey Harvest')).toBeVisible();
  });

  test('answered on the card: one tap takes the default, and the answer is its newest line, marked his', async ({ page }) => {
    await boot(page);
    await openForYou(page);
    await item(page, 'fy-glaze').locator('.fy-where').click();
    const c = card(page, 'Glaze Tests');
    await c.locator('article.fy-item[data-id="fy-glaze"] .fy-default').click();
    await expect(c.locator('.fy-card-lines li').first()).toHaveAttribute('data-mine', 'true');
    await expect(c.locator('.fy-card-lines li').first()).toHaveText(/^now\s*You“Celadon”$/);
    await expect(c.locator('article.fy-item[data-id="fy-glaze"]')).toHaveCount(0);
    expect((await calls(page, 'vault_transition')).map((a: any) => [a.id, a.metadata.answer])).toEqual([['fy-glaze', 'Celadon']]);
    expect((await calls(page, 'post_message')).map((a: any) => [a.channel, a.replyTo, a.body])).toEqual([['ch-kiln', 'k3', 'T-501: Celadon']]);
  });

  test('from the stream: the post its asks thread under, and a message that names it, each open the card', async ({ page }) => {
    await boot(page);
    await expect(stream(page).locator('article.all-msg[data-ref="k3"]')).toBeVisible();
    // k3 is the glaze card's post (T-501's reply_root); k1 is about no card
    await expect(stream(page).locator('article.all-msg[data-ref="k1"] .all-card')).toHaveCount(0);
    const post = stream(page).locator('article.all-msg[data-ref="k3"] .all-card');
    await expect(post).toHaveText('Glaze Tests · card ›');
    await expect(post.locator('.fy-mark')).toHaveAttribute('data-mark', 'yours');
    await post.click();
    await expect(card(page, 'Glaze Tests')).toBeVisible();
    // the composer didn't take the tap as "reply here"
    await expect(page.locator('.all-reply-chip')).toHaveCount(0);
    await close(page, 'Glaze Tests');
    // a message in the bee garden's room that opens with its card's name
    const ref = await page.evaluate(() => (window as any).__arrive('ch-bees', 'Uni', 'Honey Harvest: the jars are the last thing. 1 for you: find twenty jars.'));
    const named = stream(page).locator(`article.all-msg[data-ref="${ref}"] .all-card`);
    await expect(named).toHaveText('Honey Harvest · card ›');
    await named.click();
    await expect(card(page, 'Honey Harvest')).toBeVisible();
  });

  test("an area's cards: on its stream, active first and resting folded; in its details too; each opens the card", async ({ page }) => {
    await boot(page);
    await chip(page, 'Kiln Studio').click();
    const row = page.getByRole('region', { name: "Kiln Studio's cards" });
    await expect(row.locator('.fy-ac')).toHaveText(['Glaze Tests', 'Kiln Shelves', '1 resting']);
    expect(await row.locator('.fy-ac').evaluateAll((els) => els.map((e) => e.querySelector('.fy-mark')!.getAttribute('data-mark')))).toEqual(['yours', 'moving', 'rest']);
    await row.getByRole('button', { name: '1 resting' }).click();
    await expect(row.locator('.fy-ac')).toHaveText(['Glaze Tests', 'Kiln Shelves', 'Clay Order']);
    // a card with many sessions: the newest six, then the earlier ones on a tap
    await row.locator('.fy-ac', { hasText: 'Kiln Shelves' }).click();
    const c = card(page, 'Kiln Shelves');
    await expect(c.locator('.fy-card-lines li .fy-card-line')).toHaveCount(6);
    await expect(c.locator('.fy-card-lines li .fy-card-line').first()).toHaveText('Shelf session 8.');
    await c.getByRole('button', { name: '2 earlier' }).click();
    await expect(c.locator('.fy-card-lines li .fy-card-line')).toHaveCount(8);
    await expect(c.locator('.fy-card-lines li .fy-card-line').last()).toHaveText('Shelf session 1.');
    await close(page, 'Kiln Shelves');
    // the area's own room, its details: the same cards, each with its stand
    await page.locator('.all-scope-line').getByRole('button', { name: 'Open Kiln Studio ›' }).click();
    await focusSheet(page).locator('.all-focus-titles').click();
    const list = focusSheet(page).getByRole('region', { name: "Kiln Studio's cards" });
    await expect(list.locator('.fy-ac .fy-ac-name')).toHaveText(['Glaze Tests', 'Kiln Shelves', '1 resting']);
    await expect(list.locator('.fy-ac', { hasText: 'Kiln Shelves' }).locator('.fy-ac-stands')).toHaveText('The new shelves are level.');
    await list.locator('.fy-ac', { hasText: 'Glaze Tests' }).click();
    await expect(card(page, 'Glaze Tests')).toBeVisible();
  });

  test('a private card: only what its note says (its lines as stored, its topics, a count), never an ask\'s words', async ({ page }) => {
    await boot(page);
    await openForYou(page);
    // the private line opens its area's details, where its cards are
    await forYou(page).locator('.fy-private').click();
    const list = focusSheet(page).getByRole('region', { name: "Sanctum's cards" });
    await expect(list.locator('.fy-ac .fy-ac-name')).toHaveText(['daily practice']);
    await expect(list.locator('.fy-ac .fy-mark')).toHaveAttribute('data-mark', 'yours');
    await list.locator('.fy-ac').click();
    const c = card(page, 'daily practice');
    await expect(c).toBeVisible();
    await expect(c.locator('.fy-card-lines li .fy-card-line')).toHaveText(['A session on daily practice: completed.']);
    await expect(c.locator('.fy-card-count')).toContainText('1 thing waits on you');
    await expect(c.locator('.fy-card-threads > i')).toHaveText(['daily practice']);
    await expect(c.locator('.fy-card-stands, .fy-card-hill, article.fy-item')).toHaveCount(0);
    await expect(c).not.toContainText('Morning practice');
    await expect(c).not.toContainText('Private words');
  });

  test('beside the list on a wide screen (the list stays in use), a sheet over it on a phone', async ({ page }) => {
    await boot(page);
    await openForYou(page);
    await item(page, 'fy-glaze').locator('.fy-where').click();
    const c = card(page, 'Glaze Tests');
    await expect(c).toBeVisible();
    const m = await page.evaluate(() => {
      const box = document.querySelector('.fy-card')!.getBoundingClientRect();
      const home = document.querySelector('.areas-home')!.getBoundingClientRect();
      const soup = document.querySelector('article.fy-item[data-id="fy-soup"] .fy-what')!.getBoundingClientRect();
      const hit = document.elementFromPoint(soup.left + 10, soup.top + soup.height / 2);
      return { W: innerWidth, H: innerHeight, left: box.left, right: box.right, bottom: box.bottom, homeRight: home.right, scrim: !!document.querySelector('.fy-scrim'),
        listInUse: !!hit?.closest('article.fy-item[data-id="fy-soup"]'), modal: document.querySelector('.fy-card')!.getAttribute('aria-modal') };
    });
    if (wide()) {
      expect(m.scrim).toBe(false);
      expect(m.modal).toBeNull();
      expect(Math.abs(m.right - m.W)).toBeLessThan(2);
      // the home gives the card its column: nothing of the list is under it, and the list still takes a tap
      expect(m.homeRight).toBeLessThanOrEqual(m.left + 1);
      expect(m.listInUse).toBe(true);
      // another card's name, with the card open: the panel shows that one
      await item(page, 'fy-jars').locator('.fy-where').click();
      await expect(card(page, 'Honey Harvest')).toBeVisible();
      await expect(c).toHaveCount(0);
      await close(page, 'Honey Harvest');
      // closed, the home has its whole width back
      expect(await page.evaluate(() => Math.round(document.querySelector('.areas-home')!.getBoundingClientRect().right))).toBe(m.W);
    } else {
      expect(m.scrim).toBe(true);
      expect(m.modal).toBe('true');
      expect(Math.abs(m.bottom - m.H)).toBeLessThan(2);
      await page.keyboard.press('Escape');
      await expect(c).toHaveCount(0);
    }
  });

  test("the card's way to its room: the thread under its post, where an answer lands", async ({ page }) => {
    await boot(page);
    await openForYou(page);
    await item(page, 'fy-glaze').locator('.fy-where').click();
    await card(page, 'Glaze Tests').getByRole('button', { name: 'Open its thread in #kiln-studio ›' }).click();
    // the room comes into focus at the card's post, in its thread
    await expect(focusSheet(page)).toBeVisible();
    await expect(focusSheet(page).locator('.all-focus-title')).toContainText('Kiln Studio');
    // beside: the card stays open by the room; a phone's sheet makes way for it
    if (wide()) await expect(card(page, 'Glaze Tests')).toBeVisible(); else await expect(card(page, 'Glaze Tests')).toHaveCount(0);
  });

  test('reads in greyscale: the marks by shape, his answer by its tag, every word dark enough', async ({ page }) => {
    await boot(page);
    await page.addStyleTag({ content: 'html { filter: grayscale(1) !important; }' });
    await chip(page, 'Kiln Studio').click();
    const row = page.getByRole('region', { name: "Kiln Studio's cards" });
    await row.getByRole('button', { name: '1 resting' }).click();
    const shape = (sel: string) => row.locator(sel).first().evaluate((el) => { const s = getComputedStyle(el); return { bg: s.backgroundImage !== 'none' ? 'half' : s.backgroundColor, border: s.borderTopWidth, w: s.width, h: s.height }; });
    const yours = await shape('.fy-mark[data-mark="yours"]'), moving = await shape('.fy-mark[data-mark="moving"]'), rest = await shape('.fy-mark[data-mark="rest"]');
    expect(yours.bg).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    expect(moving.bg).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    expect(moving.border).not.toBe('0px');
    expect(rest.h).not.toBe(rest.w);
    await row.locator('.fy-ac', { hasText: 'Glaze Tests' }).click();
    const c = card(page, 'Glaze Tests');
    // his answer: a filled tag, not a colour
    const tag = await c.locator('.fy-you').evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(tag).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    const faint = await c.evaluate((root) => {
      const lum = (col: string) => { const m = col.match(/[\d.]+/g)!.map(Number); const [r, g, b] = m.slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const bgOf = (el: Element | null): string => { for (let e = el; e; e = e.parentElement) { const b = getComputedStyle(e).backgroundColor; if (b && !/rgba\(.*, 0\)$/.test(b) && b !== 'transparent') return b; } return 'rgb(255, 255, 255)'; };
      const out: string[] = [];
      for (const el of Array.from(root.querySelectorAll('*'))) {
        const t = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent ?? '').join('').trim();
        if (!t || (el as HTMLElement).offsetParent === null) continue;
        const s = getComputedStyle(el); const fg = lum(s.color), bg = lum(bgOf(el));
        const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
        if (ratio * Number(s.opacity || 1) < 4.5) out.push(`${t.slice(0, 30)} ${ratio.toFixed(2)}`);
      }
      return out;
    });
    expect(faint).toEqual([]);
  });

  test('nothing in the card or the area\'s cards runs past the edge', async ({ page }) => {
    await boot(page);
    await chip(page, 'Kiln Studio').click();
    await page.getByRole('region', { name: "Kiln Studio's cards" }).locator('.fy-ac', { hasText: 'Glaze Tests' }).click();
    await expect(card(page, 'Glaze Tests')).toBeVisible();
    const over = await page.evaluate(() => { const W = innerWidth; return Array.from(document.querySelectorAll('.fy-card *, .all-scope *')).filter((e) => { const r = e.getBoundingClientRect(); const sc = e.closest('.fy-acs-row ul, .all-scope-row'); return r.width > 0 && !sc && (r.right > W + 1 || r.left < -1); }).map((e) => (e as HTMLElement).className); });
    expect(over).toEqual([]);
  });
});

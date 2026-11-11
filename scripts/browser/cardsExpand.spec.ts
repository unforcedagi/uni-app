// T-335 cards expand (11-11), on the real build with Tauri faked (shapeFixture.ts `cards`: a made-up world). Aaron: "I can't see the full text,
// theres no option to expand; and the cards often contain not much context; so in the case of those two I don't really know what they're even
// asking about". Proves, one test per point:
//   1. a card opens on a tap to its whole text, never cut off, and closes again (in a room and pinned on home);
//   2. opened, it first says what it asks: what a yes does, what it touches (production, which account), who asked and why now (from the ask
//      in its room that points at it), and an ask's sheet says what its button does and shows its card;
//   3. a card that no longer waits says so and offers to ask the room for a fresh one (an expired card; an ask whose card the broker ended),
//      while an ask whose card waits says until when.
// Run: pnpm exec playwright test --config playwright.cardsexpand.config.ts
import { test, expect, type Page } from '@playwright/test';
import { bootShape, calls, CARD, ROOM, UNI } from './shapeFixture';

const SHOTS = process.env.CARDS_SHOTS ?? 'test-results/cards-expand-shots';
const shot = async (page: Page, name: string) => { await page.waitForTimeout(250); await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${name}.png` }); };
const msg = (page: Page, ref: string) => page.locator(`.sh-room [data-ref="${ref}"]`);
const clipped = (el: import('@playwright/test').Locator) => el.evaluate((e) => e.scrollWidth > e.clientWidth + 1);

async function openRiverbend(page: Page) {
  await page.locator(`.sh-row[data-room="${ROOM.river}"] .sh-row-open`).click();
  await expect(page.locator('.sh-room')).toBeVisible();
}

test('1. a card opens on a tap to its whole text and closes again', async ({ page }) => {
  await bootShape(page, { cards: true });
  await openRiverbend(page);
  const card = msg(page, CARD.long).locator('.cc');
  await card.scrollIntoViewIfNeeded();
  const what = card.locator('.cc-what');
  // closed: one line, cut (the scope is longer than any phone or desktop row)
  expect(await clipped(what)).toBe(true);
  await shot(page, '01-closed');
  // a tap on the line opens it: the whole scope, nothing cut
  await what.click();
  await expect(card.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true');
  expect(await clipped(what)).toBe(false);
  await expect(what).toHaveText(/board's Thursday meeting$/);
  await shot(page, '02-open');
  // and closes again
  await card.getByRole('button', { name: 'Show less' }).click();
  await expect(card.getByRole('button', { name: 'Show all' })).toHaveAttribute('aria-expanded', 'false');
  expect(await clipped(what)).toBe(true);
  // pinned on home, the same card opens the same way
  await page.getByRole('button', { name: 'Back to rooms' }).click();
  const pin = page.locator('.sh-pin[data-ref="rb-card"]');
  await pin.getByRole('button', { name: 'Show all' }).click();
  await expect(pin.getByRole('definition').filter({ hasText: 'Send the October invoice' }).first()).toBeVisible();
  await expect(pin.getByRole('button', { name: 'Show less' })).toBeVisible();
});

test('2. opened, a card says what it asks: what a yes does, what it touches, who asked and why now', async ({ page }) => {
  await bootShape(page, { cards: true });
  await openRiverbend(page);
  const card = msg(page, CARD.prod).locator('.cc');
  await card.scrollIntoViewIfNeeded();
  await card.getByRole('button', { name: 'Show all' }).click();
  const asks = card.getByRole('definition');
  const head = card.locator('dl.cc-asking');
  await expect(head).toBeVisible();
  await expect(head.locator('dt')).toHaveText(['If you approve', 'Touches', 'Asked by', 'Why now']);
  await expect(head.locator('dd')).toHaveText([
    'Uni gets a key for 10 min (1 use). It can deploy Workers scripts on site.example.',
    'PRODUCTION · Open Site (site.example)',
    /^Uni · in #Riverbend Commons · .+ \(asked 20 min ago\) · for T-610: Deploy the import tool to the site$/,
    'Staging passed; the archive window closes Friday.',
  ]);
  expect(await asks.count()).toBeGreaterThan(4);
  // at the top of the opened card: above what Uni says and what approving releases
  const y = async (l: import('@playwright/test').Locator) => (await l.boundingBox())!.y;
  expect(await y(head)).toBeLessThan(await y(card.locator('.sealed-says')));
  expect(await y(head)).toBeLessThan(await y(card.locator('.sealed-releases')));
  await shot(page, '03-asking');
  // the ask that points at it: its sheet says what its button does, who asked, and shows the card itself, waiting, to answer in place
  const ask = page.locator('.sh-room-ask .sh-ask[data-id="ask-deploy"]');
  await ask.scrollIntoViewIfNeeded();
  await expect(ask.locator('[data-card-state="waiting"]')).toContainText(/Its card waits in this room · answer by \d/);
  await ask.locator('.sh-ask-open').click();
  const sheet = page.locator('.sh-ask-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('.sh-ask-facts dt').first()).toHaveText('If you tap Done');
  await expect(sheet.locator('.sh-ask-yes')).toHaveText('Tells #Riverbend Commons you did it; the ask goes back to the room for any follow-up');
  await expect(sheet.locator('.sh-ask-facts')).toContainText('Asked by#Riverbend Commons');
  await expect(sheet.locator('[data-card-state="waiting"] .sealed-card')).toBeVisible();
  await shot(page, '04-sheet');
});

test("3. a card that no longer waits says so and offers to ask the room for a fresh one", async ({ page }) => {
  await bootShape(page, { cards: true });
  await openRiverbend(page);
  // the expired card: it says so, not as a fault, and offers a fresh one
  const old = msg(page, CARD.old).locator('.cc');
  await old.scrollIntoViewIfNeeded();
  await expect(old).toContainText('Expired: it no longer waits, and nothing was sent.');
  await expect(old.getByRole('button', { name: 'Ask #Riverbend Commons to repost' })).toBeVisible();
  // the ask whose card the broker ended: it says so in the broker's words, and doesn't send him looking for it
  const ask = page.locator('.sh-room-ask .sh-ask[data-id="ask-load"]');
  await ask.scrollIntoViewIfNeeded();
  const stale = ask.locator('[data-card-state="ended"]');
  await expect(stale).toContainText("Its card has ended: ✓ Approved 13:10 · Open Site (site.example) — PRODUCTION account · loads the history into the archive. Nothing to tap.");
  await shot(page, '05-stale');
  const before = (await calls(page, 'post_message')).length;
  await stale.getByRole('button', { name: 'Ask #Riverbend Commons to repost' }).click();
  await expect(stale.getByRole('status')).toHaveText(/^Asked #Riverbend Commons for a fresh card · \d/);
  const posts = (await calls(page, 'post_message')).slice(before);
  expect(posts).toHaveLength(1);
  expect(posts[0].args.channel).toBe(ROOM.river);
  expect(posts[0].args.recipients).toEqual([UNI]);   // addressed to the room's Uni: it wakes
  expect(posts[0].args.body).toMatch(/^T-611: the approval card no longer waits \(it has ended: .+\)\. If it's still needed, post a fresh card and point T-611 at it/);
  await shot(page, '06-reposted');
  // asked once: the line stays asked after the room is read again
  await page.getByRole('button', { name: 'Back to rooms' }).click();
  await openRiverbend(page);
  await expect(page.locator('.sh-ask[data-id="ask-load"] [data-card-state="ended"]').getByRole('status')).toHaveText(/^Asked #Riverbend Commons for a fresh card/);
});

test("review r1: an ask's words stay in its room; its card found waiting in another room says where; a card not on this device offers no repost", async ({ page }) => {
  await bootShape(page, { cards: true });
  await openRiverbend(page);
  // Riverbend's card names Riverbend's own ask, never the Studio ask that points at the same card
  const card = msg(page, CARD.prod).locator('.cc');
  await card.scrollIntoViewIfNeeded();
  await card.getByRole('button', { name: 'Show all' }).click();
  await expect(card.locator('dl.cc-asking')).toContainText('for T-610');
  await expect(card).not.toContainText('T-612');
  await expect(card).not.toContainText('studio line');
  await page.getByRole('button', { name: 'Back to rooms' }).click();
  await page.locator(`.sh-row[data-room="${ROOM.studio}"] .sh-row-open`).click();
  await expect(page.locator('.sh-room')).toBeVisible();
  // the Studio ask: its card waits in Riverbend (Needs you's list), and it says so
  const elsewhere = page.locator('.sh-room-ask .sh-ask[data-id="ask-elsewhere"] [data-card-state="waiting"]');
  await elsewhere.scrollIntoViewIfNeeded();
  await expect(elsewhere).toContainText(/Its card waits in #Riverbend Commons · answer by \d/);
  // an ask whose card this device doesn't hold: said plainly, nothing to tap or repost
  const unknown = page.locator('.sh-room-ask .sh-ask[data-id="ask-unknown"] [data-card-state="missing"]');
  await unknown.scrollIntoViewIfNeeded();
  await expect(unknown).toHaveText("🔑 Its card isn't among this room's recent messages on this device.");
  await expect(unknown.getByRole('button')).toHaveCount(0);
});

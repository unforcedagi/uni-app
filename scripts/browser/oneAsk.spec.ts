// T-335 one ask, step 2: the app draws one card. On the real build with Tauri faked (shapeFixture.ts: a made-up world), with room asks as
// real signed events made by the vendored library (src/ask) under made-up keys. Proves, one test per point of the brief's acceptance:
//   1. one card per ask, across a room's chat, home and the bar's count (room asks, tasks and approval cards alike);
//   2. a "tap the card" task shows once, as its card (whether uni-tasks still lists it or has folded it);
//   3. a reply to an ask posts flat (no e tag: never a thread) and ends it;
//   4. Seen ends it for good (it stays ended after a reload, read from the room's messages alone);
//   5. a lapsed ask disappears at its time with no sweep (no write, no re-read: the clock alone).
// Run: pnpm exec playwright test --config playwright.oneask.config.ts
import { test, expect, type Page } from '@playwright/test';
import { sha256 } from '@noble/hashes/sha2.js';
import { buildAnswer, buildAsk, parseAsk, pubkeyHex, signEvent, type NostrEvent } from '../../src/ask/index.ts';
import { bootShape, calls, CARD, ROOM, type ShapeOpts } from './shapeFixture';

const SHOTS = process.env.ONEASK_SHOTS ?? 'test-results/oneask-shots';
const shot = async (page: Page, name: string) => { await page.waitForTimeout(250); await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${name}.png` }); };
const sk = (n: string) => sha256(new TextEncoder().encode('one-ask spec key: ' + n));
const ME_SK = sk('robin'), UNI_SK = sk('uni');
const ME = pubkeyHex(ME_SK), UNI = pubkeyHex(UNI_SK);

/** The room asks of this world: a choice in Riverbend, a do in Studio, one already seen in Riverbend, and (for the lapse) one in Uni's room
 *  that lapses `lapseIn` seconds from now. */
function world(now = Math.floor(Date.now() / 1000), lapseIn = 3 * 86400) {
  const ask = (room: string, ago: number, f: Record<string, unknown>) => signEvent(UNI_SK, buildAsk(room, { until: now + 3 * 86400, ...f }, now - ago), now - ago);
  const walk = ask(ROOM.river, 8 * 60, { kind: 'choose', what: 'Pick the walkthrough slot', why: 'Mira asked to move it', context: 'Thursday is free from 1 to 4; Friday morning is open too.',
    options: [{ id: 'thu', label: 'Thursday 2pm' }, { id: 'fri', label: 'Friday 10am' }], task: 'T-701' });
  const stills = ask(ROOM.studio, 30 * 60, { kind: 'do', what: 'Export two stills from cut 3', why: 'The poster needs them by Friday' });
  const old = ask(ROOM.river, 2 * 3600, { kind: 'tell', what: 'The board minutes are filed', why: 'For your records' });
  const seen = signEvent(ME_SK, buildAnswer(parseAsk(old, [UNI])[0]!, 'seen'), now - 3600);
  const kiln = ask(ROOM.uni, 60, { kind: 'tell', what: 'The kiln log is in', why: 'The firing ended', until: now + lapseIn });
  return { events: [walk, stills, old, seen, kiln] as NostrEvent[], walk, stills, old, kiln };
}

async function boot(page: Page, w: ReturnType<typeof world>, o: ShapeOpts = {}) {
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log('console error:', m.text().slice(0, 400)); });
  await page.exposeFunction('__signAsMe', (t: { kind: number; tags: string[][]; content: string }) => signEvent(ME_SK, t, Math.floor(Date.now() / 1000)));
  await bootShape(page, { cards: true, ...o, asks: { me: ME, uni: UNI, events: w.events } });
  await expect(page.locator('.sh-home')).toBeVisible();
}
const card = (page: Page, id: string) => page.locator(`[data-card="${id}"]`);
const bar = (page: Page) => page.locator('.sh-place-rooms .sh-count');
const row = (page: Page, room: string) => page.locator(`.sh-row[data-room="${room}"]`);
const openRoom = async (page: Page, room: string) => { await row(page, room).locator('.sh-row-open').click(); await expect(page.locator('.sh-room')).toBeVisible(); };
const back = async (page: Page) => { await page.getByRole('button', { name: 'Back to rooms' }).click(); await expect(page.locator('.sh-home')).toBeVisible(); };
/** What home says wants him, row by row (each row's own count: drawn cards, the rest "in the room", and a private room's wordless ones). */
const rowWants = (page: Page) => page.locator('.sh-row[data-wants]').evaluateAll((els) => els.reduce((n, e) => n + Number(e.getAttribute('data-wants')), 0));

test('1. one card per ask across a room, home and the bar', async ({ page }) => {
  const w = world();
  await boot(page, w);
  // home: a room's row counts its asks once, and the bar is the sum of the rows
  await expect(row(page, ROOM.river)).toHaveAttribute('data-wants', '5'); // the choice, T-602, the invoice card, the production card (T-610), T-611
  await expect(row(page, ROOM.studio)).toHaveAttribute('data-wants', '3'); // the stills, T-603, T-613 (T-612 and T-614 are their cards)
  await expect.poll(async () => Number(await bar(page).textContent())).toBe(await rowWants(page));
  // no card is drawn twice on home
  const homeIds = await page.locator('.sh-home [data-card]').evaluateAll((els) => els.map((e) => e.getAttribute('data-card')));
  expect(new Set(homeIds).size).toBe(homeIds.length);
  await shot(page, '01-home');
  // in the room: each ask exactly once, a room's ask where it was asked (the seen one folded there), the rest after the chat
  await openRoom(page, ROOM.river);
  for (const id of [w.walk.id, w.old.id, 'ask-walk', 'rb-card', CARD.prod, 'ask-load']) await expect(card(page, id)).toHaveCount(1);
  await expect(card(page, 'ask-deploy')).toHaveCount(0);
  await expect(card(page, w.old.id)).toHaveAttribute('data-state', 'answered');
  await expect(card(page, w.old.id)).toContainText('Seen');
  // the ask's own message is the card: its block is never shown as text
  await expect(page.locator('.sh-room')).not.toContainText('```uni-ask');
  await expect(page.locator('.sh-room')).not.toContainText('"v":1');
  await shot(page, '02-room');
  await back(page);
  await openRoom(page, ROOM.studio);
  for (const id of [w.stills.id, 'ask-cut', 'ask-unknown']) await expect(card(page, id)).toHaveCount(1);
  for (const id of ['ask-elsewhere', 'ask-hushed']) await expect(card(page, id)).toHaveCount(0);
});

for (const folded of [false, true]) test(`2. a "tap the card" task shows once, as its card (${folded ? 'folded by uni-tasks' : 'still listed'})`, async ({ page }) => {
  await boot(page, world(), { folded });
  await expect(page.locator('[data-card="ask-deploy"]')).toHaveCount(0);
  await openRoom(page, ROOM.river);
  await expect(card(page, 'ask-deploy')).toHaveCount(0);
  const prod = card(page, CARD.prod);
  await expect(prod).toHaveCount(1);
  // the card carries the task's words: which task, what and why now
  await expect(prod).toContainText('T-610');
  await expect(prod).toContainText('Deploy the import tool to the site');
  await expect(prod).toContainText('Staging passed; the archive window closes Friday.');
  await prod.scrollIntoViewIfNeeded();
  await shot(page, `03-folded-${folded}`);
});

test('3. a reply to an ask posts flat (no thread) and ends it', async ({ page }) => {
  const w = world();
  await boot(page, w);
  const before = Number(await bar(page).textContent());
  await openRoom(page, ROOM.river);
  const walk = card(page, w.walk.id);
  // it opens in place to its whole context and every button
  await walk.locator('[data-card-open]').first().click();
  await expect(walk).toContainText('Thursday is free from 1 to 4; Friday morning is open too.');
  await walk.getByRole('button', { name: 'Reply in the room' }).click();
  await expect(page.locator('.composer-answering')).toContainText('Pick the walkthrough slot');
  await shot(page, '04-replying');
  await page.locator('.composer textarea').fill('Thursday works, but make it 2:30');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(async () => (await calls(page, 'post_answer')).length).toBe(1);
  const [sent] = await calls(page, 'post_answer');
  expect(sent.args.channel).toBe(ROOM.river);
  expect(sent.args.template.content).toBe('Thursday works, but make it 2:30');
  expect(sent.args.template.tags).toEqual([['h', ROOM.river], ['q', w.walk.id, '', UNI], ['p', UNI]]);
  expect(sent.args.template.tags.some((t: string[]) => t[0] === 'e')).toBe(false);
  // nothing went as a thread reply
  expect((await calls(page, 'post_message')).filter((c) => c.args.replyTo)).toEqual([]);
  // ended, in place: folded to one line; and his words sit in the main line quoting it
  await expect(walk).toHaveAttribute('data-state', 'answered');
  await expect(walk).toContainText('You answered');
  await expect(page.locator('.sh-room .msg-quote').filter({ hasText: 'Pick the walkthrough slot' })).toHaveCount(1);
  await shot(page, '05-replied');
  await back(page);
  await expect(bar(page)).toHaveText(String(before - 1));
});

test('4. Seen ends it for good', async ({ page }) => {
  const w = world();
  await boot(page, w);
  const before = Number(await bar(page).textContent());
  await openRoom(page, ROOM.studio);
  const stills = card(page, w.stills.id);
  await stills.getByRole('button', { name: 'Seen', exact: true }).click();
  await expect(stills).toHaveAttribute('data-state', 'answered');
  const [sent] = await calls(page, 'post_answer');
  // a quiet answer: in the main line, waking no one (no p), never a thread (no e)
  expect(sent.args.template.tags).toEqual([['h', ROOM.studio], ['q', w.stills.id, '', UNI]]);
  await back(page);
  await expect(bar(page)).toHaveText(String(before - 1));
  await expect(page.locator(`.sh-home [data-card="${w.stills.id}"]`)).toHaveCount(0);
  // for good: a fresh start reads the room's messages again and it stays ended (no store, no list of seen ones)
  await page.reload();
  await expect(page.locator('.sh-home')).toBeVisible();
  await expect(bar(page)).toHaveText(String(before - 1));
  await expect(page.locator(`.sh-home [data-card="${w.stills.id}"]`)).toHaveCount(0);
  await openRoom(page, ROOM.studio);
  await expect(card(page, w.stills.id)).toHaveAttribute('data-state', 'answered');
  await expect(card(page, w.stills.id).getByRole('button', { name: 'Seen', exact: true })).toHaveCount(0);
});

test('5. a lapsed ask disappears at its time, with no sweep', async ({ page }) => {
  const start = Date.now();
  await page.clock.install({ time: start });
  const w = world(Math.floor(start / 1000), 90);
  await boot(page, w);
  const home = page.locator(`.sh-home [data-card="${w.kiln.id}"]`);
  await expect(home).toHaveCount(1);
  const before = Number(await bar(page).textContent());
  const reads = (await calls(page, 'ask_events')).length;
  await page.clock.fastForward(95_000);
  await expect(home).toHaveCount(0);
  await expect(bar(page)).toHaveText(String(before - 1));
  // the clock alone: nothing written, nothing read again
  expect((await calls(page, 'ask_events')).length).toBe(reads);
  for (const cmd of ['post_answer', 'post_message', 'vault_transition', 'vault_patch_meta']) expect(await calls(page, cmd)).toEqual([]);
  // in its room it is folded where it was asked: lapsed, no buttons
  await openRoom(page, ROOM.uni);
  await expect(card(page, w.kiln.id)).toHaveAttribute('data-state', 'lapsed');
  await expect(card(page, w.kiln.id).getByRole('button', { name: 'Seen', exact: true })).toHaveCount(0);
});

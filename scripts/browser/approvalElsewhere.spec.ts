// T-335 one ask: removed the pin over home's rooms, its countdown and its 15-minute rule, because an approval waiting for a tap is now one card
// on its room's row on home, from the moment it lands until it is answered or ends (`[data-card]`, data-source card or prompt).
// T-335 the shape: a card that lands in another room is never missed: home draws it on that room's row. Uni's card is answered in place there;
// a Hermes prompt's card has "Answer in the room". It goes when it is answered or expires.
// (The in-room "Approval waiting in #room" line and the door's count are retired with the old shell, and their tests deleted.) Rust is faked (`sealed_waiting`, `sealed_card`, `sealed_answer`); the areas fixture's made-up world gives the rooms.
// Run: ELSEWHERE_TEST_PORT=5781 npx playwright test --config playwright.elsewhere.config.ts
import { mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { bootAreas } from './areasFixture';
import { homeHead, openRoom, leaveRoom, roomRow } from './shapeNav';

const fx = JSON.parse(readFileSync(new URL('../fixtures/approval-prompts.json', import.meta.url), 'utf8'));
/** the approvals waiting on home: each a card on its room's row */
const cards = (page: Page) => page.locator('.sh-home [data-card][data-kind="approve"]');
const SHOTS = process.env.ELSEWHERE_SHOTS ?? '';
const BODY = '🔑 **Uni asks to use dns-zone** (powerful)\nFor: dns.edit. Add an A record for demo.example.org\nOpen this in the Uni app to see exactly what it unlocks.\n\n```uni-sealed-approval\n{"v": 1}\n```';
const shot = async (page: Page, name: string) => { if (!SHOTS) return; await mkdir(SHOTS, { recursive: true }); await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${name}.png` }); };

async function boot(page: Page) {
  await page.addInitScript(() => {
    const w = window as any; w.__waiting = [];
    const t = () => Math.floor(Date.now() / 1000);
    const row = () => ({ rid: 'r1'.padEnd(32, '0'), action: 'dns.edit', credential: 'dns-zone', class: 'powerful', scope: 'Add an A record for demo.example.org', ttl_s: 600, uses: 1,
      payload: { name: 'demo' }, request_digest: '9b13b2ae' + 'f'.repeat(56), expires: w.__expires ?? t() + 900, answer: w.__answer ?? null });
    w.__extraInvoke = async (cmd: string, args: any) => {
      // as the store answers: a card past its expiry is no longer waiting
      if (cmd === 'sealed_waiting') return w.__waiting.filter((x: any) => x.expires > t());
      if (cmd === 'sealed_card') return { kind: 'single', event_id: args.reference, refused: null, rows: [row()] };
      if (cmd === 'sealed_answer') { w.__answer = { decision: args.decision, at: t(), until: null, sent: true }; w.__waiting = []; return { kind: 'single', event_id: args.reference, refused: null, rows: [row()] }; }
      return undefined;
    };
    /** Uni posts a card in `room`, waiting until `expires`; returns its message ref. */
    w.__card = (room: string, body: string, expires: number) => {
      w.__expires = expires;
      // the live event's re-read is async, so the card is waiting by the time the app asks
      const ref = w.__arrive(room, 'Uni', body, 0, false, null);
      w.__waiting.push({ ref, channel: room, root: null, ts: t(), kind: 'single', credential: 'dns-zone', action: 'dns.edit', class: 'powerful', rows: 1, expires, fingerprint: '9b13b2ae' });
      return ref;
    };
  });
  await bootAreas(page, 'seed', { world: 'unread' });
  await expect(homeHead(page)).toBeVisible();
}

const card = (page: Page, room: string, inS = 900) => page.evaluate(([r, b, s]) => (window as any).__card(r, b, Math.floor(Date.now() / 1000) + Number(s)), [room, BODY, inS] as const);

test('a card that lands in another room is a card on that room\'s row on home; it is answered in place there and leaves', async ({ page }) => {
  test.setTimeout(120_000);
  await boot(page);
  await expect(cards(page)).toHaveCount(0);
  await openRoom(page, 'ch-kiln');
  await expect(page.locator('.sh-room').getByRole('heading', { level: 1 })).toHaveText('kiln-studio');

  const ref = await card(page, 'ch-allot', 600);
  // the room you are in does not carry a line any more; home draws it on its own room's row
  await expect(page.locator('.approval-elsewhere')).toHaveCount(0);
  await leaveRoom(page);
  const one = roomRow(page, 'ch-allot').locator(`[data-card="${ref}"]`);
  await expect(one).toBeVisible();
  await expect(one).toHaveAttribute('data-source', 'card');
  await expect(cards(page)).toHaveCount(1);
  await shot(page, '01-card-on-home');

  // Uni's card is drawn inside it as it is in its room, so it is answered in place; nothing is sent as a message
  const cardEl = one.getByRole('region', { name: 'Approve use of dns-zone', exact: true });
  await expect(cardEl).toBeVisible();
  await cardEl.getByRole('button', { name: 'Deny' }).click();
  await expect(cards(page)).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__calls.filter((x: any) => x.cmd === 'post_message').length)).toBe(0);
  // the room has it as answered, not waiting
  await openRoom(page, 'ch-allot');
  await expect(page.locator('.sh-room .approval-banner')).toHaveCount(0);
  await expect(page.locator(`.sh-room [data-card="${ref}"]`)).toHaveCount(0);
  await shot(page, '02-answered-in-room');
});

test('a Hermes prompt in another room is a card on that room\'s row on home; Answer in the room opens that room at the prompt', async ({ page }) => {
  test.setTimeout(120_000);
  await boot(page);
  const ref = await page.evaluate(([c, b]) => (window as any).__arrive(c, 'Uni', b), ['ch-kiln', fx.prompts.three_answers_5min]);
  const one = roomRow(page, 'ch-kiln').locator(`[data-card="${ref}"]`);
  await expect(one).toBeVisible();
  await expect(one).toHaveAttribute('data-source', 'prompt');
  await one.getByRole('button', { name: 'Answer in the room' }).click();
  await expect(page.locator('.sh-room').getByRole('heading', { level: 1 })).toHaveText('kiln-studio');
  await expect(page.locator(`.sh-room .message.approval-waiting[data-ref="${ref}"]`)).toBeInViewport();
  await expect(page.locator('.sh-room .approval-banner')).toBeVisible();
});

test('a card ending in 30 minutes is on its row at once; one that expires leaves its row by itself; a 30-minute Hermes prompt is on its row at once', async ({ page }) => {
  test.setTimeout(120_000);
  await boot(page);
  const far = await card(page, 'ch-allot', 1800);
  await expect(roomRow(page, 'ch-allot').locator(`[data-card="${far}"]`)).toBeVisible();

  // a card about to end is drawn, and gone once it is past its end (the other stays)
  const soon = await card(page, 'ch-allot', 4);
  await expect(roomRow(page, 'ch-allot').locator(`[data-card="${soon}"]`)).toBeVisible();
  await expect(roomRow(page, 'ch-allot').locator(`[data-card="${soon}"]`)).toHaveCount(0, { timeout: 15_000 });
  await expect(roomRow(page, 'ch-allot').locator(`[data-card="${far}"]`)).toBeVisible();

  // a Hermes prompt in Kiln Studio's room (30 minutes): a card on its row now, not only once it is within 15 minutes
  const prompt = await page.evaluate(([c, b]) => (window as any).__arrive(c, 'Uni', b), ['ch-kiln', fx.prompts.two_answers_30min]);
  await expect(roomRow(page, 'ch-kiln').locator(`[data-card="${prompt}"]`)).toHaveAttribute('data-source', 'prompt');
});

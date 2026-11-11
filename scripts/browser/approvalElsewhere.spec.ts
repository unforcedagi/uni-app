// T-335 the shape: a card that lands in another room is never missed. When it ends within 15 minutes it is pinned over the rooms on home (`.sh-pin`)
// Uni's card is answered in place; a Hermes prompt's pin has "Open in room". The pin goes when it is answered or expires.
// (The in-room "Approval waiting in #room" line and the door's count are retired with the old shell, and their tests deleted.) Rust is faked (`sealed_waiting`, `sealed_card`, `sealed_answer`); the areas fixture's made-up world gives the rooms.
// Run: ELSEWHERE_TEST_PORT=5781 npx playwright test --config playwright.elsewhere.config.ts
import { mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { bootAreas } from './areasFixture';
import { homeHead, openRoom, leaveRoom, roomRow } from './shapeNav';

const fx = JSON.parse(readFileSync(new URL('../fixtures/approval-prompts.json', import.meta.url), 'utf8'));
const pins = (page: Page) => page.locator('.sh-pin');
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

test('a card ending within 15 minutes in another room is pinned on home; its card is answered in place and the pin clears', async ({ page }) => {
  test.setTimeout(120_000);
  await boot(page);
  await expect(pins(page)).toHaveCount(0);
  await openRoom(page, 'ch-kiln');
  await expect(page.locator('.sh-room').getByRole('heading', { level: 1 })).toHaveText('kiln-studio');

  const ref = await card(page, 'ch-allot', 600);
  // the room you are in does not carry a line any more; home pins it
  await expect(page.locator('.approval-elsewhere')).toHaveCount(0);
  await leaveRoom(page);
  const pin = page.locator(`.sh-pin[data-ref="${ref}"]`);
  await expect(pin).toBeVisible();
  await expect(pin).toContainText('allotment');
  await expect(pin.getByRole('timer')).toHaveText(/^expires in (9:[0-5]\d|10:00)$/);
  await shot(page, '01-pin-on-home');

  // Uni's card is pinned as it is in its room, so it is answered in place; nothing is sent as a message
  const cardEl = pin.getByRole('region', { name: 'Approve use of dns-zone', exact: true });
  await expect(cardEl).toBeVisible();
  await cardEl.getByRole('button', { name: 'Deny' }).click();
  await expect(pins(page)).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__calls.filter((x: any) => x.cmd === 'post_message').length)).toBe(0);
  // the room has it as answered, not waiting
  await openRoom(page, 'ch-allot');
  await expect(page.locator('.sh-room .approval-banner')).toHaveCount(0);
  await shot(page, '02-answered-in-room');
});

test('a Hermes prompt ending within 15 minutes in another room is pinned on home; Open in room opens that room at the prompt', async ({ page }) => {
  test.setTimeout(120_000);
  await boot(page);
  const ref = await page.evaluate(([c, b]) => (window as any).__arrive(c, 'Uni', b), ['ch-kiln', fx.prompts.three_answers_5min]);
  const pin = page.locator(`.sh-pin[data-ref="${ref}"]`);
  await expect(pin).toBeVisible();
  await expect(pin.locator('.sh-pin-room')).toHaveText('kiln-studio');
  await pin.getByRole('button', { name: 'Open in room' }).click();
  await expect(page.locator('.sh-room').getByRole('heading', { level: 1 })).toHaveText('kiln-studio');
  await expect(page.locator(`.sh-room .message.approval-waiting[data-ref="${ref}"]`)).toBeInViewport();
  await expect(page.locator('.sh-room .approval-banner')).toBeVisible();
});

test('a card ending later than 15 minutes is not pinned; one that expires takes its pin with it; a 30-minute Hermes prompt is not pinned yet', async ({ page }) => {
  test.setTimeout(120_000);
  await boot(page);
  await card(page, 'ch-allot', 1800);
  await page.waitForTimeout(500);
  await expect(pins(page)).toHaveCount(0);

  // a card about to end is pinned, and gone once it is past its end
  await card(page, 'ch-allot', 4);
  await expect(pins(page)).toHaveCount(1);
  await expect(pins(page).first()).toContainText('allotment');
  await expect(pins(page)).toHaveCount(0, { timeout: 15_000 });

  // a Hermes prompt in Kiln Studio's room (30 minutes: not pinned until it is within 15)
  await page.evaluate(([c, b]) => (window as any).__arrive(c, 'Uni', b), ['ch-kiln', fx.prompts.two_answers_30min]);
  await page.waitForTimeout(500);
  await expect(pins(page)).toHaveCount(0);
  await expect(roomRow(page, 'ch-kiln')).toBeVisible();
});

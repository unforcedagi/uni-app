// T-335: a card that lands in another room is never missed. The room you are in says it at the top ("Approval waiting in #allotment"), the
// rooms list puts a key on that room, and one tap opens it at the card; both go when it is answered or expires. A Hermes prompt in another
// room counts the same. Rust is faked (`sealed_waiting`, `sealed_card`, `sealed_answer`); the areas fixture's made-up world gives the rooms.
// Run: ELSEWHERE_TEST_PORT=5781 npx playwright test --config playwright.elsewhere.config.ts
import { mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { bootAreas } from './areasFixture';

const fx = JSON.parse(readFileSync(new URL('../fixtures/approval-prompts.json', import.meta.url), 'utf8'));
const SHOTS = process.env.ELSEWHERE_SHOTS ?? '';
const BODY = '🔑 **Uni asks to use dns-zone** (powerful)\nFor: dns.edit. Add an A record for demo.example.org\nOpen this in the Uni app to see exactly what it unlocks.\n\n```uni-sealed-approval\n{"v": 1}\n```';
const wide = (page: Page) => (page.viewportSize()?.width ?? 0) >= 900;
const tree = (page: Page) => page.locator(wide(page) ? '.th-roomnav' : '.th-drawer .th-phone-tree');
const roomRow = (page: Page, id: string) => tree(page).locator(`.th-go[data-room="${id}"]`);
const line = (page: Page) => page.locator('.approval-elsewhere');
const title = (page: Page) => page.locator('.sr-title').first();
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
  await page.locator('[data-place="front-door"]').waitFor();
}
async function openArea(page: Page, area: string) {
  await page.locator(`.fd-door[data-path="Areas/${area}"]`).click();
  await expect(title(page)).toHaveText(area);
}
/** The rooms list, with "Other rooms" unfolded (on a phone it is in the Places drawer). */
async function places(page: Page) {
  if (!wide(page) && !(await page.locator('.th-drawer').isVisible())) await page.locator('.sr-drawer').click();
  await tree(page).waitFor();
  const fold = tree(page).locator('.th-fold[data-path="~other-rooms"]');
  if ((await fold.getAttribute('aria-expanded')) !== 'true') await fold.click();
}
async function closePlaces(page: Page) { if (!wide(page) && (await page.locator('.th-drawer').isVisible())) await page.keyboard.press('Escape'); }
const card = (page: Page, room: string, inS = 900) => page.evaluate(([r, b, s]) => (window as any).__card(r, b, Math.floor(Date.now() / 1000) + Number(s)), [room, BODY, inS] as const);

test('a card in another room: a line at the top and a key on that room; the line opens the card; answering it clears both', async ({ page }) => {
  test.setTimeout(120_000);
  await boot(page);
  await openArea(page, 'Kiln Studio');
  await expect(line(page)).toHaveCount(0);

  const ref = await card(page, 'ch-allot');
  await expect(line(page)).toBeVisible();
  await expect(line(page).locator('.approval-elsewhere-text b')).toHaveText('Approval waiting in #allotment');
  await expect(line(page)).toHaveAttribute('aria-label', /^Approval waiting in #allotment · first ends \d{1,2}:\d{2}\s?[AP]M\. Show it$/);
  // it sits under the room's header, above the conversation
  const head = await page.locator('.sr-head').first().boundingBox(); const box = await line(page).boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(head!.y + head!.height - 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual((await page.locator('.sr-chat').first().boundingBox())!.y + 1);
  await shot(page, '01-line-in-kiln');

  await places(page);
  const allot = roomRow(page, 'ch-allot');
  await expect(allot.locator('.th-ask')).toBeVisible();
  await expect(allot).toHaveAttribute('aria-label', /1 approval waiting/);
  await shot(page, '02-key-on-room');
  await closePlaces(page);

  await line(page).click();
  await expect(title(page)).toHaveText('#allotment');
  await expect(page.getByRole('region', { name: 'Approve use of dns-zone', exact: true })).toBeVisible();
  await expect(page.locator(`.message[data-ref="${ref}"]`)).toBeInViewport();
  // here, the card is this room's: the banner over the composer says it, and the line (for other rooms) goes
  await expect(line(page)).toHaveCount(0);
  await expect(page.locator('.approval-banner')).toBeVisible();
  await shot(page, '03-opened-at-card');

  await page.getByRole('region', { name: 'Approve use of dns-zone', exact: true }).getByRole('button', { name: 'Deny' }).click();
  await expect(page.locator('.approval-banner')).toHaveCount(0);
  await places(page);
  await expect(roomRow(page, 'ch-allot').locator('.th-ask')).toHaveCount(0);
  await tree(page).locator('.th-go[data-path="Areas/Kiln Studio"]').first().click();
  await expect(title(page)).toHaveText('Kiln Studio');
  await expect(line(page)).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__calls.filter((x: any) => x.cmd === 'post_message').length)).toBe(0);
});

test('a card that expires takes its line and key with it; a Hermes prompt elsewhere counts too; two rooms are both named', async ({ page }) => {
  test.setTimeout(120_000);
  await boot(page);
  await openArea(page, 'North Field');
  await card(page, 'ch-allot', 4);
  await expect(line(page).locator('b')).toHaveText('Approval waiting in #allotment');
  // the app reads the waiting cards again when the first one ends: past its end it is gone
  await expect(line(page)).toHaveCount(0, { timeout: 15_000 });
  await places(page);
  await expect(roomRow(page, 'ch-allot').locator('.th-ask')).toHaveCount(0);
  await closePlaces(page);

  // a Hermes prompt in Kiln Studio's room, and then a card in #allotment
  await page.evaluate(([c, b]) => (window as any).__arrive(c, 'Uni', b), ['ch-kiln', fx.prompts.two_answers_30min]);
  await expect(line(page).locator('b')).toHaveText('Approval waiting in #kiln-studio');
  await expect(line(page).locator('i')).toHaveText('!');
  await card(page, 'ch-allot');
  await expect(line(page).locator('b')).toHaveText(/^2 approvals waiting in #(kiln-studio and #allotment|allotment and #kiln-studio)$/);
  await shot(page, '04-two-rooms');
  // in the tree, Kiln Studio's own row carries the prompt's key
  await places(page);
  await expect(tree(page).locator('.th-go[data-path="Areas/Kiln Studio"]').first().locator('.th-ask')).toBeVisible();
});

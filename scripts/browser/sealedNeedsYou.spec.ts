// T-234 milestone 2: Uni's approval card waiting in a room is in Needs you at once (its room, the credential and action,
// its class and fingerprint, when it ends), notified once, and its row opens the room at the card; answering it on the
// card takes it out of Needs you, the banner and the room's mark. Rust is faked (`sealed_waiting`, `sealed_card`,
// `sealed_answer`); the T-161 areas fixture gives the real home surface. Synthetic names only.
import { test, expect, type Page } from '@playwright/test';
import { bootAreas } from './areasFixture';

const ROOM = 'ch-garden';
const wide = (page: Page) => (page.viewportSize()?.width ?? 0) >= 900 && (page.viewportSize()?.height ?? 0) >= 400;
const android = (page: Page) => page.evaluate(() => /Android/i.test(navigator.userAgent));
const BODY = '🔑 **Uni asks to use dns-zone** (powerful)\nFor: dns.edit. Add an A record for demo.example.org\nOpen this in the Uni app to see exactly what it unlocks.\n\n```uni-sealed-approval\n{"v": 1}\n```';

async function boot(page: Page) {
  await page.addInitScript(() => {
    const w = window as any; w.__notes = []; w.__waiting = [];
    w.Notification = class { static permission = 'granted'; static requestPermission = async () => 'granted'; constructor(title: string, o: { body?: string } = {}) { w.__notes.push({ title, body: o.body ?? '' }); } };
    const t = () => Math.floor(Date.now() / 1000);
    const row = () => ({ rid: 'r1'.padEnd(32, '0'), action: 'dns.edit', credential: 'dns-zone', class: 'powerful', scope: 'Add an A record for demo.example.org', ttl_s: 600, uses: 1,
      payload: { name: 'demo' }, request_digest: '9b13b2ae' + 'f'.repeat(56), expires: t() + 900, answer: w.__answer ?? null });
    w.__extraInvoke = async (cmd: string, args: any) => {
      if (cmd === 'sealed_waiting') return w.__waiting;
      if (cmd === 'sealed_card') return { kind: 'single', event_id: args.reference, refused: null, rows: [row()] };
      if (cmd === 'sealed_answer') { w.__answer = { decision: args.decision, at: t(), until: null, sent: true }; w.__waiting = []; return { kind: 'single', event_id: args.reference, refused: null, rows: [row()] }; }
      return undefined;
    };
  });
  await bootAreas(page, 'seed', { tree: true, tasks: true, briefs: true, strayRoom: true });
  if (wide(page)) {
    const nav = page.locator('.th-roomnav');
    await nav.locator('.th-row.d1').first().waitFor();
    await nav.locator('.th-go[aria-label^="Uni,"]').first().click();
    await expect(page.locator('.sr')).toHaveAttribute('data-node', 'Uni');
  } else await page.locator('.th-phone-tree, .cp.strip').first().waitFor();
}
const strip = (page: Page) => page.locator('.cp-line[aria-expanded="false"]');

test('a waiting card is in Needs you with its room, credential, class and end; the row opens the card; answering it clears it', async ({ page }) => {
  test.setTimeout(120_000);
  await boot(page);
  const rows = page.locator('.cp-sealed');
  await expect(rows).toHaveCount(0);
  const ref = await page.evaluate(([room, body]) => { const w = window as any; const r = w.__arrive(room, 'Uni', body, 0, false, null);
    w.__waiting = [{ ref: r, channel: room, root: null, ts: Math.floor(Date.now() / 1000), kind: 'single', credential: 'dns-zone', action: 'dns.edit', class: 'powerful', rows: 1, expires: Math.floor(Date.now() / 1000) + 900, fingerprint: '9b13b2ae' }];
    w.__arrive(room, 'Uni', 'and one more line', -1, false, null); return r; }, [ROOM, BODY] as const);
  if (await strip(page).count()) { await expect(strip(page)).toContainText('Uni asks: dns-zone · dns.edit'); await strip(page).click(); }
  const row = rows.first();
  await expect(rows).toHaveCount(1);
  await expect(row.locator('.cp-approval-lead')).toHaveText('Uni asks to use a credential in #garden-club');
  await expect(row.locator('.cp-approval-cmd')).toHaveText('dns-zone · dns.edit');
  await expect(row.locator('.cp-approval-why')).toHaveText('Powerful: hold to approve · job 9b13 b2ae');
  await expect(row.locator('.cp-approval-how')).toHaveText(/^Answer on the card · ends \d{1,2}:\d{2}\s?[AP]M$/);
  if (!(await android(page))) await expect.poll(() => page.evaluate(() => (window as any).__notes)).toContainEqual({ title: 'Uni in #garden-club', body: 'Asks to use dns-zone (powerful)' });
  if (process.env.CARDS_SHOTS) await page.screenshot({ path: `${process.env.CARDS_SHOTS}/${test.info().project.name}-needs-you.png` });
  await row.getByRole('button').click();
  const c = page.getByRole('region', { name: 'Approve use of dns-zone', exact: true });
  await expect(c).toBeVisible();
  await expect(page.locator(`.message.approval-waiting[data-ref="${ref}"]`)).toBeVisible();
  await expect(page.locator('.approval-banner')).toContainText('Uni asks for your tap: dns-zone · dns.edit');
  await c.getByRole('button', { name: 'Deny' }).click();
  await expect(c.getByRole('status')).toHaveText('Denied');
  await expect(page.locator('.approval-banner')).toHaveCount(0);
  await expect(page.locator('.message.approval-waiting')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__calls.filter((x: any) => x.cmd === 'post_message').length)).toBe(0);
});

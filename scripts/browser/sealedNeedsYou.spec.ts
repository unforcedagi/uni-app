// T-234 milestone 2: Uni's approval card waiting in a room is in Needs you at once (its room, the credential and action,
// its class and fingerprint, when it ends), notified once, and its row opens the room at the card; answering it on the
// card takes it out of Needs you, the banner and the room's mark. Rust is faked (`sealed_waiting`, `sealed_card`,
// `sealed_answer`); the T-161 areas fixture gives the real home surface. Synthetic names only.
import { test, expect, type Page } from '@playwright/test';
import { bootAreas, openPlaces } from './areasFixture';

const ROOM = 'ch-garden';
/** 0.2 one home: the waiting cards are in the home's drawer; openPlaces does nothing while the home still reads its rooms, so wait for its head */
const places = async (page: Page) => { await page.locator('[data-place="front-door"] .fd-pull').waitFor(); await openPlaces(page); };
const android = (page: Page) => page.evaluate(() => /Android/i.test(navigator.userAgent));
const BODY = '🔑 **Uni asks to use dns-zone** (powerful)\nFor: dns.edit. Add an A record for demo.example.org\nOpen this in the Uni app to see exactly what it unlocks.\n\n```uni-sealed-approval\n{"v": 1}\n```';

async function boot(page: Page, failTasks = false) {
  await page.addInitScript(() => {
    const w = window as any; w.__notes = []; w.__waiting = [];
    w.Notification = class { static permission = 'granted'; static requestPermission = async () => 'granted'; constructor(title: string, o: { body?: string } = {}) { w.__notes.push({ title, body: o.body ?? '' }); } };
    const t = () => Math.floor(Date.now() / 1000);
    const row = () => ({ rid: 'r1'.padEnd(32, '0'), action: 'dns.edit', credential: 'dns-zone', class: 'powerful', scope: 'Add an A record for demo.example.org', ttl_s: 600, uses: 1,
      payload: { name: 'demo' }, request_digest: '9b13b2ae' + 'f'.repeat(56), expires: t() + 900, answer: w.__answer ?? null });
    w.__extraInvoke = async (cmd: string, args: any) => {
      // T-335 card timing: a spec can make the read slow (`__swDelay` ms), fail (`__swFail` times) or make the sync fail (`__refreshFail` times)
      if (cmd === 'sealed_waiting') { const now = JSON.parse(JSON.stringify(w.__waiting)); if (w.__swDelay) await new Promise((r) => setTimeout(r, w.__swDelay)); if (w.__swFail > 0) { w.__swFail -= 1; throw new Error('database is locked'); } return now; }
      if (cmd === 'refresh' && w.__refreshFail > 0) { w.__refreshFail -= 1; throw new Error('relay: no route to host'); }
      if (cmd === 'sealed_card') return { kind: 'single', event_id: args.reference, refused: null, rows: [row()] };
      if (cmd === 'sealed_answer') { w.__answer = { decision: args.decision, at: t(), until: null, sent: true }; w.__waiting = []; return { kind: 'single', event_id: args.reference, refused: null, rows: [row()] }; }
      return undefined;
    };
  });
  await bootAreas(page, 'seed', { tree: true, tasks: true, briefs: true, strayRoom: true, queryFails: failTasks ? ['task'] : [] });
  // T-302: Uni's home is the front door; its "Waiting on your OK" list holds the waiting cards from every room
  await page.locator('[data-place="front-door"]').waitFor();
}

test('a waiting card is in Needs you with its room, credential, class and end; the row opens the card; answering it clears it', async ({ page }) => {
  test.setTimeout(120_000);
  await boot(page);
  const rows = page.locator('.cp-sealed');
  await expect(rows).toHaveCount(0);
  const ref = await page.evaluate(([room, body]) => { const w = window as any; const r = w.__arrive(room, 'Uni', body, 0, false, null);
    w.__waiting = [{ ref: r, channel: room, root: null, ts: Math.floor(Date.now() / 1000), kind: 'single', credential: 'dns-zone', action: 'dns.edit', class: 'powerful', rows: 1, expires: Math.floor(Date.now() / 1000) + 900, fingerprint: '9b13b2ae' }];
    w.__arrive(room, 'Uni', 'and one more line', -1, false, null); return r; }, [ROOM, BODY] as const);
  // 0.2 one home: the waiting cards are in the home's drawer, under what needs you
  await places(page);
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

test('the task list failing to load still shows a waiting card in Needs you', async ({ page }) => {
  test.setTimeout(120_000);
  await boot(page, true);
  await page.evaluate(([room, body]) => { const w = window as any; const r = w.__arrive(room, 'Uni', body, 0, false, null);
    w.__waiting = [{ ref: r, channel: room, root: null, ts: Math.floor(Date.now() / 1000), kind: 'morning', credential: null, action: null, class: 'routine', rows: 3, expires: Math.floor(Date.now() / 1000) + 900, fingerprint: '0aa11bbc' }];
    w.__arrive(room, 'Uni', 'and one more line', -1, false, null); }, [ROOM, BODY.replace('uni-sealed-approval', 'uni-sealed-morning')] as const);
  await places(page);
  // (the front door holds no task list, so there is no "Couldn't load" line to say; the card shows all the same)
  const row = page.locator('.cp-sealed').first();
  await expect(row.locator('.cp-approval-lead')).toHaveText("Uni's morning card in #garden-club");
  await expect(row.locator('.cp-approval-cmd')).toHaveText('Morning card · 3 routine credentials');
  // and in the work view ("All of Uni's work"), where the list's failure is said again
  const all = page.getByRole('button', { name: /All of Uni.s work/ });
  if (await all.count()) {
    await all.first().click();
    await expect(page.locator('.wv').getByText("Couldn't load what needs you")).toBeVisible();
    await expect(page.locator('.wv .cp-sealed .cp-approval-cmd')).toHaveText('Morning card · 3 routine credentials');
  }
});

// 11-07: a card answered on another of the owner's devices. That device's answer never reaches this one; Uni's edit of the card does (the
// broker edits a card that ended to one line: uni-ops tests/test_sealed_card_sync.py drives it with the app's own Rust). Rust then no
// longer lists it (`sealed_waiting` reads the edited body, which has no fence), and the app has to read that again when the edit lands,
// not at the next message.
const ANSWERED = '❌ Denied at 14:05 · **Uni asks to use dns-zone** (powerful)';
async function cardArrives(page: Page): Promise<string> {
  return page.evaluate(([room, body]) => { const w = window as any; const r = w.__arrive(room, 'Uni', body, 0, false, null);
    w.__waiting = [{ ref: r, channel: room, root: null, ts: Math.floor(Date.now() / 1000), kind: 'single', credential: 'dns-zone', action: 'dns.edit', class: 'powerful', rows: 1, expires: Math.floor(Date.now() / 1000) + 900, fingerprint: '9b13b2ae' }];
    return r; }, [ROOM, BODY] as const);
}
const answeredElsewhere = (page: Page, ref: string) => page.evaluate(([room, r, line]) => { const w = window as any; w.__waiting = []; w.__editMsg(room, r, line); }, [ROOM, ref, ANSWERED] as const);

test('a card answered on another device leaves Needs you as soon as Uni edits it', async ({ page }) => {
  test.setTimeout(120_000);
  await boot(page);
  const ref = await cardArrives(page);
  await places(page);
  const rows = page.locator('.cp-sealed');
  await expect(rows).toHaveCount(1);
  await answeredElsewhere(page, ref);
  await expect(rows).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__calls.filter((x: any) => x.cmd === 'sealed_answer').length)).toBe(0);
});

test('a card answered on another device leaves the room it is open in: no buttons, no banner, the line in its place', async ({ page }) => {
  test.setTimeout(120_000);
  await boot(page);
  const ref = await cardArrives(page);
  await places(page);
  await page.locator('.cp-sealed').first().getByRole('button').click();
  const c = page.getByRole('region', { name: 'Approve use of dns-zone', exact: true });
  await expect(c).toBeVisible();
  await expect(page.locator('.approval-banner')).toContainText('Uni asks for your tap: dns-zone · dns.edit');
  await answeredElsewhere(page, ref);
  await expect(c).toHaveCount(0);
  await expect(page.locator(`article[data-ref="${ref}"]`)).toContainText("Denied at 14:05");
  await expect(page.locator('.approval-banner')).toHaveCount(0);
  await expect(page.locator('.message.approval-waiting')).toHaveCount(0);
});

// T-335 card timing (11-09): three ways a card already in the store stayed off the screen. Each is driven as the app meets it: the read of
// the waiting cards (`sealed_waiting`) is slow while other rooms keep talking, or fails once, or the sync fails as the app comes back.
const waitingRow = (ref: string) => ({ ref, channel: ROOM, root: null, ts: Math.floor(Date.now() / 1000), kind: 'single', credential: 'dns-zone', action: 'dns.edit', class: 'powerful', rows: 1, expires: Math.floor(Date.now() / 1000) + 900, fingerprint: '9b13b2ae' });
const setVisible = (page: Page, visible: boolean) => page.evaluate((v) => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (v ? 'visible' : 'hidden') }); document.dispatchEvent(new Event('visibilitychange')); }, visible);

test('a waiting card shows while other rooms keep talking, though each read of the cards is slower than the talk', async ({ page }) => {
  test.setTimeout(120_000);
  await boot(page);
  await places(page);
  const rows = page.locator('.cp-sealed');
  await expect(rows).toHaveCount(0);
  await page.evaluate(() => { (window as any).__swDelay = 400; });
  const ref = await page.evaluate(([room, body]) => (window as any).__arrive(room, 'Uni', body, 0, false, null), [ROOM, BODY] as const);
  await page.evaluate((w) => { (window as any).__waiting = [w]; }, waitingRow(ref));
  // another room talks for 6 s, a message every 200 ms: every read of the cards has a newer one started before it lands
  await page.evaluate(() => { const w = window as any; let n = 0; w.__talk = setInterval(() => { w.__arrive('ch-kiln', 'Uni', 'line ' + n, 0, false, null); if (++n >= 30) clearInterval(w.__talk); }, 200); });
  await expect(rows).toHaveCount(1, { timeout: 2500 });
  expect(await page.evaluate(() => (window as any).__talk !== undefined && (window as any).__msgs['ch-kiln'].filter((m: any) => /^line /.test(m.body)).length), 'the card is up while the talk is still going').toBeLessThan(30);
  await page.evaluate(() => clearInterval((window as any).__talk));
});

test('a read of the waiting cards that fails is tried again, with no new message to prompt it', async ({ page }) => {
  test.setTimeout(120_000);
  await boot(page);
  await places(page);
  const rows = page.locator('.cp-sealed');
  await page.evaluate(() => { (window as any).__swFail = 1; });
  const ref = await page.evaluate(([room, body]) => (window as any).__arrive(room, 'Uni', body, 0, false, null), [ROOM, BODY] as const);
  await page.evaluate((w) => { (window as any).__waiting = [w]; }, waitingRow(ref));
  await expect(rows).toHaveCount(1, { timeout: 4000 });
});

test('a sync that fails as the app comes back is tried again, and the card that landed while it was away shows', async ({ page }) => {
  test.setTimeout(120_000);
  await boot(page);
  await places(page);
  const rows = page.locator('.cp-sealed');
  await setVisible(page, false);
  // the card lands while the app is away: stored by the next sync, never announced on the live socket
  const ref = await page.evaluate(([room, body]) => { const w = window as any; const l = w.__listeners['uni://live']; w.__listeners['uni://live'] = []; const r = w.__arrive(room, 'Uni', body, 0, false, null); w.__listeners['uni://live'] = l; return r; }, [ROOM, BODY] as const);
  await page.evaluate(() => { const w = window as any; w.__refreshFail = 1; w.__calls.length = 0; });
  await setVisible(page, true);
  // the first sync fails (the network is not up yet): nothing new is read
  await expect.poll(() => page.evaluate(() => (window as any).__calls.filter((x: any) => x.cmd === 'refresh').length)).toBe(1);
  await page.evaluate((w) => { (window as any).__waiting = [w]; }, waitingRow(ref));
  await expect(rows).toHaveCount(1, { timeout: 6000 });
  expect(await page.evaluate(() => (window as any).__calls.filter((x: any) => x.cmd === 'live_start').length), 'live updates are on again').toBeGreaterThan(0);
});

test('a sync retry that is waiting when the app leaves the screen does not run while it is away', async ({ page }) => {
  test.setTimeout(120_000);
  await boot(page);
  const syncs = () => page.evaluate(() => (window as any).__calls.filter((x: any) => x.cmd === 'refresh').length);
  await setVisible(page, false);
  await page.evaluate(() => { const w = window as any; w.__refreshFail = 9; w.__calls.length = 0; });
  await setVisible(page, true);
  await expect.poll(syncs).toBe(1);
  await setVisible(page, false);
  // the first retry would have run at 2 s
  await page.waitForTimeout(3500);
  expect(await syncs()).toBe(1);
  // back on screen: it syncs at once, and after that failure tries again by itself
  await setVisible(page, true);
  await expect.poll(syncs, { timeout: 5000 }).toBeGreaterThanOrEqual(3);
});

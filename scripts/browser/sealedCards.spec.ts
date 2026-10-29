import { test, expect, type Page } from '@playwright/test';

// T-234 milestone 2: Uni's approval card and morning card on the real built frontend, with the Tauri backend faked. The
// fake stands in for Rust: `sealed_card` returns the checked view (or the refusal Rust would give), `sealed_answer` takes
// the tap. The checks, the data key and the reply are tested for real in uni-core (sealed_card.rs, tests/mock_relay.rs)
// and against the reference broker (uni-ops research/t234-sealed-creds/app/cards_crosscheck.py). Proves: the card draws
// only from the view; powerful needs a hold and a short press sends nothing; Deny; routine is a tap; expired, replayed
// and tampered cards have no buttons; the permanent-token warning; the morning card's per-row grants; a failed send keeps
// the decision for Try again; the webview sends only request ids. Synthetic keys and names only.
// Run: CARDS_TEST_PORT=5744 npx playwright test --config playwright.cards.config.ts

const ME = 'a'.repeat(64);
const UNI = 'c'.repeat(64);
const now = () => Math.floor(Date.now() / 1000);
const msg = (ref: string, body: string, ts: number, author = UNI, name = 'Uni') => ({ ref, channel: 'test', author, author_name: name, ts, body,
  mentions_me: false, root: null, parent: null, mentions: [], reply_count: 0, last_reply_ts: null, edited: false, reactions: [] });
const fence = (lang: string, prose: string) => `${prose}\nOpen this in the Uni app to see exactly what it unlocks.\n\n\`\`\`${lang}\n{"v": 1}\n\`\`\``;
const single = (prose = '🔑 **Uni asks to use dns-zone** (powerful)') => fence('uni-sealed-approval', prose);

type Row = { rid: string; action: string; credential: string; class: 'routine' | 'powerful'; scope: string; ttl_s: number; uses: number; payload: unknown; request_digest: string; expires: number; answer: null };
const row = (o: Partial<Row> = {}): Row => ({ rid: 'r1'.padEnd(32, '0'), action: 'dns.edit', credential: 'dns-zone', class: 'powerful', scope: 'Add an A record for demo.example.org',
  ttl_s: 600, uses: 1, payload: { type: 'A', name: 'demo', content: '192.0.2.7', zone: 'example.org', note: 'https://example.org/' + 'x'.repeat(90) },
  request_digest: '9b13b2ae' + 'f'.repeat(56), expires: now() + 900, answer: null, ...o });
const view = (rows: Row[], kind: 'single' | 'morning' = 'single') => ({ kind, event_id: 'e'.repeat(64), refused: null, rows });
const refused = (why: string, kind: 'single' | 'morning' = 'single') => ({ kind, event_id: 'e'.repeat(64), refused: why, rows: [] });

type Opts = { messages: unknown[]; cards: Record<string, unknown>; failures?: number; waiting?: unknown[] };
async function boot(page: Page, o: Opts) {
  await page.addInitScript(({ ME, UNI, o }) => {
    const w = window as any;
    w.calls = [];
    w.failures = o.failures ?? 0;
    const cards = o.cards as Record<string, any>;
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: () => 1,
      invoke: async (cmd: string, args: any) => {
        w.calls.push({ cmd, args });
        switch (cmd) {
          case 'identity_status': return { paired: true, pubkey: ME };
          case 'get_identity': return ME;
          case 'relay_origin': return 'https://example.invalid';
          case 'get_npub': return 'test';
          case 'get_rooms': return [{ id: 'test', name: 'Test room', unread: 0 }];
          case 'get_members': return [{ pubkey: UNI, name: 'Uni' }, { pubkey: ME, name: 'Robin' }];
          case 'get_messages': return o.messages;
          case 'vault_list': return [];
          case 'journal_config': return { hub: 'test' };
          case 'refresh': return { pubkey: ME, total_items: 0, channel_errors: {}, truncated_channels: [] };
          case 'secret_requesters': return [];
          case 'sealed_waiting': return w.answered ? [] : (o.waiting ?? []);
          case 'sealed_card': return cards[args.reference] ?? null;
          case 'sealed_answer': {
            await new Promise((r) => setTimeout(r, 200));
            const v = cards[args.reference];
            const t = Math.floor(Date.now() / 1000);
            const sent = w.failures <= 0;
            v.rows = v.rows.map((r: any) => args.rids.includes(r.rid) ? { ...r, answer: { decision: args.decision, at: t, until: args.decision === 'approve' ? t + r.ttl_s : null, sent } } : r);
            w.answered = true;
            if (typeof w.__afterAnswer === 'function') w.__afterAnswer(cards);
            if (!sent) { w.failures--; throw 'relay unreachable: connection refused'; }
            return v;
          }
          default: return null;
        }
      },
    };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  }, { ME, UNI, o });
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'Message Test room' })).toBeVisible();
}
const calls = (page: Page) => page.evaluate(() => (window as any).calls as { cmd: string; args: any }[]);
const answers = async (page: Page) => (await calls(page)).filter((c) => c.cmd === 'sealed_answer');
const card = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
/** T-335: a waiting card's facts are behind its "details" toggle, closed until asked for */
const details = async (c: ReturnType<typeof card>) => { await c.getByRole('button', { name: 'details', exact: true }).click(); await expect(c.locator('.cc-details')).toBeVisible(); };
/** T-335: an answered card is one line, closed */
const line = (c: ReturnType<typeof card>) => c.locator('details > summary');
const shot = async (page: Page, name: string) => { if (process.env.CARDS_SHOTS) await page.screenshot({ path: `${process.env.CARDS_SHOTS}/${test.info().project.name}-${name}.png` }); };
/** press and hold the button for `ms` with the pointer, as a finger or a mouse does */
async function hold(page: Page, button: ReturnType<Page['getByRole']>, ms: number) {
  await button.scrollIntoViewIfNeeded();
  const b = (await button.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
}

test('approve a powerful card: every field from the view, a click does nothing, a one-second hold sends the request id once', async ({ page }) => {
  await boot(page, { messages: [msg('m1', single('🔑 **Uni asks to use something harmless** (routine)'), now() - 30)], cards: { m1: view([row()]) } });
  const c = card(page, 'Approve use of dns-zone');
  await expect(c).toBeVisible();
  await expect(c.getByText('POWERFUL')).toBeVisible();
  // T-335: one row: what (the checked scope), where and how long, the buttons; the facts are closed
  await expect(c.locator('.cc-what')).toHaveText('Add an A record for demo.example.org');
  await expect(c.locator('.cc-meta')).toHaveText(/^dns-zone · dns\.edit · 10 min · POWERFUL · details$/);
  await expect(c.locator('dl')).toHaveCount(0);
  await expect(c.getByRole('button', { name: 'details' })).toHaveAttribute('aria-expanded', 'false');
  // tapping the row itself answers nothing
  await c.locator('.cc-what').click();
  await c.locator('.cc-meta').click({ position: { x: 2, y: 2 } });
  expect(await answers(page)).toHaveLength(0);
  await details(c);
  for (const [k, v] of [['Credential', 'dns-zone'], ['Action', 'dns.edit'], ['Scope', 'Add an A record for demo.example.org'], ['Window', '10 min, 1 use'], ['Exact job', '9b13 b2ae (fingerprint)']]) {
    await expect(c.locator('dt', { hasText: new RegExp(`^${k}$`) }).locator('+ dd')).toHaveText(v);
  }
  await expect(c.locator('dt', { hasText: /^Answer by$/ }).locator('+ dd')).toHaveText(/^\d{2}:\d{2}/);
  // the payload: every top-level key, long values cut, URLs as text, never links
  for (const k of ['type', 'name', 'content', 'zone', 'note']) await expect(c.locator('.sealed-key', { hasText: new RegExp(`^${k}$`) })).toBeVisible();
  await expect(c.locator('.sealed-payload a')).toHaveCount(0);
  await expect(c.getByText(/^https:\/\/example\.org\/x+…$/)).toBeVisible();
  await c.getByRole('button', { name: '▸ more' }).click();
  await expect(c.locator('.sealed-pretty')).toContainText('"zone": "example.org"');
  // P5: what approving really releases, from the checked fields
  await expect(c.locator('.sealed-releases')).toHaveText("Approving opens dns-zone itself on uni for up to 10 min. Uni is trusted to do only what's shown. If uni were compromised, this would hand over all of dns-zone.");
  // the message's own words stay outside the frame, and the card never shows them as its facts
  await expect(page.getByText('Uni asks to use something harmless')).toBeVisible();
  await expect(c.getByText('something harmless')).toHaveCount(0);
  await shot(page, 'approve-before');
  const approve = c.getByRole('button', { name: 'Hold to approve: press and hold' });
  await approve.click();
  await page.waitForTimeout(1300);
  expect(await answers(page)).toHaveLength(0);
  await hold(page, approve, 1300);
  // T-335: answered, it is one closed line: "✓ Approved · what · time"; opening it shows the facts and still nothing to answer
  await expect(c.getByRole('status')).toHaveText('Approved');
  await expect(line(c)).toHaveText(/^✓Approved · Add an A record for demo\.example\.org · \d{1,2}:\d{2}(\s?[AP]M)?$/);
  await expect(c.locator('details')).not.toHaveAttribute('open');
  await expect(c.locator('dl')).toBeHidden();
  await expect(c.getByRole('button', { name: /Deny|approve/i })).toHaveCount(0);
  await line(c).click();
  await expect(c.locator('dt', { hasText: /^Open until$/ }).locator('+ dd')).toHaveText(/^\d{2}:\d{2}/);
  await expect(c.getByRole('button', { name: /Deny|approve/i })).toHaveCount(0);
  const sent = await answers(page);
  expect(sent).toHaveLength(1);
  // the webview names the card and the request, never a key
  expect(sent[0].args).toEqual({ channel: 'test', reference: 'm1', decision: 'approve', rids: [row().rid] });
  await shot(page, 'approve-after');
});

test('cancel: letting go before a second sends nothing and says so; the card stays answerable', async ({ page }) => {
  await boot(page, { messages: [msg('m1', single(), now() - 30)], cards: { m1: view([row()]) } });
  const c = card(page, 'Approve use of dns-zone');
  const approve = c.getByRole('button', { name: 'Hold to approve: press and hold' });
  await hold(page, approve, 400);
  await expect(c.getByText('Cancelled: nothing was sent. Hold for a second to approve.')).toBeVisible();
  await page.waitForTimeout(900);
  expect(await answers(page)).toHaveLength(0);
  await expect(approve).toBeEnabled();
  // the keyboard holds too: Space down for a second
  await approve.focus();
  await page.keyboard.down('Space');
  await page.waitForTimeout(1300);
  await page.keyboard.up('Space');
  await expect(c.getByRole('status')).toHaveText('Approved');
  expect(await answers(page)).toHaveLength(1);
});

test('reject: Deny sends a deny for the request and the card says Denied', async ({ page }) => {
  await boot(page, { messages: [msg('m1', single(), now() - 30)], cards: { m1: view([row()]) } });
  const c = card(page, 'Approve use of dns-zone');
  await c.getByRole('button', { name: 'Deny' }).click();
  await expect(c.getByRole('status')).toHaveText('Denied');
  await expect(c.getByRole('button', { name: /Deny|approve/i })).toHaveCount(0);
  const sent = await answers(page);
  expect(sent.map((s) => [s.args.decision, s.args.rids])).toEqual([['deny', [row().rid]]]);
});

test('a routine card is approved with a plain tap, with no powerful warning', async ({ page }) => {
  const r = row({ credential: 'pages-deploy', action: 'deploy.pages', class: 'routine', ttl_s: 3600, uses: 3, scope: 'Deploy the example site', payload: null });
  await boot(page, { messages: [msg('m1', single(), now() - 30)], cards: { m1: view([r]) } });
  const c = card(page, 'Approve use of pages-deploy');
  await expect(c.locator('.cc-meta')).toHaveText('pages-deploy · deploy.pages · 60 min · details');
  await expect(c.locator('.sealed-badge')).toHaveCount(0);
  await expect(c.locator('.sealed-releases')).toHaveCount(0);
  await details(c);
  await expect(c.locator('dt', { hasText: /^Window$/ }).locator('+ dd')).toHaveText('60 min, 3 uses');
  await c.getByRole('button', { name: 'Approve' }).click();
  await expect(c.getByRole('status')).toHaveText('Approved');
  await expect(line(c)).toHaveText(/^✓Approved · Deploy the example site · \d{1,2}:\d{2}(\s?[AP]M)?$/);
  expect((await answers(page)).map((s) => s.args.decision)).toEqual(['approve']);
});

test('expired: greyed with the reason and no buttons; one that expires while open loses its buttons', async ({ page }) => {
  // the page's clock runs as usual until the test moves it on past the answer-by time
  await page.clock.install();
  await boot(page, { messages: [msg('m1', single(), now() - 3000), msg('m2', single(), now() - 30)],
    cards: { m1: refused('This card has expired.'), m2: view([row({ rid: 'r2'.padEnd(32, '0'), expires: now() + 120 })]) } });
  const old = card(page, 'Approve use of a credential (can\'t be approved)');
  await expect(old.getByRole('status')).toHaveText('This card has expired.');
  await expect(old.getByRole('button')).toHaveCount(0);
  const open = card(page, 'Approve use of dns-zone');
  await expect(open.getByRole('button', { name: 'Deny' })).toBeVisible();
  await page.clock.fastForward('03:00');
  await expect(open.getByText('Expired', { exact: true })).toBeVisible();
  await expect(line(open)).toHaveText(/^⌛Expired · Add an A record for demo\.example\.org · \d{1,2}:\d{2}(\s?[AP]M)?$/);
  await expect(open.getByRole('button', { name: /Deny|approve/i })).toHaveCount(0);
  await shot(page, 'expired');
  expect(await answers(page)).toHaveLength(0);
});

test('replayed and tampered cards: the reason Rust gives, nothing to tap', async ({ page }) => {
  const why = ['This card repeats a request that was already answered.', "What's shown doesn't match what's approved.", 'Not signed by Uni.', "The key in this card belongs to a different credential.", "This card misstates the credential's class."];
  await boot(page, { messages: why.map((_, i) => msg(`m${i}`, single(`🔑 **Uni asks to use cloudflare-dns** ${i}`), now() - 60 + i)),
    cards: Object.fromEntries(why.map((w, i) => [`m${i}`, refused(w)])) });
  const greyed = page.locator('.sealed-card.sealed-greyed');
  await expect(greyed).toHaveCount(why.length);
  for (const w of why) await expect(greyed.getByText(w, { exact: true })).toBeVisible();
  await expect(page.locator('.sealed-card').getByRole('button')).toHaveCount(0);
  await expect(page.locator('.sealed-card dl')).toHaveCount(0);
  await shot(page, 'refused');
  expect(await answers(page)).toHaveLength(0);
});

test('answering one card reads the others again: the same request on a second card is then a replay with no buttons', async ({ page }) => {
  await boot(page, { messages: [msg('m1', single(), now() - 60), msg('m2', single('🔑 the same request again'), now() - 30)], cards: { m1: view([row()]), m2: view([row()]) } });
  await page.addScriptTag({ content: "window.__afterAnswer = (cards) => { cards.m2 = { kind: 'single', event_id: 'e', refused: 'This card repeats a request that was already answered.', rows: [] }; };" });
  const cards = page.locator('.sealed-card');
  await expect(cards.getByRole('button', { name: 'Deny' })).toHaveCount(2);
  await cards.first().getByRole('button', { name: 'Deny' }).click();
  await expect(cards.first().getByRole('status')).toHaveText('Denied');
  await expect(page.getByText('This card repeats a request that was already answered.')).toBeVisible();
  await expect(page.locator('.sealed-card').getByRole('button', { name: /Deny|approve/i })).toHaveCount(0);
});

test('a permanent child token says so, with its purpose and destination', async ({ page }) => {
  const mint = row({ credential: 'cf-parent', action: 'mint.cloudflare', ttl_s: 60, scope: 'Mint a permanent read-only token for example-bucket',
    payload: { v: 1, template: 'r2-read', bucket: 'example-bucket', child_ttl_s: null, purpose: 'nightly backup check', destination: 'sealed:example-r2-read', then: 'seal' } });
  const short = row({ rid: 'r3'.padEnd(32, '0'), credential: 'cf-parent2', action: 'mint.cloudflare', ttl_s: 60, scope: 'Mint a one-hour child', payload: { template: 'r2-read', child_ttl_s: 3600 } });
  await boot(page, { messages: [msg('m1', single(), now() - 60), msg('m2', single(), now() - 30)], cards: { m1: view([mint]), m2: view([short]) } });
  const c = card(page, 'Approve use of cf-parent');
  // the warning stays in sight on the closed card; the purpose is what it's for
  await expect(c.getByRole('note')).toHaveText(/This makes a permanent token\. It keeps working until someone revokes it\./);
  await expect(c.locator('.cc-what')).toHaveText('nightly backup check');
  await details(c);
  await expect(c.locator('dt', { hasText: /^Child token$/ }).locator('+ dd')).toHaveText('permanent');
  await expect(c.locator('dt', { hasText: /^Purpose$/ }).locator('+ dd')).toHaveText('nightly backup check');
  await expect(c.locator('dt', { hasText: /^Destination$/ }).locator('+ dd')).toHaveText('sealed:example-r2-read');
  await expect(c.locator('dt', { hasText: /^Window$/ }).locator('+ dd')).toHaveText('60 s, 1 use');
  const s = card(page, 'Approve use of cf-parent2');
  await expect(s.getByRole('note')).toHaveCount(0);
  await details(s);
  await expect(s.locator('dt', { hasText: /^Child token$/ }).locator('+ dd')).toHaveText('expires after 60 min');
  await shot(page, 'permanent');
});

test('the morning card: each routine kind is its own grant; switching one off leaves it out, and one tap sends the rest', async ({ page }) => {
  const rows = ['r2-backups', 'pages-deploy', 'dns-read'].map((n, i) => row({ rid: `m${i}`.padEnd(32, '0'), credential: n, action: ['r2.list', 'deploy.pages', 'dns.read'][i], class: 'routine', ttl_s: 50400, uses: 200, scope: `Routine ${n} for today`, payload: null, request_digest: `${i}0aa11bb`.padEnd(64, 'c'), expires: now() + 3600 }));
  await boot(page, { messages: [msg('m1', fence('uni-sealed-morning', "🔑 **Uni's morning card**: 3 routine credential(s) for today"), now() - 30)], cards: { m1: view(rows, 'morning') } });
  const c = card(page, "Uni's morning card");
  // T-335: one row naming every credential, the count on its button; the per-row switches are behind details
  await expect(c.locator('.cc-what')).toHaveText('Morning card: r2-backups, pages-deploy, dns-read');
  await expect(c.getByRole('switch')).toHaveCount(0);
  await details(c);
  const switches = c.getByRole('switch');
  await expect(switches).toHaveCount(3);
  for (const r of rows) await expect(c.getByRole('switch', { name: `Grant ${r.credential} for ${r.action}` })).toBeChecked();
  await expect(c.getByText('14 h, 200 uses').first()).toBeVisible();
  // never one blanket "approve everything": the button counts what is switched on
  await expect(c.getByRole('button', { name: /approve all|everything/i })).toHaveCount(0);
  await expect(c.getByRole('button', { name: 'Approve 3 of 3' })).toBeVisible();
  await c.getByRole('switch', { name: 'Grant pages-deploy for deploy.pages' }).uncheck();
  await shot(page, 'morning-before');
  await c.getByRole('button', { name: 'Approve 2 of 3' }).click();
  await expect(line(c)).toHaveText(/^✓Approved 2 of 3 · Morning card · \d{1,2}:\d{2}(\s?[AP]M)?$/);
  await expect(c.locator('details')).not.toHaveAttribute('open');
  await line(c).click();
  await expect(c.getByText(/^Approved · open until/)).toHaveCount(2);
  await expect(c.getByText('Left out')).toHaveCount(1);
  await expect(c.getByRole('switch')).toHaveCount(0);
  const sent = await answers(page);
  expect(sent.map((s) => [s.args.decision, s.args.rids])).toEqual([['approve', [rows[0].rid, rows[2].rid]]]);
  await shot(page, 'morning-after');
});

test('the morning card: all switched off sends nothing; Deny all denies every row', async ({ page }) => {
  const rows = ['r2-backups', 'dns-read'].map((n, i) => row({ rid: `n${i}`.padEnd(32, '0'), credential: n, class: 'routine', ttl_s: 3600, payload: null, expires: now() + 3600 }));
  await boot(page, { messages: [msg('m1', fence('uni-sealed-morning', "🔑 **Uni's morning card**"), now() - 30)], cards: { m1: view(rows, 'morning') } });
  const c = card(page, "Uni's morning card");
  await details(c);
  await expect(c.getByRole('switch')).toHaveCount(2);
  for (const s of await c.getByRole('switch').all()) await s.uncheck();
  await expect(c.getByRole('button', { name: 'Nothing chosen' })).toBeDisabled();
  await c.getByRole('button', { name: 'Deny all' }).click();
  await expect(c.getByRole('status')).toHaveText('Denied');
  await line(c).click();
  await expect(c.locator('.sealed-row-status')).toHaveText(['Denied', 'Denied']);
  expect((await answers(page)).map((s) => [s.args.decision, s.args.rids])).toEqual([['deny', rows.map((r) => r.rid)]]);
});

test('a send that fails says so; Try again sends the same decision', async ({ page }) => {
  await boot(page, { messages: [msg('m1', single(), now() - 30)], cards: { m1: view([row({ class: 'routine', credential: 'r2-backups', ttl_s: 60 })]) }, failures: 1 });
  const c = card(page, 'Approve use of r2-backups');
  await c.getByRole('button', { name: 'Approve' }).click();
  await expect(c.getByRole('alert')).toHaveText('Not sent: relay unreachable: connection refused');
  await expect(c.getByText('Approved · not sent yet')).toBeVisible();
  await expect(c.getByRole('button', { name: /^(Approve|Deny)$/ })).toHaveCount(0);
  await c.getByRole('button', { name: 'Try again' }).click();
  await expect(c.getByRole('status')).toHaveText('Approved');
  await expect(c.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  expect((await answers(page)).map((s) => s.args.decision)).toEqual(['approve', 'approve']);
});

test('a send that failed and a card that then expired: Expired, and no Try again that could never work', async ({ page }) => {
  await page.clock.install();
  await boot(page, { messages: [msg('m1', single(), now() - 30)], cards: { m1: view([row({ class: 'routine', credential: 'r2-backups', ttl_s: 60, expires: now() + 120 })]) }, failures: 1 });
  const c = card(page, 'Approve use of r2-backups');
  await c.getByRole('button', { name: 'Approve' }).click();
  await expect(c.getByText('Approved · not sent yet')).toBeVisible();
  await expect(c.getByRole('button', { name: 'Try again' })).toBeVisible();
  await page.clock.fastForward('03:00');
  // T-335: the line says the approval never reached Uni
  await expect(c.getByRole('status')).toHaveText('Expired · approval not sent');
  await expect(c.getByRole('button', { name: 'Try again' })).toHaveCount(0);
});

test('a waiting card is flagged over the composer and Show brings it into view', async ({ page }) => {
  const waiting = [{ ref: 'm1', channel: 'test', root: null, ts: now() - 30, kind: 'single', credential: 'dns-zone', action: 'dns.edit', class: 'powerful', rows: 1, expires: now() + 900, fingerprint: '9b13b2ae' }];
  await boot(page, { messages: [msg('m1', single(), now() - 30)], cards: { m1: view([row()]) }, waiting });
  const banner = page.locator('.approval-banner');
  await expect(banner).toContainText('Uni asks for your tap: dns-zone · dns.edit. Answer on its card · ends');
  await banner.getByRole('button', { name: 'Show' }).click();
  await expect(card(page, 'Approve use of dns-zone')).toBeInViewport();
  await expect(page.locator('article.approval-waiting[data-ref="m1"]')).toHaveCount(1);
  await card(page, 'Approve use of dns-zone').getByRole('button', { name: 'Deny' }).click();
  await expect(banner).toHaveCount(0);
});

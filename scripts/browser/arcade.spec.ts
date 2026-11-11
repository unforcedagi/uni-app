// T-335 Taste Arcade in the app, on applet contract 2 (its grant card, its port), with Rust faked (`arcade_*`, `journal_save_voice`, `journal_save_text`; the door itself
// is proven end to end in the taste-arcade repo). Reachable from the Applets drawer; a burst
// of This or That saves each pick once; Gallery, Fix It and Who Said It save what was played; a Ripple voice answer files a journal voice entry and the reaction names the
// note it landed in, never its words; the Garden's "Not me" saves a verdict and the plant moves to the Not me patch.
// Synthetic cards and words only.
import { test, expect, type Page } from '@playwright/test';
import { bootAreas } from './areasFixture';
import { bar } from './shapeNav';

const pal = (id: string, title: string, colors: string[], features: string[]) => ({ id, kind: 'palette', domain: 'visual', title, features, source: 'generated', palette: colors });
const ASK = { dimension: 'colour', prompt: 'Which colours feel more like you?', detail: 'Same little landscape on both. Only the colours change.' };
const ASK_GREY = { dimension: 'value', prompt: 'Which light and dark feels more like you?', detail: 'Same little landscape, in greys. Only the tones change.' };
const TONAL = [pal('t-ember', 'Ember', ['#6b6b6b', '#cccccc', '#444444'], ['visual:dark']), pal('t-glacier', 'Glacier', ['#c0c0c0', '#f8f8f8', '#555555'], ['visual:light-paper'])];
const CARDS = [
  pal('t-ember', 'Ember', ['#a3542a', '#e8c48f', '#5b3a29'], ['visual:warm', 'visual:earthy']),
  pal('t-glacier', 'Glacier', ['#9ec9e6', '#f4f8fb', '#3c5a73'], ['visual:cool', 'visual:clinical']),
  pal('t-moss', 'Moss', ['#4f6b3a', '#c9d3a8', '#2c3a22'], ['visual:earthy', 'visual:muted']),
  pal('t-neon', 'Neon', ['#ff2bd6', '#1b1b3a', '#2bfff1'], ['visual:neon', 'visual:vivid']),
];
const ASK_Q = { dimension: 'systems', prompt: 'How should this work?', detail: "No right answer. It's your system, in your words." };
const QUESTION = { id: 't-q1', kind: 'question', domain: 'systems', title: 'Away', text: 'When you are away for a week, what should happen to what arrives?', features: ['systems:calm'], source: 'generated' };
const CLAIMS = [
  { id: 'visual:warm+', domain: 'visual', text: 'Warm colour: clay, ember, late sun.', weight: 0.7, evidence: 6, status: 'live', quotes: ['made-up words about sun'] },
  { id: 'motion:slow+', domain: 'motion', text: 'Slow motion, like breathing.', weight: 0.6, evidence: 4, status: 'live', quotes: [] },
  { id: 'words:plain+', domain: 'words', text: 'Plain words, short sentences.', weight: 0.5, evidence: 3, status: 'live', quotes: [] },
];
const NOTE_ID = '01M6QAF6FYXD39R6BP1TW2TEST';
const ASK_GAL = { dimension: 'visual', prompt: 'Does this one pull you?', detail: 'Pin what pulls. Drift past the rest.' };
const GALLERY = [
  { id: 't-img-a', kind: 'image', domain: 'visual', title: 'Made-up fern', features: ['visual:organic'], source: 'generated', media: { src: 't-img-a' } },
  { id: 't-img-b', kind: 'image', domain: 'visual', title: 'Made-up sign', features: ['visual:neon'], source: 'generated', media: { src: 't-img-b' } },
];
const ASK_FIX = { dimension: 'words', prompt: 'What would you change?', detail: 'Nudge it until it feels right.' };
const FIX = {
  id: 't-fix', kind: 'artifact', domain: 'words', title: 'A made-up welcome', features: [], source: 'generated',
  artifact: {
    template: 'copy', params: { tone: 0.7, length: 0.6 }, hunch: 'made-up hunch: too stiff',
    axes: [{ key: 'tone', low: 'human', high: 'corporate', feature: 'words:corporate' }, { key: 'length', low: 'shorter', high: 'longer', feature: 'words:long' }],
    variants: { 'high-high': 'Made-up long stiff welcome.', 'high-low': 'Made-up stiff welcome.', 'low-high': 'Made-up long warm welcome.', 'low-low': 'Made-up warm welcome.', mid: 'Made-up welcome.' },
    text: { title: 'First screen', body: 'Get started' },
  },
};
const ASK_WHO = { dimension: 'words', prompt: 'Who wrote this line?', detail: 'You, or Uni writing as you?' };
const VOICES = [
  { id: 't-v-own', kind: 'voice', domain: 'words', title: 'Porch', text: 'A made-up line about a coat by the door.', features: ['words:plain'], source: 'generated', voice: { by: 'owner', origin: 'an invented post' } },
  { id: 't-v-uni', kind: 'voice', domain: 'words', title: 'Unlock', text: 'A made-up line about unlocking potential.', features: ['words:hype'], source: 'generated', voice: { by: 'uni', tell: 'Made-up tell: too tidy.' } },
];

async function boot(page: Page) {
  await page.addInitScript(({ cards, tonal, ask, askGrey, askQ, question, claims, noteId, gallery, askGal, fix, askFix, voices, askWho }) => {
    const w = window as any;
    w.__arcadeBurst = 6;
    w.__arcade = [];
    const stats = () => ({ reactions: w.__arcade.length, seeds: 10 + w.__arcade.length, byGame: {}, guesses: { right: 0, total: 0 } });
    const profile = () => {
      const cs = claims.map((c: any) => ({ ...c }));
      for (const r of w.__arcade) if (r.kind === 'claim') { const c = cs.find((x: any) => x.id === r.claim.id); if (c) c.status = r.claim.verdict === 'me' ? 'live' : r.claim.verdict === 'not-me' ? 'not-me' : 'pruned'; }
      return { updated: '2026-11-05T12:00:00Z', by: 'local', summary: 'Made-up summary: warm, slow, plain.', claims: cs, reactions: w.__arcade.length, answers: [] };
    };
    let n = 0;
    w.__extraInvoke = async (cmd: string, args: any) => {
      if (cmd === 'arcade_home') return { stats: stats(), fresh: { 'this-or-that': 2, gallery: 0, 'fix-it': 0, 'who-said-it': 0, ripple: 1 }, games: {}, profile: {}, look: w.__look ?? [] };
      if (cmd === 'arcade_rounds') {
        if (args.game === 'this-or-that' && args.grey) return { rounds: Array.from({ length: args.n }, () => ({ game: 'this-or-that', a: tonal[0], b: tonal[1], ask: askGrey })) };
        if (args.game === 'this-or-that') return { rounds: Array.from({ length: args.n }, (_, i) => { const a = cards[(2 * i + n++) % 4], b = cards[(2 * i + 1 + n) % 4]; return { game: 'this-or-that', a, b: b.id === a.id ? cards[(cards.indexOf(a) + 1) % 4] : b, ask }; }) };
        if (args.game === 'ripple') return { rounds: [{ game: 'ripple', card: question, ask: askQ }] };
        // look here: the pinned card's round first, as the door deals it
        if (args.game === 'gallery') return { rounds: [...gallery].sort((a: any, b: any) => (b.id === args.look ? 1 : 0) - (a.id === args.look ? 1 : 0)).map((card: any) => ({ game: 'gallery', card, ask: askGal })) };
        if (args.game === 'fix-it') return { rounds: [{ game: 'fix-it', card: fix, ask: askFix }] };
        if (args.game === 'who-said-it') return { rounds: voices.map((card: any) => ({ game: 'who-said-it', card, ask: askWho })) };
        return { rounds: [] };
      }
      if (cmd === 'arcade_react') { w.__arcade.push(...args.reactions); return { ok: true, stored: args.reactions.length, stats: stats() }; }
      if (cmd === 'arcade_profile') return { profile: profile(), markdown: '# Taste profile', note: w.__profileNote ?? { vault: 'uni', path: 'Taste/Profile' } };
      if (cmd === 'arcade_distill') return { queued: true };
      if (cmd === 'arcade_media') return new ArrayBuffer(8);
      if (cmd === 'journal_save_voice') { await new Promise((r) => setTimeout(r, w.__saveDelay ?? 0)); return { sent: [noteId], remaining: 0, error: null }; }
      if (cmd === 'journal_save_text') return { sent: [noteId], remaining: 0, error: null };
      return undefined;
    };
    // a microphone that hears a quiet tone, so the app's own recorder session runs for real
    const md = navigator.mediaDevices ?? ((navigator as any).mediaDevices = {});
    // __micDelay: a mic slow to open, as a phone's can be. __tracks: every track handed out, to see the mic was let go.
    w.__tracks = [];
    md.getUserMedia = async () => { await new Promise((r) => setTimeout(r, w.__micDelay ?? 0)); const ctx = new AudioContext(); const o = ctx.createOscillator(); const d = ctx.createMediaStreamDestination(); o.connect(d); o.start(); w.__tracks.push(...d.stream.getTracks());
      // __leaveInTheGap: the game's way out is tapped after the mic opens and before the screen has said so
      if (w.__leaveInTheGap) { w.__leaveInTheGap = false; const mc = new MessageChannel(); mc.port1.onmessage = () => { w.__leftInTheGap = !document.querySelector('.ta-rip.is-listening'); (document.querySelector('.ta-game .ta-back') as HTMLElement)?.click(); }; mc.port2.postMessage(0); }
      return d.stream; };
  }, { cards: CARDS, tonal: TONAL, ask: ASK, askGrey: ASK_GREY, askQ: ASK_Q, question: QUESTION, claims: CLAIMS, noteId: NOTE_ID, gallery: GALLERY, askGal: ASK_GAL, fix: FIX, askFix: ASK_FIX, voices: VOICES, askWho: ASK_WHO });
  await bootAreas(page, 'seed', { tree: true, tasks: true, briefs: true });
}
const reactions = (page: Page) => page.evaluate(() => (window as any).__arcade as any[]);
const calls = (page: Page, cmd: string) => page.evaluate((c) => (window as any).__calls.filter((x: any) => x.cmd === c).map((x: any) => x.args), cmd);
const tap = async (page: Page, loc: ReturnType<Page['locator']>, timeout?: number) => { if (test.info().project.name === 'phone') await loc.tap({ timeout }); else await loc.click({ timeout }); };

const card = (page: Page) => page.getByRole('region', { name: 'Arcade is asking for access' });
const granted = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('uni.interface.grants.v2') ?? '{}')['builtin:arcade'] ?? null);
const arcadeCalls = (page: Page) => page.evaluate(() => (window as any).__calls.filter((x: any) => /^arcade_|^journal_save/.test(x.cmd)).map((x: any) => x.cmd));

/** The drawer's Arcade tile: the Arcade's frame, with its grant card on a device that hasn't allowed it. */
async function openTile(page: Page) {
  // every applet opens from the Applets drawer, in the applet frame, on a phone as on a desktop
  await bar(page).getByRole('button', { name: /^Applets/ }).click();
  await tap(page, page.getByRole('dialog', { name: 'Applets' }).getByRole('button', { name: /^Arcade$/ }));
  await expect(page.locator('.sh-ap-top h1')).toHaveText('Arcade');
}
async function openArcade(page: Page) {
  await openTile(page);
  // contract 2: nothing of the Arcade runs until its card is allowed (a fresh device asks; one that allowed it goes straight in)
  if (!(await granted(page))) await tap(page, card(page).getByRole('button', { name: 'Allow' }));
  await expect(page.locator('.sh-ap-frame .ta-home')).toBeVisible();
}

test('contract 2: the card names exactly what the Arcade is granted; nothing runs before Allow; Allow is remembered', async ({ page }) => {
  await boot(page);
  await openTile(page);
  await expect(card(page)).toBeVisible();
  await expect(card(page).getByRole('heading')).toHaveText('Arcade asks for access');
  const rows = card(page).locator('.grant-line');
  await expect(rows.locator('dt')).toHaveText(['Arcade door, on the box', 'Arcade door, on the box', 'uni vault', 'uni vault', 'This device']);
  await expect(rows.locator('dd')).toHaveText([
    "See what's new and your counts · deal rounds · read your taste profile · show a card's picture, sound or clip",
    'Save your reactions · ask for a fresh taste profile',
    'Add notes in Journal/ (only the ones it made)', 'Read notes in Taste/', 'Record your voice when you ask it to']);
  // what changes something is marked; what only reads is not
  await expect(card(page).locator('dd.grant-outside')).toHaveText(['Save your reactions · ask for a fresh taste profile', 'Add notes in Journal/ (only the ones it made)']);
  // there is nothing to review or revoke yet
  await expect(page.locator('.sh-ap-frame').getByRole('button', { name: 'Access' })).toHaveCount(0);
  await expect(card(page)).toContainText('Nothing else. A call to any other door, vault or folder is refused.');
  await expect(card(page)).toContainText(/Lasts until .*20\d\d, or until you revoke it · Grant [0-9a-f]{4} [0-9a-f]{4}/);
  // the card fits the screen: both answers are in view without scrolling the page
  await expect(card(page).getByRole('button', { name: 'Allow' })).toBeInViewport({ ratio: 1 });
  if (process.env.T335_SHOTS) await page.screenshot({ path: `${process.env.T335_SHOTS}/${test.info().project.name}-grant-card.png` });
  // nothing of the Arcade has run: no game on screen, no call to the door
  await expect(page.locator('.ta-arcade')).toHaveCount(0);
  expect(await arcadeCalls(page)).toEqual([]);
  // Not now: still nothing, nothing stored, and it can be asked again
  await tap(page, card(page).getByRole('button', { name: 'Not now' }));
  await expect(page.locator('.sh-ap-gate')).toContainText("Arcade isn't allowed to run");
  expect(await granted(page)).toBeNull();
  expect(await arcadeCalls(page)).toEqual([]);
  await tap(page, page.getByRole('button', { name: 'Ask again' }));
  // a script's click is not the owner's tap
  await card(page).getByRole('button', { name: 'Allow' }).evaluate((b: HTMLElement) => b.click());
  expect(await granted(page)).toBeNull();
  await tap(page, card(page).getByRole('button', { name: 'Allow' }));
  await expect(page.locator('.sh-ap-frame .ta-home')).toBeVisible();
  const g = await granted(page);
  expect(g).toMatchObject({ html: 'builtin' });
  expect(g.scope).toMatch(/^[0-9a-f]{64}$/);
  expect(Date.parse(g.expires) - Date.parse(g.grantedAt)).toBe(365 * 86_400_000);
  // remembered: after a restart the Arcade opens with no card
  await page.reload();
  await openTile(page);
  await expect(page.locator('.sh-ap-frame .ta-home')).toBeVisible();
  await expect(card(page)).toHaveCount(0);
});

test('contract 2: in the running app a call outside the grant is refused, and one inside goes through', async ({ page }) => {
  await boot(page);
  // the door answers with a profile note outside what the Arcade may open (it may read Taste/ in the owner's vault, nothing else)
  await page.addInitScript(() => { (window as any).__profileNote = { vault: 'uni', path: 'Journal/2026/11-11/09-00 Made-up private entry' }; });
  await page.reload();
  await openArcade(page);
  const refusals: string[] = [];
  page.on('console', (m) => { if (m.type() === 'warning' && m.text().includes('[applet arcade] refused')) refusals.push(m.text()); });
  await tap(page, page.locator('[data-toy="garden"]'));
  await tap(page, page.getByRole('button', { name: 'Open the note' }));
  await expect.poll(() => refusals.length).toBe(1);
  expect(refusals[0]).toContain('out_of_scope');
  await expect(page.locator('.sh-ap-frame .ta-arcade')).toBeVisible(); // still in the Arcade: no note opened
  const opened = () => page.evaluate(() => (window as any).__calls.filter((x: any) => x.cmd === 'vault_note').map((x: any) => String(x.args.noteRef)));
  expect((await opened()).filter((r) => /private entry|Taste\/Profile/.test(r))).toEqual([]);
  // another vault altogether
  await page.evaluate(() => { (window as any).__profileNote = { vault: 'elsewhere', path: 'Taste/Profile' }; });
  await tap(page, page.getByRole('button', { name: 'Open the note' }));
  await expect.poll(() => refusals.length).toBe(2);
  expect(refusals[1]).toContain('not_granted');
  // the note it was granted opens
  await page.evaluate(() => { (window as any).__profileNote = { vault: 'uni', path: 'Taste/Profile' }; });
  await tap(page, page.getByRole('button', { name: 'Open the note' }));
  await expect.poll(opened).toContain('Taste/Profile');
  expect((await opened()).filter((r) => /private entry/.test(r))).toEqual([]);
  expect(refusals.length).toBe(2);
});

test('contract 2: Access shows what was granted; Revoke access stops the Arcade and the card comes back; other access asks again', async ({ page }) => {
  await boot(page);
  await openArcade(page);
  await tap(page, page.locator('[data-toy="garden"]'));
  await expect(page.locator('.ta-game')).toBeVisible();
  await tap(page, page.locator('.sh-ap-frame').getByRole('button', { name: 'Access' }));
  const review = page.getByRole('region', { name: 'What Arcade may reach' });
  await expect(review.locator('.grant-line')).toHaveCount(5);
  await expect(review).toContainText(/Allowed .*20\d\d · until .*20\d\d · Grant [0-9a-f]{4} [0-9a-f]{4}/);
  if (process.env.T335_SHOTS) await page.screenshot({ path: `${process.env.T335_SHOTS}/${test.info().project.name}-grant-review.png` });
  // Done: back in the game that was open, not a fresh Arcade
  await tap(page, review.getByRole('button', { name: 'Done' }));
  await expect(page.locator('.ta-game')).toBeVisible();
  await tap(page, page.locator('.sh-ap-frame').getByRole('button', { name: 'Access' }));
  const before = (await arcadeCalls(page)).length;
  await tap(page, review.getByRole('button', { name: 'Revoke access' }));
  await expect(page.locator('.ta-arcade')).toHaveCount(0);
  await expect(page.locator('.sh-ap-gate')).toContainText("Arcade isn't allowed to run");
  await expect(page.locator('.sh-ap-frame').getByRole('button', { name: 'Access' })).toHaveCount(0);
  expect(await granted(page)).toBeNull();
  await tap(page, page.getByRole('button', { name: 'Ask again' }));
  await expect(card(page)).toBeVisible();
  expect((await arcadeCalls(page)).length).toBe(before);
  // a grant made for other access (an older release's manifest) is not this one: the card asks again
  await tap(page, card(page).getByRole('button', { name: 'Allow' }));
  await expect(page.locator('.sh-ap-frame .ta-home')).toBeVisible();
  await page.evaluate(() => { const all = JSON.parse(localStorage.getItem('uni.interface.grants.v2')!); all['builtin:arcade'].scope = 'f'.repeat(64); localStorage.setItem('uni.interface.grants.v2', JSON.stringify(all)); });
  await page.reload();
  await openTile(page);
  await expect(card(page)).toBeVisible();
  await expect(page.locator('.ta-arcade')).toHaveCount(0);
  // and so is one past its date
  await page.evaluate(() => { const all = JSON.parse(localStorage.getItem('uni.interface.grants.v2')!); delete all['builtin:arcade']; localStorage.setItem('uni.interface.grants.v2', JSON.stringify(all)); });
  await tap(page, card(page).getByRole('button', { name: 'Allow' }));
  await expect(page.locator('.sh-ap-frame .ta-home')).toBeVisible();
  await page.evaluate(() => { const all = JSON.parse(localStorage.getItem('uni.interface.grants.v2')!); all['builtin:arcade'].expires = '2026-01-01T00:00:00.000Z'; localStorage.setItem('uni.interface.grants.v2', JSON.stringify(all)); });
  await page.reload();
  await openTile(page);
  await expect(card(page)).toBeVisible();
});

test('the Arcade opens from the app, a burst saves each pick once, and the way back returns to where you were', async ({ page }) => {
  test.setTimeout(90_000); // a timed burst, played tap by tap
  await boot(page);
  await openArcade(page);
  await expect(page.locator('.ta-toy')).toHaveCount(6);
  if (process.env.T335_SHOTS) await page.screenshot({ path: `${process.env.T335_SHOTS}/${test.info().project.name}-arcade-home.png` });
  await tap(page, page.locator('[data-toy="this-or-that"]'));
  const sides = page.locator('.ta-side-hit');
  let picks = 0;
  while (!(await page.locator('.ta-end').isVisible())) {
    if (await sides.first().isEnabled({ timeout: 300 }).catch(() => false)) { await tap(page, sides.first(), 1500).catch(() => undefined); picks++; await page.waitForTimeout(550); }
    else await page.waitForTimeout(100);
    expect(picks).toBeLessThan(40);
  }
  const rs = await reactions(page);
  expect(rs.length).toBeGreaterThanOrEqual(1);
  for (const r of rs) { expect(r).toMatchObject({ game: 'this-or-that', kind: 'pick' }); expect(r.other).not.toBe(r.card); }
  expect(new Set(rs.map((r) => r.id)).size).toBe(rs.length);
  // each reaction went to Rust once
  expect((await calls(page, 'arcade_react')).flatMap((a: any) => a.reactions).length).toBe(rs.length);
  await tap(page, page.locator('.ta-arcade').getByRole('button', { name: 'Arcade' }).first());
  // the Arcade has no Back of its own; the applet frame's "Back to applets" is the way out
  await expect(page.locator('.ta-home')).toBeVisible();
  await expect(page.locator('.ta-home').getByRole('button', { name: /leave|back|close/i })).toHaveCount(0);
  await tap(page, page.locator('.sh-ap-frame').getByRole('button', { name: 'Back to applets' }));
  await expect(page.locator('.sh-ap-frame')).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Applets' })).toBeVisible();
});

test('in the app: a pair says what it asks; the greyscale switch reaches the door, and a pick is marked', async ({ page }) => {
  await boot(page);
  await openArcade(page);
  await tap(page, page.locator('[data-toy="this-or-that"]'));
  await expect(page.locator('.ta-ask h2')).toHaveText('Which colours feel more like you?');
  await expect(page.locator('.ta-tot')).toHaveAttribute('data-dimension', 'colour');
  // the way out for a screen with no colour
  await tap(page, page.getByRole('button', { name: /Switch to greyscale/ }));
  await expect(page.locator('.ta-ask h2')).toHaveText('Which light and dark feels more like you?');
  expect((await calls(page, 'arcade_rounds')).pop()).toMatchObject({ game: 'this-or-that', grey: true });
  await tap(page, page.locator('.ta-side-hit').first());
  await expect.poll(async () => (await reactions(page)).length).toBe(1);
  expect((await reactions(page))[0]).toMatchObject({ grey: true, dimension: 'value' });
  // the home asks for what greyscale can deal, and the switch shows on
  await tap(page, page.locator('.ta-arcade').getByRole('button', { name: 'Arcade' }).first());
  await expect(page.getByRole('switch', { name: /Greyscale screen/ })).toHaveAttribute('aria-checked', 'true');
  await expect.poll(async () => (await calls(page, 'arcade_home')).pop()).toMatchObject({ grey: true });
  if (process.env.T335_SHOTS) await page.screenshot({ path: `${process.env.T335_SHOTS}/${test.info().project.name}-arcade-grey.png` });
});

test('the calm screen (how a Daylight is set up) plays in greyscale without being asked', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('uni.motion', 'calm'));
  await boot(page);
  await openArcade(page);
  await expect(page.getByRole('switch', { name: /Greyscale screen/ })).toHaveAttribute('aria-checked', 'true');
  await tap(page, page.locator('[data-toy="this-or-that"]'));
  await expect(page.locator('.ta-tot')).toHaveAttribute('data-dimension', 'value');
  expect((await calls(page, 'arcade_rounds')).pop()).toMatchObject({ grey: true, still: true });
});

test('Ripple out loud files a journal voice entry; the reaction names the note, never its words', async ({ page }) => {
  await boot(page);
  await openArcade(page);
  await tap(page, page.locator('[data-toy="ripple"]'));
  await tap(page, page.getByRole('button', { name: 'Answer out loud' }));
  await expect(page.locator('.ta-rip.is-listening')).toBeVisible();
  await page.waitForTimeout(1200);
  await tap(page, page.getByRole('button', { name: /Keep it: stop/ }));
  await expect(page.getByText('In your journal. Uni will fold it into Systems.')).toBeVisible();
  const voice = await calls(page, 'journal_save_voice');
  expect(voice).toHaveLength(1);
  const rs = await reactions(page);
  expect(rs).toHaveLength(1);
  expect(rs[0]).toMatchObject({ game: 'ripple', kind: 'voice', card: QUESTION.id, voice: { ref: NOTE_ID } });
  expect(rs[0].words).toBeUndefined();
});

test('Ripple typed files a journal text entry; the reaction names the note, never its words', async ({ page }) => {
  await boot(page);
  await openArcade(page);
  await tap(page, page.locator('[data-toy="ripple"]'));
  await tap(page, page.getByRole('button', { name: /Write it instead/ }));
  await page.getByLabel('Your answer').fill('Made-up: hold it all until Monday.');
  await tap(page, page.getByRole('button', { name: 'Keep it' }));
  await expect(page.getByText('In your journal. Uni will fold it into Systems.')).toBeVisible();
  const text = await calls(page, 'journal_save_text');
  expect(text).toHaveLength(1);
  expect(text[0].entry.content).toBe('Made-up: hold it all until Monday.');
  expect(text[0].saveAnother).toBe(true);
  const sent = (await calls(page, 'arcade_react')).flatMap((a: any) => a.reactions);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ game: 'ripple', kind: 'voice', card: QUESTION.id, voice: { ref: NOTE_ID } });
  expect(JSON.stringify(sent)).not.toContain('Monday');
});

test('Garden: "Not me" saves a verdict and moves the plant to the patch at once', async ({ page }) => {
  await boot(page);
  await openArcade(page);
  await tap(page, page.locator('[data-toy="garden"]'));
  const plant = page.locator('.ta-plant[data-claim="visual:warm+"]');
  await plant.scrollIntoViewIfNeeded();
  await tap(page, plant);
  await tap(page, page.getByRole('button', { name: 'Not me' }));
  await expect(page.locator('.ta-plant[data-claim="visual:warm+"]')).toHaveCount(0);
  await expect(page.locator('.ta-patch-item[data-claim="visual:warm+"]')).toBeVisible();
  expect((await reactions(page)).pop()).toMatchObject({ game: 'garden', kind: 'claim', claim: { id: 'visual:warm+', verdict: 'not-me' } });
  if (process.env.T335_SHOTS) await page.screenshot({ path: `${process.env.T335_SHOTS}/${test.info().project.name}-arcade-garden.png` });
});

test('Gallery: a pin with words and a pin without are saved, one per picture', async ({ page }) => {
  await boot(page);
  await openArcade(page);
  await tap(page, page.locator('[data-toy="gallery"]'));
  await tap(page, page.getByRole('button', { name: /Pin it/ }));
  await page.getByLabel(/What pulls you/).fill('made-up: the quiet middle');
  await tap(page, page.getByRole('button', { name: 'Drift on', exact: true }));
  await expect(page.locator('.ta-gal-where')).toHaveText(/^2 of/);
  await tap(page, page.getByRole('button', { name: /Pin it/ }));
  await tap(page, page.locator('.ta-arcade').getByRole('button', { name: 'Arcade' }).first());
  await expect(page.locator('.ta-home')).toBeVisible();
  await expect.poll(async () => (await reactions(page)).length).toBe(2);
  const rs = await reactions(page);
  expect(rs[0]).toMatchObject({ game: 'gallery', kind: 'pin', card: 't-img-a', words: 'made-up: the quiet middle' });
  expect(rs[1]).toMatchObject({ game: 'gallery', kind: 'pin', card: 't-img-b' });
  expect(rs[1].words).toBeUndefined();
});

test("Fix It: a nudge and a why are saved, and Uni's hunch shows beside them", async ({ page }) => {
  await boot(page);
  await openArcade(page);
  await tap(page, page.locator('[data-toy="fix-it"]'));
  const slider = page.getByRole('slider').first();
  await expect(slider).toBeVisible();
  const before = Number(await slider.inputValue());
  const box = (await slider.boundingBox())!;
  await page.mouse.move(box.x + ((before + 1) / 2) * box.width, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.05, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  const after = Number(await slider.inputValue());
  expect(before - after).toBeGreaterThan(0.3);
  await page.getByLabel(/In your words/).fill('made-up: less stiff');
  await tap(page, page.getByRole('button', { name: 'Done' }));
  await expect(page.locator('.ta-fix-hunch')).toContainText('made-up hunch: too stiff');
  await expect(page.locator('.ta-fix-words')).toContainText('made-up: less stiff');
  await expect.poll(async () => (await reactions(page)).length).toBe(1);
  const r = (await reactions(page))[0];
  expect(r).toMatchObject({ game: 'fix-it', kind: 'nudge', card: 't-fix', words: 'made-up: less stiff' });
  expect(r.nudges.tone).toBeCloseTo(after - before, 1);
});

test('Who Said It: each guess is scored against who wrote the line, and saved', async ({ page }) => {
  await boot(page);
  await openArcade(page);
  await tap(page, page.locator('[data-toy="who-said-it"]'));
  const seen: string[] = [];
  for (let i = 0; i < VOICES.length; i++) {
    const text = (await page.locator('.ta-who-line blockquote').textContent())!.trim();
    const card = VOICES.find((v) => v.text === text)!;
    seen.push(card.id);
    // always "I wrote that": right on the owner's line, wrong on Uni's
    await tap(page, page.getByRole('button', { name: 'I wrote that' }));
    await expect(page.locator('.ta-who-verdict b')).toHaveText(card.voice.by === 'owner' ? 'Right.' : 'Not this time.');
    await tap(page, page.getByRole('button', { name: /Next line|That's the stack/ }));
  }
  await expect.poll(async () => (await reactions(page)).length).toBe(VOICES.length);
  const rs = await reactions(page);
  expect(rs.map((r) => r.card).sort()).toEqual([...seen].sort());
  for (const r of rs) expect(r).toMatchObject({ game: 'who-said-it', kind: 'guess', guess: { said: 'owner', right: r.card === 't-v-own' } });
});

const liveMics = (page: Page) => page.evaluate(() => (window as any).__tracks.filter((t: MediaStreamTrack) => t.readyState === 'live').length);
const micOpens = (page: Page) => page.evaluate(() => (window as any).__tracks.length);

test('Ripple: two taps while the mic opens start one recording, and it can still be stopped', async ({ page }) => {
  await boot(page);
  await openArcade(page);
  await page.evaluate(() => { (window as any).__micDelay = 500; });
  await tap(page, page.locator('[data-toy="ripple"]'));
  // the second tap lands while the first is still waiting for the mic
  await page.locator('.ta-rip-mic').evaluate((b: HTMLButtonElement) => { b.click(); b.click(); });
  await expect(page.getByRole('button', { name: /Write it instead/ })).toBeDisabled(); // no way out of sight of Stop while it opens
  await expect(page.locator('.ta-rip.is-listening')).toBeVisible();
  await expect(page.getByLabel('Your answer')).toHaveCount(0);
  await page.waitForTimeout(800);
  await tap(page, page.getByRole('button', { name: /Keep it: stop/ }));
  await expect(page.getByText('In your journal. Uni will fold it into Systems.')).toBeVisible();
  expect(await calls(page, 'journal_save_voice')).toHaveLength(1);
  expect(await micOpens(page)).toBe(1);
  await expect.poll(() => liveMics(page)).toBe(0);
});

test('Ripple: leaving while the mic opens lets it go, and the next recording can start', async ({ page }) => {
  await boot(page);
  await openArcade(page);
  await page.evaluate(() => { (window as any).__micDelay = 1500; });
  await tap(page, page.locator('[data-toy="ripple"]'));
  await tap(page, page.getByRole('button', { name: 'Answer out loud' }));
  await tap(page, page.locator('.ta-arcade').getByRole('button', { name: 'Arcade' }).first());
  await expect(page.locator('.ta-home')).toBeVisible();
  expect(await micOpens(page)).toBe(0); // gone before the mic answered
  await expect.poll(() => micOpens(page)).toBe(1); // the mic has opened, with nobody left to hold it
  await expect.poll(() => liveMics(page)).toBe(0);
  // nothing is left holding the recording lock
  await page.evaluate(() => { (window as any).__micDelay = 0; });
  await tap(page, page.locator('[data-toy="ripple"]'));
  await tap(page, page.getByRole('button', { name: 'Answer out loud' }));
  await expect(page.locator('.ta-rip.is-listening')).toBeVisible();
  await tap(page, page.getByRole('button', { name: 'Throw it away' }));
  await expect.poll(() => liveMics(page)).toBe(0);
});

test('Ripple: leaving in the moment after the mic opens, before the screen shows it, lets it go too', async ({ page }) => {
  await boot(page);
  await openArcade(page);
  await tap(page, page.locator('[data-toy="ripple"]'));
  await page.evaluate(() => { const w = window as any; w.__micDelay = 200; w.__leaveInTheGap = true; });
  await tap(page, page.getByRole('button', { name: 'Answer out loud' }));
  await expect(page.locator('.ta-home')).toBeVisible();
  expect(await page.evaluate(() => (window as any).__leftInTheGap)).toBe(true);
  await expect.poll(() => liveMics(page)).toBe(0);
});

test('Ripple: the screen settling mid-answer (reduced motion, Calm) keeps the recording and its Stop', async ({ page }) => {
  await boot(page);
  await openArcade(page);
  await tap(page, page.locator('[data-toy="ripple"]'));
  await tap(page, page.getByRole('button', { name: 'Answer out loud' }));
  const stop = page.getByRole('button', { name: /Keep it: stop/ });
  await expect(stop).toBeVisible();
  await page.emulateMedia({ reducedMotion: 'no-preference' }); // the games deal again for a screen that changed
  await page.waitForTimeout(500);
  await expect(stop).toBeVisible();
  await page.waitForTimeout(800);
  await tap(page, stop);
  await expect(page.getByText('In your journal. Uni will fold it into Systems.')).toBeVisible();
  expect(await calls(page, 'journal_save_voice')).toHaveLength(1);
  await expect.poll(() => liveMics(page)).toBe(0);
});

test('Ripple: a second answer while the first is still saving is its own recording, with its own length', async ({ page }) => {
  test.setTimeout(60_000);
  await boot(page);
  await openArcade(page);
  await page.evaluate(() => { (window as any).__saveDelay = 4000; });
  await tap(page, page.locator('[data-toy="ripple"]'));
  await tap(page, page.getByRole('button', { name: 'Answer out loud' }));
  await page.waitForTimeout(1000);
  await tap(page, page.getByRole('button', { name: /Keep it: stop/ }));
  await expect(page.getByText('Keeping it…')).toBeVisible();
  await tap(page, page.locator('.ta-arcade').getByRole('button', { name: 'Arcade' }).first());
  await tap(page, page.locator('[data-toy="ripple"]'));
  await tap(page, page.getByRole('button', { name: 'Answer out loud' }));
  await page.waitForTimeout(1000);
  await tap(page, page.getByRole('button', { name: /Keep it: stop/ }));
  await expect.poll(() => liveMics(page)).toBe(0); // the second Stop stopped the second mic
  await expect(page.getByText('In your journal. Uni will fold it into Systems.')).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await calls(page, 'journal_save_voice')).length).toBe(2); // each answer saved
  await expect.poll(async () => (await reactions(page)).length).toBe(2);
  for (const r of await reactions(page)) expect(r.voice.seconds).toBeLessThan(3); // the time spoken, not the time saving
});

// T-335 look here: a room pins a card for the owner (uni-tasks `tasks.py look --board arcade`); the ask carries the pin's
// link, and the app opens it itself: the Arcade, on that card, dealt first by the door. Made-up host, room and words.
const PIN_URL = 'https://box.example.ts.net:8543/#look/t-img-b';
test('a look ask Open button opens the Arcade on the pinned card, in the app', async ({ page }) => {
  await page.addInitScript((url) => {
    const w = window as any;
    w.__look = [{ card: 't-img-b', game: 'gallery', title: 'Made-up sign', room: 'kiln-studio', why: 'Made-up: does the sign read from the road?', drops: '2026-12-01' }];
    w.__seedTasks = [{ id: 'fy-pin', path: 'Tasks/T-540 Look at this card', extension: 'md', tags: ['task'], fy: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      metadata: { state: 'open', owner: 'aaron', needs_aaron: true, kind: 'look', no_default: true, node: 'Areas/Kiln Studio', look_url: url, why_now: 'Made-up: does the sign read from the road?', asked_at: new Date().toISOString() } }];
  }, PIN_URL);
  await boot(page);
  // the ask is on a home row with an Open button; it opens the card in the app (the Applets drawer is not the way in here)
  const open = page.locator('.sh-ask').getByRole('button', { name: /^Open the link for .*Look at this card/ });
  await tap(page, open);
  // a device that hasn't allowed the Arcade sees its card first; the pinned card is still where it opens
  await tap(page, card(page).getByRole('button', { name: 'Allow' }));
  // the Arcade, on the pinned card: its round came first because the app asked the door for it by id
  await expect(page.locator('.sh-ap-frame .ta-game')).toBeVisible();
  await expect(page.locator('.ta-gal-where')).toHaveText(/^1 of/);
  await expect(page.getByRole('figure', { name: 'Made-up sign' })).toBeVisible();
  expect((await calls(page, 'arcade_rounds')).find((a: any) => a.game === 'gallery')).toMatchObject({ look: 't-img-b' });
  expect(await calls(page, 'open_link')).toHaveLength(0); // never handed to the system browser
  // back on the Arcade's home the pin says who asked and why; the next deal is plain play (no look)
  await tap(page, page.locator('.ta-arcade').getByRole('button', { name: 'Arcade' }).first());
  await expect(page.locator('.ta-look-pin')).toContainText('Look here · #kiln-studio');
  await tap(page, page.locator('[data-toy="gallery"]'));
  await expect(page.locator('.ta-gal-where')).toHaveText(/^1 of/);
  expect((await calls(page, 'arcade_rounds')).filter((a: any) => a.game === 'gallery').pop()?.look).toBeUndefined();
});

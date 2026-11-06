// T-335 Taste Arcade in the app, with Rust faked (`arcade_*`, `journal_save_voice`, `journal_save_text`; the door itself
// is proven end to end in the taste-arcade repo). Reachable from the rail at phone and desktop sizes; a burst
// of This or That saves each pick once; a Ripple voice answer files a journal voice entry and the reaction names the
// note it landed in, never its words; the Garden's "Not me" saves a verdict and the plant moves to the Not me patch.
// Synthetic cards and words only.
import { test, expect, type Page } from '@playwright/test';
import { bootAreas } from './areasFixture';

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

async function boot(page: Page) {
  await page.addInitScript(({ cards, tonal, ask, askGrey, askQ, question, claims, noteId }) => {
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
      if (cmd === 'arcade_home') return { stats: stats(), fresh: { 'this-or-that': 2, gallery: 0, 'fix-it': 0, 'who-said-it': 0, ripple: 1 }, games: {}, profile: {} };
      if (cmd === 'arcade_rounds') {
        if (args.game === 'this-or-that' && args.grey) return { rounds: Array.from({ length: args.n }, () => ({ game: 'this-or-that', a: tonal[0], b: tonal[1], ask: askGrey })) };
        if (args.game === 'this-or-that') return { rounds: Array.from({ length: args.n }, (_, i) => { const a = cards[(2 * i + n++) % 4], b = cards[(2 * i + 1 + n) % 4]; return { game: 'this-or-that', a, b: b.id === a.id ? cards[(cards.indexOf(a) + 1) % 4] : b, ask }; }) };
        if (args.game === 'ripple') return { rounds: [{ game: 'ripple', card: question, ask: askQ }] };
        return { rounds: [] };
      }
      if (cmd === 'arcade_react') { w.__arcade.push(...args.reactions); return { ok: true, stored: args.reactions.length, stats: stats() }; }
      if (cmd === 'arcade_profile') return { profile: profile(), markdown: '# Taste profile', note: { vault: 'uni', path: 'Taste/Profile' } };
      if (cmd === 'arcade_distill') return { queued: true };
      if (cmd === 'arcade_media') return new ArrayBuffer(8);
      if (cmd === 'journal_save_voice') return { sent: [noteId], remaining: 0, error: null };
      if (cmd === 'journal_save_text') return { sent: [noteId], remaining: 0, error: null };
      return undefined;
    };
    // a microphone that hears a quiet tone, so the app's own recorder session runs for real
    const md = navigator.mediaDevices ?? ((navigator as any).mediaDevices = {});
    md.getUserMedia = async () => { const ctx = new AudioContext(); const o = ctx.createOscillator(); const d = ctx.createMediaStreamDestination(); o.connect(d); o.start(); return d.stream; };
  }, { cards: CARDS, tonal: TONAL, ask: ASK, askGrey: ASK_GREY, askQ: ASK_Q, question: QUESTION, claims: CLAIMS, noteId: NOTE_ID });
  await bootAreas(page, 'seed', { tree: true, tasks: true, briefs: true });
  await page.locator('[data-place="front-door"]').waitFor();
}
const reactions = (page: Page) => page.evaluate(() => (window as any).__arcade as any[]);
const calls = (page: Page, cmd: string) => page.evaluate((c) => (window as any).__calls.filter((x: any) => x.cmd === c).map((x: any) => x.args), cmd);
const tap = async (page: Page, loc: ReturnType<Page['locator']>, timeout?: number) => { if (test.info().project.name === 'phone') await loc.tap({ timeout }); else await loc.click({ timeout }); };

async function openArcade(page: Page) {
  await tap(page, page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Arcade' }));
  await expect(page.locator('.arcade-place .ta-home')).toBeVisible();
}

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
  await tap(page, page.locator('.ta-home').getByRole('button', { name: /leave|back|close/i }).first());
  await expect(page.locator('.arcade-place')).toHaveCount(0);
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

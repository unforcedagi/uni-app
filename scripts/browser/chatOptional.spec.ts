// Life OS profile PR 3: chat.provider null hides every Buzz surface and makes no Buzz calls (fixture-based: a uni vault whose profile note says chat null).
import { mkdir } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import { areaCard, bootAreas } from './areasFixture';

const SHOTS = 'scripts/browser/__shots__/chat-optional';
const wide = (page: Page) => (page.viewportSize()?.width ?? 0) >= 900;
const panel = (page: Page) => page.locator('.th-panel');
const callsOf = (page: Page, ...cmds: string[]) => page.evaluate((c) => (window as any).__calls.filter((x: any) => c.includes(x.cmd)).map((x: any) => x.cmd + ' ' + JSON.stringify(x.args).slice(0, 100)), cmds);
const shot = async (page: Page, name: string) => { await mkdir(SHOTS, { recursive: true }); const s = page.viewportSize()!; await page.screenshot({ path: `${SHOTS}/${name}-${s.width}x${s.height}.png` }); };
const base = { briefs: true, tree: true, tasks: true, boulder: true, underBoulder: true, priya: true, pinned: true, layout: 'tree' } as const;
/** `note`: a uni vault whose profile note says chat null. `pack`: another vault with no profile note (the pack defaults: chat null from the first render). */
const boot = (page: Page, mode: 'buzz' | 'note' | 'pack') => bootAreas(page, 'seed', { ...base, ...(mode === 'note' ? { profileNote: { chat: { provider: null } } } : mode === 'pack' ? { lifeVault: 'pack' } : {}) });

/** Nothing of Buzz on screen. */
async function noBuzz(page: Page) {
  await expect(page.locator('.talk, .talk-hold')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Hold to talk|Open room|Open in #|Ask Uni/ })).toHaveCount(0);
  await expect(page.locator('.th-door, .th-roomline, .th-roomhead, .th-ledger, .steward, .node-room-dot, .th-sap, .th-sec.th-room, .th-sec.th-updates, .th-ask, .uni-router-rule')).toHaveCount(0);
  const text = await page.locator('body').innerText();
  for (const bad of [/Room #/, /held by #/, /Stewarded by/, /From the rooms below/, /Hold to talk/, /Ask Uni/, /@Uni/]) expect(text).not.toMatch(bad);
}

test.describe('chat optional (profile.chat.provider null)', () => {
  for (const mode of ['pack', 'note'] as const) test(`tree home (${mode}): no Buzz surface, no Buzz calls, tasks and nodes still work`, async ({ page }) => {
    await boot(page, mode);
    if (wide(page)) await expect(panel(page)).toBeVisible(); else await expect(page.locator('.th-phone-tree')).toBeVisible();
    await noBuzz(page);
    await shot(page, `${mode}-home`);
    if (wide(page)) await areaCard(page, 'Boulder').click(); else await page.getByRole('button', { name: /^Boulder,/ }).first().click();
    await expect(wide(page) ? page.locator('.node-core h1') : page.locator('.th-head h1')).toHaveText('Boulder');
    await expect(page.getByRole('region', { name: 'What needs doing here' })).toBeVisible();
    await noBuzz(page);
    await shot(page, `${mode}-level`);
    // The uni vault renders at once with Uni's own profile, so a profile note that turns chat off only lands after its discovery: its first room load can precede it.
    // The app shell also loads the tab's initial room once at start (App.tsx, not the Life OS surface): the one call allowed, and never a ledger (limit 12), recent line (2) or a node's room.
    const msgs = await callsOf(page, 'get_messages');
    if (mode === 'pack') expect(msgs.filter((m: string) => !m.includes('"channel":"uni-room","root":null,"limit":300'))).toEqual([]);
    expect(await callsOf(page, 'post_message', 'send', 'prepare_voice_message')).toEqual([]);
  });

  test('chat buzz (the uni vault) keeps the talk bar and room', async ({ page }) => {
    await boot(page, 'buzz');
    if (!wide(page)) await page.getByRole('button', { name: /^Uni,/ }).first().click();
    await expect(page.getByRole('button', { name: /Hold to talk/ })).toBeVisible();
  });
});

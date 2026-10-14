// T-80: Areas as a life OS view, after r12: the device cache and one-query loading, node statuses, the App tab beside the room, and Back
// through the levels. (Today, the Brief page, the map and the room switcher were deleted with the Map, Octopus and Classic layouts.)
import { test, expect, type Page } from '@playwright/test';
import { areaCard, bootAreas, openAreaPage, openAreasHome } from './areasFixture';

const calls = (page: Page, cmd: string) => page.evaluate((c) => (window as any).__calls.filter((x: any) => x.cmd === c), cmd);
const isDesktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 900;
const tree = (page: Page) => page.locator(isDesktop(page) ? '.th-roomnav' : '.th-phone-tree');
/** Unfold every area of the room tree, so a project's row can be clicked. */
async function unfold(page: Page) {
  if (!isDesktop(page) && await page.locator('.sr-drawer, .th-back').count()) await page.locator('.sr-drawer, .th-back').first().click();
  await tree(page).locator('.th-row.d1').first().waitFor();
  for (let i = 0; i < 12; i++) { const f = tree(page).locator('.th-fold[aria-expanded="false"]'); if (!await f.count()) break; await f.first().click(); }
}
/** A node's whole work page ("All of X's work"), from its room. */
async function workPage(page: Page, name: string) {
  await unfold(page);
  await areaCard(page, name).click();
  if (!isDesktop(page) && await page.locator('.cp-line[aria-expanded="false"]').count()) await page.locator('.cp-line').click();
  await page.getByRole('button', { name: /^All of .*'s work/ }).click();
  await expect(page.locator('.sr-work')).toBeVisible();
  await expect.poll(async () => [await page.locator('.sr').first().getAttribute('data-node').catch(() => null), await page.locator('.sr-title').first().textContent().catch(() => null)]).toContain(name); /* r15: a borrowed room's heading is the room; the place is data-node */
}

test.describe('device cache', () => {
  const area = (id: string, name: string, status: string) => ({ id, path: `Areas/${name}`, name, purpose: 'p', status, channels: [], rooms: [], kind: 'area', parent: null, since: null, title: name, body: `# ${name}`, metadata: {}, updatedAt: null });
  const cached = JSON.stringify({
    v: 2, owner: { identity: 'a'.repeat(64), vault: 'uni' }, savedAt: Date.now() - 3600_000, areas: [area('a-techne', 'Techne', 'foreground')],
    briefs: { 'Areas/Techne': { content: '## Now\nFROM THE DEVICE CACHE.\n\n## Needs you\n- cached need\n', generatedAt: null, updatedAt: null } }, today: null,
  });

  test('paints from the device at once while the network is slow, then refreshes and saves', async ({ page }) => {
    await bootAreas(page, 'seed', { briefs: true, queryDelay: 1800, deviceCache: cached });
    await page.evaluate(() => { document.documentElement.dataset.t0 = String(performance.now()); });
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Uni', exact: true }).click();
    await expect(areaCard(page, 'Techne')).toBeVisible({ timeout: 500 });
    await expect(page.locator('.areas-status')).toContainText('Saved copy · refreshing');
    const timing = await page.evaluate(() => (window as any).__areasTiming);
    expect(timing.fromCache).toBe(true);
    expect(timing.cacheMs).toBeLessThan(500);
    // the network answers later and replaces it
    await expect(areaCard(page, 'Unforced Development')).toBeVisible({ timeout: 6000 });
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('uni.areas.cache.v2') || 'null'));
    expect(saved.areas.map((a: any) => a.name)).toContain('Unforced Development');
    expect(saved.briefs['Areas/Techne'].content).toContain('coop paperwork');
  });

  test('a failed refresh keeps what the device remembered', async ({ page }) => {
    await bootAreas(page, 'seed', { queryFails: ['area'], deviceCache: cached });
    await openAreasHome(page);
    await expect(areaCard(page, 'Techne')).toBeVisible();
    await expect(page.locator('.areas-status')).toContainText("couldn't refresh");
    await openAreaPage(page, 'Techne', { app: false });
    await expect(page.locator('.areas-status')).toContainText("couldn't refresh");
  });

  for (const tag of ['project', 'area-brief', 'area-today']) test(`failed ${tag} refresh retains savedAt and labels old data`, async ({ page }) => {
    await bootAreas(page, 'seed', { briefs: true, queryFails: [tag], deviceCache: cached });
    await openAreasHome(page);
    await expect(page.locator('.areas-status')).toContainText("couldn't refresh");
    await expect(page.locator('.areas-status')).toContainText(tag);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('uni.areas.cache.v2')!).savedAt)).toBe(JSON.parse(cached).savedAt);
  });

  test('another account never paints the saved copy', async ({ page }) => {
    const other = JSON.parse(cached); other.owner.identity = 'b'.repeat(64);
    await bootAreas(page, 'seed', { queryFails: ['area'], deviceCache: JSON.stringify(other) });
    await openAreasHome(page);
    await expect(page.getByText('FROM THE DEVICE CACHE.', { exact: false })).toHaveCount(0);
    await expect(areaCard(page, 'Techne')).toHaveCount(0);
  });

  test('forget then pair account B clears disk and memory before any paint', async ({ page }) => {
    await bootAreas(page, 'seed', { briefs: true });
    await expect(areaCard(page, 'Techne')).toBeVisible();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('uni.areas.cache.v2'))).not.toBeNull();
    await page.evaluate(() => {
      const w = window as any; const original = w.__TAURI_INTERNALS__.invoke;
      w.__TAURI_INTERNALS__.invoke = async (cmd: string, args: any) => {
        if (cmd === 'get_identity') return 'b'.repeat(64);
        if (cmd === 'pairing_start') return { sas: '000000' };
        if (cmd === 'pairing_confirm') return { pubkey: 'b'.repeat(64) };
        if (cmd === 'vault_query') throw 'account B offline';
        return original(cmd, args);
      };
      localStorage.setItem('uni.areas.cache.v1', 'legacy private data');
    });
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Forget this device key', exact: true }).click();
    await page.getByRole('button', { name: /Tap again to forget/ }).click();
    await expect(page.locator('.pairing-card')).toBeVisible();
    expect(await page.evaluate(() => [localStorage.getItem('uni.areas.cache.v1'), localStorage.getItem('uni.areas.cache.v2')])).toEqual([null, null]);
    await page.getByRole('textbox', { name: 'Pairing link' }).fill('nostrpair://test');
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await page.getByRole('button', { name: 'Codes match', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('account B offline');
    await expect(areaCard(page, 'Techne')).toHaveCount(0);
  });

  test('a first load that fails says so', async ({ page }) => {
    await bootAreas(page, 'seed', { queryFails: ['area'] });
    await openAreasHome(page);
    await expect(page.getByRole('alert')).toContainText("Couldn't load areas");
  });
});

test.describe('App tab', () => {
  test('an area with a sealed app opens to its room; "App ›" in the header shows the app inside the room shell, and Back to chat returns', async ({ page }) => {
    await bootAreas(page, 'seed', { briefs: true });
    await openAreasHome(page);
    await openAreaPage(page, 'Techne', { app: false });
    await expect(page.locator('.sr-chat')).toBeVisible();
    await expect(page.locator('iframe.area-frame')).toHaveCount(0);
    await page.locator('.sr-app').click();
    await expect(page.locator('.sr-work iframe.area-frame')).toHaveCount(1);
    await expect(page.frameLocator('iframe.area-frame').locator('#title')).toHaveText('Techne');
    // r14: the same shell: its header and the tree stay; no tabs, no second chat
    await expect(page.locator('.sr-title')).toHaveText('Techne');
    await expect(page.locator('.area-tabs, .area-chat, .area-bar')).toHaveCount(0);
    await expect(page.locator('.sr-appbar')).toContainText('Techne app');
    await page.getByRole('button', { name: 'Back to chat' }).click();
    await expect(page.locator('iframe.area-frame')).toHaveCount(0);
    await expect(page.locator('.sr-chat')).toBeVisible();
  });

  test('an area without an app has no tabs', async ({ page }) => {
    await bootAreas(page, 'seed', { briefs: true });
    await openAreasHome(page);
    await openAreaPage(page, 'Sanctum', { app: false });
    await page.waitForTimeout(400);
    await expect(page.getByRole('tablist', { name: 'Area views' })).toHaveCount(0);
  });
});

test('path brief beats a newer metadata-only note; limit is visible', async ({ page }) => {
  await bootAreas(page, 'seed', { briefs: true });
  await page.evaluate(() => {
    const w = window as any; const original = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (cmd: string, args: any) => {
      const result = await original(cmd, args);
      if (cmd === 'vault_query' && args.tag === 'area-brief') return [...result, ...Array.from({ length: 200 - result.length }, (_, i) => ({ id: `stray-${i}`, path: `Notes/stray-${i}`, metadata: { area: 'Techne' }, content: '## Now\nSTRAY BRIEF', updatedAt: '2099-01-01' }))];
      return result;
    };
    document.dispatchEvent(new Event('visibilitychange'));
  });
  // Reopen after a full reload is unnecessary: trigger a refresh beyond the debounce.
  await page.clock.install();
  await page.clock.fastForward(31000);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(async () => (await calls(page, 'vault_query')).length).toBeGreaterThanOrEqual(8);
  await workPage(page, 'Techne');
  await expect(page.locator('.th-lede')).toContainText('coop paperwork');
  await expect(page.locator('.th-lede')).not.toContainText('STRAY BRIEF');
  await expect(page.locator('.areas-status')).toContainText('showing first 200');
});

 test('cached home paints before room loading resolves', async ({ page }) => {
  const a = { id: 'cached', path: 'Areas/Cached', name: 'Cached', purpose: 'Cached purpose', status: 'foreground', channels: [], rooms: [], kind: 'area', parent: null, title: 'Cached', body: '', metadata: {}, since: null, updatedAt: null };
  await bootAreas(page, 'seed', { roomsDelay: 3000, queryDelay: 3000, deviceCache: JSON.stringify({ v: 2, owner: { identity: 'a'.repeat(64), vault: 'uni' }, savedAt: Date.now(), areas: [a], briefs: {}, today: null }) });
  await expect(areaCard(page, 'Cached')).toBeVisible({ timeout: 700 });
  expect(await page.evaluate(() => (window as any).__roomsResolved)).toBeUndefined();
  await expect(page.getByRole('heading', { name: 'Uni', level: 1 })).toBeVisible();
  if (isDesktop(page)) await expect(page.locator('.sr-chat')).toBeVisible({ timeout: 8000 });
 });
 test('system Back follows parent levels and the project body is read once', async ({ page }) => {
  await bootAreas(page, 'seed', { tree: true, briefs: true });
  await workPage(page, 'COhere 2026');
  await page.locator('.th-note summary').click();
  await expect(page.locator('.th-note')).toContainText('The festival: venue, crew and the schedule.');
  const back = () => page.evaluate(() => { const w = window as any; w.__cbs[w.__backHandler.id]({ message: {}, index: w.__backIndex ?? 0 }); w.__backIndex = (w.__backIndex ?? 0) + 1; });
  await back(); // the work page closes back to the room
  await expect(page.locator('.sr-title')).toHaveText('COhere 2026');
  expect((await calls(page, 'vault_note')).filter((c: any) => c.args.noteRef === 'p-cohere')).toHaveLength(1);
  if (isDesktop(page)) { await back(); await expect(page.locator('.sr-title')).toHaveText('Techne'); await back(); await expect(page.locator('.sr-title')).toHaveText('Uni'); }
  else { await back(); await expect(page.locator('.th-phone-tree')).toBeVisible(); }
 });

for (const status of ['archived', 'done', 'dormant']) test(`area and project status ${status} controls the tree's rows`, async ({ page }) => {
  await bootAreas(page, 'seed', { tree: true, nodeStatuses: { 'a-sad': status, 'p-cohere': status } });
  await expect(areaCard(page, 'Techne')).toBeVisible();
  // dormant is not archived or done: background nodes stay in the tree
  if (status === 'dormant') await expect(areaCard(page, 'Sanctum')).toBeVisible();
  else await expect(areaCard(page, 'Sanctum')).toHaveCount(0);
  await unfold(page);
  if (status === 'dormant') await expect(areaCard(page, 'COhere 2026')).toBeVisible();
  else await expect(areaCard(page, 'COhere 2026')).toHaveCount(0);
});
test('failed project refresh retains previous projects and stale marker', async ({ page }) => {
  await bootAreas(page, 'seed', { tree: true });
  await unfold(page);
  await expect(areaCard(page, 'COhere 2026')).toBeVisible();
  await page.evaluate(() => {
    const w = window as any; const original = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = (cmd: string, args: any) => cmd === 'vault_query' && args.tag === 'project' ? Promise.reject('projects unavailable') : original(cmd, args);
  });
  await page.clock.install(); await page.clock.fastForward(31000);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.locator('.areas-status')).toContainText("couldn't refresh: project");
  await expect(areaCard(page, 'COhere 2026')).toBeVisible();
});

 test('fresh memory stays fresh during a deferred background refresh', async ({ page }) => {
  await bootAreas(page, 'seed');
  await expect(areaCard(page, 'Techne')).toBeVisible();
  await page.evaluate(() => {
    const w = window as any, original = w.__TAURI_INTERNALS__.invoke;
    w.__pendingAreas = [];
    w.__TAURI_INTERNALS__.invoke = (cmd: string, args: any) => cmd === 'vault_query'
      ? new Promise((resolve) => w.__pendingAreas.push(async () => resolve(await original(cmd, args)))) : original(cmd, args);
  });
  await page.clock.install(); await page.clock.fastForward(31000);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  // r13: the four area queries and the task tree's (re-read with every refresh); r16: the run and draft reads start beside it
  await expect.poll(() => page.evaluate(() => (window as any).__pendingAreas.length)).toBe(7);
  await expect(page.locator('.areas-status')).toHaveCount(0);
  await page.evaluate(async () => { for (const resolve of (window as any).__pendingAreas) await resolve(); });
 });

 test('forgetAreas discards an in-flight result while the hook remains mounted', async ({ page }) => {
  await bootAreas(page, 'seed', { queryDelay: 3000 });
  // the four area queries (the task tree's node, run and draft reads are the task list's)
  await expect.poll(async () => (await calls(page, 'vault_query')).filter((c: any) => !['node', 'run', 'draft'].includes(c.args.tag)).length).toBe(4);
  await page.evaluate(() => (window as any).__forgetAreas());
  await page.waitForTimeout(3500);
  expect(await page.evaluate(() => localStorage.getItem('uni.areas.cache.v2'))).toBeNull();
  await expect(areaCard(page, 'Techne')).toHaveCount(0);
 });

 test('unresolved identity shows Signing in', async ({ page }) => {
  await bootAreas(page, 'seed', { identityDelay: 3000 });
  await expect(page.getByText('Signing in…', { exact: true })).toBeVisible();
  expect(await calls(page, 'vault_query')).toHaveLength(0);
  await expect(areaCard(page, 'Techne')).toBeVisible({ timeout: 8000 });
 });


test('identity changes discard cached project bodies, including when returning to an account', async ({ page }) => {
  await bootAreas(page, 'seed', { tree: true, briefs: true });
  await page.evaluate(() => {
    const w = window as any;
    w.bodyOwner = 'a';
    const original = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (cmd: string, args: any) => {
      const result = await original(cmd, args);
      if (cmd === 'refresh') return { ...result, pubkey: w.bodyOwner.repeat(64) };
      if (cmd === 'vault_note' && args.noteRef === 'p-cohere') return { ...result, note: { ...result.note, content: `${result.note.content}\n\nBody for account ${w.bodyOwner}` } };
      return result;
    };
  });
  await workPage(page, 'COhere 2026');
  const purpose = page.locator('.th-note');
  await purpose.locator('summary').click();
  await expect(purpose).toContainText('Body for account a');
  for (const owner of ['b', 'a']) {
    await page.evaluate((owner) => {
      (window as any).bodyOwner = owner;
      document.dispatchEvent(new Event('visibilitychange'));
    }, owner);
    // another account remounts the place (its room, not the work page): open the work page again
    await expect.poll(async () => (await calls(page, 'refresh')).length).toBeGreaterThan(0);
    await page.waitForTimeout(300);
    if (!await purpose.count()) await workPage(page, 'COhere 2026');
    if (!await purpose.getAttribute('open').then((v) => v !== null).catch(() => false)) await purpose.locator('summary').click();
    await expect(purpose).toContainText(`Body for account ${owner}`);
  }
  expect((await calls(page, 'vault_note')).filter((c: any) => c.args.noteRef === 'p-cohere')).toHaveLength(3);
});

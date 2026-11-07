// T-80: Areas as a life OS view, after r12: the device cache and one-query loading, node statuses, the App tab beside the room, and Back
// through the levels. (Today, the Brief page, the map and the room switcher were deleted with the Map, Octopus and Classic layouts.)
import { test, expect, type Page } from '@playwright/test';
import { areaCard, bootAreas, focusSheet, openAreaPage, openAreasHome, openDetails } from './areasFixture';
import { railGo } from './railGo';

const calls = (page: Page, cmd: string) => page.evaluate((c) => (window as any).__calls.filter((x: any) => x.cmd === c), cmd);
// T-335 one surface: a room is in focus over All; its name heads the sheet; its details hold its work, the places inside it and its app
const title = (page: Page) => focusSheet(page).locator('.all-focus-title');
/** T-335: a place is opened from Uni's home (its door, or its parent's details there): from anywhere else (a room in focus, All), go there first. */
const fromHome = async (page: Page) => { if (!(await page.locator('[data-place="front-door"]').first().isVisible()) || (await focusSheet(page).isVisible())) await openAreasHome(page); };
/** 0.2 one home: the doors are in the drawer under the home's head; this pulls it down (without waiting for a door, so an absent one can be checked). */
async function pullDown(page: Page) {
  const pull = page.locator('[data-place="front-door"] .fd-pull');
  await pull.waitFor();
  if ((await pull.getAttribute('aria-expanded')) !== 'true' && (await pull.isEnabled())) await pull.click();
  await expect(page.locator('#fd-drawer')).toBeVisible();
}
const backToChat = (page: Page) => focusSheet(page).getByRole('button', { name: /: back to the conversation$/ }).click();
/** Where a place inside another is reached: its parent's details ("Inside X"). */
const PARENT: Record<string, string> = { 'COhere 2026': 'Techne' };
/** The places inside an area, as its details list them (what the tree's unfolded rows were). */
async function inside(page: Page, area: string) {
  await fromHome(page);
  await openAreaPage(page, area, { app: false });
  await openDetails(page);
  return focusSheet(page).locator('.fx-places');
}
/** A node's whole work page ("All of X's work"), from its room's details. */
async function workPage(page: Page, name: string) {
  await fromHome(page);
  await openAreaPage(page, name, { app: false, parent: PARENT[name] });
  await openDetails(page);
  await focusSheet(page).getByRole('button', { name: /^All of .*'s work/ }).click();
  await expect(page.locator('.fx-work')).toBeVisible();
  await expect(title(page)).toHaveText(name);
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
    await pullDown(page);
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
    // the room in focus says it too (the home behind it keeps its own line)
    await expect(focusSheet(page).locator('.areas-status')).toContainText("couldn't refresh");
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
    await pullDown(page);
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
    await railGo(page, 'Settings');
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
    // 0.2: the home is All's stream; with nothing read it says so in place of the stream, with a way to try again
    await expect(page.locator('[data-place="front-door"] .all-quiet')).toContainText("Couldn't read your places just now.");
    await expect(page.locator('[data-place="front-door"]').getByRole('button', { name: 'Try again' })).toBeVisible();
  });
});

test.describe('App tab', () => {
  test('an area with a sealed app opens to its room; "Open the app" in its details shows the app inside the focus, and its name returns to the chat', async ({ page }) => {
    await bootAreas(page, 'seed', { briefs: true });
    await openAreasHome(page);
    await openAreaPage(page, 'Techne', { app: false });
    await expect(focusSheet(page).locator('.sr-chat')).toBeVisible();
    await expect(page.locator('iframe.area-frame')).toHaveCount(0);
    await openDetails(page);
    await focusSheet(page).getByRole('button', { name: 'Open the Techne app ›' }).click();
    await expect(focusSheet(page).locator('.fx-app iframe.area-frame')).toHaveCount(1);
    await expect(page.frameLocator('iframe.area-frame').locator('#title')).toHaveText('Techne');
    // r14, T-335: the same focus, under the room's name; no tabs, no second chat
    await expect(title(page)).toHaveText('Techne');
    await expect(page.locator('.area-tabs, .area-chat, .area-bar')).toHaveCount(0);
    await expect(page.locator('.sr-appbar')).toContainText('Techne app');
    await backToChat(page);
    await expect(page.locator('iframe.area-frame')).toHaveCount(0);
    await expect(focusSheet(page).locator('.sr-chat')).toBeVisible();
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
  await expect(page.getByRole('region', { name: /in focus$/ }).locator('.areas-status')).toContainText('showing first 200');
});

 test('cached home paints before room loading resolves', async ({ page }) => {
  const a = { id: 'cached', path: 'Areas/Cached', name: 'Cached', purpose: 'Cached purpose', status: 'foreground', channels: [], rooms: [], kind: 'area', parent: null, title: 'Cached', body: '', metadata: {}, since: null, updatedAt: null };
  await bootAreas(page, 'seed', { roomsDelay: 3000, queryDelay: 3000, deviceCache: JSON.stringify({ v: 2, owner: { identity: 'a'.repeat(64), vault: 'uni' }, savedAt: Date.now(), areas: [a], briefs: {}, today: null }) });
  await expect(areaCard(page, 'Cached')).toBeVisible({ timeout: 700 });
  expect(await page.evaluate(() => (window as any).__roomsResolved)).toBeUndefined();
  await expect(page.getByRole('heading', { name: 'Uni', level: 1 })).toBeVisible();
  // T-302: the home is the front door (no Uni room beside it)
  await expect(page.locator('[data-place="front-door"]')).toBeVisible();
 });
 test('system Back steps out of a project\'s work, through its room, to All, and the project body is read once', async ({ page }) => {
  await bootAreas(page, 'seed', { tree: true, briefs: true });
  await workPage(page, 'COhere 2026');
  await page.locator('.th-note summary').click();
  await expect(page.locator('.th-note')).toContainText('The festival: venue, crew and the schedule.');
  const back = () => page.evaluate(() => { const w = window as any; w.__cbs[w.__backHandler.id]({ message: {}, index: w.__backIndex ?? 0 }); w.__backIndex = (w.__backIndex ?? 0) + 1; });
  // each Back closes what is over the place: the work page, its details, then the project's room comes out of focus, back to All
  // (T-335: a room is in focus over All; there are no parent levels to climb: the way in was through the area's details)
  const backTo = async (seen: () => Promise<boolean>) => { for (let i = 0; i < 4 && !(await seen()); i++) { await back(); await page.waitForTimeout(250); } expect(await seen()).toBe(true); };
  await backTo(async () => !(await page.locator('.fx-work').isVisible()) && (await focusSheet(page).locator('.sr-chat').isVisible()) && (await title(page).textContent()) === 'COhere 2026');
  expect((await calls(page, 'vault_note')).filter((c: any) => c.args.noteRef === 'p-cohere')).toHaveLength(1);
  await backTo(async () => (await focusSheet(page).count()) === 0 && (await page.locator('[data-place="front-door"]').first().isVisible()));
 });

// T-335: the tree's rows are the home's doors (areas) and an area's "Inside X" in its details (the places inside it)
for (const status of ['archived', 'done', 'dormant']) test(`area and project status ${status} controls the doors and the places inside`, async ({ page }) => {
  await bootAreas(page, 'seed', { tree: true, nodeStatuses: { 'a-sad': status, 'p-cohere': status } });
  await pullDown(page);
  await expect(areaCard(page, 'Techne')).toBeVisible();
  // dormant is not archived or done: background nodes stay in the tree
  if (status === 'dormant') await expect(areaCard(page, 'Sanctum')).toBeVisible();
  else await expect(areaCard(page, 'Sanctum')).toHaveCount(0);
  const places = await inside(page, 'Techne');
  if (status === 'dormant') await expect(places.getByRole('button', { name: /COhere 2026/ })).toBeVisible();
  else await expect(focusSheet(page).locator('.fx-place', { hasText: 'COhere 2026' })).toHaveCount(0);
});
test('failed project refresh retains previous projects and stale marker', async ({ page }) => {
  await bootAreas(page, 'seed', { tree: true });
  const places = await inside(page, 'Techne');
  await expect(places.getByRole('button', { name: /COhere 2026/ })).toBeVisible();
  await page.evaluate(() => {
    const w = window as any; const original = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = (cmd: string, args: any) => cmd === 'vault_query' && args.tag === 'project' ? Promise.reject('projects unavailable') : original(cmd, args);
  });
  await page.clock.install(); await page.clock.fastForward(31000);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByRole('region', { name: /in focus$/ }).locator('.areas-status')).toContainText("couldn't refresh: project");
  await expect(places.getByRole('button', { name: /COhere 2026/ })).toBeVisible();
});

 test('fresh memory stays fresh during a deferred background refresh', async ({ page }) => {
  await bootAreas(page, 'seed');
  await pullDown(page);
  await expect(areaCard(page, 'Techne')).toBeVisible();
  await page.evaluate(() => {
    const w = window as any, original = w.__TAURI_INTERNALS__.invoke;
    w.__pendingAreas = [];
    w.__TAURI_INTERNALS__.invoke = (cmd: string, args: any) => cmd === 'vault_query'
      ? new Promise((resolve) => w.__pendingAreas.push(async () => resolve(await original(cmd, args)))) : original(cmd, args);
  });
  await page.clock.install(); await page.clock.fastForward(31000);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  // r13: the four area queries and the task tree's (re-read with every refresh); r16: the run and draft reads start beside it;
  // T-302: and the front door's work read (its node notes; its run reads are metadata queries)
  await expect.poll(() => page.evaluate(() => (window as any).__pendingAreas.length)).toBe(8);
  await expect(page.locator('.areas-status')).toHaveCount(0);
  await page.evaluate(async () => { for (const resolve of (window as any).__pendingAreas) await resolve(); });
 });

 test('forgetAreas discards an in-flight result while the hook remains mounted', async ({ page }) => {
  await bootAreas(page, 'seed', { queryDelay: 3000 });
  // the four area queries (the task list's and the home's own reads, tasks and posts, are theirs)
  await expect.poll(async () => (await calls(page, 'vault_query')).filter((c: any) => ['area', 'project', 'area-brief', 'area-today'].includes(c.args.tag)).length).toBe(4);
  await page.evaluate(() => (window as any).__forgetAreas());
  await page.waitForTimeout(3500);
  expect(await page.evaluate(() => localStorage.getItem('uni.areas.cache.v2'))).toBeNull();
  await expect(areaCard(page, 'Techne')).toHaveCount(0);
 });

 test('unresolved identity shows Signing in', async ({ page }) => {
  await bootAreas(page, 'seed', { identityDelay: 3000 });
  // 0.2: the home is All's stream; before the key is known it says it is reading, and reads nothing yet
  await expect(page.locator('[data-place="front-door"] .all-quiet')).toHaveText('Reading your rooms…');
  expect(await calls(page, 'vault_query')).toHaveLength(0);
  await expect(page.locator('[data-place="front-door"] .fd-pull')).toBeVisible({ timeout: 8000 });
  await pullDown(page);
  await expect(areaCard(page, 'Techne')).toBeVisible();
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

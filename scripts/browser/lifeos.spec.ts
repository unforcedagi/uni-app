// T-80: Areas as a life OS view. Today (needs-you, cards, background collapsed), the native Brief page, Ask Uni drafts,
// the room switcher for multi-room areas, the App tab, and the device cache / one-query loading.
import { mkdir } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import { areaCard, bootAreas, openAreaPage, openAreasHome } from './areasFixture';

const calls = (page: Page, cmd: string) => page.evaluate((c) => (window as any).__calls.filter((x: any) => x.cmd === c), cmd);
const isDesktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 900;
const composer = (page: Page, room: string) => page.getByRole('textbox', { name: `Message ${room}` });
// On a phone the chat is a pull-up sheet; its composer is reachable once it is open.
const openSheet = async (page: Page) => { if (!isDesktop(page) && await page.locator('.area-chat.sheet:not(.open) .sheet-peek').count()) await page.locator('.sheet-peek').click(); };

test.describe('Today', () => {
  test.beforeEach(async ({ page }) => bootAreas(page, 'seed', { briefs: true }));

  test('needs-you first (ranked), then foreground cards with Now line, count and freshness; background collapsed', async ({ page }, info) => {
    await openAreasHome(page);
    const needs = page.locator('.today-needs li');
    await expect(needs).toHaveCount(2);
    // ranked: the overdue invoice before the grant due tomorrow
    await expect(needs.nth(0)).toContainText('Send the Q4 invoice');
    await expect(needs.nth(1)).toContainText('Reply to Leonardo about the grant');
    const names = await page.locator('.areas-grid').first().locator('.area-card strong').allTextContents();
    expect(names).toEqual(['Techne', 'Unforced Development']);
    const techne = areaCard(page, 'Techne');
    await expect(techne).toContainText('The coop paperwork is signed.');
    await expect(techne).toContainText('2 need you');
    await expect(techne).toContainText('updated 3h ago');
    await expect(areaCard(page, 'Unforced Development')).toContainText('1 needs you');
    // background areas are collapsed until asked for
    await expect(areaCard(page, 'Sanctum')).toBeHidden();
    await page.locator('.today-background > summary').click();
    await expect(areaCard(page, 'Sanctum')).toBeVisible();
    await expect(areaCard(page, 'Sanctum')).toContainText('No brief yet');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await mkdir('shots/t80', { recursive: true });
    await page.screenshot({ path: `shots/t80/${info.project.name}-today.png` });
  });

  test('loads with tag queries, never the whole-vault listing', async ({ page }) => {
    await openAreasHome(page);
    await expect(areaCard(page, 'Techne')).toBeVisible();
    const tags = (await calls(page, 'vault_query')).map((c: any) => c.args.tag).sort();
    expect(tags).toEqual(['area', 'area-brief', 'area-today', 'project']);
    expect(await calls(page, 'vault_paths')).toHaveLength(0);
    // and the one-note-per-area fetch is gone too
    expect((await calls(page, 'vault_note')).filter((c: any) => String(c.args.noteRef).startsWith('a-'))).toHaveLength(0);
  });

  test('Ask Uni on a need drops a draft in that area room and sends nothing', async ({ page }) => {
    await openAreasHome(page);
    await page.getByRole('button', { name: /Ask Uni about: Reply to Leonardo/ }).click();
    await expect(composer(page, 'Techne')).toHaveValue(/@Uni Techne: .*Reply to Leonardo about the grant/);
    expect(await calls(page, 'post_message')).toHaveLength(0);
  });

  test('a need names its area and a link in it opens the note', async ({ page }) => {
    await openAreasHome(page);
    await page.locator('.today-needs li', { hasText: 'Reply to Leonardo' }).getByRole('button', { name: 'the plan', exact: true }).click();
    await expect(page.locator('.note-sheet')).toContainText('Techne plan body');
  });
});

test.describe('Today without a Today note', () => {
  test('without a Today note the needs come from the area briefs', async ({ page }) => {
    await bootAreas(page, 'seed', { briefs: true, queryFails: ['area-today'] });
    await openAreasHome(page);
    await expect(page.locator('.today-needs li')).toHaveCount(3);
    await expect(page.locator('.today-needs li').first()).toContainText('Send the Q4 invoice');
  });
});

test.describe('Today with no briefs', () => {
  test('says Uni has not written Today yet, and still lists the areas', async ({ page }) => {
    await bootAreas(page, 'seed');
    await openAreasHome(page);
    await expect(page.locator('.today-needs')).toContainText("Uni hasn't written Today yet.");
    await expect(areaCard(page, 'Techne')).toContainText('The craft of building');
    await expect(areaCard(page, 'Techne')).toContainText('No brief yet');
  });
});

test.describe('device cache', () => {
  const area = (id: string, name: string, status: string) => ({ id, path: `Areas/${name}`, name, purpose: 'p', status, channels: [], rooms: [], kind: 'area', parent: null, since: null, title: name, body: `# ${name}`, metadata: {}, updatedAt: null });
  const cached = JSON.stringify({
    v: 2, savedAt: Date.now() - 3600_000, areas: [area('a-techne', 'Techne', 'foreground')],
    briefs: { 'Areas/Techne': { content: '## Now\nFROM THE DEVICE CACHE.\n\n## Needs you\n- cached need\n', generatedAt: null, updatedAt: null } }, today: null,
  });

  test('paints from the device at once while the network is slow, then refreshes and saves', async ({ page }) => {
    await bootAreas(page, 'seed', { briefs: true, queryDelay: 1800, deviceCache: cached });
    await page.evaluate(() => { document.documentElement.dataset.t0 = String(performance.now()); });
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Uni', exact: true }).click();
    await expect(areaCard(page, 'Techne')).toContainText('FROM THE DEVICE CACHE.', { timeout: 500 });
    const timing = await page.evaluate(() => (window as any).__areasTiming);
    expect(timing.fromCache).toBe(true);
    expect(timing.cacheMs).toBeLessThan(500);
    // the network answers later and replaces it
    await expect(areaCard(page, 'Techne')).toContainText('The coop paperwork is signed.', { timeout: 6000 });
    await expect(areaCard(page, 'Unforced Development')).toBeVisible();
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('uni.areas.cache.v2') || 'null'));
    expect(saved.areas.map((a: any) => a.name)).toContain('Unforced Development');
    expect(saved.briefs['Areas/Techne'].content).toContain('coop paperwork');
  });

  test('a failed refresh keeps what the device remembered', async ({ page }) => {
    await bootAreas(page, 'seed', { queryFails: ['area'], deviceCache: cached });
    await openAreasHome(page);
    await expect(areaCard(page, 'Techne')).toContainText('FROM THE DEVICE CACHE.');
    await expect(page.getByRole('alert')).toContainText("Couldn't load areas");
  });

  test('a first load that fails says so', async ({ page }) => {
    await bootAreas(page, 'seed', { queryFails: ['area'] });
    await openAreasHome(page);
    await expect(page.getByRole('alert')).toContainText("Couldn't load areas");
  });
});

test.describe('the Brief page', () => {
  test.beforeEach(async ({ page }) => bootAreas(page, 'seed', { briefs: true }));

  test('renders the sections natively, with freshness, and no Open-note loop', async ({ page }, info) => {
    await openAreasHome(page);
    await openAreaPage(page, 'Techne', { app: false });
    const brief = page.locator('.area-brief');
    await expect(brief.locator('h1')).toHaveText('Techne');
    await expect(brief.locator('.brief-fresh span')).toHaveText('updated 3h ago');
    for (const h of ['Now', 'Needs you', 'Moving', 'People', 'Recent', 'Quiet', 'Suggested next']) await expect(brief.getByRole('heading', { name: new RegExp(`^${h}`) })).toBeVisible();
    await expect(brief.locator('.brief-now')).toContainText('COhere starts Oct 15');
    await expect(brief.locator('.brief-needsYou li')).toHaveCount(2);
    await expect(brief.locator('.brief-quiet')).toContainText('Nothing recent.');
    await expect(page.getByRole('button', { name: 'Open note' })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await mkdir('shots/t80', { recursive: true });
    await page.screenshot({ path: `shots/t80/${info.project.name}-brief.png` });
  });

  test('a wikilink opens that note in the app and Back returns to the brief', async ({ page }) => {
    await openAreasHome(page);
    await openAreaPage(page, 'Techne', { app: false });
    await page.locator('.brief-needsYou').getByRole('button', { name: 'the plan', exact: true }).click();
    await expect(page.locator('.note-sheet')).toContainText('Techne plan body');
    await page.locator('.note-back').click();
    await expect(page.locator('.area-brief h1')).toHaveText('Techne');
  });

  test('Ask Uni on Needs you, Moving and Suggested next drafts into the room composer and sends nothing', async ({ page }) => {
    await openAreasHome(page);
    await openAreaPage(page, 'Techne', { app: false });
    await expect(page.locator('.brief-ask')).toHaveCount(2 + 1 + 2);
    await page.getByRole('button', { name: 'Ask Uni about: Decide the COhere venue by Oct 12' }).click();
    // on a phone the draft opens the sheet by itself
    if (!isDesktop(page)) await expect(page.locator('.area-chat.sheet.open')).toHaveCount(1);
    await expect(composer(page, 'Techne')).toHaveValue(/@Uni Techne: .*Decide the COhere venue by Oct 12/);
    if (!isDesktop(page)) await page.locator('.sheet-peek').click(); // the open sheet covers the brief; lower it
    await page.getByRole('button', { name: 'Ask Uni about: Draft a reply to Leonardo' }).click();
    await expect(composer(page, 'Techne')).toHaveValue(/Decide the COhere venue[\s\S]*please go ahead and draft this\? "Draft a reply to Leonardo"/);
    expect(await calls(page, 'post_message')).toHaveLength(0);
  });

  test('desktop: the brief and the room sit side by side', async ({ page }) => {
    test.skip(!isDesktop(page), 'desktop only');
    await openAreasHome(page);
    await openAreaPage(page, 'Techne', { app: false });
    const b = (await page.locator('.area-brief').boundingBox())!, c = (await page.locator('.area-chat.side').boundingBox())!;
    expect(b.x + b.width).toBeLessThanOrEqual(c.x + 2);
    await expect(composer(page, 'Techne')).toBeVisible();
  });

  test('no brief: says so and offers to ask Uni to write it (a draft only)', async ({ page }) => {
    await openAreasHome(page);
    await openAreaPage(page, 'Sanctum', { app: false });
    await expect(page.locator('.brief-missing')).toContainText("Uni hasn't written this area's brief yet");
    await page.getByRole('button', { name: 'Ask Uni to write it' }).click();
    if (!isDesktop(page)) await expect(page.locator('.area-chat.sheet.open')).toHaveCount(1);
    await expect(composer(page, 'Sanctum')).toHaveValue(/@Uni Sanctum has no brief yet.*Areas\/Sanctum\/Brief/);
    expect(await calls(page, 'post_message')).toHaveLength(0);
  });

  test('an area with no room cannot be asked, and says why', async ({ page }) => {
    await openAreasHome(page);
    await openAreaPage(page, 'Relationships', { app: false });
    await expect(page.locator('.brief-missing')).toContainText('no room yet');
    await expect(page.getByRole('button', { name: 'Ask Uni to write it' })).toHaveCount(0);
  });
});

test.describe('App tab', () => {
  test('an area with a sealed app has Brief (default) and App tabs; the app runs only on the App tab', async ({ page }) => {
    await bootAreas(page, 'seed', { briefs: true });
    await openAreasHome(page);
    await openAreaPage(page, 'Techne', { app: false });
    const tabs = page.getByRole('tablist', { name: 'Area views' });
    await expect(tabs.getByRole('tab', { name: 'Brief' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('iframe.area-frame')).toHaveCount(0);
    await tabs.getByRole('tab', { name: 'App' }).click();
    await expect(page.locator('iframe.area-frame')).toHaveCount(1);
    await expect(page.frameLocator('iframe.area-frame').locator('#title')).toHaveText('Techne');
    await tabs.getByRole('tab', { name: 'Brief' }).click();
    await expect(page.locator('iframe.area-frame')).toHaveCount(0);
    await expect(page.locator('.area-brief h1')).toHaveText('Techne');
  });

  test('an area without an app has no tabs', async ({ page }) => {
    await bootAreas(page, 'seed', { briefs: true });
    await openAreasHome(page);
    await openAreaPage(page, 'Sanctum', { app: false });
    await page.waitForTimeout(400);
    await expect(page.getByRole('tablist', { name: 'Area views' })).toHaveCount(0);
  });
});

test.describe('room switcher', () => {
  test.beforeEach(async ({ page }) => bootAreas(page, 'seed', { briefs: true, multiRoom: true }));

  test('a two-room area shows chips and switches the chat to the other room', async ({ page }, info) => {
    await openAreasHome(page);
    await openAreaPage(page, 'Techne', { app: false });
    await openSheet(page);
    const chips = page.getByRole('group', { name: 'Rooms' });
    await expect(chips.getByRole('button')).toHaveText(['#Techne', '#Cohere']);
    await expect(chips.getByRole('button', { name: '#Techne' })).toHaveAttribute('aria-pressed', 'true');
    await expect(composer(page, 'Techne')).toBeVisible();
    await chips.getByRole('button', { name: '#Cohere' }).click();
    await expect(chips.getByRole('button', { name: '#Cohere' })).toHaveAttribute('aria-pressed', 'true');
    await expect(composer(page, 'Cohere')).toBeVisible();
    await expect(page.locator('.area-chat .message-list')).toContainText('COhere schedule draft is in the vault.');
    await expect(page.getByRole('button', { name: /Open #Cohere as a full room/ })).toBeVisible();
    await mkdir('shots/t80', { recursive: true });
    await page.screenshot({ path: `shots/t80/${info.project.name}-techne-rooms.png` });
  });

  test('Ask Uni goes to the room that is showing', async ({ page }) => {
    await openAreasHome(page);
    await openAreaPage(page, 'Techne', { app: false });
    await openSheet(page);
    await page.getByRole('group', { name: 'Rooms' }).getByRole('button', { name: '#Cohere' }).click();
    await expect(composer(page, 'Cohere')).toBeVisible();
    await page.getByRole('button', { name: 'Ask Uni about: Decide the COhere venue by Oct 12' }).click();
    await expect(composer(page, 'Cohere')).toHaveValue(/Decide the COhere venue/);
  });

  test('a one-room area has no chips', async ({ page }) => {
    await openAreasHome(page);
    await openAreaPage(page, 'Unforced Development', { app: false });
    await expect(page.getByRole('group', { name: 'Rooms' })).toHaveCount(0);
  });
});

// T-80b: the app opens to Uni; areas and projects are a tree under it.
test.describe('Uni is home, areas are a tree', () => {
  test.beforeEach(async ({ page }) => bootAreas(page, 'seed', { briefs: true, tree: true }));
  const crumbs = (page: Page) => page.getByRole('navigation', { name: 'Where you are' });

  test('the app opens to Uni: Needs you, Moved, the Uni chat, then the areas as cards', async ({ page }, info) => {
    await expect(page.getByRole('heading', { name: 'Uni', level: 1 })).toBeVisible();
    await expect(page.locator('.area-bar-title')).toHaveText('Uni');
    await expect(page.getByRole('button', { name: /^Back to/ })).toHaveCount(0);
    const order = await page.locator('.area-brief h2').allTextContents();
    expect(order.slice(0, 3).map((t) => t.trim())).toEqual(['Needs you', 'Moved', 'Areas']);
    await expect(page.locator('.today-moved')).toContainText('coop papers signed');
    await expect(page.locator('.brief-fresh span')).toHaveText('updated 2h ago');
    await expect(areaCard(page, 'Techne')).toContainText('1 inside');
    // the Uni chat is the room of this page
    await openSheet(page);
    await expect(composer(page, 'Uni')).toBeVisible();
    // Uni's own Refresh drafts into the Uni chat and sends nothing
    if (!isDesktop(page)) await page.locator('.sheet-peek').click();
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    if (!isDesktop(page)) await expect(page.locator('.area-chat.sheet.open')).toHaveCount(1); // the draft opens the sheet by itself
    await expect(composer(page, 'Uni')).toHaveValue(/@Uni Please refresh Areas\/Today/);
    expect(await calls(page, 'post_message')).toHaveLength(0);
    await mkdir('shots/t80b', { recursive: true });
    await page.screenshot({ path: `shots/t80b/${info.project.name}-uni-home.png` });
  });

  test('Techne shows the project as a card inside it, and its own room only', async ({ page }) => {
    await openAreaPage(page, 'Techne', { app: false });
    await expect(crumbs(page)).toContainText('Uni');
    await expect(crumbs(page).locator('.here')).toHaveText(/Techne/);
    const inside = page.getByRole('region', { name: 'Inside Techne' });
    await expect(inside.locator('.area-card strong')).toHaveText(['COhere 2026']);
    await expect(inside.locator('.area-card')).toContainText('Venue is held for Oct 15');
    await expect(inside.locator('.area-card')).toContainText('1 needs you');
    // #cohere belongs to the child now: no chip for it on Techne
    await expect(page.locator('.room-chips')).toHaveCount(0);
    await openSheet(page);
    await expect(composer(page, 'Techne')).toBeVisible();
  });

  test('the child has its own page and room, a breadcrumb up, and Back goes to its parent', async ({ page }) => {
    await openAreaPage(page, 'Techne', { app: false });
    await areaCard(page, 'COhere 2026').click();
    await expect(page.locator('.area-bar-title')).toHaveText('COhere 2026');
    await expect(crumbs(page).getByRole('button')).toHaveText(['Uni', 'Techne']);
    await expect(crumbs(page).locator('.here')).toHaveText(/COhere 2026/);
    await expect(page.locator('.area-brief h1')).toHaveText('COhere 2026');
    await expect(page.locator('.brief-now')).toContainText('Venue is held for Oct 15');
    await expect(page.locator('.brief-fresh span')).toHaveText('updated 5h ago');
    await openSheet(page);
    await expect(composer(page, 'Cohere')).toBeVisible();
    await expect(page.locator('.area-chat')).toContainText('COhere schedule draft');
    if (!isDesktop(page)) await page.locator('.sheet-peek').click();
    await expect(page.getByRole('button', { name: 'Back to Techne' })).toBeVisible();
    await page.getByRole('button', { name: 'Back to Techne' }).click();
    await expect(page.locator('.area-bar-title')).toHaveText('Techne');
    await page.getByRole('button', { name: 'Back to Uni' }).click();
    await expect(page.getByRole('heading', { name: 'Uni', level: 1 })).toBeVisible();
  });

  test('breadcrumb jumps straight to Uni', async ({ page }) => {
    await openAreaPage(page, 'Techne', { app: false });
    await areaCard(page, 'COhere 2026').click();
    await crumbs(page).getByRole('button', { name: 'Uni' }).click();
    await expect(page.locator('.area-bar-title')).toHaveText('Uni');
  });

  test('Refresh drafts a request in that node\'s room; it is never sent', async ({ page }, info) => {
    await openAreaPage(page, 'Techne', { app: false });
    await areaCard(page, 'COhere 2026').click();
    await expect(page.locator('.area-chat')).toContainText('Festival crew list'); // the room has opened
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    if (!isDesktop(page)) await expect(page.locator('.area-chat.sheet.open')).toHaveCount(1); // the draft opens the sheet by itself
    await expect(composer(page, 'Cohere')).toHaveValue(/@Uni Please refresh COhere 2026's brief \(Projects\/COhere\/COhere 2026\/Brief\)/);
    expect(await calls(page, 'post_message')).toHaveLength(0);
    await mkdir('shots/t80b', { recursive: true });
    await page.screenshot({ path: `shots/t80b/${info.project.name}-refresh-draft.png` });
  });

  test('loading the tree is four tag queries and no per-node fetch', async ({ page }) => {
    await expect(areaCard(page, 'Techne')).toBeVisible();
    const tags = (await calls(page, 'vault_query')).map((c: any) => c.args.tag).sort();
    expect(tags).toEqual(['area', 'area-brief', 'area-today', 'project']);
    expect(await calls(page, 'vault_paths')).toHaveLength(0);
    await openAreaPage(page, 'Techne', { app: false });
    await areaCard(page, 'COhere 2026').click();
    await expect(page.locator('.brief-now')).toBeVisible();
    // only the sealed-app lookup (by path, in the background) ever asks for a note by path
    expect((await calls(page, 'vault_note')).filter((c: any) => /\//.test(String(c.args.noteRef)) && !/\/app(\.html)?$/.test(String(c.args.noteRef)))).toHaveLength(0);
  });

  test('after a reload the app opens on Uni again, from the device cache', async ({ page }) => {
    await expect(areaCard(page, 'Techne')).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Uni', level: 1 })).toBeVisible();
    await expect(areaCard(page, 'Techne')).toBeVisible({ timeout: 1500 });
  });
});

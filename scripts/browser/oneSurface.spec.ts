// T-335 one surface. All with a room in focus is the app: every way into a room opens that room in focus over All, on a phone and on a desktop,
// and the old room view (its tree of rooms beside the conversation, its companion panel, its own page) is gone: never on screen, and not in
// the bundle. The focus head is the room's name and at most one labelled line; a tap on it opens the room's details inside the focus.
// Made-up world only.
// Run: ONE_TEST_PORT=1493 npx playwright test --config playwright.onesurface.config.ts
import { readdirSync, readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { bootAreas } from './areasFixture';

const rail = (page: Page) => page.getByRole('navigation', { name: 'Main navigation' });
const sheet = (page: Page) => page.getByRole('region', { name: /in focus$/ });
const home = (page: Page) => page.locator('[data-place="front-door"][data-view="places"]');
const details = (page: Page) => sheet(page).getByRole('region', { name: /details$/ });
const androidBack = (page: Page) => page.evaluate(() => { const w = window as any; w.__cbs[w.__backHandler.id]({ message: {}, index: w.__backIndex ?? 0 }); w.__backIndex = (w.__backIndex ?? 0) + 1; });
const touch = () => test.info().project.name !== 'desktop';

/** Everything that belonged to the old room view: its tree beside the room, its drawer, its header, its companion, its thread bar, its work page. */
const OLD = ['.th-level', '[data-layout="rooms"]', '.th-roomnav', '.th-drawer', '.sr-drawer', '.sr-head', '.cp.side', '.cp.strip', '.sr-thread-back', '.all-focus-page'];
async function noOldView(page: Page) {
  for (const sel of OLD) await expect(page.locator(sel), `the old room view's ${sel}`).toHaveCount(0);
}

/** The room is in focus over All: All is the place (on the rail too), behind; the room's sheet is in front, with its own composer. */
async function inFocus(page: Page, name: string | RegExp, composer?: RegExp) {
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page).locator('.all-focus-title')).toHaveText(name);
  await expect(page.locator('.all-surface[data-focus="open"]')).toBeVisible();
  await expect(page.locator('.all-behind [data-view="all"]')).toHaveCount(1);
  if (!touch() || (page.viewportSize()?.width ?? 0) >= 600) await expect(rail(page).getByRole('button', { name: 'All', exact: true })).toHaveAttribute('aria-current', 'page');
  if (composer) await expect(sheet(page).getByRole('textbox', { name: composer })).toBeVisible();
  await noOldView(page);
}

const T0 = '2026-10-10T08:00:00.000Z';
const task = (id: string, title: string, node: string, extra: Record<string, unknown> = {}) => ({ id, path: `Tasks/${title}`, extension: 'md', tags: ['task'], createdAt: T0, updatedAt: T0, fixtureTask: true, metadata: { node, state: 'open', owner: 'aaron', ...extra } });

async function boot(page: Page, opts: Record<string, unknown> = {}, before?: () => void) {
  await page.addInitScript(({ calm, tasks }) => {
    const w = window as any;
    if (calm) { try { localStorage.setItem('uni.motion', 'calm'); } catch { /* */ } }
    w.__seedTasks = tasks;
    w.__extraInvoke = async (cmd: string, args: any) => {
      if (cmd === 'route_suggest') throw 'route door unreachable';
      if (cmd === 'route_outcome') return {};
      if (cmd === 'search') return (w.__hits ?? []).filter((h: any) => h.snippet.toLowerCase().includes(String(args.query).toLowerCase()));
      return undefined;
    };
  }, { calm: test.info().project.name === 'daylight', tasks: [task('t-jars', 'T-41 Find jars for the honey', 'Areas/Bee Garden', { priority: 'now', next: 'Ask the neighbours for twenty jars.' })] });
  if (before) await page.addInitScript(before);
  await bootAreas(page, 'seed', { world: 'unread', glow: true, uniMember: true, tasks: true, ...opts } as any);
  await page.locator('[data-place="front-door"]').first().waitFor();
}

test.describe('every way into a room lands in focus over All', () => {
  test('a place on the Uni home', async ({ page }) => {
    await boot(page);
    await home(page).locator('.fd-door[data-path="Areas/Choir"]').click();
    await inFocus(page, 'Choir', /^Message #choir/);
    await expect(sheet(page)).toContainText('Sheet music for the winter set is printed');
    // Back: All, where the room was in front of it
    if (touch()) await androidBack(page); else await page.keyboard.press('Escape');
    await expect(sheet(page)).toHaveCount(0);
    await expect(page.locator('[data-view="all"]')).toBeVisible();
    await noOldView(page);
  });

  test('a place with no room of its own talks in the room it borrows, named for the place', async ({ page }) => {
    await boot(page);
    await home(page).locator('.fd-door[data-path="Areas/Still Water"]').click();
    await inFocus(page, 'Still Water', /^Message #uni/);
    await expect(sheet(page).locator('.all-focus-line')).toContainText('Talks in #uni');
  });

  test('a room no area holds, from "New in other rooms"', async ({ page }) => {
    await boot(page, { unread: { 'ch-allot': 2 } });
    await home(page).getByRole('button', { name: /^#allotment/ }).click();
    await inFocus(page, '#allotment', /^Message #allotment/);
    await expect(sheet(page)).toContainText('The water butt is full again.');
  });

  test('a private place, opened from the home, shows inside its focus only', async ({ page }) => {
    await boot(page);
    await home(page).locator('.fd-door[data-path="Areas/Sanctum"]').click();
    await inFocus(page, 'Sanctum', /^Message #sanctum/);
    await expect(sheet(page)).toContainText('Sat twenty minutes');
    // All behind it never shows the private room
    await expect(page.locator('.all-behind')).not.toContainText('Sat twenty minutes');
  });

  test('a search hit, in a room and in a thread', async ({ page }) => {
    await boot(page, {}, () => {
      const w = window as any, now = Math.floor(Date.now() / 1000);
      const m = (ref: string, channel: string, body: string, root: string | null = null) => ({ ref, channel, author: 'b'.repeat(64), author_name: 'Uni', ts: now - 3000, body, mentions_me: false, root, parent: root, mentions: [], reply_count: 0, last_reply_ts: null, edited: false, reactions: [], media: [] });
      w.__hits = [{ channel_name: 'kiln-studio', snippet: 'The bisque firing finished overnight', message: m('k1', 'ch-kiln', 'The bisque firing finished overnight. Twelve pots, one crack.') },
        { channel_name: 'glaze-tests', snippet: 'Three test tiles came out glossy', message: m('g1', 'ch-glaze', 'Three test tiles came out glossy, one crawled.') }];
    });
    await rail(page).getByRole('button', { name: touch() && (page.viewportSize()?.width ?? 0) < 600 ? 'More' : 'Search' }).click();
    if (touch() && (page.viewportSize()?.width ?? 0) < 600) await page.getByRole('button', { name: 'Search' }).click();
    await page.getByRole('searchbox').fill('bisque');
    await page.locator('.search-hit').first().click();
    await inFocus(page, 'Kiln Studio', /^Message #kiln-studio/);
    await expect(sheet(page).locator('[data-ref="k1"]')).toBeVisible();
    // a project's own room is a room too
    await rail(page).getByRole('button', { name: touch() && (page.viewportSize()?.width ?? 0) < 600 ? 'More' : 'Search' }).click();
    if (touch() && (page.viewportSize()?.width ?? 0) < 600) await page.getByRole('button', { name: 'Search' }).click();
    await page.getByRole('searchbox').fill('glossy');
    await page.locator('.search-hit').first().click();
    await inFocus(page, /Glaze Tests|#glaze-tests/, /^Message #glaze-tests/);
  });

  test('what needs you on the home opens its room, its details showing the task', async ({ page }) => {
    await boot(page);
    await home(page).getByRole('button', { name: /^Needs you/ }).click();
    await home(page).getByRole('button', { name: /Find jars for the honey/ }).click();
    await inFocus(page, 'Bee Garden');
    await expect(details(page)).toBeVisible();
    await expect(details(page)).toContainText('Find jars for the honey');
  });

  test('a room the app reopens to, saved before this version, comes back in focus over All', async ({ page }) => {
    await page.addInitScript(() => {
      if (sessionStorage.getItem('test.savedOnce')) return;
      sessionStorage.setItem('test.savedOnce', '1');
      localStorage.setItem('uni.tabs.v2', JSON.stringify({ v: 1, tabs: [{ id: 't1', kind: 'room', channel: 'ch-table', title: 'long-table' }], active: 't1', recent: ['t1'] }));
    });
    await boot(page);
    await inFocus(page, 'Long Table', /^Message #long-table/);
  });

  test('an area page saved before this version comes back as its room in focus', async ({ page }) => {
    await page.addInitScript(() => {
      if (sessionStorage.getItem('test.savedOnce')) return;
      sessionStorage.setItem('test.savedOnce', '1');
      localStorage.setItem('uni.tabs.v2', JSON.stringify({ v: 1, tabs: [{ id: 't1', kind: 'area', path: 'Areas/North Field', channel: 'ch-north', title: 'North Field' }], active: 't1', recent: ['t1'] }));
    });
    await boot(page);
    await inFocus(page, 'North Field', /^Message #north-field/);
  });

  test('a room in focus is where the app reopens', async ({ page }) => {
    await boot(page);
    await home(page).locator('.fd-door[data-path="Areas/Bee Garden"]').click();
    await inFocus(page, 'Bee Garden');
    await page.reload();
    await inFocus(page, 'Bee Garden', /^Message #bee-garden/);
  });

  test('the home\'s composer: "Sent to" opens the room it went to in focus', async ({ page }) => {
    await boot(page);
    const field = home(page).getByRole('textbox', { name: /Talk to Uni|Message for your rooms/ });
    await field.fill('Choir: can we add a carol to the winter set?');
    await field.press('Enter');
    await home(page).getByRole('button', { name: /choir/i }).filter({ hasText: /choir/i }).last().click();
    await inFocus(page, 'Choir');
  });
});

test.describe('the focus head and the room\'s details', () => {
  test('the head is the name and one labelled line; a tap opens the details inside the focus; Back steps out', async ({ page }) => {
    await boot(page);
    await home(page).locator('.fd-door[data-path="Areas/Choir"]').click();
    await inFocus(page, 'Choir');
    // the line says where it comes from
    const line = sheet(page).locator('.all-focus-line');
    await expect(line).toHaveCount(1);
    await expect(line.locator('.all-focus-src')).toHaveText(/^#choir's summary/);
    await expect(line).toContainText('The hall is held on Tuesdays');
    // a tap on the head: the room's details, in the same sheet, over the same All
    await sheet(page).getByRole('button', { name: /Choir.*details/ }).click();
    await expect(details(page)).toBeVisible();
    await inFocus(page, 'Choir');
    await expect(details(page)).toContainText('The hall is held on Tuesdays; the winter set is printed.');
    await expect(details(page)).toContainText(/by #choir/);
    // Back: the conversation, then All
    if (touch()) await androidBack(page); else await page.keyboard.press('Escape');
    await expect(details(page)).toHaveCount(0);
    await expect(sheet(page).getByRole('textbox', { name: /^Message #choir/ })).toBeVisible();
    if (touch()) await androidBack(page); else await page.keyboard.press('Escape');
    await expect(sheet(page)).toHaveCount(0);
    await noOldView(page);
  });

  test('the details hold what the old room page did: needs you, its projects and sessions, all of its work', async ({ page }) => {
    await boot(page);
    await home(page).locator('.fd-door[data-path="Areas/Bee Garden"]').click();
    await sheet(page).getByRole('button', { name: /Bee Garden.*details/ }).click();
    await expect(details(page)).toContainText('Find jars for the honey');
    // a task opens its sheet over the focus, and closes back to the details
    await details(page).getByRole('button', { name: /Find jars for the honey/ }).first().click();
    const taskSheet = page.getByRole('dialog', { name: /Find jars for the honey/ });
    await expect(taskSheet).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(taskSheet).toHaveCount(0);
    await expect(details(page)).toBeVisible();
    // all of its work, still inside the focus
    await details(page).getByRole('button', { name: /All of Bee Garden's work/ }).click();
    await expect(sheet(page).getByRole('region', { name: /Bee Garden's work/ })).toBeVisible();
    await inFocus(page, 'Bee Garden');
    // a place with projects lists them; one opens over the focus
    if (touch()) await androidBack(page); else await page.keyboard.press('Escape');
    if (touch()) await androidBack(page); else await page.keyboard.press('Escape');
    if (touch()) await androidBack(page); else await page.keyboard.press('Escape');
    await expect(sheet(page)).toHaveCount(0);
  });

  test('a place with a place inside it: the details name it, one tap puts that room in focus', async ({ page }) => {
    await boot(page);
    await home(page).locator('.fd-door[data-path="Areas/Kiln Studio"]').click();
    await sheet(page).getByRole('button', { name: /Kiln Studio.*details/ }).click();
    await details(page).getByRole('button', { name: /Glaze Tests/ }).first().click();
    await inFocus(page, /Glaze Tests|#glaze-tests/, /^Message #glaze-tests/);
  });
});

test('the old room view is not in the app at all', async () => {
  const dir = new URL('../../dist-onesurface/assets/', import.meta.url);
  const js = readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => readFileSync(new URL(f, dir), 'utf8')).join('\n');
  // the tree of rooms beside a room, its drawer, the companion panel and the room's own page, by the words only they said
  for (const words of ['Rooms and places', 'Hide where this stands', 'Show where this stands', 'Back to the room', "'s page", 'Close places', 'Hide the sidebar']) {
    expect(js.includes(words), `"${words}" is still in the bundle`).toBe(false);
  }
});

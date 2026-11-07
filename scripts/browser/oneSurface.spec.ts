// T-335 one surface. All with a room in focus is the app: every way into a room opens that room in focus over All, on a phone and on a desktop,
// and the old room view (its tree of rooms beside the conversation, its companion panel, its own page) is gone: never on screen, and not in
// the bundle. The focus head is the room's name and at most one labelled line; a tap on it opens the room's details inside the focus.
// 0.2 one home: the rail's Uni is All's stream, and Uni's places (what needs you, the doors, the other rooms) are in the drawer its head pulls down.
// Made-up world only.
// Run: ONE_TEST_PORT=1493 npx playwright test --config playwright.onesurface.config.ts
import { readdirSync, readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { bootAreas, openPlaces } from './areasFixture';
import { railGo } from './railGo';

const rail = (page: Page) => page.getByRole('navigation', { name: 'Main navigation' });
const sheet = (page: Page) => page.getByRole('region', { name: /in focus$/ });
const home = (page: Page) => page.locator('[data-place="front-door"][data-view="all"]');
/** 0.2: Uni's places, pulled down from the home's head. */
async function drawer(page: Page) {
  // the drawer stands open while All's stream is still on its way, and folds when it comes: wait for the head's pull to be live first
  await expect(page.locator('[data-place="front-door"] .fd-pull')).toBeEnabled();
  await openPlaces(page);
  const d = page.locator('#fd-drawer');
  await expect(d).toBeVisible();
  return d;
}
const details = (page: Page) => sheet(page).getByRole('region', { name: /details$/ });
const androidBack = (page: Page) => page.evaluate(() => { const w = window as any; w.__cbs[w.__backHandler.id]({ message: {}, index: w.__backIndex ?? 0 }); w.__backIndex = (w.__backIndex ?? 0) + 1; });
const touch = () => test.info().project.name !== 'desktop';

/** Everything that belonged to the old room view: its tree beside the room, its drawer, its header, its companion, its thread bar, its work page. */
const OLD = ['.th-level', '[data-layout="rooms"]', '.th-roomnav', '.th-drawer', '.sr-drawer', '.sr-head', '.cp.side', '.cp.strip', '.sr-thread-back', '.all-focus-page'];
async function noOldView(page: Page) {
  for (const sel of OLD) await expect(page.locator(sel), `the old room view's ${sel}`).toHaveCount(0);
}

/** The room is in focus over All: All is the place (on the rail, as Uni), behind; the room's sheet is in front, with its own composer. */
async function inFocus(page: Page, name: string | RegExp, composer?: RegExp) {
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page).locator('.all-focus-title')).toHaveText(name);
  await expect(page.locator('.all-surface[data-focus="open"]')).toBeVisible();
  await expect(page.locator('.all-behind [data-view="all"]')).toHaveCount(1);
  await expect(rail(page).getByRole('button', { name: 'Uni', exact: true })).toHaveAttribute('aria-current', 'page');
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
  await bootAreas(page, 'seed', { world: 'unread', glow: true, uniMember: true, tasks: true, noWait: true, ...opts } as any);
  await page.locator('[data-place="front-door"]').first().waitFor();
}

test.describe('every way into a room lands in focus over All', () => {
  test('a place in the home\'s drawer', async ({ page }) => {
    await boot(page);
    await (await drawer(page)).locator('.fd-door[data-path="Areas/Choir"]').click();
    await inFocus(page, 'Choir', /^Message choir/);
    await expect(sheet(page)).toContainText('Sheet music for the winter set is printed');
    // Back: All, where the room was in front of it
    if (touch()) await androidBack(page); else await page.keyboard.press('Escape');
    await expect(sheet(page)).toHaveCount(0);
    await expect(page.locator('[data-view="all"]')).toBeVisible();
    await noOldView(page);
  });

  test('a place with no room of its own talks in the room it borrows, named for the place', async ({ page }) => {
    await boot(page);
    await (await drawer(page)).locator('.fd-door[data-path="Areas/Still Water"]').click();
    await inFocus(page, 'Still Water', /^Message uni/i);
    await expect(sheet(page).locator('.all-focus-line')).toHaveText(/^Talks in #uni · no room of its own yet$/i);
  });

  test('a room no area holds, from "New in other rooms"', async ({ page }) => {
    await boot(page, { unread: { 'ch-allot': 2 } });
    await (await drawer(page)).getByRole('region', { name: 'New in other rooms' }).getByRole('button', { name: /^#allotment/ }).click();
    await inFocus(page, '#allotment', /^Message allotment/);
    await expect(sheet(page)).toContainText('The water butt is full again.');
  });

  test('a private place, opened from the home, shows inside its focus only', async ({ page }) => {
    await boot(page);
    await (await drawer(page)).locator('.fd-door[data-path="Areas/Sanctum"]').click();
    await inFocus(page, 'Sanctum', /^Message sanctum/);
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
    await railGo(page, 'Search'); // 0.2: in More on a phone and a tablet
    await page.getByRole('searchbox').fill('bisque');
    await page.locator('.search-hit').first().click();
    await inFocus(page, 'Kiln Studio', /^Message kiln-studio/);
    await expect(sheet(page).locator('[data-ref="k1"]')).toBeVisible();
    // a project's own room is a room too
    await railGo(page, 'Search'); // 0.2: in More on a phone and a tablet
    await page.getByRole('searchbox').fill('glossy');
    await page.locator('.search-hit').first().click();
    await inFocus(page, /Glaze Tests|#glaze-tests/, /^Message glaze-tests/);
  });

  test('what needs you, in the home\'s drawer, opens its room with the ask\'s sheet over it (0.2.2: its action is said there)', async ({ page }) => {
    await boot(page);
    // 0.2: in the drawer the list is simply there, no "Needs you · N" to open first
    const needs = (await drawer(page)).getByRole('region', { name: 'Needs you' });
    await expect(needs.getByRole('button', { name: /^Needs you/ })).toHaveCount(0);
    await needs.getByRole('button', { name: /Find jars for the honey/ }).click();
    await inFocus(page, 'Bee Garden');
    const sheet = page.getByRole('dialog').filter({ has: page.locator('.task-kind') });
    await expect(sheet).toContainText('Find jars for the honey');
    await expect(sheet.locator('.task-kind')).toContainText('#bee-garden');
  });

  test('a room the app reopens to, saved before this version, comes back in focus over All', async ({ page }) => {
    await page.addInitScript(() => {
      if (sessionStorage.getItem('test.savedOnce')) return;
      sessionStorage.setItem('test.savedOnce', '1');
      localStorage.setItem('uni.tabs.v2', JSON.stringify({ v: 1, tabs: [{ id: 't1', kind: 'room', channel: 'ch-table', title: 'long-table' }], active: 't1', recent: ['t1'] }));
    });
    await boot(page);
    await inFocus(page, 'Long Table', /^Message long-table/);
  });

  test('an area page saved before this version comes back as its room in focus', async ({ page }) => {
    await page.addInitScript(() => {
      if (sessionStorage.getItem('test.savedOnce')) return;
      sessionStorage.setItem('test.savedOnce', '1');
      localStorage.setItem('uni.tabs.v2', JSON.stringify({ v: 1, tabs: [{ id: 't1', kind: 'area', path: 'Areas/North Field', channel: 'ch-north', title: 'North Field' }], active: 't1', recent: ['t1'] }));
    });
    await boot(page);
    await inFocus(page, 'North Field', /^Message north-field/);
  });

  test('a room in focus is where the app reopens', async ({ page }) => {
    await boot(page);
    await (await drawer(page)).locator('.fd-door[data-path="Areas/Bee Garden"]').click();
    await inFocus(page, 'Bee Garden');
    await page.reload();
    await inFocus(page, 'Bee Garden', /^Message bee-garden/);
  });

  test('the home\'s composer: "Sent to" opens the room it went to in focus', async ({ page }) => {
    await boot(page);
    const field = home(page).getByRole('region', { name: 'Talk to Uni' }).getByRole('textbox', { name: 'Message for your rooms' });
    await field.fill('Choir: can we add a carol to the winter set?');
    await home(page).getByRole('button', { name: /^Send to Choir/ }).click();
    const sent = home(page).locator('.all-link', { hasText: 'Choir' });
    await expect(sent).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).__calls.filter((c: any) => c.cmd === 'post_message').map((c: any) => c.args.channel))).toEqual(['ch-choir']);
    await sent.click();
    await inFocus(page, 'Choir', /^Message choir/);
    await expect(sheet(page)).toContainText('can we add a carol to the winter set?');
  });
});

test.describe('the focus head and the room\'s details', () => {
  test('the head is the name and one labelled line; a tap opens the details inside the focus; Back steps out', async ({ page }) => {
    await boot(page);
    await (await drawer(page)).locator('.fd-door[data-path="Areas/Choir"]').click();
    await inFocus(page, 'Choir');
    // the line says where it comes from
    const line = sheet(page).locator('.all-focus-line');
    await expect(line).toHaveCount(1);
    await expect(line.locator('.all-focus-src')).toHaveText(/^#choir's summary/);
    await expect(line).toContainText('The hall is held on Tuesdays');
    // a tap on the head, its line too: the room's details, in the same sheet, over the same All
    if (touch()) await line.tap(); else await line.click();
    await expect(details(page)).toBeVisible();
    await inFocus(page, 'Choir');
    await expect(details(page)).toContainText('The hall is held on Tuesdays; the winter set is printed.');
    await expect(details(page)).toContainText(/by #choir/);
    // Back: the conversation, then All
    if (touch()) await androidBack(page); else await page.keyboard.press('Escape');
    await expect(details(page)).toHaveCount(0);
    await expect(sheet(page).getByRole('textbox', { name: /^Message choir/ })).toBeVisible();
    if (touch()) await androidBack(page); else await page.keyboard.press('Escape');
    await expect(sheet(page)).toHaveCount(0);
    await noOldView(page);
  });

  test('the details hold what the old room page did: needs you, its projects and sessions, all of its work', async ({ page }) => {
    await boot(page);
    await (await drawer(page)).locator('.fd-door[data-path="Areas/Bee Garden"]').click();
    await sheet(page).getByRole('button', { name: /Bee Garden.*details/ }).click();
    await expect(details(page)).toContainText('Find jars for the honey');
    // a task opens its sheet over the focus, and closes back to the details
    await details(page).getByRole('button', { name: /Find jars for the honey/ }).first().click();
    const taskSheet = page.getByRole('dialog', { name: /twenty jars|Find jars/ });
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
    await (await drawer(page)).locator('.fd-door[data-path="Areas/Kiln Studio"]').click();
    await sheet(page).getByRole('button', { name: /Kiln Studio.*details/ }).click();
    await details(page).getByRole('button', { name: /Glaze Tests/ }).first().click();
    await inFocus(page, /Glaze Tests|#glaze-tests/, /^Message glaze-tests/);
  });
});

test.describe('review 1', () => {
  test('to Mail and back: the room is still in focus, by the rail\'s Uni and by Back', async ({ page }) => {
    await boot(page);
    await (await drawer(page)).locator('.fd-door[data-path="Areas/Choir"]').click();
    await inFocus(page, 'Choir');
    const go = (name: 'Uni' | 'Mail') => rail(page).getByRole('button', { name, exact: true }).click();
    await go('Mail');
    await expect(sheet(page)).toHaveCount(0);
    await go('Uni');
    await inFocus(page, 'Choir', /^Message choir/);
    // 0.2: Mail has no Back pill of its own; the way back is the rail's Uni (above) or the Android back
    await go('Mail');
    await expect(page.locator('.mail-bar').getByRole('button', { name: /^← / })).toHaveCount(0);
    if (touch()) {
      await androidBack(page);
      await inFocus(page, 'Choir', /^Message choir/);
    }
  });

  test('a place inside another that talks in its room is in the details, and opens named for itself', async ({ page }) => {
    await page.addInitScript(() => { const w = window as any; w.__extraInvoke = async (cmd: string) => { if (cmd === 'route_suggest') throw 'x'; if (cmd === 'route_outcome') return {}; return undefined; }; });
    await bootAreas(page, 'seed', { tree: true, atlas: true, tasks: true, uniMember: true, noWait: true } as any);
    await page.locator('[data-place="front-door"]').first().waitFor();
    await (await drawer(page)).locator('.fd-door[data-path="Areas/Atlas"]').click();
    await sheet(page).getByRole('button', { name: /Atlas.*details/ }).click();
    const inside = details(page).getByRole('region', { name: 'Inside Atlas' });
    await expect(inside.getByRole('button', { name: /Atlas Institute/ })).toContainText('talks in #atlas');
    await inside.getByRole('button', { name: /Atlas Institute/ }).click();
    await inFocus(page, 'Atlas Institute');
    await expect(sheet(page).locator('.all-focus-line')).toHaveText(/^Talks in #atlas · no room of its own yet$/);
  });

  test('a search hit in a room a place borrows is that room, not the place last in focus', async ({ page }) => {
    await boot(page, {}, () => {
      const w = window as any, now = Math.floor(Date.now() / 1000);
      w.__hits = [{ channel_name: 'Uni', snippet: 'A word for the uni room', message: { ref: 'u1', channel: 'uni-room', author: 'b'.repeat(64), author_name: 'Uni', ts: now - 3000, body: 'A word for the uni room', mentions_me: false, root: null, parent: null, mentions: [], reply_count: 0, last_reply_ts: null, edited: false, reactions: [], media: [] } }];
      w.__msgsSeed = true;
    });
    await (await drawer(page)).locator('.fd-door[data-path="Areas/Still Water"]').click();
    await inFocus(page, 'Still Water');
    await page.keyboard.press('Control+k');
    await page.getByRole('searchbox').fill('uni room');
    await page.locator('.search-hit').first().click();
    await inFocus(page, 'Uni');
    await expect(sheet(page).locator('.all-focus-line')).toHaveCount(0);
  });

  test('the focus is not rebuilt when the places arrive late: the composer keeps its keys', async ({ page }) => {
    test.skip(touch(), 'the keys go to the composer on a desktop');
    await page.addInitScript(() => {
      if (sessionStorage.getItem('test.savedOnce')) return;
      sessionStorage.setItem('test.savedOnce', '1');
      localStorage.setItem('uni.tabs.v2', JSON.stringify({ v: 1, tabs: [{ id: 't1', kind: 'all', title: 'All', channel: 'ch-kiln' }], active: 't1', recent: ['t1'] }));
    });
    await boot(page, { queryDelay: 2500 });
    const box = sheet(page).getByRole('textbox', { name: /^Message kiln-studio/ });
    await box.click();
    await box.pressSequentially('half a thought');
    await box.evaluate((el) => { (el as any).__same = true; });
    await expect(sheet(page).locator('.all-focus-title')).toHaveText('Kiln Studio', { timeout: 15_000 });
    expect(await box.evaluate((el) => (el as any).__same === true && document.activeElement === el)).toBe(true);
    await expect(box).toHaveValue('half a thought');
  });

  test('a vault without rooms: its tree, Uni\'s own level with all of the work, and each place\'s work', async ({ page }) => {
    await bootAreas(page, 'seed', { briefs: true, tree: true, tasks: true, boulder: true, underBoulder: true, priya: true, pinned: true, lifeVault: 'pack' } as any);
    await expect(page.locator('.th-phone-tree')).toBeVisible();
    await page.locator('.th-go[data-path=""]').click();
    await expect(page.getByRole('region', { name: /'s work$/ }).locator('.wp-title')).toBeVisible();
    await expect(page.locator('.sr-work').getByRole('region', { name: 'Needs you' })).toBeVisible();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(page.locator('.th-phone-tree')).toBeVisible();
    await page.getByRole('button', { name: /^Boulder,/ }).first().click();
    await expect(page.locator('.wp-title')).toHaveText('Boulder');
    await noOldView(page);
    expect(await page.evaluate(() => (window as any).__calls.filter((c: any) => c.cmd === 'post_message').length)).toBe(0);
  });
});

test('review 2: a room that goes away while in focus leaves it, and All forgets it', async ({ page }) => {
  await boot(page);
  await (await drawer(page)).locator('.fd-door[data-path="Areas/Choir"]').click();
  await inFocus(page, 'Choir');
  await page.evaluate(() => {
    const w = window as any, original = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (cmd: string, args: any) => { const r = await original(cmd, args); return cmd === 'get_rooms' ? r.filter((x: any) => x.id !== 'ch-choir') : r; };
    for (const h of w.__listeners['uni://live'] ?? []) w.__cbs[h]?.({ event: 'uni://live', id: 1, payload: { kind: 'rooms' } });
  });
  await expect(sheet(page)).toHaveCount(0);
  await expect(page.locator('[data-view="all"]')).toBeVisible();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('uni.tabs.v2') ?? '{}').tabs?.some((t: any) => t.channel === 'ch-choir') ?? false)).toBe(false);
});

test('the old room view is not in the app at all', async () => {
  const dir = new URL('../../dist-onesurface/assets/', import.meta.url);
  const js = readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => readFileSync(new URL(f, dir), 'utf8')).join('\n');
  // the tree of rooms beside a room, its drawer, the companion panel and the room's own page, by the words only they said
  for (const words of ['Rooms and places', 'Hide where this stands', 'Show where this stands', 'Back to the room', "'s page", 'Close places', 'Hide the sidebar']) {
    expect(js.includes(words), `"${words}" is still in the bundle`).toBe(false);
  }
});

// T-335 as Aaron: the papercuts found walking the whole app as its owner, one flow each. Nearly all fail on the build before the fix (8c7241ae); the ones marked guard hold a line that was already right, and were proven by a bug of this pass.
// Made-up data only: the fixtures are the tour's.
import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { bootAreas, openPlaces, type BootOpts, openForYou } from './areasFixture';
import { installNotePaneFixture } from './notePaneFixture';
import * as mailMock from './mailMock';
import * as calMock from './calMock';
import { railGo, railNav, openRailMore } from './railGo';

const USAGE = JSON.parse(readFileSync(new URL('../fixtures/usage-note.json', import.meta.url), 'utf8'));
const PROMPTS = JSON.parse(readFileSync(new URL('../fixtures/approval-prompts.json', import.meta.url), 'utf8'));
const phone = () => test.info().project.name === 'phone';
const onlyPhone = () => test.skip(!phone(), 'a phone-size papercut');

async function glow(page: Page, o: BootOpts = {}, native?: (cmd: string, args: any) => unknown) {
  if (native) await page.addInitScript(`window.__extraInvoke = async (cmd, args) => (${native.toString()})(cmd, args);`);
  await bootAreas(page, 'seed', { world: 'unread', glow: true, uniMember: true, unread: { 'ch-kiln': 1, 'ch-bees': 2 }, ...o });
  await page.locator('[data-place="front-door"]').waitFor();
}
async function kiln(page: Page, o: BootOpts = {}) {
  await glow(page, o);
  await openPlaces(page);
  await page.locator('.fd-door[data-path="Areas/Kiln Studio"]').click();
  await focus(page).getByRole('textbox', { name: /^Message / }).waitFor();
  await expect(focus(page).locator('.message-list article.message').first()).toBeVisible();
}
/** T-335 one surface: a room is in focus over All. */
const focus = (page: Page) => page.getByRole('region', { name: /in focus$/ });
/** A long press on a message (a finger down until the sheet is up, then up): its actions sheet (as chatfeel.spec.ts does). */
async function longPress(page: Page, msg: ReturnType<Page['locator']>) {
  await msg.scrollIntoViewIfNeeded();
  const b = (await msg.locator('p').first().boundingBox())!;
  const at = { x: b.x + 20, y: b.y + 8 };
  await page.evaluate(({ x, y }) => { document.elementFromPoint(x, y)!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, pointerType: 'touch', isPrimary: true })); }, at);
  const sheet = page.getByRole('dialog', { name: 'Message actions' });
  await expect(sheet).toBeVisible();
  await page.evaluate(({ x, y }) => { document.elementFromPoint(x, y)!.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y, pointerType: 'touch', isPrimary: true })); }, at);
  return sheet;
}
const TASKS: BootOpts = { briefs: true, tree: true, tasks: true, atlas: true, steer: true, pinned: true, uniMember: true };
/** The tour's way into an ask of the tasks world: Uni's home, For you at its top (0.3.0; it replaced the drawer's Needs-you list), its first
 *  item: its room in focus (T-335), with the ask's sheet over it (0.2.2). */
async function openAskFromHome(page: Page) {
  await page.locator('[data-place="front-door"]').first().waitFor();
  await openForYou(page);
  await page.getByRole('region', { name: 'For you' }).locator('.fy-what').first().click();
  await expect(focus(page)).toBeVisible();
}

// ---------------------------------------------------------------- the rail
test('the phone bar is three places and More; the rest open from a sheet that closes itself', async ({ page }) => {
  onlyPhone();
  await glow(page);
  const rail = railNav(page);
  // 0.2 one home: no All (Uni is All's stream) and no For you on the rail (it opens from the home's drawer)
  for (const name of ['Uni', 'Journal', 'Mail', 'More']) await expect(rail.getByRole('button', { name, exact: true })).toBeVisible();
  for (const name of ['All', 'For you']) await expect(rail.getByRole('button', { name, exact: true })).toHaveCount(0);
  for (const name of ['To post', 'Arcade', 'Vault', 'Search', 'Settings']) await expect(rail.getByRole('button', { name, exact: true })).toBeHidden();
  // every label fits: nothing is cut or squeezed under 60 px wide
  const widths = await rail.locator('> button').evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent).map((e) => e.getBoundingClientRect().width));
  expect(widths.length).toBe(4);
  for (const w of widths) expect(w).toBeGreaterThanOrEqual(60);
  const more = rail.getByRole('button', { name: 'More', exact: true });
  await more.click();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  for (const name of ['To post', 'Arcade', 'Vault', 'Search', 'Settings']) await expect(rail.getByRole('button', { name, exact: true })).toBeVisible();
  // a tap on the scrim closes it; Escape closes it; going somewhere closes it and More says you're in there
  await page.getByRole('button', { name: 'Close More' }).click({ position: { x: 20, y: 20 } });
  await expect(rail.getByRole('button', { name: 'Search', exact: true })).toBeHidden();
  await more.click();
  await page.keyboard.press('Escape');
  await expect(rail.getByRole('button', { name: 'Search', exact: true })).toBeHidden();
  await railGo(page, 'Settings');
  await expect(page.locator('.settings')).toBeVisible();
  await expect(rail.getByRole('button', { name: 'Settings', exact: true })).toBeHidden();
  await expect(more).toHaveAttribute('aria-current', 'page');
});

test('the bar stays in reach over a panel, and any way out closes the sheet (review round 1)', async ({ page }) => {
  onlyPhone();
  await glow(page);
  const rail = railNav(page);
  await railGo(page, 'Settings');
  await expect(page.locator('.settings')).toBeVisible();
  // More over an open panel: the panel goes, the sheet is on top and its places can be tapped
  await rail.getByRole('button', { name: 'More', exact: true }).click();
  await expect(page.locator('.settings')).toBeHidden();
  await rail.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('searchbox', { name: 'Search conversations and notes' })).toBeVisible();
  // a place on the bar over an open panel goes there, not just closes the panel
  await rail.getByRole('button', { name: 'Journal', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Journal entry', exact: true })).toBeVisible();
  // with the sheet open, a place on the bar goes there and the sheet closes
  await rail.getByRole('button', { name: 'More', exact: true }).click();
  await rail.getByRole('button', { name: 'Uni', exact: true }).click();
  await expect(rail.getByRole('button', { name: 'Settings', exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Close More' })).toHaveCount(0);
});

test('the sheet doesn\'t outlive a rotation', async ({ page }) => {
  onlyPhone();
  await glow(page);
  await railNav(page).getByRole('button', { name: 'More', exact: true }).click();
  await page.setViewportSize({ width: 844, height: 390 });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(railNav(page).getByRole('button', { name: 'Settings', exact: true })).toBeHidden();
});

test('ink: the knots and the sheet are black on white, by shape', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('uni.motion', 'calm'));
  await glow(page);
  const knot = page.locator('.fd-knot').first();
  expect(await knot.evaluate((e) => getComputedStyle(e).opacity)).toBe('1');
  expect(await knot.evaluate((e) => getComputedStyle(e).animationName)).toBe('none');
});

test('closing a panel opened from the sheet gives focus back to More', async ({ page }) => {
  onlyPhone();
  await glow(page);
  await railGo(page, 'Settings');
  await page.getByRole('button', { name: 'Close panel', exact: true }).click();
  await expect(railNav(page).getByRole('button', { name: 'More', exact: true })).toBeFocused();
});

test('guard: a wider screen keeps every place on the rail and has no More', async ({ page }) => {
  test.skip(phone(), 'desktop');
  await glow(page);
  const rail = railNav(page);
  await expect(rail.getByRole('button', { name: 'More', exact: true })).toBeHidden();
  for (const name of ['Uni', 'Journal', 'Mail', 'To post', 'Arcade', 'Vault', 'Search', 'Settings']) await expect(rail.getByRole('button', { name, exact: true })).toBeVisible();
  // Settings still sits at the bottom of the rail
  const settings = (await rail.getByRole('button', { name: 'Settings', exact: true }).boundingBox())!;
  expect(settings.y).toBeGreaterThan(page.viewportSize()!.height * 0.7);
});

test('the rail draws every place with one hand: no text glyphs', async ({ page }) => {
  await glow(page);
  await openRailMore(page);
  const glyphs = await railNav(page).locator('button > i').evaluateAll((els) => els.filter((e) => !e.querySelector('svg')).map((e) => e.textContent));
  expect(glyphs).toEqual([]);
});

// ---------------------------------------------------------------- a room
test('a room says what it is once: no "Last written by", no "no folder yet", no channel over the name on a phone', async ({ page }) => {
  await kiln(page);
  const body = focus(page);
  await expect(body).toBeVisible();
  await expect(body).not.toContainText('no folder yet');
  if (phone()) {
    // r29 / T-335: the head's one line says whose account it is (the room that wrote it), never "Last written"
    await expect(body.locator('.all-focus-line')).toContainText(/^#kiln-studio's summary: Glaze tests are out/);
    await expect(body.locator('.all-focus-line')).not.toContainText('Last written');
    await expect(body.locator('.all-focus-line')).toHaveCount(1);
    // the chat gets the room: the head and its line take at most 130 px
    const list = (await body.locator('.message-list').boundingBox())!;
    expect(list.y).toBeLessThanOrEqual(130);
  }
});

test('a long room name ends in an ellipsis', async ({ page }) => {
  await kiln(page);
  // T-335: the name in the focus head (its button, a flex item of the heading, is the box that cuts)
  const t = await focus(page).locator('.all-focus-title .all-focus-open').evaluate((el) => { el.textContent = 'A very long room name that goes on and on and on and on past any window, however wide, whatever the screen, and on again'; const s = getComputedStyle(el); return { display: s.display, overflow: s.textOverflow, cut: el.scrollWidth > el.clientWidth }; });
  expect(t.display).toBe('block');
  expect(t.overflow).toBe('ellipsis');
  expect(t.cut).toBe(true);
});

test('a project that isn\'t set up is said once, under all of the room\'s work', async ({ page }) => {
  await kiln(page);
  await expect(focus(page).locator('[data-place="project-strip"]')).toHaveCount(0);
  // T-335: all of its work is in the room's details
  await focus(page).getByRole('button', { name: /: room details$/ }).click();
  await focus(page).getByRole('button', { name: /^All of Kiln Studio/ }).click();
  await expect(page.locator('.wv-gaps')).toContainText('Glaze Tests: not set up yet');
});

test('the composer ring sits in line with the mic and Send, in the room\'s colour', async ({ page }) => {
  onlyPhone();
  await kiln(page);
  const center = async (sel: string) => { const b = (await focus(page).locator(sel).first().boundingBox())!; return b.y + b.height / 2; };
  expect(Math.abs(await center('.compose-uni') - await center('.compose-row .send'))).toBeLessThanOrEqual(2);
  const ring = await focus(page).locator('.compose-uni').evaluate((el) => { const s = getComputedStyle(el), b = getComputedStyle(el, '::before'); return { display: s.display, shadow: b.boxShadow, tint: getComputedStyle(el.closest('.all-focus')!).getPropertyValue('--room-tint') }; });
  expect(ring.display).toBe('flex');
  expect(ring.tint).toContain('hsl');
  const tintRgb = await focus(page).locator('.compose-uni').evaluate((el) => { const p = document.createElement('i'); p.style.color = 'var(--room-tint)'; el.append(p); const c = getComputedStyle(p).color; p.remove(); return c; });
  expect(ring.shadow).toContain(tintRgb);
});

test('every room wears one colour: the home\'s door, All\'s stream and the room agree', async ({ page }) => {
  await glow(page);
  // 0.2 one home: the doors are in the drawer under the home's head, the stream under it
  await openPlaces(page);
  const door = page.locator('.fd-door[data-path="Areas/Kiln Studio"]');
  const tint = await door.evaluate((el) => (el as HTMLElement).style.getPropertyValue('--room-tint'));
  expect(tint).toContain('hsl');
  await page.locator('.fd-pull').click();
  await expect(page.locator('#fd-drawer')).toHaveCount(0);
  const chip = page.locator('.all-place', { hasText: 'Kiln Studio' }).first();
  await expect(chip).toBeVisible();
  expect(await chip.evaluate((el) => (el as HTMLElement).style.getPropertyValue('--room-tint'))).toBe(tint);
  await openPlaces(page);
  await page.locator('.fd-door[data-path="Areas/Kiln Studio"]').click();
  await focus(page).getByRole('textbox', { name: /^Message / }).waitFor();
  expect(await focus(page).evaluate((el) => (el as HTMLElement).style.getPropertyValue('--room-tint'))).toBe(tint);
});

test('a toast never sits on the composer', async ({ page }) => {
  onlyPhone();
  await kiln(page);
  // 0.2: on a touch screen Copy is in the latest reply's long-press sheet, not its always-on row
  const latest = focus(page).locator('.message-list article.message').last();
  await expect(latest.getByRole('group', { name: 'Message actions' }).getByRole('button', { name: 'Copy', exact: true })).toBeHidden();
  const sheet = await longPress(page, latest);
  await page.waitForTimeout(450); // the sheet takes no tap in its first 400 ms
  await sheet.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(page.locator('.toast')).toBeVisible();
  const toast = (await page.locator('.toast').boundingBox())!;
  const composer = (await focus(page).locator('.compose-row').boundingBox())!;
  expect(toast.y + toast.height).toBeLessThanOrEqual(composer.y);
});

test('a note link in chat is the note\'s title, never its id', async ({ page }) => {
  await page.addInitScript(installNotePaneFixture);
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'Message Orchard' })).toBeVisible();
  const chips = page.locator('.message-list .note-chip');
  await expect(chips.first()).toBeVisible();
  for (const t of await chips.allTextContents()) expect(t).not.toMatch(/[0-9A-HJKMNP-TV-Z]{8}…/);
});

test('leaving an unsaved note says what each button does; the safe one is first', async ({ page }) => {
  await page.addInitScript(installNotePaneFixture);
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'Message Orchard' })).toBeVisible();
  await page.waitForTimeout(1700);
  const chip = page.locator('.message-list .note-chip', { hasText: 'Spring planting plan' }).first();
  await chip.scrollIntoViewIfNeeded();
  await chip.click();
  const pane = page.locator('.note-pane');
  await pane.getByRole('button', { name: 'Edit' }).click();
  await pane.getByRole('textbox', { name: 'Note content' }).fill('# Spring planting plan\n\nA changed line.');
  await pane.getByRole('button', { name: 'Close note' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog.getByRole('button', { name: 'Keep editing' })).toBeFocused();
  await expect(dialog.getByRole('button', { name: 'Close note' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Continue' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Keep editing' }).click();
  await expect(pane.getByRole('textbox', { name: 'Note content' })).toHaveValue(/A changed line/);
  await pane.getByRole('button', { name: 'Close note' }).click();
  await dialog.getByRole('button', { name: 'Close note' }).click();
  await expect(pane).toBeHidden();
});

test('a note on a phone keeps its tools on one row, and Quote only shows when there is a passage', async ({ page }) => {
  onlyPhone();
  await page.addInitScript(installNotePaneFixture);
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'Message Orchard' })).toBeVisible();
  await page.waitForTimeout(1700);
  const chip = page.locator('.message-list .note-chip', { hasText: 'Spring planting plan' }).first();
  await chip.scrollIntoViewIfNeeded();
  await chip.tap();
  const bar = page.locator('.note-pane .note-bar');
  await expect(page.locator('.note-pane .note-body')).toBeVisible();
  expect((await bar.boundingBox())!.height).toBeLessThanOrEqual(64);
  await expect(page.locator('.note-pane').getByRole('button', { name: 'Quote in reply' })).toBeHidden();
  await expect(page.locator('.note-pane').getByRole('button', { name: 'Open as page' })).toBeVisible();
});

// ---------------------------------------------------------------- tasks, decisions, approvals
test('a task sheet speaks plainly: no "due due", no task number', async ({ page }) => {
  await bootAreas(page, 'seed', TASKS);
  await openAskFromHome(page);
  const sheet = page.locator('.task-sheet').first();
  await expect(sheet).toBeVisible();
  await expect(sheet).not.toContainText(/due due/i);
  for (const dd of await sheet.locator('.task-facts dd').allTextContents()) expect(dd).not.toMatch(/\bdue\b/);
  await sheet.locator('summary', { hasText: 'Details' }).click();
  await expect(sheet).not.toContainText(/\bT-\d+\b/);
});

test('a waiting approval is from Uni, not from a program\'s name', async ({ page }) => {
  await bootAreas(page, 'seed', { tree: true, tasks: true, briefs: true, strayRoom: true });
  await page.locator('[data-place="front-door"]').waitFor();
  await page.evaluate(([c, n, b]) => (window as any).__arrive(c, n, b), ['ch-garden', 'Uni', PROMPTS.prompts.two_answers_30min] as const);
  await openPlaces(page);
  await page.locator('.cp-approval').getByRole('button').click();
  await expect(page.locator('.message.approval-waiting')).toContainText('Uni needs your OK');
  await expect(page.locator('.message.approval-waiting')).not.toContainText('Hermes needs');
});

// ---------------------------------------------------------------- Settings
test('Settings: the update first, nothing that can\'t be used, the dangerous one small and last', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-26T18:00:00Z')); // the usage fixture's own Monday, so its reading is fresh
  await page.addInitScript((usage) => { (window as any).__extraInvoke = async (cmd: string, a: any) => cmd === 'plugin:app|version' ? '0.1.98' : cmd === 'vault_note' && a.noteRef === 'System/Claude accounts' ? { hub: 'https://hub.example.ts.net', vault: 'uni', note: usage } : undefined; }, USAGE);
  await glow(page);
  await railGo(page, 'Settings');
  const settings = page.locator('.settings');
  await expect(settings).toBeVisible();
  // "Up to date" isn't news; it stays for a screen reader
  await expect(settings.locator('.connection')).toHaveAttribute('data-fine', 'true');
  expect((await settings.locator('.connection').boundingBox())!.height).toBeLessThanOrEqual(1);
  // pairing that this device can't do isn't offered as a grey button
  await expect(page.getByRole('button', { name: 'Pair a device' })).toHaveCount(0);
  await expect(settings).not.toContainText('requires native device unlock');
  // order: updates above Claude accounts, Forget in This device, below approvals
  const y = async (l: ReturnType<Page['locator']>) => (await l.boundingBox())!.y + await settings.evaluate((e) => e.scrollTop ?? 0);
  const update = settings.locator('.update-settings');
  await expect(settings.locator('.usage-card')).toBeVisible();
  expect(await y(update)).toBeLessThan(await y(settings.locator('.usage-card')));
  const forget = settings.getByRole('button', { name: /Forget this device/ });
  expect(await y(update)).toBeLessThan(await y(forget));
  await expect(settings.getByRole('region', { name: 'This device' }).getByRole('button', { name: /Forget this device/ })).toBeVisible();
  // Forget reads as a danger, not as the same pill as everything else
  const f = await forget.evaluate((e) => { const s = getComputedStyle(e); return { border: s.borderTopStyle, bg: s.backgroundColor }; });
  expect(f.border).toBe('none');
  expect(f.bg).toBe('rgba(0, 0, 0, 0)');
});

test('Settings says so when the live line has a problem, even with the sync up to date (review round 1)', async ({ page }) => {
  await glow(page);
  await railGo(page, 'Settings');
  const line = page.locator('.settings .connection');
  await expect(line).toHaveAttribute('data-fine', 'true');
  await page.evaluate(() => { const w = window as any; for (const h of w.__listeners?.['uni://live'] ?? []) w.__cbs[h]?.({ event: 'uni://live', id: 1, payload: { kind: 'status', status: 'Reconnecting in 5s' } }); });
  await expect(line).toContainText('Reconnecting in 5s');
  await expect(line).not.toHaveAttribute('data-fine', 'true');
  expect((await line.boundingBox())!.height).toBeGreaterThan(8);
});

// ---------------------------------------------------------------- the vault
test('one vault: Vault goes straight in; an open folder has small marks, not buttons of words', async ({ page }) => {
  await glow(page);
  await railGo(page, 'Vault');
  const browser = page.locator('.vault-browser');
  await expect(browser).toBeVisible();
  await expect(page.getByRole('region', { name: 'Vaults' })).toBeHidden();
  await expect(browser.getByRole('button', { name: 'Refresh' }).locator('svg')).toBeVisible();
  await expect(browser.getByRole('button', { name: 'New note here' })).toHaveCount(0);
  // 0.2: a folder's own "+" shows only where there is hover; a phone has the one New note at the top
  if (phone()) await expect(browser.getByRole('button', { name: 'New note in Areas' })).toBeHidden();
  else {
    const plus = browser.getByRole('button', { name: 'New note in Areas' });
    await browser.locator('.vault-folder', { has: page.getByRole('button', { name: 'New note in Areas' }) }).first().hover();
    await expect(plus).toBeVisible();
    await expect(plus.locator('xpath=..')).toHaveCSS('opacity', '1');
  }
  await expect(browser.getByRole('button', { name: 'New note', exact: true })).toBeVisible();
  await browser.getByRole('button', { name: 'New note', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New note' });
  await expect(dialog).toContainText('Name');
  await expect(dialog).not.toContainText('Path');
});

test('one vault, whatever it is called, goes straight in', async ({ page }) => {
  await glow(page, {}, (cmd) => (cmd === 'vault_list' ? ['garden'] : undefined));
  await railGo(page, 'Vault');
  await expect(page.locator('.vault-browser')).toBeVisible();
  await expect(page.locator('.vault-browser .note-bar strong')).toHaveText('garden');
});

// ---------------------------------------------------------------- Search
test('Search: nothing found is one line and a next step; a found note\'s folder is on its own line', async ({ page }) => {
  await kiln(page);
  if (phone()) await railGo(page, 'Search'); else await page.keyboard.press('Control+k');
  const field = page.getByRole('searchbox', { name: 'Search conversations and notes' });
  await field.fill('zzzqqq nothing like this');
  const none = page.locator('.search-nothing');
  await expect(none).toContainText('Nothing here for');
  // 0.2.2: the fallback asks the Uni of the room you were in, and says which
  await expect(none.getByRole('button', { name: /^Ask Uni in #\S+ to look$/ })).toBeVisible();
  await expect(page.locator('.search-section')).toHaveCount(0);
  await field.fill('glaze');
  const hit = page.locator('.search-hit').first();
  await expect(hit).toBeVisible();
  await expect(page.locator('.search-results')).not.toContainText('keyword');
  await expect(page.locator('.search-nothing')).toHaveCount(0);
  const path = page.locator('.search-path').first();
  await expect(path).toHaveCSS('display', 'block');
  await expect(page.getByText('Narrow the notes')).toHaveCount(0);
  // typing on from a query that found nothing never shows "nothing" for words not yet searched
  await field.fill('zzzqqq nothing like this');
  await expect(none).toContainText('Nothing here for');
  await field.pressSequentially(' again');
  await expect(page.locator('.search-nothing')).toHaveCount(0);
});

// ---------------------------------------------------------------- the home
test('the home: a quiet day has its own line, the places sit on one thread, and All explains only what it guessed', async ({ page }) => {
  await glow(page);
  // 0.3.1: For you's head is the day's line on the home: nothing for you, then the day's quiet line
  await expect(page.locator('.fy-toggle')).toHaveText(/^Nothing for you · /);
  const quiet = (await page.locator('.fy-toggle .fy-sum > span').last().textContent())!.replace(/^ · /, '');
  expect(['All quiet.', 'The rooms are resting.', 'The mycelium has it.', 'Go look at a tree.', "Nothing's on fire.", 'Breathe out.', 'The garden keeps itself today.']).toContain(quiet);
  // 0.2 one home: the thread runs under the day's sentence; its knots are the drawer's doors, one each
  await openPlaces(page);
  await expect(page.locator('.fd-weave .fd-knot')).toHaveCount(await page.locator('.fd-door').count());
  await expect(page.locator('.fd-weave .fd-knot.fresh').first()).toBeVisible();
  await expect(page.locator('.fd-door[data-path="Areas/Kiln Studio"]')).not.toContainText('#kiln-studio');
  // All's composer is the home's own, at its foot
  await page.getByRole('region', { name: 'Talk to Uni' }).getByRole('textbox', { name: 'Message for your rooms' }).fill('Tell Choir and North Field the hall is booked for Tuesday');
  await expect(page.locator('.all-chip.chosen').first()).toBeVisible();
  await expect(page.locator('.all-why')).toHaveCount(0);
});

test('the home never says less than the cards beside it: an approval waiting is not "Nothing needs you" (review round 3)', async ({ page }) => {
  await bootAreas(page, 'seed', { tree: true, tasks: true, briefs: true, strayRoom: true });
  await page.locator('[data-place="front-door"]').waitFor();
  await page.evaluate(([c, n, b]) => (window as any).__arrive(c, n, b), ['ch-garden', 'Uni', PROMPTS.prompts.two_answers_30min] as const);
  await openPlaces(page);
  await expect(page.locator('#fd-drawer .cp-approval')).toBeVisible();
  await expect(page.locator('.fy-toggle')).not.toContainText('Nothing for you');
  await expect(page.locator('.fy-toggle')).toContainText('1 waiting for your OK');
});

test('a re-read that fails after a good one doesn\'t leave the home saying nothing needs you (code review)', async ({ page }) => {
  test.setTimeout(90_000); // the re-read comes on the tasks' own timer, up to 80 s after the good one
  await page.addInitScript(() => { (window as any).__extraInvoke = async (cmd: string, a: any) => { if (cmd.startsWith('vault_query') && ['task', 'decision'].includes(a.tag) && (window as any).__failTasks) throw new Error('the vault did not answer'); if (cmd.startsWith('vault_query') && ['task', 'decision'].includes(a.tag)) return []; return undefined; }; });
  await bootAreas(page, 'seed', { tree: true, tasks: true, uniMember: true });
  await page.locator('[data-place="front-door"]').waitFor();
  await expect(page.locator('.fy-toggle')).toContainText('Nothing for you');
  await page.evaluate(() => { (window as any).__failTasks = true; document.dispatchEvent(new Event('visibilitychange')); });
  await expect(page.locator('.fy-toggle')).toContainText("Couldn't check what needs you", { timeout: 80_000 });
});

test('a failed read of what needs you says so and offers another try, instead of "Nothing needs you" (review round 3)', async ({ page }) => {
  await page.addInitScript(() => { (window as any).__extraInvoke = async (cmd: string, a: any) => { if (cmd.startsWith('vault_query') && a.tag === 'task' && (window as any).__failTasks !== false) throw new Error('the vault did not answer'); return undefined; }; });
  await bootAreas(page, 'seed', { tree: true, tasks: true, uniMember: true });
  await page.locator('[data-place="front-door"]').waitFor();
  await expect(page.locator('.fy-toggle')).toContainText("Couldn't check what needs you");
  await expect(page.locator('.fy-toggle')).not.toContainText('Nothing for you');
  await page.evaluate(() => { (window as any).__failTasks = false; });
  // 0.2: the other try is in the home's drawer, at its top
  await openPlaces(page);
  await page.locator('#fd-drawer').getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('.fy-toggle')).not.toContainText("Couldn't check");
});

// ---------------------------------------------------------------- Mail, Calendar, Messages
test('Mail\'s account tags speak in words, not capitals', async ({ page }) => {
  await mailMock.boot(page, 'ok');
  await mailMock.rows(page).first().waitFor();
  for (const t of await mailMock.rows(page).locator('.mail-who').allTextContents()) expect(t, t).not.toMatch(/^(YOU|UNI)\b/);
});

test('Mail that can only read has no grey New or Reply; a phone\'s list has one search field', async ({ page }) => {
  await mailMock.boot(page, 'ok');
  await expect(mailMock.mail(page)).toBeVisible();
  await mailMock.rows(page).first().waitFor();
  await expect(mailMock.mail(page)).not.toContainText('Sending comes later');
  await expect(mailMock.mail(page).getByRole('button', { name: /^New/ })).toHaveCount(0);
  await expect(mailMock.mail(page)).toContainText('reading only');
  if (phone()) await expect(page.getByRole('navigation', { name: 'Mail actions' }).getByRole('button', { name: 'Search' })).toHaveCount(0);
  await mailMock.rows(page).first().click();
  await expect(mailMock.mail(page).getByRole('button', { name: /^Reply/ })).toHaveCount(0);
  await expect(mailMock.mail(page)).not.toContainText('Sending comes later');
  await expect(mailMock.mail(page).getByRole('button', { name: 'Refresh' }).locator('svg')).toBeVisible();
});

test('a many-pane place\'s header runs the width of its panes on a wide screen', async ({ page }) => {
  test.skip(phone(), 'desktop');
  await mailMock.boot(page, 'ok');
  await expect(mailMock.mail(page)).toBeVisible();
  const bar = (await page.locator('.mail-bar').boundingBox())!;
  const panes = (await page.locator('.mail-panes').boundingBox())!;
  // 0.2: a rail place has no Back of its own; the head starts with the place's name, at the panes' left edge
  await expect(page.locator('.mail-bar').getByRole('button', { name: /^←/ })).toHaveCount(0);
  const title = (await page.locator('.mail-bar .mail-title').boundingBox())!;
  expect(title.x - bar.x).toBeLessThanOrEqual(20);
  expect(Math.abs(bar.x - panes.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(bar.x + bar.width - (panes.x + panes.width))).toBeLessThanOrEqual(1);
});

test('Mail\'s and Calendar\'s tags don\'t shout', async ({ page }) => {
  await calMock.boot(page, {});
  await expect(calMock.cal(page)).toBeVisible();
  await calMock.pickView(page, 'Agenda');
  const tags = await calMock.cal(page).locator('.cal-tag').allTextContents();
  expect(tags.length).toBeGreaterThan(0);
  for (const t of tags) expect(t === t.toUpperCase() && t.length > 1, `"${t}" shouts`).toBe(false);
  // free is said, quietly: a free event shouldn't read as busy
  expect(tags).toContain('Free');
  const free = calMock.cal(page).locator('.cal-tag.tag-free').first();
  expect(await free.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
});

test('the rail\'s Uni is the home\'s Uni: one mark', async ({ page }) => {
  await glow(page);
  const mark = (loc: ReturnType<Page['locator']>) => loc.locator('path').first().getAttribute('d');
  expect(await mark(railNav(page).getByRole('button', { name: 'Uni', exact: true }))).toBe(await mark(page.locator('.fd-title .enso')));
});

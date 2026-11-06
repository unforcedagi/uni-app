// T-335 as Aaron: the papercuts found walking the whole app as its owner, one flow each. Each fails on the build before the fix (fbb7e9b7).
// Made-up data only: the fixtures are the tour's.
import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { bootAreas, leaveFrontDoor, type BootOpts } from './areasFixture';
import { installNotePaneFixture } from './notePaneFixture';
import * as mailMock from './mailMock';
import * as calMock from './calMock';
import { railGo, railNav, openRailMore } from './railGo';

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
  await page.locator('.fd-door[data-path="Areas/Kiln Studio"]').click();
  await page.getByRole('textbox', { name: /^Message / }).first().waitFor();
  await expect(page.locator('.message-list article.message').first()).toBeVisible();
}
const TASKS: BootOpts = { briefs: true, tree: true, tasks: true, atlas: true, steer: true, pinned: true, uniMember: true };
/** The tour's way into a room of the tasks world: the front door, a first room, then the tree (beside it, or the Places drawer). */
async function openRoom(page: Page, name: string) {
  await leaveFrontDoor(page);
  const beside = (page.viewportSize()?.width ?? 0) >= 900;
  if (!beside) { await page.locator('.sr-drawer, .th-phone-tree').first().waitFor(); if (await page.locator('.sr-drawer').count() && !await page.locator('.th-drawer').count()) await page.locator('.sr-drawer').click(); }
  const scope = beside ? page.locator('.th-roomnav') : page.locator('.th-phone-tree');
  await scope.locator('.th-row.d1').first().waitFor();
  for (let i = 0; i < 12; i++) { const f = scope.locator('.th-fold[aria-expanded="false"]'); if (!await f.count()) break; await f.first().click(); }
  await scope.locator(`.th-go[aria-label^="${name},"]`).click();
  await expect(page.locator('.sr')).toHaveAttribute('data-node', name);
}

// ---------------------------------------------------------------- the rail
test('the phone bar is four places and More; the rest open from a sheet that closes itself', async ({ page }) => {
  onlyPhone();
  await glow(page);
  const rail = railNav(page);
  for (const name of ['Uni', 'All', 'Journal', 'Mail', 'More']) await expect(rail.getByRole('button', { name, exact: true })).toBeVisible();
  for (const name of ['For you', 'To post', 'Vault', 'Search', 'Settings']) await expect(rail.getByRole('button', { name, exact: true })).toBeHidden();
  // every label fits: nothing is cut or squeezed under 60 px wide
  const widths = await rail.locator('> button').evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent).map((e) => e.getBoundingClientRect().width));
  expect(widths.length).toBe(5);
  for (const w of widths) expect(w).toBeGreaterThanOrEqual(60);
  const more = rail.getByRole('button', { name: 'More', exact: true });
  await more.click();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  for (const name of ['For you', 'To post', 'Vault', 'Search', 'Settings']) await expect(rail.getByRole('button', { name, exact: true })).toBeVisible();
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

test('a wider screen keeps every place on the rail and has no More', async ({ page }) => {
  test.skip(phone(), 'desktop');
  await glow(page);
  const rail = railNav(page);
  await expect(rail.getByRole('button', { name: 'More', exact: true })).toBeHidden();
  for (const name of ['Uni', 'All', 'Journal', 'Mail', 'For you', 'To post', 'Vault', 'Search', 'Settings']) await expect(rail.getByRole('button', { name, exact: true })).toBeVisible();
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
  const body = page.locator('.sr').first();
  await expect(body).not.toContainText('no folder yet');
  if (phone()) {
    await expect(page.locator('.cp.strip .cp-line')).toContainText('Glaze tests are out');
    await expect(page.locator('.cp.strip .cp-line')).not.toContainText('Last written');
    await expect(page.locator('.sr-door')).toBeHidden();
    // the chat gets the room: the header and strip take at most 130 px
    const list = (await page.locator('.message-list').boundingBox())!;
    expect(list.y).toBeLessThanOrEqual(130);
  }
});

test('the composer ring sits in line with the mic and Send, in the room\'s colour', async ({ page }) => {
  onlyPhone();
  await kiln(page);
  const center = async (sel: string) => { const b = (await page.locator(sel).first().boundingBox())!; return b.y + b.height / 2; };
  expect(Math.abs(await center('.compose-uni') - await center('.compose-row .send'))).toBeLessThanOrEqual(2);
  const ring = await page.locator('.compose-uni').evaluate((el) => { const s = getComputedStyle(el), b = getComputedStyle(el, '::before'); return { display: s.display, shadow: b.boxShadow, tint: getComputedStyle(el.closest('.sr')!).getPropertyValue('--room-tint') }; });
  expect(ring.display).toBe('flex');
  expect(ring.tint).toContain('hsl');
});

test('every room wears one colour: the home, All and the room agree', async ({ page }) => {
  await glow(page);
  const door = page.locator('.fd-door[data-path="Areas/Kiln Studio"]');
  const tint = await door.evaluate((el) => (el as HTMLElement).style.getPropertyValue('--room-tint'));
  expect(tint).toContain('hsl');
  await railNav(page).getByRole('button', { name: 'All', exact: true }).click();
  const chip = page.locator('.all-place', { hasText: 'Kiln Studio' }).first();
  await expect(chip).toBeVisible();
  expect(await chip.evaluate((el) => (el as HTMLElement).style.getPropertyValue('--room-tint'))).toBe(tint);
  await railNav(page).getByRole('button', { name: 'Uni', exact: true }).click();
  await page.locator('.fd-door[data-path="Areas/Kiln Studio"]').click();
  await page.getByRole('textbox', { name: /^Message / }).first().waitFor();
  expect(await page.locator('.sr').first().evaluate((el) => (el as HTMLElement).style.getPropertyValue('--room-tint'))).toBe(tint);
});

test('a toast never sits on the composer', async ({ page }) => {
  onlyPhone();
  await kiln(page);
  await page.locator('.message-list article.message').last().getByRole('group', { name: 'Message actions' }).getByRole('button', { name: 'Copy', exact: true }).click();
  const toast = (await page.locator('.toast').boundingBox())!;
  const composer = (await page.locator('.compose-row').first().boundingBox())!;
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
  await openRoom(page, 'ATLAS');
  await page.getByRole('textbox', { name: /^Message / }).first().waitFor();
  if (phone()) await page.locator('.cp.strip .cp-line').click();
  await page.getByRole('region', { name: 'Needs you' }).locator('.cp-need[data-id="T-07"]').click();
  const sheet = page.locator('.task-sheet').first();
  await expect(sheet).toBeVisible();
  await expect(sheet).not.toContainText(/due due/i);
  await sheet.locator('summary', { hasText: 'Details' }).click();
  await expect(sheet).not.toContainText('T-07');
});

test('a waiting approval is from Uni, not from a program\'s name', async ({ page }) => {
  await bootAreas(page, 'seed', { tree: true, tasks: true, briefs: true, strayRoom: true });
  await page.locator('[data-place="front-door"]').waitFor();
  await page.evaluate(([c, n, b]) => (window as any).__arrive(c, n, b), ['ch-garden', 'Uni', PROMPTS.prompts.two_answers_30min] as const);
  await page.locator('.cp-approval').getByRole('button').click();
  await expect(page.locator('.message.approval-waiting')).toContainText('Uni needs your OK');
  await expect(page.locator('.message.approval-waiting')).not.toContainText('Hermes needs');
});

// ---------------------------------------------------------------- Settings
test('Settings: the update first, nothing that can\'t be used, the dangerous one small and last', async ({ page }) => {
  await glow(page, {}, (cmd) => (cmd === 'plugin:app|version' ? '0.1.98' : undefined));
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
  const forget = settings.getByRole('button', { name: /Forget this device/ });
  expect(await y(update)).toBeLessThan(await y(forget));
  await expect(settings.getByRole('region', { name: 'This device' }).getByRole('button', { name: /Forget this device/ })).toBeVisible();
  // Forget reads as a danger, not as the same pill as everything else
  const f = await forget.evaluate((e) => { const s = getComputedStyle(e); return { border: s.borderTopStyle, bg: s.backgroundColor }; });
  expect(f.border).toBe('none');
  expect(f.bg).toBe('rgba(0, 0, 0, 0)');
});

// ---------------------------------------------------------------- the vault
test('one vault: Vault goes straight in; each open folder has two small marks, not two more buttons of words', async ({ page }) => {
  await glow(page);
  await railGo(page, 'Vault');
  const browser = page.locator('.vault-browser');
  await expect(browser).toBeVisible();
  await expect(page.getByRole('region', { name: 'Vaults' })).toBeHidden();
  await expect(browser.getByRole('button', { name: 'Refresh' }).locator('svg')).toBeVisible();
  await expect(browser.getByRole('button', { name: 'New note here' })).toHaveCount(0);
  await expect(browser.getByRole('button', { name: 'New note in Areas' })).toBeVisible();
  await expect(browser.getByRole('button', { name: 'New note', exact: true })).toBeVisible();
  await browser.getByRole('button', { name: 'New note', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New note' });
  await expect(dialog).toContainText('Name');
  await expect(dialog).not.toContainText('Path');
});

// ---------------------------------------------------------------- Search
test('Search: nothing found is one line and a next step; a found note\'s folder is on its own line', async ({ page }) => {
  await kiln(page);
  if (phone()) await railGo(page, 'Search'); else await page.keyboard.press('Control+k');
  const field = page.getByRole('searchbox', { name: 'Search conversations and notes' });
  await field.fill('zzzqqq nothing like this');
  const none = page.locator('.search-nothing');
  await expect(none).toContainText('Nothing here for');
  await expect(none.getByRole('button', { name: 'Ask Uni to look' })).toBeVisible();
  await expect(page.locator('.search-section')).toHaveCount(0);
  await field.fill('glaze');
  const hit = page.locator('.search-hit').first();
  await expect(hit).toBeVisible();
  await expect(page.locator('.search-results')).not.toContainText('keyword');
  await expect(page.locator('.search-nothing')).toHaveCount(0);
  const path = page.locator('.search-path').first();
  await expect(path).toHaveCSS('display', 'block');
  await expect(page.getByText('Narrow the notes')).toHaveCount(0);
});

// ---------------------------------------------------------------- the home
test('the home: a quiet day has its own line, the places sit on one thread, and All explains only what it guessed', async ({ page }) => {
  await glow(page);
  const quiet = await page.locator('.fd-statement span').last().textContent();
  expect(['All quiet.', 'The rooms are resting.', 'The mycelium has it.', 'Go look at a tree.', "Nothing's on fire.", 'Breathe out.', 'The garden keeps itself today.']).toContain(quiet);
  await expect(page.locator('.fd-weave .fd-knot')).toHaveCount(await page.locator('.fd-door').count());
  await expect(page.locator('.fd-weave .fd-knot.fresh').first()).toBeVisible();
  await expect(page.locator('.fd-door[data-path="Areas/Kiln Studio"]')).not.toContainText('#kiln-studio');
  await railNav(page).getByRole('button', { name: 'All', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message for your rooms' }).fill('Tell Choir and North Field the hall is booked for Tuesday');
  await expect(page.locator('.all-chip.chosen').first()).toBeVisible();
  await expect(page.locator('.all-why')).toHaveCount(0);
});

// ---------------------------------------------------------------- Mail, Calendar, Messages
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
  const back = (await page.locator('.mail-bar').getByRole('button', { name: /^←/ }).boundingBox())!;
  expect(back.x - bar.x).toBeLessThanOrEqual(20);
});

test('Mail\'s and Calendar\'s tags don\'t shout', async ({ page }) => {
  await calMock.boot(page, {});
  await expect(calMock.cal(page)).toBeVisible();
  await calMock.pickView(page, 'Agenda');
  const tags = await calMock.cal(page).locator('.cal-tag').allTextContents();
  expect(tags.length).toBeGreaterThan(0);
  for (const t of tags) expect(t === t.toUpperCase() && t.length > 1, `"${t}" shouts`).toBe(false);
  expect(tags).not.toContain('Free');
});

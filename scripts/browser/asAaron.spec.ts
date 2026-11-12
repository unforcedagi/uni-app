// T-335 as Aaron: the papercuts found walking the whole app as its owner, one flow each. Nearly all fail on the build before the fix (8c7241ae); the ones marked guard hold a line that was already right, and were proven by a bug of this pass.
// Made-up data only: the fixtures are the tour's.
import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { bootAreas, type BootOpts } from './areasFixture';
import { homeHead, openApplet, openRoom, openSettings } from './shapeNav';
import { installNotePaneFixture } from './notePaneFixture';
import * as mailMock from './mailMock';
import * as calMock from './calMock';

const USAGE = JSON.parse(readFileSync(new URL('../fixtures/usage-note.json', import.meta.url), 'utf8'));
const PROMPTS = JSON.parse(readFileSync(new URL('../fixtures/approval-prompts.json', import.meta.url), 'utf8'));
const phone = () => test.info().project.name === 'phone';
const onlyPhone = () => test.skip(!phone(), 'a phone-size papercut');

async function glow(page: Page, o: BootOpts = {}, native?: (cmd: string, args: any) => unknown) {
  if (native) await page.addInitScript(`window.__extraInvoke = async (cmd, args) => (${native.toString()})(cmd, args);`);
  await bootAreas(page, 'seed', { world: 'unread', glow: true, uniMember: true, unread: { 'ch-kiln': 1, 'ch-bees': 2 }, ...o });
  await expect(homeHead(page)).toBeVisible();
}
async function kiln(page: Page, o: BootOpts = {}) {
  await glow(page, o);
  await openRoom(page, 'ch-kiln');
  await focus(page).getByRole('textbox', { name: /^Message / }).waitFor();
  await expect(focus(page).locator('.message-list article.message').first()).toBeVisible();
}
/** T-335 the shape: the room open from home. */
const focus = (page: Page) => page.locator('.sh-room');
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

// ---------------------------------------------------------------- the rail
// ---------------------------------------------------------------- a room
test('a room says what it is once: no "Last written", no "no folder yet", and on a phone the head leaves the chat the room', async ({ page }) => {
  await kiln(page);
  const body = focus(page);
  await expect(body).not.toContainText('no folder yet');
  await expect(body).not.toContainText('Last written');
  if (phone()) {
    // the chat gets the room: the head and its strip take at most 130 px
    const list = (await body.locator('.message-list').boundingBox())!;
    expect(list.y).toBeLessThanOrEqual(130);
  }
});

test('a long room name ends in an ellipsis', async ({ page }) => {
  await kiln(page);
  // T-335: the name in the focus head (its button, a flex item of the heading, is the box that cuts)
  const t = await focus(page).locator('h1').evaluate((el) => { el.textContent = 'A very long room name that goes on and on and on and on past any window, however wide, whatever the screen, and on again'; const s = getComputedStyle(el); return { display: s.display, overflow: s.textOverflow, cut: el.scrollWidth > el.clientWidth }; });
  expect(t.display).toBe('block');
  expect(t.overflow).toBe('ellipsis');
  expect(t.cut).toBe(true);
});

test('the composer ring sits in line with the mic and Send', async ({ page }) => {
  onlyPhone();
  await kiln(page);
  const center = async (sel: string) => { const b = (await focus(page).locator(sel).first().boundingBox())!; return b.y + b.height / 2; };
  expect(Math.abs(await center('.compose-uni') - await center('.compose-row .send'))).toBeLessThanOrEqual(2);
  const ring = await focus(page).locator('.compose-uni').evaluate((el) => { const s = getComputedStyle(el), b = getComputedStyle(el, '::before'); return { display: s.display, shadow: b.boxShadow }; });
  expect(ring.display).toBe('flex');
  // (the ring's colour is no longer the room's own tint: the shell sets none; it is the accent now)
  expect(ring.shadow).not.toBe('none');
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
test('a waiting approval is from Uni, not from a program\'s name', async ({ page }) => {
  await bootAreas(page, 'seed', { tree: true, tasks: true, briefs: true, strayRoom: true });
  await expect(homeHead(page)).toBeVisible();
  await page.evaluate(([c, n, b]) => (window as any).__arrive(c, n, b), ['ch-garden', 'Uni', PROMPTS.prompts.two_answers_30min] as const);
  await openRoom(page, 'ch-garden');
  await expect(page.locator('.message.approval-waiting')).toContainText('Uni needs your OK');
  await expect(page.locator('.message.approval-waiting')).not.toContainText('Hermes needs');
});

// ---------------------------------------------------------------- Settings
test('Settings: the update first, nothing that can\'t be used, the dangerous one small and last', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-26T18:00:00Z')); // the usage fixture's own Monday, so its reading is fresh
  await page.addInitScript((usage) => { (window as any).__extraInvoke = async (cmd: string, a: any) => cmd === 'plugin:app|version' ? '0.1.98' : cmd === 'vault_note' && a.noteRef === 'System/Claude accounts' ? { hub: 'https://hub.example.ts.net', vault: 'uni', note: usage } : undefined; }, USAGE);
  await glow(page);
  await openSettings(page);
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
  await openSettings(page);
  const line = page.locator('.settings .connection');
  await expect(line).toHaveAttribute('data-fine', 'true');
  await page.evaluate(() => { const w = window as any; for (const h of w.__listeners?.['uni://live'] ?? []) w.__cbs[h]?.({ event: 'uni://live', id: 1, payload: { kind: 'status', status: 'Reconnecting in 5s' } }); });
  await expect(line).toContainText('Reconnecting in 5s');
  await expect(line).not.toHaveAttribute('data-fine', 'true');
  expect((await line.boundingBox())!.height).toBeGreaterThan(8);
});

// ---------------------------------------------------------------- the vault
/** The Vault applet from the drawer: with one vault it goes straight in, and the frame's head is that vault's name. */
async function openVault(page: Page) {
  await page.getByRole('navigation', { name: 'Places' }).getByRole('button', { name: /^Applets/ }).click();
  await page.getByRole('dialog', { name: 'Applets' }).getByRole('button', { name: /^Vault( \(\d+\))?$/ }).click();
}
test('one vault: Vault goes straight in; an open folder has small marks, not buttons of words', async ({ page }) => {
  await glow(page);
  await openVault(page);
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
  await openVault(page);
  await expect(page.locator('.vault-browser')).toBeVisible();
  await expect(page.locator('.sh-ap-top h1')).toHaveText('garden');
});

// ---------------------------------------------------------------- Search
test('Search: nothing found is one line and a next step; a found note\'s folder is on its own line', async ({ page }) => {
  await kiln(page);
  await page.keyboard.press('Control+k');
  const field = page.getByRole('searchbox', { name: /^Search / });
  await field.fill('zzzqqq nothing like this');
  const none = page.locator('.search-nothing');
  await expect(none).toContainText(/^Nothing in .+ for “zzzqqq nothing like this”\./);
  // the fallback asks the Uni of the room you were in (its title says which)
  await expect(none.getByRole('button', { name: 'Ask Uni', exact: true })).toBeVisible();
  await expect(none.getByRole('button', { name: 'Ask Uni', exact: true })).toHaveAttribute('title', /^Ask Uni in #\S+$/);
  await expect(page.locator('.sh-find-head')).toHaveCount(0);
  // in a room the search is the room's: the note is counted under "Also in", and a tap on it shows it, grouped by its place
  await field.fill('glaze');
  const also = page.locator('.sh-find-also .sh-find-also-place');
  await expect(also.first()).toBeVisible();
  await also.first().click();
  const hit = page.locator('.search-hit').first();
  await expect(hit).toBeVisible();
  await expect(page.locator('.sh-find-head').first()).toBeVisible();
  await expect(page.locator('.search-results')).not.toContainText('keyword');
  await expect(page.locator('.search-nothing')).toHaveCount(0);
  const path = page.locator('.search-path').first();
  await expect(path).toHaveCSS('display', 'block');
  await expect(page.getByText('Narrow the notes')).toHaveCount(0);
  // typing on from a query that found nothing never shows "nothing" for words not yet searched
  await field.fill('zzzqqq nothing like this');
  await expect(none).toContainText('Nothing in ');
  await field.pressSequentially(' again');
  await expect(page.locator('.search-nothing')).toHaveCount(0);
});

// ---------------------------------------------------------------- the home
// ---------------------------------------------------------------- Mail, Calendar, Messages
test('Mail\'s account tags speak in words, not capitals', async ({ page }) => {
  // T-335 v2: rows carry no account tag (the tab says whose mail it is); the tag stays where the account matters
  await mailMock.boot(page, 'ok', { writes: true, held: true });
  await mailMock.rows(page).first().waitFor();
  await expect(mailMock.rows(page).locator('.mail-who')).toHaveCount(0);
  await mailMock.tab(page, 'Waiting').click();
  await page.locator('.mail-held-row').first().waitFor();
  const tags = await page.locator('.mail-held-row .mail-who').allTextContents();
  expect(tags.length).toBeGreaterThan(0);
  for (const t of tags) expect(t, t).not.toMatch(/^(YOU|UNI)\b/);
});

test('Mail that can only read has no grey New or Reply; a phone\'s list has one search field', async ({ page }) => {
  await mailMock.boot(page, 'ok');
  await expect(mailMock.mail(page)).toBeVisible();
  await mailMock.rows(page).first().waitFor();
  await expect(mailMock.mail(page)).not.toContainText('Sending comes later');
  await expect(mailMock.mail(page).getByRole('button', { name: /^New/ })).toHaveCount(0);
  await expect(mailMock.mail(page)).toContainText('reading only');
  await expect(mailMock.mail(page).getByRole('searchbox')).toHaveCount(1);
  await mailMock.rows(page).first().click();
  await expect(mailMock.mail(page).getByRole('button', { name: /^Reply/ })).toHaveCount(0);
  await expect(mailMock.mail(page)).not.toContainText('Sending comes later');
  // a phone's thread fills the screen (the tabs and Refresh give way to it): Refresh is back on the list
  await mailMock.backToThreads(page);
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


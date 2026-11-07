// The screen tour (the "before" half of a before/after restyle): every screen, sheet and panel of the app on made-up data, one test each,
// each screenshotted to $TOUR_SHOTS/<project>/<NN-name>.png (default test-results/tour) with a computed-style audit beside it (<NN-name>.json).
// Fixtures are the existing specs' (areasFixture, projectsFixture, mailMock, calMock, messagesBridge ...); nothing real.
// Run: TOUR_TEST_PORT=17491 TOUR_SHOTS=/some/dir npx playwright test --config playwright.tour.config.ts
import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { bootAreas, focusSheet, openAreaPage, openDetails, openPlaces, type BootOpts } from './areasFixture';
import { bootProjects, type Boot } from './projectsFixture';
import { audit, lookViolations } from './tourAudit';
import { installNotePaneFixture } from './notePaneFixture';
import * as mailMock from './mailMock';
import * as calMock from './calMock';
import { railGo } from './railGo';

const USAGE_NOTE = JSON.parse(readFileSync(new URL('../fixtures/usage-note.json', import.meta.url), 'utf8'));
const SHOTS = process.env.TOUR_SHOTS ?? 'test-results/tour';
const project = () => test.info().project.name;
const touch = () => !!test.info().project.use.hasTouch;
const wide = (page: Page) => (page.viewportSize()?.width ?? 0) >= 900;

/** Settles the page (fonts, 300 ms), screenshots the viewport and writes the style audit beside it. */
async function snap(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/${project()}/${name}.png` });
  await audit(page, `${SHOTS}/${project()}/${name}.json`);
  expect(await lookViolations(page, { ink: project() === 'daylight', night: project() === 'night' }), `the look's rules on ${name}`).toEqual([]);
}

/** Boots a page the way every spec does, plus the device's motion setting (Daylight is Calm, as the device is). */
type Tour = { version?: boolean; usage?: boolean; update?: boolean; pair?: 'waiting' | 'code'; unpaired?: boolean; cards?: { sealed?: unknown; secret?: unknown; trusted?: boolean }; media?: boolean; posts?: unknown[]; approvals?: boolean; forYou?: boolean };
async function init(page: Page, extra: Record<string, string> = {}, tour: Tour = {}) {
  await page.addInitScript(({ kv, tour, usage }) => {
    const w = window as any;
    // one hook for the few native answers the fixtures don't give: the usage note, an update, the pairing dialog, no identity
    w.__extraInvoke = async (cmd: string, args: any) => {
      if (cmd === 'plugin:app|version' && (tour.version || tour.update)) return '0.1.98'; // (the area apps' self-test gate keys on the real version: only Settings gets one)
      if (tour.update) {
        if (cmd === 'plugin:updater|check') return { rid: 7, currentVersion: '0.1.98', version: '0.1.99', date: null, body: null, rawJson: {} };
        if (cmd === 'plugin:updater|download_and_install') return null;
        if (cmd === 'android_update_manifest') return { version: '0.1.99', url: 'https://example.com/releases/uni-v0.1.99/uni.apk' }; // the Android build (the Daylight's user agent) asks this instead
      }
      if (tour.usage && cmd === 'vault_note' && args.noteRef === 'System/Claude accounts') return { hub: 'https://hub.example.ts.net', vault: 'uni', note: usage };
      if (tour.unpaired && cmd === 'identity_status') return { paired: false, pubkey: null };
      if (tour.media && cmd === 'get_messages' && args.channel === 'ch-kiln') {
        const now = Math.floor(Date.now() / 1000), O = 'https://relay.example';
        const media = (sha: string, ext: string, mime: string, filename: string, size: number) => ({ url: `${O}/media/${sha}.${ext}`, mime, sha256: sha, size, dim: ext === 'jpg' ? '1200x800' : null, blurhash: null, alt: null, filename });
        const msg = (ref: string, ts: number, body: string, m: unknown) => ({ ref, channel: 'ch-kiln', author: 'c'.repeat(64), author_name: 'Uni', ts, body, mentions_me: false, root: null, parent: null, mentions: [], reply_count: 0, last_reply_ts: null, edited: false, reactions: [], media: [m] });
        return [msg('m1', now - 180, 'The firing log', media('6'.repeat(64), 'pdf', 'application/pdf', 'Firing log.pdf', 70563)),
          msg('m2', now - 120, 'Kiln time-lapse', media('f'.repeat(64), 'mp4', 'video/mp4', 'kiln.mp4', 36665525)),
          msg('m3', now - 60, 'The test tiles', media('7'.repeat(64), 'jpg', 'image/jpeg', 'tiles.jpg', 51421))];
      }
      if (tour.media && cmd === 'relay_origin') return 'https://relay.example';
      if (tour.media && cmd === 'media_bytes') {
        // a made-up picture (a glaze-tile gradient), so the thumbnail and the viewer show something
        const c = new OffscreenCanvas(480, 320), g = c.getContext('2d')!;
        const grad = g.createLinearGradient(0, 0, 480, 320); grad.addColorStop(0, '#7fa6a0'); grad.addColorStop(0.5, '#e8d9b5'); grad.addColorStop(1, '#b0623f');
        g.fillStyle = grad; g.fillRect(0, 0, 480, 320);
        g.fillStyle = 'rgba(255,255,255,0.55)'; g.beginPath(); g.arc(160, 170, 70, 0, Math.PI * 2); g.fill();
        return await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer();
      }
      if (tour.media && cmd === 'media_save') return `Downloads/${args.name}`;
      if (tour.posts) {
        if (cmd === 'vault_query' && args.tag === 'post') return tour.posts;
        if (cmd === 'unlock_grace') return null;
      }
      if (tour.approvals && cmd === 'sealed_status') return { uni: 'c'.repeat(64), seal_pub: 'd'.repeat(64), rooms: [{ id: 'ch-kiln', name: 'Kiln Studio', members: 2 }], enrolled: null };
      if (tour.forYou && cmd === 'vault_note' && args.noteRef === '01M3ZQF7EM4ADC7HEY36D3DC3B') return { hub: 'https://example.invalid', vault: 'uni', note: { id: args.noteRef, path: 'For you', createdAt: '2026-11-01T08:00:00Z', updatedAt: '2026-11-05T07:30:00Z', tags: [], metadata: {},
        content: '# For you\n\nThursday, November 5.\n\n## Worth a look\n\n- The bisque load is cooled; unload before the glaze tests.\n- Choir wants the hall booked for Tuesday: one yes or no from you.\n- Honey jars: the neighbours have thirty.\n\n## Waiting on others\n\n- Kiln Studio: shelf repair quote.\n- Long Table: menu for Friday.\n' } };
      // sealed approval / secret-request cards: Rust's checks are faked (they are proven in uni-core); any message ref verifies
      if (tour.cards) {
        if (cmd === 'sealed_card' && tour.cards.sealed) return tour.cards.sealed;
        if (cmd === 'sealed_waiting') return [];
        if (cmd === 'unlock_grace') return null;
        if (cmd === 'secret_requesters') return tour.cards.trusted ? ['c'.repeat(64)] : [];
        if (cmd === 'secret_request' && tour.cards.secret) return { author: 'c'.repeat(64), request: tour.cards.secret };
      }
      if (tour.pair) {
        w.__pairAvailable = true;
        if (cmd === 'pair_source_available') return true;
        if (cmd === 'pair_source_start') return { uri: 'nostrpair://example-made-up-link', qr_svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><path d="M0 0h3v3H0zM5 0h3v3H5zM0 5h3v3H0zM4 4h1v1H4zM6 5h2v1H6zM5 7h3v1H5z"/></svg>', expires_in_ms: 120000 };
        if (cmd === 'pair_source_wait_offer') return tour.pair === 'code' ? { sas: '4821 7305' } : new Promise(() => {});
      }
      return undefined;
    };
    if (sessionStorage.getItem('tour.booted')) return;
    sessionStorage.setItem('tour.booted', '1');
    if (navigator.userAgent.includes('SM-T') || (window.innerWidth === 828 && window.innerHeight === 1104)) localStorage.setItem('uni.motion', 'calm');
    for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v);
  }, { kv: extra, tour, usage: USAGE_NOTE });
}

/** The made-up glow world: five areas with talk, a project room, unread counts. */
async function glow(page: Page, o: BootOpts = {}, ls: Record<string, string> = {}, tour: Tour = {}) {
  await init(page, ls, tour);
  await bootAreas(page, 'seed', { world: 'unread', glow: true, uniMember: true, unread: { 'ch-kiln': 1, 'ch-bees': 2 }, ...o });
  await page.locator('[data-place="front-door"]').waitFor();
}
/** The made-up tasks world: Techne/Atlas nodes with tasks, decisions, briefs; the clock pinned. */
const TASKS: BootOpts = { briefs: true, tree: true, tasks: true, atlas: true, steer: true, pinned: true, uniMember: true };
async function tasksWorld(page: Page, o: BootOpts = {}) {
  await init(page);
  await bootAreas(page, 'seed', { ...TASKS, ...o });
}
async function projects(page: Page, o: Boot = {}) {
  await init(page);
  await bootProjects(page, o);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Uni', level: 1 })).toBeVisible();
}
const rail = (page: Page) => page.getByRole('navigation', { name: 'Main navigation' });
const doorOf = (page: Page, name: string) => page.getByRole('navigation', { name: 'Rooms' }).getByRole('button', { name: new RegExp(`^${name}\\b`) });
const calls = (page: Page, cmd: string) => page.evaluate((c) => (window as any).__calls.filter((x: any) => x.cmd === c).map((x: any) => x.args), cmd);

// ---------------------------------------------------------------------------------------------------------- front door and rooms
test('01-home-needs-collapsed', async ({ page }) => {
  await projects(page);
  await expect(page.locator('.fd-pull')).toHaveText(/One thing needs you\./);
  await snap(page, '01-home-needs-collapsed');
});

test('02-home-needs-open', async ({ page }) => {
  await projects(page);
  await openPlaces(page);
  await expect(page.getByRole('region', { name: 'Needs you' }).getByRole('button', { name: /Choose the photo/ })).toBeVisible();
  await snap(page, '02-home-needs-open');
});

test('03-home-places-glow', async ({ page }) => {
  await glow(page);
  await openPlaces(page);
  await expect(page.locator('.fd-door')).toHaveCount(7);
  await snap(page, '03-home-places-glow');
});

test('08-more-sheet', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) >= 600, 'the phone bar (600px and up has every place on the rail)');
  await glow(page);
  await rail(page).getByRole('button', { name: 'More', exact: true }).click();
  await expect(rail(page).getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
  await snap(page, '08-more-sheet');
});

test('04-all-view', async ({ page }) => {
  await glow(page);
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Uni', exact: true }).click();
  await expect(page.locator('article.all-msg').first()).toBeVisible();
  await snap(page, '04-all-view');
});

test('05-all-route-chips', async ({ page }) => {
  await glow(page);
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Uni', exact: true }).click();
  const field = page.getByRole('textbox', { name: 'Message for your rooms' });
  await field.fill('Tell Choir and North Field the hall is booked for Tuesday');
  await expect(page.locator('.all-chip.chosen').first()).toBeVisible();
  await snap(page, '05-all-route-chips');
});

test('06-usage-card', async ({ page }) => {
  await projects(page);
  // 0.2: the Claude accounts card lives in Settings (the home's line went with the old home)
  await railGo(page, 'Settings');
  await expect(page.locator('.settings').getByText('Claude accounts').first()).toBeVisible();
  await snap(page, '06-usage-card');
});

async function kiln(page: Page, o: BootOpts = {}) {
  await glow(page, o);
  await openPlaces(page);
  await page.locator('.fd-door[data-path="Areas/Kiln Studio"]').click();
  await roomBox(page).waitFor();
  await expect(focusSheet(page).locator('.message-list article.message').first()).toBeVisible();
}
/** T-335: a room is shown in focus over All (All, behind it, has a composer and messages of its own). */
const roomBox = (page: Page) => focusSheet(page).getByRole('textbox', { name: /^Message / });

test('10-room', async ({ page }) => {
  await kiln(page);
  await snap(page, '10-room');
});

test('11-room-composer-typing', async ({ page }) => {
  await kiln(page);
  await roomBox(page).fill('Can we move the glaze test to Thursday? Also check the shelf by the window.');
  await snap(page, '11-room-composer-typing');
});

test('14-room-actions-desktop-hover', async ({ page }) => {
  test.skip(touch(), 'hover row is mouse-only; the phone has the long-press sheet (15)');
  await kiln(page);
  const older = focusSheet(page).locator('.message-list article.message[data-ref="k1"]');
  await older.hover();
  await expect(older.getByRole('group', { name: 'Message actions' })).toHaveCSS('opacity', '1');
  await snap(page, '14-room-actions-desktop-hover');
});

test('15-room-actions-phone-sheet', async ({ page }) => {
  test.skip(!touch(), 'the long-press sheet is touch-only');
  await kiln(page);
  const older = focusSheet(page).locator('.message-list article.message[data-ref="k1"]');
  await older.scrollIntoViewIfNeeded();
  const b = (await older.locator('p').first().boundingBox())!;
  await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, pointerType: 'touch', isPrimary: true })), { x: b.x + 20, y: b.y + 8 });
  const sheet = page.getByRole('dialog', { name: 'Message actions' });
  await expect(sheet).toBeVisible();
  await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)!.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y, pointerType: 'touch', isPrimary: true })), { x: b.x + 20, y: b.y + 8 });
  await snap(page, '15-room-actions-phone-sheet');
});

test('16-room-latest-actions-row', async ({ page }) => {
  await kiln(page);
  await expect(focusSheet(page).locator('article.message[data-ref="k3"]').getByRole('group', { name: 'Message actions' })).toBeVisible();
  await page.mouse.move(1, 1);
  await snap(page, '16-room-latest-actions-row');
});

test('20-find-recent', async ({ page }) => {
  await kiln(page);
  if (wide(page)) await page.keyboard.press('Control+k'); else await railGo(page, 'Search');
  await expect(page.getByRole('searchbox', { name: 'Search conversations and notes' })).toBeFocused();
  await expect(page.locator('.search-recent button').first()).toBeVisible();
  await snap(page, '20-find-recent');
});

test('21-find-results', async ({ page }) => {
  await kiln(page);
  if (wide(page)) await page.keyboard.press('Control+k'); else await railGo(page, 'Search');
  await page.getByRole('searchbox', { name: 'Search conversations and notes' }).fill('glaze');
  await expect(page.locator('.search-hit').first()).toBeVisible();
  await snap(page, '21-find-results');
});

// ---------------------------------------------------------------------------------------------------------- Settings, updates, pairing
async function settings(page: Page, tour: Tour = { usage: true }) {
  await page.clock.setFixedTime(new Date('2026-10-26T18:00:00Z')); // the usage fixture's own Monday, so its reading is fresh
  await glow(page, {}, {}, { version: true, approvals: true, ...tour });
  await railGo(page, 'Settings');
  await expect(page.locator('.settings')).toBeVisible();
}

test('30-settings-top', async ({ page }) => {
  await settings(page);
  await expect(page.locator('.usage-card, section[aria-label="Claude accounts"]').first()).toBeVisible();
  await snap(page, '30-settings-top');
});

test('31-settings-update-motion', async ({ page }) => {
  await settings(page);
  await page.locator('.update-settings').scrollIntoViewIfNeeded();
  await page.locator('.update-settings').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await snap(page, '31-settings-update-motion');
});

test('32-settings-developer-open', async ({ page }) => {
  await settings(page);
  await page.locator('.settings-dev > summary').click();
  await page.locator('.settings-dev').evaluate((el) => el.scrollIntoView({ block: 'end' }));
  await expect(page.getByRole('button', { name: 'Run sandbox self-test' })).toBeVisible();
  await snap(page, '32-settings-developer-open');
});

test('33-settings-update-ready', async ({ page }) => {
  await settings(page, { usage: true, update: true });
  await page.locator('.update-settings').evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await expect(page.locator('.update-settings')).toContainText(/Restart|Download APK/);
  await snap(page, '33-settings-update-ready');
});

test('34-pair-another-device-waiting', async ({ page }) => {
  await settings(page, { pair: 'waiting' });
  await page.getByRole('button', { name: 'Pair a device' }).click();
  await expect(page.locator('dialog.pair-source')).toBeVisible();
  await expect(page.locator('dialog.pair-source img.pair-source-qr')).toBeVisible();
  await snap(page, '34-pair-another-device-waiting');
});

test('35-pair-another-device-code', async ({ page }) => {
  await settings(page, { pair: 'code' });
  await page.getByRole('button', { name: 'Pair a device' }).click();
  await expect(page.locator('dialog.pair-source')).toContainText('Does the other device show this code');
  await snap(page, '35-pair-another-device-code');
});

test('36-pairing-screen-no-identity', async ({ page }) => {
  await init(page, {}, { unpaired: true });
  await bootAreas(page, 'seed', { world: 'unread', glow: true, noWait: true });
  await expect(page.locator('main.pairing')).toBeVisible();
  await snap(page, '36-pairing-screen-no-identity');
});

test('37-update-banner', async ({ page }) => {
  await glow(page, {}, {}, { update: true });
  await expect(page.locator('.update-notice')).toBeVisible();
  await snap(page, '37-update-banner');
});

// ---------------------------------------------------------------------------------------------------------- Vault, notes, journal
test('40-vault-panel', async ({ page }) => {
  await glow(page);
  await railGo(page, 'Vault');
  await expect(page.locator('.vault-browser')).toBeVisible(); // one vault: straight in
  await snap(page, '40-vault-panel');
});

async function vaultBrowser(page: Page) {
  await glow(page);
  await railGo(page, 'Vault');
  await expect(page.locator('.vault-browser, [data-place="vault"], .vault-view').first()).toBeVisible();
}

async function unfold(page: Page) {
  for (const n of ['Areas', 'Projects']) { const t = page.getByRole('button', { name: new RegExp(`^.?\\s*${n}$`) }).first(); if (await t.count()) await t.click().catch(() => {}); }
}

test('41-vault-browser', async ({ page }) => {
  await vaultBrowser(page);
  await unfold(page);
  await snap(page, '41-vault-browser');
});

test('42-new-note-modal', async ({ page }) => {
  await vaultBrowser(page);
  await page.getByRole('button', { name: /^New note/ }).first().click();
  await expect(page.getByRole('dialog', { name: 'New note' })).toBeVisible();
  await snap(page, '42-new-note-modal');
});

test('43-note-editor-and-created-toast', async ({ page }) => {
  await vaultBrowser(page);
  await page.getByRole('button', { name: /^New note/ }).first().click();
  await page.getByRole('dialog', { name: 'New note' }).getByRole('textbox').fill('Projects/Glaze Tests/Firing notes');
  await page.getByRole('button', { name: 'Create note' }).click();
  await expect(page.locator('.toast')).toContainText('Created');
  await expect(page.locator('textarea').first()).toBeVisible();
  await page.locator('textarea').first().fill('Cone 04 bisque on Monday.\n\n- Test tiles on Wednesday\n- Shelf by the window is warm');
  await snap(page, '43-note-editor-and-created-toast');
});

test('45-toast-copied', async ({ page }) => {
  await kiln(page);
  // 0.2: on a touch screen Copy is in the long-press sheet (and says so there); the toast shown is Settings' copied key
  if (touch()) { await railGo(page, 'Settings'); await page.getByRole('button', { name: 'Copy your public key' }).click(); }
  else await focusSheet(page).locator('article.message[data-ref="k3"]').getByRole('group', { name: 'Message actions' }).getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(page.locator('.toast')).toBeVisible();
  await snap(page, '45-toast-copied');
});

// the note pane's own world (an orchard room with a plan note linked in chat)
async function orchard(page: Page) {
  await init(page);
  await page.addInitScript(installNotePaneFixture);
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'Message Orchard' })).toBeVisible();
  const chip = page.locator('.message-list .note-chip', { hasText: 'Spring planting plan' }).first();
  await chip.scrollIntoViewIfNeeded();
  return chip;
}
const tap = (page: Page, l: ReturnType<Page['locator']>) => (touch() ? l.tap() : l.click());

test('46-orchard-room-with-note-link', async ({ page }) => {
  await orchard(page);
  await page.waitForTimeout(1700); // a room holds its newest message for 1.5 s after it opens
  await snap(page, '46-orchard-room-with-note-link');
});

test('47-note-beside-chat', async ({ page }) => {
  const chip = await orchard(page);
  await page.waitForTimeout(1700);
  await tap(page, chip);
  await expect(page.locator('.note-pane .note-body')).toContainText('Two dwarf apple trees');
  await snap(page, '47-note-beside-chat');
});

test('48-note-pane-quote-selection', async ({ page }) => {
  const chip = await orchard(page);
  await page.waitForTimeout(1700);
  await tap(page, chip);
  await expect(page.locator('.note-pane .note-body')).toContainText('Two dwarf apple trees');
  await page.evaluate(() => {
    const li = [...document.querySelectorAll('.note-pane .note-body li')].find((x) => x.textContent!.includes('Two dwarf apple trees'))!;
    const r = document.createRange(); r.selectNodeContents(li); const s = getSelection()!; s.removeAllRanges(); s.addRange(r);
  });
  await expect(page.locator('.note-pane').getByRole('button', { name: 'Quote in reply' })).toBeEnabled();
  await snap(page, '48-note-pane-quote-selection');
});

test('49-note-pane-editing', async ({ page }) => {
  const chip = await orchard(page);
  await page.waitForTimeout(1700);
  await tap(page, chip);
  const pane = page.locator('.note-pane');
  await tap(page, pane.getByRole('button', { name: 'Edit' }));
  await pane.getByRole('textbox', { name: 'Note content' }).fill('# Spring planting plan\n\nA changed line, still a draft.');
  await snap(page, '49-note-pane-editing');
});

test('50-confirm-dialog-unsaved', async ({ page }) => {
  const chip = await orchard(page);
  await page.waitForTimeout(1700);
  await tap(page, chip);
  const pane = page.locator('.note-pane');
  await tap(page, pane.getByRole('button', { name: 'Edit' }));
  await pane.getByRole('textbox', { name: 'Note content' }).fill('# Spring planting plan\n\nA changed line.');
  await tap(page, pane.getByRole('button', { name: 'Close note' }));
  await expect(page.getByRole('alertdialog', { name: 'Unsaved changes' })).toBeVisible();
  await snap(page, '50-confirm-dialog-unsaved');
});

test('51-note-page-over-room', async ({ page }) => {
  const chip = await orchard(page);
  await page.waitForTimeout(1700);
  await tap(page, chip);
  await tap(page, page.locator('.note-pane').getByRole('button', { name: 'Open as page' }));
  await expect(page.locator('.note-sheet .note-title')).toHaveText('Spring planting plan');
  await snap(page, '51-note-page-over-room');
});

// ---------------------------------------------------------------------------------------------------------- the tasks world: work view, tasks, drawer
/** A room of the tasks world, opened as a person does (T-335): ATLAS is inside Atlas, so the Atlas door, its details, and "Inside Atlas". */
async function openRoom(page: Page, name: string) {
  await page.locator('[data-place="front-door"]').waitFor();
  await openPlaces(page);
  await page.locator('.fd-door[data-path="Areas/Atlas"]').click();
  await openDetails(page);
  await focusSheet(page).getByRole('region', { name: 'Inside Atlas' }).locator('.fx-place').filter({ has: page.locator('span', { hasText: new RegExp(`^${name}$`) }) }).click();
  await expect(focusSheet(page).locator('.all-focus-title')).toHaveText(name);
  await expect(focusSheet(page).locator('.sr-chat .message').first()).toBeVisible();
}
const atlas = async (page: Page, o: BootOpts = {}) => { await tasksWorld(page, o); await openRoom(page, 'ATLAS'); };
/** What needs you in the room: its details, in the focus. */
const needsYou = (page: Page) => focusSheet(page).locator('.all-focus-details').getByRole('region', { name: 'Needs you' });
async function openWorkView(page: Page) {
  await openDetails(page);
  await focusSheet(page).getByRole('button', { name: /^All of .*'s work/ }).first().click();
  await expect(focusSheet(page).getByRole('region', { name: /'s work$/ })).toBeVisible();
}

test('61-room-with-needs-you-line', async ({ page }) => {
  await atlas(page);
  await snap(page, '61-room-with-needs-you-line');
});

test('62-room-needs-you-open', async ({ page }) => {
  await atlas(page);
  await openDetails(page);
  await expect(needsYou(page).locator('.cp-need').first()).toBeVisible();
  await snap(page, '62-room-needs-you-open');
});

test('63-work-view-area-page', async ({ page }) => {
  await atlas(page);
  await openWorkView(page);
  await snap(page, '63-work-view-area-page');
});

test('64-task-sheet', async ({ page }) => {
  await atlas(page);
  await openDetails(page);
  await needsYou(page).locator('.cp-need[data-id="T-07"]').click();
  await expect(page.getByRole('dialog').filter({ has: page.locator('.task-kind') }).first()).toBeVisible();
  await snap(page, '64-task-sheet');
});

test('65-decision-sheet', async ({ page }) => {
  await atlas(page);
  await openDetails(page);
  await needsYou(page).locator('.cp-need').filter({ hasText: 'Decide the ATLAS hosting' }).click();
  await expect(page.getByRole('group', { name: /^Decide:/ })).toBeVisible();
  await snap(page, '65-decision-sheet');
});

test('66-task-sheet-details-open', async ({ page }) => {
  await atlas(page);
  await openDetails(page);
  await needsYou(page).locator('.cp-need[data-id="T-07"]').click();
  const d = page.getByRole('dialog').filter({ has: page.locator('.task-kind') }).first();
  await d.locator('details.task-details > summary').click();
  await snap(page, '66-task-sheet-details-open');
});

// ---------------------------------------------------------------------------------------------------------- projects and sessions
const strip = (page: Page) => focusSheet(page).locator('[data-place="project-strip"]');
async function workshop(page: Page, o: Boot = {}) {
  await projects(page, o);
  await openPlaces(page);
  await doorOf(page, 'Workshop').click();
  await expect(focusSheet(page).locator('.all-focus-title')).toHaveText('Workshop');
  // T-335: the area's projects are in the room's details
  await openDetails(page);
}
async function openProject(page: Page, name: RegExp) {
  await workshop(page);
  await strip(page).getByRole('button', { name }).first().click();
  const sheet = page.getByRole('dialog', { name });
  await expect(sheet).toBeVisible();
  return sheet;
}

test('70-room-with-projects-strip', async ({ page }) => {
  await workshop(page);
  await expect(strip(page).locator('.ps-tab').first()).toBeVisible();
  await snap(page, '70-room-with-projects-strip');
});

test('71-sessions-panel-project-sheet', async ({ page }) => {
  await openProject(page, /Riverbend co-op site/);
  await snap(page, '71-sessions-panel-project-sheet');
});

test('72-sessions-panel-actions-menu', async ({ page }) => {
  const s = await openProject(page, /Riverbend co-op site/);
  await s.getByRole('button', { name: 'Actions' }).click();
  await expect(s.getByRole('list', { name: 'Ask the room' })).toBeVisible();
  await snap(page, '72-sessions-panel-actions-menu');
});

test('73-sessions-stop-confirm', async ({ page }) => {
  const s = await openProject(page, /Riverbend co-op site/);
  await s.getByRole('button', { name: 'Actions' }).click();
  await s.getByRole('list', { name: 'Ask the room' }).getByRole('button', { name: /^Stop “Make the events page/ }).click();
  await expect(s.getByRole('group', { name: /Stop: what will be posted/ })).toBeVisible();
  await snap(page, '73-sessions-stop-confirm');
});

const view = (page: Page) => page.locator('[data-place="session-view"]');
async function session(page: Page, ask: string, boot: Boot = {}) {
  await workshop(page, boot);
  await strip(page).getByRole('button', { name: /Riverbend co-op site/ }).first().click();
  const sheet = page.getByRole('dialog', { name: /Riverbend co-op site/ });
  await sheet.getByRole('button', { name: new RegExp(`^${ask.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }).first().click();
  await expect(view(page)).toBeVisible();
}

test('74-session-view-live', async ({ page }) => {
  await session(page, 'Make the events page read like a noticeboard');
  await snap(page, '74-session-view-live');
});

test('75-session-view-finished', async ({ page }) => {
  await session(page, "Rebuild the about page from the coordinator's letter");
  await snap(page, '75-session-view-finished');
});

// ---------------------------------------------------------------------------------------------------------- Mail, Calendar, Messages
// Messages' door faked with made-up people (copied from messagesTabs.spec.ts: a spec file can't be imported without running its tests)
const msgTablist = (page: Page) => page.getByRole('tablist', { name: 'Networks' });
async function messagesBoot(page: Page, before?: () => void) {
  await page.addInitScript(() => {
    const w = window as any;
    localStorage.setItem('uni.tabs.v1', JSON.stringify({ v: 1, tabs: [{ id: 'messages', kind: 'messages', title: 'Messages' }], active: 'messages', recent: ['messages'] }));
    localStorage.setItem('uni.messages.seen.v1', '1');
    const now = Date.now(), min = 60_000;
    const room = (id: string, name: string, network: string, ago: number, preview: string | null, over: object = {}) =>
      ({ id: `!${id}:example.org`, name, preview, preview_own: false, ts: now - ago * min, unread: 0, encrypted: true, invited: false, inviter: null, direct: true, network, ...over });
    w.__rooms = [
      room('book', 'Book club', 'signal', 120, 'Chapter four for Thursday', { direct: false }),
      room('jun', 'Jun Park', 'telegram', 180, 'Photo'),
      room('robin', 'Robin Vale', 'signal', 5, 'Running ten minutes late', { unread: 1 }),
      room('bakery', 'Corner Bakery', 'gmessages', 30, 'Your order is ready', { encrypted: false }),
      room('allot', 'Allotment group', 'whatsapp', 1440, 'The tomatoes are in', { direct: false }),
      room('sam', 'Sam Example', 'matrix', 10, null, { invited: true, inviter: 'Sam Example' }),
      room('mara', 'Mara Quill', 'whatsapp', 1, 'Can you bring the folding chairs?', { unread: 2 }),
    ];
    const card = (network: string, name: string, state: string, rev = 1) => ({ network, name, state, accounts: [], step: null, note: null, rev });
    w.__links = [card('signal', 'Signal', 'linked'), card('telegram', 'Telegram', 'needs_attention'), card('whatsapp', 'WhatsApp', 'linked'),
      card('gmessages', 'Google Messages', 'linked'), card('messenger', 'Messenger', 'not_linked'), card('instagram', 'Instagram', 'unavailable')];
    const callbacks = new Map<number, (e: unknown) => void>();
    const listeners = new Map<number, { event: string; handler: number }>();
    let nextId = 1;
    w.__push = (payload: unknown) => { for (const [id, l] of listeners) if (l.event === 'messages://update') callbacks.get(l.handler)?.({ event: l.event, id, payload }); };
    const line = (i: number, roomId: string) => ({ key: `${roomId}-${i}`, event_id: `$${roomId}-${i}`, sender: '@someone:example.org', sender_name: 'Someone', own: false, ts: now - (5 - i) * min, kind: 'text', body: `Line ${i + 1}`, state: 'remote', encrypted: true, edited: false });
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: (cb: (e: unknown) => void) => { const id = nextId++; callbacks.set(id, cb); return id; },
      invoke: async (cmd: string, args: any) => {
        switch (cmd) {
          case 'messages_status': return { state: 'live', user_id: '@pat:example.org', homeserver: 'https://matrix.example.org', error: null };
          case 'messages_rooms': return w.__rooms;
          case 'messages_sign_out': return { state: 'signed_out', user_id: null, homeserver: null, error: null };
          case 'messages_sign_in_device': return { state: 'live', user_id: '@lee:example.org', homeserver: 'https://matrix.example.org', error: null };
          case 'messages_open': return Array.from({ length: 4 }, (_, i) => line(i, args.roomId));
          case 'messages_links': w.__linkReads = (w.__linkReads ?? 0) + 1; return w.__links;
          case 'messages_link_check': return w.__links.find((l: any) => l.network === args.network);
          // a send can be held, to fail later (w.__failSend()), as one on its way when the account ends
          case 'messages_send': return w.__holdSends ? new Promise((_, no) => { w.__failSend = () => no({ kind: 'unreachable', message: 'The homeserver went away.' }); }) : null;
          case 'messages_close': case 'messages_read': return null;
          case 'plugin:event|listen': { const id = nextId++; listeners.set(id, { event: args.event, handler: args.handler }); return id; }
          case 'plugin:event|unlisten': listeners.delete(args.eventId); return null;
          case 'identity_status': return { paired: true, pubkey: 'a'.repeat(64) };
          case 'get_identity': return 'a'.repeat(64);
          case 'get_rooms': case 'get_messages': case 'get_members': case 'vault_paths': case 'journal_pending': case 'journal_list': case 'vault_list': return [];
          case 'journal_flush': return { sent: [], remaining: 0, error: null };
          case 'journal_config': return { hub: 'https://example.invalid', vault: 'uni' };
          case 'refresh': return { pubkey: 'a'.repeat(64), total_items: 0, channel_errors: {}, truncated_channels: [] };
          default: return null;
        }
      },
    };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_event: string, id: number) => listeners.delete(id) };
  });
  // a test's own changes to the made-up world, before the app starts
  if (before) await page.addInitScript(before);
  await page.goto('/');
  await expect(msgTablist(page).or(page.getByText('No conversations yet.')).first()).toBeVisible({ timeout: 15_000 });
}


const msgList = (page: Page) => page.getByRole('navigation', { name: 'Conversations' });
const msgPhone = (page: Page) => (page.viewportSize()?.width ?? 0) < 700;

// ---- Mail
async function mailBoot(page: Page, mode: mailMock.Mode = 'ok', opts: Parameters<typeof mailMock.boot>[2] = {}) {
  await init(page);
  await mailMock.boot(page, mode, opts);
  await expect(mailMock.mail(page)).toBeVisible();
  await mailMock.rows(page).first().waitFor();
}
const newMail = (page: Page) => (mailMock.stacked(page) ? page.getByRole('navigation', { name: 'Mail actions' }) : page.locator('.mail-list-new')).getByRole('button', { name: /^New/ });

test('80-mail-list-combined', async ({ page }) => {
  await mailBoot(page);
  await expect(mailMock.rows(page)).toHaveCount(6);
  await snap(page, '80-mail-list-combined');
});

test('81-mail-mailboxes', async ({ page }) => {
  await mailBoot(page);
  if (mailMock.boxesHidden(page)) await page.getByRole('button', { name: '☰ Mailboxes' }).click();
  await expect(page.getByRole('navigation', { name: 'Mailboxes' })).toBeVisible();
  await snap(page, '81-mail-mailboxes');
});

test('82-mail-message-thread', async ({ page }) => {
  await mailBoot(page);
  await mailMock.rows(page).nth(0).click();
  await expect(page.getByRole('region', { name: 'Thread: Planning the garden week' })).toBeVisible();
  await snap(page, '82-mail-message-thread');
});

test('83-mail-uni-draft-in-thread', async ({ page }) => {
  await mailBoot(page, 'ok', { writes: true });
  await mailMock.rows(page).nth(0).click();
  const thread = page.getByRole('region', { name: 'Thread: Planning the garden week' });
  await thread.locator('.mail-card').last().scrollIntoViewIfNeeded();
  await expect(thread.getByRole('button', { name: /Review and send/ }).first()).toBeVisible();
  await snap(page, '83-mail-uni-draft-in-thread');
});

test('84-mail-compose', async ({ page }) => {
  await mailBoot(page, 'ok', { writes: true });
  await newMail(page).click();
  await page.getByRole('button', { name: 'Cc / Bcc' }).click();
  await page.getByRole('textbox', { name: 'To' }).fill('mara@example.org');
  await expect(page.getByRole('region', { name: /New message|Compose/ }).or(page.locator('.mail-compose')).first()).toBeVisible();
  await snap(page, '84-mail-compose');
});

test('85-mail-review-before-sending', async ({ page }) => {
  await mailBoot(page, 'ok', { writes: true });
  await newMail(page).click();
  await page.getByRole('radio', { name: /robin@example\.com/ }).check();
  await page.getByRole('textbox', { name: 'To' }).fill('mara@example.org');
  await page.getByRole('button', { name: /^Send as you/ }).click();
  await expect(page.getByRole('region', { name: 'Review before sending' })).toBeVisible();
  await snap(page, '85-mail-review-before-sending');
});

test('86-mail-not-allowed', async ({ page }) => {
  await init(page);
  await mailMock.boot(page, 'not_allowed');
  await page.waitForTimeout(500);
  await snap(page, '86-mail-not-allowed');
});

test('87-mail-unreachable', async ({ page }) => {
  await init(page);
  await mailMock.boot(page, 'unreachable');
  await page.waitForTimeout(500);
  await snap(page, '87-mail-unreachable');
});

// ---- Calendar
async function calBoot(page: Page, opts: Parameters<typeof calMock.boot>[1] = {}) {
  await init(page);
  const d = await calMock.boot(page, opts);
  await expect(calMock.cal(page)).toBeVisible();
  return d;
}

test('90-calendar-day', async ({ page }) => {
  await calBoot(page);
  await calMock.pickView(page, 'Day');
  await snap(page, '90-calendar-day');
});

test('91-calendar-week', async ({ page }) => {
  await calBoot(page);
  await calMock.pickView(page, 'Week');
  await expect(calMock.ev(page, 'Lunch with Kai')).toBeVisible();
  await snap(page, '91-calendar-week');
});

test('92-calendar-agenda', async ({ page }) => {
  await calBoot(page);
  await calMock.pickView(page, 'Agenda');
  await expect(calMock.cal(page).getByRole('region', { name: 'Wednesday, Oct 21' })).toBeVisible();
  await snap(page, '92-calendar-agenda');
});

test('93-calendar-event-sheet', async ({ page }) => {
  await calBoot(page);
  await calMock.pickView(page, 'Agenda');
  await calMock.cal(page).getByRole('region', { name: 'Wednesday, Oct 21' }).getByRole('button', { name: /^Soil workshop,/ }).click();
  await expect(calMock.detail(page)).toBeVisible();
  await snap(page, '93-calendar-event-sheet');
});

test('94-calendar-new-event-form', async ({ page }) => {
  await calBoot(page);
  await calMock.pickView(page, 'Week');
  await calMock.cal(page).getByRole('button', { name: 'New event', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'New event' });
  await form.getByLabel('Title').fill('Pottery wheel session');
  await form.getByLabel('Where').fill('Clay barn');
  await snap(page, '94-calendar-new-event-form');
});

// ---- Messages
async function messages(page: Page) {
  await init(page);
  await messagesBoot(page);
}

test('100-messages-list-all', async ({ page }) => {
  await messages(page);
  await expect(msgList(page).locator('.msgs-row-name').first()).toBeVisible();
  await snap(page, '100-messages-list-all');
});

test('101-messages-thread', async ({ page }) => {
  await messages(page);
  await msgList(page).getByRole('button', { name: /Mara Quill/ }).click();
  await expect(page.getByRole('region', { name: 'Conversation: Mara Quill' }).getByRole('textbox', { name: 'Message Mara Quill on WhatsApp' })).toBeVisible();
  await snap(page, '101-messages-thread');
});

test('102-messages-link-another-network', async ({ page }) => {
  await messages(page);
  await page.getByRole('button', { name: 'Link another network' }).click();
  await page.waitForTimeout(300);
  await snap(page, '102-messages-link-another-network');
});

test('103-messages-empty-link-first', async ({ page }) => {
  await init(page);
  await messagesBoot(page, () => { const w = window as any; w.__rooms = []; w.__links = w.__links.map((l: any) => ({ ...l, state: 'not_linked' })); });
  await expect(msgList(page).getByRole('button', { name: 'Link an account' })).toBeVisible();
  await snap(page, '103-messages-empty-link-first');
});

// ---------------------------------------------------------------------------------------------------------- cards in the chat
const nowS = () => Math.floor(Date.now() / 1000);
const sealedRow = (o: Record<string, unknown> = {}) => ({ rid: 'r1'.padEnd(32, '0'), action: 'dns.edit', credential: 'dns-zone', class: 'powerful', scope: 'Add an A record for demo.example.org',
  ttl_s: 600, uses: 1, payload: { type: 'A', name: 'demo', content: '192.0.2.7', zone: 'example.org' }, request_digest: '9b13b2ae' + 'f'.repeat(56), expires: nowS() + 900, answer: null, ...o });
const sealedView = (rows: unknown[], kind: 'single' | 'morning' = 'single') => ({ kind, event_id: 'e'.repeat(64), refused: null, rows });
const fence = (lang: string, prose: string) => `${prose}\nOpen this in the Uni app to see exactly what it unlocks.\n\n\`\`\`${lang}\n{"v": 1}\n\`\`\``;
const SECRET_FIXTURE = JSON.parse(readFileSync(new URL('../fixtures/t176-messages.json', import.meta.url), 'utf8'));
const secretBody = (SECRET_FIXTURE.request.content as string).replace(/"expires":\d+/, `"expires":${nowS() + 900}`);
const secretReq = () => JSON.parse(/```uni-secret-request\n([^\n]*)\n```/.exec(secretBody)![1]);
const arrive = (page: Page, channel: string, body: string, who = 'Uni') => page.evaluate(([c, n, b]) => (window as any).__arrive(c, n, b), [channel, who, body] as const);
async function kilnWith(page: Page, tour: Tour, body: string) {
  await glow(page, {}, {}, tour);
  await openPlaces(page);
  await page.locator('.fd-door[data-path="Areas/Kiln Studio"]').click();
  await roomBox(page).waitFor();
  await arrive(page, 'ch-kiln', body);
}

test('110-sealed-approval-card', async ({ page }) => {
  await kilnWith(page, { cards: { sealed: sealedView([sealedRow()]) } }, fence('uni-sealed-approval', '🔑 **Uni asks to use dns-zone** (powerful)'));
  const c = page.getByRole('region', { name: 'Approve use of dns-zone', exact: true });
  await c.scrollIntoViewIfNeeded();
  await expect(c).toBeVisible();
  await snap(page, '110-sealed-approval-card');
});

test('111-sealed-approval-card-details', async ({ page }) => {
  await kilnWith(page, { cards: { sealed: sealedView([sealedRow()]) } }, fence('uni-sealed-approval', '🔑 **Uni asks to use dns-zone** (powerful)'));
  const c = page.getByRole('region', { name: 'Approve use of dns-zone', exact: true });
  await c.getByRole('button', { name: 'details', exact: true }).click();
  await expect(c.locator('.cc-details')).toBeVisible();
  await c.scrollIntoViewIfNeeded();
  await snap(page, '111-sealed-approval-card-details');
});

test('112-sealed-morning-card', async ({ page }) => {
  const rows = [sealedRow({ rid: 'r1'.padEnd(32, '0'), action: 'mail.read', credential: 'mail-read', class: 'routine', scope: 'Read the inbox for triage', ttl_s: 3600, uses: 20 }),
    sealedRow({ rid: 'r2'.padEnd(32, '0'), action: 'cal.read', credential: 'cal-read', class: 'routine', scope: 'Read the calendar for the day', ttl_s: 3600, uses: 20 })];
  await kilnWith(page, { cards: { sealed: sealedView(rows, 'morning') } }, fence('uni-sealed-morning', "🔑 **Uni's morning card**: 2 routine credential(s) for today"));
  const c = page.getByRole('region', { name: "Uni's morning card", exact: true });
  await c.scrollIntoViewIfNeeded();
  await expect(c).toBeVisible();
  await snap(page, '112-sealed-morning-card');
});

test('113-secret-request-card-untrusted', async ({ page }) => {
  await kilnWith(page, { cards: { secret: secretReq() } }, secretBody);
  const c = page.getByRole('region', { name: 'Secret request: Tailscale API token' });
  await c.scrollIntoViewIfNeeded();
  await expect(c.getByRole('button', { name: /^Trust Uni/ })).toBeVisible();
  await snap(page, '113-secret-request-card-untrusted');
});

test('114-secret-request-card-field', async ({ page }) => {
  await kilnWith(page, { cards: { secret: secretReq(), trusted: true } }, secretBody);
  const c = page.getByRole('region', { name: 'Secret request: Tailscale API token' });
  await c.scrollIntoViewIfNeeded();
  const field = c.locator('input[type=password]');
  await field.fill('made-up-not-a-real-secret');
  await snap(page, '114-secret-request-card-field');
});

// the front door's own needs-you queue
test('115-decision-card-in-chat', async ({ page }) => {
  const D1 = '01M5D0000000000000000000A1';
  await init(page);
  await page.addInitScript(([d1]) => {
    const at = '2026-10-09T09:00:00.000Z';
    (window as any).__seedTasks = [{ id: d1, path: 'Decisions/2026-10-09 Which layout for the garden page?', extension: 'md', tags: ['decision'], createdAt: at, updatedAt: at,
      lastUpdatedVia: 'api', content: '# Which layout for the garden page?\n\n- A\n- B (default)\n- C\n',
      metadata: { node: 'Projects/ATLAS', state: 'open', options: ['A', 'B', 'C'], default: 'B', owner: 'aaron', asked: '2026-10-09', task: 'T-07' } }];
  }, [D1] as const);
  await bootAreas(page, 'seed', TASKS);
  await openRoom(page, 'ATLAS');
  await arrive(page, '7dcea809-25cd-4160-ba99-f0a56386adcb', `Your call on the garden page layout. Tap your pick: uni:${D1}`);
  const card = focusSheet(page).getByRole('region', { name: 'Decision: Which layout for the garden page?' });
  await card.scrollIntoViewIfNeeded();
  await expect(card).toBeVisible();
  await snap(page, '115-decision-card-in-chat');
});

test('116-attachments-in-chat', async ({ page }) => {
  await glow(page, {}, {}, { media: true });
  await openPlaces(page);
  await page.locator('.fd-door[data-path="Areas/Kiln Studio"]').click();
  await expect(focusSheet(page).getByRole('button', { name: 'Open Firing log.pdf' })).toBeVisible();
  await snap(page, '116-attachments-in-chat');
});

test('117-attachment-image-preview', async ({ page }) => {
  await glow(page, {}, {}, { media: true });
  await openPlaces(page);
  await page.locator('.fd-door[data-path="Areas/Kiln Studio"]').click();
  await focusSheet(page).getByRole('button', { name: 'Open image tiles.jpg' }).click();
  await expect(page.getByRole('dialog', { name: 'tiles.jpg' })).toBeVisible();
  await snap(page, '117-attachment-image-preview');
});

test('118-attachment-saved-status', async ({ page }) => {
  await glow(page, {}, {}, { media: true });
  await openPlaces(page);
  await page.locator('.fd-door[data-path="Areas/Kiln Studio"]').click();
  await focusSheet(page).getByRole('button', { name: 'Save Firing log.pdf to Downloads' }).click();
  await expect(focusSheet(page).getByRole('status').filter({ hasText: 'Saved to Downloads/Firing log.pdf' })).toBeVisible();
  await snap(page, '118-attachment-saved-status');
});

// ---- Hermes approval prompt
const PROMPTS = JSON.parse(readFileSync(new URL('../fixtures/approval-prompts.json', import.meta.url), 'utf8'));
test('120-approval-prompt-in-needs-you', async ({ page }) => {
  await init(page);
  await bootAreas(page, 'seed', { tree: true, tasks: true, briefs: true, strayRoom: true });
  await page.locator('[data-place="front-door"]').waitFor();
  await arrive(page, 'ch-garden', PROMPTS.prompts.two_answers_30min);
  await openPlaces(page);
  await expect(page.locator('.cp-approval')).toHaveCount(1);
  await snap(page, '120-approval-prompt-in-needs-you');
});

test('121-approval-prompt-card-in-room', async ({ page }) => {
  await init(page);
  await bootAreas(page, 'seed', { tree: true, tasks: true, briefs: true, strayRoom: true });
  await page.locator('[data-place="front-door"]').waitFor();
  await arrive(page, 'ch-garden', PROMPTS.prompts.two_answers_30min);
  await openPlaces(page);
  await page.locator('.cp-approval').getByRole('button').click();
  await expect(page.locator('.message.approval-waiting')).toBeVisible();
  await snap(page, '121-approval-prompt-card-in-room');
});

// ---------------------------------------------------------------------------------------------------------- thread, To post, For you, Journal, app, composer
test('130-thread-view', async ({ page }) => {
  await atlas(page, { thread: true });
  await focusSheet(page).locator('.sr-chat .thread-summary').first().click();
  await expect(focusSheet(page).getByRole('button', { name: 'Back to ATLAS' })).toBeVisible();
  await expect(focusSheet(page).locator('.all-focus-line')).toHaveText('Thread · 2 replies');
  await snap(page, '130-thread-view');
});

const POSTS = [
  { id: 'post-uni', path: 'Posts/build log', tags: ['post'], updatedAt: '2026-10-29T10:00:01.000Z', metadata: { state: 'proposed', platform: 'bluesky', piece: '', media: [], account: 'uni', provenance: 'uni', body: 'Uni build log, week 44: 12 tests went red before the fix, 0 after. Notes: https://example.com/log/44', why: 'The weekly build log.', crosspost: ['x'] } },
  { id: 'post-mine', path: 'Posts/excerpt', tags: ['post'], updatedAt: '2026-10-29T10:00:02.000Z', metadata: { state: 'proposed', platform: 'bluesky', media: [], account: 'aaron', provenance: 'aaron-excerpt', piece: 'https://example.com/pieces/slow-work', body: '“The garden doesn’t hurry.” https://example.com/pieces/slow-work' } },
  { id: 'post-wrong', path: 'Posts/wrong voice', tags: ['post'], updatedAt: '2026-10-29T10:00:03.000Z', metadata: { state: 'proposed', platform: 'bluesky', piece: '', media: [], account: 'aaron', provenance: 'uni', body: 'A sentence Uni wrote, proposed for the wrong account.' } },
];
async function toPost(page: Page) {
  await init(page);
  await page.addInitScript((posts) => {
    (window as any).__extraInvoke = ((prev: any) => async (cmd: string, args: any) => {
      if (cmd === 'vault_query' && args.tag === 'post') return JSON.parse(JSON.stringify(posts));
      if (cmd === 'unlock_grace') return null;
      return prev ? prev(cmd, args) : undefined;
    })((window as any).__extraInvoke);
  }, POSTS);
  await bootAreas(page, 'seed', { tree: true, tasks: true, briefs: true });
  await page.locator('[data-place="front-door"]').waitFor();
}

test('140-to-post-front-door-count', async ({ page }) => {
  await toPost(page);
  await openPlaces(page);
  await expect(page.getByRole('button', { name: 'To post · 3' })).toBeVisible();
  await snap(page, '140-to-post-front-door-count');
});

test('141-to-post-queue', async ({ page }) => {
  await toPost(page);
  await openPlaces(page);
  await page.getByRole('button', { name: 'To post · 3' }).click();
  await expect(page.getByRole('region', { name: 'To post' }).getByRole('heading', { name: 'To review · 3' })).toBeVisible();
  await snap(page, '141-to-post-queue');
});

test('142-for-you', async ({ page }) => {
  await glow(page, {}, {}, { forYou: true });
  await openPlaces(page);
  await page.getByRole('button', { name: /^For you/ }).click();
  await expect(page.getByText('Worth a look')).toBeVisible();
  await snap(page, '142-for-you');
});

test('143-journal-empty', async ({ page }) => {
  await glow(page);
  await rail(page).getByRole('button', { name: 'Journal' }).click();
  await expect(page.locator('.journal-tab-content')).toBeVisible();
  await snap(page, '143-journal-empty');
});

test('144-journal-entries', async ({ page }) => {
  await init(page);
  await page.addInitScript(() => { (window as any).__journal = [1, 2, 3].map((i) => ({ id: `j${i}`, path: `Journal/2026/10-1${i}/09-00 Entry ${i}`, created_at: `2026-10-1${i}T15:00:00Z`, content: `A made-up morning entry, number ${i}. The kiln was warm and the garden quiet; we planned the week over tea.`, source: 'text', entry_id: `e${i}` })); });
  await bootAreas(page, 'seed', { world: 'unread', glow: true, uniMember: true });
  await rail(page).getByRole('button', { name: 'Journal' }).click();
  await expect(page.locator('.journal-list .journal-entry').first()).toBeVisible();
  await snap(page, '144-journal-entries');
});

test('145-journal-entry-menu', async ({ page }) => {
  await init(page);
  await page.addInitScript(() => { (window as any).__journal = [1, 2, 3].map((i) => ({ id: `j${i}`, path: `Journal/2026/10-1${i}/09-00 Entry ${i}`, created_at: `2026-10-1${i}T15:00:00Z`, content: `A made-up morning entry, number ${i}.`, source: 'text', entry_id: `e${i}` })); });
  await bootAreas(page, 'seed', { world: 'unread', glow: true, uniMember: true });
  await rail(page).getByRole('button', { name: 'Journal' }).click();
  await page.locator('.journal-list').getByRole('button', { name: 'More for this entry' }).first().click();
  await expect(page.getByRole('group', { name: 'Entry actions' })).toBeVisible();
  await snap(page, '145-journal-entry-menu');
});

test('150-area-app-in-room', async ({ page }) => {
  test.setTimeout(90_000);
  test.skip(project() === 'daylight', "area apps don't open on the Android user agent (the platform gate): the Daylight stays on the default room view");
  await init(page);
  await bootAreas(page, 'seed');
  await openAreaPage(page, 'Techne', { app: true });
  await expect(page.frameLocator('iframe.area-frame').locator('#title')).toHaveText('Techne');
  await snap(page, '150-area-app-in-room');
});

test('151-area-app-suggestion-bar', async ({ page }) => {
  test.setTimeout(90_000);
  test.skip(project() === 'daylight', "area apps don't open on the Android user agent (the platform gate): the Daylight stays on the default room view");
  await init(page);
  await bootAreas(page, 'seed');
  await openAreaPage(page, 'Techne', { app: true });
  const f = page.frameLocator('iframe.area-frame');
  await expect(f.locator('#title')).toHaveText('Techne');
  await f.locator('#t').fill('Pairing on the bridge tonight');
  await f.locator('#go').click();
  await expect(page.locator('.suggestion-bar')).toContainText('Techne suggests a draft');
  await snap(page, '151-area-app-suggestion-bar');
});

test('152-area-app-self-test', async ({ page }) => {
  test.setTimeout(120_000);
  await init(page, {}, { approvals: true });
  await bootAreas(page, 'seed', { selftest: false });
  await railGo(page, 'Settings');
  await page.locator('.settings-dev > summary').click();
  await page.getByRole('button', { name: 'Run sandbox self-test' }).click();
  await expect(page.locator('.selftest-status.pass')).toContainText('Passed', { timeout: 60000 });
  await page.locator('.selftest-list').scrollIntoViewIfNeeded();
  await snap(page, '152-area-app-self-test');
});

test('153-area-app-grant-prompt', async ({ page }) => {
  test.setTimeout(90_000);
  test.skip(project() === 'daylight', "area apps don't open on the Android user agent (the platform gate)");
  await init(page);
  await bootAreas(page, 'seed', { granted: false });
  await openAreaPage(page, 'Techne', { app: true });
  await page.waitForTimeout(500);
  await snap(page, '153-area-app-grant-prompt');
});

test('160-composer-menu-open', async ({ page }) => {
  await kiln(page);
  await focusSheet(page).getByRole('button', { name: 'More message options' }).click();
  await expect(page.getByRole('menuitem').first()).toBeVisible();
  await snap(page, '160-composer-menu-open');
});

test('38-settings-approvals-confirm', async ({ page }) => {
  await settings(page);
  const a = page.getByRole('region', { name: 'Approvals' });
  await a.scrollIntoViewIfNeeded();
  await a.getByRole('button', { name: 'Enable approvals for Uni' }).click();
  await expect(a.getByRole('group', { name: 'Enable approvals for Uni' })).toBeVisible();
  await snap(page, '38-settings-approvals-confirm');
});

// ---------------------------------------------------------------------------------------------------------- more of what a person can see
test('161-room-uni-working-stop', async ({ page }) => {
  await kiln(page);
  await page.evaluate(() => { (window as any).__postDelay = 60_000; });
  const box = roomBox(page);
  await box.fill('Can you draft the firing plan for the week?');
  if (touch()) await focusSheet(page).locator('.composer button.send').click(); else await box.press('Enter');
  await expect(focusSheet(page).locator('.composer button[aria-label="Stop Uni"]')).toBeVisible();
  await snap(page, '161-room-uni-working-stop');
});

test('162-room-quick-replies', async ({ page }) => {
  await glow(page);
  await openPlaces(page);
  await page.locator('.fd-door[data-path="Areas/Bee Garden"]').click();
  await expect(page.getByRole('group', { name: 'Quick replies' })).toBeVisible();
  await snap(page, '162-room-quick-replies');
});

test('163-room-mention-picker', async ({ page }) => {
  await kiln(page);
  await roomBox(page).pressSequentially('@');
  await page.waitForTimeout(300);
  await snap(page, '163-room-mention-picker');
});

test('22-find-no-results', async ({ page }) => {
  await kiln(page);
  if (wide(page)) await page.keyboard.press('Control+k'); else await railGo(page, 'Search');
  await page.getByRole('searchbox', { name: 'Search conversations and notes' }).fill('zzzqqq nothing like this');
  await page.waitForTimeout(800);
  await snap(page, '22-find-no-results');
});

test('88-mail-search-results', async ({ page }) => {
  await mailBoot(page);
  const q = page.getByRole('searchbox', { name: 'Search mail' });
  await q.fill('marmalade');
  await q.press('Enter');
  await page.waitForTimeout(600);
  await snap(page, '88-mail-search-results');
});

test('104-messages-sign-in', async ({ page }) => {
  await messages(page);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('button', { name: 'Sign out?' }).click();
  await expect(page.getByRole('form', { name: 'Sign in to Messages' })).toBeVisible();
  await snap(page, '104-messages-sign-in');
});

test('39-settings-calm-screen-on', async ({ page }) => {
  await settings(page);
  await page.getByRole('checkbox', { name: /Calm screen/ }).check();
  await expect(page.locator('html')).toHaveAttribute('data-screen', 'ink');
  await snap(page, '39-settings-calm-screen-on');
});

test('07-all-view-composer-focus', async ({ page }) => {
  await glow(page);
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Uni', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message for your rooms' }).click();
  await snap(page, '07-all-view-composer-focus');
});

test('23-find-scoped-to-a-folder', async ({ page }) => {
  await vaultBrowser(page);
  // 0.2: a name that finds nothing offers a search of the notes' words
  await page.getByRole('searchbox', { name: 'Find a note by name' }).fill('bisque');
  await page.getByRole('button', { name: /^Search the notes for/ }).click();
  await expect(page.getByRole('searchbox', { name: 'Search conversations and notes' })).toBeVisible();
  await snap(page, '23-find-scoped-to-a-folder');
});

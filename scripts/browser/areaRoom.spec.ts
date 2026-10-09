// T-75: an area includes its room. The interface and the area's chat (the app's real room view) side by side on a
// desktop, with a pull-up sheet on a phone; live messages reach the interface; suggestions land above the composer.
import { mkdir } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import { bootAreas } from './areasFixture';

const rail = (page: Page) => page.getByRole('navigation', { name: 'Main navigation' });
const openArea = async (page: Page, name: string) => {
  await rail(page).getByRole('button', { name: 'Areas', exact: true }).click();
  await page.locator('.area-card', { has: page.locator('strong', { hasText: new RegExp(`^${name}$`) }) }).click();
  await expect(page.locator('.area-bar-title')).toHaveText(name);
};
const calls = (page: Page, cmd: string) => page.evaluate((c) => (window as any).__calls.filter((x: any) => x.cmd === c), cmd);
const arrive = (page: Page, channel: string, name: string, body: string) => page.evaluate(([c, n, b]) => (window as any).__arrive(c, n, b), [channel, name, body]);
const isDesktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 900;
const composer = (page: Page, room: string) => page.getByRole('textbox', { name: `Message ${room}` });
const frame = (page: Page) => page.frameLocator('iframe.area-frame');

// Reports every chat.message the frame hears (and how many) so a test can tell "nothing" from "not yet".
const LISTENER = `<!doctype html><html><body><pre id="out">none</pre><script>
var got = [];
uni.chat.onMessage(function (m) { got.push(m); document.getElementById('out').textContent = JSON.stringify(got); });
uni.chat.recent(1).then(function () { document.getElementById('out').dataset.recent = 'ok'; }, function (e) { document.getElementById('out').dataset.recent = e.code; });
</script></body></html>`;
const iface = (needs: object[], chat?: string) => ({ contract: 1, needs, ...(chat ? { layout: { chat } } : {}) });
const ALL = [{ 'vault.read': 'area' }, { 'chat.read': 'area' }, { 'chat.draft': 'area' }];

test.describe('layout', () => {
  test('desktop: interface and chat side by side; the divider drags and the width persists', async ({ page }, info) => {
    test.skip(!isDesktop(page), 'desktop only');
    await bootAreas(page, 'seed');
    await openArea(page, 'Techne');
    const chat = page.locator('.area-chat.side');
    await expect(chat).toBeVisible();
    await expect(composer(page, 'Techne')).toBeVisible();
    await expect(chat.locator('.message-list')).toContainText('Run it on the laptop first.');
    await expect(frame(page).locator('#title')).toHaveText('Techne');
    const f = (await page.locator('iframe.area-frame').boundingBox())!, c = (await chat.boundingBox())!;
    expect(f.x + f.width, 'the interface ends where the chat begins').toBeLessThanOrEqual(c.x + 2);
    expect(Math.abs(f.y - c.y), 'same top edge').toBeLessThan(40);
    expect(c.width).toBeGreaterThan(300);
    // drag the divider 120px to the left: the chat grows by that much
    const sep = page.getByRole('separator', { name: 'Resize chat' });
    const s = (await sep.boundingBox())!;
    await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
    await page.mouse.down();
    await page.mouse.move(s.x + s.width / 2 - 60, s.y + s.height / 2, { steps: 4 });
    await page.mouse.move(s.x + s.width / 2 - 120, s.y + s.height / 2, { steps: 4 });
    await page.mouse.up();
    const after = (await chat.boundingBox())!;
    expect(Math.round(after.width - c.width)).toBeGreaterThanOrEqual(115); expect(Math.round(after.width - c.width)).toBeLessThanOrEqual(125);
    const stored = await page.evaluate(() => localStorage.getItem('uni.area.chatWidth.v1'));
    expect(Number(stored)).toBe(Math.round(after.width));
    // keyboard: the separator moves in steps
    await sep.focus(); await page.keyboard.press('ArrowRight');
    expect(Math.round((await chat.boundingBox())!.width)).toBe(Math.round(after.width) - 24);
    // a limit: dragged far, the chat never takes more than 60% and the interface keeps room
    await sep.focus(); for (let i = 0; i < 30; i++) await page.keyboard.press('Shift+ArrowLeft');
    const box = (await page.locator('.area-split').boundingBox())!;
    expect((await chat.boundingBox())!.width).toBeLessThanOrEqual(box.width * 0.6 + 1);
    const w = await page.evaluate(() => localStorage.getItem('uni.area.chatWidth.v1'));
    // persisted across a reload and a different area
    await page.reload();
    await page.getByRole('tab', { name: /Techne/ }).click();
    await expect(chat).toBeVisible();
    expect(Math.round((await chat.boundingBox())!.width)).toBe(Number(w));
    await mkdir('shots/t75', { recursive: true });
    await page.screenshot({ path: `shots/t75/${info.project.name}-divider-wide.png` });
  });

  test('phone: the interface is full screen and the chat is a pull-up sheet with a peek bar', async ({ page }, info) => {
    test.skip(isDesktop(page), 'phone only');
    await bootAreas(page, 'seed');
    await openArea(page, 'Techne');
    const sheet = page.locator('.area-chat.sheet');
    const peek = sheet.locator('.sheet-peek');
    await expect(peek).toBeVisible();
    await expect(peek).toContainText('Ship Techne first');
    await expect(peek).toContainText('Aaron');
    await expect(page.locator('.area-chat.side')).toHaveCount(0);
    const vp = page.viewportSize()!;
    const f = (await page.locator('iframe.area-frame').boundingBox())!;
    expect(f.width, 'interface is full width').toBeGreaterThan(vp.width - 4);
    await expect(composer(page, 'Techne'), 'collapsed: the composer is out of reach').toBeHidden();
    await expect(peek).toHaveAttribute('aria-expanded', 'false');
    await mkdir('shots/t75', { recursive: true });
    await page.screenshot({ path: `shots/t75/${info.project.name}-sheet-peek.png` });
    // a message arrives while collapsed: the peek shows it and counts it
    await arrive(page, 'ch-techne', 'Uni', 'A word while you were away');
    await expect(peek).toContainText('A word while you were away');
    await expect(sheet.locator('.peek-unread')).toHaveText('1');
    await arrive(page, 'ch-techne', 'Uni', 'And another');
    await expect(sheet.locator('.peek-unread')).toHaveText('2');
    // tap expands: the composer is reachable, inside the viewport, and the unread count clears
    await peek.click();
    await expect(peek).toHaveAttribute('aria-expanded', 'true');
    await expect(composer(page, 'Techne')).toBeVisible();
    const cb = (await composer(page, 'Techne').boundingBox())!;
    expect(cb.y + cb.height).toBeLessThanOrEqual(vp.height + 1);
    await expect(sheet.locator('.peek-unread')).toHaveCount(0);
    await expect(sheet.locator('.message-list')).toContainText('A word while you were away');
    await composer(page, 'Techne').fill('typing from the sheet');
    await page.screenshot({ path: `shots/t75/${info.project.name}-sheet-open.png` });
    // tap again collapses; the draft survives
    await peek.click();
    await expect(composer(page, 'Techne')).toBeHidden();
    await peek.click();
    await expect(composer(page, 'Techne')).toHaveValue('typing from the sheet');
  });

  test('phone: dragging the peek bar up expands and down collapses', async ({ page }) => {
    test.skip(isDesktop(page), 'phone only');
    await bootAreas(page, 'seed');
    await openArea(page, 'Techne');
    const peek = page.locator('.sheet-peek');
    await expect(peek).toBeEnabled(); // the room has opened
    await page.waitForTimeout(400); // and the layout has settled
    const b = (await peek.boundingBox())!;
    const x = b.x + b.width / 2, y = b.y + b.height / 2;
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x, y - 60, { steps: 5 }); await page.mouse.up();
    await expect(peek).toHaveAttribute('aria-expanded', 'true');
    const o = (await peek.boundingBox())!;
    await page.mouse.move(x, o.y + o.height / 2); await page.mouse.down(); await page.mouse.move(x, o.y + o.height / 2 + 60, { steps: 5 }); await page.mouse.up();
    await expect(peek).toHaveAttribute('aria-expanded', 'false');
  });

  test('the manifest hint wins: sheet on a desktop, hidden shows no chat; side on a phone is a sheet', async ({ page }) => {
    await bootAreas(page, 'seed', { apps: [{ name: 'Hush', html: LISTENER, interface: iface(ALL, 'hidden') }, { name: 'Wild', html: LISTENER, interface: iface(ALL, 'sideways') }] });
    await openArea(page, 'Unforced Development'); // seed hint: sheet
    await expect(page.locator('.area-chat.sheet')).toHaveCount(1);
    await expect(page.locator('.area-chat.side')).toHaveCount(0);
    await expect(page.getByRole('separator', { name: 'Resize chat' })).toHaveCount(0);
    await page.locator('.area-bar .note-back').click();
    await openArea(page, 'Hush');
    await expect(page.locator('.area-chat')).toHaveCount(0);
    await expect(page.locator('iframe.area-frame')).toBeVisible();
    await page.locator('.area-bar .note-back').click();
    await openArea(page, 'Wild'); // unknown hint: the default for this device
    await expect(page.locator(isDesktop(page) ? '.area-chat.side' : '.area-chat.sheet')).toHaveCount(1);
  });

  test('an area with no room says so in the chat pane', async ({ page }) => {
    await bootAreas(page, 'seed');
    await openArea(page, 'Relationships');
    await expect(page.locator('.area-chat')).toContainText('This area has no room yet');
    await expect(page.getByRole('textbox', { name: /^Message / }).filter({ visible: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Open #/ })).toHaveCount(0);
  });
});

test.describe('the room is the real room', () => {
  test('typing in the area composer sends through the room view, with Send', async ({ page }) => {
    await bootAreas(page, 'seed');
    await openArea(page, 'Techne');
    if (!isDesktop(page)) await page.locator('.sheet-peek').click();
    await composer(page, 'Techne').fill('hello from the area');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect.poll(async () => (await calls(page, 'post_message')).length).toBe(1);
    const [call] = await calls(page, 'post_message');
    expect(call.args.channel).toBe('ch-techne'); expect(call.args.body).toBe('hello from the area');
  });

  test('zoom: Open #room opens the full room, and the draft carries over', async ({ page }) => {
    await bootAreas(page, 'seed');
    await openArea(page, 'Techne');
    if (!isDesktop(page)) await page.locator('.sheet-peek').click();
    await composer(page, 'Techne').fill('half a thought');
    await page.getByRole('button', { name: /Open #Techne/ }).click();
    await expect(page.locator('.conversation-header')).toContainText('Techne');
    await expect(page.locator('.tab-chip')).toHaveCount(2);
    await expect(composer(page, 'Techne')).toHaveValue('half a thought');
    // the area tab is still there and still shows its chat
    await page.getByRole('tab', { name: /Techne/ }).first().click();
    await expect(page.locator('.area-bar-title')).toHaveText('Techne');
  });

  test('the area tab restores with its room after a reload', async ({ page }) => {
    await bootAreas(page, 'seed');
    await openArea(page, 'Techne');
    await page.reload();
    await page.getByRole('tab', { name: /Techne/ }).click();
    await expect(page.locator('.area-bar-title')).toHaveText('Techne');
    if (!isDesktop(page)) await page.locator('.sheet-peek').click();
    await expect(composer(page, 'Techne')).toBeVisible();
    await expect(page.locator('.area-chat .message-list')).toContainText('Run it on the laptop first.');
  });
});

test.describe('live messages', () => {
  test('an arriving message updates the interface and the chat', async ({ page }, info) => {
    await bootAreas(page, 'seed');
    await openArea(page, 'Techne');
    const f = frame(page);
    await expect(f.locator('#latest-body')).toContainText('Ship Techne first');
    await expect(f.locator('#latest-h')).toHaveText('Latest from #techne');
    await arrive(page, 'ch-techne', 'Uni', 'Live from the room: the sheet works');
    await expect(f.locator('#latest-body')).toContainText('Live from the room: the sheet works');
    await expect(f.locator('#latest-body')).toContainText('Uni');
    await expect(f.locator('#pulse li').first()).toContainText('the sheet works');
    if (isDesktop(page)) await expect(page.locator('.area-chat .message-list')).toContainText('the sheet works');
    await mkdir('shots/t75', { recursive: true });
    await page.screenshot({ path: `shots/t75/${info.project.name}-live-techne.png` });
  });

  test('the unforced dashboard feed is live too', async ({ page }) => {
    await bootAreas(page, 'seed');
    await openArea(page, 'Unforced Development');
    const f = frame(page);
    await expect(f.locator('#s-msgs')).toContainText('2');
    await arrive(page, 'ch-unf', 'Uni', 'Proposal two is signed');
    await expect(f.locator('#feed li').first()).toContainText('Proposal two is signed');
    await expect(f.locator('#s-msgs')).toContainText('3');
  });

  test('a message from another room does not reach the interface', async ({ page }) => {
    await bootAreas(page, 'seed', { granted: false, apps: [{ name: 'Ears', html: LISTENER, interface: iface(ALL, 'hidden') }] });
    await openArea(page, 'Ears');
    await page.getByRole('button', { name: 'Allow' }).click();
    const out = frame(page).locator('#out');
    await expect(out).toHaveAttribute('data-recent', 'ok');
    await arrive(page, 'ch-sad', 'Aaron', 'not for this area');
    await arrive(page, 'ch-techne', 'Uni', 'for this area');
    await expect(out).toContainText('for this area');
    await expect(out).not.toContainText('not for this area');
  });

  test('without chat.read nothing is pushed (and chat.recent is refused)', async ({ page }) => {
    await bootAreas(page, 'seed', { granted: false, apps: [{ name: 'Deaf', html: LISTENER, interface: iface([{ 'vault.read': 'area' }, { 'chat.draft': 'area' }], 'hidden') }] });
    await openArea(page, 'Deaf');
    await page.getByRole('button', { name: 'Allow' }).click();
    const out = frame(page).locator('#out');
    await expect(out).toHaveAttribute('data-recent', 'not_granted');
    for (let i = 0; i < 3; i++) await arrive(page, 'ch-techne', 'Uni', 'whisper ' + i);
    await page.waitForTimeout(600);
    await expect(out).toHaveText('none');
  });

  test('cleaning: hidden characters never reach the interface', async ({ page }) => {
    await bootAreas(page, 'seed', { granted: false, apps: [{ name: 'Clean', html: LISTENER, interface: iface(ALL, 'hidden') }] });
    await openArea(page, 'Clean');
    await page.getByRole('button', { name: 'Allow' }).click();
    const out = frame(page).locator('#out');
    await expect(out).toHaveAttribute('data-recent', 'ok');
    await arrive(page, 'ch-techne', 'Uni', 'vis‮ible​ text' + String.fromCodePoint(0xe0041));
    await expect(out).toContainText('visible text');
    expect(await out.textContent()).not.toMatch(/[‮​]|\u{e0041}/u);
  });

  test('a burst of messages is bounded by the request bucket', async ({ page }) => {
    await bootAreas(page, 'seed', { granted: false, apps: [{ name: 'Burst', html: LISTENER, interface: iface(ALL, 'hidden') }] });
    await openArea(page, 'Burst');
    await page.getByRole('button', { name: 'Allow' }).click();
    const out = frame(page).locator('#out');
    await expect(out).toHaveAttribute('data-recent', 'ok');
    await page.evaluate(() => { for (let i = 0; i < 90; i++) (window as any).__arrive('ch-techne', 'Uni', 'burst ' + i); });
    await expect(out).toContainText('burst');
    await page.waitForTimeout(800);
    const n = await out.evaluate((el) => JSON.parse(el.textContent || '[]').length);
    expect(n).toBeLessThanOrEqual(60); expect(n).toBeGreaterThan(5);
  });
});

test.describe('suggestions', () => {
  test('the suggestion bar sits directly above the chat composer and Add to draft fills it', async ({ page }, info) => {
    await bootAreas(page, 'seed');
    await openArea(page, 'Techne');
    const f = frame(page);
    await f.locator('#t').fill('Pairing on the bridge tonight');
    await f.locator('#go').click();
    const bar = page.locator('.area-chat .suggestion-bar');
    await expect(bar).toBeVisible(); // on a phone the sheet opens by itself
    await expect(bar).toContainText('Pairing on the bridge tonight');
    await expect(page.locator('.area-main .suggestion-bar')).toHaveCount(0);
    const b = (await bar.boundingBox())!, c = (await composer(page, 'Techne').boundingBox())!;
    expect(b.y + b.height).toBeLessThanOrEqual(c.y + 2);
    expect(c.y - (b.y + b.height), 'directly above, not far off').toBeLessThan(160);
    await expect(composer(page, 'Techne')).toHaveValue('');
    await mkdir('shots/t75', { recursive: true });
    await page.screenshot({ path: `shots/t75/${info.project.name}-suggestion.png` });
    await bar.getByRole('button', { name: 'Add to draft' }).click();
    await expect(composer(page, 'Techne')).toHaveValue('Pairing on the bridge tonight');
    await expect(composer(page, 'Techne')).toBeFocused();
    expect(await calls(page, 'post_message')).toHaveLength(0);
    await expect(page.locator('.tab-chip'), 'no room tab opened: the composer is right there').toHaveCount(1);
    // a second suggestion goes after the draft
    if (!isDesktop(page)) await page.locator('.sheet-peek').click(); // put the sheet down to reach the interface
    // the composer holds the keyboard (inert frame under a press catcher): one press hands it back to the app
    await page.locator('.area-catcher').click({ timeout: 1500 }).catch(() => {}); // (already gone once the sheet is down)
    await f.locator('#t').fill('second thought'); await f.locator('#go').click();
    await bar.getByRole('button', { name: 'Add to draft' }).click();
    await expect(composer(page, 'Techne')).toHaveValue('Pairing on the bridge tonight\n\nsecond thought');
  });

  test('with the chat hidden the bar stays above the interface and Add to draft opens the room', async ({ page }) => {
    await bootAreas(page, 'seed', { apps: [{ name: 'Hush', html: `<!doctype html><button id="go" onclick="uni.chat.draft('from hush')">go</button>`, interface: iface(ALL, 'hidden') }] });
    await openArea(page, 'Hush');
    await frame(page).locator('#go').click();
    const bar = page.locator('.area-main .suggestion-bar');
    await expect(bar).toContainText('from hush');
    await bar.getByRole('button', { name: 'Add to draft' }).click();
    await expect(composer(page, 'Techne')).toHaveValue('from hush');
    await expect(page.locator('.conversation-header')).toContainText('Techne');
  });
});

test.describe('screenshots', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test.describe(scheme, () => {
      test.use({ colorScheme: scheme });
      test(`techne and unforced, ${scheme}`, async ({ page }, info) => {
        await bootAreas(page, 'seed');
        await mkdir('shots/t75', { recursive: true });
        await openArea(page, 'Techne');
        await expect(frame(page).locator('#latest-body')).toContainText('Ship Techne first');
        await page.screenshot({ path: `shots/t75/${info.project.name}-${scheme}-techne.png` });
        if (!isDesktop(page)) { await page.locator('.sheet-peek').click(); await expect(composer(page, 'Techne')).toBeVisible(); await page.screenshot({ path: `shots/t75/${info.project.name}-${scheme}-techne-open.png` }); }
        await page.locator('.area-bar .note-back').click();
        await openArea(page, 'Unforced Development');
        await expect(frame(page).locator('#s-msgs')).toContainText('2');
        await page.screenshot({ path: `shots/t75/${info.project.name}-${scheme}-unforced.png` });
        await page.locator('.area-bar .note-back').click();
        await openArea(page, 'Sanctum');
        await expect(page.locator('.area-chat')).toContainText('Sat twenty minutes');
        await page.screenshot({ path: `shots/t75/${info.project.name}-${scheme}-default.png` });
      });
    });
  }
});

// T-75b P1-1: a running interface must not take keyboard focus from the host's chat composer and read what is typed.
// A frame can always focus itself from inside (window.focus()); the host takes the keyboard back and stops an app that does it again.
// The thief reports every key it hears through the host (a vault search), which is visible after the frame is gone.
const THIEF = `<!doctype html><html><body><input id="i"><script>
document.addEventListener('keydown', function (e) { uni.vault.queryNotes({ search: e.key }).catch(function () {}); });
setInterval(function () { document.getElementById('i').focus(); window.focus(); }, 5);
</script></body></html>`;
// An app that behaves: it logs the keys it is given and never asks for focus.
const POLITE = `<!doctype html><html><body><input id="i"><pre id="log"></pre><script>
var log = '';
document.addEventListener('keydown', function (e) { log += e.key; document.getElementById('log').textContent = log; });
</script></body></html>`;
const SECRET = 'my password is hunter2';
const heard = async (page: Page) => (await calls(page, 'vault_search')).map((c: any) => c.args.query).join('');

test.describe('focus stays in the chat', () => {
  test('an app that keeps taking the keyboard from the composer hears nothing and is stopped', async ({ page }) => {
    await bootAreas(page, 'seed', { granted: false, apps: [{ name: 'Thief', html: THIEF, interface: iface([{ 'vault.read': 'area' }], 'side') }] });
    await openArea(page, 'Thief');
    await page.getByRole('button', { name: 'Allow' }).click();
    await expect(frame(page).locator('#i')).toBeAttached();
    if (!isDesktop(page)) await page.locator('.sheet-peek').click();
    const box = composer(page, 'Techne');
    await box.click();
    // a person needs longer than this to start typing; the app has already tried, and been caught, by then
    await expect(page.locator('iframe.area-frame')).toHaveCount(0);
    await expect(page.locator('.area-quiet').filter({ hasText: 'kept taking the keyboard' })).toBeVisible();
    await page.keyboard.type(SECRET, { delay: 25 });
    await expect(box).toHaveValue(SECRET);
    expect(await heard(page), 'the app heard no key').toBe('');
  });

  test('a polite app: the composer keeps the keyboard while typing, and pressing on the app hands it over', async ({ page }) => {
    await bootAreas(page, 'seed', { granted: false, apps: [{ name: 'Polite', html: POLITE, interface: iface([{ 'vault.read': 'area' }], 'side') }] });
    await openArea(page, 'Polite');
    await page.getByRole('button', { name: 'Allow' }).click();
    await expect(frame(page).locator('#log')).toBeAttached();
    if (!isDesktop(page)) await page.locator('.sheet-peek').click();
    const box = composer(page, 'Techne');
    await box.click();
    await page.keyboard.type(SECRET, { delay: 10 });
    await expect(box).toHaveValue(SECRET);
    expect(await frame(page).locator('#log').textContent(), 'the frame heard no keys').toBe('');
    if (!isDesktop(page)) await page.locator('.sheet-peek').click(); // put the sheet down
    // a real press lands on the overlay above the frame (Playwright's click would refuse to hit it)
    const fb = (await page.locator('iframe.area-frame').boundingBox())!;
    await page.mouse.click(fb.x + 20, fb.y + 20);
    await page.waitForTimeout(100); // a person's next key is not within a frame of the press
    await page.keyboard.type('xyz', { delay: 25 });
    await expect(frame(page).locator('#log')).toHaveText('xyz');
    if (!isDesktop(page)) await page.locator('.sheet-peek').click();
    await expect(box).toHaveValue(SECRET);
  });
});

// T-75b P2-1: a suggestion from an interface in an area without a room still has somewhere to show.
test.describe('suggestions without a room', () => {
  test('the bar sits above the interface when the area has no room', async ({ page }) => {
    const OPEN = `<!doctype html><html><body><script>uni.note.open('Areas/NoRoom/Alpha').catch(function(){});</script></body></html>`;
    await bootAreas(page, 'seed', { granted: false, apps: [{ name: 'NoRoom', html: OPEN, channel: '', interface: iface([{ 'vault.read': 'area' }]) }] });
    await openArea(page, 'NoRoom');
    await page.getByRole('button', { name: 'Allow' }).click();
    await expect(page.locator('.area-chat')).toContainText('no room yet');
    await expect(page.locator('.suggestion-bar .suggestion')).toHaveCount(1);
    await expect(page.locator('.suggestion-bar .suggestion')).toBeVisible();
  });
});

test.describe('the area bar and the panes', () => {
  test('360 px: the bar is one row; Stop and Revoke are in a menu', async ({ page }) => {
    test.skip(isDesktop(page), 'phone only');
    await page.setViewportSize({ width: 360, height: 740 });
    await bootAreas(page, 'seed');
    await openArea(page, 'Techne');
    const bar = (await page.locator('.area-bar').boundingBox())!;
    expect(bar.height, 'one row').toBeLessThanOrEqual(60);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    await expect(page.getByRole('button', { name: 'Stop app' })).toBeHidden();
    await page.getByRole('button', { name: 'App controls' }).click();
    await expect(page.getByRole('button', { name: 'Stop app' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Revoke access' })).toBeVisible();
    await page.getByRole('button', { name: 'Stop app' }).click();
    await expect(page.locator('iframe.area-frame')).toHaveCount(0);
  });

  test('desktop: the panes are labelled App and Chat, drawn by Uni', async ({ page }) => {
    test.skip(!isDesktop(page), 'desktop only');
    await bootAreas(page, 'seed');
    await openArea(page, 'Techne');
    await expect(page.locator('.area-main .pane-label')).toHaveText('App');
    await expect(page.locator('.area-chat.side .pane-label')).toHaveText('Chat, drawn by Uni');
  });
});

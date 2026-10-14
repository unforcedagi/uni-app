// T-75, r14: an area includes its room. Its app is a view inside the room shell (r14: the side-by-side chat and the phone's pull-up sheet are
// gone): the same header and tree, "‹ Back to chat"; live messages reach the app; a suggestion's draft goes into the room's own composer.
import { mkdir } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import { bootAreas, openAreaPage, openAreasHome } from './areasFixture';

const openArea = async (page: Page, name: string) => { await openAreasHome(page); await openAreaPage(page, name); };
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

test.describe('the app is a view in the room shell', () => {
  test('the room comes first; "App ›" shows the app in the chat\'s place, with the same header and tree; Back to chat returns', async ({ page }) => {
    await bootAreas(page, 'seed');
    await openAreasHome(page);
    await openAreaPage(page, 'Techne', { app: false });
    await expect(page.locator('.sr-chat')).toBeVisible();
    await page.getByRole('button', { name: 'Open the Techne app' }).click();
    await expect(page.locator('.sr-work iframe.area-frame')).toHaveCount(1);
    await expect(page.locator('.sr-title')).toHaveText('Techne');
    if (isDesktop(page)) await expect(page.locator('.th-roomnav')).toBeVisible();
    await expect(page.locator('.area-chat, .area-tabs, .area-bar, .room-chips, .area-divider')).toHaveCount(0);
    await expect(page.locator('.sr-chat')).toHaveCount(0);
    await page.getByRole('button', { name: 'Back to chat' }).click();
    await expect(page.locator('iframe.area-frame')).toHaveCount(0);
    await expect(composer(page, 'Techne')).toBeVisible();
  });

  for (const hint of ['side', 'sheet', 'hidden']) test(`a manifest's chat layout hint (${hint}) no longer makes a second chat: the app is the same view`, async ({ page }) => {
    await bootAreas(page, 'seed', { apps: [{ name: 'Hint', html: '<!doctype html><p id="t">hi</p>', interface: iface(ALL, hint) }] });
    await openArea(page, 'Hint');
    await expect(frame(page).locator('#t')).toHaveText('hi');
    await expect(page.locator('.area-chat, .sheet-peek')).toHaveCount(0);
    await expect(page.locator('.sr-appbar')).toContainText('Hint app');
  });

  test('Escape and Alt+← close the app view before they change places', async ({ page }) => {
    await bootAreas(page, 'seed');
    await openArea(page, 'Techne');
    await expect(page.locator('.sr-work iframe.area-frame')).toHaveCount(1);
    await page.locator('.sr-appbar').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Alt+ArrowLeft');
    await expect(page.locator('iframe.area-frame')).toHaveCount(0);
    await expect(page.locator('.sr-title')).toHaveText('Techne');
  });

  test('an area with no room of its own talks in the room that holds it, and says so', async ({ page }) => {
    await bootAreas(page, 'seed');
    await openArea(page, 'Relationships');
    // r15: the real room is the heading; the area is a line under it
    await expect(page.locator('.sr-title')).toHaveText('Relationships'); // r20 (Codex 6): the node stays the heading
    await expect(page.locator('.sr-context')).toHaveText('Chat in #Uni · no room of its own yet');
    await expect(page.locator('.sr-chat').getByRole('textbox', { name: /^Message / })).toHaveAttribute('placeholder', 'Message #Uni'); // r13: the channel's own name
  });
});

test.describe('the room is the real room', () => {
  test('typing in the area\'s composer sends through the room view, with Send', async ({ page }) => {
    await bootAreas(page, 'seed');
    await openAreasHome(page);
    await openAreaPage(page, 'Techne', { app: false });
    await composer(page, 'Techne').fill('hello from the area');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect.poll(async () => (await calls(page, 'post_message')).length).toBe(1);
    const [call] = await calls(page, 'post_message');
    expect(call.args.channel).toBe('ch-techne'); expect(call.args.body).toBe('hello from the area');
  });

  test('the area restores with its room after a reload', async ({ page }) => {
    await bootAreas(page, 'seed');
    await openArea(page, 'Techne');
    await page.reload();
    await expect(page.locator('.sr-title')).toHaveText('Techne');
    await expect(composer(page, 'Techne')).toBeVisible();
    await expect(page.locator('.sr-chat .message-list')).toContainText('Run it on the laptop first.');
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
    // the room's own conversation has it too
    await page.getByRole('button', { name: 'Back to chat' }).click();
    await expect(page.locator('.sr-chat .message-list')).toContainText('the sheet works');
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
  test('the suggestion bar sits above the app; Add to draft fills the room\'s own composer and goes back to the chat; nothing is sent', async ({ page }, info) => {
    await bootAreas(page, 'seed');
    await openArea(page, 'Techne');
    const f = frame(page);
    await f.locator('#t').fill('Pairing on the bridge tonight');
    await f.locator('#go').click();
    const bar = page.locator('.area-app .suggestion-bar');
    await expect(bar).toBeVisible();
    await expect(bar).toContainText('Pairing on the bridge tonight');
    await mkdir('shots/t75', { recursive: true });
    await page.screenshot({ path: `shots/t75/${info.project.name}-suggestion.png` });
    await bar.getByRole('button', { name: 'Add to draft' }).click();
    await expect(page.locator('iframe.area-frame')).toHaveCount(0);
    await expect(composer(page, 'Techne')).toHaveValue('Pairing on the bridge tonight');
    expect(await calls(page, 'post_message')).toHaveLength(0);
    // a second suggestion goes after the draft
    await page.getByRole('button', { name: 'Open the Techne app' }).click();
    await f.locator('#t').fill('second thought'); await f.locator('#go').click();
    await page.locator('.area-app .suggestion-bar').getByRole('button', { name: 'Add to draft' }).click();
    await expect(composer(page, 'Techne')).toHaveValue('Pairing on the bridge tonight\n\nsecond thought');
  });

  test('the bar shows when the area has no room of its own', async ({ page }) => {
    const OPEN = `<!doctype html><html><body><script>uni.note.open('Areas/NoRoom/Alpha').catch(function(){});</script></body></html>`;
    await bootAreas(page, 'seed', { granted: false, apps: [{ name: 'NoRoom', html: OPEN, channel: '', interface: iface([{ 'vault.read': 'area' }]) }] });
    await openArea(page, 'NoRoom');
    await page.getByRole('button', { name: 'Allow' }).click();
    await expect(page.locator('.suggestion-bar .suggestion')).toHaveCount(1);
    await expect(page.locator('.suggestion-bar .suggestion')).toBeVisible();
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
        await page.getByRole('button', { name: 'Back to chat' }).click();
        await openArea(page, 'Unforced Development');
        await expect(frame(page).locator('#s-msgs')).toContainText('2');
        await page.screenshot({ path: `shots/t75/${info.project.name}-${scheme}-unforced.png` });
        await page.getByRole('button', { name: 'Back to chat' }).click();
        await openArea(page, 'Sanctum');
        await expect(page.locator('.sr-chat')).toContainText('Sat twenty minutes');
        await page.screenshot({ path: `shots/t75/${info.project.name}-${scheme}-default.png` });
      });
    });
  }
});

// T-75b P1-1, r14: a running app must never read what is typed in the chat. The app and the composer are never on screen together now:
// while the app shows there is no composer, and going back to the chat unmounts the app. The thief reports every key it hears.
const THIEF = `<!doctype html><html><body><input id="i"><script>
document.addEventListener('keydown', function (e) { uni.vault.queryNotes({ search: e.key }).catch(function () {}); });
setInterval(function () { document.getElementById('i').focus(); window.focus(); }, 5);
</script></body></html>`;
const SECRET = 'my password is hunter2';
const heard = async (page: Page) => (await calls(page, 'vault_search')).map((c: any) => c.args.query).join('');

test.describe('the app never hears the chat', () => {
  test('an app that grabs the keyboard is gone before the composer is back, and hears nothing typed there', async ({ page }) => {
    await bootAreas(page, 'seed', { granted: false, apps: [{ name: 'Thief', html: THIEF, interface: iface([{ 'vault.read': 'area' }]) }] });
    await openArea(page, 'Thief');
    await page.getByRole('button', { name: 'Allow' }).click();
    await expect(frame(page).locator('#i')).toBeAttached();
    await expect(page.locator('.sr-chat textarea')).toHaveCount(0);
    await page.getByRole('button', { name: 'Back to chat' }).click();
    await expect(page.locator('iframe.area-frame')).toHaveCount(0);
    const box = composer(page, 'Techne');
    await box.click();
    await page.keyboard.type(SECRET, { delay: 25 });
    await expect(box).toHaveValue(SECRET);
    expect(await heard(page), 'the app heard no key').toBe('');
  });
});

test.describe('the app bar', () => {
  test('360 px: one row; Stop and Revoke are in a menu', async ({ page }) => {
    test.skip(isDesktop(page), 'phone only');
    await page.setViewportSize({ width: 360, height: 740 });
    await bootAreas(page, 'seed');
    await openArea(page, 'Techne');
    const bar = (await page.locator('.sr-appbar').boundingBox())!;
    expect(bar.height, 'one row').toBeLessThanOrEqual(60);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    await expect(page.getByRole('button', { name: 'Stop app' })).toBeHidden();
    await page.getByRole('button', { name: 'App controls' }).click();
    await expect(page.getByRole('button', { name: 'Stop app' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Revoke access' })).toBeVisible();
    await page.getByRole('button', { name: 'Stop app' }).click();
    await expect(page.locator('iframe.area-frame')).toHaveCount(0);
  });
});

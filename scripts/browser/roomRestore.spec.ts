// T-294: Uni's rooms and Messages are two sides of one app, and each keeps its last place. In a room (T-335: in focus over All), over to
// Messages, and Back (0.2: there is no All tab; the system Back on Android, Alt+← on a desktop): the same room, at the same spot in the
// conversation, with the half-typed draft. The
// same after the app is put away and comes back (a hidden page shown again), and after the system closed it (a reload:
// the webview starts over from what the device kept). Messages keeps its own: the conversation open, and its draft.
// The rooms are the areas fixture's made-up ones; Messages' Rust door is faked (`messages_*`), with made-up people.
// Run: npx playwright test --config playwright.roomrestore.config.ts
import { test, expect, type Page } from '@playwright/test';
import { bootAreas, focusSheet, openDetails, openPlaces } from './areasFixture';
import { railGo } from './railGo';

const rail = (page: Page) => page.getByRole('navigation', { name: 'Main navigation' });
const chat = (page: Page) => focusSheet(page).locator('.sr-chat');
const list = (page: Page) => chat(page).locator('.message-list');
const composer = (page: Page) => chat(page).getByRole('textbox', { name: /^Message / });
const DRAFT = 'Half a thought about the map labels';

/** Messages' door, faked: signed in, two conversations; a thread opens with a few lines. */
async function fakeMessages(page: Page) {
  await page.addInitScript(() => {
    const w = window as any;
    const now = Date.now();
    const room = (id: string, name: string, preview: string) => ({ id, name, preview, preview_own: false, ts: now - 60_000, unread: 0, encrypted: true, invited: false, inviter: null, direct: true });
    const line = (i: number, roomId: string) => ({ key: `${roomId}-${i}`, event_id: `$${roomId}-${i}`, sender: '@sam:example.org', sender_name: 'Sam Example', own: false, ts: now - (10 - i) * 60_000, kind: 'text', body: `Line ${i + 1} from Sam`, state: 'remote', encrypted: true, edited: false });
    w.__extraInvoke = async (cmd: string, args: any) => {
      switch (cmd) {
        case 'messages_status': return { state: 'live', user_id: '@aaron:example.org', homeserver: 'https://matrix.example.org', error: null };
        case 'messages_rooms': return [room('!sam:example.org', 'Sam Example', 'See you then'), room('!kit:example.org', 'Kit Sample', 'Thanks!')];
        // Kit's conversation is long enough to read back in, and two more lines have come by the time it is opened again
        case 'messages_open': { const kit = args.roomId.startsWith('!kit'); const n = kit ? 40 + 2 * Math.min(w.__kitOpens = (w.__kitOpens ?? -1) + 1, 1) : 4; return Array.from({ length: n }, (_, i) => line(i, args.roomId)); }
        case 'messages_close': case 'messages_read': case 'messages_send': return null;
        default: return undefined;
      }
    };
  });
}

async function boot(page: Page) {
  await fakeMessages(page);
  await bootAreas(page, 'seed', { tree: true, atlas: true, longChat: true, pinned: true });
  // Messages joins the rail once its door has answered (a few seconds after start)
  await expect(rail(page).getByRole('button', { name: 'Messages', includeHidden: true })).toHaveCount(1, { timeout: 10_000 });
}

/** Open a room as a person does (T-335: in focus over All): ATLAS is inside Atlas, so the Atlas door, its details, and "Inside Atlas". */
async function openRoom(page: Page, name: string) {
  await page.locator('[data-place="front-door"]').waitFor();
  await openPlaces(page); // 0.2: the places are in the drawer under the home's head
  await page.locator('.fd-door[data-path="Areas/Atlas"]').click();
  await openDetails(page);
  await focusSheet(page).getByRole('region', { name: 'Inside Atlas' }).locator('.fx-place').filter({ has: page.locator('span', { hasText: new RegExp(`^${name}$`) }) }).click();
  await inFocus(page, name);
  await expect(chat(page)).toContainText('The newest line of this room.');
}
/** The room is in focus over All: All is the place, the room's sheet is in front. */
async function inFocus(page: Page, name: string) {
  await expect(focusSheet(page).locator('.all-focus-title')).toHaveText(name);
  await expect(page.locator('.all-surface[data-focus="open"]')).toBeVisible();
  // 0.2 one home: All is Uni's home, so the rail's Uni is the current place
  if ((page.viewportSize()?.width ?? 0) >= 600) await expect(rail(page).getByRole('button', { name: 'Uni', exact: true })).toHaveAttribute('aria-current', 'page');
}
/** 0.2: back to where you were on Uni's side: Android's Back (as the plugin delivers it) on a touch screen, Alt+← on a desktop. */
const toAll = async (page: Page) => {
  // (0.2: on a Mac the rail's Uni is the way back from a place; it brings back the room you left, kept on the device)
  if (test.info().project.name === 'mac') { await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Uni', exact: true }).click(); return; }
  await page.evaluate(() => { const w = window as any; w.__cbs[w.__backHandler.id]({ message: {}, index: w.__backIndex ?? 0 }); w.__backIndex = (w.__backIndex ?? 0) + 1; });
};

/** Where the reader is: the first message in sight and how far below the list's top edge it starts. */
const spot = (page: Page) => list(page).evaluate((el) => {
  const top = el.getBoundingClientRect().top;
  const first = [...el.querySelectorAll<HTMLElement>('[data-ref]')].find((m) => m.getBoundingClientRect().bottom > top + 1);
  return first ? { ref: first.dataset.ref!, offset: Math.round(first.getBoundingClientRect().top - top), fromEnd: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight) } : null;
});

/** Read back up the conversation, as a person would (the wheel), until well away from the newest message. */
async function readBack(page: Page) {
  const box = (await list(page).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(400);
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -500); await page.waitForTimeout(60); }
  await expect.poll(async () => (await spot(page))?.fromEnd ?? 0).toBeGreaterThan(1200);
  await page.waitForTimeout(300);
  return (await spot(page))!;
}

/** The same room, the same message first in sight (within a few pixels), the draft as it was. */
async function expectSamePlace(page: Page, was: { ref: string; offset: number }) {
  await inFocus(page, 'ATLAS');
  await expect(composer(page)).toHaveValue(DRAFT);
  await expect.poll(async () => (await spot(page))?.ref).toBe(was.ref);
  expect(Math.abs((await spot(page))!.offset - was.offset)).toBeLessThan(8);
}

/** The app put away (hidden) or brought back (shown), as the Android WebView reports it. */
const flip = (page: Page, state: 'hidden' | 'visible') => page.evaluate((s) => {
  Object.defineProperty(document, 'visibilityState', { value: s, configurable: true });
  Object.defineProperty(document, 'hidden', { value: s === 'hidden', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}, state);

async function inRoomWithDraft(page: Page) {
  await openRoom(page, 'ATLAS');
  await composer(page).fill(DRAFT);
  // done typing: the keyboard goes (on a phone the bottom bar comes back with it)
  await composer(page).blur();
  return readBack(page);
}
const messagesView = (page: Page) => page.locator('section.msgs');

test.describe('T-294 back to the room you were in', () => {
  test('a room in focus, Messages, then Back: the same room, at the same spot, with the draft', async ({ page }) => {
    await boot(page);
    const was = await inRoomWithDraft(page);
    await railGo(page, 'Messages');
    await expect(page.getByRole('navigation', { name: 'Conversations' })).toBeVisible();
    await toAll(page);
    await expectSamePlace(page, was);
  });

  // 0.2: the rail's places have no Back pill; the system Back is the way back
  test('Messages has no Back of its own; Back goes to the room in focus, at its spot', async ({ page }) => {
    await boot(page);
    const was = await inRoomWithDraft(page);
    await railGo(page, 'Messages');
    await expect(page.getByRole('navigation', { name: 'Conversations' })).toBeVisible();
    await expect(messagesView(page).getByRole('button', { name: /^(←|‹)/ })).toHaveCount(0);
    await toAll(page);
    await expectSamePlace(page, was);
  });

  test('with a room in focus, the Uni button still goes home to Uni', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'ATLAS');
    await rail(page).getByRole('button', { name: 'Uni', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Uni', level: 1 })).toBeVisible();
    await expect(focusSheet(page)).toHaveCount(0);
  });

  test('put away and brought back (hidden, then shown): still the room, its spot and the draft', async ({ page }) => {
    await boot(page);
    const was = await inRoomWithDraft(page);
    await flip(page, 'hidden');
    await page.waitForTimeout(300);
    await flip(page, 'visible');
    await page.waitForTimeout(1200);
    await expectSamePlace(page, was);
  });

  test('closed by the system in the room (a reload): it reopens in the room, at the spot, with the draft', async ({ page }) => {
    await boot(page);
    const was = await inRoomWithDraft(page);
    await flip(page, 'hidden');
    await page.reload();
    await expectSamePlace(page, was);
  });

  test('closed by the system in Messages (a reload): Messages reopens, and Back goes to the room, at the spot, with the draft', async ({ page }) => {
    await boot(page);
    const was = await inRoomWithDraft(page);
    await railGo(page, 'Messages');
    await expect(page.getByRole('navigation', { name: 'Conversations' })).toBeVisible();
    await flip(page, 'hidden');
    await page.reload();
    await expect(messagesView(page)).toBeVisible();
    await expect(rail(page).getByRole('button', { name: 'Messages', includeHidden: true })).toHaveCount(1, { timeout: 10_000 });
    await toAll(page);
    await expectSamePlace(page, was);
  });

  test('Messages keeps its own place: the conversation open, its draft and how far back it was read, across a trip back to the room', async ({ page }) => {
    await boot(page);
    await openRoom(page, 'ATLAS');
    await railGo(page, 'Messages');
    await page.getByRole('navigation', { name: 'Conversations' }).getByRole('button', { name: /Kit Sample/ }).click();
    const box = page.getByRole('textbox', { name: 'Message Kit Sample' });
    await box.fill('Running ten minutes late');
    await box.blur();
    const log = page.getByRole('log', { name: 'Messages with Kit Sample' });
    await expect(log).toContainText('Line 40 from Sam');
    const fromEnd = () => log.evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight));
    /** The first message in sight, and how far below the top it starts. */
    const reading = () => log.evaluate((el) => { const top = el.getBoundingClientRect().top; const m = [...el.querySelectorAll<HTMLElement>('[data-key]')].find((x) => x.getBoundingClientRect().bottom > top + 1)!; return { key: m.dataset.key, offset: Math.round(m.getBoundingClientRect().top - top) }; });
    const box2 = (await log.boundingBox())!;
    await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2);
    for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, -200); await page.waitForTimeout(60); }
    await expect.poll(fromEnd).toBeGreaterThan(300);
    await page.waitForTimeout(200);
    const left = await reading();
    await toAll(page);
    await inFocus(page, 'ATLAS');
    await railGo(page, 'Messages');
    await expect(page.getByRole('region', { name: 'Conversation: Kit Sample' })).toBeVisible();
    await expect(box).toHaveValue('Running ten minutes late');
    // back at the message it was read to, though two newer lines came in meanwhile
    await expect(log).toContainText('Line 42 from Sam');
    const now = await reading();
    expect(now.key).toBe(left.key);
    expect(Math.abs(now.offset - left.offset)).toBeLessThan(8);
  });
});

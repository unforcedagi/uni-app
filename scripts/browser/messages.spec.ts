// T-278 Messages, end to end: two people on a real Matrix homeserver, each signed in through the app's own sign-in
// form, in an end-to-end encrypted room. A sends from the composer; B, looking at the conversation, sees it arrive
// without reloading. Between them: the app's UI, the Rust core (crates/uni-messages) through the dev bridge, and the
// homeserver; nothing is mocked but the shell's hub-facing startup commands.
//
// Needs a homeserver and two accounts (made-up people), never real ones:
//   MESSAGES_HS          the homeserver, default http://127.0.0.1:8278
//   MESSAGES_USERS_FILE  JSON {"a": {"user_id", "password", "display"}, "b": {...}}, kept outside the repo (mode 0600)
// Run: MESSAGES_USERS_FILE=… npx playwright test --config playwright.messages.config.ts
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { boot, type Bridge } from './messagesBridge';

type Account = { user_id: string; password: string; display: string };
const HS = process.env.MESSAGES_HS || 'http://127.0.0.1:8278';
const usersFile = process.env.MESSAGES_USERS_FILE;
const users: { a: Account; b: Account } | null = usersFile ? JSON.parse(readFileSync(usersFile, 'utf8')) : null;
const bridge: Bridge = { url: process.env.MESSAGES_BRIDGE_URL!, token: process.env.MESSAGES_BRIDGE_TOKEN! };

/** The client-server API, for the test's own setup (a room to talk in); the app's side goes through the UI only. */
async function api(method: string, path: string, body?: unknown, token?: string) {
  const r = await fetch(`${HS}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${json.errcode ?? ''}`);
  return json;
}
const login = async (a: Account) => (await api('POST', '/_matrix/client/v3/login', { type: 'm.login.password', identifier: { type: 'm.id.user', user: a.user_id }, password: a.password, initial_device_display_name: 'T-278 test setup' })).access_token as string;

async function signIn(page: Page, a: Account) {
  const form = page.getByRole('form', { name: 'Sign in to Messages' });
  await form.getByLabel('Homeserver').fill(HS);
  await form.getByLabel('Username').fill(a.user_id);
  await form.getByLabel('Password').fill(a.password);
  await form.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Conversations' })).toBeVisible({ timeout: 30_000 });
}

const conversation = (page: Page, name: string) => page.getByRole('region', { name: `Conversation: ${name}` });
const log = (page: Page, name: string) => page.getByRole('log', { name: `Messages with ${name}` });

/** Open a fresh room and wait until it has finished opening (its empty state), so anything later can only arrive live. */
async function openRoom(page: Page, name: string) {
  await page.getByRole('navigation', { name: 'Conversations' }).getByRole('button', { name: new RegExp(name) }).click({ timeout: 30_000 });
  await expect(conversation(page, name)).toBeVisible();
  await expect(log(page, name).getByText('No messages yet. Say hello.')).toBeVisible({ timeout: 20_000 });
}

test.describe('T-278 Messages on a live homeserver', () => {
  test.skip(!users, 'needs MESSAGES_USERS_FILE and a running homeserver (see the header)');

  test('a message A sends arrives live for B, end-to-end encrypted', async ({ browser }, info) => {
    const run = `${Date.now().toString(36)}-${info.project.name}`;
    const room = `Test chat ${run}`;
    const text = `Hello from A, ${run}`;
    // the room: encrypted from the start, B invited and joined
    const ta = await login(users!.a), tb = await login(users!.b);
    const { room_id } = await api('POST', '/_matrix/client/v3/createRoom', {
      name: room, preset: 'private_chat', invite: [users!.b.user_id],
      initial_state: [{ type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } }],
    }, ta);
    await api('POST', `/_matrix/client/v3/join/${encodeURIComponent(room_id)}`, {}, tb);

    const ctxA = await browser.newContext(), ctxB = await browser.newContext();
    const a = await ctxA.newPage(), b = await ctxB.newPage();
    try {
      await boot(a, 'a', bridge);
      await boot(b, 'b', bridge);
      await signIn(a, users!.a);
      await signIn(b, users!.b);

      // B is looking at the conversation, finished opening, before anything is sent
      await openRoom(b, room);

      await openRoom(a, room);
      const draft = conversation(a, room).getByRole('textbox', { name: `Message ${room}` });
      await draft.fill(text);
      // a keyboard's Enter sends; a touch screen's Enter is a new line, so it taps Send
      if (info.project.use.hasTouch) await conversation(a, room).getByRole('button', { name: 'Send' }).click();
      else await draft.press('Enter');
      await expect(draft).toHaveValue('');
      await expect(log(a, room)).toContainText(text);
      await expect(log(a, room).getByText('Sent', { exact: true })).toBeVisible({ timeout: 20_000 });

      // live receive: it arrives on B's open conversation, from A, decrypted on B's device
      const arrived = log(b, room).locator('.msgs-msg', { hasText: text });
      await expect(arrived).toBeVisible({ timeout: 20_000 });
      await expect(arrived).toHaveAttribute('data-encrypted', 'true');
      await expect(arrived.locator('.msgs-from strong')).toHaveText(users!.a.display);
      await expect(conversation(b, room).getByText('ENCRYPTED', { exact: true })).toBeVisible();
      await expect(conversation(b, room).getByText("Uni can't read this conversation.")).toBeVisible();
    } finally {
      // leave no devices behind: signing out removes each test device on the homeserver
      for (const p of [a, b]) await p.getByRole('button', { name: 'Sign out' }).click({ timeout: 5_000 }).catch(() => {});
      await expect(a.getByRole('form', { name: 'Sign in to Messages' })).toBeVisible().catch(() => {});
      await expect(b.getByRole('form', { name: 'Sign in to Messages' })).toBeVisible().catch(() => {});
      await ctxA.close(); await ctxB.close();
      for (const t of [ta, tb]) await api('POST', '/_matrix/client/v3/logout', {}, t).catch(() => {});
    }
  });
});

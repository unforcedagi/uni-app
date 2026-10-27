// T-282 Messages, "Link an account", end to end against the live bridges on a real homeserver: a throwaway account
// signs in through the app's own form, opens the Link screen, and for each network reaches its bridge's real login
// prompt (a QR from Signal's and WhatsApp's servers, Google's cookie step, Messenger's and Instagram's username field),
// then cancels. No login is completed and nothing is typed into a real service's field. Between the test and the
// bridges: the app's UI, the Rust core (crates/uni-messages, link.rs) through the dev bridge, and the homeserver.
//
// Needs, never real accounts:
//   MESSAGES_LINK_HS        the homeserver, default http://127.0.0.1:8008
//   MESSAGES_LINK_USER_FILE JSON {"user_id", "password"} of a throwaway account the bridges allow, outside the repo
//   MESSAGES_TELEGRAM       "running" once the Telegram bridge has its keys; otherwise its card must say NOT RUNNING
// Run: MESSAGES_LINK_USER_FILE=… npx playwright test --config playwright.messages.config.ts messagesLink
import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { boot, type Bridge } from './messagesBridge';

const HS = process.env.MESSAGES_LINK_HS || 'http://127.0.0.1:8008';
const userFile = process.env.MESSAGES_LINK_USER_FILE;
const user: { user_id: string; password: string } | null = userFile ? JSON.parse(readFileSync(userFile, 'utf8')) : null;
const bridge: Bridge = { url: process.env.MESSAGES_BRIDGE_URL!, token: process.env.MESSAGES_BRIDGE_TOKEN! };
const telegramRunning = process.env.MESSAGES_TELEGRAM === 'running';

const card = (page: Page, name: string) => page.getByRole('region', { name: 'Link an account' }).getByRole('listitem', { name, exact: true });
const tag = (c: Locator) => c.locator('.msgs-link-tag');

/** Cancel and wait until the card is back to its resting state. */
async function cancel(c: Locator) {
  await c.getByRole('button', { name: 'Cancel' }).click();
  await expect(c.getByRole('button', { name: /^Link/ })).toBeVisible({ timeout: 20_000 });
}

/** A QR the app drew: an SVG of the bridge's code with dark modules in it. */
async function expectQr(c: Locator, name: string) {
  const qr = c.getByRole('img', { name: `QR code to link ${name}` });
  await expect(qr).toBeVisible({ timeout: 45_000 });
  expect((await qr.locator('path').getAttribute('d'))?.length ?? 0).toBeGreaterThan(500);
}

test.describe('T-282 Link an account, on the live bridges', () => {
  test.skip(!user, 'needs MESSAGES_LINK_USER_FILE and the live homeserver and bridges (see the header)');

  test('each bridge reaches its real login prompt, and cancels', async ({ page }, info) => {
    test.setTimeout(300_000);
    const phone = !!info.project.use.isMobile;
    await boot(page, `link-${info.project.name}`, bridge);
    const form = page.getByRole('form', { name: 'Sign in to Messages' });
    await form.getByLabel('Homeserver').fill(HS);
    await form.getByLabel('Username').fill(user!.user_id);
    await form.getByLabel('Password').fill(user!.password);
    await form.getByRole('button', { name: 'Sign in' }).click();
    const list = page.getByRole('navigation', { name: 'Conversations' });
    await expect(list).toBeVisible({ timeout: 30_000 });
    try {
      // the bots' DMs are linking, not conversations: none is listed (their names are "<Network> bridge")
      await expect(list.getByText(/No conversations yet\.|Pick a conversation\./).or(list.getByRole('list')).first()).toBeVisible({ timeout: 20_000 });
      await expect(list.getByRole('button', { name: /bridge/i })).toHaveCount(0);

      await page.getByRole('button', { name: 'Link another network' }).or(list.getByRole('button', { name: 'Link an account' })).first().click();
      // (now that the cards have asked every bot, the list still holds no bot DM: checked again on the way back)
      const screen = page.getByRole('region', { name: 'Link an account' });
      await expect(screen).toBeVisible();
      for (const n of ['Signal', 'Telegram', 'WhatsApp', 'Google Messages', 'Messenger', 'Instagram']) await expect(card(page, n)).toBeVisible();

      // every running bridge answers what is linked: nothing, for a throwaway account
      for (const n of ['Signal', 'WhatsApp', 'Google Messages', 'Messenger', 'Instagram']) await expect(tag(card(page, n))).toHaveText('NOT LINKED', { timeout: 60_000 });

      // Signal: one way in, a QR to scan in Signal's Linked devices
      const signal = card(page, 'Signal');
      await signal.getByRole('button', { name: 'Link', exact: true }).click();
      await expectQr(signal, 'Signal');
      await expect(signal.getByText('Scan the QR code on your Signal app to log in')).toBeVisible();
      await cancel(signal);
      await expect(signal.getByRole('img', { name: /QR code/ })).toHaveCount(0);

      // WhatsApp: two ways in; the QR
      const wa = card(page, 'WhatsApp');
      await wa.getByRole('button', { name: 'Link', exact: true }).click();
      await wa.getByRole('button', { name: /Scan a QR code/ }).click({ timeout: 30_000 });
      await expectQr(wa, 'WhatsApp');
      await cancel(wa);

      // Google Messages: Google's sign-in, as cookies from a browser (the bridge's only way in now)
      const gm = card(page, 'Google Messages');
      await gm.getByRole('button', { name: 'Link', exact: true }).click();
      await expect(gm.getByLabel('cURL command or cookies (JSON)')).toBeVisible({ timeout: 30_000 });
      await expect(gm.getByRole('link', { name: 'accounts.google.com' })).toBeVisible();
      await cancel(gm);

      // Messenger: the username and password way in, up to its first field
      const fb = card(page, 'Messenger');
      await fb.getByRole('button', { name: 'Link', exact: true }).click();
      await fb.getByRole('button', { name: /username\/password using Messenger iOS API/ }).click({ timeout: 30_000 });
      await expect(fb.getByLabel('Username or email address')).toBeVisible({ timeout: 30_000 });
      await cancel(fb);

      // Instagram: its own bridge (mautrix-instagram), up to its first field
      const ig = card(page, 'Instagram');
      await ig.getByRole('button', { name: 'Link', exact: true }).click();
      await ig.getByRole('button', { name: /Instagram Android API/ }).click({ timeout: 30_000 });
      await expect(ig.getByLabel('Email or username')).toBeVisible({ timeout: 30_000 });
      await cancel(ig);

      // Telegram: its phone-number prompt once the bridge has Aaron's keys; until then the card says why it can't
      const tg = card(page, 'Telegram');
      if (telegramRunning) {
        await expect(tag(tg)).toHaveText('NOT LINKED', { timeout: 60_000 });
        await tg.getByRole('button', { name: 'Link', exact: true }).click();
        await tg.getByRole('button', { name: /phone/i }).first().click({ timeout: 30_000 });
        await expect(tg.getByLabel(/Phone number/)).toBeVisible({ timeout: 30_000 });
        await cancel(tg);
      } else {
        await expect(tag(tg)).toHaveText('NOT RUNNING', { timeout: 60_000 });
        await expect(tg.getByText(/needs a key you make at my\.telegram\.org/)).toBeVisible();
        // the keys go to the door on the box, which starts the bridge (not sent here: the dev bridge has no device key)
        const keys = tg.getByRole('form', { name: 'Telegram app keys' });
        await expect(keys.getByLabel('api_id')).toBeVisible();
        await expect(keys.getByLabel('api_hash')).toBeVisible();
      }

      // and back to the conversations: still no bot DM among them, now that every bot has one
      await screen.getByRole('button', { name: '← Conversations' }).click();
      await expect(list.getByRole('button', { name: /bridge/i })).toHaveCount(0);
      await expect(phone ? list : page.getByText('Pick a conversation.')).toBeVisible();
    } finally {
      // leave no device behind, and no login under way
      for (const n of ['signal', 'whatsapp', 'gmessages', 'messenger', 'instagram']) {
        await page.evaluate((network) => (window as any).__TAURI_INTERNALS__.invoke('messages_link_cancel', { network }).catch(() => {}), n).catch(() => {});
      }
      await page.getByRole('button', { name: 'Sign out' }).click({ timeout: 5_000 }).catch(() => {});
      await expect(form).toBeVisible().catch(() => {});
    }
  });
});

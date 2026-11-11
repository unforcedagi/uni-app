import { test, expect, type Page } from '@playwright/test';
import { bar, openApplet } from './shapeNav';

async function boot(page: Page, fixture = 'five', query = '') {
  await page.addInitScript(() => {
    const w = window as any;
    w.__calls = [];
    const fixture = new URLSearchParams(location.search).get('vaultFixture');
    if (new URLSearchParams(location.search).get('brokenStorage')) {
      Storage.prototype.getItem = () => { throw new Error('denied'); };
      Storage.prototype.setItem = () => { throw new Error('denied'); };
    }
    const names = fixture === 'many' ? ['uni', ...Array.from({ length: 20 }, (_, i) => `vault-${String(i + 1).padStart(2, '0')}`)]
      : fixture === 'without-uni'
      ? ['parachute', 'unforced'] : new URLSearchParams(location.search).get('vaultFixture') === 'empty'
      ? [] : ['parachute', 'scope-test', 'unforced', 'uni', 'uni-1'];
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: () => 1,
      invoke: async (cmd: string, args: any) => {
        w.__calls.push({ cmd, args });
        switch (cmd) {
          case 'identity_status': return { paired: true, pubkey: 'a'.repeat(64) };
          case 'get_identity': return 'a'.repeat(64);
          case 'get_npub': return 'test';
          case 'get_rooms': return [{ id: 'test', name: 'Test room', unread: 0 }];
          case 'get_members': case 'get_messages': return [];
          case 'vault_list': return names;
          case 'vault_paths': case 'vault_search': case 'search': return [];
          case 'journal_config': return { hub: 'test' };
          case 'refresh': return { total_items: 0, channel_errors: {}, truncated_channels: [] };
          default: return null;
        }
      },
    };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  });
  await page.goto(`/?vaultFixture=${fixture}${query}`);
  // the Vault applet, from the drawer: with several vaults it shows the chooser inside its frame
  await openVault(page);
}

async function openVault(page: Page) {
  await openApplet(page, 'Vault');
  await expect(page.locator('.sh-ap-frame').getByRole('region', { name: 'Vaults' })).toBeVisible();
}

function vaultButton(page: Page, name: string) {
  return page.getByRole('region', { name: 'Vaults' }).locator('button.room').filter({ has: page.locator('strong').filter({ hasText: new RegExp(`^${name}$`) }) });
}

for (const fixture of ['five', 'without-uni', 'empty']) {
  test(`${fixture}: primary and other vaults are accurate and reachable`, async ({ page }) => {
    await boot(page, fixture);
    const vaults = page.getByRole('region', { name: 'Vaults' });
    const primary = vaultButton(page, 'uni');
    const toggle = vaults.getByRole('button', { name: /^Other vaults \(/ });
    if (fixture === 'empty') {
      await expect(primary).toHaveCount(0);
      await expect(toggle).toHaveCount(0);
      return;
    }
    await expect(primary).toHaveCount(fixture === 'five' ? 1 : 0);
    await expect(toggle).toHaveText(`Other vaults (${fixture === 'five' ? 4 : 2})`);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(vaultButton(page, 'parachute')).toBeHidden();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(vaultButton(page, 'parachute')).toBeVisible();
    if (fixture === 'five') {
      for (const name of ['scope-test', 'unforced', 'uni-1']) await expect(vaultButton(page, name)).toBeVisible();
    }
    await vaultButton(page, 'parachute').click();
    // the chooser gives way to the vault, in the same frame, named for it
    await expect(page.getByRole('region', { name: 'Vault parachute' })).toBeVisible();
    await expect(page.locator('.sh-ap-top h1')).toHaveText('parachute');
  });
}

test('Other vault expansion survives reload and remains keyboard operable', async ({ page }) => {
  await boot(page);
  const vaults = page.getByRole('region', { name: 'Vaults' });
  const toggle = vaults.getByRole('button', { name: 'Other vaults (4)' });
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await page.reload();
  await openVault(page);
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await toggle.focus();
  await page.keyboard.press('Space');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await page.reload();
  await openVault(page);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
});

test('Twenty other vaults stay reachable inside the viewport and targets are 44px', async ({ page }) => {
  await boot(page, 'many');
  const toggle = page.getByRole('region', { name: 'Vaults' }).getByRole('button', { name: 'Other vaults (20)' });
  expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await toggle.click();
  const list = page.locator('#other-vault-list');
  // The list is long; the frame around it must not spill past the viewport (the frame scrolls, not the page).
  const frame = page.locator('.sh-ap-frame');
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1)).toBe(true);
  const scroller = await list.evaluateHandle((el) => { for (let n: HTMLElement | null = el; n; n = n.parentElement) if (n.scrollHeight > n.clientHeight + 1 && getComputedStyle(n).overflowY !== 'visible') return n; return el; });
  expect(await scroller.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  const last = vaultButton(page, 'vault-20');
  const box = (await last.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  expect(box.height).toBeGreaterThanOrEqual(44);
  await last.click();
  await expect(page.getByRole('region', { name: 'Vault vault-20' })).toBeVisible();
  await expect(frame.getByRole('region', { name: 'Vaults' })).toBeHidden();
});

test('Unavailable storage leaves vaults collapsed but operable', async ({ page }) => {
  await boot(page, 'five', '&brokenStorage=1');
  const toggle = page.getByRole('region', { name: 'Vaults' }).getByRole('button', { name: 'Other vaults (4)' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(vaultButton(page, 'uni-1')).toBeVisible();
});

test('Search still reaches every vault from home, and from inside a vault stays in that vault', async ({ page }) => {
  await boot(page);
  // there is no vault picker any more: the scope is where you are
  const calls = (cmd: string) => page.evaluate((c) => (window as any).__calls.filter((x: any) => x.cmd === c).map((x: any) => x.args), cmd);
  await bar(page).getByRole('button', { name: /^Rooms/ }).click();
  await page.keyboard.press('Control+k');
  const search = page.getByRole('region', { name: 'Search' });
  await expect(search).toBeVisible();
  await expect(search.locator('select')).toHaveCount(0);
  await search.getByRole('searchbox').fill('garden');
  // from home the notes are searched across every vault the hub holds: no vault named
  await expect.poll(async () => (await calls('vault_search')).map((a: any) => a.vault)).toContain(null);
  await page.keyboard.press('Escape');
  // from inside a vault the same search is that vault's
  await openVault(page);
  const toggle = page.getByRole('button', { name: 'Other vaults (4)' });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await vaultButton(page, 'parachute').click();
  await expect(page.getByRole('region', { name: 'Vault parachute' })).toBeVisible();
  await page.keyboard.press('Control+k');
  await expect(search).toBeVisible();
  await search.getByRole('searchbox').fill('orchard');
  await expect.poll(async () => (await calls('vault_search')).filter((a: any) => a.query === 'orchard').map((a: any) => a.vault)).toContain('parachute');
});

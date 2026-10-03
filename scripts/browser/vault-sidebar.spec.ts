import { test, expect, type Page } from '@playwright/test';

async function boot(page: Page, fixture = 'five', query = '') {
  await page.addInitScript(() => {
    const w = window as any;
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
      invoke: async (cmd: string) => {
        switch (cmd) {
          case 'identity_status': return { paired: true, pubkey: 'a'.repeat(64) };
          case 'get_identity': return 'a'.repeat(64);
          case 'get_npub': return 'test';
          case 'get_rooms': return [{ id: 'test', name: 'Test room', unread: 0 }];
          case 'get_members': case 'get_messages': return [];
          case 'vault_list': return names;
          case 'vault_paths': return [];
          case 'journal_config': return { hub: 'test' };
          case 'refresh': return { total_items: 0, channel_errors: {}, truncated_channels: [] };
          default: return null;
        }
      },
    };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  });
  await page.goto(`/?vaultFixture=${fixture}${query}`);
  if (test.info().project.name === 'phone-390') await page.getByRole('button', { name: 'Back to conversations' }).click();
  if (test.info().project.name !== 'phone-390') await page.getByRole('button', { name: 'Vault', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Vaults' })).toBeVisible();
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
    if (test.info().project.name === 'phone-390') await expect(page.getByRole('region', { name: 'Vault parachute' })).toBeVisible();
    else {
      await page.getByRole('button', { name: 'Vault', exact: true }).click();
      await expect(vaultButton(page, 'parachute')).toHaveClass(/selected/);
      await toggle.click();
      await expect(toggle).toHaveClass(/selected/);
      await expect(toggle).toHaveAccessibleName(`Other vaults (${fixture === 'five' ? 4 : 2}), current vault parachute`);
    }
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
  if (test.info().project.name === 'phone-390') await page.getByRole('button', { name: 'Back to conversations' }).click();
  if (test.info().project.name !== 'phone-390') await page.getByRole('button', { name: 'Vault', exact: true }).click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await toggle.focus();
  await page.keyboard.press('Space');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await page.reload();
  if (test.info().project.name === 'phone-390') await page.getByRole('button', { name: 'Back to conversations' }).click();
  if (test.info().project.name !== 'phone-390') await page.getByRole('button', { name: 'Vault', exact: true }).click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
});

test('Twenty other vaults stay reachable inside the viewport and targets are 44px', async ({ page }) => {
  await boot(page, 'many');
  const toggle = page.getByRole('region', { name: 'Vaults' }).getByRole('button', { name: 'Other vaults (20)' });
  expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await toggle.click();
  const list = page.locator('#other-vault-list');
  // The list itself must scroll; the sidebar around it must not overflow (the shell clips it).
  expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  for (const sel of ['.rooms', '.rooms-body']) {
    expect(await page.locator(sel).evaluate((el) => el.scrollHeight <= el.clientHeight + 1), sel).toBe(true);
  }
  await list.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  const last = vaultButton(page, 'vault-20');
  const box = (await last.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await last.click();
  if (test.info().project.name === 'phone-390') await expect(page.getByRole('region', { name: 'Vault vault-20' })).toBeVisible();
  else {
    await expect(page.getByRole('region', { name: 'Vault vault-20' })).toBeVisible();
    await expect(page.locator('.rooms')).toBeHidden();
  }
});

test('Unavailable storage leaves vaults collapsed but operable', async ({ page }) => {
  await boot(page, 'five', '&brokenStorage=1');
  const toggle = page.getByRole('region', { name: 'Vaults' }).getByRole('button', { name: 'Other vaults (4)' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(vaultButton(page, 'uni-1')).toBeVisible();
});

test('Search still reaches every vault', async ({ page }) => {
  await boot(page);
  await page.getByRole('button', { name: 'Search messages and notes' }).click();
  const options = await page.locator('select option').allTextContents();
  for (const name of ['parachute', 'scope-test', 'unforced', 'uni', 'uni-1']) expect(options).toContain(name);
});

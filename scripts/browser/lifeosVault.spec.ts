// Acceptance for profile PRs 1-6: the app opens a fresh scratch vault that has only the life-os pack.
// Needs a running scratch vault: SV_ENV=<env.json>. Run: pnpm exec playwright test --config playwright.lifeos-vault.config.ts
import { mkdir } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import { bootAnyVault, resetSeed, scratchEnv } from './lifeosAnyVault';

const SHOTS = process.env.SHOTS_DIR ?? 'scripts/browser/__shots__/lifeos-any-vault';
const shot = async (page: Page, name: string, tasks = false) => { await mkdir(SHOTS, { recursive: true }); if (tasks) { await page.getByRole('region', { name: 'What needs doing here' }).scrollIntoViewIfNeeded(); await page.evaluate(() => document.querySelector('[aria-label="What needs doing here"]')?.scrollIntoView({ block: 'start' })); await page.waitForTimeout(150); } const s = page.viewportSize()!; await page.screenshot({ path: `${SHOTS}/${name}-${s.width}x${s.height}.png` }); };
const card = (page: Page, name: string) => page.locator(`.node-arm[data-name="${name}"]`);
const titles = (page: Page) => page.locator('.task-row .task-title');
const calls = (page: Page, cmd: string) => page.evaluate((c) => (window as any).__calls.filter((x: any) => x.cmd === c).map((x: any) => x.args), cmd);

test('scratch life-os vault: tree, node with tasks, check-off, clean console, no Uni glue', async ({ page }) => {
  await resetSeed(scratchEnv());
  const { errors } = await bootAnyVault(page, { savedVault: 'lifeos' });
  await expect(card(page, 'Health')).toBeVisible();
  await expect(card(page, 'Work')).toBeVisible();
  await expect(page.getByRole('button', { name: 'For you' })).toHaveCount(0);
  await shot(page, 'tree');
  await card(page, 'Work').click();
  await expect(page.getByRole('heading', { name: 'Work', level: 1 })).toBeVisible();
  await expect(card(page, 'Launch')).toBeVisible();
  // Work + Launch: waiting review (me), release notes (agent), tag the build (me)
  await expect(titles(page)).toHaveCount(3);
  await expect(page.locator('.work-group').filter({ has: page.getByRole('heading', { name: 'You' }) }).locator('.task-title')).toHaveText(['Review the contract', 'Tag the build']);
  await expect(page.locator('.work-group').filter({ has: page.getByRole('heading', { name: 'Rooms' }) }).locator('.task-title')).toHaveText(['Write release notes']);
  await shot(page, 'node-with-tasks', true);
  const row = page.locator('.task-row').filter({ hasText: 'Tag the build' });
  await row.getByRole('button', { name: /done/i }).first().click();
  await expect(titles(page).filter({ hasText: 'Tag the build' })).toHaveCount(0);
  await expect(page.locator('.undo-bar, [role="status"]').filter({ hasText: /Marked done/ })).toBeVisible();
  const t = await calls(page, 'vault_transition');
  expect(t).toHaveLength(1); expect(t[0]).toMatchObject({ vault: 'lifeos', from: 'open', to: 'done' });
  await shot(page, 'after-check-off', true);
  // every vault call named the scratch vault, never uni
  const vaults = await page.evaluate(() => (window as any).__calls.filter((x: any) => x.cmd.startsWith('vault_') && x.cmd !== 'vault_list').map((x: any) => x.args.vault));
  expect(vaults.length).toBeGreaterThan(5);
  const leaks = await page.evaluate(() => (window as any).__calls.filter((x: any) => x.cmd.startsWith('vault_') && x.args.vault === 'uni').map((x: any) => x.cmd + ' ' + JSON.stringify(x.args).slice(0, 120)));
  expect(leaks).toEqual([]);
  expect(new Set(vaults)).toEqual(new Set(['lifeos']));
  expect(await calls(page, 'get_messages')).toHaveLength(0);
  expect(errors).toEqual([]);
});

test('a vault without the pack says so', async ({ page }) => {
  const { errors } = await bootAnyVault(page, { savedVault: 'bare' });
  await expect(page.getByRole('heading', { name: /isn't set up for Uni yet/ })).toBeVisible();
  await shot(page, 'no-pack');
  expect(errors).toEqual([]);
});

test('the picker switches vault and the choice persists', async ({ page }) => {
  await bootAnyVault(page, { savedVault: 'lifeos' });
  await expect(card(page, 'Health')).toBeVisible();
  await page.getByLabel('Life OS vault').selectOption('bare');
  await expect(page.getByRole('heading', { name: /isn't set up for Uni yet/ })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('uni.lifeos.vault'))).toBe('bare');
});

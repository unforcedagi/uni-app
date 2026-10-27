// T-302 round 3: the independent review's four findings, each played as it would happen, on the real web build with the projects fixture
// (made-up vault, nothing leaves the page). Each test fails with its fix taken out.
import { expect, test, type Page } from '@playwright/test';
import { bootProjects } from './projectsFixture.ts';

const A = 'a'.repeat(64), B = 'b'.repeat(64);
const MIN = 60_000;
const shot = (page: Page, name: string) => page.screenshot({ path: `__shots__/t319/${test.info().project.name}-${name}.png` });
const workKeys = (page: Page) => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('uni.work.')));
const door = (page: Page, name: string) => page.getByRole('navigation', { name: 'Rooms' }).getByRole('button', { name: new RegExp(`^${name}\\b`) });
const rail = (page: Page) => page.getByRole('navigation', { name: 'Main navigation' });
async function home(page: Page) {
  await page.goto('/');
  await expect(page.locator('[data-place="front-door"]')).toBeVisible();
}
/** The first read has landed and been kept on the device for identity A. */
const kept = async (page: Page) => expect.poll(async () => (await workKeys(page)).length).toBeGreaterThan(0);

test('P1: another identity on the same vault never sees the work this device kept for the first', async ({ page }) => {
  await bootProjects(page);
  await home(page);
  await expect(door(page, 'Workshop').locator('.fd-live')).toHaveText('2 working');
  await kept(page);
  // another key on this device, and its own reads of the work don't come through: only a copy could show anything
  await page.evaluate((b) => { sessionStorage.setItem('t.identity', b); sessionStorage.setItem('t.offline', '1'); }, B);
  await page.reload();
  await expect(door(page, 'Workshop')).toBeVisible();
  await expect(page.locator('.fd-live')).toHaveCount(0);
  await door(page, 'Workshop').click();
  await expect(page.locator('.sr-title')).toHaveText('Workshop');
  await expect(page.locator('[data-place="project-strip"] .ps-tab')).toHaveCount(0);
  // the copy kept is the first identity's own, by name
  expect(await workKeys(page)).toEqual([`uni.work.v3:${A}:uni`]);
});

test('P1: Forget drops the kept work, and a read still out when it happened can\'t put it back', async ({ page }) => {
  await page.clock.install();
  await bootProjects(page);
  await home(page);
  await kept(page);
  // the next read is held mid-way (the vault is slow), then Forget
  await page.evaluate(() => { (window as any).__holdRuns = true; });
  await page.clock.fastForward(31_000);
  await expect.poll(() => page.evaluate(() => (window as any).__held.length)).toBeGreaterThan(0);
  await rail(page).getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Forget this device key', exact: true }).click();
  await page.getByRole('button', { name: /Tap again to forget/ }).click();
  await expect.poll(() => workKeys(page)).toEqual([]);
  // the held read lands after Forget
  await page.evaluate(() => (window as any).__releaseRuns());
  await page.waitForTimeout(800);
  expect(await workKeys(page)).toEqual([]);
});

test('P2: a ledger longer than the pages read keeps the recent sessions whole, and says some older ones aren\'t loaded', async ({ page }) => {
  await bootProjects(page, { bigRuns: 2100 });
  await home(page);
  await expect(page.locator('.fd-status')).toHaveText("Some older sessions aren't loaded");
  await expect(door(page, 'Workshop').locator('.fd-live')).toHaveText('2 working');
  await door(page, 'Workshop').click();
  await page.locator('[data-place="project-strip"] .ps-tab[data-project="p-coop"]').click();
  const sheet = page.getByRole('dialog', { name: 'Riverbend co-op site' });
  await expect(sheet.locator('.pj-session').filter({ hasText: 'Rebuild the about page' })).toBeVisible();
  await expect(sheet.locator('.pj-status')).toContainText("Some older sessions aren't loaded");
});

test('P2: offline, a kept copy ages by the clock: "working at <time>" while recently heard, then not working; it says it couldn\'t refresh', async ({ page }) => {
  await bootProjects(page);
  await home(page);
  await kept(page);
  // 100 minutes later, offline: the copy's sessions were last heard about 100 minutes ago (still within the 2 hours)
  await page.clock.install({ time: new Date(Date.now() + 100 * MIN) });
  await page.evaluate(() => sessionStorage.setItem('t.offline', '1'));
  await page.reload();
  await expect(page.locator('.fd-status')).toContainText(/^Couldn't refresh · As of /);
  await expect(door(page, 'Workshop').locator('.fd-live')).toHaveText(/^2 working at /);
  // 25 minutes on, still offline: no one has heard from them for over 2 hours, so they no longer count as working
  await page.clock.fastForward(25 * MIN);
  await expect(page.locator('.fd-live')).toHaveCount(0);
});

test('P2: when reads hang (no answer, no error), the clock alone stops a quiet session counting as working', async ({ page }) => {
  await bootProjects(page);
  await home(page);
  await kept(page);
  await page.clock.install({ time: new Date(Date.now() + 100 * MIN) });
  await page.evaluate(() => sessionStorage.setItem('t.hang', '1'));
  await page.reload();
  await expect(page.locator('.fd-status')).toHaveText(/^As of /);
  await expect(door(page, 'Workshop').locator('.fd-live')).toHaveText(/^2 working at /);
  await page.clock.fastForward(25 * MIN);
  await expect(page.locator('.fd-live')).toHaveCount(0);
});

test('P2: a copy kept from hours ago opens with its sessions not working, at once', async ({ page }) => {
  await bootProjects(page);
  await home(page);
  await kept(page);
  await page.clock.install({ time: new Date(Date.now() + 150 * MIN) });
  await page.evaluate(() => sessionStorage.setItem('t.offline', '1'));
  await page.reload();
  await expect(door(page, 'Workshop')).toBeVisible();
  await expect(page.locator('.fd-live')).toHaveCount(0, { timeout: 3000 });
});

test('P2: the usage line and the card read the note again (focus, and every few minutes), and an old reading says so', async ({ page }) => {
  await page.clock.install();
  await bootProjects(page);
  await home(page);
  const line = page.locator('.fd-usage');
  await expect(line).toHaveText('Claude: A 41% of the week · B 12% of the week · new work to B · as of 6 min ago');
  const setUsage = (week: number, readMinAgo: number) => page.evaluate(([week, ago]) => {
    const u = (window as any).__world.usage; const at = new Date(Date.now() - ago * 60_000).toISOString();
    const doc = u.metadata.claude_accounts; doc.read_at = at; doc.accounts[0].read_at = at; doc.accounts[0].week.used = week;
  }, [week, readMinAgo] as const);
  // coming back to the window reads it again
  await setUsage(55, 1);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(line).toHaveText('Claude: A 55% of the week · B 12% of the week · new work to B · as of 1 min ago');
  // T-319: a reading three hours old is not shown as current: the line says so plainly, without its numbers
  await setUsage(55, 180);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(line).toHaveText('Claude: no fresh usage reading; the last one is from 3 h ago');
  // the full card, left open, reads it again every few minutes
  await setUsage(60, 1);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await line.click();
  const card = page.getByRole('dialog', { name: 'Claude accounts' });
  await expect(card).toContainText('60%');
  await setUsage(70, 1);
  await page.clock.fastForward(5 * MIN + 1000);
  await expect(card).toContainText('70%');
});

test('T-319: the usage line says how old its reading is, says plainly when it is old, and Refresh reads the note again now', async ({ page }) => {
  await bootProjects(page);
  await page.addInitScript(() => {
    // count the reads of the usage note, and make its reading 28 hours old before the app's first read
    const w = window as any, inv = w.__TAURI_INTERNALS__.invoke;
    const doc = w.__world.usage.metadata.claude_accounts, at = new Date(Date.now() - 28 * 60 * 60_000).toISOString();
    doc.read_at = at; for (const a of doc.accounts) a.read_at = at;
    w.__usageReads = 0;
    w.__TAURI_INTERNALS__.invoke = async (cmd: string, args: any) => { if (cmd === 'vault_note' && args?.noteRef === 'System/Claude accounts') w.__usageReads++; return inv(cmd, args); };
  });
  await home(page);
  const line = page.locator('.fd-usage');
  await expect(line).toHaveText('Claude: no fresh usage reading; the last one is from 28 h ago');
  await expect(line).not.toContainText('%');
  await line.scrollIntoViewIfNeeded();
  await shot(page, 'usage-stale');
  // the launcher writes a new reading; Refresh reads it at once (no waiting for the next few minutes, no leaving the window)
  await page.evaluate(() => {
    const doc = (window as any).__world.usage.metadata.claude_accounts, at = new Date(Date.now() - 2 * 60_000).toISOString();
    doc.read_at = at; for (const a of doc.accounts) a.read_at = at; doc.accounts[0].week.used = 47;
  });
  const reads = await page.evaluate(() => (window as any).__usageReads as number);
  await page.getByRole('button', { name: 'Refresh Claude usage' }).click();
  await expect(line).toHaveText('Claude: A 47% of the week · B 12% of the week · new work to B · as of 2 min ago');
  expect(await page.evaluate(() => (window as any).__usageReads as number)).toBeGreaterThan(reads);
  await shot(page, 'usage-fresh');
  // the card, opened from the line: as of when, and its own Refresh
  await line.click();
  const card = page.getByRole('dialog', { name: 'Claude accounts' });
  await expect(card.locator('.usage-age')).toHaveText('As of 2 min ago');
  await expect(card.getByRole('button', { name: 'Refresh Claude usage' })).toBeVisible();
});

test('review f97fx1ji P3: a task list longer than the pages read still places a session found only through its task', async ({ page }) => {
  await bootProjects(page, { bigTasks: 2100 });
  await home(page);
  await door(page, 'Engine Room').click();
  await page.locator('[data-place="project-strip"] .ps-tab[data-project="p-backups"]').click();
  const sheet = page.getByRole('dialog', { name: 'Nightly backups' });
  await expect(sheet.locator('.pj-session')).toContainText('Left a commit.');
  await expect(page.locator('.pj-status')).toHaveCount(0);
});

test('review f97fx1ji P3: when that task can\'t be read either, it says a session couldn\'t be placed (never a quiet success)', async ({ page }) => {
  await bootProjects(page, { bigTasks: 2100 });
  await page.addInitScript(() => sessionStorage.setItem('t.nopaths', '1'));
  await home(page);
  await expect(page.locator('.fd-status')).toHaveText("1 session couldn't be placed under a project");
});

test('review f97fx1ji P3: a task read that fails is not taken as the whole list: the session is still placed through its own task', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('t.tasksfail', '1'));
  await bootProjects(page);
  await home(page);
  await door(page, 'Engine Room').click();
  await page.locator('[data-place="project-strip"] .ps-tab[data-project="p-backups"]').click();
  await expect(page.getByRole('dialog', { name: 'Nightly backups' }).locator('.pj-session')).toContainText('Left a commit.');
});

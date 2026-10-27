// T-319 walkthrough driver: the usage line saying plainly that its reading is old, Refresh reading the note again, the card's "as of",
// one account's old reading said on its own row;
// then a long session scrolled back to its first step. Writes marks.json (seconds into the video at each scene's start) and stills
// NN-*.png to the run's output dir; narrate.py cuts and voices them. Made-up world only (scripts/browser/projectsWorld.ts).
import { test, expect, type Page } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { bootProjects } from '../../scripts/browser/projectsFixture';

const view = (page: Page) => page.locator('[data-place="session-view"]');
const readAt = (page: Page, minAgo: number, week?: number) => page.evaluate(([ago, week]) => {
  const doc = (window as any).__world.usage.metadata.claude_accounts, at = new Date(Date.now() - ago * 60_000).toISOString();
  doc.read_at = at; for (const a of doc.accounts) a.read_at = at;
  if (week !== undefined) doc.accounts[0].week.used = week;
}, [minAgo, week] as const);

test('walk', async ({ page }) => {
  const t0 = Date.now();
  const marks: Record<string, number> = {};
  const R = test.info().project.outputDir;
  mkdirSync(R, { recursive: true });
  const mark = async (label: string) => {
    marks[label] = (Date.now() - t0) / 1000;
    await page.screenshot({ path: `${R}/${String(Object.keys(marks).length).padStart(2, '0')}-${label}.png` });
  };
  const hold = (ms: number) => page.waitForTimeout(ms);
  await bootProjects(page, { moreRuns: (now) => [{ id: 'run-long', path: 'Runs/2026-10-20 Sort the gallery by season', tags: ['run'],
    createdAt: new Date(now - 300 * 60_000).toISOString(), updatedAt: new Date(now).toISOString(),
    metadata: { node: 'p-coop', state: 'running', started_at: new Date(now - 300 * 60_000).toISOString(), doing_now: 'Editing card-449.css', doing_at: new Date(now - 60_000).toISOString(), steps: 300, feed: 'feed-long' } }] });
  // the usage note's reading is 28 hours old when the app first reads it
  await page.addInitScript(() => {
    const doc = (window as any).__world.usage.metadata.claude_accounts, at = new Date(Date.now() - 28 * 60 * 60_000).toISOString();
    doc.read_at = at; for (const a of doc.accounts) a.read_at = at;
  });
  await page.goto('/');
  const line = page.locator('.fd-usage');
  await expect(line).toHaveText('Claude: no fresh usage reading; the last one is from 28 h ago');
  await line.scrollIntoViewIfNeeded();
  await mark('stale');
  await hold(9000);

  await readAt(page, 2, 47);
  await page.getByRole('button', { name: 'Refresh Claude usage' }).click();
  await expect(line).toHaveText(/ · as of 2 min ago$/);
  await mark('refresh');
  await hold(8000);

  await line.click();
  await expect(page.getByRole('dialog', { name: 'Claude accounts' }).locator('.usage-age')).toHaveText('As of 2 min ago');
  await mark('card');
  await hold(8000);

  // one account's meter stops while the other's keeps going: that account says so on its own row
  await page.evaluate(() => {
    const doc = (window as any).__world.usage.metadata.claude_accounts;
    doc.accounts[0].read_at = new Date(Date.now() - 48 * 60 * 60_000).toISOString();
  });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('dialog', { name: 'Claude accounts' }).getByLabel('Account A')).toContainText('No fresh reading for this account');
  await mark('one-old');
  await hold(9000);
  await page.keyboard.press('Escape');
  await expect(line).toContainText('A no fresh reading (2 days old)');

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('.fd-door[data-path="Areas/Workshop"]').click();
  await page.locator('[data-place="project-strip"]').getByRole('button', { name: /Riverbend co-op site/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: /^Sort the gallery by season/ }).first().click();
  const steps = view(page).locator('.sv-steps');
  await expect(steps.locator('li')).toHaveCount(60);
  await mark('long');
  await hold(9000);

  await view(page).getByRole('button', { name: 'Load earlier steps' }).click();
  await expect(steps.locator('li')).toHaveCount(250);
  await mark('earlier');
  await hold(8000);

  // scrolling up to the top of the list, as a person would, loads the part before that
  for (let i = 0; i < 12; i++) { await steps.evaluate((b) => b.scrollBy({ top: -260 })); await hold(250); }
  await steps.evaluate((b) => { b.scrollTop = 0; b.dispatchEvent(new Event('scroll')); });
  await expect(steps.locator('li')).toHaveCount(450);
  await steps.evaluate((b) => b.scrollBy({ top: -10_000 }));
  await expect(view(page)).toContainText('From its first step.');
  await mark('first');
  await hold(9000);
  await mark('end');
  await hold(1000);
  writeFileSync(`${R}/marks.json`, JSON.stringify(marks, null, 1));
});

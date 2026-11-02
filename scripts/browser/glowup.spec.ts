// T-335 glow-up: the study's direction built into the app (home, a room, find) and the All view. Synthetic data only.
// Shots go to $GLOWUP_SHOTS (default: test-results/glowup-shots), never into the repo.
import { test, expect, type Page } from '@playwright/test';
import { bootAreas } from './areasFixture';

const SHOTS = process.env.GLOWUP_SHOTS ?? 'test-results/glowup-shots';
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${name}.png` });
const daylight = () => test.info().project.name === 'daylight';

async function boot(page: Page) {
  // the Daylight is set to Calm screen, as the device is
  if (daylight()) await page.addInitScript(() => { if (!sessionStorage.getItem('glow.booted')) localStorage.setItem('uni.motion', 'calm'); sessionStorage.setItem('glow.booted', '1'); });
  await bootAreas(page, 'seed', { tree: true, tasks: true, briefs: true, unread: { 'ch-techne': 2, 'ch-unf': 1 } });
  await page.locator('[data-place="front-door"]').waitFor();
  await page.waitForTimeout(800);
}

test('look: home, a room and find', async ({ page }) => {
  await boot(page);
  await shot(page, '01-home');
  await page.locator('.fd-door[data-path="Areas/Techne"]').click();
  await page.getByRole('textbox', { name: /Message/ }).first().waitFor();
  await page.waitForTimeout(600);
  await shot(page, '02-room');
  if (page.viewportSize()!.width >= 900) await page.keyboard.press('Control+k');
  else await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Search' }).click();
  const field = page.getByRole('searchbox', { name: 'Search conversations and notes' });
  await expect(field).toBeFocused();
  await shot(page, '03-find-empty');
  await field.fill('plan');
  await page.waitForTimeout(900);
  await shot(page, '04-find-results');
});

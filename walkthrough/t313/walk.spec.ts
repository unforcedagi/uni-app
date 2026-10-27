// T-313 walkthrough driver: each narration line's step, started at that line's time (runs/vo/timeline.json). Writes
// runs/marks.json (`start`: seconds into the film where the narration begins) and a still per step (runs/NN-tag.png).
import { test, expect, type Page } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { boot, type Bridge } from '../../scripts/browser/messagesBridge';

const D = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
const users = JSON.parse(readFileSync(`${process.env.T313_DIR}/users.json`, 'utf8'));
const timeline: { duration: number; lines: { tag: string; t0: number; t1: number }[] } = JSON.parse(readFileSync(`${D}/runs/vo/timeline.json`, 'utf8'));
const bridge: Bridge = { url: process.env.MESSAGES_BRIDGE_URL!, token: process.env.MESSAGES_BRIDGE_TOKEN! };
const log = (page: Page) => page.getByRole('log', { name: 'Messages with Robin Vale' });

test('walk', async ({ page }) => {
  const t0 = Date.now();
  mkdirSync(`${D}/runs`, { recursive: true });
  // a ring where the screen is tapped, so the film shows each tap
  await page.addInitScript(() => addEventListener('pointerdown', (e) => {
    const d = document.createElement('div');
    d.style.cssText = `position:fixed;left:${e.clientX - 24}px;top:${e.clientY - 24}px;width:48px;height:48px;border-radius:50%;border:4px solid #d33;pointer-events:none;z-index:99999`;
    document.body.appendChild(d); setTimeout(() => d.remove(), 800);
  }, true));
  await boot(page, 'pat', bridge);
  const form = page.getByRole('form', { name: 'Sign in to Messages' });
  await form.getByLabel('Homeserver').fill(process.env.T313_HS!);
  await form.getByLabel('Username').fill(users.pat.user_id);
  await form.getByLabel('Password').fill(users.pat.password);
  await form.getByRole('button', { name: 'Sign in' }).click();
  const list = page.getByRole('navigation', { name: 'Conversations' });
  await expect(list.getByRole('button', { name: /Robin Vale/ })).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(1500);

  const start = Date.now();
  const at = async (tag: string) => {
    const line = timeline.lines.find((l) => l.tag === tag)!;
    const wait = start + line.t0 * 1000 - Date.now();
    if (wait > 0) await page.waitForTimeout(wait);
    return line;
  };
  const shot = (n: number, tag: string) => page.screenshot({ path: `${D}/runs/${String(n).padStart(2, '0')}-${tag}.png` });
  const voice = log(page).locator('.msgs-msg.has-media').filter({ has: page.getByRole('button', { name: /voice message/ }) }).first();

  await at('open');
  await page.waitForTimeout(2200);
  await list.getByRole('button', { name: /Robin Vale/ }).click();
  await expect(log(page)).toBeVisible();
  await page.waitForTimeout(800);
  // to the top of the conversation, where the link is
  await log(page).evaluate((el) => { el.scrollTop = 0; });
  await shot(1, 'open');

  await at('link');
  await page.waitForTimeout(1200);
  await log(page).getByRole('link', { name: /garden-lunch/ }).click();
  await shot(2, 'link');

  await at('voice');
  await voice.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(1200);
  await shot(3, 'voice');
  const robin = await at('robin');
  await voice.getByRole('button', { name: /^Play voice message/ }).click();
  await page.waitForTimeout(1500);
  await shot(4, 'playing');

  await at('words');
  await expect(voice.locator('.msgs-words-text')).toBeVisible({ timeout: 20_000 });
  await voice.locator('.msgs-words-text').evaluate((el) => { (el as HTMLElement).style.outline = '3px solid #d33'; (el as HTMLElement).style.outlineOffset = '3px'; });
  await page.waitForTimeout(500);
  await shot(5, 'words');
  await page.waitForTimeout(3500);
  await voice.locator('.msgs-words-text').evaluate((el) => { (el as HTMLElement).style.outline = ''; });

  await at('scrub');
  const slider = voice.getByRole('slider');
  const sb = (await slider.boundingBox())!;
  await page.mouse.move(sb.x + sb.width * 0.15, sb.y + sb.height / 2);
  await page.mouse.down();
  await page.mouse.move(sb.x + sb.width * 0.55, sb.y + sb.height / 2, { steps: 12 });
  await page.mouse.up();
  await voice.getByRole('button', { name: /^Play voice message/ }).click().catch(() => {});
  await page.waitForTimeout(1500);
  await voice.getByRole('button', { name: 'Pause voice message' }).click().catch(() => {});
  await shot(6, 'scrub');

  await at('photo');
  const photo = log(page).getByRole('button', { name: /^Photo:/ });
  await photo.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(1200);
  await photo.click();
  await page.waitForTimeout(1600);
  await shot(7, 'photo');
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();

  await at('file');
  const open = log(page).getByRole('button', { name: /^Open planting-plan/ });
  await open.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(1000);
  await open.click();
  await shot(8, 'file');

  await at('reply');
  await log(page).evaluate((el) => { el.scrollTop = 0; });
  const quote = log(page).getByRole('button', { name: /^In reply to/ });
  await quote.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(1500);
  await quote.click();
  await page.waitForTimeout(1200);
  await shot(9, 'reply');
  await log(page).getByRole('list', { name: 'Reactions' }).evaluate((el) => el.scrollIntoView({ block: 'center' }));

  await at('long');
  const more = log(page).getByRole('button', { name: 'Read more' });
  await more.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(1500);
  await more.click();
  await page.waitForTimeout(800);
  await shot(10, 'long');

  await at('end');
  await log(page).evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(timeline.duration * 1000 - (Date.now() - start) + 500);
  writeFileSync(`${D}/runs/marks.json`, JSON.stringify({ start: (start - t0) / 1000, robin: robin.t0 }));
});

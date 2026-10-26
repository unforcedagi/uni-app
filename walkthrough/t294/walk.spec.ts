// T-294 walkthrough driver: a room read back with a draft, over to Messages and back, Messages' own place, a restart, Uni at Uni.
// Writes runs/marks.json (seconds into the video at each scene's start) and stills runs/NN-*.png; narrate.py cuts and voices them.
import { test, expect, type Page } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { bootAreas } from '../../scripts/browser/areasFixture';

const rail = (page: Page) => page.getByRole('navigation', { name: 'Main navigation' });
const composer = (page: Page) => page.locator('.sr-chat').getByRole('textbox', { name: /^Message / });

test('walk', async ({ page }) => {
  const t0 = Date.now();
  const marks: Record<string, number> = {};
  const mark = async (label: string, still = true) => {
    marks[label] = (Date.now() - t0) / 1000;
    if (still) await page.screenshot({ path: `runs/${String(Object.keys(marks).length).padStart(2, '0')}-${label}.png` });
  };
  mkdirSync('runs', { recursive: true });
  await page.addInitScript(() => {
    const w = window as any;
    const now = Date.now();
    const room = (id: string, name: string, preview: string, unread = 0) => ({ id, name, preview, preview_own: false, ts: now - 60_000, unread, encrypted: true, invited: false, inviter: null, direct: true });
    const say = ['Are we still on for Thursday?', 'I can bring the projector.', 'Rae says the hall is booked till six.', 'Shall we start at four then?'];
    const line = (i: number, roomId: string) => ({ key: `${roomId}-${i}`, event_id: `$${roomId}-${i}`, sender: '@kit:example.org', sender_name: 'Kit Sample', own: i % 4 === 3, ts: now - (40 - i) * 600_000, kind: 'text', body: `${say[i % 4]} (${i + 1})`, state: 'remote', encrypted: true, edited: false });
    w.__extraInvoke = async (cmd: string, args: any) => {
      switch (cmd) {
        case 'messages_status': return { state: 'live', user_id: '@aaron:example.org', homeserver: 'https://matrix.example.org', error: null };
        case 'messages_rooms': return [room('!kit:example.org', 'Kit Sample', 'Shall we start at four then?', 1), room('!sam:example.org', 'Sam Example', 'See you then'), room('!club:example.org', 'Book club', 'Chapter 4 next')];
        case 'messages_open': return Array.from({ length: 40 }, (_, i) => line(i, args.roomId));
        case 'messages_close': case 'messages_read': case 'messages_send': return null;
        default: return undefined;
      }
    };
    // a ring where the screen is tapped, so the film shows each tap
    addEventListener('pointerdown', (e) => {
      const d = document.createElement('div');
      d.style.cssText = `position:fixed;left:${e.clientX - 22}px;top:${e.clientY - 22}px;width:44px;height:44px;border-radius:50%;border:4px solid #d33;pointer-events:none;z-index:99999`;
      document.body.appendChild(d); setTimeout(() => d.remove(), 700);
    }, true);
  });
  await bootAreas(page, 'seed', { tree: true, atlas: true, longChat: true, pinned: true });
  await expect(rail(page).getByRole('button', { name: 'Messages' })).toBeVisible({ timeout: 10_000 });
  const tree = page.locator('.th-roomnav');
  for (let i = 0; i < 12; i++) { const f = tree.locator('.th-fold[aria-expanded="false"]'); if (!await f.count()) break; await f.first().click(); }
  await tree.locator('.th-go[aria-label^="ATLAS,"]').click();
  await expect(page.locator('.sr')).toHaveAttribute('data-node', 'ATLAS');
  await page.waitForTimeout(800);
  // 1: reading back, a reply half written
  const list = page.locator('.sr-chat .message-list');
  const box = (await list.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await mark('room', false);
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -450); await page.waitForTimeout(250); }
  await composer(page).pressSequentially('Half a thought about the map labels', { delay: 45 });
  await composer(page).blur();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'runs/01-room.png' });
  // 2: over to Messages
  await page.waitForTimeout(1500);
  await mark('messages', false);
  await rail(page).getByRole('button', { name: 'Messages' }).click();
  await expect(page.getByRole('navigation', { name: 'Conversations' })).toBeVisible();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'runs/02-messages.png' });
  // 3: Uni: the same room, spot and draft
  await mark('back', false);
  await rail(page).getByRole('button', { name: 'Uni', exact: true }).click();
  await expect(page.locator('.sr')).toHaveAttribute('data-node', 'ATLAS');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'runs/03-back.png' });
  await page.waitForTimeout(2500);
  // 4: Messages keeps its own place
  await mark('msgs-own', false);
  await rail(page).getByRole('button', { name: 'Messages' }).click();
  await page.getByRole('navigation', { name: 'Conversations' }).getByRole('button', { name: /Kit Sample/ }).click();
  const log = page.getByRole('log', { name: 'Messages with Kit Sample' });
  await expect(log).toContainText('(40)');
  const lb = (await log.boundingBox())!;
  await page.mouse.move(lb.x + lb.width / 2, lb.y + lb.height / 2);
  for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, -300); await page.waitForTimeout(250); }
  const reply = page.getByRole('textbox', { name: 'Message Kit Sample' });
  await reply.pressSequentially('Four works for me', { delay: 45 });
  await reply.blur();
  await page.waitForTimeout(1200);
  await rail(page).getByRole('button', { name: 'Uni', exact: true }).click();
  await expect(page.locator('.sr')).toHaveAttribute('data-node', 'ATLAS');
  await page.waitForTimeout(1800);
  await rail(page).getByRole('button', { name: 'Messages' }).click();
  await expect(reply).toHaveValue('Four works for me');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'runs/04-messages-own.png' });
  // 5: closed by the system while in Messages, reopened: Uni still goes back to the room
  await mark('restart', false);
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.reload();
  await expect(page.locator('section.msgs')).toBeVisible();
  await expect(rail(page).getByRole('button', { name: 'Messages' })).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(1500);
  await rail(page).getByRole('button', { name: 'Uni', exact: true }).click();
  await expect(page.locator('.sr')).toHaveAttribute('data-node', 'ATLAS');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'runs/05-restart.png' });
  // 6: at Uni already, Uni goes home
  await mark('home', false);
  await rail(page).getByRole('button', { name: 'Uni', exact: true }).click();
  await expect(page.locator('.sr')).toHaveAttribute('data-node', 'Uni');
  await page.waitForTimeout(3000);
  await page.screenshot({ path: 'runs/06-home.png' });
  marks.end = (Date.now() - t0) / 1000;
  writeFileSync('runs/marks.json', JSON.stringify(marks, null, 1));
});

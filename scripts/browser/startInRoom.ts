// 0.2.2: with the Uni glue a fresh start opens the home, whatever the rooms are (it opened the busiest room when there was no Uni room).
// A test world that starts in a room says so: the app was last left there (seeded only when nothing is saved yet, so a reload keeps what
// the app saved since).
import type { Page } from '@playwright/test';

export async function startInRoom(page: Page, channel: string) {
  await page.addInitScript((ch) => {
    try {
      if (!localStorage.getItem('uni.tabs.v2')) localStorage.setItem('uni.tabs.v2', JSON.stringify({ v: 1, tabs: [{ id: 'start-room', kind: 'all', title: 'Uni', channel: ch }], active: 'start-room', recent: ['start-room'] }));
    } catch { /* private storage */ }
  }, channel);
}

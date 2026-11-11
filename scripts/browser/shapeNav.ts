// T-335 the shape: how a spec moves around the shell. Home is the rooms list; the bar has Rooms, Journal and Applets;
// every applet opens from the drawer; Settings opens from home's gear; a room opens from its row.
import { expect, type Page } from '@playwright/test';

export const bar = (page: Page) => page.getByRole('navigation', { name: 'Places' });
export const homeHead = (page: Page) => page.getByRole('heading', { name: 'Rooms', level: 1 });
export const roomRow = (page: Page, id: string) => page.locator(`.sh-row[data-room="${id}"]`);

/** Home, from wherever the bar shows (inside a room, step back first with `leaveRoom`). */
export async function goRooms(page: Page) {
  await bar(page).getByRole('button', { name: /^Rooms/ }).click();
  await expect(homeHead(page)).toBeVisible();
}
export async function goJournal(page: Page) {
  await bar(page).getByRole('button', { name: /^Journal/ }).click();
}
/** Opens an applet by its tile's name ("Mail", "Calendar", "To Post", "Vault", "Arcade", "Messages"). */
export async function openApplet(page: Page, name: string) {
  await bar(page).getByRole('button', { name: /^Applets/ }).click();
  const drawer = page.getByRole('dialog', { name: 'Applets' });
  await drawer.getByRole('button', { name: new RegExp(`^${name}( \\(\\d+\\))?$`) }).click();
  await expect(page.locator('.sh-ap-top h1')).toHaveText(name);
}
/** Settings lives behind home's gear. */
export async function openSettings(page: Page) {
  if (!(await homeHead(page).isVisible().catch(() => false))) await goRooms(page);
  await page.locator('.sh-home').getByRole('button', { name: 'Settings' }).click();
}
/** A room, from home, by its channel id. */
export async function openRoom(page: Page, id: string) {
  if (!(await homeHead(page).isVisible().catch(() => false))) await goRooms(page);
  await roomRow(page, id).locator('.sh-row-open').click();
  await expect(page.locator('.sh-room')).toBeVisible();
}
/** Out of a room, back to home. */
export async function leaveRoom(page: Page) {
  await page.locator('.sh-room').getByRole('button', { name: 'Back to rooms' }).click();
  await expect(homeHead(page)).toBeVisible();
}

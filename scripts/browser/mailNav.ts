// The Mail specs' way around the shell: Mail is an applet in its frame (the saved tab opens straight into it); leaving it is
// Back to applets, coming back is the drawer's Mail tile; what wants a look in Mail (held sends + unread Inbox) shows as the
// count on that tile and on the bar's Applets button.
import { expect, type Page } from '@playwright/test';
import { bar, openApplet } from './shapeNav';

const drawer = (page: Page) => page.getByRole('dialog', { name: 'Applets' });

/** Out of Mail to the applets drawer, then away from it: Mail is gone from the page. */
export async function leaveMail(page: Page) {
  await page.locator('.sh-ap-frame').getByRole('button', { name: 'Back to applets' }).click();
  await expect(drawer(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer(page)).toHaveCount(0);
  await expect(page.locator('.mail')).toHaveCount(0);
}
/** Back into Mail from the drawer's tile. */
export const returnToMail = (page: Page) => openApplet(page, 'Mail');

/** The count Mail shows: on the bar's Applets button (its name carries it) and on the Mail tile in the drawer. 0 = no count anywhere. */
export async function expectMailCount(page: Page, n: number) {
  const applets = bar(page).getByRole('button', { name: /^Applets/ });
  if (n > 0) await expect(applets).toHaveAccessibleName(`Applets, ${n} new`); else await expect(applets).toHaveAccessibleName('Applets');
  const open = await drawer(page).count();
  if (!open) await applets.click();
  await expect(drawer(page).getByRole('button', { name: n > 0 ? `Mail (${n})` : 'Mail', exact: true })).toBeVisible();
  if (!open) { await page.keyboard.press('Escape'); await expect(drawer(page)).toHaveCount(0); }
}

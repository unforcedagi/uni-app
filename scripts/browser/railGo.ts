// T-335 as Aaron: on a phone the rail is four places and More; the rest open from the sheet More shows. This taps a place wherever it is.
import type { Page } from '@playwright/test';
export const railNav = (page: Page) => page.getByRole('navigation', { name: 'Main navigation' });
/** Opens More when the place is behind it (a phone), so the place's button can be seen and tapped. */
export async function openRailMore(page: Page) {
  const more = railNav(page).getByRole('button', { name: 'More', exact: true });
  if (await more.isVisible() && (await more.getAttribute('aria-expanded')) !== 'true') await more.click();
}
export async function railGo(page: Page, name: string) {
  await openRailMore(page);
  await railNav(page).getByRole('button', { name, exact: true }).click();
}

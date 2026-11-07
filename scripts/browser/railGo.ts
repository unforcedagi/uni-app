// T-335 as Aaron: on a phone the rail is four places and More; the rest open from the sheet More shows. This taps a place wherever it is.
import type { Page } from '@playwright/test';
export const railNav = (page: Page) => page.getByRole('navigation', { name: 'Main navigation' });
/** Opens More when the place is behind it (a phone), so the place's button can be seen and tapped. */
export async function openRailMore(page: Page) {
  if ((page.viewportSize()?.width ?? 0) >= 1100) return; // a desktop has every place on the rail (0.2: a tablet has the phone's few and More)
  const more = railNav(page).getByRole('button', { name: 'More', exact: true });
  await more.waitFor(); // the bar steps aside while a composer has focus
  if ((await more.getAttribute('aria-expanded')) !== 'true') await more.click();
}
export async function railGo(page: Page, name: string) {
  if (!(await railNav(page).getByRole('button', { name, exact: true }).isVisible().catch(() => false))) await openRailMore(page);
  await railNav(page).getByRole('button', { name, exact: true }).click();
}

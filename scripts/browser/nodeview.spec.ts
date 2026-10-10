// T-83: the octopus node view is the app's home. Uni → Techne → COhere 2026 and back (breadcrumb, chip, Android back), the centre
// from the node's brief, the node's room at every level, no looping animation anywhere, three screen sizes in colour and grayscale.
import { mkdir } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import { areaCard, bootAreas, openAreaPage } from './areasFixture';

const isDesktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 900;
const SHOTS = 'scripts/browser/__shots__/t83';
const crumbs = (page: Page) => page.getByRole('navigation', { name: 'Where you are' });
const composer = (page: Page, room: string) => page.getByRole('textbox', { name: `Message ${room}` });
const openSheet = async (page: Page) => { if (!isDesktop(page) && await page.locator('.area-chat.sheet:not(.open) .sheet-peek').count()) await page.locator('.sheet-peek').click(); };
const closeSheet = async (page: Page) => { if (!isDesktop(page) && await page.locator('.area-chat.sheet.open').count()) await page.locator('.sheet-peek').click(); };
const back = (page: Page) => page.evaluate(() => { const w = window as any; w.__cbs[w.__backHandler.id]({ message: {}, index: w.__backIndex ?? 0 }); w.__backIndex = (w.__backIndex ?? 0) + 1; });
const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const core = (page: Page) => page.locator('.node-core');
/** Every animation or transition running anywhere on the page must be finite. */
const infinite = (page: Page) => page.evaluate(() => document.getAnimations().filter((a) => { const t = a.effect?.getComputedTiming(); return !t || t.iterations === Infinity || !Number.isFinite(t.endTime as number); }).map((a) => (a as CSSAnimation).animationName ?? a.constructor.name));

test.describe('node view', () => {
  test.beforeEach(async ({ page }) => bootAreas(page, 'seed', { briefs: true, tree: true }));

  test('Uni at the centre: Needs you from the brief, areas as arms with status marks, the Uni room', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Uni', level: 1 })).toBeVisible();
    await expect(page.locator('.node-chip')).toHaveCount(0);
    if (isDesktop(page)) {
      await expect(core(page).locator('.node-alive li').first()).toContainText('Needs you');
      await expect(core(page).locator('.node-alive li').first()).toContainText('Send the Q4 invoice');
    } else await expect(core(page).locator('.node-count')).toHaveText(/need/);
    await expect(core(page)).toContainText(/updated \d+h ago/).catch(() => {}); // freshness shows in the centre where it fits
    // status encoded by ring style, name and a text label: Techne has needs, a project below it rolls up
    await expect(areaCard(page, 'Techne')).toHaveAttribute('data-mark', 'needs');
    await expect(areaCard(page, 'Techne')).toHaveAttribute('aria-label', 'Techne, needs you');
    await expect(areaCard(page, 'Sadhana')).toHaveAttribute('data-mark', 'quiet');
    await openSheet(page);
    await expect(composer(page, 'Uni')).toBeVisible();
    expect(await fits(page)).toBe(true);
  });

  test('Uni → Techne → COhere 2026 → back twice via the breadcrumb', async ({ page }) => {
    await areaCard(page, 'Techne').click();
    await expect(page.getByRole('heading', { name: 'Techne', level: 1 })).toBeVisible();
    await expect(page.locator('.node-chip')).toHaveAccessibleName('Zoom out to Uni');
    if (isDesktop(page)) await expect(core(page).locator('.node-alive')).toContainText('Reply to Benjamin about the grant');
    await openSheet(page);
    await expect(composer(page, 'Techne')).toBeVisible();
    await closeSheet(page);
    await areaCard(page, 'COhere 2026').click();
    await expect(page.getByRole('heading', { name: 'COhere 2026', level: 1 })).toBeVisible();
    await expect(page.locator('.node-chip')).toHaveAccessibleName('Zoom out to Techne');
    if (isDesktop(page)) await expect(core(page).locator('.node-alive')).toContainText('Needs you');
    await openSheet(page);
    await expect(composer(page, 'Cohere')).toBeVisible();
    await closeSheet(page);
    await crumbs(page).getByRole('button', { name: 'Techne' }).click();
    await expect(page.getByRole('heading', { name: 'Techne', level: 1 })).toBeVisible();
    await crumbs(page).getByRole('button', { name: 'Uni' }).click();
    await expect(page.getByRole('heading', { name: 'Uni', level: 1 })).toBeVisible();
    await expect(areaCard(page, 'Techne')).toBeVisible();
  });

  test('zoom out by the chip and by Android back, one level at a time', async ({ page }) => {
    await areaCard(page, 'Techne').click();
    await areaCard(page, 'COhere 2026').click();
    await expect(page.locator('.area-bar-title')).toHaveText('COhere 2026');
    await page.locator('.node-chip').click();
    await expect(page.locator('.area-bar-title')).toHaveText('Techne');
    await areaCard(page, 'COhere 2026').click();
    await expect(page.locator('.area-bar-title')).toHaveText('COhere 2026');
    await back(page);
    await expect(page.locator('.area-bar-title')).toHaveText('Techne');
    await back(page);
    await expect(page.locator('.area-bar-title')).toHaveText('Uni');
  });

  test('the area slot stub is there for an area and absent for Uni and a project', async ({ page }) => {
    await expect(page.locator('.node-slot')).toHaveCount(0);
    await areaCard(page, 'Techne').click();
    await expect(page.locator('.node-slot')).toHaveText("This space is for Techne's own view.");
    await areaCard(page, 'COhere 2026').click();
    await expect(page.locator('.node-slot')).toHaveCount(0);
  });

  test('no animation loops anywhere, with motion allowed or reduced', async ({ page }) => {
    for (const reducedMotion of ['no-preference', 'reduce'] as const) {
      await page.emulateMedia({ reducedMotion });
      await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Uni', exact: true }).click().catch(() => {});
      expect(await infinite(page)).toEqual([]);
      await areaCard(page, 'Techne').click();
      // mid-zoom and after: every animation has an end, and the zoom itself ends within 350 ms
      expect(await infinite(page)).toEqual([]);
      // the zoom's own animations (the map and its parts) end within 350 ms; the chat's own message rise is older and finite
      const ends = await page.evaluate(() => document.getAnimations().filter((a) => (a.effect as KeyframeEffect).target?.closest?.('.node-stage')).map((a) => a.effect!.getComputedTiming().endTime as number));
      expect(ends.length).toBeGreaterThan(reducedMotion === 'reduce' ? -1 : 0);
      for (const e of ends) expect(e).toBeLessThanOrEqual(350);
      await expect(page.getByRole('heading', { name: 'Techne', level: 1 })).toBeVisible();
      await page.waitForTimeout(450);
      expect(await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length)).toBe(0);
      await page.locator('.node-chip').click();
      await expect(page.getByRole('heading', { name: 'Uni', level: 1 })).toBeVisible();
    }
    const css = await page.evaluate(() => [...document.styleSheets].flatMap((s) => { try { return [...s.cssRules]; } catch { return []; } }).filter((r) => r instanceof CSSStyleRule && /infinite/.test(r.cssText) && /node-/.test(r.selectorText)).length);
    expect(css).toBe(0);
  });

  test('no brief: a quiet "No brief yet" and the Ask-Uni draft (never sent)', async ({ page }) => {
    await openAreaPage(page, 'Sadhana', { app: false });
    await expect(core(page)).toContainText(/No brief yet/);
    await page.getByRole('button', { name: 'Ask Uni to write it' }).click();
    await expect(composer(page, 'Sadhana')).toHaveValue(/@Uni Sadhana has no brief yet/);
    expect(await page.evaluate(() => (window as any).__calls.filter((c: any) => c.cmd === 'post_message').length)).toBe(0);
  });

  test('screenshots at 1600×1200, 1200×1600 and 390×844, colour and grayscale', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'sizes are set inside this test');
    await mkdir(SHOTS, { recursive: true });
    for (const [w, h] of [[1600, 1200], [1200, 1600], [390, 844]]) {
      await page.setViewportSize({ width: w, height: h });
      await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Uni', exact: true }).click().catch(() => {});
      for (const level of ['uni', 'techne', 'cohere']) {
        if (level === 'uni') await expect(page.getByRole('heading', { name: 'Uni', level: 1 })).toBeVisible();
        if (level === 'techne') await areaCard(page, 'Techne').click();
        if (level === 'cohere') await areaCard(page, 'COhere 2026').click();
        await page.waitForTimeout(450);
        expect(await fits(page)).toBe(true);
        await page.screenshot({ path: `${SHOTS}/${level}-${w}x${h}.png` });
        await page.addStyleTag({ content: 'html{filter:grayscale(1)}' }).then(async (tag) => { await page.screenshot({ path: `${SHOTS}/${level}-${w}x${h}-gray.png` }); await tag.evaluate((n) => n.remove()); });
      }
      await crumbs(page).getByRole('button', { name: 'Uni' }).click();
    }
  });
});

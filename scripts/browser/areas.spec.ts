import { mkdir } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import { bootAreas } from './areasFixture';

const rail = (page: Page) => page.getByRole('navigation', { name: 'Main navigation' });
const openAreas = async (page: Page) => { await rail(page).getByRole('button', { name: 'Areas', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Areas', level: 1 })).toBeVisible(); };
const card = (page: Page, name: string) => page.locator('.area-card', { has: page.locator('strong', { hasText: new RegExp(`^${name}$`) }) });
const openArea = async (page: Page, name: string) => { await card(page, name).click(); await expect(page.locator('.area-bar-title')).toHaveText(name); };
const calls = (page: Page, cmd: string) => page.evaluate((c) => (window as any).__calls.filter((x: any) => x.cmd === c), cmd);

test.describe('seed apps and navigation', () => {
  test.beforeEach(async ({ page }) => bootAreas(page, 'seed'));

  test('home lists areas foreground first, with room pulse', async ({ page }, info) => {
    await openAreas(page);
    const names = await page.locator('.area-card strong').allTextContents();
    expect(names).toEqual(['Techne', 'Unforced Development', 'Atlas', 'Expression', 'Relationships', 'Sadhana']);
    await expect(card(page, 'Techne').locator('.area-mark')).toHaveText(/Foreground/);
    await expect(card(page, 'Techne')).toContainText('Good. Ship Techne first');
    await expect(card(page, 'Relationships')).toContainText('No room linked');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await mkdir('shots/t73', { recursive: true });
    await page.screenshot({ path: `shots/t73/${info.project.name}-areas-home.png` });
  });

  test('techne app renders from bridge data and drafts without sending', async ({ page }, info) => {
    await openAreas(page);
    await openArea(page, 'Techne');
    const iframe = page.locator('iframe.area-frame');
    expect(await iframe.getAttribute('sandbox')).toBe('allow-scripts');
    const f = page.frameLocator('iframe.area-frame');
    await expect(f.locator('#title')).toHaveText('Techne');
    await expect(f.locator('#purpose')).toContainText('The craft of building');
    await expect(f.locator('#pulse li').first()).toContainText('Aaron');
    await expect(f.locator('#notes button')).toHaveCount(3);
    await expect(f.locator('#notes button').first()).toContainText('Workbench log');
    await mkdir('shots/t73', { recursive: true });
    await page.screenshot({ path: `shots/t73/${info.project.name}-area-techne.png` });
    // compose: the room opens with the text in the composer; nothing is posted
    await f.locator('#t').fill('Pairing on the bridge tonight');
    await f.locator('#go').click();
    const box = page.getByRole('textbox', { name: 'Message Techne' });
    await expect(box).toHaveValue('Pairing on the bridge tonight');
    expect(await calls(page, 'post_message')).toHaveLength(0);
    // The area tab stays open next to the room tab.
    await expect(page.locator('.tab-chip')).toHaveCount(2);
    await expect(page.locator('.tab-chip').first()).toContainText('◫ Techne');
  });

  test('note.open uses the note sheet; Back returns to the area', async ({ page }) => {
    await openAreas(page);
    await openArea(page, 'Techne');
    await page.frameLocator('iframe.area-frame').locator('#notes button', { hasText: 'Plan' }).click();
    await expect(page.locator('.note-sheet')).toContainText('Techne plan body');
    await page.locator('.note-back').click();
    await expect(page.locator('.area-bar-title')).toHaveText('Techne');
  });

  test('unforced app renders a dashboard', async ({ page }, info) => {
    await openAreas(page);
    await openArea(page, 'Unforced Development');
    const f = page.frameLocator('iframe.area-frame');
    await expect(f.locator('#s-notes')).toHaveText('3');
    await expect(f.locator('#s-msgs')).toContainText('2');
    await expect(f.locator('#feed li').first()).toContainText('Aaron');
    await mkdir('shots/t73', { recursive: true });
    await page.screenshot({ path: `shots/t73/${info.project.name}-area-unforced.png` });
  });

  test('an area without an app shows the default view', async ({ page }) => {
    await openAreas(page);
    await openArea(page, 'Sadhana');
    await expect(page.locator('iframe')).toHaveCount(0);
    await expect(page.locator('.area-default')).toContainText('Daily practice');
    await expect(page.locator('.area-msg')).toContainText('Sat twenty minutes');
    await page.getByRole('button', { name: 'Open note' }).click();
    await expect(page.locator('.note-sheet')).toBeVisible();
    await page.locator('.note-back').click();
    await page.getByRole('button', { name: 'Open room' }).click();
    await expect(page.getByRole('textbox', { name: 'Message Sadhana' })).toBeVisible();
  });

  test('area tabs restore after reload and Back goes to Areas', async ({ page }) => {
    await openAreas(page);
    await openArea(page, 'Sadhana');
    await page.reload();
    // Launch lands on Uni; the area tab itself is restored in the strip.
    await page.getByRole('tab', { name: /Sadhana/ }).click();
    await expect(page.locator('.area-bar-title')).toHaveText('Sadhana');
    await page.locator('.area-bar .note-back').click();
    await expect(page.getByRole('heading', { name: 'Areas', level: 1 })).toBeVisible();
  });
});

test.describe('platform gate', () => {
  test.use({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36' });
  test('android stays on the default view even when an app exists', async ({ page }) => {
    await bootAreas(page, 'seed');
    await openAreas(page);
    await openArea(page, 'Techne');
    await expect(page.locator('iframe')).toHaveCount(0);
    await expect(page.locator('.area-default')).toContainText('The craft of building');
    expect(await calls(page, 'vault_note').then((c: any[]) => c.filter((x) => x.args.noteRef === 'app-techne'))).toHaveLength(0);
  });
});

test.describe('hostile and benign apps', () => {
  test.beforeEach(async ({ page }) => bootAreas(page, 'test'));

  test('a benign app renders using bridge data', async ({ page }) => {
    await openAreas(page);
    await openArea(page, 'Benign');
    const f = page.frameLocator('iframe.area-frame');
    await expect(f.locator('#t')).toHaveText('Benign');
    await expect(f.locator('#n')).toHaveText('Alpha');
    await expect(f.locator('#th')).toContainText(/accent=#?\w+/);
  });

  test('a hostile app is contained', async ({ page }) => {
    const hits: string[] = [];
    await page.route('http://127.0.0.1:1436/**', (r) => { hits.push(r.request().url()); return r.abort(); });
    const events: string[] = [];
    page.on('request', (r) => { if (r.url().includes(':1436')) events.push('request ' + r.url()); });
    page.on('requestfailed', (r) => { if (r.url().includes(':1436')) events.push('failed ' + r.url() + ' ' + r.failure()?.errorText); });
    const before = page.url();
    await openAreas(page);
    await openArea(page, 'Hostile');
    const out = page.frameLocator('iframe.area-frame').locator('#out');
    await expect(out).toContainText('"flood"', { timeout: 15000 });
    const R = JSON.parse((await out.textContent())!);

    for (const k of ['fetch', 'xhr', 'ws', 'img', 'topRead', 'parentDoc', 'cookie', 'storage', 'eval']) expect(R[k], k).toMatch(/^blocked/);
    expect(R.tauri).toBe('blocked:absent');
    expect(R.parentTauri).toMatch(/^blocked/);
    expect(R.popup).toMatch(/^blocked/);
    expect(String(R.topWrite)).not.toMatch(/^LEAK/);
    // Anything the frame tried to fetch was refused by the CSP before leaving the page.
    expect(events.filter((e) => e.startsWith('request')).length).toBe(events.filter((e) => /^failed .* csp$/.test(e)).length);
    expect(events.length).toBeGreaterThan(0);
    expect(hits, 'no request reached the network').toEqual([]);
    expect(page.url()).toBe(before);
    expect(await page.locator('iframe.area-frame').getAttribute('sandbox')).toBe('allow-scripts');

    expect(R['bridge:unk']).toBe('unknown_method');
    expect(R['bridge:big']).toBe('too_large');
    expect(R['bridge:out1']).toBe('out_of_scope');
    expect(R['bridge:out2']).toBe('out_of_scope');
    expect(R['bridge:out3']).toBe('out_of_scope');
    expect(R['bridge:extra']).toBe('bad_request');
    expect(R['bridge:v2']).toBe('bad_version');
    expect(R['bridge:longid']).toBe('none');
    expect(R.stray).toBe('none');
    const flood = JSON.parse(R.flood);
    expect(flood.ok).toBeLessThanOrEqual(60);
    expect(flood.ok).toBeGreaterThan(0);
    expect(flood.ok + flood.err).toBe(100 - flood.none);
    expect(flood.err).toBeGreaterThanOrEqual(40 - 8);
    // The out-of-scope paths never reached the vault.
    const notes = (await calls(page, 'vault_note')).map((c: any) => c.args.noteRef);
    expect(notes.filter((n: string) => /Atlas|passwd|\.\./.test(n))).toEqual([]);
    expect(await calls(page, 'post_message')).toHaveLength(0);
  });
});

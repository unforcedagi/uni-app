// T-86: the octopus with tasks. Tasks are Parachute objects: the lists come from indexed vault queries, every check-off is a
// compare-and-set `state_transition`, Undo is the reverse, and a note to a level goes to that level's room through the app's own paths.
import { mkdir } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import { areaCard, bootAreas } from './areasFixture';

const SHOTS = 'scripts/browser/__shots__/t86';
const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const calls = (page: Page, cmd: string) => page.evaluate((c) => (window as any).__calls.filter((x: any) => x.cmd === c).map((x: any) => x.args), cmd);
const rows = (page: Page) => page.locator('.task-row .task-title');
const group = (page: Page, name: string) => page.locator('.work-group').filter({ has: page.getByRole('heading', { name, exact: false }) });
const infinite = (page: Page) => page.evaluate(() => document.getAnimations().filter((a) => { const t = a.effect?.getComputedTiming(); return !t || t.iterations === Infinity || !Number.isFinite(t.endTime as number); }).length);
const toCohere = async (page: Page) => { await areaCard(page, 'Techne').click(); await expect(page.getByRole('heading', { name: 'Techne', level: 1 })).toBeVisible(); await areaCard(page, 'COhere 2026').click(); await expect(page.getByRole('heading', { name: 'COhere 2026', level: 1 })).toBeVisible(); await expect(page.locator('.work-group').first()).toBeVisible(); };
const shot = async (page: Page, name: string) => {
  await mkdir(SHOTS, { recursive: true });
  const size = page.viewportSize()!;
  const file = `${SHOTS}/${name}-${size.width}x${size.height}`;
  await page.screenshot({ path: `${file}.png` });
  const tag = await page.addStyleTag({ content: 'html{filter:grayscale(1)}' });
  await page.screenshot({ path: `${file}-gray.png` });
  await tag.evaluate((n) => n.remove());
};

test.describe('tasks on the node view', () => {
  test.beforeEach(async ({ page }) => { await bootAreas(page, 'seed', { briefs: true, tree: true, tasks: true }); });

  test('Uni → Techne → COhere 2026: the right tasks, grouped You / Rooms / Others, waiting-on-you first, provenance on descendants', async ({ page }) => {
    await expect(page.locator('.work-head .brief-count')).toHaveText('9');
    await expect(group(page, 'You').locator('.task-title')).toHaveText(['T-03 COhere festival readiness', 'Decide the COhere venue', 'FY-14 FableJi remains in writing', 'T-20 Send the Q4 invoice', 'T-33 Casey call: book it', 'T-65 Sponsorship invoice draft']);
    await expect(group(page, 'Rooms').locator('.task-title')).toHaveText(['T-64 COhere app spec', 'T-80 Wire the usage guard']);
    await expect(group(page, 'Others').locator('.task-title')).toHaveText(['T-61 Techne vision page']);
    // not shown: done, archived, snoozed
    await expect(page.getByText('T-99 Already finished')).toHaveCount(0);
    await expect(page.getByText('T-98 Put away')).toHaveCount(0);
    await expect(page.getByText('T-14 A snoozed one')).toHaveCount(0);
    // rolled-up counts on the arms
    await expect(areaCard(page, 'Techne')).toHaveAttribute('aria-label', /, 7 open$/);
    await expect(page.locator('.node-badge').first()).toBeVisible();
    // vault queries: the whole tree once, tasks by state
    expect((await calls(page, 'vault_query')).some((a: any) => a.tag === 'node')).toBe(true);
    await shot(page, 'uni');

    await areaCard(page, 'Techne').click();
    await expect(page.getByRole('heading', { name: 'Techne', level: 1 })).toBeVisible();
    await expect(page.locator('.work-head .brief-count')).toHaveText('7');
    await expect(group(page, 'You').locator('.task-row').filter({ hasText: 'T-03' })).toContainText('in COhere 2026');
    await expect(group(page, 'You').locator('.task-row').filter({ hasText: 'T-33' })).not.toContainText(/ in [A-Z]/);
    const near = (await calls(page, 'vault_subtree_tasks')).filter((a: any) => a.tag === 'task' && a.root === 'Areas/Techne').at(-1);
    expect(near).toEqual({ vault: 'uni', tag: 'task', root: 'Areas/Techne', states: ['open', 'doing', 'waiting'], limit: 200 });
    expect((await calls(page, 'vault_query_meta')).filter((a: any) => a.metadata.node), 'one-request path: no two-query walk').toHaveLength(0);
    await shot(page, 'techne');

    await areaCard(page, 'COhere 2026').click();
    await expect(page.getByRole('heading', { name: 'COhere 2026', level: 1 })).toBeVisible();
    await expect(page.locator('.work-head .brief-count')).toHaveText('4');
    await expect(group(page, 'You').locator('.task-title')).toHaveText(['T-03 COhere festival readiness', 'Decide the COhere venue', 'T-65 Sponsorship invoice draft']);
    await expect(group(page, 'You').locator('.task-row').filter({ hasText: 'Decide the COhere' })).toContainText('Decide');
    await expect(group(page, 'You').locator('.task-row').filter({ hasText: 'T-03' })).toContainText('Waiting on you');
    await expect(page.locator('.task-meta', { hasText: / in (COhere|Techne|Uni)/ })).toHaveCount(0);
    await shot(page, 'cohere');
  });

  test('a vault without near/then falls back to the two-query walk and shows the same tasks', async ({ page }) => {
    await bootAreas(page, 'seed', { briefs: true, tree: true, tasks: true, nearOff: true });
    await expect(page.locator('.work-head .brief-count')).toHaveText('9');
    await areaCard(page, 'Techne').click();
    await expect(page.getByRole('heading', { name: 'Techne', level: 1 })).toBeVisible();
    await expect(page.locator('.work-head .brief-count')).toHaveText('7');
    const meta = (await calls(page, 'vault_query_meta')).filter((a: any) => a.tag === 'task' && a.metadata.node).at(-1);
    expect(meta.metadata.node.in).toEqual(expect.arrayContaining(['Areas/Techne', 'Projects/COhere/COhere 2026']));
    expect(meta.metadata.state).toEqual({ in: ['open', 'doing', 'waiting'] });
    const tried = (await calls(page, 'vault_subtree_tasks')).length;
    await areaCard(page, 'COhere 2026').click();
    await expect(page.locator('.work-head .brief-count')).toHaveText('4');
    expect((await calls(page, 'vault_subtree_tasks')).length, 'detected once, not retried').toBe(tried);
  });

  test('Mark done is a state_transition open → done; the row leaves; Undo sends the reverse', async ({ page }) => {
    await toCohere(page);
    await page.getByRole('button', { name: 'Mark done: T-65 Sponsorship invoice draft' }).click();
    await expect(rows(page).filter({ hasText: 'T-65' })).toHaveCount(0);
    expect(await calls(page, 'vault_transition')).toEqual([{ vault: 'uni', id: 'k3', field: 'state', from: 'open', to: 'done' }]);
    const undo = page.getByRole('button', { name: 'Undo' });
    await expect(undo).toBeVisible();
    await expect(page.locator('.work-head .brief-count')).toHaveText('3');
    await shot(page, 'after-done-undo');
    await undo.click();
    await expect(rows(page).filter({ hasText: 'T-65' })).toHaveCount(1);
    expect(await calls(page, 'vault_transition')).toEqual([
      { vault: 'uni', id: 'k3', field: 'state', from: 'open', to: 'done' },
      { vault: 'uni', id: 'k3', field: 'state', from: 'done', to: 'open' }]);
    await expect(page.locator('.work-head .brief-count')).toHaveText('4');
  });

  test('Undo is offered for five seconds, then goes', async ({ page }) => {
    await toCohere(page);
    await page.getByRole('button', { name: 'Mark done: T-65 Sponsorship invoice draft' }).click();
    await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Undo' })).toHaveCount(0, { timeout: 7000 });
  });

  test('the task sheet: facts, attribution, Archive, Snooze until tomorrow (guarded merge) and its undo', async ({ page }) => {
    await toCohere(page);
    await page.locator('.task-main', { hasText: 'T-03 COhere festival readiness' }).click();
    const sheet = page.getByRole('dialog');
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText('Check-in PR by Oct 12');
    await expect(sheet).toContainText('Changed by cdf67944 via api');
    for (const name of ['Mark done', 'Archive', 'Snooze until tomorrow']) await expect(sheet.getByRole('button', { name })).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Open in #Cohere' })).toBeVisible();
    for (const b of await sheet.getByRole('button').all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await shot(page, 'task-sheet');
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);

    await page.locator('.task-main', { hasText: 'T-65' }).click();
    await page.getByRole('button', { name: 'Archive' }).click();
    expect((await calls(page, 'vault_transition')).at(-1)).toEqual({ vault: 'uni', id: 'k3', field: 'state', from: 'open', to: 'archived' });
    await expect(rows(page).filter({ hasText: 'T-65' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(rows(page).filter({ hasText: 'T-65' })).toHaveCount(1);
    expect((await calls(page, 'vault_transition')).at(-1)).toEqual({ vault: 'uni', id: 'k3', field: 'state', from: 'archived', to: 'open' });

    await page.locator('.task-main', { hasText: 'T-65' }).click();
    await page.getByRole('button', { name: 'Snooze until tomorrow' }).click();
    const [patch] = await calls(page, 'vault_patch_meta');
    const t = new Date(); t.setDate(t.getDate() + 1);
    const tomorrow = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
    expect(patch).toMatchObject({ vault: 'uni', id: 'k3', metadata: { snoozed_until: tomorrow } });
    expect(typeof patch.ifUpdatedAt).toBe('string');
    await expect(rows(page).filter({ hasText: 'T-65' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(rows(page).filter({ hasText: 'T-65' })).toHaveCount(1);
    expect((await calls(page, 'vault_patch_meta')).at(-1).metadata).toEqual({ snoozed_until: null });
  });

  test('Open in #room switches to that room\'s chat', async ({ page }) => {
    await toCohere(page);
    await page.locator('.task-main', { hasText: 'T-65' }).click();
    await page.getByRole('button', { name: 'Open in #Cohere' }).click();
    await expect(page.getByRole('textbox', { name: 'Message Cohere' })).toBeVisible();
  });

  test('409: changed elsewhere → says so, re-reads, never retries; 422 and other errors roll back with a message', async ({ page }) => {
    await toCohere(page);
    await page.evaluate(() => (window as any).__elsewhere('k3', 'done'));
    const before = (await calls(page, 'vault_subtree_tasks')).length;
    await page.getByRole('button', { name: 'Mark done: T-65 Sponsorship invoice draft' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'changed elsewhere' })).toBeVisible();
    await expect.poll(async () => (await calls(page, 'vault_subtree_tasks')).length).toBeGreaterThan(before);
    expect(await calls(page, 'vault_transition')).toHaveLength(1);
    await expect(rows(page).filter({ hasText: 'T-65' })).toHaveCount(0);

    await page.evaluate(() => { (window as any).__failNext = '[schema_validation] state is not one of open,doing'; });
    await page.getByRole('button', { name: 'Mark done: T-03 COhere festival readiness' }).click();
    await expect(page.getByText(/the vault refused that value/)).toBeVisible();
    await expect(rows(page).filter({ hasText: 'T-03' })).toHaveCount(1);

    await page.evaluate(() => { (window as any).__failNext = 'hub unreachable: connect'; });
    await page.getByRole('button', { name: 'Mark done: T-03 COhere festival readiness' }).click();
    await expect(page.getByText(/Couldn't mark it done: hub unreachable/)).toBeVisible();
    await expect(rows(page).filter({ hasText: 'T-03' })).toHaveCount(1);
    expect(await calls(page, 'vault_transition')).toHaveLength(3);
  });

  test('hold to talk: a voice note through the voice outbox to this level\'s room; the room is named', async ({ page }) => {
    await toCohere(page);
    const hold = page.getByRole('button', { name: /Hold to talk to #Cohere/ });
    await expect(hold).toBeVisible();
    expect((await hold.boundingBox())!.height).toBeGreaterThanOrEqual(56);
    const box = (await hold.boundingBox())!;
    await page.mouse.move(box.x + 40, box.y + 20);
    await page.mouse.down();
    await expect(page.getByRole('button', { name: /Recording for #Cohere/ })).toBeVisible();
    await page.waitForTimeout(500);
    await shot(page, 'hold-to-talk');
    await page.mouse.up();
    await expect.poll(async () => (await calls(page, 'post_message')).length).toBe(1);
    expect((await calls(page, 'prepare_voice_message'))[0]).toMatchObject({ channel: 'ch-cohere', body: '' });
    expect((await calls(page, 'post_message'))[0]).toMatchObject({ channel: 'ch-cohere', body: '' });
    expect((await calls(page, 'media_upload')).length).toBe(1);
    await expect(page.locator('.talk-status')).toContainText('Sent to #Cohere');
  });

  test('Techne\'s note goes to #Techne; a level with no room of its own uses its parent\'s', async ({ page }) => {
    await areaCard(page, 'Techne').click();
    await expect(page.getByRole('button', { name: /Hold to talk to #Techne/ })).toBeVisible();
    await page.getByRole('navigation', { name: 'Where you are' }).getByRole('button', { name: 'Uni' }).click();
    await expect(page.getByRole('button', { name: /Hold to talk to #Uni/ })).toBeVisible();
  });

  test('tap: one line of text to this level\'s room, "Sent to #room", and the room\'s last messages under the map', async ({ page }) => {
    await toCohere(page);
    await expect(page.locator('.talk-recent li')).toHaveCount(2);
    await page.getByRole('button', { name: /Hold to talk to #Cohere/ }).click();
    const input = page.getByRole('textbox', { name: 'Note to #Cohere' });
    await expect(input).toBeFocused();
    await input.fill('Venue deposit is paid');
    await input.press('Enter');
    await expect.poll(async () => (await calls(page, 'post_message')).length).toBe(1);
    expect((await calls(page, 'post_message'))[0]).toMatchObject({ channel: 'ch-cohere', body: 'Venue deposit is paid', replyTo: null, media: [] });
    await expect(page.locator('.talk-status')).toHaveText('Sent to #Cohere');
    await expect(page.locator('.talk-recent li').last()).toContainText('Venue deposit is paid');
    // nothing was drafted or sent anywhere else
    expect((await calls(page, 'post_message')).every((a: any) => a.channel === 'ch-cohere')).toBe(true);
  });

  test('Android Back closes the task sheet first, then zooms out one level', async ({ page }) => {
    await toCohere(page);
    await page.locator('.task-main', { hasText: 'T-65' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    const back = () => page.evaluate(() => { const w = window as any; w.__cbs[w.__backHandler.id]({ message: {}, index: w.__backIndex ?? 0 }); w.__backIndex = (w.__backIndex ?? 0) + 1; });
    await back();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'COhere 2026', level: 1 })).toBeVisible();
    await back();
    await expect(page.getByRole('heading', { name: 'Techne', level: 1 })).toBeVisible();
  });

  test('calm: nothing loops, no overflow at three sizes, vault text stays text', async ({ page }, info) => {
    await toCohere(page);
    expect(await infinite(page)).toBe(0);
    await page.locator('.task-main', { hasText: 'T-65' }).click();
    await page.waitForTimeout(400);
    expect(await infinite(page)).toBe(0);
    await page.keyboard.press('Escape');
    const css = await page.evaluate(() => [...document.styleSheets].flatMap((s) => { try { return [...s.cssRules]; } catch { return []; } }).filter((r) => /infinite/.test(r.cssText) && /task|talk|undo|work/.test(r.cssText)).length);
    expect(css).toBe(0);
    test.skip(info.project.name !== 'desktop', 'sizes are set inside this test');
    for (const [w, h] of [[1600, 1200], [1200, 1600], [390, 844]]) {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(250);
      expect(await fits(page)).toBe(true);
      await shot(page, 'cohere');
      await page.locator('.task-main', { hasText: 'T-03' }).click();
      expect(await fits(page)).toBe(true);
      await page.keyboard.press('Escape');
    }
  });
});

test('a task title is text, never markup', async ({ page }) => {
  await bootAreas(page, 'seed', { briefs: true, tree: true, tasks: true });
  await page.evaluate(() => { (window as any).__tasks.push({ id: 'x1', path: 'Tasks/<img src=x onerror=window.__pwn=1> bold', extension: 'md', tags: ['task'], updatedAt: 'T', metadata: { node: 'Uni', state: 'open', owner: 'aaron', next: '<b>hi</b>' } }); });
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Uni', exact: true }).click();
  await areaCard(page, 'Techne').click();
  await page.getByRole('navigation', { name: 'Where you are' }).getByRole('button', { name: 'Uni' }).click();
  await expect(page.locator('.task-title', { hasText: '<img src=x' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__pwn)).toBeUndefined();
  expect(await page.locator('.task-row img').count()).toBe(0);
});

// T-335 Recipes, the first applet a room made and tends: its real folder (applet.html, applet.json, seed/*.md, all made-up recipes)
// put in a made-up `recipes` vault beside the primary one. End to end on the real build with Tauri faked (sealedAppletFixture.ts):
// the drawer's Recipes slot opens it; the grant card names exactly the recipes vault and its folder; Allow runs it; it lists, opens,
// logs "we made this", edits and adds through the frame's two writes; a read outside its grant comes back empty and a write outside is refused.
// Run: pnpm test:recipes   (RECIPES_APPLET_DIR: the applet's folder; default ../uni-ops/applets/recipes beside this checkout)
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { bootSealed, openFromDrawer, type FixtureNote } from './sealedAppletFixture';

const DIR = resolve(process.env.RECIPES_APPLET_DIR ?? new URL('../../../uni-ops/applets/recipes', import.meta.url).pathname);
const has = existsSync(join(DIR, 'applet.html'));
const html = has ? readFileSync(join(DIR, 'applet.html'), 'utf8') : '';
const manifest = has ? JSON.parse(readFileSync(join(DIR, 'applet.json'), 'utf8')) : {};
const seeds: FixtureNote[] = has ? readdirSync(join(DIR, 'seed')).filter((f) => f.endsWith('.md')).map((f, i) => ({
  id: `recipe-${i}`, vault: 'recipes', path: `Recipes/${f.replace(/\.md$/, '')}`, tags: ['recipe'], content: readFileSync(join(DIR, 'seed', f), 'utf8'),
})) : [];
const OUTSIDE: FixtureNote[] = [
  { id: 'pantry-stock', vault: 'recipes', path: 'Pantry/Stock', content: 'PANTRY-WORDS: a made-up note outside the grant.' },
  { id: 'uni-diary', vault: 'uni', path: 'Recipes/Diary', content: 'OTHER-VAULT-WORDS: same folder, another vault.' },
];

const frame = (page: Page) => page.frameLocator('iframe.area-frame');
const card = (page: Page) => page.getByRole('region', { name: 'Recipes is asking for access' });
const calls = (page: Page, cmd: string) => page.evaluate((c) => (window as any).__calls.filter((x: any) => x.cmd === c).map((x: any) => x.args), cmd);
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

test.skip(!has, `no applet folder at ${DIR} (set RECIPES_APPLET_DIR)`);
test.beforeEach(async ({ page }) => { page.on('pageerror', (e) => { throw e; }); });

async function boot(page: Page) {
  const { contract, id, name, ...v2 } = manifest;
  expect([contract, id, name]).toEqual([2, 'recipes', 'Recipes']);
  await bootSealed(page, { granted: false, vaults: ['recipes'], applets: [{ id, name, html, v2, vault: 'recipes', path: 'Applets/Recipes' }], data: [...seeds, ...OUTSIDE] });
  await openFromDrawer(page, 'Recipes');
}

test('the Recipes slot opens the applet; the card names exactly the recipes vault; it lists, opens, logs a making, edits and adds', async ({ page }) => {
  await boot(page);
  await expect(page.getByText("Recipes isn't built yet.")).toHaveCount(0);
  // the card: one row, the recipes vault, its one folder, marked because it changes notes; and nothing else
  await expect(card(page).locator('.grant-line dt')).toHaveText(['recipes vault']);
  await expect(card(page).locator('.grant-line dd')).toHaveText(['Read, add and change notes in Recipes/']);
  await expect(card(page).locator('.grant-outside')).toHaveCount(1);
  await expect(card(page)).toContainText("It can't send messages, delete notes, change notes anywhere else or reach the internet.");
  await expect(page.locator('iframe')).toHaveCount(0);
  await card(page).getByRole('button', { name: 'Allow' }).click();

  const f = frame(page);
  await expect(f.locator('.row')).toHaveText(['Green herb rice', 'Lemon lentil soup', 'Skillet cornbread']);
  await expect(f.locator('#count')).toHaveText('3 recipes');
  // open one, log that we made it today
  await f.getByRole('button', { name: 'Lemon lentil soup' }).click();
  await expect(f.locator('h2')).toHaveText('Lemon lentil soup');
  // it read its own vault: the listing and the recipe came from `recipes`
  expect((await calls(page, 'vault_note')).filter((a: any) => a.noteRef === 'recipe-1').map((a: any) => a.vault)).toEqual(['recipes']);
  expect((await calls(page, 'vault_paths')).map((a: any) => a.vault)).toContain('recipes');
  await expect(f.locator('.made')).toContainText('Made twice');
  await f.getByRole('button', { name: 'We made this today' }).click();
  await expect(f.locator('.made')).toContainText('Made 3 times');
  let saves = await calls(page, 'vault_save');
  expect(saves).toHaveLength(1);
  expect(saves[0]).toMatchObject({ vault: 'recipes', id: 'recipe-1', force: false });
  expect(saves[0].content).toContain(`## Made\n- 2026-10-12\n- 2026-11-02\n- ${today()}\n`);

  // edit: new notes, saved at the revision it read
  await f.getByRole('button', { name: 'Edit' }).click();
  await f.locator('#f-notes').fill('Better the next day. Made-up note: add chili flakes.');
  await f.getByRole('button', { name: 'Save' }).click();
  await expect(f.locator('.notes')).toHaveText('Better the next day. Made-up note: add chili flakes.');
  saves = await calls(page, 'vault_save');
  expect(saves).toHaveLength(2);
  expect(saves[1].content).toContain('## Notes\nBetter the next day. Made-up note: add chili flakes.\n');
  expect(saves[1].content).toContain('## Ingredients\n- 1 cup red lentils, rinsed\n');

  // add a new one: a note in Recipes/ of the recipes vault, and the list shows it at once
  await f.getByRole('button', { name: '← All recipes' }).click();
  await f.getByRole('button', { name: 'Add a recipe' }).click();
  await f.locator('#f-title').fill('Toasted oat porridge');
  await f.locator('#f-tags').fill('breakfast');
  await f.locator('#f-ingredients').fill('1 cup oats\n2 cups milk\npinch of salt');
  await f.locator('#f-steps').fill('Toast the oats dry.\nAdd milk and salt; simmer 5 minutes.');
  await f.getByRole('button', { name: 'Add to the book' }).click();
  await expect(f.locator('h2')).toHaveText('Toasted oat porridge');
  const creates = await calls(page, 'vault_create');
  expect(creates).toEqual([{ vault: 'recipes', path: 'Recipes/Toasted oat porridge', content: expect.stringContaining('# Toasted oat porridge\n\nTags: breakfast\n') }]);
  expect(creates[0].content).toContain('## Steps\n1. Toast the oats dry.\n2. Add milk and salt; simmer 5 minutes.\n');
  await expect(f.locator('.row')).toHaveText(['Green herb rice', 'Lemon lentil soup', 'Skillet cornbread', 'Toasted oat porridge']);
});

test('outside its grant: a read comes back empty, a write is refused, and nothing reached the vault writer', async ({ page }) => {
  await boot(page);
  await card(page).getByRole('button', { name: 'Allow' }).click();
  const f = frame(page);
  await expect(f.locator('.row')).toHaveCount(3);
  const R = await page.frames().find((x) => x !== page.mainFrame() && x.url() === 'about:srcdoc')!.evaluate(async () => {
    const u = (window as any).uni;
    const go = async (path: string, init?: RequestInit) => { const r = await u.frameFetch('https://vault.invalid' + path, init); return { status: r.status, body: await r.text() }; };
    return {
      byPath: await u.vault.getNote('Pantry/Stock'),
      byId: await u.vault.getNote('pantry-stock'),
      list: await go('/api/notes?path_prefix=' + encodeURIComponent('Pantry/')),
      otherVault: await u.vault.getNote('uni-diary'),
      writeOutside: await go('/api/notes', { method: 'POST', body: JSON.stringify({ path: 'Pantry/Planted', content: 'x' }) }),
      rewriteOwnCode: await go('/api/notes/applet-recipes', { method: 'PATCH', body: JSON.stringify({ content: '<p>x</p>', if_updated_at: '2026-11-09T10:00:00Z' }) }),
      tagged: await go('/api/notes', { method: 'POST', body: JSON.stringify({ path: 'Recipes/Planted', content: 'x', tags: ['applet'] }) }),
      remove: await go('/api/notes/recipe-0', { method: 'DELETE' }),
    };
  });
  expect(R.byPath).toBeNull();
  expect(R.byId).toBeNull();
  expect(R.otherVault).toBeNull();
  expect(R.list.status).toBe(403);
  expect(R.writeOutside.status).toBe(403);
  expect(R.rewriteOwnCode.status).toBe(404); // its own note sits outside Recipes/: absent to it, never changed
  expect(R.tagged.status).toBe(400);
  expect(R.remove.status).toBe(405);
  expect(JSON.stringify(R)).not.toMatch(/PANTRY-WORDS|OTHER-VAULT-WORDS/);
  expect(await calls(page, 'vault_create')).toEqual([]);
  expect(await calls(page, 'vault_save')).toEqual([]);
  // the other vault's same-named folder was never asked for
  expect((await calls(page, 'vault_note')).some((a: any) => a.vault === 'uni' && a.noteRef === 'uni-diary')).toBe(false);
});

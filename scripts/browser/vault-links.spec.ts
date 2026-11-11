import { test, expect, type Page } from '@playwright/test';

async function boot(page: Page, scenario: string) {
  await page.addInitScript(({ scenario }) => {
    const w = window as any;
    const ref = scenario === 'recover' ? 'Notes/Work plan extra prose' : scenario === 'render' ? 'Notes/Work plan' : 'Notes/Missing title';
    // The note opens from the saved place (uni.tabs.v2, as note-download and noteFormat open theirs); 0.1.46's migration of the old
    // uni.tabs.v1 strip reopens only a surface, never a note, so a v1 note tab now lands on the home.
    localStorage.setItem('uni.tabs.v2', JSON.stringify({ v: 1, tabs: [{ id: 'note', kind: 'note', title: ref, note: { hub: null, vault: scenario === 'render' ? 'uni' : 'parachute', ref, recover: true } }], active: 'note', recent: ['note'] }));
    w.noteCalls = [];
    w.searchCalls = [];
    w.openLinks = [];
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: () => 1,
      invoke: async (cmd: string, args: any) => {
        switch (cmd) {
          case 'identity_status': return { paired: true, pubkey: 'a'.repeat(64) };
          case 'get_identity': return 'a'.repeat(64);
          case 'get_npub': return 'test';
          case 'get_rooms': return [{ id: 'test', name: 'Test room', unread: 0 }];
          case 'get_members': case 'get_messages': case 'search': return [];
          // the second vault is one a wikilink may name (SHORTHAND_VAULTS in src/vaultlinks.ts); any other prefix reads as part of the path
          case 'vault_list': return ['uni', 'parachute'];
          case 'journal_config': return { hub: 'https://uni-1.example.ts.net' };
          case 'refresh': return { total_items: 0, channel_errors: {}, truncated_channels: [] };
          case 'open_link': w.openLinks.push(args.url); return null;
          case 'vault_note':
            // (the retired For you note: 0.2.2 never reads it; kept so an older build's read is answered)
            if (args.noteRef === '01M3ZQF7EM4ADC7HEY36D3DC3B') return { vault: 'uni', note: { id: args.noteRef, content: '' } };
            // (0.3.5's rooms registry, read at launch and on focus: not published here, which the app takes as "use the last one")
            if (args.noteRef === 'System/Rooms') throw `vault: note not found: ${args.noteRef}`;
            w.noteCalls.push(args);
            if (scenario === 'denied') throw 'vault: unauthorized';
            if (args.noteRef === 'Notes/Work plan' || args.noteRef === 'found-id' || args.noteRef === 'Notes/Title with spaces') return { hub: 'https://uni-1.example.ts.net', vault: args.vault, note: { id: 'found-id', path: 'Notes/Work plan', content: scenario === 'render' && args.vault === 'uni' ? '# Work plan\n\n[[parachute:Notes/Title with spaces#Heading|the proposal]]\n\n[remote](https://other.example/surface/parachute/v/uni/n/Notes/Work%20plan)' : '# Work plan\n\nPlan body', tags: [] } };
            throw `vault: note not found: ${args.noteRef}`;
          case 'vault_search':
            w.searchCalls.push(args);
            return [{ vault: 'parachute', id: 'found-id', path: 'Notes/Work plan', snippet: 'Plan body', mode: 'keyword', score: null }];
          default: return null;
        }
      },
    };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  }, { scenario });
  await page.goto('/');
}

test('bare reference recovers longest prefix in the right vault and persists id', async ({ page }) => {
  await boot(page, 'recover');
  await expect(page.locator('.note-body')).toContainText('Plan body');
  expect(await page.evaluate(() => (window as any).noteCalls)).toEqual([
    { vault: 'parachute', noteRef: 'Notes/Work plan extra prose' },
    { vault: 'parachute', noteRef: 'Notes/Work plan extra' },
    { vault: 'parachute', noteRef: 'Notes/Work plan' },
  ]);
  // the resolved id persists as an alias (a note tab itself is never saved since 0.1.46: the app reopens to a place, not a note)
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('uni.noteAliases.v1')!)['["parachute","Notes/Work plan extra prose"]'])).toBe('found-id');
});

test('missing reference offers scoped hits and opens a hit', async ({ page }) => {
  await boot(page, 'missing');
  await expect(page.getByText('No note named Notes/Missing title in parachute')).toBeVisible();
  await expect(page.locator('.note-error .vault-note')).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).searchCalls[0])).toEqual({ query: 'Missing title', limit: 8, mode: 'keyword', vault: 'parachute', pathPrefix: null });
  await page.locator('.note-error .vault-note').click();
  await expect(page.locator('.note-body')).toContainText('Plan body');
});

test('search all vaults opens visible prefilled search', async ({ page }) => {
  await boot(page, 'missing');
  await page.getByRole('button', { name: 'Search all vaults' }).click();
  await expect(page.getByRole('searchbox')).toBeVisible();
  await expect(page.getByRole('searchbox')).toHaveValue('Missing title');
  // T-335 the shape: search starts where you are, so from this note it is scoped to its vault (no vault filter row; "Not what you meant?" widens it)
  await expect(page.getByRole('region', { name: 'Search' })).toContainText('Searching the parachute vault');
  await page.locator('.search-hit').filter({ hasText: 'Work plan' }).click();
  await expect(page.locator('.note-body')).toContainText('Plan body');
});

test('authorization errors do not retry or search and retain Parachute action', async ({ page }) => {
  await boot(page, 'denied');
  // r18: a failed read says so in words, with Retry; the technical reason and the Parachute route sit under Details
  const failed = page.getByRole('alert').filter({ hasText: "Couldn't open this note just now." });
  await expect(failed).toBeVisible();
  await expect(failed.getByRole('button', { name: 'Retry' })).toBeVisible();
  await failed.getByText('Details').click();
  await expect(failed.getByText('vault: unauthorized')).toBeVisible();
  await expect(failed.getByRole('button', { name: 'Open in Parachute ↗' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).noteCalls.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).searchCalls.length)).toBe(0);
});

test('rendered wikilink keeps spaces, alias, heading and vault; other hubs open externally', async ({ page }) => {
  await boot(page, 'render');
  await page.getByRole('link', { name: 'remote', exact: true }).click();
  expect(await page.evaluate(() => (window as any).openLinks)).toEqual(['https://other.example/surface/parachute/v/uni/n/Notes/Work%20plan']);
  await page.getByRole('link', { name: 'the proposal', exact: true }).click();
  await expect(page.locator('.note-body')).toContainText('Plan body');
  expect(await page.evaluate(() => (window as any).noteCalls.at(-1))).toEqual({ vault: 'parachute', noteRef: 'Notes/Title with spaces' });
});

// T-270: a dot in a folder name is not a file extension. The vault returns the note's extension; the note view renders
// by it, so `Projects/example.org/Launch plan` is markdown, not plain text.
import { test, expect, type Page } from '@playwright/test';

type Fake = { path: string; extension?: string; content: string };

async function boot(page: Page, note: Fake) {
  await page.addInitScript(({ note }) => {
    const w = window as any;
    localStorage.setItem('uni.tabs.v2', JSON.stringify({ v: 1, tabs: [{ id: 'note', kind: 'note', title: note.path, note: { hub: null, vault: 'uni', ref: 'dotted-id' } }], active: 'note', recent: ['note'] }));
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
          case 'vault_list': return ['uni'];
          case 'journal_config': return { hub: 'https://hub.example.ts.net' };
          case 'refresh': return { total_items: 0, channel_errors: {}, truncated_channels: [] };
          case 'vault_note':
            if (args.noteRef !== 'dotted-id') return { vault: 'uni', note: { id: args.noteRef, content: '' } };
            return { hub: 'https://hub.example.ts.net', vault: 'uni', note: { id: 'dotted-id', path: note.path, extension: note.extension, content: note.content, tags: [] } };
          default: return null;
        }
      },
    };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  }, { note });
  await page.goto('/');
  await expect(page.locator('.note-body')).toBeVisible();
}

test('a markdown note in a folder with a dot in its name renders its headings', async ({ page }) => {
  await boot(page, { path: 'Projects/example.org/Launch plan', extension: 'md', content: '# Launch plan\n\n## Goals\n\n- First step' });
  await expect(page.locator('.note-body h2')).toHaveText('Goals');
  await expect(page.locator('.note-body li')).toHaveText('First step');
  await expect(page.locator('.note-body')).not.toContainText('## Goals');
});

test('a csv note in a folder with a dot in its name renders as a table', async ({ page }) => {
  await boot(page, { path: 'Projects/example.org/budget', extension: 'csv', content: 'item,cost\nchairs,40' });
  await expect(page.locator('.note-body table')).toBeVisible();
  await expect(page.locator('.note-body td').first()).toHaveText('chairs');
});

test('a note with no extension in a folder with a dot in its name is markdown', async ({ page }) => {
  await boot(page, { path: 'Projects/example.org/Launch plan', content: '# Launch plan\n\n## Goals\n\n- First step' });
  await expect(page.locator('.note-body h2')).toHaveText('Goals');
  await expect(page.locator('.note-body')).not.toContainText('## Goals');
});

test('a code note in a folder with a dot in its name is highlighted by its extension', async ({ page }) => {
  await boot(page, { path: 'Projects/example.org/build', extension: 'ts', content: 'const answer: number = 42;' });
  await expect(page.locator('.note-body pre code.language-typescript')).toHaveText('const answer: number = 42;');
});

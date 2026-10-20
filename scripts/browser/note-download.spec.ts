// T-204: "Download .md" in the note view. The save command is mocked as a real
// browser download of exactly what the app hands it, so each test checks a file:
// its bytes against the fixture note and its name against the sanitised title.
import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import fixture from '../fixtures/t204-notes.json' with { type: 'json' };

type FixtureNote = (typeof fixture.notes)[number];

async function boot(page: Page, note: FixtureNote) {
  await page.addInitScript(({ note }) => {
    const w = window as any;
    localStorage.setItem('uni.tabs.v2', JSON.stringify({ v: 1, tabs: [{ id: 'note', kind: 'note', title: note.id, note: { hub: null, vault: 'uni', ref: note.id } }], active: 'note', recent: ['note'] }));
    w.shares = [];
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
            if (args.noteRef !== note.id) return { vault: 'uni', note: { id: args.noteRef, content: '' } };
            return { hub: 'https://hub.example.ts.net', vault: 'uni', note: { id: note.id, extension: (note as any).extension, path: note.path, createdAt: note.createdAt, updatedAt: note.updatedAt, content: note.content, tags: [] } };
          case 'note_download': {
            // What the desktop Save dialog or Android's Downloads would get: these bytes under this name.
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([new TextEncoder().encode(args.text)], { type: 'text/markdown' }));
            a.download = args.name;
            document.body.append(a);
            a.click();
            a.remove();
            return `~/Downloads/${args.name}`;
          }
          case 'note_share': w.shares.push(args); return null;
          default: return null;
        }
      },
    };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  }, { note });
  await page.goto('/');
  await expect(page.locator('.note-body')).toBeVisible();
}

async function download(page: Page) {
  const [file] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download .md' }).click()]);
  return { name: file.suggestedFilename(), bytes: await readFile((await file.path())!) };
}

for (const note of fixture.notes) {
  test(`Download .md saves "${note.expectedName.slice(0, 24)}…" byte for byte`, async ({ page }) => {
    await boot(page, note);
    const file = await download(page);
    expect(file.name).toBe(note.expectedName);
    expect(Buffer.byteLength(file.name)).toBeLessThanOrEqual(123);
    expect(file.bytes.equals(Buffer.from(note.content, 'utf8'))).toBe(true);
    await expect(page.getByText(`Saved to ~/Downloads/${note.expectedName}`)).toBeVisible();
  });
}

test('front matter is off by default; turned on, it adds path and dates and is remembered', async ({ page }) => {
  const note = fixture.notes[0];
  await boot(page, note);
  await page.getByRole('button', { name: 'Download options' }).click();
  const toggle = page.getByRole('checkbox', { name: /front matter/ });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  const file = await download(page);
  const head = `---\npath: "${note.path}"\ncreated: "${note.createdAt}"\nupdated: "${note.updatedAt}"\n---\n`;
  expect(file.bytes.equals(Buffer.from(head + note.content, 'utf8'))).toBe(true);
  await page.reload();
  await expect(page.locator('.note-body')).toBeVisible();
  await page.getByRole('button', { name: 'Download options' }).click();
  await expect(page.getByRole('checkbox', { name: /front matter/ })).toBeChecked();
});

test('a note with its own front matter keeps it; only missing keys are added inside', async ({ page }) => {
  const note = fixture.notes[2];
  await boot(page, note);
  await page.getByRole('button', { name: 'Download options' }).click();
  await page.getByRole('checkbox', { name: /front matter/ }).check();
  const file = await download(page);
  const expected = `---\npath: "${note.path}"\ncreated: "${note.createdAt}"\nupdated: "${note.updatedAt}"\n` + note.content.slice('---\n'.length);
  expect(file.bytes.toString('utf8')).toBe(expected);
});

test('a note that is not markdown has no Download .md', async ({ page }) => {
  await boot(page, { ...fixture.notes[0], extension: 'canvas' } as FixtureNote);
  await expect(page.getByRole('button', { name: 'Copy markdown' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download .md' })).toHaveCount(0);
});

test('a failed save says why once', async ({ page }) => {
  await boot(page, fixture.notes[0]);
  await page.evaluate(() => { const w = window as any; const inner = w.__TAURI_INTERNALS__.invoke; w.__TAURI_INTERNALS__.invoke = async (cmd: string, args: any) => { if (cmd === 'note_download') throw "Couldn't save the note: Permission denied (os error 13)"; return inner(cmd, args); }; });
  await page.getByRole('button', { name: 'Download .md' }).click();
  await expect(page.getByText("Couldn't save the note: Permission denied (os error 13)", { exact: true })).toBeVisible();
});

test('Share is not offered off Android', async ({ page }) => {
  await boot(page, fixture.notes[0]);
  await page.getByRole('button', { name: 'Download options' }).click();
  await expect(page.getByRole('button', { name: 'Share…' })).toHaveCount(0);
});

test.describe('on Android', () => {
  test.use({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36' });
  test('Share hands the same file to the share sheet', async ({ page }) => {
    const note = fixture.notes[0];
    await boot(page, note);
    await page.getByRole('button', { name: 'Download options' }).click();
    await page.getByRole('button', { name: 'Share…' }).click();
    const shares = await page.evaluate(() => (window as any).shares);
    expect(shares).toEqual([{ name: note.expectedName, text: note.content, title: 'Plans 10/19 🌱: draft?' }]);
  });
});

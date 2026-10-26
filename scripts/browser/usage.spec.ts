// T-295: the Claude accounts card at the top of Settings. The Tauri IPC is mocked in the page; `vault_note` for the
// usage note is answered by the test process: the made-up fixture (scripts/fixtures/usage-note.json), or, with
// USAGE_NOTE_CMD set, the real note as that command prints it (a read of the live vault; nothing is written to it).
// `usage_set_preference` is kept in window.__calls and applied to the fixture note.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const FIXTURE = JSON.parse(readFileSync(new URL('../fixtures/usage-note.json', import.meta.url), 'utf8'));
const NOW = new Date('2026-10-26T18:00:00Z'); // the fixture's Monday, noon in Denver
const LIVE = process.env.USAGE_NOTE_CMD;

type World = { note: any | null; conflictOnce: boolean; calls: { cmd: string; args: any }[] };

async function boot(page: Page, w: World) {
  await page.exposeFunction('__usage', async (cmd: string, args: any) => {
    w.calls.push({ cmd, args });
    if (cmd === 'vault_note') {
      if (args.noteRef !== 'System/Claude accounts' || args.vault !== 'uni') throw 'vault: note not found';
      if (!w.note) throw 'vault: note not found: System/Claude accounts';
      return { hub: 'https://hub.example.ts.net', vault: 'uni', note: w.note };
    }
    if (cmd === 'usage_set_preference') {
      if (w.conflictOnce) { w.conflictOnce = false; w.note.updatedAt = 'later'; throw 'conflict: note has been modified'; }
      if (args.ifUpdatedAt !== w.note.updatedAt) throw 'conflict: stale';
      w.note.metadata.account_preference = args.preference;
      w.note.updatedAt = `${w.note.updatedAt}+`;
      return { id: w.note.id, updatedAt: w.note.updatedAt };
    }
    return null;
  });
  await page.addInitScript(() => {
    const win = window as any;
    win.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } }, transformCallback: () => 1,
      invoke: async (cmd: string, args: any) => {
        switch (cmd) {
          case 'vault_note': case 'usage_set_preference': return win.__usage(cmd, args);
          case 'identity_status': return { paired: true, pubkey: 'a'.repeat(64) };
          case 'get_identity': return 'a'.repeat(64);
          case 'get_rooms': case 'get_messages': case 'get_members': case 'vault_paths': case 'journal_pending': case 'journal_list': case 'vault_list': return [];
          case 'journal_flush': return { sent: [], remaining: 0, error: null };
          case 'journal_config': return { hub: 'https://hub.example.ts.net', vault: 'uni' };
          case 'refresh': return { pubkey: 'a'.repeat(64), total_items: 0, channel_errors: {}, truncated_channels: [] };
          case 'mail_parked': case 'cal_session': case 'cal_events': throw { kind: 'unreachable', message: 'not here' };
          default: return null;
        }
      },
    };
    win.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  });
  await page.goto('/');
}

async function openSettings(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  return page.getByRole('region', { name: 'Claude accounts' }).or(page.locator('section.usage-card'));
}

test.describe('fixture', () => {
  test.skip(!!LIVE, 'live run');

  test('one tap shows both accounts: session, week, resets and pace, and who gets the next worker', async ({ page }, info) => {
    await page.clock.setFixedTime(NOW);
    await boot(page, { note: structuredClone(FIXTURE), conflictOnce: false, calls: [] });
    const card = await openSettings(page);
    await expect(card).toBeVisible();
    const a = card.getByLabel('Account A'), b = card.getByLabel('Account B');
    await expect(a).toContainText('Session0%');
    await expect(a).toContainText('Week8%');
    await expect(a).toContainText('resets Fri 7amon pace');
    await expect(b).toContainText('Session62%');
    await expect(b).toContainText('resets 3:20pm');
    await expect(b).toContainText('resets Sat 8amahead of pace');
    await expect(card).toContainText('Updated 15 min ago');
    await expect(card.getByRole('radio', { name: 'Auto' })).toHaveAttribute('aria-checked', 'true');
    await expect(card.getByRole('status')).toHaveText('Next worker: Account A (auto)');
    await card.screenshot({ path: info.outputPath('usage-card.png') });
  });

  test('the preference is one control: it sets the note, and a note the launcher rewrote meanwhile is read again', async ({ page }, info) => {
    await page.clock.setFixedTime(NOW);
    const w: World = { note: structuredClone(FIXTURE), conflictOnce: true, calls: [] };
    await boot(page, w);
    const card = await openSettings(page);
    await card.getByRole('radio', { name: 'B' }).click();
    await expect(card.getByRole('radio', { name: 'B' })).toHaveAttribute('aria-checked', 'true');
    await expect(card.getByRole('status')).toHaveText('Saved: new workers go to Account B while it has room.');
    const sets = w.calls.filter((c) => c.cmd === 'usage_set_preference');
    expect(sets.map((c) => [c.args.preference, c.args.ifUpdatedAt])).toEqual([['b', FIXTURE.updatedAt], ['b', 'later']]);
    expect(Number.isNaN(Date.parse(sets[1].args.setAt))).toBe(false);
    expect(w.note.metadata.account_preference).toBe('b');
    await card.screenshot({ path: info.outputPath('usage-card-b.png') });
    await card.getByRole('radio', { name: 'Auto' }).click();
    await expect(card.getByRole('radio', { name: 'Auto' })).toHaveAttribute('aria-checked', 'true');
    expect(w.note.metadata.account_preference).toBe('auto');
  });

  test('no usage note on this install: Settings has no card', async ({ page }) => {
    await boot(page, { note: null, conflictOnce: false, calls: [] });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('button', { name: /Forget this device key/ })).toBeVisible();
    await expect(page.locator('section.usage-card')).toHaveCount(0);
  });
});

test.describe('live', () => {
  test.skip(!LIVE, 'set USAGE_NOTE_CMD to a command that prints the live usage note as JSON');

  test('the real note: both accounts show the numbers it holds', async ({ page }, info) => {
    const note = JSON.parse(execSync(LIVE!, { encoding: 'utf8' }));
    const doc = note.metadata.claude_accounts;
    await boot(page, { note, conflictOnce: false, calls: [] });
    const card = await openSettings(page);
    await expect(card).toBeVisible();
    for (const acct of doc.accounts) {
      const row = card.getByLabel(`Account ${acct.name.toUpperCase()}`);
      const passed = (x: any) => x?.resets_at && Date.parse(x.resets_at) <= Date.now();
      await expect(row).toContainText(`Session${passed(acct.session) ? 0 : Math.round(acct.session.used)}%`);
      await expect(row).toContainText(`Week${passed(acct.week) ? 0 : Math.round(acct.week.used)}%`);
    }
    await card.screenshot({ path: info.outputPath('usage-card-live.png') });
    await page.screenshot({ path: info.outputPath('settings-live.png') });
  });
});

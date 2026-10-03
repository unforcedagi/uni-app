import { mkdir } from 'node:fs/promises';
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as any;
    w.updated = '2026-10-01T12:00:00Z';
    w.content = '# For you\n\n- Walk in the morning light\n  - nested\n* Make time for a quiet conversation\n```\n- code\n```\n- Read something slowly';
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } }, transformCallback: () => 1,
      invoke: async (cmd: string, args: any) => {
        switch (cmd) {
          case 'identity_status': return { paired: true, pubkey: 'a'.repeat(64) };
          case 'get_identity': return 'a'.repeat(64);
          case 'get_npub': return 'test';
          case 'get_rooms': return [{ id: 'uni-room', name: 'Uni', unread: 0 }, { id: 'garden', name: 'Garden', unread: 2 }];
          case 'get_messages': return args.channel === 'uni-room' ? [
            { ref: 'hello', channel: 'uni-room', author: 'a'.repeat(64), author_name: 'Aaron', ts: 1790942400, body: 'I want to make a little more room for quiet today.', mentions_me: false, root: null, parent: null, mentions: [], reply_count: 0, last_reply_ts: null, edited: false, reactions: [] },
            { ref: 'reply', channel: 'uni-room', author: 'b'.repeat(64), author_name: 'Uni', ts: 1790942460, body: 'Start with one small thing. A walk in the morning light, a page in your journal, or a conversation you have been meaning to make time for.', mentions_me: false, root: null, parent: null, mentions: [], reply_count: 0, last_reply_ts: null, edited: false, reactions: [] },
          ] : [];
          case 'get_members': case 'vault_paths': case 'journal_pending': return [];
          case 'journal_list': return [{ id: 'journal-one', path: 'Notes/2026/10-01/09-00-00', created_at: '2026-10-01T15:00:00Z', content: 'The morning feels spacious. I want to carry a little of that into the rest of the day.', source: 'text', entry_id: 'one', tags: [], pending: false }];
          case 'vault_list': return ['uni', 'garden'];
          case 'vault_note': return { hub: 'https://example.invalid', vault: 'uni', note: { id: '01M3ZQF7EM4ADC7HEY36D3DC3B', path: 'For you.md', extension: 'md', content: w.content, updatedAt: w.updated } };
          case 'journal_config': return { hub: 'https://example.invalid', vault: 'uni' };
          case 'journal_flush': return { sent: [], remaining: 0, error: null };
          case 'refresh': return { total_items: 0, channel_errors: {}, truncated_channels: [] };
          default: return null;
        }
      },
    };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  });
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'Message Uni' })).toBeVisible();
});

test('Rail surfaces, overlay panels, focus and phone list', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const rail = page.getByRole('navigation', { name: 'Main navigation' });
  const shot = async (name: string) => {
    if (!phone) {
      const dir = '/home/uni/Code/uni-sketches/t21/built';
      await mkdir(dir, { recursive: true });
      await page.screenshot({ path: `${dir}/${info.project.name}-${name}.png` });
    }
  };
  if (phone) {
    await expect(rail).toBeHidden();
    await page.getByRole('button', { name: 'Back to conversations', exact: true }).click();
    await expect(page.locator('.journal-room')).toBeVisible();
    await expect(page.locator('.for-you-room')).toContainText('3 recommendations');
    await page.locator('.journal-room').click();
  } else {
    await expect(rail).toBeVisible();
    expect((await page.locator('.conversation').boundingBox())!.x).toBeLessThanOrEqual(80);
    await expect(rail.getByLabel('Unread rooms')).toBeVisible();
    await shot('uni');
    await rail.getByRole('button', { name: 'Journal', exact: true }).click();
  }
  const writing = page.getByRole('textbox', { name: 'Journal entry', exact: true });
  await expect(writing).toBeVisible();
  expect((await writing.boundingBox())!.height).toBeGreaterThanOrEqual(page.viewportSize()!.height * .4);
  await writing.fill('A little room to think.');
  await shot('journal');
  await page.getByRole('button', { name: 'Focus', exact: true }).click();
  await expect(rail).toBeHidden();
  await expect(page.locator('.tab-strip')).toBeHidden();
  await shot('focus');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Focus' })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Focus' }).click();
  await page.getByRole('button', { name: 'Focus' }).click();
  if (phone) await page.getByRole('button', { name: 'Back to conversations', exact: true }).click();
  const fy = phone ? page.locator('.for-you-room') : rail.getByRole('button', { name: 'For you', exact: true });
  if (!phone) { await expect(fy.locator('.rail-count')).toHaveText('3'); await expect(fy.locator('.rail-dot')).toBeVisible(); }
  await fy.click();
  await expect(page.locator('.note-title')).toHaveText('For you');
  await shot('for-you');
  if (!phone) {
    await expect(fy.locator('.rail-dot')).toHaveCount(0);
    await rail.getByRole('button', { name: 'Uni', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Message Uni' })).toBeVisible();
    const before = await page.locator('.conversation').boundingBox();
    await rail.getByRole('button', { name: 'Rooms', exact: true }).click();
    await expect(page.locator('.rooms')).toBeVisible();
    expect((await page.locator('.conversation').boundingBox())!.x).toBe(before!.x);
    await shot('rooms');
    await page.locator('.rooms nav button').filter({ hasText: 'Garden' }).click();
    await expect(page.locator('.rooms')).toBeHidden();
    await expect(page.getByRole('textbox', { name: 'Message Garden' })).toBeVisible();
    await rail.getByRole('button', { name: 'Journal', exact: true }).click();
    await page.reload();
    await expect(writing).toHaveValue('A little room to think.');
    await rail.getByRole('button', { name: 'Uni', exact: true }).click();
    await page.reload();
    await expect(page.getByRole('textbox', { name: 'Message Uni' })).toBeVisible();
    await page.evaluate(() => { (window as any).updated = '2026-10-02T12:00:00Z'; (window as any).content += '\n- A new suggestion'; document.dispatchEvent(new Event('visibilitychange')); });
    await expect(fy.locator('.rail-count')).toHaveText('4');
    await expect(fy.locator('.rail-dot')).toBeVisible();
  }
});

import { expect, type Page } from '@playwright/test';

export async function bootRail(page: Page) {
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
          case 'get_members': return [{ pubkey: 'a'.repeat(64), name: 'Aaron', named: true }, { pubkey: 'b'.repeat(64), name: 'Uni' }];
          case 'vault_paths': case 'journal_pending': return [];
          case 'search_messages': case 'vault_search': return [];
          case 'vault_tree': return [{ id: 'note-one', path: 'Notes/Quiet.md' }];
          case 'journal_list': return [{ id: 'journal-one', path: 'Notes/2026/10-01/09-00-00', created_at: '2026-10-01T15:00:00Z', content: 'The morning feels spacious. I want to carry a little of that into the rest of the day.', source: 'text', entry_id: 'one', tags: [], pending: false }];
          case 'vault_list': return ['uni', 'garden'];
          case 'vault_note':
            if (args.noteRef === 'stale-note') return { hub: 'https://example.invalid', vault: 'uni', note: { id: 'stale-note', path: 'ATLAS — Phase 02B.md', extension: 'md', content: '# ATLAS — Phase 02B\n\nA previous note.' } };
            return { hub: 'https://example.invalid', vault: 'uni', note: { id: '01M3ZQF7EM4ADC7HEY36D3DC3B', path: 'For you.md', extension: 'md', content: w.content, updatedAt: w.updated } };
          case 'journal_config': return { hub: 'https://example.invalid', vault: 'uni' };
          case 'journal_flush': return { sent: [], remaining: 0, error: null };
          case 'refresh': return { pubkey: 'a'.repeat(64), total_items: 0, channel_errors: {}, truncated_channels: [] };
          default: return null;
        }
      },
    };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  });
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'Message Uni' })).toBeVisible();
}

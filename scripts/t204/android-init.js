// T-204 on the Android emulator: the emulator is not paired, so vault_note is answered here with the fixture note
// (the driver fills in NOTE); Download .md and Share go to the real note_download / note_share (Rust → the
// Kotlin FilesPlugin → MediaStore Downloads / the share sheet). Everything else is mocked.
if (window.top === window) (function () {
  const w = window;
  // Injected before Tauri's own bridge exists: look it up when called.
  const real = () => w.__TAURI_INTERNALS__;
  const NOTE = __NOTE__;
  const REAL = new Set(['note_download', 'note_share', 'log_line']);
  localStorage.setItem('uni.tabs.v2', JSON.stringify({ v: 1, tabs: [{ id: 'note', kind: 'note', title: NOTE.id, note: { hub: null, vault: 'uni', ref: NOTE.id } }], active: 'note', recent: ['note'] }));
  localStorage.setItem('uni.noteDownload.frontmatter', '0');
  w.__calls = [];
  w.__T76_MOCK__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    transformCallback: (cb, once) => real().transformCallback(cb, once),
    unregisterCallback: (id) => real().unregisterCallback && real().unregisterCallback(id),
    convertFileSrc: (p, proto) => real().convertFileSrc(p, proto),
    invoke: async (cmd, args, opts) => {
      w.__calls.push(cmd);
      if (REAL.has(cmd)) return real().invoke(cmd, args, opts);
      switch (cmd) {
        case 'identity_status': return { paired: true, pubkey: 'a'.repeat(64) };
        case 'get_identity': return 'a'.repeat(64);
        case 'get_npub': return 'test';
        case 'get_rooms': return [{ id: 'garden', name: 'garden', last_message: '', last_ts: 0, mentions: false, unread: 0 }];
        case 'get_members': case 'get_messages': case 'search': return [];
        case 'vault_list': return ['uni'];
        case 'journal_config': return { hub: 'https://hub.example.ts.net' };
        case 'refresh': return { pubkey: 'a'.repeat(64), total_items: 0, channel_errors: {}, truncated_channels: [] };
        case 'vault_note':
          if (args.noteRef !== NOTE.id) return { vault: 'uni', note: { id: args.noteRef, content: '' } };
          return { hub: 'https://hub.example.ts.net', vault: 'uni', note: { id: NOTE.id, path: NOTE.path, createdAt: NOTE.createdAt, updatedAt: NOTE.updatedAt, content: NOTE.content, tags: [] } };
        default: return null;
      }
    },
  };
  w.__T76_MOCK_EVT__ = { unregisterListener: () => {} };
})();

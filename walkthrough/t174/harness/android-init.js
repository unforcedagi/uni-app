// T-174 Android run: injected over CDP before the page loads (harness APK built with UNI_T76=1). Rooms and messages
// are mocked; media_save / media_open / media_bytes / media_stream / relay_origin are the real commands. The test
// files are already in the app's media cache (no key on the emulator), so they verify by hash without a fetch.
(function () {
  if (window.top !== window) return;
  const w = window;
  const real = () => w.__TAURI_INTERNALS__;
  const PDF = '60cfa571f344a9e1c4a57e6fdfb6b03b480318674af204978c9ba39ef1ec6d3b';
  const MP4 = 'fc17a6aad1586839a26ba0aaf47dc8b11a9f12b8e2172d5ac28449003a0849e6';
  const JPG = '7f2120ec9cd0537c25b8be3826b6930e4aa0a03523be7e50fd35ea1517d2fb05';
  const now = Math.floor(Date.now() / 1000);
  const messages = (O) => {
    const media = (sha, ext, mime, filename, size, dim = null) => ({ url: `${O}/media/${sha}.${ext}`, mime, sha256: sha, size, dim, blurhash: null, alt: null, filename });
    const msg = (ref, ts, body, m) => ({ ref, channel: 'field-notes', author: 'b'.repeat(64), author_name: 'Robin', ts, body, mentions_me: false, root: null, parent: null, mentions: [], reply_count: 0, last_reply_ts: null, edited: false, reactions: [], media: [m] });
    return [
      msg('m1', now - 240, 'Here is the Q3 report', media(PDF, 'pdf', 'application/pdf', 'Q3 report.pdf', 175603)),
      msg('m2', now - 180, 'Recording from Thursday', media(MP4, 'mp4', 'video/mp4', 'class.mp4', 36665525, '1280x720')),
      msg('m3', now - 120, 'The garden this morning', media(JPG, 'jpg', 'image/jpeg', 'garden.jpg', 51421, '1200x800')),
    ];
  };
  // media_bytes (image display) needs the account key even for a cached file, and the emulator is not paired:
  // the image card shows the same JPEG from here (the driver fills in its bytes). Saving it is the real command.
  const PHOTO = '__PHOTO_B64__';
  const REAL = new Set(['media_save', 'media_open', 'media_stream', 'media_pin', 'media_release', 'relay_origin', 'log_line']);
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
        case 'get_rooms': return [{ id: 'field-notes', name: 'field-notes', last_message: 'The garden this morning', last_ts: now - 120, mentions: false, unread: 0 }];
        case 'get_members': return [{ pubkey: 'b'.repeat(64), name: 'Robin', named: true }];
        case 'get_messages': return messages(await real().invoke('relay_origin'));
        case 'media_bytes':
          if (args.sha === JPG) return Uint8Array.from(atob(PHOTO), (c) => c.charCodeAt(0)).buffer;
          return real().invoke(cmd, args, opts);
        case 'vault_list': return [];
        case 'journal_config': return { hub: 'test' };
        case 'refresh': return { pubkey: 'a'.repeat(64), total_items: 3, channel_errors: {}, truncated_channels: [] };
        default: return null;
      }
    },
  };
  w.__T76_MOCK_EVT__ = { unregisterListener: () => {} };
})();

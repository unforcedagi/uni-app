// T-204 real Linux build: the note comes from the stand-in hub through the real vault_note, and Download .md goes
// to the real note_download (system Save dialog, file written by Rust). Rooms and the rest are mocked.
// run-desktop.sh prepends `const T204 = { noteId, frontmatter }`. Results go to $UNI_T76_DIR.
if (window.top === window) (function () {
  const w = window;
  const real = w.__TAURI_INTERNALS__;
  w.__T76_REAL = real;
  const REAL = new Set(['vault_note', 'note_download', 't76_write', 't76_read', 'log_line']);
  const out = (name, v) => real.invoke('t76_write', { name, contents: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }).catch(() => {});
  localStorage.setItem('uni.tabs.v2', JSON.stringify({ v: 1, tabs: [{ id: 'note', kind: 'note', title: T204.noteId, note: { hub: null, vault: 'uni', ref: T204.noteId } }], active: 'note', recent: ['note'] }));
  localStorage.setItem('uni.noteDownload.frontmatter', T204.frontmatter ? '1' : '0');
  w.__T76_MOCK__ = {
    metadata: { currentWindow: { label: 't76' }, currentWebview: { label: 't76' } },
    transformCallback: (cb) => real.transformCallback(cb),
    unregisterCallback: (id) => real.unregisterCallback && real.unregisterCallback(id),
    convertFileSrc: (p, proto) => real.convertFileSrc(p, proto),
    invoke: async (cmd, args, opts) => {
      if (REAL.has(cmd)) return real.invoke(cmd, args, opts);
      switch (cmd) {
        case 'identity_status': return { paired: true, pubkey: 'a'.repeat(64) };
        case 'get_identity': return 'a'.repeat(64);
        case 'get_npub': return 'test';
        case 'get_rooms': return [{ id: 'garden', name: 'garden', last_message: '', last_ts: 0, mentions: false, unread: 0 }];
        case 'get_members': case 'get_messages': case 'search': return [];
        case 'vault_list': return ['uni'];
        case 'journal_config': return { hub: 'http://127.0.0.1:18204' };
        case 'refresh': return { pubkey: 'a'.repeat(64), total_items: 0, channel_errors: {}, truncated_channels: [] };
        default: return null;
      }
    },
  };
  w.__T76_MOCK_EVT__ = { unregisterListener: () => {} };

  const log = [];
  const step = (s, extra) => { log.push({ t: Math.round(performance.now()), s, ...extra }); out('progress.json', log); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (f, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const v = f(); if (v) return v; await sleep(100); } return null; };
  const mark = (name) => out('mark-' + name, String(Date.now()));
  const waitFile = async (name, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await real.invoke('t76_read', { name }).catch(() => null); if (v) return v; await sleep(150); } return null; };
  addEventListener('error', (e) => step('window error', { msg: String(e.message) }));
  addEventListener('unhandledrejection', (e) => step('unhandled', { msg: String(e.reason) }));
  (async () => {
    try {
      const body = await until(() => document.querySelector('.note-body'), 30000);
      if (!body) throw new Error('note did not open: ' + (document.querySelector('.note-error')?.textContent || 'no error shown'));
      step('note open', { title: document.querySelector('.note-title')?.textContent });
      mark('note');
      await sleep(1500);
      const go = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Download .md');
      if (!go) throw new Error('no Download .md button');
      go.click();
      step('clicked Download .md');
      mark('dialog');
      // The GTK Save dialog opens with the name filled in and Downloads open; atspi_save.py presses its Save button.
      await sleep(2000);
      if (T204.manual) await sleep(T204.manual);
      else {
        await out('dialog.req', '1');
        const ack = await waitFile('dialog.ack', 20000);
        step('dialog', { ack, seen: JSON.parse((await real.invoke('t76_read', { name: 'dialog.json' }).catch(() => null)) || '{}') });
        if (ack !== 'pressed') throw new Error('Save dialog not answered: ' + ack);
      }
      const toast = await until(() => [...document.querySelectorAll('body *')].find((e) => e.children.length === 0 && /^(Saved to|Couldn't save)/.test(e.textContent || '')), 15000);
      step('result', { toast: toast?.textContent ?? null });
      mark('saved');
      await sleep(2500);
      await out(toast && toast.textContent.startsWith('Saved to') ? 'done' : 'error.txt', toast?.textContent ?? 'no confirmation');
    } catch (e) {
      step('error', { msg: String(e) });
      await out('error.txt', String(e && e.stack || e));
    }
  })();
})();

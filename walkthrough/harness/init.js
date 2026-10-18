// T-172 real-webview run: rooms and messages are mocked; media_stream, relay_origin and convertFileSrc go to the
// real Rust core (window.__T76_REAL = the real __TAURI_INTERNALS__), which fetches from the local Blossom stand-in.
if (window.top === window) (function () {
  const w = window;
  const real = w.__TAURI_INTERNALS__;
  w.__T76_REAL = real;
  const SHA = 'fc17a6aad1586839a26ba0aaf47dc8b11a9f12b8e2172d5ac28449003a0849e6', BIG = 'e'.repeat(64), O = 'http://127.0.0.1:18172';
  const out = (name, v) => real.invoke('t76_write', { name, contents: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }).catch(() => {});
  const msg = (ref, ts, body, media) => ({ ref, channel: 'atlas-teaching', author: 'b'.repeat(64), author_name: 'Test member', ts, body, mentions_me: false, root: null, parent: null, mentions: [], reply_count: 0, last_reply_ts: null, edited: false, reactions: [], media });
  const now = Math.floor(Date.now() / 1000);
  const messages = [
    msg('m1', now - 120, 'Thursday class recording (35 MB)', [{ url: `${O}/media/${SHA}.mp4`, mime: 'video/mp4', sha256: SHA, size: 36665525, dim: '1280x720', blurhash: null, alt: null, filename: 'teaching-clip.mp4' }]),
    msg('m2', now - 60, 'And the full-day recording', [{ url: `${O}/media/${BIG}.mp4`, mime: 'video/mp4', sha256: BIG, size: 600 * 1024 * 1024, dim: '1280x720', blurhash: null, alt: null, filename: 'full-day.mp4' }]),
  ];
  const REAL = new Set(['media_stream', 'relay_origin', 't76_write', 't76_read', 'log_line']);
  w.__calls = [];
  w.__T76_MOCK__ = {
    metadata: { currentWindow: { label: 't76' }, currentWebview: { label: 't76' } },
    transformCallback: (cb) => real.transformCallback(cb),
    unregisterCallback: (id) => real.unregisterCallback && real.unregisterCallback(id),
    convertFileSrc: (p, proto) => real.convertFileSrc(p, proto),
    invoke: async (cmd, args, opts) => {
      w.__calls.push(cmd);
      if (REAL.has(cmd)) return real.invoke(cmd, args, opts);
      switch (cmd) {
        case 'identity_status': return { paired: true, pubkey: 'a'.repeat(64) };
        case 'get_identity': return 'a'.repeat(64);
        case 'get_npub': return 'test';
        case 'get_rooms': return [{ id: 'atlas-teaching', name: 'atlas-teaching', last_message: 'And the full-day recording', last_ts: now - 60, mentions: false, unread: 0 }];
        case 'get_members': return [{ pubkey: 'b'.repeat(64), name: 'Test member', named: true }];
        case 'get_messages': return messages;
        case 'vault_list': return [];
        case 'journal_config': return { hub: 'test' };
        case 'refresh': return { pubkey: 'a'.repeat(64), total_items: 2, channel_errors: {}, truncated_channels: [] };
        default: return null;
      }
    },
  };
  w.__T76_MOCK_EVT__ = { unregisterListener: () => {} };

  // Driver: open the room, play the clip, seek, then try the 600 MB one. Results → $UNI_T76_DIR.
  const log = [];
  const step = (s, extra) => { log.push({ t: Math.round(performance.now()), s, ...extra }); out('progress.json', log); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (f, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const v = f(); if (v) return v; await sleep(100); } return null; };
  const card = (name) => [...document.querySelectorAll('button.attachment-file')].find((b) => b.textContent.includes(name));
  addEventListener('error', (e) => step('window error', { msg: String(e.message) }));
  addEventListener('unhandledrejection', (e) => step('unhandled', { msg: String(e.reason) }));
  (async () => {
    try {
      await until(() => document.body && document.body.children.length, 20000);
      step('page up');
      if (!(await until(() => card('teaching-clip'), 20000))) {
        const room = await until(() => [...document.querySelectorAll('button, a')].find((b) => /atlas-teaching/.test(b.textContent)), 15000);
        step('room link', { found: !!room }); room && room.click();
      }
      const c = await until(() => card('teaching-clip'), 20000);
      step('card', { text: c && c.textContent });
      if (!c) throw new Error('no clip card; calls: ' + w.__calls.join(','));
      c.scrollIntoView({ block: 'center' });
      await sleep(4000);
      c.click();
      step('clicked', { text: c.textContent });
      await sleep(300);
      step('loading', { text: (card('teaching-clip') || {}).textContent });
      const v = await until(() => document.querySelector('video.attachment-video'), 60000);
      if (!v) throw new Error('no video element; card: ' + (card('teaching-clip') || {}).textContent);
      step('video element', { src: v.src });
      ['loadedmetadata', 'canplay', 'playing', 'seeking', 'seeked', 'error', 'stalled'].forEach((e) => v.addEventListener(e, () => step('event ' + e, { t: v.currentTime, err: v.error && v.error.code, msg: v.error && v.error.message })));
      await until(() => v.readyState >= 1, 15000);
      if (v.paused) { try { await v.play(); step('play() ok'); } catch (e) { step('play() failed', { msg: String(e) }); v.muted = true; await v.play().catch((e2) => step('muted play failed', { msg: String(e2) })); } }
      await sleep(6000);
      step('after 6 s', { currentTime: v.currentTime, duration: v.duration, videoWidth: v.videoWidth, videoHeight: v.videoHeight, paused: v.paused, readyState: v.readyState, buffered: v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0 });
      v.currentTime = 45;
      await sleep(5000);
      step('after seek to 45 s', { currentTime: v.currentTime, paused: v.paused, readyState: v.readyState, err: v.error && v.error.code });
      v.pause();
      const b = card('full-day');
      b.scrollIntoView({ block: 'center' });
      await sleep(1500);
      b.click();
      const err = await until(() => { const x = card('full-day'); return x && /⚠/.test(x.textContent) && x.textContent; }, 30000);
      step('big file', { text: err });
      await sleep(4000);
      out('done', JSON.stringify(log));
    } catch (e) {
      step('failed', { msg: String(e) });
      out('error.txt', String(e && e.stack || e));
    }
  })();
})();

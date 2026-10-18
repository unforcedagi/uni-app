// T-174 real-webview run: rooms and messages are mocked; media_save, media_open, media_bytes, media_stream and
// relay_origin go to the real Rust core (window.__T76_REAL = the real __TAURI_INTERNALS__), which fetches from the
// local Blossom stand-in with real auth and hash checks, then saves to ~/Downloads or hands the file to xdg-open.
if (window.top === window) (function () {
  const w = window;
  const real = w.__TAURI_INTERNALS__;
  w.__T76_REAL = real;
  const PDF = '60cfa571f344a9e1c4a57e6fdfb6b03b480318674af204978c9ba39ef1ec6d3b';
  const MP4 = 'fc17a6aad1586839a26ba0aaf47dc8b11a9f12b8e2172d5ac28449003a0849e6';
  const JPG = '7f2120ec9cd0537c25b8be3826b6930e4aa0a03523be7e50fd35ea1517d2fb05';
  const GONE = 'd'.repeat(64), O = 'http://127.0.0.1:18174';
  const out = (name, v) => real.invoke('t76_write', { name, contents: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }).catch(() => {});
  const media = (sha, ext, mime, filename, size, dim = null) => ({ url: `${O}/media/${sha}.${ext}`, mime, sha256: sha, size, dim, blurhash: null, alt: null, filename });
  const msg = (ref, ts, body, m) => ({ ref, channel: 'field-notes', author: 'b'.repeat(64), author_name: 'Robin', ts, body, mentions_me: false, root: null, parent: null, mentions: [], reply_count: 0, last_reply_ts: null, edited: false, reactions: [], media: [m] });
  const now = Math.floor(Date.now() / 1000);
  const messages = [
    msg('m1', now - 240, 'Here is the Q3 report', media(PDF, 'pdf', 'application/pdf', 'Q3 report.pdf', 175603)),
    msg('m2', now - 180, 'Recording from Thursday', media(MP4, 'mp4', 'video/mp4', 'class.mp4', 36665525, '1280x720')),
    msg('m3', now - 120, 'The garden this morning', media(JPG, 'jpg', 'image/jpeg', 'garden.jpg', 51421, '1200x800')),
    msg('m4', now - 60, 'Old budget (removed from the relay)', media(GONE, 'xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'budget.xlsx', 20480)),
  ];
  const REAL = new Set(['media_save', 'media_open', 'media_bytes', 'media_stream', 'media_pin', 'media_release', 'relay_origin', 't76_write', 't76_read', 'log_line']);
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
        case 'get_rooms': return [{ id: 'field-notes', name: 'field-notes', last_message: messages[3].body, last_ts: now - 60, mentions: false, unread: 0 }];
        case 'get_members': return [{ pubkey: 'b'.repeat(64), name: 'Robin', named: true }];
        case 'get_messages': return messages;
        case 'vault_list': return [];
        case 'journal_config': return { hub: 'test' };
        case 'refresh': return { pubkey: 'a'.repeat(64), total_items: 4, channel_errors: {}, truncated_channels: [] };
        default: return null;
      }
    },
  };
  w.__T76_MOCK_EVT__ = { unregisterListener: () => {} };

  // Driver. Each step waits on what the card says; pauses leave time for the screen grabs. Results → $UNI_T76_DIR.
  const log = [];
  const step = (s, extra) => { log.push({ t: Math.round(performance.now()), s, ...extra }); out('progress.json', log); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (f, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const v = f(); if (v) return v; await sleep(100); } return null; };
  const byLabel = (label) => document.querySelector(`button[aria-label="${label}"]`);
  const group = (name) => byLabel(`Save ${name} to Downloads`)?.closest('.attachment-file-group, .attachment-media-group, .lightbox');
  const note = (name) => group(name)?.querySelector('.attachment-note')?.textContent;
  const mark = (name) => out('mark-' + name, String(Date.now()));
  addEventListener('error', (e) => step('window error', { msg: String(e.message) }));
  addEventListener('unhandledrejection', (e) => step('unhandled', { msg: String(e.reason) }));
  (async () => {
    try {
      await until(() => document.body && document.body.children.length, 20000);
      if (!(await until(() => byLabel('Open Q3 report.pdf'), 15000))) {
        const room = await until(() => [...document.querySelectorAll('button, a')].find((b) => /field-notes/.test(b.textContent)), 15000);
        room && room.click();
      }
      const pdf = await until(() => byLabel('Open Q3 report.pdf'), 20000);
      if (!pdf) throw new Error('no PDF card; calls: ' + w.__calls.join(','));
      pdf.scrollIntoView({ block: 'center' });
      await sleep(3000); mark('01-cards');
      step('cards', { pdf: pdf.textContent });

      byLabel('Save Q3 report.pdf to Downloads').click();
      step('pdf save', { note: await until(() => note('Q3 report.pdf'), 30000) });
      await sleep(2500); mark('02-pdf-saved');

      pdf.click();
      await sleep(400);
      step('pdf open', { card: (await until(() => !/Opening/.test(byLabel('Open Q3 report.pdf').textContent) && byLabel('Open Q3 report.pdf').textContent, 30000)) });
      await sleep(4500); mark('03-pdf-opened');
      await sleep(3000);

      const vid = byLabel('Save class.mp4 to Downloads');
      vid.scrollIntoView({ block: 'center' });
      await sleep(800);
      vid.click();
      await sleep(500); mark('04-video-saving');
      step('video save', { note: await until(() => note('class.mp4'), 60000) });
      await sleep(2500); mark('05-video-saved');

      // T-172: the 35 MB video plays in the app, streamed from the verified cache, and seeks.
      const play = [...document.querySelectorAll('button.attachment-file')].find((b) => b.textContent.includes('class.mp4'));
      play.click();
      await sleep(400); mark('05a-video-loading');
      const v = await until(() => document.querySelector('video.attachment-video'), 60000);
      if (!v) throw new Error('no video element');
      v.muted = true; await v.play().catch(() => {});
      await sleep(5000); mark('05b-video-playing');
      step('video playing', { t: v.currentTime, duration: v.duration, w: v.videoWidth, h: v.videoHeight, paused: v.paused, err: v.error && v.error.code });
      v.currentTime = 45;
      await sleep(3500); mark('05c-video-seeked');
      step('video after seek', { t: v.currentTime, paused: v.paused, err: v.error && v.error.code });
      v.pause();

      // The video and image have no Open button (they play / show in the app); prove the real command opens them too.
      const origin = await real.invoke('relay_origin');
      for (const [sha, ext, mime] of [[MP4, 'mp4', 'video/mp4'], [JPG, 'jpg', 'image/jpeg']]) {
        const r = await real.invoke('media_open', { url: `${origin}/media/${sha}.${ext}`, sha, mime }).then(() => 'ok', (e) => 'error: ' + e);
        step(ext + ' open (command)', { r });
        await sleep(ext === 'mp4' ? 4000 : 3000); mark('06-' + ext + '-opened');
        await sleep(3000);
      }

      const img = byLabel('Open image garden.jpg');
      img.scrollIntoView({ block: 'center' });
      await until(() => !img.disabled, 15000);
      img.click();
      const lbSave = await until(() => document.querySelector('.lightbox button[aria-label="Save garden.jpg to Downloads"]'), 5000);
      await sleep(1500); mark('07-lightbox');
      lbSave.click();
      step('image save', { note: await until(() => document.querySelector('.lightbox .attachment-note')?.textContent, 30000) });
      await sleep(2500); mark('08-image-saved');
      document.querySelector('.lightbox-close').click();

      const gone = byLabel('Save budget.xlsx to Downloads');
      gone.scrollIntoView({ block: 'center' });
      await sleep(800);
      gone.click();
      step('missing file save', { note: await until(() => note('budget.xlsx'), 30000) });
      await sleep(3000); mark('09-error');
      out('done', JSON.stringify(log));
    } catch (e) {
      step('failed', { msg: String(e) });
      out('error.txt', String(e && e.stack || e));
    }
  })();
})();

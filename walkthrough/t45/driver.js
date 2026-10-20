// T-45 walk driver (debug builds only, injected through the T-76 harness). Opens Mail from the rail and walks the
// inbox. It presses Open only on the disguised invoice.png and on budget.docx (a Word file carrying an OLE object),
// which Rust refuses before anything is written or opened; never on the real PDF (that would launch a viewer outside the walk).
// WALK=main (default) | error: the error run only shows what the first screen says.
(function () {
  if (window.top !== window) return;
  if (window.__WALK_STARTED) return; window.__WALK_STARTED = true;
  const MODE = (document.currentScript && document.currentScript.dataset.walk) || window.__WALK_MODE || 'main';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ipc = () => window.__TAURI_INTERNALS__;
  const log = []; let shotId = 0;
  const write = (name, v) => ipc().invoke('t76_write', { name, contents: typeof v === 'string' ? v : JSON.stringify(v, null, 2) });
  const read = (name) => ipc().invoke('t76_read', { name });
  let cap = null;
  function caption(text) {
    if (!cap) { cap = document.createElement('div'); cap.setAttribute('aria-hidden', 'true');
      cap.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);max-width:80%;z-index:99999;padding:10px 18px;border-radius:12px;background:rgba(20,20,16,.86);color:#fff;font:600 17px/1.35 system-ui,sans-serif;text-align:center;pointer-events:none';
      document.body.appendChild(cap); }
    cap.textContent = text; cap.style.display = text ? 'block' : 'none';
  }
  async function shot(label, text) {
    caption(text || ''); await sleep(400);
    const id = ++shotId;
    log.push({ id, label, caption: text || '', at: new Date().toISOString() });
    await write('walk-log.json', log);
    await write('shot.req', JSON.stringify({ id, label }));
    for (let i = 0; i < 100; i++) { if ((await read('shot.ack')) === String(id)) return; await sleep(100); }
  }
  async function until(fn, ms = 30000) { const t = performance.now(); while (performance.now() - t < ms) { const v = fn(); if (v) return v; await sleep(200); } return null; }
  const fail = async (what) => { log.push({ miss: what, page: (document.body.innerText || '').slice(0, 800) }); await write('walk-log.json', log); await write('error.txt', what); };
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 2 && r.height > 2; };
  const btn = (re, scope) => [...(scope || document).querySelectorAll('button')].filter(visible).find((b) => re.test((b.innerText || '').trim()) || re.test(b.getAttribute('aria-label') || ''));
  const rows = () => [...document.querySelectorAll('.mail-row')];
  async function run() {
    const mail = await until(() => btn(/^Mail$/));
    if (!mail) return fail('no Mail button on the rail');
    await sleep(1500);
    mail.click();
    if (MODE === 'error') {
      const p = await until(() => document.querySelector('.mail-problem'), 40000);
      if (!p) return fail('no problem shown');
      const more = p.querySelector('details'); if (more) more.open = true;
      await shot(window.__WALK_LABEL || '07-error', window.__WALK_CAPTION || '');
      return write('done', '1');
    }
    if (!(await until(() => rows().length >= 4))) return fail('no inbox rows');
    await shot('01-inbox', 'Mail: the Inbox, newest first. Unread mail is bold with a dot. Read-only.');
    rows()[0].click();
    if (!(await until(() => document.querySelector('.mail-text')))) return fail('plain message did not open');
    await shot('02-plain', 'A plain message reads as text. Opening it does not mark it read.');
    rows()[1].click();
    if (!(await until(() => document.querySelector('iframe.mail-html')))) return fail('html message did not open');
    await sleep(800);
    await shot('03-html', 'An HTML-only newsletter: sanitized, sealed, and its two remote images are not loaded.');
    rows()[2].click();
    if (!(await until(() => document.querySelector('.mail-attachments')))) return fail('attachment message did not open');
    await shot('04-attachment', 'Plain text first. The PDF opens through the app, never from the web page.');
    const fmt = btn(/^Show formatted$/);
    if (!fmt) return fail('no Show formatted');
    fmt.click();
    await until(() => document.querySelector('iframe.mail-html'));
    await sleep(800);
    await shot('05-formatted', 'Show formatted switches to the HTML version of the same message.');
    const disguised = btn(/^Open invoice\.png$/);
    if (!disguised) return fail('no invoice.png attachment');
    disguised.scrollIntoView({ block: 'center' });
    disguised.click();
    const note = await until(() => [...document.querySelectorAll('.mail-note')].find((n) => /contents are/.test(n.textContent || '')), 20000);
    if (!note) return fail('the disguised attachment was not refused');
    note.scrollIntoView({ block: 'center' });
    await shot('06-disguised', 'invoice.png is really an SVG, which can run script. Rust checks the bytes and refuses it.');
    const office = btn(/^Open budget\.docx$/);
    if (!office) return fail('no budget.docx attachment');
    office.scrollIntoView({ block: 'center' });
    office.click();
    const officeNote = await until(() => [...document.querySelectorAll('.mail-note')].find((n) => /Office file with macros/.test(n.textContent || '')), 20000);
    if (!officeNote) return fail('the Office file with an object was not refused');
    officeNote.scrollIntoView({ block: 'center' });
    await shot('07-office', 'budget.docx is a real Word file with an OLE object inside. Rust unzips it, reads its parts and refuses it.');
    const archive = btn(/^Archive/);
    if (!archive) return fail('no Archive mailbox');
    archive.click();
    if (!(await until(() => document.querySelector('.mail-empty')))) return fail('no empty state');
    await shot('08-empty', 'An empty mailbox says so, rather than looking broken.');
    caption('');
    await write('done', '1');
  }
  const start = () => run().catch((e) => fail('driver threw: ' + (e && e.stack || e)));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();

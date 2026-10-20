// T-45 v2 walk driver (debug builds only, injected through the T-76 harness). Opens Mail from the rail and walks both
// mailboxes on the fake bridge's made-up mail (`fake_mail_bridge <port> <key> shared`): the combined inbox, Uni's
// Inbox, a thread with Uni's draft and triage note, a search, and the attachment gates. It presses Open only on the
// disguised poster-proof.png, which Rust refuses before anything is written or opened; never on the real PDF (that would
// launch a viewer outside the walk). Each step checks what the screen shows and stops with error.txt if it is wrong.
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
  const fail = async (what) => {
    const read = document.querySelector('.mail-read');
    log.push({ miss: what, page: (document.body.innerText || '').slice(0, 800), reading: read ? read.innerText.slice(0, 2000) : null,
      buttons: [...document.querySelectorAll('.mail-read button')].map((b) => `${b.getAttribute('aria-label') || ''} | ${b.innerText.trim()} | ${b.disabled}`) });
    await write('walk-log.json', log); await shot('zz-fail', ''); await write('error.txt', what);
  };
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 2 && r.height > 2; };
  const btn = (re, scope) => [...(scope || document).querySelectorAll('button')].filter(visible).find((b) => re.test((b.innerText || '').trim()) || re.test(b.getAttribute('aria-label') || ''));
  const rows = () => [...document.querySelectorAll('.mail-row')].filter(visible);
  const tags = () => rows().map((r) => (r.querySelector('.mail-who') || {}).textContent);
  const box = (group, name) => { const g = document.querySelector(`.mail-boxes [aria-label="${group}"]`); return g && btn(new RegExp(`^${name}`), g); };
  async function run() {
    const mail = await until(() => btn(/^Mail$/));
    if (!mail) return fail('no Mail button on the rail');
    await sleep(1500);
    mail.click();
    if (MODE === 'error') {
      const p = await until(() => document.querySelector('.mail-problem'), 40000);
      if (!p) return fail('no problem shown');
      const more = p.querySelector('details'); if (more) more.open = true;
      await shot(window.__WALK_LABEL || '09-error', window.__WALK_CAPTION || '');
      return write('done', '1');
    }
    if (!(await until(() => rows().length === 6))) return fail('the combined inbox did not show six threads');
    if (tags().join(',') !== 'YOU,UNI,UNI,YOU,YOU,UNI') return fail('rows are not tagged and interleaved: ' + tags().join(','));
    await until(() => document.querySelector('.mail-row-triage'), 10000);
    await shot('01-combined', 'All inboxes: your mail and Uni\'s, newest first. Every row says YOU or UNI.');

    const uniInbox = box("Uni's mailboxes", 'Inbox');
    if (!uniInbox) return fail("no Inbox in Uni's mailboxes");
    uniInbox.click();
    if (!(await until(() => rows().length === 3 && tags().every((t) => t === 'UNI')))) return fail("Uni's Inbox did not show only Uni's mail");
    await shot('02-uni-inbox', "Uni's Inbox, in its own group with a dashed rule.");

    const all = btn(/^All inboxes/);
    all.click();
    if (!(await until(() => rows().length === 6))) return fail('back to All inboxes failed');
    rows()[0].click();
    const thread = await until(() => document.querySelector('.mail-thread'));
    if (!thread) return fail('the thread did not open');
    if (!(await until(() => document.querySelector('.mail-triage')))) return fail("no Uni's triage note in the thread");
    const reply = btn(/^Reply/, thread);
    if (!reply || !reply.disabled) return fail('Reply is not disabled');
    await shot('03-thread', "A thread, oldest first. Uni's triage note is labelled as Uni's. Reply is disabled: sending comes later.");
    const draft = thread.querySelector('.mail-card-draft');
    if (!draft || !/DRAFT · BY UNI · NOT SENT/.test(draft.textContent)) return fail("no Uni draft card");
    draft.scrollIntoView({ block: 'center' });
    await shot('04-uni-draft', "Uni's draft in your Drafts reads as a draft: by Uni, not sent.");

    const search = document.querySelector('input[type="search"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(search, 'lighthouse'); search.dispatchEvent(new Event('input', { bubbles: true }));
    search.form.requestSubmit();
    if (!(await until(() => rows().length === 1 && tags()[0] === 'UNI'))) return fail('the search did not find the one match in Uni\'s mail');
    await shot('05-search', 'Search reads both mailboxes. lighthouse is only in Uni\'s mail.');

    btn(/^Clear$/).click();
    if (!(await until(() => rows().length === 6))) return fail('clearing the search failed');
    rows()[3].click();
    const files = await until(() => document.querySelector('.mail-thread .mail-attachments'));
    if (!files) return fail('the attachment thread did not open');
    const pane = document.querySelector('.mail-read');
    const exe = btn(/setup\.exe won't open/, pane);
    if (!exe || !exe.disabled) return fail('setup.exe is not refused at once');
    const proof = btn(/^Open poster-proof\.png$/, pane);
    if (!proof) return fail('no poster-proof.png');
    proof.click();
    const note = await until(() => [...document.querySelectorAll('.mail-att-why')].find((n) => /contents are an SVG/.test(n.textContent || '')), 20000);
    if (!note) return fail('the disguised attachment was not refused');
    files.scrollIntoView({ block: 'start' });
    await shot('06-attachments', 'setup.exe is refused by its name, before anything is fetched. poster-proof.png is really an SVG: refused on Open.');
    const news = [...document.querySelectorAll('button')].filter(visible).filter((b) => /^New/.test(b.innerText.trim()));
    if (news.length !== 1 || !news[0].disabled) return fail('New is not one disabled button');
    caption('');
    await write('done', '1');
  }
  const start = () => run().catch((e) => fail('driver threw: ' + (e && e.stack || e)));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();

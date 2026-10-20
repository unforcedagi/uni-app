// T-210 walk driver (debug builds only, injected through the T-76 harness). Opens Mail on the fake bridge in `writes`
// mode (`fake_mail_bridge <port> <key> writes`: made-up mail, a bridge that offers writes, sends kept in memory) and
// walks the write side: a thread marked read on open with its tools, Uni's draft reviewed and sent by you, the sent
// copy's provenance, a new message whose sender must be picked and sent as Uni, and the "not verified" badge. Each step
// checks what the screen shows and stops with error.txt if it is wrong.
// Run: DRIVER=walkthrough/t210/driver.js with walkthrough/t45/walk.sh (see walkthrough/t210/walk.sh).
(function () {
  if (window.top !== window) return;
  if (window.__WALK_STARTED) return; window.__WALK_STARTED = true;
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
    const pane = document.querySelector('.mail-read');
    log.push({ miss: what, page: (document.body.innerText || '').slice(0, 800), reading: pane ? pane.innerText.slice(0, 2000) : null,
      buttons: [...document.querySelectorAll('.mail-read button')].map((b) => `${b.getAttribute('aria-label') || ''} | ${b.innerText.trim()} | ${b.disabled}`) });
    await write('walk-log.json', log); await shot('zz-fail', ''); await write('error.txt', what);
  };
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 2 && r.height > 2; };
  const btn = (re, scope) => [...(scope || document).querySelectorAll('button')].filter(visible).find((b) => re.test((b.innerText || '').trim()) || re.test(b.getAttribute('aria-label') || ''));
  const rows = () => [...document.querySelectorAll('.mail-row')].filter(visible);
  const has = (re) => re.test(document.querySelector('.mail-read')?.innerText || '');
  const setVal = (el, v) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const field = (name) => [...document.querySelectorAll('.mail-compose-fields label')].find((l) => l.querySelector('span')?.textContent === name)?.querySelector('input, textarea');
  async function run() {
    const mail = await until(() => btn(/^Mail$/));
    if (!mail) return fail('no Mail button on the rail');
    await sleep(1500);
    mail.click();
    if (!(await until(() => rows().length === 7))) return fail('the combined inbox did not show seven threads');
    await until(() => document.querySelector('.mail-row-triage'), 10000);
    const account = document.querySelector('.mail-account')?.textContent;
    if (account !== 'robin@example.com') return fail('the header still says read-only: ' + account);
    const news = [...document.querySelectorAll('button')].filter(visible).filter((b) => /^New$/.test(b.innerText.trim()));
    if (news.length !== 1 || news[0].disabled) return fail('New is not on');
    await shot('01-writes-on', 'The bridge offers writes: New is on, and Mail no longer says read-only.');

    rows()[0].click();
    if (!(await until(() => btn(/^Mark unread$/)))) return fail('the thread was not marked read on open');
    if (rows()[0].classList.contains('unread')) return fail('the row still reads as unread');
    btn(/^⚐ Flag$/).click();
    if (!(await until(() => btn(/^⚑ Unflag$/)))) return fail('Flag did not take');
    await shot('02-thread-tools', 'Opening a thread marks it read. Mark unread, Flag, Archive and Reply show only where the bridge offers them.');

    const review = btn(/^Review and send it yourself/);
    if (!review) return fail("no 'Review and send it yourself' on Uni's draft");
    review.click();
    const composer = await until(() => document.querySelector('[aria-label="Review Uni\'s draft"]'));
    if (!composer) return fail("Uni's draft did not open in the composer");
    if (!/DRAFT · BY UNI · NOT SENT/.test(composer.innerText)) return fail('the composer does not say the draft is by Uni');
    if (composer.querySelector('input[type=radio]')) return fail('the sender is not locked');
    setVal(field('Message'), 'Monday suits me. See you at nine.\n\nRobin');
    await shot('03-uni-draft', "Uni's draft opens in the composer, from you, locked. Uni can't send as you; you can.");

    btn(/^Send as you: review first/).click();
    const rev = await until(() => document.querySelector('.mail-review'));
    if (!rev || !btn(/^Send as you, from robin@example\.com$/)) return fail('no review with a named Send button');
    await shot('04-review', 'Send first saves the draft and shows exactly what was saved. The button says who it sends as.');

    btn(/^Send as you, from robin@example\.com$/).click();
    if (!(await until(() => has(/Sent as you\./)))) return fail('the send did not say Sent');
    await shot('05-sent', 'Sent once. A retry of this review is the same send, never a second message.');

    btn(/^Close$/).click();
    const prov = await until(() => [...document.querySelectorAll('.mail-provenance')].find(visible));
    if (!prov) return fail('the sent copy does not say who drafted it');
    prov.scrollIntoView({ block: 'center' });
    await shot('06-provenance', 'The sent copy says Uni drafted it and you sent it.');

    [...document.querySelectorAll('button')].filter(visible).find((b) => /^New$/.test(b.innerText.trim())).click();
    if (!(await until(() => btn(/^Choose who it's from$/)?.disabled))) return fail('a new message has a sender before one is picked');
    await shot('07-new-unpicked', 'A new message from All inboxes has no sender until you choose one. Enter never sends.');

    const uni = [...document.querySelectorAll('.mail-from-pick')].find((l) => /uni@example\.com/.test(l.innerText));
    uni.querySelector('input').click();
    if (!(await until(() => btn(/^Send as Uni: review first, from uni@example\.com$/)))) return fail('picking Uni did not name Uni on Send');
    setVal(field('To'), 'Ada Moss <ada@example.org>');
    setVal(field('Subject'), 'Reading group: Thursday at six');
    setVal(field('Message'), 'See you there.');
    btn(/^Send as Uni: review first/).click();
    if (!(await until(() => btn(/^Send as Uni, from uni@example\.com$/)))) return fail('no review for the send as Uni');
    btn(/^Send as Uni, from uni@example\.com$/).click();
    if (!(await until(() => has(/Sent as Uni\./)))) return fail('the send as Uni did not say Sent');
    await shot('08-sent-as-uni', "As Uni, it goes through the bridge and Uni's outbound rules, from Uni's address.");

    btn(/^Close$/).click();
    await sleep(500);
    const forged = await until(() => rows().find((r) => /Please send the deposit/.test(r.innerText)));
    if (!forged) return fail('no forged message in the list');
    forged.click();
    if (!(await until(() => has(/NOT VERIFIED/)))) return fail('no Not verified badge');
    await shot('09-not-verified', "Mail that says it's from you but failed DMARC on the way in says Not verified.");
    caption('');
    await write('done', '1');
  }
  const start = () => run().catch((e) => fail('driver threw: ' + (e && e.stack || e)));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();

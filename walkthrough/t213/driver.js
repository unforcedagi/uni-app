// T-213 walk driver (debug builds only, injected through the T-76 harness). Opens Mail on the fake bridge in `approve`
// mode (`fake_mail_bridge <port> <key> approve`: made-up mail, two sends parked in Uni's Drafts, approvals kept in
// memory) and walks the held sends: the badge and banner, Waiting for you, one held send in full, Send it with its
// confirm, Don't send with its confirm, and the outcomes kept on the rows. Each step checks what the screen shows and
// stops with error.txt if it is wrong.
// Run: DRIVER=walkthrough/t213/driver.js with walkthrough/t45/walk.sh.
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
    caption(''); await sleep(400); // the narration says it: nothing covers the screen
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
    const banner = await until(() => btn(/2 sends from Uni's address wait for you · Review$/));
    if (!banner) return fail('no banner for the two held sends');
    if ((await until(() => document.querySelector('.rail .rail-count')?.textContent === '2', 8000)) === null) return fail('no badge of 2 on the rail');
    await shot('01-banner', "Two sends from Uni's address are waiting for you. The Mail button counts them, and so does a banner over the list.");

    banner.click();
    if (!(await until(() => document.querySelectorAll('.mail-held-row').length === 2))) return fail('Waiting for you did not list two sends');
    if (!/Waiting for you/.test(document.querySelector('.mail-box-waiting')?.innerText || '')) return fail("no Waiting for you in Uni's mailboxes");
    await shot('02-waiting', "Waiting for you sits in Uni's mailboxes. Each row says who it is to, and why Uni's rules held it.");

    [...document.querySelectorAll('.mail-held-row')].find((r) => /harvest supper/.test(r.innerText)).click();
    if (!(await until(() => has(/Could we book the barn/) && has(/why it waits/i)))) return fail('the held send did not show what it sends');
    const send = btn(/^Send it, from Uni's address \(uni@example\.com\)$/);
    if (!send || !btn(/^Don't send it from Uni's address/)) return fail('the two decisions are not both offered, labelled with Uni\'s address');
    await shot('03-held', "Each one shows exactly what it sends: from, to, subject and the whole text. Send it and Don't send both say they act for Uni's address.");

    send.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    send.click();
    const confirm = await until(() => document.querySelector('.mail-held-confirm'));
    if (!confirm || !/It goes out exactly as shown/.test(confirm.innerText)) return fail('Send it did not ask to confirm');
    await shot('04-confirm', 'Send it asks once more. The Enter key never confirms: only a tap does.');

    btn(/^Yes, send from Uni's address$/).click();
    if (!(await until(() => has(/Sent from Uni's address \(uni@example\.com\)\./)))) return fail('the approval did not say Sent');
    if (btn(/^Send it/)) return fail('Send it is still offered after sending');
    await shot('05-sent', "Sent, once, from Uni's address. The bridge sends the very draft you saw: if it had changed, it would refuse.");

    const back = btn(/^← Waiting$/); if (back) back.click();
    [...document.querySelectorAll('.mail-held-row')].find((r) => /newsletter/.test(r.innerText)).click();
    if (!(await until(() => btn(/^Don't send it from Uni's address/)))) return fail('the second held send did not open');
    btn(/^Don't send it from Uni's address/).click();
    if (!(await until(() => btn(/^Yes, don't send it$/)))) return fail("Don't send did not ask to confirm");
    btn(/^Yes, don't send it$/).click();
    if (!(await until(() => has(/Declined\. Nothing was sent from Uni's address\./)))) return fail('the decline did not say Declined');
    await shot('06-declined', "Don't send declines it after one confirm. Nothing goes out, and Uni may change the draft or drop it.");

    const b2 = btn(/^← Waiting$/); if (b2) b2.click();
    if (!(await until(() => !document.querySelector('.rail .rail-count')))) return fail('the rail badge did not clear');
    const tags = [...document.querySelectorAll('.mail-held-row .mail-held-tag')].map((t) => t.textContent).sort().join(',');
    if (tags !== 'NOT SENT,SENT') return fail('the rows do not keep what happened: ' + tags);
    await shot('07-done', 'What happened stays on each row, and the badge is gone. If a send fails, it says so, and to ask #mail.');
    caption('');
    await write('done', '1');
  }
  const start = () => run().catch((e) => fail('driver threw: ' + (e && e.stack || e)));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();

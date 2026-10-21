// T-229 live walk (debug builds only, injected through the T-76 harness). The real app against the live calendar door
// on a sample vault: open Calendar from the rail, create one made-up event for tomorrow, move it an hour later through
// its panel, cancel it, and log what the panel shows at each step (its note path, for reading the note back). Each
// step checks the screen and stops with error.txt if it is wrong. Run: DRIVER=walkthrough/t229/live.js walkthrough/t229/walk.sh
(function () {
  if (window.top !== window) return;
  if (window.__WALK_STARTED) return; window.__WALK_STARTED = true;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ipc = () => window.__TAURI_INTERNALS__;
  const log = []; let shotId = 0;
  const write = (name, v) => ipc().invoke('t76_write', { name, contents: typeof v === 'string' ? v : JSON.stringify(v, null, 2) });
  const read = (name) => ipc().invoke('t76_read', { name });
  async function shot(label) {
    await sleep(400);
    const id = ++shotId;
    log.push({ id, label, at: new Date().toISOString() });
    await write('walk-log.json', log);
    await write('shot.req', JSON.stringify({ id, label }));
    for (let i = 0; i < 100; i++) { if ((await read('shot.ack')) === String(id)) return; await sleep(100); }
  }
  async function until(fn, ms = 30000) { const t = performance.now(); while (performance.now() - t < ms) { const v = fn(); if (v) return v; await sleep(200); } return null; }
  const fail = async (what) => {
    log.push({ miss: what, page: (document.body.innerText || '').slice(0, 1500) });
    await write('walk-log.json', log); await shot('zz-fail'); await write('error.txt', what);
  };
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 2 && r.height > 2; };
  const btn = (re, scope) => [...(scope || document).querySelectorAll('button')].filter(visible).find((b) => re.test((b.innerText || '').trim()) || re.test(b.getAttribute('aria-label') || ''));
  const setVal = (el, v) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const labelled = (scope, name) => [...scope.querySelectorAll('label')].find((l) => l.firstChild?.textContent?.trim() === name)?.querySelector('input, textarea, select');
  const panel = () => document.querySelector('.cal-detail');
  const pad = (n) => String(n).padStart(2, '0');
  async function run() {
    const rail = await until(() => btn(/^Calendar$/), 20000);
    if (!rail) return fail('no Calendar on the rail: the door did not answer this key');
    rail.click();
    if (!(await until(() => document.querySelector('.cal-grid, .cal-agenda')))) return fail('the calendar did not load');
    const who = document.querySelector('.cal-title')?.innerText || '';
    log.push({ step: 'opened', title: who });
    await shot('01-opened');
    // tomorrow, 3 PM in the calendar's zone, half an hour
    const tomorrow = new Date(Date.now() + 86400000);
    const day = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}`;
    const title = `T-229 e2e check ${pad(new Date().getHours())}${pad(new Date().getMinutes())}${pad(new Date().getSeconds())}`;
    btn(/^New event$/).click();
    const form = await until(() => document.querySelector('form[aria-label="New event"]'));
    if (!form) return fail('no New event form');
    setVal(labelled(form, 'Title'), title);
    setVal(labelled(form, 'Day'), day);
    setVal(labelled(form, 'Start'), '15:00');
    setVal(labelled(form, 'End'), '15:30');
    setVal(labelled(form, 'Where'), 'A made-up room');
    await shot('02-new');
    btn(/^Add event$/, form).click();
    if (!(await until(() => panel() && new RegExp(title).test(panel().innerText) && /Calendar\//.test(panel().innerText), 20000))) return fail('the new event did not open with its note');
    log.push({ step: 'created', title, day, panel: panel().innerText });
    await shot('03-created');
    btn(/^Move…$/, panel()).click();
    const mv = await until(() => panel()?.querySelector('form[aria-label="Move event"]'));
    if (!mv) return fail('no Move form');
    setVal(labelled(mv, 'Start'), '16:00');
    btn(/^Move$/, mv).click();
    if (!(await until(() => /4\sPM\s–\s4:30\sPM/.test(panel()?.innerText || ''), 20000))) return fail('the panel does not show it at 4 PM');
    log.push({ step: 'moved', panel: panel().innerText });
    await shot('04-moved');
    btn(/^Cancel event$/, panel()).click();
    if (!(await until(() => /CANCELLED/.test(panel()?.innerText || ''), 20000))) return fail('the panel does not show it cancelled');
    log.push({ step: 'cancelled', panel: panel().innerText, buttons: [...panel().querySelectorAll('button')].map((b) => b.innerText.trim()) });
    await shot('05-cancelled');
    await write('walk-log.json', log);
    await write('done', '1');
  }
  const go = () => run().catch((e) => fail(`driver error: ${e && e.message}`));
  if (document.readyState === 'complete') go(); else window.addEventListener('load', go);
})();

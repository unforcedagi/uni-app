// T-229 walk driver (debug builds only, injected through the T-76 harness). The real app as the owner, against the fake
// calendar door (scripts/fake-cal-door.ts <port> <key> owner conflict: the shared fixture's made-up events, a made-up
// conflict, invites to an outbox in memory). Walks: the week; an event shared with a named person; a new event with
// people; its invites waiting, the confirm, sent; a drag on a repeating event and its "which events?"; the conflicts the
// sync left; and the door gone (the runner stops it when this writes stop-door): the last snapshot, read-only. Each step
// checks what the screen shows and stops with error.txt if it is wrong.
// Run: DRIVER=walkthrough/t229/driver.js STOP_DOOR=<fake door pid> walkthrough/t229/walk.sh <name>
(function () {
  if (window.top !== window) return;
  if (window.__WALK_STARTED) return; window.__WALK_STARTED = true;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ipc = () => window.__TAURI_INTERNALS__;
  const log = []; let shotId = 0;
  const write = (name, v) => ipc().invoke('t76_write', { name, contents: typeof v === 'string' ? v : JSON.stringify(v, null, 2) });
  const read = (name) => ipc().invoke('t76_read', { name });
  async function shot(label) {
    await sleep(500);
    const id = ++shotId;
    log.push({ id, label, at: new Date().toISOString() });
    await write('walk-log.json', log);
    await write('shot.req', JSON.stringify({ id, label }));
    for (let i = 0; i < 100; i++) { if ((await read('shot.ack')) === String(id)) return; await sleep(100); }
  }
  async function until(fn, ms = 20000) { const t = performance.now(); while (performance.now() - t < ms) { const v = fn(); if (v) return v; await sleep(200); } return null; }
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
  const text = () => document.querySelector('.cal')?.innerText || '';
  const close = () => btn(/^Close event$/)?.click();
  const pointer = (el, type, x, y) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 7, pointerType: 'mouse', isPrimary: true }));
  async function run() {
    const rail = await until(() => btn(/^Calendar$/));
    if (!rail) return fail('no Calendar on the rail');
    rail.click();
    if (!(await until(() => btn(/^Lunch with Kai,/)))) return fail('the week did not show the made-up events');
    document.querySelector('.cal-scroll').scrollTop = 7 * 48;
    await shot('01-week');

    btn(/^Garden plot rota,/).click();
    if (!(await until(() => panel() && labelled(panel(), 'Shared with')?.value === 'People/Mara Quell'))) return fail('the shared event did not say who it is shared with');
    await shot('02-shared');
    close();

    btn(/^New event$/).click();
    const form = await until(() => document.querySelector('form[aria-label="New event"]'));
    if (!form) return fail('no New event form');
    setVal(labelled(form, 'Title'), 'Seed library planning');
    setVal(labelled(form, 'Day'), '2026-10-23');
    setVal(labelled(form, 'Start'), '11:00');
    setVal(labelled(form, 'End'), '12:00');
    setVal(labelled(form, 'Where'), 'The Commons, room 2');
    setVal(labelled(form, 'People to invite'), 'juno@example.com, mara@example.com');
    if (!(await until(() => /Invites wait until you send them/.test(form.innerText)))) return fail('no word that invites wait');
    await shot('03-new');
    btn(/^Add event$/, form).click();
    if (!(await until(() => panel() && /Invites not sent\./.test(panel().innerText) && /TENTATIVE/.test(panel().innerText)))) return fail('the new event does not show its invites waiting');
    await shot('04-invites-waiting');
    btn(/^Send invites…$/, panel()).click();
    const confirm = await until(() => document.querySelector('[role="dialog"][aria-label="Send invites?"]'));
    if (!confirm || !/juno@example\.com[\s\S]*mara@example\.com/.test(confirm.innerText)) return fail('the confirm does not list who gets the invites');
    await shot('05-invite-confirm');
    btn(/^Send invites$/, confirm).click();
    if (!(await until(() => /Invites are on their way/.test(document.querySelector('.cal-notice')?.innerText || '') && !/Invites not sent/.test(panel()?.innerText || '')))) return fail('the invites did not go');
    await shot('06-invites-sent');
    close();

    // a drag on Thursday's Studio hours, an hour later: it repeats, so it asks which events
    const studio = await until(() => btn(/^Studio hours, Thursday, Oct 22/));
    if (!studio) return fail('no Studio hours on Thursday');
    const r = studio.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + 12;
    pointer(studio, 'pointerdown', x, y);
    for (let i = 1; i <= 8; i++) { pointer(studio, 'pointermove', x, y + (48 * i) / 8); await sleep(30); }
    await shot('07-dragging');
    pointer(studio, 'pointerup', x, y + 48);
    const ask = await until(() => document.querySelector('[role="dialog"][aria-label="Move a repeating event"]'));
    if (!ask) return fail('a drag on a repeating event did not ask which events');
    await shot('08-which-events');
    btn(/^This event$/, ask).click();
    if (!(await until(() => btn(/^Studio hours, Thursday, Oct 22 · 10\sAM – 12\sPM/)))) return fail('Thursday\'s Studio hours did not move');
    await shot('09-moved-one');

    btn(/^Conflicts \(1\)$/).click();
    if (!(await until(() => /KEPT/.test(document.querySelector('.cal-conflicts')?.innerText || '')))) return fail('no conflicts list');
    await shot('10-conflicts');
    btn(/^Close conflicts$/).click();

    // the door goes away: the last snapshot, read-only
    await write('stop-door', '1');
    await sleep(2500);
    btn(/^Refresh$/).click();
    if (!(await until(() => /OFFLINE/.test(document.querySelector('.cal-title')?.innerText || '') && btn(/^Lunch with Kai,/)))) return fail('no offline snapshot');
    if (btn(/^New event$/)) return fail('New event is offered offline');
    btn(/^Lunch with Kai,/).click();
    if (!(await until(() => /Offline: read-only/.test(panel()?.innerText || '')))) return fail('the panel is not read-only offline');
    await shot('11-offline');
    await write('walk-log.json', log);
    await write('done', '1');
  }
  const go = () => run().catch((e) => fail(`driver error: ${e && e.message}`));
  if (document.readyState === 'complete') go(); else window.addEventListener('load', go);
})();

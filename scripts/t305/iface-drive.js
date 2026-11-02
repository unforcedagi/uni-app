// T-305 interface platform spike: drives the real Linux build as a person would, across reloads and launches.
// Runs before each page's own scripts (src-tauri/src/t76.rs, debug builds only). The phase lives in a file under
// UNI_T76_DIR, so it survives the reload a switch causes and a relaunch. scripts/t305/iface-e2e-desktop.sh runs it.
if (window.top === window) (function () {
  const T = () => window.__TAURI_INTERNALS__;
  const call = (cmd, args) => T().invoke(cmd, args);
  const put = (name, v) => call('t76_write', { name, contents: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }).catch(() => {});
  const get = (name) => call('t76_read', { name }).catch(() => null);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let lines = [];
  const log = async (msg) => { lines.push(`${new Date().toISOString().slice(11, 19)} ${msg}`); const prev = (await get('drive.log')) || ''; await put('drive.log', prev + lines.splice(0).join('\n') + '\n'); };
  const until = async (what, test, ms = 60000) => {
    const end = Date.now() + ms;
    for (;;) { const v = test(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(250); }
  };
  // The harness takes the screenshot when the marker appears; hold still while it does.
  const shot = async (name, hold = 2500) => { await put(`shot-${name}`, ''); await sleep(hold); };
  // The innermost visible elements whose whole text is `text`.
  const byText = (text, root = document) => [...root.querySelectorAll('button, a, [role=button], li, span, b, p, h1, h2, div')]
    .filter((e) => e.offsetParent !== null && e.textContent.trim() === text && ![...e.children].some((c) => c.textContent.trim() === text));
  const clickable = (e) => e.closest('button, a, [role=button]') || e;
  const press = (e) => { clickable(e).scrollIntoView({ block: 'center' }); clickable(e).click(); };
  const LETTER = 'Saving two squash seeds for the spring swap.';
  // Uni lists rooms outside its areas under "Other rooms", folded at first.
  const room = async (name) => {
    const row = () => byText(name)[0] || byText(`#${name}`)[0];
    const fold = await until('Other rooms', () => row() || byText('Other rooms')[0]);
    if (fold.textContent.trim() === 'Other rooms') {
      press(fold);
      await sleep(800);
      const b = clickable(fold);
      await log(`unfolded Other rooms: <${b.tagName.toLowerCase()} ${b.getAttribute('aria-label')}> expanded=${document.querySelector('.th-fold')?.getAttribute('aria-expanded')}`);
    }
    return until(name, row, 20000).catch(async (e) => {
      await log(`tree: ${document.querySelector('.th-fold')?.parentElement?.parentElement?.innerHTML.slice(0, 1500)}`);
      throw e;
    });
  };

  async function run() {
    const phase = ((await get('phase')) || 'uni-start').trim();
    const garden = !!document.getElementById('garden');
    await log(`page loaded: ${garden ? 'Garden' : 'Uni'}, phase ${phase}`);
    const status = await call('ota_status');
    await log(`ota_status: interface ${status.iface}, bundle ${status.active ? status.active.version : 'built in'}`);

    if (phase === 'uni-start' && !garden) {
      localStorage.setItem('drive-probe', 'set by Uni');
      await room('Seed Library');
      await shot('01-uni');
      press(await until('Settings', () => document.querySelector('button[aria-label="Settings"]')));
      const use = await until('Use Garden', () => byText('Use Garden')[0]);
      await log(`settings: ${document.querySelector('.iface-picker')?.textContent}`);
      await shot('02-uni-settings');
      await put('phase', 'garden');
      press(use);
      return;
    }
    if (phase === 'garden' && garden) {
      const places = await until('five places', () => { const p = document.querySelectorAll('.place'); return p.length >= 5 && p; });
      await log(`places: ${[...places].map((p) => p.getAttribute('aria-label')).join(' | ')}`);
      await log(`Garden's page: ${location.href}`);
      await put('garden-js', document.querySelector('script[type=module]').src);
      await shot('03-garden');
      // Three neighbours write while Garden is open (the relay sends them live): fireflies, and moths flying in.
      await put('relay-live', '');
      await until('a firefly', () => document.querySelectorAll('.fly').length >= 1, 30000);
      await shot('03b-moth-in', 600);
      await until('three places with new letters', () => document.querySelectorAll('.place .fly').length >= 3, 30000);
      await sleep(1800);
      await log(`after live letters: ${[...document.querySelectorAll('.place')].map((p) => p.getAttribute('aria-label')).join(' | ')}`);
      await shot('03c-fireflies');
      // The shell's gate: Garden was granted rooms.read and rooms.send only.
      const denied = await call('vault_list').then(() => 'allowed', (e) => String(e));
      await log(`vault_list from Garden: ${denied}`);
      // Its window has no plugins, its own browser storage, and can't load Uni's pages.
      // Events go to every window that listens: an interface may not listen at all (live letters come through the gate).
      const heard = await call('plugin:event|listen', { event: 'uni://live', target: { kind: 'Any' }, handler: 0 }).then(() => 'allowed', (e) => String(e));
      await log(`Uni's live events from Garden: ${heard.includes('not allowed') ? 'refused' : heard}`);
      const clip = await call('plugin:clipboard-manager|write_text', { text: 'from Garden' }).then(() => 'allowed', (e) => String(e));
      await log(`clipboard from Garden: ${clip.includes('not allowed') ? 'refused' : clip}`);
      await log(`Uni's storage seen from Garden: ${localStorage.getItem('drive-probe') ?? 'nothing'}`);
      const a = document.createElement('a'); a.href = '/index.html'; document.body.append(a); a.click();
      await sleep(1500);
      await log(`after trying to open Uni's page in Garden's window: ${document.getElementById('garden') ? 'still Garden' : 'navigated away'}`);
      const seeds = [...document.querySelectorAll('.place')].find((p) => p.getAttribute('aria-label').startsWith('Seed Library'));
      seeds.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await until('letters', () => document.querySelectorAll('.letter').length >= 4);
      await log(`letters: ${[...document.querySelectorAll('.letter .body')].map((b) => b.textContent).join(' | ')}`);
      await shot('04-letters');
      const box = document.querySelector('.compose textarea');
      box.value = LETTER;
      box.dispatchEvent(new Event('input', { bubbles: true }));
      await shot('05-writing', 1200);
      document.querySelector('.compose .send').click();
      await sleep(450);
      await shot('06-moth', 300);
      await until('the sent letter', () => [...document.querySelectorAll('.letter .body')].some((b) => b.textContent === LETTER), 30000);
      await log(`status: ${document.querySelector('.status').textContent}`);
      await shot('07-sent');
      await put('phase', 'back');
      press(byText('Back to Uni')[0]);
      return;
    }
    if (phase === 'back' && !garden) {
      await until('Uni rail', () => document.querySelector('button[aria-label="Settings"]'));
      press(await room('Seed Library'));
      await until('the letter in Uni', () => byText(LETTER).length || document.body.innerText.includes(LETTER), 30000);
      await log('Uni shows the letter Garden sent');
      // Uni's page tries to run Garden's own script (it would get Uni's powers): its scheme refuses this webview.
      const src = (await get('garden-js')).trim();
      const ran = await new Promise((done) => { const s = document.createElement('script'); s.src = src; s.onload = () => done('loaded'); s.onerror = () => done('refused'); document.head.append(s); });
      await log(`Garden's script from Uni's page: ${ran}`);
      await shot('08-uni-back');
      // Leave Garden showing for the next launch.
      press(await until('Settings', () => document.querySelector('button[aria-label="Settings"]')));
      await put('phase', 'garden-again');
      press(await until('Use Garden', () => byText('Use Garden')[0]));
      return;
    }
    if (phase === 'garden-again' && garden) {
      await until('places', () => document.querySelectorAll('.place').length >= 5);
      await log('Garden showing again; this launch is done');
      await put('phase', 'offline');
      await put('done-1', '');
      return;
    }
    if (phase === 'offline' && garden) {
      await until('places', () => document.querySelectorAll('.place').length >= 5);
      await log(`relaunched with the Garden channel down: ${document.querySelectorAll('.place').length} places`);
      await shot('09-offline-garden');
      await put('done-2', '');
      return;
    }
    await log(`unexpected: phase ${phase} on ${garden ? 'Garden' : 'Uni'}`);
    await put('error.txt', `phase ${phase} on ${garden ? 'Garden' : 'Uni'}`);
  }

  const start = () => run().catch(async (e) => {
    await log(`error: ${e.message}`);
    await put('page.txt', document.body.innerText.slice(0, 4000));
    await shot('error', 1500);
    await put('error.txt', e.message);
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(start, 500));
  else setTimeout(start, 500);
})();

// T-76 in-page driver, appended to the Tauri init script. Runs in the top frame of the real webview (WebKitGTK).
// Results go out through the debug-only `t76_write` command, using the real Tauri IPC captured before the mock replaced it.
(() => {
  if (window.top !== window) return;
  const real = window.__T76_REAL;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const files = {};
  const out = (name, v) => { files[name] = v; return real.invoke('t76_write', { name, contents: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }); };
  const progress = [];
  const note = (s) => { progress.push(`${(performance.now() / 1000).toFixed(1)}s ${s}`); out('progress.log', progress.join('\n')).catch(() => {}); };
  const waitFor = async (fn, ms = 10000, what = 'condition') => { const t = performance.now(); for (;;) { const v = fn(); if (v) return v; if (performance.now() - t > ms) throw new Error('timeout: ' + what); await sleep(50); } };
  const $ = (s) => document.querySelector(s);
  const btn = (re, root = document) => [...root.querySelectorAll('button')].find((b) => re.test((b.getAttribute('aria-label') || b.textContent || '').trim()));
  const composer = () => document.querySelector('textarea[aria-label="Message Techne"], input[aria-label="Message Techne"]');
  const setText = (el, v) => { const p = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(p, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const diag = { violations: [], errors: [], frames: [] };
  document.addEventListener('securitypolicyviolation', (e) => { diag.violations.push({ dir: e.effectiveDirective, blocked: e.blockedURI, src: e.sourceFile, sample: e.sample }); out('diag.json', diag).catch(() => {}); });
  addEventListener('error', (e) => { diag.errors.push(String(e.message)); out('diag.json', diag).catch(() => {}); });
  const captured = [];
  new MutationObserver((ms) => { for (const m of ms) for (const n of [...m.addedNodes, m.target]) { const f = n instanceof HTMLIFrameElement ? n : n.querySelector && n.querySelector('iframe'); if (f && f.getAttribute('srcdoc') && f.title === 'Sandbox self-test') { const d = f.getAttribute('srcdoc'); if (!captured.some((c) => c.srcdoc === d)) captured.push({ t: Math.round(performance.now()), srcdoc: d }); } } }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['srcdoc'] });
  const vt = [];
  document.addEventListener('securitypolicyviolation', (e) => vt.push({ t: Math.round(performance.now()), dir: e.effectiveDirective, blocked: e.blockedURI }));
  let keyId = 0;
  /** Real, trusted key events: the helper (keys.py) runs wtype against the nested compositor. */
  const keys = async (steps) => {
    const id = ++keyId; await real.invoke('t76_write', { name: 'keys.req', contents: JSON.stringify({ id, steps }) });
    for (let i = 0; i < 200; i++) { if ((await real.invoke('t76_read', { name: 'keys.ack' })) === String(id)) return; await sleep(50); }
    throw new Error('keys not acknowledged');
  };
  const warns = [];
  const w0 = console.warn.bind(console); console.warn = (...a) => { warns.push(a.map(String).join(' ')); w0(...a); };

  const openArea = async (name) => {
    btn(/^Areas$/, $('nav[aria-label="Main navigation"]')).click();
    const card = await waitFor(() => [...document.querySelectorAll('.area-card')].find((c) => c.querySelector('strong')?.textContent.trim() === name), 10000, 'area card ' + name);
    card.click();
    await waitFor(() => $('.area-bar-title')?.textContent === name, 10000, 'area bar ' + name);
    const allow = await waitFor(() => btn(/^Allow$/), 8000, 'Allow').catch(() => null);
    if (allow) { allow.focus(); await sleep(100); await keys([{ key: 'Return' }]); } // the grant prompt, answered by a real key press (Allow ignores untrusted clicks)
    await waitFor(() => $('iframe.area-frame'), 10000, 'frame of ' + name).catch((e) => { throw new Error(e.message + ' | page: ' + document.querySelector('main, .area-view, body').innerText.replace(/\s+/g, ' ').slice(0, 500)); });
    await sleep(500); // the frame loads and its script runs
    return composer();
  };
  const steal = () => $('iframe.area-frame').contentWindow.postMessage('steal', '*');
  const state = () => ({ frames: document.querySelectorAll('iframe.area-frame').length, notice: !!document.evaluate('//p[@role="status"][contains(., "took the keyboard")]', document, null, 9).singleNodeValue, stopped: [...document.querySelectorAll('.area-quiet')].some((e) => e.textContent.includes('kept taking the keyboard')), composerFocused: document.activeElement === composer(), hasFocus: document.hasFocus() });

  const run = async () => {
    const env = { userAgent: navigator.userAgent, rtcMain: typeof RTCPeerConnection, webkitRtcMain: typeof webkitRTCPeerConnection, mediaDevices: typeof navigator.mediaDevices, hasFocus: document.hasFocus(), tauriInternalsReal: !!real, descriptors: window.__T76_DESC, mockActive: real !== window.__TAURI_INTERNALS__ };
    await out('env.json', env); note('env written');

    // 0. does a sandboxed srcdoc frame run script at all in this webview?
    const simple = (srcdoc, ms = 4000, nosb = false) => new Promise((res) => { const f = document.createElement('iframe'); if (!nosb) f.setAttribute('sandbox', 'allow-scripts'); f.style.cssText = 'position:fixed;left:0;top:0;width:100px;height:100px'; const h = (e) => { if (e.source === f.contentWindow) { cleanup(); res(String(e.data)); } }; const cleanup = () => { removeEventListener('message', h); f.remove(); }; addEventListener('message', h); setTimeout(() => { cleanup(); res('no message'); }, ms); f.srcdoc = srcdoc; document.body.appendChild(f); });
    diag.simpleFrame = await simple('<script>parent.postMessage("hi","*")<\/script>');
    diag.simpleFrameCsp = await simple('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'"><script>parent.postMessage("hi-csp","*")<\/script>');
    diag.nosandbox = await simple('<script>parent.postMessage("hi-nosb","*")<\/script>', 3000, true);
    diag.onload = await new Promise((res) => { const f = document.createElement('iframe'); f.setAttribute('sandbox', 'allow-scripts'); f.onload = () => res('load'); setTimeout(() => res('no load'), 3000); f.srcdoc = '<p>x</p>'; document.body.appendChild(f); });
    diag.about = await new Promise((res) => { const f = document.createElement('iframe'); f.onload = () => res('load'); setTimeout(() => res('no load'), 3000); document.body.appendChild(f); });
    diag.visibility = document.visibilityState;
    diag.location = location.href;
    try { const r = await fetch(location.href); diag.hostCspHeader = r.headers.get('content-security-policy'); diag.hostHeaders = [...r.headers.keys()]; } catch (e) { diag.hostCspHeader = 'fetch failed: ' + e; }
    diag.metaCsp = [...document.querySelectorAll('meta[http-equiv]')].map((m) => m.content);
    diag.scriptsRun = await simple('<script>parent.postMessage(String(typeof document), "*")<\/script>', 2000, true);
    diag.blobFrame = await new Promise((res) => { const f = document.createElement('iframe'); const h = (e) => { if (e.source === f.contentWindow) res('msg'); }; addEventListener('message', h); setTimeout(() => res('no message'), 2000); f.src = URL.createObjectURL(new Blob(['<script>parent.postMessage(1,"*")<\/script>'], { type: 'text/html' })); document.body.appendChild(f); });
    await out('diag.json', diag);
    // 1. the self-test, through the UI
    await waitFor(() => $('nav[aria-label="Main navigation"]'), 30000, 'app rail');
    const focusWait = performance.now(); await waitFor(() => document.hasFocus(), 3000, 'window focus').catch(() => {}); const focusBeforeKey = document.hasFocus(); await keys([{ key: 'Shift_L' }]); await waitFor(() => document.hasFocus(), 5000, 'window focus after a key').catch(() => {});
    await out('env.json', { ...env, hasFocusAtStart: env.hasFocus, hasFocusAtRail: document.hasFocus(), hasFocusBeforeFirstKey: focusBeforeKey, focusWaitMs: Math.round(performance.now() - focusWait) });
    btn(/^Settings$/, $('nav[aria-label="Main navigation"]')).click();
    const runBtn = await waitFor(() => btn(/^Run sandbox self-test$/), 20000, 'self-test button');
    note('self-test: click');
    runBtn.click();
    setTimeout(() => { diag.frames = [...document.querySelectorAll('iframe')].map((f) => ({ title: f.title, sandbox: f.getAttribute('sandbox'), hasSrcdoc: (f.getAttribute('srcdoc') || '').length, readyState: (() => { try { return f.contentDocument && f.contentDocument.readyState; } catch (e) { return 'cross'; } })() })); out('diag.json', diag).catch(() => {}); }, 8000);
    const t0 = Math.round(performance.now());
    const status = await waitFor(() => $('.selftest-status.pass, .selftest-status.fail, .selftest-status.approved'), 90000, 'self-test result');
    const result = {
      status: status.className, text: status.textContent,
      checks: [...document.querySelectorAll('.selftest-list li')].map((li) => ({ ok: li.classList.contains('pass'), label: li.firstChild.nextSibling?.textContent?.trim() || li.textContent.replace(/^[✓✗]\s*/, '').replace(/ (passed|failed)$/, '') })),
      stored: JSON.parse(localStorage.getItem('uni.areaApps.selftest.v1') || 'null'),
    };
    result.timeline = { clickAtMs: t0, doneAtMs: Math.round(performance.now()), stageFramesSeen: captured.map((c) => ({ t: c.t, bytes: c.srcdoc.length, navUrlInDoc: (c.srcdoc.match(/127\.0\.0\.1:\d+\/selftest-nav/) || [null])[0], vector: /http-equiv = 'refresh'/.test(c.srcdoc) ? 'meta' : /a\.click/.test(c.srcdoc) ? 'anchor' : /setTimeout\(function \(\) \{ location/.test(c.srcdoc) ? 'self' : /selftest-nav/.test(c.srcdoc) ? 'parse' : 'main' })), violationsDuringSelfTest: vt.filter((v) => v.t >= t0) };
    await out('selftest.json', result); note('self-test: ' + result.status);

    // 1b. what the failing checks really do on this engine: the frame tries each thing against a loopback listener / the IPC
    const exp = {};
    const frameRun = (srcdoc, ms = 3500) => new Promise((res) => { const f = document.createElement('iframe'); f.setAttribute('sandbox', 'allow-scripts'); f.style.cssText = 'position:fixed;left:0;top:0;width:100px;height:100px'; const h = (e) => { if (e.source === f.contentWindow && e.data && e.data.t76) { clearTimeout(t); removeEventListener('message', h); res(e.data); f.remove(); } }; addEventListener('message', h); const t = setTimeout(() => { removeEventListener('message', h); f.remove(); res('no report'); }, ms); f.srcdoc = srcdoc; document.body.appendChild(f); });
    const nav = (code) => `<script>addEventListener('load', function () { setTimeout(function () { ${code} }, 100); });<\/script>`;
    const U = 'http://127.0.0.1:__PORT__/';
    // the real frame's policy (src/interface/srcdoc.ts FRAME_CSP), to see how it changes what the host observes
    const CSPM = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'">`;
    const v0 = diag.violations.length;
    exp.ipcFromFrame = await frameRun(`<script>var r = { t76: 1 }; try { var h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.ipc; r.present = !!h; if (h) { h.postMessage(JSON.stringify({ cmd: 't76_write', callback: 1, error: 2, payload: { name: 'frame-ipc.txt', contents: 'from a sandboxed frame' }, options: { headers: {} } })); r.posted = true; } } catch (e) { r.err = String(e); } r.windowIpc = typeof window.ipc; parent.postMessage(r, '*');<\/script>`);
    for (const [k, code] of [['self', `location.href = '${U}self';`], ['meta', `var m = document.createElement('meta'); m.httpEquiv = 'refresh'; m.content = '0;url=${U}meta'; document.head.appendChild(m);`], ['anchor', `var a = document.createElement('a'); a.href = '${U}anchor'; document.body.appendChild(a); a.click();`]]) {
      const before = diag.violations.length;
      await frameRun(nav(code), 2500); await sleep(500);
      exp['nav_' + k] = { violationsSeenByHost: diag.violations.slice(before) };
    }
    { const before = diag.violations.length; await frameRun(`<script>location.href = '${U}parse';<\/script>`, 2500); await sleep(500); exp.nav_parse = { violationsSeenByHost: diag.violations.slice(before) }; }
    for (const [k, code] of [['self', `location.href = '${U}csp-self';`], ['meta', `var m = document.createElement('meta'); m.httpEquiv = 'refresh'; m.content = '0;url=${U}csp-meta'; document.head.appendChild(m);`], ['anchor', `var a = document.createElement('a'); a.href = '${U}csp-anchor'; document.body.appendChild(a); a.click();`]]) {
      const before = diag.violations.length;
      await frameRun(CSPM + nav(code), 2500); await sleep(2500);
      exp['navWithFrameCsp_' + k] = { violationsSeenByHost: diag.violations.slice(before) };
    }
    { const before = diag.violations.length; await frameRun(CSPM + `<script>location.href = '${U}csp-parse';<\/script>`, 2500); await sleep(2500); exp.navWithFrameCsp_parse = { violationsSeenByHost: diag.violations.slice(before) }; }
    // can an app under the real frame policy get a fresh realm (a child frame) to reach webkit.messageHandlers.ipc from?
    exp.childRealm = await frameRun(CSPM + `<script>var r = { t76: 1 }; var f = document.createElement('iframe'); f.srcdoc = '<script>parent.postMessage({kid:1,ipc:!!(window.webkit&&window.webkit.messageHandlers&&window.webkit.messageHandlers.ipc)},"*")<\\/script>'; addEventListener('message', function (e) { if (e.data && e.data.kid) { r.kidIpc = e.data.ipc; parent.postMessage(r, '*'); } }); document.addEventListener('securitypolicyviolation', function (e) { r.violation = e.effectiveDirective; }); document.documentElement.appendChild(f); setTimeout(function () { r.done = 'timeout'; parent.postMessage(r, '*'); }, 1500);<\/script>`);
    exp.replay = [];
    for (const c of captured.filter((c) => /selftest-nav/.test(c.srcdoc))) { const before = diag.violations.length; await frameRun(c.srcdoc, 2500); await sleep(2500); exp.replay.push({ navUrlInDoc: (c.srcdoc.match(/127\.0\.0\.1:\d+\/selftest-nav/) || [null])[0], violations: diag.violations.slice(before).map((x) => x.dir + ' ' + x.blocked) }); }
    exp.fetchToListener = await frameRun(`<script>fetch('${U}fetch').then(function(){ parent.postMessage({t76:1,r:'resolved'},'*'); }, function(e){ parent.postMessage({t76:1,r:'rejected '+e.name},'*'); });<\/script>`);
    await out('experiments.json', exp); note('experiments');

    // 2. focus theft
    // The self-test fails on this engine (see selftest.json). The theft run needs the gate open, so it is opened by hand, and says so.
    const forcedGate = !localStorage.getItem('uni.areaApps.selftest.v1');
    if (forcedGate) { localStorage.setItem('uni.areaApps.selftest.v1', JSON.stringify({ platform: 'linux', passedAt: new Date().toISOString(), appVersion: 'dev', mode: 'sealed', userAgent: navigator.userAgent })); window.dispatchEvent(new StorageEvent('storage', { key: 'uni.areaApps.selftest.v1' })); }
    const theft = { forcedGate };
    const run1 = async (key, name, fn) => { try { const box = await openArea(name); setText(box, ''); await sleep(150); theft[key] = await fn(box); } catch (e) { theft[key] = { error: String(e && e.message || e) }; } note('theft ' + key); await out('focus-theft.json', theft); };

    // What the host sees of focus for a while after the app acts: did the iframe ever become document.activeElement?
    const watch = async (ms) => { const seen = { iframeWasActive: false, samples: 0 }; const t = performance.now(); while (performance.now() - t < ms) { seen.samples++; if (document.activeElement instanceof HTMLIFrameElement) seen.iframeWasActive = true; await sleep(10); } return seen; };
    let lastFrameReport = null;
    addEventListener('message', (e) => { if (e.data && e.data.t76steal) lastFrameReport = e.data; });
    const stealAndWatch = async () => { lastFrameReport = null; steal(); const seen = await watch(900); return { ...seen, frameReport: lastFrameReport }; };
    const heardKeys = () => (window.__calls || []).filter((c) => c.cmd === 'vault_search').map((c) => c.args.query).join('');
    const theftLogs = () => warns.filter((w) => w.includes('focus theft'));
    const forceActive = () => { const f = $('iframe.area-frame'); f.inert = false; return f.inert; }; // engine ignored: undo the host's inert, as a webview that does not honour it would
    const realType = async (text) => keys([{ type: text }]);

    // A: real Tab out of the composer is not a theft
    await run1('A_tabOutIsNotTheft', 'Polite', async (box) => {
      box.focus(); await sleep(150);
      await keys([{ key: 'Tab' }, { key: 'Tab' }, { key: 'Tab' }, { key: 'Tab' }]); await sleep(600);
      return { after: state(), thefts: theftLogs() };
    });
    // B/C: the app steals focus from inside, as it is (the host marks the frame inert while the composer holds focus)
    await run1('B_naturalSteal_emptyComposer', 'PoliteB', async (box) => {
      box.focus(); await sleep(150);
      const before = state(), inert = $('iframe.area-frame').inert, r = await stealAndWatch();
      return { inertWhileComposerFocused: inert, before, ...r, after: state(), thefts: theftLogs() };
    });
    await run1('C_naturalSteal_withText', 'PoliteC', async (box) => {
      warns.length = 0; box.focus(); await sleep(100); await realType('hello'); await sleep(150);
      const before = state(), inert = $('iframe.area-frame').inert, r = await stealAndWatch();
      return { inertWhileComposerFocused: inert, composerValueBefore: composer()?.value, before, ...r, after: state(), composerValueAfter: composer()?.value, thefts: theftLogs() };
    });
    // D: a thief that refocuses itself every 5 ms, with a person typing real keys
    await run1('D_naturalThief_realTyping', 'Thief', async (box) => {
      warns.length = 0; const searches0 = heardKeys().length; box.focus(); await sleep(200);
      await realType('hunter2'); await sleep(500);
      return { after: state(), composerValue: composer()?.value, keysHeardByApp: heardKeys().slice(searches0), thefts: theftLogs() };
    });
    // H: control. The instrument can hear: the host hands the frame the keyboard (as a press on it would) and real keys reach the app.
    await run1('H_control_appHearsKeysWhenItHasTheKeyboard', 'ThiefC', async () => {
      const searches0 = heardKeys().length; $('iframe.area-frame').focus(); await sleep(300);
      const active = document.activeElement instanceof HTMLIFrameElement;
      await realType('abc'); await sleep(500);
      return { frameIsActiveElement: active, keysHeardByApp: heardKeys().slice(searches0) };
    });
    // E/F/G: the frame cannot take focus by itself here, so the focus is moved to it from the host (real focus change, real blur
    // of the host window). That is the case the blur-side counting exists for.
    const unseal = () => { const f = $('iframe.area-frame'); f.inert = false; f.closest('.area-stage')?.removeAttribute('inert'); void f.offsetHeight; return f; }; // undo both inert layers (frame and .area-stage)
    const hostMove = async () => { const f = unseal(); await sleep(30); f.focus(); };
    const trace = [];
    const tag = () => { const a = document.activeElement; return a ? a.tagName + (a.getAttribute && a.getAttribute('aria-label') ? '[' + a.getAttribute('aria-label') + ']' : '') : 'null'; };
    for (const [target, names] of [[window, ['blur', 'focus']], [document, ['focusin', 'focusout']]]) for (const n of names) target.addEventListener(n, (e) => { if (trace.on) trace.push(`${(performance.now() - trace.t0).toFixed(1)}ms ${n} target=${e.target === window || e.target === document ? '#doc' : e.target.tagName} active=${tag()} related=${e.relatedTarget ? e.relatedTarget.tagName : '-'}`); }, true);
    const probeFocus = async () => { const f = $('iframe.area-frame'); const o = { inertBefore: f.inert, ancestorInert: !!f.parentElement.closest('[inert]'), tabindex: f.getAttribute('tabindex'), display: getComputedStyle(f).display, visibility: getComputedStyle(f).visibility, activeBefore: tag() }; f.inert = false; await sleep(30); f.focus(); o.activeRightAfter = tag(); await sleep(50); o.activeLater = tag(); o.matchesFocus = f.matches(':focus'); return o; };
    const hostMoveAndWatch = async () => { trace.length = 0; trace.t0 = performance.now(); trace.on = true; await hostMove(); const w = await watch(900); trace.on = false; w.trace = [...trace]; return w; };
    await run1('E_focusMovedToFrame_emptyComposer', 'PoliteD', async (box) => {
      warns.length = 0; box.focus(); await sleep(150);
      const before = state(), seen = await hostMoveAndWatch();
      return { before, ...seen, after: state(), thefts: theftLogs() };
    });
    await run1('F_focusMovedToFrame_withText', 'PoliteE', async (box) => {
      warns.length = 0; box.focus(); await sleep(100); await realType('hello'); await sleep(150);
      const before = state(), seen = await hostMoveAndWatch();
      return { before, ...seen, after: state(), composerEndsWithHello: composer()?.value.endsWith('hello'), thefts: theftLogs() };
    });
    await run1('G_repeatingMoves_emptyComposer', 'PoliteG', async (box) => {
      warns.length = 0; box.focus(); await sleep(150);
      const seq = []; for (let i = 0; i < 3; i++) { await hostMove(); await sleep(400); seq.push(state()); if (!$('iframe.area-frame')) break; box.isConnected && composer()?.focus(); await sleep(250); }
      return { afterEach: seq, thefts: theftLogs() };
    });
    await run1('I_repeatingThief_realTyping', 'ThiefD', async (box) => {
      warns.length = 0; const searches0 = heardKeys().length; box.focus(); await sleep(150);
      const iv = setInterval(() => { if ($('iframe.area-frame')) unseal().focus(); }, 5);
      await realType('hunter2'); await sleep(800); clearInterval(iv);
      return { after: state(), keysHeardByApp: heardKeys().slice(searches0), thefts: theftLogs() };
    });
    // J/K: the app steals by itself (focus() + window.focus() from inside), with the host's inert layers undone
    await run1('J_appStealsItself_emptyComposer', 'PoliteH', async (box) => {
      warns.length = 0; box.focus(); await sleep(150); unseal(); await sleep(30);
      const before = state(), r = await stealAndWatch();
      return { before, ...r, after: state(), thefts: theftLogs() };
    });
    await run1('K_appStealsItself_withText', 'PoliteI', async (box) => {
      warns.length = 0; box.focus(); await sleep(100); await realType('hello'); await sleep(150); unseal(); await sleep(30);
      const before = state(), r = await stealAndWatch();
      return { before, ...r, after: state(), thefts: theftLogs() };
    });
    await out('done', 'ok'); note('done');
  };
  const go = () => run().catch((e) => out('error.txt', String(e && e.stack || e) + '\n--- body ---\n' + document.body.innerText.slice(0, 1500)));
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', () => setTimeout(go, 1500)); else setTimeout(go, 1500);
})();

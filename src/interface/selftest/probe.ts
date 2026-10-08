// Sandbox self-test. A hostile probe app runs inside a sealed frame and
// reports, per check, whether the escape was blocked. Pure evaluation lives
// here; the probe sources are strings because they execute inside the frame.
//
// Navigation checks need a host-observed `frame-src` violation: a reload count is
// not proof (and a missing host CSP must fail). WebRTC is judged in a child
// frame the probe creates, because a srcdoc child is a fresh realm that the
// in-frame neutraliser never touched.
//
// Rules for the network checks: a check passes only on a *positive*
// `securitypolicyviolation` event for that very attempt, and the attempt
// targets something that would really succeed without the CSP (a blob: URL the
// frame created itself, or loopback). Success, silence and timeouts all fail.

export const PROBE_CHECKS: { id: string; label: string }[] = [
  { id: "bridge", label: "Contract answers inside the frame" },
  { id: "tauriInternals", label: "__TAURI_INTERNALS__ unreachable" },
  { id: "tauriGlobal", label: "__TAURI__ absent" },
  { id: "webkitIpc", label: "webkit.messageHandlers.ipc unreachable" },
  { id: "windowIpc", label: "window.ipc unreachable" },
  { id: "fetch", label: "fetch blocked by the CSP" },
  { id: "xhr", label: "XMLHttpRequest blocked by the CSP" },
  { id: "beacon", label: "sendBeacon blocked by the CSP" },
  { id: "webrtc", label: "WebRTC unavailable" },
  { id: "webrtcChild", label: "WebRTC unavailable in a child frame" },
  { id: "parentDocument", label: "parent.document unreachable" },
  { id: "topNavigation", label: "Top navigation blocked" },
  { id: "cookie", label: "document.cookie unreachable" },
  { id: "storage", label: "localStorage unreachable" },
  { id: "popup", label: "window.open blocked" },
  { id: "navSelf", label: "Self-navigation stopped (location)" },
  { id: "navMeta", label: "Meta refresh stopped" },
  { id: "navAnchor", label: "Link navigation stopped" },
  { id: "navParse", label: "Navigation during page parse stopped" },
];

/** The checks the in-frame probe reports itself; the rest are judged by the host. */
export const NAV_STAGES = [
  { id: "navSelf", vector: "self" },
  { id: "navMeta", vector: "meta" },
  { id: "navAnchor", vector: "anchor" },
  { id: "navParse", vector: "parse" },
] as const;
export type NavVector = (typeof NAV_STAGES)[number]["vector"];

export type ProbeCheck = { id: string; label: string; ok: boolean };
export type ProbeResult = { pass: boolean; checks: ProbeCheck[] };

/** A check passes only when the probe reported exactly `true`; missing means fail. */
export function evaluateProbe(report: unknown): ProbeResult {
  const results = report && typeof report === "object" ? (report as Record<string, unknown>) : {};
  const checks = PROBE_CHECKS.map((c) => ({ ...c, ok: results[c.id] === true }));
  return { pass: checks.every((c) => c.ok), checks };
}

/**
 * A navigation attempt was stopped iff the host saw a `frame-src` violation
 * (the host CSP blocked it). A second load, silence and timeouts are not proof:
 * the request has already left by then, and with no host CSP it succeeds.
 */
export function navVerdict(o: { violation: boolean; loads?: number }): boolean {
  return o.violation === true;
}

export const PROBE_HTML = `<!doctype html><html><body><script>
(async () => {
  const R = {};
  const blocked = async (fn) => { try { await fn(); return false; } catch (e) { return true; } };
  // Pass only on a securitypolicyviolation for this attempt. Success, silence and the timeout all fail.
  // sendBeacon "succeeds" (returns true) even when the CSP then blocks it, so it keeps waiting for the event.
  const violated = (directive, attempt, waitAfterSuccess) => new Promise((res) => {
    const off = () => document.removeEventListener('securitypolicyviolation', on);
    const t = setTimeout(() => { off(); res(false); }, 2000);
    const on = (e) => { if (String(e.effectiveDirective || e.violatedDirective || '').indexOf(directive) === 0) { clearTimeout(t); off(); res(true); } };
    document.addEventListener('securitypolicyviolation', on);
    try { Promise.resolve(attempt()).then(() => { if (!waitAfterSuccess) { clearTimeout(t); off(); res(false); } }, () => {}); } catch (e) {}
  });
  R.tauriInternals = typeof window.__TAURI_INTERNALS__ === 'undefined' || await blocked(() => window.__TAURI_INTERNALS__.invoke('vault_paths', { vault: 'uni' }));
  R.tauriGlobal = typeof window.__TAURI__ === 'undefined';
  // wry/WebKitGTK and Android deliver IPC through these; reachable means a post that does not throw.
  R.webkitIpc = await blocked(() => { const h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.ipc; if (!h) throw new Error('absent'); h.postMessage('selftest'); });
  R.windowIpc = await blocked(() => { if (!window.ipc || typeof window.ipc.postMessage !== 'function') throw new Error('absent'); window.ipc.postMessage('selftest'); });
  // Targets that succeed without the CSP: a blob: URL made in this frame, and loopback.
  const blob = URL.createObjectURL(new Blob(['selftest']));
  const loop = 'http://127.0.0.1:1/selftest';
  R.fetch = await violated('connect-src', () => fetch(blob));
  R.xhr = await violated('connect-src', () => new Promise((ok, no) => { const x = new XMLHttpRequest(); x.open('GET', blob); x.onload = () => ok(); x.onerror = () => no(new Error('blocked')); x.send(); }));
  R.beacon = await violated('connect-src', () => { if (!navigator.sendBeacon(loop, 'x')) return Promise.reject(new Error('refused')); return Promise.resolve(); }, true);
  // WebRTC has no CSP control: the host removes it from this realm before app code. Constructing one with a TURN server must fail.
  R.webrtc = await blocked(() => { const pc = new RTCPeerConnection({ iceServers: [{ urls: 'turn:127.0.0.1:9', username: 'selftest', credential: 'x' }] }); pc.createDataChannel('x'); pc.close(); });
  // A srcdoc child frame is a fresh realm: the neutraliser never ran there. Constructible there means the webview has WebRTC, and fails.
  // If the child cannot be created, only a frame-src violation seen here counts as proof.
  R.webrtcChild = await new Promise((res) => {
    let done = false;
    const f = document.createElement('iframe');
    const finish = (v) => { if (done) return; done = true; clearTimeout(t); removeEventListener('message', on); document.removeEventListener('securitypolicyviolation', onv); res(v); };
    const t = setTimeout(() => finish(false), 2500);
    const on = (e) => { if (e.source === f.contentWindow && e.data && e.data.rtcChild === 1) finish(e.data.constructible === false); };
    const onv = (e) => { if (String(e.effectiveDirective || e.violatedDirective || '').indexOf('frame-src') === 0) finish(true); };
    addEventListener('message', on); document.addEventListener('securitypolicyviolation', onv);
    f.srcdoc = '<script>var c=false;try{var P=window.RTCPeerConnection||window.webkitRTCPeerConnection;if(P){var pc=new P({iceServers:[{urls:"turn:127.0.0.1:9",username:"selftest",credential:"x"}]});pc.createDataChannel("x");pc.close();c=true}}catch(e){}parent.postMessage({rtcChild:1,constructible:c},"*")<\\/script>';
    document.body.appendChild(f);
  });
  R.parentDocument = await blocked(() => parent.document.body);
  R.topNavigation = await blocked(() => { top.location.href = 'about:blank#selftest'; });
  // Chromium throws in an opaque origin; WebKit returns '' instead. Pass on a throw, or on '' where a write does not persist.
  R.cookie = await (async () => { try { if (document.cookie !== '') return false; document.cookie = 'selftest=1'; return document.cookie.indexOf('selftest') < 0; } catch (e) { return true; } })();
  R.storage = await blocked(() => localStorage.getItem('selftest'));
  R.popup = await blocked(() => { if (window.open('about:blank') === null) throw new Error('blocked'); });
  R.bridge = await new Promise((res) => {
    const t = setTimeout(() => res(false), 2000);
    addEventListener('message', (e) => { const m = e.data; if (m && m.bridge === 1 && m.id === 'probe' && m.result && m.result.title === 'selftest') { clearTimeout(t); res(true); } });
    parent.postMessage({ bridge: 1, id: 'probe', method: 'area.get' }, '*');
  });
  parent.postMessage({ probe: 1, results: R }, '*');
})();
</script></body></html>`;

/** A probe that tries one way of navigating itself: after load (self, meta, anchor) or while the page is still parsing (parse). The host judges the outcome. */
export function navProbeHtml(vector: NavVector): string {
  const url = "http://127.0.0.1:1/selftest-nav";
  const code = {
    self: `location.href = ${JSON.stringify(url)};`,
    meta: `var m = document.createElement('meta'); m.httpEquiv = 'refresh'; m.content = '0;url=${url}'; document.head.appendChild(m);`,
    anchor: `var a = document.createElement('a'); a.href = ${JSON.stringify(url)}; document.body.appendChild(a); a.click();`,
    parse: `location.href = ${JSON.stringify(url)};`,
  }[vector];
  // A request that leaves during parse is what a load-based check never sees.
  if (vector === "parse") return `<!doctype html><html><body><script>${code}</script></body></html>`;
  return `<!doctype html><html><body><script>addEventListener('load', function () { setTimeout(function () { ${code} }, 100); });</script></body></html>`;
}

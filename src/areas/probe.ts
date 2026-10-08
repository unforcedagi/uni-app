// Sandbox self-test. A hostile probe app runs inside the real AreaFrame and
// reports, per check, whether the escape was blocked. Pure evaluation lives
// here; the probe source is a string because it executes inside the frame.

export const PROBE_CHECKS: { id: string; label: string }[] = [
  { id: "bridge", label: "Bridge answers inside the frame" },
  { id: "tauriInternals", label: "__TAURI_INTERNALS__ unreachable" },
  { id: "tauriGlobal", label: "__TAURI__ absent" },
  { id: "webkitIpc", label: "webkit.messageHandlers.ipc unreachable" },
  { id: "windowIpc", label: "window.ipc unreachable" },
  { id: "fetch", label: "fetch blocked" },
  { id: "xhr", label: "XMLHttpRequest blocked" },
  { id: "parentDocument", label: "parent.document unreachable" },
  { id: "topNavigation", label: "Top navigation blocked" },
  { id: "cookie", label: "document.cookie unreachable" },
  { id: "storage", label: "localStorage unreachable" },
  { id: "popup", label: "window.open blocked" },
];

export type ProbeCheck = { id: string; label: string; ok: boolean };
export type ProbeResult = { pass: boolean; checks: ProbeCheck[] };

/** A check passes only when the probe reported exactly `true`; missing means fail. */
export function evaluateProbe(report: unknown): ProbeResult {
  const results = report && typeof report === "object" ? (report as Record<string, unknown>) : {};
  const checks = PROBE_CHECKS.map((c) => ({ ...c, ok: results[c.id] === true }));
  return { pass: checks.every((c) => c.ok), checks };
}

export const PROBE_HTML = `<!doctype html><html><body><script>
(async () => {
  const R = {};
  const blocked = async (fn) => { try { await fn(); return false; } catch (e) { return true; } };
  const settle = (make) => new Promise((res) => { const t = setTimeout(() => res(true), 1500); make((v) => { clearTimeout(t); res(v); }); });
  R.tauriInternals = typeof window.__TAURI_INTERNALS__ === 'undefined' || await blocked(() => window.__TAURI_INTERNALS__.invoke('vault_paths', { vault: 'uni' }));
  R.tauriGlobal = typeof window.__TAURI__ === 'undefined';
  // wry/WebKitGTK and Android deliver IPC through these; reachable means a post that does not throw.
  R.webkitIpc = await blocked(() => { const h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.ipc; if (!h) throw new Error('absent'); h.postMessage('selftest'); });
  R.windowIpc = await blocked(() => { if (!window.ipc || typeof window.ipc.postMessage !== 'function') throw new Error('absent'); window.ipc.postMessage('selftest'); });
  const target = 'https://example.invalid/selftest';
  R.fetch = await blocked(() => fetch(target));
  R.xhr = await settle((done) => { try { const x = new XMLHttpRequest(); x.open('GET', target); x.onload = () => done(false); x.onerror = () => done(true); x.send(); } catch (e) { done(true); } });
  R.parentDocument = await blocked(() => parent.document.body);
  R.topNavigation = await blocked(() => { top.location.href = 'about:blank#selftest'; });
  R.cookie = await blocked(() => document.cookie);
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

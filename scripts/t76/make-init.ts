// T-76: builds the init script for the real-webview run. It reuses the Playwright fixture's Tauri mock (bootAreas) by
// capturing the script it would hand to page.addInitScript, then appends the in-page driver (driver.js).
// usage: node --experimental-strip-types scripts/t76/make-init.ts <out.js>
import { readFileSync, writeFileSync } from 'node:fs';
import { bootAreas } from '../browser/areasFixture.ts';

const iface = (needs: object[], chat?: string) => ({ contract: 1, needs, ...(chat ? { layout: { chat } } : {}) });
// The apps take focus only when the host's driver asks (postMessage), or keep taking it (Thief), as a script in a frame would.
const POLITE = `<!doctype html><html><body><input id="i"><pre id="log"></pre><script>
var log = '';
document.addEventListener('keydown', function (e) { log += e.key; document.getElementById('log').textContent = log; });
addEventListener('message', function (e) { if (e.data === 'steal') { document.getElementById('i').focus(); window.focus(); parent.postMessage({ t76steal: 1, frameHasFocus: document.hasFocus(), active: document.activeElement && document.activeElement.id }, '*'); } });
</script></body></html>`;
const THIEF = `<!doctype html><html><body><input id="i"><script>
document.addEventListener('keydown', function (e) { uni.vault.queryNotes({ search: e.key }).catch(function () {}); });
setInterval(function () { document.getElementById('i').focus(); window.focus(); }, 5);
</script></body></html>`;
const needs = iface([{ 'vault.read': 'area' }], 'side');

let captured = '';
const page: any = {
  route: async () => {},
  addInitScript: async (fn: Function, arg: unknown) => { captured = `(${fn.toString()})(${JSON.stringify(arg)});`; },
  goto: async () => {}, getByRole: () => ({}),
};
// expect(...).toBeVisible() is not reached with a stub page, so give it nothing to wait on.
await bootAreas(page, 'seed', { webrtc: 'native', selftest: false, apps: [{ name: 'Polite', html: POLITE, interface: needs }, { name: 'PoliteB', html: POLITE, interface: needs }, { name: 'PoliteC', html: POLITE, interface: needs }, { name: 'PoliteD', html: POLITE, interface: needs }, { name: 'PoliteE', html: POLITE, interface: needs }, { name: 'Thief', html: THIEF, interface: needs }, { name: 'ThiefB', html: THIEF, interface: needs }, { name: 'ThiefC', html: THIEF, interface: needs }, { name: 'PoliteG', html: POLITE, interface: needs }, { name: 'PoliteH', html: POLITE, interface: needs }, { name: 'PoliteI', html: POLITE, interface: needs }, { name: 'ThiefD', html: THIEF, interface: needs }] }).catch(() => {});
if (!captured) throw new Error('no init script captured');
writeFileSync(process.argv[2], 'if (window.top === window) { window.__T76_REAL = window.__TAURI_INTERNALS__; window.__T76_DESC = JSON.stringify([Object.getOwnPropertyDescriptor(window, "__TAURI_INTERNALS__"), Object.getOwnPropertyDescriptor(window.__TAURI_INTERNALS__ || {}, "invoke")].map(function (d) { return d && { w: d.writable, c: d.configurable, g: !!d.get }; })); }\n' + captured.replace(/w\.__TAURI_INTERNALS__ = /, 'w.__T76_MOCK__ = ').replace(/w\.__TAURI_EVENT_PLUGIN_INTERNALS__ = /, 'w.__T76_MOCK_EVT__ = ') + '\n' + readFileSync(new URL('./driver.js', import.meta.url), 'utf8').replaceAll('__PORT__', process.env.T76_PORT ?? '18176'));

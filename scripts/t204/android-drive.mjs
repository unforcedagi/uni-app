// T-204: drive the debug APK on the emulator over CDP: inject android-init.js with a fixture note, reload, tap
// Download .md, then the options menu and Share…, with real touch events; screenshots after each step.
// usage: node android-drive.mjs <ws-url> <android-init.js> <fixture.json> <note index> <out dir> <adb serial>
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const [ws, initFile, fixture, idx, out, serial] = process.argv.slice(2);
const note = JSON.parse(readFileSync(fixture, 'utf8')).notes[Number(idx)];
const adb = (...a) => execFileSync(process.env.ADB ?? 'adb', ['-s', serial, ...a]);
const sock = new WebSocket(ws);
let id = 0; const waiting = new Map();
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; waiting.set(i, { res, rej }); sock.send(JSON.stringify({ id: i, method, params })); });
sock.onmessage = (m) => { const d = JSON.parse(m.data); const w = waiting.get(d.id); if (w) { waiting.delete(d.id); d.error ? w.rej(new Error(JSON.stringify(d.error))) : w.res(d.result); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const js = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.value;
const until = async (expr, ms = 30000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await js(`(() => { const v = (${expr}); return v instanceof Element ? true : v; })()`); if (v) return v; await sleep(200); } return null; };
const box = (sel) => js(`(() => { const e = ${sel}; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
async function tap(sel) {
  const p = await box(sel); if (!p) throw new Error('nothing to tap: ' + sel);
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y }] });
  await sleep(80);
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
const marks = {};
const shot = (name) => { marks[name] = Date.now(); writeFileSync(`${out}/android-marks.json`, JSON.stringify(marks)); writeFileSync(`${out}/android-${name}.png`, adb('exec-out', 'screencap', '-p')); };
const button = (text) => `[...document.querySelectorAll('button')].find((b) => b.textContent === ${JSON.stringify(text)} || b.getAttribute('aria-label') === ${JSON.stringify(text)})`;
const toast = `[...document.querySelectorAll('body *')].find((e) => e.children.length === 0 && /^(Saved to|Couldn't)/.test(e.textContent || ''))?.textContent`;
// The software-rendered emulator's System UI can stall under load and show "isn't responding" (not the app): tap Wait.
function dismissAnr() {
  try {
    adb('shell', 'uiautomator', 'dump', '/sdcard/t204-ui.xml');
    const xml = adb('exec-out', 'cat', '/sdcard/t204-ui.xml').toString();
    if (!/isn.t responding/.test(xml)) return false;
    const m = /text="Wait"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(xml);
    if (m) adb('shell', 'input', 'tap', String((+m[1] + +m[3]) >> 1), String((+m[2] + +m[4]) >> 1));
    return !!m;
  } catch { return false; }
}
const log = {};
sock.onopen = async () => {
  try {
    await send('Page.enable'); await send('Runtime.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', { source: readFileSync(initFile, 'utf8').replace('= __NOTE__;', () => '= ' + JSON.stringify(note) + ';') });
    await send('Page.reload', { ignoreCache: true });
    if (!(await until(`document.querySelector('.note-body')`, 30000))) throw new Error('note did not open: ' + await js('JSON.stringify(window.__calls)'));
    await sleep(1500); shot('01-note');
    await tap(button('Download .md'));
    log.download = await until(toast, 15000);
    console.log('download:', log.download);
    await sleep(800); shot('02-saved');
    await tap(button('Download options'));
    await sleep(800); shot('03-menu');
    await tap(button('Share…'));
    await sleep(3500);
    if (dismissAnr()) { log.anrDismissed = true; await sleep(1500); }
    log.foreground = adb('shell', 'dumpsys activity activities | grep -m1 topResumedActivity').toString().trim();
    console.log('after Share:', log.foreground);
    shot('04-share-sheet');
    writeFileSync(`${out}/android-steps.json`, JSON.stringify(log, null, 2));
    process.exit(0);
  } catch (e) { console.error('failed:', e.message); writeFileSync(`${out}/android-steps.json`, JSON.stringify(log, null, 2)); process.exit(1); }
};
setTimeout(() => { console.error('timeout'); process.exit(2); }, 120000);

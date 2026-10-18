// T-174: drive the harness APK on the emulator over CDP: inject android-init.js, reload, tap Save / Open with real
// touch events, grab the screen after each step (adb screencap), and print what each card said.
// usage: node android-drive.mjs <ws-url> <android-init.js> <out dir> <adb serial> <photo.jpg>
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const [ws, initFile, out, serial, photo] = process.argv.slice(2);
const adb = (...a) => execFileSync(process.env.ADB ?? 'adb', ['-s', serial, ...a]);
const sock = new WebSocket(ws);
let id = 0; const waiting = new Map();
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; waiting.set(i, { res, rej }); sock.send(JSON.stringify({ id: i, method, params })); });
sock.onmessage = (m) => { const d = JSON.parse(m.data); const w = waiting.get(d.id); if (w) { waiting.delete(d.id); d.error ? w.rej(new Error(JSON.stringify(d.error))) : w.res(d.result); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const js = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.value;
// Elements don't cross CDP by value: an element found is `true`.
const until = async (expr, ms = 30000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await js(`(() => { const v = (${expr}); return v instanceof Element ? true : v; })()`); if (v) return v; await sleep(200); } return null; };
const box = (sel) => js(`(() => { const e = ${sel}; if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
async function tap(sel) {
  const b = await box(sel); if (!b) throw new Error('nothing to tap: ' + sel);
  await sleep(400);
  const p = await box(sel);
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y }] });
  await sleep(80);
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
const marks = {};
const shot = (name) => { marks[name] = Date.now(); writeFileSync(`${out}/android-marks.json`, JSON.stringify(marks)); writeFileSync(`${out}/android-${name}.png`, adb('exec-out', 'screencap', '-p')); };
const btn = (label) => `document.querySelector('button[aria-label="${label}"]')`;
const note = (name) => `${btn(`Save ${name} to Downloads`)}?.closest('.attachment-file-group, .attachment-media-group, .lightbox')?.querySelector('.attachment-note')?.textContent`;
const log = [];
const step = (s, v) => { log.push({ s, v }); console.log(s, JSON.stringify(v)); };
sock.onopen = async () => {
  try {
    await send('Page.enable'); await send('Runtime.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', { source: readFileSync(initFile, 'utf8').replace('__PHOTO_B64__', readFileSync(photo).toString('base64')) });
    await send('Page.reload', { ignoreCache: true });
    await sleep(3000);
    if (!(await until(btn('Open Q3 report.pdf'), 8000))) {
      // Phone layout: the room tree first.
      const fold = await js(`!!document.querySelector('.th-others .th-fold[aria-expanded="false"]')`);
      if (fold) await tap(`document.querySelector('.th-others .th-fold')`);
      await sleep(600);
      await tap(`[...document.querySelectorAll('button, a')].find((b) => /field-notes/.test(b.textContent))`);
    }
    if (!(await until(btn('Open Q3 report.pdf'), 20000))) throw new Error('no PDF card: ' + await js('JSON.stringify(window.__calls)'));
    await box(btn('Open Q3 report.pdf')); await sleep(2500); shot('01-cards');

    await tap(btn('Save Q3 report.pdf to Downloads'));
    step('pdf save', await until(note('Q3 report.pdf')));
    await sleep(1500); shot('02-pdf-saved');

    await tap(btn('Open Q3 report.pdf'));
    await sleep(4000);
    step('pdf open: foreground', adb('shell', 'dumpsys activity activities | grep -m1 topResumedActivity').toString().trim());
    shot('03-pdf-opened');
    adb('shell', 'input', 'keyevent', 'KEYCODE_BACK'); await sleep(2500);
    step('pdf card after open', await js(`${btn('Open Q3 report.pdf')}.textContent`));

    await tap(btn('Save class.mp4 to Downloads'));
    await sleep(300); shot('04-video-saving');
    step('video save', await until(note('class.mp4'), 60000));
    await sleep(1500); shot('05-video-saved');

    // No Open button on video (it plays here); the real command opens it in the video app.
    step('mp4 open (command)', await js(`(async () => { const o = await window.__TAURI_INTERNALS__.invoke('relay_origin'); return window.__TAURI_INTERNALS__.invoke('media_open', { url: o + '/media/fc17a6aad1586839a26ba0aaf47dc8b11a9f12b8e2172d5ac28449003a0849e6.mp4', sha: 'fc17a6aad1586839a26ba0aaf47dc8b11a9f12b8e2172d5ac28449003a0849e6', mime: 'video/mp4' }).then(() => 'ok', (e) => 'error: ' + e); })()`));
    await sleep(4000);
    step('mp4 open: foreground', adb('shell', 'dumpsys activity activities | grep -m1 topResumedActivity').toString().trim());
    shot('06-mp4-opened');
    adb('shell', 'input', 'keyevent', 'KEYCODE_BACK'); await sleep(2500);

    // Images load once scrolled near.
    await box(`document.querySelector('button[aria-label$="image garden.jpg"]')`);
    await until(btn('Open image garden.jpg'), 15000);
    await tap(btn('Open image garden.jpg'));
    await until(`document.querySelector('.lightbox button[aria-label="Save garden.jpg to Downloads"]')`, 5000);
    await sleep(1200); shot('07-lightbox');
    await tap(`document.querySelector('.lightbox button[aria-label="Save garden.jpg to Downloads"]')`);
    step('image save', await until(`document.querySelector('.lightbox .attachment-note')?.textContent`));
    await sleep(1500); shot('08-image-saved');
    await tap(`document.querySelector('.lightbox-close')`);
    writeFileSync(`${out}/android-steps.json`, JSON.stringify(log, null, 2));
    process.exit(0);
  } catch (e) { console.error('failed:', e.message); writeFileSync(`${out}/android-steps.json`, JSON.stringify(log, null, 2)); process.exit(1); }
};
setTimeout(() => { console.error('timeout'); process.exit(2); }, 240000);

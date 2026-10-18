// Evaluate a JS file in a WebView over CDP; print the JSON result. usage: node cdp.mjs <ws-url> <expr.js>
import { readFileSync } from 'node:fs';
const [ws, file] = process.argv.slice(2);
const sock = new WebSocket(ws);
sock.onopen = () => sock.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: readFileSync(file, 'utf8'), awaitPromise: true, returnByValue: true } }));
sock.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) { console.log(JSON.stringify(d.result?.result?.value ?? d, null, 1).slice(0, 4000)); if (d.result?.exceptionDetails) console.log(JSON.stringify(d.result.exceptionDetails).slice(0, 2000)); process.exit(0); } };
sock.onerror = (e) => { console.error('ws error', e.message); process.exit(1); };
setTimeout(() => { console.error('timeout'); process.exit(2); }, 120000);

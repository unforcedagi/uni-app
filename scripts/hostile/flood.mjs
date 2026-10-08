// Flood the host side of a frame (review 1 P2-2 / review 2 flood2): big junk, many tiny junk, and wide/deep/huge payloads must cost almost nothing.
// Run: node --experimental-strip-types scripts/hostile/flood.mjs
import { createSession } from '../../src/interface/session.ts';
import { createRouter } from '../../src/interface/router.ts';
import { createThemeModule } from '../../src/interface/modules/theme.ts';
let replies = 0;
const router = createRouter([createThemeModule({ theme: () => ({}) })]);
let s = createSession({ post: () => { replies++; }, router, grant: {} });
const fresh = () => { s = createSession({ post: () => { replies++; }, router, grant: {} }); };
const ms = (f) => { const t = performance.now(); f(); return Math.round(performance.now() - t); };
const big = { uni: 1, id: 'x', ns: 'nope', method: 'x', params: { a: 'y'.repeat(20_000_000) } };
console.log('20 x 20MB invalid: ms', ms(() => { for (let i = 0; i < 20; i++) s.handle(big); }), 'replies', replies);
replies = 0;
console.log('200k small invalid: ms', ms(() => { for (let i = 0; i < 200000; i++) s.handle({ uni: 1, id: 'x', ns: 'nope', method: 'x' }); }), 'replies', replies);
fresh(); replies = 0;
const wide = {}; for (let i = 0; i < 3000; i++) wide['k' + i] = i;
console.log('60 x 3000-key objects: ms', ms(() => { for (let i = 0; i < 60; i++) s.handle({ uni: 1, id: 'w' + i, ns: 'theme', method: 'get', params: wide }); }), 'replies', replies);
fresh();
const arr = { a: new Array(5_000_000).fill(1) };
console.log('60 x 5M-element arrays: ms', ms(() => { for (let i = 0; i < 60; i++) s.handle({ uni: 1, id: 'a' + i, ns: 'theme', method: 'get', params: arr }); }));

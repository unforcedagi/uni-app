import assert from 'node:assert/strict';
import { build } from 'vite';
// Bundle the real payload loader so Node can resolve the app's extensionless imports.
const result = await build({ configFile: false, logLevel: 'silent', build: { write: false, minify: false, lib: { entry: 'src/areas/useAreas.ts', formats: ['es'] }, rollupOptions: { external: ['react', '@tauri-apps/api/core'] } } });
const output = (Array.isArray(result) ? result[0] : result).output;
const { writeFile, unlink } = await import('node:fs/promises');
const file = new URL('../.areas-payload-test.mjs', import.meta.url);
await writeFile(file, output[0].code);
try {
  const mod = await import(file.href);
  (globalThis as any).window = { __TAURI_INTERNALS__: { invoke: async (_cmd: string, args: any) => args.tag === 'area' ? [{ id: 'techne', path: 'Areas/Techne', tags: ['area'] }] : args.tag === 'area-brief' ? [{ path: 'Notes/stray', metadata: { area: 'Techne' }, content: 'STRAY' }] : args.tag === 'area-today' ? [{ path: 'Notes/today', metadata: { area: 'Today' }, content: 'STRAY TODAY' }] : [] } };
  const p = await mod.fetchPayload();
  assert.equal(p.areas[0].path, 'Areas/Techne');
  assert.equal(mod.toView(p, false).briefs['Areas/Techne'], undefined);
  assert.deepEqual(p.briefs, {}, 'metadata-only brief must not belong to Techne');
  assert.equal(p.today, null, 'Today must match its path');
  console.log('areasPayload: ok');
} finally { await unlink(file); delete (globalThis as any).window; }

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
  const asked: string[] = [];
  (globalThis as any).window = { __TAURI_INTERNALS__: { invoke: async (cmd: string, args: any) => { if (cmd === 'vault_query') asked.push(args.tag); return args.tag === 'area' ? [{ id: 'techne', path: 'Areas/Techne', tags: ['area'] }] : args.tag === 'area-brief' ? [{ path: 'Notes/stray', metadata: { area: 'Techne' }, content: 'STRAY' }] : args.tag === 'area-today' ? [{ id: 'today', path: 'Areas/Today', tags: ['area-today'], content: '## Needs you today\n- old' }] : []; } } };
  const p = await mod.fetchPayload();
  // T-335 (11-09): the Areas/Today roll-up is retired; the loader reads only the areas, the projects and their briefs
  assert.deepEqual([...asked].sort(), ['area', 'area-brief', 'project'], 'the areas load must never ask for the retired area-today tag');
  assert.equal('today' in p, false, 'the payload carries no Today note');
  assert.equal(p.areas[0].path, 'Areas/Techne');
  assert.equal(mod.toView(p, false).briefs['Areas/Techne'], undefined);
  assert.deepEqual(p.briefs, {}, 'metadata-only brief must not belong to Techne');
  // Project bodies must refresh without a revision, while known revisions reuse reads.
  const bodyResult = await build({ configFile: false, logLevel: 'silent', build: { write: false, minify: false, lib: { entry: 'src/areas/projectBody.ts', formats: ['es'] }, rollupOptions: { external: ['@tauri-apps/api/core'] } } });
  const bodyFile = new URL('../.project-body-test.mjs', import.meta.url);
  await writeFile(bodyFile, (Array.isArray(bodyResult) ? bodyResult[0] : bodyResult).output[0].code);
  try {
    const bodies = await import(bodyFile.href);
    let reads = 0;
    (globalThis as any).window.__TAURI_INTERNALS__.invoke = async () => ({ note: { content: `body ${++reads}` } });
    const node: { id: string; updatedAt: string | null } = { id: 'project', updatedAt: null };
    assert.equal(await bodies.projectBody('A', node), 'body 1');
    assert.equal(await bodies.projectBody('A', node), 'body 2');
    node.updatedAt = 'revision-1';
    assert.equal(await bodies.projectBody('A', node), 'body 3');
    assert.equal(await bodies.projectBody('A', node), 'body 3');
    assert.equal(await bodies.projectBody('B', node), 'body 4');
    bodies.clearProjectBodies();
    assert.equal(await bodies.projectBody('A', node), 'body 5');
    (globalThis as any).window.__TAURI_INTERNALS__.invoke = async () => { throw new Error('offline'); };
    bodies.clearProjectBodies();
    await assert.rejects(bodies.projectBody('A', node), /offline/);
    (globalThis as any).window.__TAURI_INTERNALS__.invoke = async () => ({ note: { content: 'recovered' } });
    assert.equal(await bodies.projectBody('A', node), 'recovered');
  } finally { await unlink(bodyFile); }
  console.log('areasPayload: ok');
} finally { await unlink(file); delete (globalThis as any).window; }

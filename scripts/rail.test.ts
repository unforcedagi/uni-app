import assert from 'node:assert/strict';
import { readLastSurface, saveLastSurface } from '../src/railCore.ts';
import { HOME_LAYOUT_KEY, migrateHomeLayout } from '../src/areas/homeLayout.ts';
const values = new Map<string, string>();
const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
assert.equal(readLastSurface(storage), 'uni');
saveLastSurface(storage, 'journal'); assert.equal(readLastSurface(storage), 'journal');
saveLastSurface(storage, 'uni'); assert.equal(readLastSurface(storage), 'uni');
const broken = { getItem: () => { throw Error(); }, setItem: () => { throw Error(); } };
assert.equal(readLastSurface(broken), 'uni'); saveLastSurface(broken, 'journal');
// the retired Home layout setting (Map, Octopus, Classic, the room tree) is dropped once at start (moved from the retired treehome test)
for (const was of ['tree', 'octopus', 'classic', 'rooms']) {
  const m = new Map([[HOME_LAYOUT_KEY, was]]);
  const st = { getItem: (k: string) => m.get(k) ?? null, removeItem: (k: string) => { m.delete(k); } };
  assert.equal(migrateHomeLayout(st), was); assert.equal(m.has(HOME_LAYOUT_KEY), false);
  assert.equal(migrateHomeLayout(st), null, 'the second start finds nothing to migrate');
}
assert.equal(migrateHomeLayout(null), null);
console.log('rail tests passed');

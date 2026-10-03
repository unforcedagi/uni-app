import assert from 'node:assert/strict';
import { countRecommendations, readLastSurface, saveLastSurface, isRecommendationNew } from '../src/railCore.ts';
assert.equal(countRecommendations(''), 0);
assert.equal(countRecommendations('- one\n* two\n  - nested\n\t* nested\n- three'), 3);
assert.equal(countRecommendations('- one\n```md\n- code\n~~~\n* code\n```\n* two\n   ~~~~\n- code\n~~~\n* code\n~~~~\n- three'), 3);
assert.equal(countRecommendations('```\n- unclosed'), 0);
for (const [content, expected] of [
  ['+ one', 1], ['1. one\n2. two', 2], ['- - -', 0],
  ['***', 0], ['---', 0], ['* * *', 0],
  ['  + nested\n  1. nested', 0],
  ['~~~md\n+ code\n1. code\n~~~\n+ visible', 1],
] as const) assert.equal(countRecommendations(content), expected, content);
const values = new Map<string, string>();
const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
assert.equal(readLastSurface(storage), 'uni');
saveLastSurface(storage, 'journal'); assert.equal(readLastSurface(storage), 'journal');
saveLastSurface(storage, 'uni'); assert.equal(readLastSurface(storage), 'uni');
const broken = { getItem: () => { throw Error(); }, setItem: () => { throw Error(); } };
assert.equal(readLastSurface(broken), 'uni'); saveLastSurface(broken, 'journal');
assert.equal(isRecommendationNew('2026-10-02', '2026-10-01'), true);
assert.equal(isRecommendationNew('2026-10-02', '2026-10-02'), false);
console.log('rail tests passed');

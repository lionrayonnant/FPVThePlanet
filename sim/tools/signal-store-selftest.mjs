// Selftest of the operator's resolved-signals record (issue #185).
// Run: node tools/signal-store-selftest.mjs
import assert from 'node:assert/strict';
import { MAX_RESOLVED, fromStored, withResolved, resolvedIds } from './signal-store-model.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };
const entry = (at, extra = {}) => ({ at, name: 'X', lat: 49.25, lon: 4.03, tier: 1, family: 'cinewhoop', holdS: 6.1, distM: 142, sessionId: 's1', photo: 0, ...extra });

t('garbage reads as empty', () => {
	for (const v of [undefined, null, 3, 'x', [], { resolved: 'x' }]) assert.deepEqual(fromStored(v), { resolved: {} });
});

t('valid entries survive, malformed ones are dropped', () => {
	const s = fromStored({ resolved: {
		'wd:Q1': entry(1),
		'wd:Q2': { at: 'x' },
		'not-an-id': entry(2),
		'wd:Q3': entry(3, { tier: 9 }),
		'wd:Q4': entry(4, { photo: null, sessionId: null, family: null }),
	} });
	assert.deepEqual(Object.keys(s.resolved).sort(), ['wd:Q1', 'wd:Q4']);
});

t('withResolved keeps the first resolution and returns a new object', () => {
	const a = withResolved(fromStored(null), 'wd:Q1', entry(10));
	const b = withResolved(a, 'wd:Q1', entry(20));
	assert.equal(b.resolved['wd:Q1'].at, 10);
	assert.notEqual(a, fromStored(null));
	assert.deepEqual([...resolvedIds(b)], ['wd:Q1']);
});

t('past MAX_RESOLVED the oldest goes', () => {
	let s = fromStored(null);
	for (let i = 0; i < MAX_RESOLVED + 3; i++) s = withResolved(s, `wd:Q${i + 1}`, entry(i));
	assert.equal(Object.keys(s.resolved).length, MAX_RESOLVED);
	assert.equal(s.resolved['wd:Q1'], undefined);
	assert.ok(s.resolved[`wd:Q${MAX_RESOLVED + 3}`]);
});

t('text is capped and control characters stripped', () => {
	const s = withResolved(fromStored(null), 'wd:Q1', entry(1, { name: 'A\u0000' + 'B'.repeat(200) }));
	assert.ok(s.resolved['wd:Q1'].name.length <= 60);
	assert.ok(!/\u0000/.test(s.resolved['wd:Q1'].name));
});

console.log(`signal-store: ${n} ok`);

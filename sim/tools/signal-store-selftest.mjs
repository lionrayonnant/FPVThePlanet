// Selftest of the operator's resolved-signals record (issue #185).
// Run: node tools/signal-store-selftest.mjs
import assert from 'node:assert/strict';
import { MAX_RESOLVED, fromStored, withResolved, withPhoto, withPlace, resolvedIds } from './signal-store-model.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };
const entry = (at, extra = {}) => ({ at, name: 'X', lat: 49.25, lon: 4.03, tier: 1, family: 'cinewhoop', holdS: 6.1, distM: 142, sessionId: 's1', photo: 0, place: null, ...extra });

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

t('withPhoto sets the photo of an entry written without one, once, on a new object', () => {
	const a = withResolved(fromStored(null), 'wd:Q1', entry(1, { photo: null }));
	const b = withPhoto(a, 'wd:Q1', 4);
	assert.notEqual(b, a);
	assert.equal(a.resolved['wd:Q1'].photo, null, 'input untouched');
	assert.equal(b.resolved['wd:Q1'].photo, 4);
	assert.equal(withPhoto(b, 'wd:Q1', 7).resolved['wd:Q1'].photo, 4, 'never overwritten');
	assert.deepEqual(withPhoto(a, 'wd:Q2', 4), a, 'unknown id: unchanged');
	for (const bad of [-1, 1.5, null, 'x']) assert.equal(withPhoto(a, 'wd:Q1', bad).resolved['wd:Q1'].photo, null);
});

t('a worst-case store fits the server body (1 MB) with headroom', () => {
	// 4-byte code points are the worst UTF-8 case for the capped names and the
	// place; the machine fields (family, sessionId) are ASCII tokens at their
	// cap.
	const wide = '\u{1F600}'.repeat(60);
	const widePlace = '\u{1F600}'.repeat(40);
	let s = { resolved: {} };
	for (let i = 0; i < MAX_RESOLVED; i++) {
		s.resolved[`wd:Q${999999000000 - i}`] = entry(1790000000000 + i, {
			name: wide, family: 'f'.repeat(200), sessionId: 's'.repeat(200), place: widePlace,
			lat: -49.12345678901234, lon: -179.1234567890123, holdS: 6.000000000000001, distM: 123456.78901234, photo: 999999, tier: 3,
		});
	}
	s = fromStored(s);
	assert.equal(Object.keys(s.resolved).length, MAX_RESOLVED);
	const bytes = Buffer.byteLength(JSON.stringify({ key: 'signals', value: s }));
	assert.ok(bytes < 0.85e6, `${bytes} bytes`);
});

t('withPlace sets the place of an entry resolved without one, once, on a new object', () => {
	const a = withResolved(fromStored(null), 'wd:Q1', entry(1, { place: null }));
	const b = withPlace(a, 'wd:Q1', 'Reims');
	assert.notEqual(b, a);
	assert.equal(a.resolved['wd:Q1'].place, null, 'input untouched');
	assert.equal(b.resolved['wd:Q1'].place, 'Reims');
	assert.equal(withPlace(b, 'wd:Q1', 'Paris').resolved['wd:Q1'].place, 'Reims', 'never overwritten');
	assert.deepEqual(withPlace(a, 'wd:Q2', 'Reims'), a, 'unknown id: unchanged');
	assert.equal(withPlace(a, 'wd:Q1', null).resolved['wd:Q1'].place, null, 'a null name leaves it null');
});

t('place is capped at 40 code points and control characters stripped', () => {
	const s = withResolved(fromStored(null), 'wd:Q1', entry(1, { place: '\u0000' + 'É'.repeat(200) }));
	assert.equal(Array.from(s.resolved['wd:Q1'].place).length, 40);
	assert.ok(!/\u0000/.test(s.resolved['wd:Q1'].place));
});

t('family and sessionId are ASCII tokens or null', () => {
	const s = withResolved(fromStored(null), 'wd:Q1', entry(1, { family: 'É', sessionId: 'a b' }));
	assert.equal(s.resolved['wd:Q1'].family, null);
	assert.equal(s.resolved['wd:Q1'].sessionId, null);
	const u = withResolved(fromStored(null), 'wd:Q1', entry(1, { sessionId: '3f2b8c1e-6d0a-4c5e-9b7f-1a2b3c4d5e6f' }));
	assert.equal(u.resolved['wd:Q1'].sessionId, '3f2b8c1e-6d0a-4c5e-9b7f-1a2b3c4d5e6f');
});

t('resolvedIds is memoised per stored object', () => {
	const a = withResolved(fromStored(null), 'wd:Q1', entry(1));
	assert.equal(resolvedIds(a), resolvedIds(a), 'same object, same Set');
	const b = withResolved(a, 'wd:Q2', entry(2));
	assert.notEqual(resolvedIds(b), resolvedIds(a));
	assert.deepEqual([...resolvedIds(b)].sort(), ['wd:Q1', 'wd:Q2']);
	assert.equal(resolvedIds(null).size, 0);
});

t('trace: a known shape is kept, anything else dropped; a hold entry has no trace key', () => {
	const s = fromStored({ resolved: {
		'wd:Q1': entry(1, { trace: 'spiral' }),
		'wd:Q2': entry(2, { trace: 'loop' }),
		'wd:Q3': entry(3),
	} });
	assert.equal(s.resolved['wd:Q1'].trace, 'spiral');
	assert.ok(!('trace' in s.resolved['wd:Q2']), 'an unknown shape is dropped, the entry kept');
	assert.ok(!('trace' in s.resolved['wd:Q3']), 'an old entry reads back unchanged');
	for (const shape of ['orbit', 'spiral', 'under', 'dive']) {
		assert.equal(withResolved(null, 'wd:Q9', entry(9, { trace: shape })).resolved['wd:Q9'].trace, shape);
	}
});

console.log(`signal-store: ${n} ok`);

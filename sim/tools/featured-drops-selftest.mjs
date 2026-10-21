// Selftest of the featured LIVE drop points (tools/featured-drops.mjs). No DOM,
// no I/O. Run: node tools/featured-drops-selftest.mjs
import assert from 'node:assert/strict';
import { FEATURED_DROPS, firstDropFor } from './featured-drops.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

t('FEATURED_DROPS: a short list, unique ids and names', () => {
	assert.ok(FEATURED_DROPS.length >= 3 && FEATURED_DROPS.length <= 8, 'a list, not a catalogue');
	assert.equal(new Set(FEATURED_DROPS.map((d) => d.id)).size, FEATURED_DROPS.length, 'unique ids');
	assert.equal(new Set(FEATURED_DROPS.map((d) => d.name)).size, FEATURED_DROPS.length, 'unique names');
});

t('FEATURED_DROPS: real coordinates, upper-case names', () => {
	for (const d of FEATURED_DROPS) {
		assert.ok(Number.isFinite(d.lat) && Math.abs(d.lat) <= 90, `${d.id}: latitude`);
		assert.ok(Number.isFinite(d.lon) && Math.abs(d.lon) <= 180, `${d.id}: longitude`);
		assert.ok(!(d.lat === 0 && d.lon === 0), `${d.id}: not the Gulf of Guinea`);
		assert.equal(d.name, d.name.toUpperCase(), `${d.id}: terminal voice`);
		assert.match(d.id, /^[a-z0-9-]+$/, `${d.id}: id`);
	}
	// Two drops closer than ~1 km would be the same city twice.
	for (const [i, a] of FEATURED_DROPS.entries()) {
		for (const b of FEATURED_DROPS.slice(i + 1)) {
			assert.ok(Math.hypot(a.lat - b.lat, a.lon - b.lon) > 0.01, `${a.id} / ${b.id}: distinct places`);
		}
	}
});

t('firstDropFor: pinned for an operator who never flew, nothing after', () => {
	assert.equal(firstDropFor(null), FEATURED_DROPS[0], 'no operator yet');
	assert.equal(firstDropFor({}), FEATURED_DROPS[0], 'no sessions field');
	assert.equal(firstDropFor({ sessions: [] }), FEATURED_DROPS[0], 'empty history');
	assert.equal(firstDropFor({ sessions: [{ id: 's1' }] }), null, 'one flight is enough');
	assert.equal(firstDropFor({ sessions: 'garbage' }), FEATURED_DROPS[0], 'a malformed record is no history');
});

console.log(`\n${n} featured-drops tests OK`);

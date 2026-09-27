// Selftest of the signal model (issue #185, spec 2026-09-27-signals-design.md).
// No DOM, no network. Run: node tools/signal-model-selftest.mjs
import assert from 'node:assert/strict';
import {
	TILE_Z, MIN_QUERY_ZOOM, MAX_TILES_PER_VIEW,
	tileOf, tileKey, tileBounds, tilesForView, overpassQuery,
} from './signal-model.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

const EIFFEL = { lat: 48.8584, lon: 2.2945 };

t('constants from the plan, verbatim', () => {
	assert.equal(TILE_Z, 12);
	assert.equal(MIN_QUERY_ZOOM, 11);
	assert.equal(MAX_TILES_PER_VIEW, 12);
});

t('tileOf: the z12 tile of the Eiffel Tower, computed independently', () => {
	// x = floor((lon+180)/360 * 4096) = floor(2074.107) = 2074
	// y = floor((1 - ln(tan φ + sec φ)/π)/2 * 4096) = 1409
	assert.deepEqual(tileOf(EIFFEL.lat, EIFFEL.lon), { x: 2074, y: 1409 });
});

t('tileKey is stable and carries the zoom', () => {
	assert.equal(tileKey({ x: 2074, y: 1409 }), 'z12/2074/1409');
});

t('tileBounds contains the point it came from, and n > s, e > w', () => {
	const b = tileBounds(tileOf(EIFFEL.lat, EIFFEL.lon));
	assert.ok(b.n > b.s && b.e > b.w);
	assert.ok(EIFFEL.lat >= b.s && EIFFEL.lat <= b.n, JSON.stringify(b));
	assert.ok(EIFFEL.lon >= b.w && EIFFEL.lon <= b.e, JSON.stringify(b));
	// 360 / 4096 degrees wide
	assert.ok(Math.abs((b.e - b.w) - 360 / 4096) < 1e-9);
});

t('tilesForView: null below MIN_QUERY_ZOOM', () => {
	const v = { s: 48.85, w: 2.28, n: 48.87, e: 2.31 };
	assert.equal(tilesForView(v, MIN_QUERY_ZOOM - 1), null);
});

t('tilesForView: a small view over Paris is one or a few tiles, deduped and sorted', () => {
	const v = { s: 48.85, w: 2.28, n: 48.87, e: 2.31 };
	const keys = tilesForView(v, 14);
	assert.ok(Array.isArray(keys) && keys.length >= 1 && keys.length <= 4, String(keys));
	assert.deepEqual(keys, [...new Set(keys)].sort());
	assert.ok(keys.includes('z12/2074/1409'));
});

t('tilesForView: a view too wide returns null rather than flooding Overpass', () => {
	const v = { s: 48.0, w: 1.0, n: 50.0, e: 4.0 };
	assert.equal(tilesForView(v, 12), null);
});

t('tilesForView: a view across the antimeridian is handled, not inverted', () => {
	const keys = tilesForView({ s: -17.1, w: 179.95, n: -17.0, e: -179.95 }, 13);
	assert.ok(Array.isArray(keys) && keys.length >= 2 && keys.length <= 4, String(keys));
	assert.ok(keys.some((k) => k.startsWith('z12/4095/')));
	assert.ok(keys.some((k) => k.startsWith('z12/0/')));
});

t('overpassQuery: timeout, output cap, wikidata filter, the bbox in s,w,n,e order', () => {
	const q = overpassQuery({ s: 1, w: 2, n: 3, e: 4 });
	assert.match(q, /^\[out:json\]\[timeout:25\]\[maxsize:\d+\];/);
	assert.match(q, /\(1,2,3,4\)/);
	assert.match(q, /out tags center \d+;$/);
	// every clause requires a wikidata tag: the notability filter
	const clauses = q.match(/nwr\[[^;]*;|way\[[^;]*;/g);
	assert.ok(clauses.length >= 5);
	for (const c of clauses) assert.match(c, /\["wikidata"\]/, c);
});

console.log(`signal-model: ${n} ok`);

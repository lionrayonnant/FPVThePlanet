// Selftest of the pure Nominatim-reverse helpers (issue #185) and of the
// cached, queued client (src/place-name.js) that wraps them. Fake fetch and
// a manual timer, like tools/signal-source-selftest.mjs: no network, no
// browser. Run: node tools/place-name-selftest.mjs
import assert from 'node:assert/strict';
import { reverseUrl, placeNameOf, placeKey, TILE_Z } from './place-name-model.mjs';
import { createPlaceNames, CACHE_TTL_MS, PLACE_VERSION, MIN_GAP_MS } from '../src/place-name.js';
import { memoryCache } from '../src/signal-source.js';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); };

await t('reverseUrl: jsonv2, this module\'s zoom, English', () => {
	const u = new URL(reverseUrl(49.2536, 4.0340));
	assert.equal(u.origin + u.pathname, 'https://nominatim.openstreetmap.org/reverse');
	assert.equal(u.searchParams.get('format'), 'jsonv2');
	assert.equal(u.searchParams.get('zoom'), String(TILE_Z));
	assert.equal(u.searchParams.get('lat'), '49.2536');
	assert.equal(u.searchParams.get('lon'), '4.034');
	assert.equal(u.searchParams.get('accept-language'), 'en');
});

await t('placeNameOf: a city', () => {
	assert.equal(placeNameOf({ address: { city: 'Reims', county: 'Marne' } }), 'REIMS');
});

await t('placeNameOf: town/village/municipality fall back below city', () => {
	assert.equal(placeNameOf({ address: { town: 'Sedan' } }), 'SEDAN');
	assert.equal(placeNameOf({ address: { village: 'Bazeilles' } }), 'BAZEILLES');
	assert.equal(placeNameOf({ address: { municipality: 'Charleville-Mézières' } }), 'CHARLEVILLE-MÉZIÈRES');
});

await t('placeNameOf: a natural area with no settlement falls back to county, then state', () => {
	assert.equal(placeNameOf({ address: { county: 'Ardennes' } }), 'ARDENNES');
	assert.equal(placeNameOf({ address: { state: 'Grand Est' } }), 'GRAND EST');
	assert.equal(placeNameOf({ address: { county: 'Ardennes', state: 'Grand Est' } }), 'ARDENNES', 'county wins over state');
});

await t('placeNameOf: garbage answers null instead of throwing', () => {
	for (const bad of [null, undefined, {}, { address: null }, { address: 'x' }, { address: {} }, 3, 'x']) {
		assert.equal(placeNameOf(bad), null);
	}
});

await t('placeNameOf: cleaned and capped at 40 code points, control characters stripped', () => {
	const s = placeNameOf({ address: { city: '\u0000' + 'a'.repeat(80) } });
	assert.equal(s.length, 40);
	assert.ok(!/\u0000/.test(s));
	assert.equal(placeNameOf({ address: { city: '  Reims  ' } }), 'REIMS', 'whitespace trimmed');
});

await t('placeKey: same z10 tile for nearby points, a different one further away; invalid input is null', () => {
	const a = placeKey(49.2536, 4.0340);
	const b = placeKey(49.26, 4.05); // a few km away, same tile at z10
	const c = placeKey(-33.87, 151.21); // Sydney: a different tile
	assert.equal(a, b);
	assert.notEqual(a, c);
	assert.match(a, /^z10\/\d+\/\d+$/);
	for (const bad of [[NaN, 4], [49, Infinity], [null, 4], [49, 'x']]) assert.equal(placeKey(...bad), null);
});

// ------------------------------------------------------- src/place-name.js

// A timer the test advances by hand, like signal-source-selftest's.
function manualTimer() {
	const pending = [];
	const schedule = (fn, ms) => { pending.push({ fn, ms }); return pending.length; };
	const fire = () => { const p = pending.splice(0); for (const x of p) x.fn(); return p; };
	return { schedule, fire, pending };
}

const okBody = (address) => ({ ok: true, json: async () => ({ address }) });

await t('constants', () => {
	assert.equal(CACHE_TTL_MS, 90 * 24 * 3600 * 1000);
	assert.equal(PLACE_VERSION, 1);
	assert.equal(MIN_GAP_MS, 1000);
});

await t('nameOf: one request, cached, memoised for a second call at the same place', async () => {
	const cache = memoryCache();
	const calls = [];
	const fetchFn = async (url) => { calls.push(url); return okBody({ city: 'Reims' }); };
	const client = createPlaceNames({ fetch: fetchFn, cache, schedule: setImmediate });
	assert.equal(await client.nameOf(49.2536, 4.0340), 'REIMS');
	assert.equal(await client.nameOf(49.26, 4.05), 'REIMS', 'same z10 tile: memoised, no new fetch');
	assert.equal(calls.length, 1);
	const key = placeKey(49.2536, 4.0340);
	assert.equal((await cache.get(key)).name, 'REIMS');
	assert.equal((await cache.get(key)).v, PLACE_VERSION);
});

await t('nameOf: a fresh cache entry answers without a fetch', async () => {
	const cache = memoryCache();
	const key = placeKey(49.2536, 4.0340);
	await cache.set(key, { v: PLACE_VERSION, at: Date.now(), name: 'REIMS' });
	const fetchFn = async () => { throw new Error('must not be called'); };
	const client = createPlaceNames({ fetch: fetchFn, cache, schedule: setImmediate });
	assert.equal(await client.nameOf(49.2536, 4.0340), 'REIMS');
});

await t('nameOf: an expired cache entry is refetched', async () => {
	const cache = memoryCache();
	const key = placeKey(49.2536, 4.0340);
	let now = 1_000_000_000_000;
	await cache.set(key, { v: PLACE_VERSION, at: now - CACHE_TTL_MS - 1, name: 'OLD' });
	const fetchFn = async () => okBody({ city: 'Reims' });
	const client = createPlaceNames({ fetch: fetchFn, cache, now: () => now, schedule: setImmediate });
	assert.equal(await client.nameOf(49.2536, 4.0340), 'REIMS');
});

await t('nameOf: never rejects — a fetch failure resolves null', async () => {
	const fetchFn = async () => { throw new Error('offline'); };
	const client = createPlaceNames({ fetch: fetchFn, cache: memoryCache(), schedule: setImmediate });
	assert.equal(await client.nameOf(49.2536, 4.0340), null);
	const fetchFn2 = async () => ({ ok: false, json: async () => ({}) });
	const client2 = createPlaceNames({ fetch: fetchFn2, cache: memoryCache(), schedule: setImmediate });
	assert.equal(await client2.nameOf(49.2536, 4.0340), null);
});

await t('nameOf: a failed lookup is not memoised — the next call asks again', async () => {
	let fail = true;
	const calls = [];
	const fetchFn = async (url) => {
		calls.push(url);
		if (fail) throw new Error('offline');
		return okBody({ city: 'Reims' });
	};
	const cache = memoryCache();
	const client = createPlaceNames({ fetch: fetchFn, cache, schedule: setImmediate });
	assert.equal(await client.nameOf(49.2536, 4.0340), null);
	assert.equal(await cache.get(placeKey(49.2536, 4.0340)), null, 'nothing cached either');
	fail = false;
	assert.equal(await client.nameOf(49.2536, 4.0340), 'REIMS', 'retried, and named');
	assert.equal(calls.length, 2);
	assert.equal(await client.nameOf(49.26, 4.05), 'REIMS', 'the success is memoised');
	assert.equal(calls.length, 2);
});

await t('nameOf: a genuine "no name" answer IS memoised and cached', async () => {
	const calls = [];
	const fetchFn = async (url) => { calls.push(url); return okBody({}); };
	const cache = memoryCache();
	const client = createPlaceNames({ fetch: fetchFn, cache, schedule: setImmediate });
	assert.equal(await client.nameOf(49.2536, 4.0340), null);
	assert.equal(await client.nameOf(49.2536, 4.0340), null);
	assert.equal(calls.length, 1, 'asked once');
	assert.equal((await cache.get(placeKey(49.2536, 4.0340))).name, null);
});

await t('nameOf: invalid coordinates resolve null without a fetch', async () => {
	const fetchFn = async () => { throw new Error('must not be called'); };
	const client = createPlaceNames({ fetch: fetchFn, cache: memoryCache(), schedule: setImmediate });
	assert.equal(await client.nameOf(NaN, 4), null);
});

await t('the queue: at most 1 request/s, even for places answered instantly', async () => {
	const tm = manualTimer();
	let now = 0;
	const calls = [];
	const fetchFn = async (url) => { calls.push(now); return okBody({ city: 'X' }); };
	const client = createPlaceNames({ fetch: fetchFn, cache: memoryCache(), now: () => now, schedule: tm.schedule });

	// Three different z10 tiles: none share a memo entry or a cache hit.
	const p1 = client.nameOf(49.25, 4.03);   // Reims
	const p2 = client.nameOf(48.85, 2.35);   // Paris
	const p3 = client.nameOf(45.75, 4.85);   // Lyon
	await new Promise((r) => setImmediate(r));

	assert.equal(tm.pending.length, 1);
	assert.equal(tm.pending[0].ms, 0, 'first request: no wait');
	tm.fire();
	await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));

	assert.equal(tm.pending.length, 1);
	assert.equal(tm.pending[0].ms, MIN_GAP_MS, 'second request waits out the full gap even though the first answered at once');
	now += MIN_GAP_MS;
	tm.fire();
	await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));

	assert.equal(tm.pending.length, 1);
	assert.equal(tm.pending[0].ms, MIN_GAP_MS);
	now += MIN_GAP_MS;
	tm.fire();

	assert.deepEqual(await Promise.all([p1, p2, p3]), ['X', 'X', 'X']);
	assert.equal(calls.length, 3);
	assert.equal(calls[1] - calls[0], MIN_GAP_MS);
	assert.equal(calls[2] - calls[1], MIN_GAP_MS);
});

console.log(`place-name: ${n} ok`);

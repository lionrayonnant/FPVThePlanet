// Selftest of the Overpass client (issue #185). Fake fetch, memory cache, a
// manual timer: no network, no browser. Run: node tools/signal-source-selftest.mjs
import assert from 'node:assert/strict';
import { createSignalSource, memoryCache, CACHE_TTL_MS, DEFAULT_RETRY_S, ENDPOINT } from '../src/signal-source.js';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); };

const REIMS = {
	type: 'way', id: 43263447, center: { lat: 49.2536, lon: 4.0340 },
	tags: { building: 'cathedral', name: 'Cathédrale Notre-Dame de Reims', wikidata: 'Q191783' },
};
const okBody = (els) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ elements: els }) });

// A fetch that records calls and tracks concurrency.
function fakeFetch(respond) {
	const calls = [];
	let inFlight = 0, maxInFlight = 0;
	const fn = async (url, init) => {
		calls.push({ url, init });
		inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
		try { await new Promise((r) => setImmediate(r)); return await respond(calls.length, url, init); }
		finally { inFlight--; }
	};
	return { fn, calls, max: () => maxInFlight };
}

// A timer the test advances by hand.
function manualTimer() {
	const pending = [];
	const schedule = (fn, ms) => { pending.push({ fn, ms }); return pending.length; };
	const fire = () => { const p = pending.splice(0); for (const x of p) x.fn(); return p; };
	return { schedule, fire, pending };
}

await t('constants', () => {
	assert.equal(ENDPOINT, 'https://overpass-api.de/api/interpreter');
	assert.equal(CACHE_TTL_MS, 30 * 24 * 3600 * 1000);
	assert.equal(DEFAULT_RETRY_S, 60);
});

await t('one POST per tile, form-encoded, never two in flight', async () => {
	const f = fakeFetch(() => okBody([REIMS]));
	const src = createSignalSource({ fetch: f.fn, cache: memoryCache() });
	src.request(['z12/2074/1409', 'z12/2075/1409', 'z12/2074/1409']);
	await src.idle();
	assert.equal(f.calls.length, 2);
	assert.equal(f.max(), 1);
	assert.equal(f.calls[0].url, ENDPOINT);
	assert.equal(f.calls[0].init.method, 'POST');
	assert.match(String(f.calls[0].init.body), /^data=/);
	assert.equal(src.status(), 'idle');
});

await t('a tile already loaded is never asked again', async () => {
	const f = fakeFetch(() => okBody([REIMS]));
	const src = createSignalSource({ fetch: f.fn, cache: memoryCache() });
	src.request(['z12/2074/1409']);
	await src.idle();
	src.request(['z12/2074/1409']);
	await src.idle();
	assert.equal(f.calls.length, 1);
});

await t('signals() dedups the same landmark returned by two tiles', async () => {
	const f = fakeFetch(() => okBody([REIMS]));
	const src = createSignalSource({ fetch: f.fn, cache: memoryCache() });
	src.request(['z12/1/1', 'z12/1/2']);
	await src.idle();
	assert.equal(src.signals().length, 1);
});

await t('a fresh cache entry answers without fetch; an expired one refetches', async () => {
	const cache = memoryCache();
	let now = 1_000_000;
	await cache.set('z12/2074/1409', { at: now, signals: [{ id: 'osm:way/1', tile: 'z12/2074/1409' }] });
	const f = fakeFetch(() => okBody([REIMS]));
	const src = createSignalSource({ fetch: f.fn, cache, now: () => now + CACHE_TTL_MS - 1 });
	src.request(['z12/2074/1409']);
	await src.idle();
	assert.equal(f.calls.length, 0);
	assert.equal(src.signals()[0].id, 'osm:way/1');

	const src2 = createSignalSource({ fetch: f.fn, cache, now: () => now + CACHE_TTL_MS + 1 });
	src2.request(['z12/2074/1409']);
	await src2.idle();
	assert.equal(f.calls.length, 1);
	assert.equal((await cache.get('z12/2074/1409')).signals[0].id, 'wd:Q191783');
});

await t('429: waits Retry-After seconds, then retries the same tile', async () => {
	const tm = manualTimer();
	const f = fakeFetch((i) => i === 1
		? { ok: false, status: 429, headers: { get: (h) => (h.toLowerCase() === 'retry-after' ? '7' : null) }, json: async () => ({}) }
		: okBody([REIMS]));
	const src = createSignalSource({ fetch: f.fn, cache: memoryCache(), schedule: tm.schedule });
	src.request(['z12/2074/1409']);
	await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
	await new Promise((r) => setImmediate(r));
	assert.equal(src.status(), 'waiting');
	assert.equal(tm.pending.length, 1);
	assert.equal(tm.pending[0].ms, 7000);
	tm.fire();
	await src.idle();
	assert.equal(f.calls.length, 2);
	assert.equal(src.status(), 'idle');
	assert.equal(src.signals().length, 1);
});

await t('429 without Retry-After uses DEFAULT_RETRY_S', async () => {
	const tm = manualTimer();
	const f = fakeFetch(() => ({ ok: false, status: 429, headers: { get: () => null }, json: async () => ({}) }));
	const src = createSignalSource({ fetch: f.fn, cache: memoryCache(), schedule: tm.schedule });
	src.request(['z12/1/1']);
	for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
	assert.equal(tm.pending[0].ms, DEFAULT_RETRY_S * 1000);
});

await t('a network error or a 5xx marks UNAVAILABLE, caches nothing, and a later request retries', async () => {
	const cache = memoryCache();
	let fail = true;
	const f = fakeFetch(() => { if (fail) throw new Error('offline'); return okBody([REIMS]); });
	const src = createSignalSource({ fetch: f.fn, cache });
	src.request(['z12/2074/1409']);
	await src.idle();
	assert.equal(src.status(), 'unavailable');
	assert.equal(await cache.get('z12/2074/1409'), null);
	fail = false;
	src.request(['z12/2074/1409']);
	await src.idle();
	assert.equal(src.status(), 'idle');
	assert.equal(src.signals().length, 1);

	const f5 = fakeFetch(() => ({ ok: false, status: 504, headers: { get: () => null }, json: async () => ({}) }));
	const s5 = createSignalSource({ fetch: f5.fn, cache: memoryCache() });
	s5.request(['z12/1/1']);
	await s5.idle();
	assert.equal(s5.status(), 'unavailable');
});

await t('onChange fires when signals or status change', async () => {
	let changes = 0;
	const f = fakeFetch(() => okBody([REIMS]));
	const src = createSignalSource({ fetch: f.fn, cache: memoryCache(), onChange: () => changes++ });
	src.request(['z12/2074/1409']);
	await src.idle();
	assert.ok(changes >= 2, `changes=${changes}`); // loading, then loaded
});

await t('a cache that throws does not break the source', async () => {
	const bad = { get: async () => { throw new Error('idb blocked'); }, set: async () => { throw new Error('idb blocked'); } };
	const f = fakeFetch(() => okBody([REIMS]));
	const src = createSignalSource({ fetch: f.fn, cache: bad });
	src.request(['z12/2074/1409']);
	await src.idle();
	assert.equal(src.signals().length, 1);
});

console.log(`signal-source: ${n} ok`);

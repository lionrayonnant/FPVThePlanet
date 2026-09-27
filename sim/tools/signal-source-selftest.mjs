// Selftest of the Overpass client (issue #185). Fake fetch, memory cache, a
// manual timer: no network, no browser. Run: node tools/signal-source-selftest.mjs
import assert from 'node:assert/strict';
import { createSignalSource, memoryCache, CACHE_TTL_MS, DEFAULT_RETRY_S, ENDPOINT } from '../src/signal-source.js';
import { MODEL_VERSION } from '../tools/signal-model.mjs';

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
	await cache.set('z12/2074/1409', { v: MODEL_VERSION, at: now, signals: [{ id: 'osm:way/1', tile: 'z12/2074/1409' }] });
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

await t('a cache entry with a stale MODEL_VERSION is a miss: refetched, and restored with the current version', async () => {
	const cache = memoryCache();
	await cache.set('z12/1/1', { v: 0, at: Date.now(), signals: [{ id: 'osm:way/1', tile: 'z12/1/1' }] });
	const f = fakeFetch(() => okBody([REIMS]));
	const src = createSignalSource({ fetch: f.fn, cache });
	src.request(['z12/1/1']);
	await src.idle();
	assert.equal(f.calls.length, 1);
	assert.equal(src.signals()[0].id, 'wd:Q191783');
	assert.equal((await cache.get('z12/1/1')).v, MODEL_VERSION);
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

await t('a network error or a 5xx marks UNAVAILABLE, caches nothing, and a later request (past the cooldown) retries', async () => {
	const cache = memoryCache();
	let fail = true;
	let now = 1_000_000;
	const f = fakeFetch(() => { if (fail) throw new Error('offline'); return okBody([REIMS]); });
	const src = createSignalSource({ fetch: f.fn, cache, now: () => now });
	src.request(['z12/2074/1409']);
	await src.idle();
	assert.equal(src.status(), 'unavailable');
	assert.equal(await cache.get('z12/2074/1409'), null);
	fail = false;
	now += DEFAULT_RETRY_S * 1000 + 1;
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

await t('a request inside the failure cooldown does not fetch', async () => {
	let now = 1_000_000;
	const f = fakeFetch(() => { throw new Error('offline'); });
	const src = createSignalSource({ fetch: f.fn, cache: memoryCache(), now: () => now });
	src.request(['z12/1/1']);
	await src.idle();
	assert.equal(f.calls.length, 1);
	now += DEFAULT_RETRY_S * 1000 - 1; // still cooling down
	src.request(['z12/1/1']);
	await src.idle();
	assert.equal(f.calls.length, 1, 'still cooling down: no new fetch');
});

await t('a 200 whose JSON carries an Overpass error remark is a failure: not cached, UNAVAILABLE, cools down', async () => {
	const cache = memoryCache();
	let now = 1_000_000;
	const errorBody = { ok: true, status: 200, headers: { get: () => null }, json: async () => ({
		remark: 'runtime error: Query timed out in "query" at line 1 after 26 seconds.', elements: [],
	}) };
	const f = fakeFetch(() => errorBody);
	const src = createSignalSource({ fetch: f.fn, cache, now: () => now });
	src.request(['z12/1/1']);
	await src.idle();
	assert.equal(src.status(), 'unavailable');
	assert.equal(await cache.get('z12/1/1'), null);
	assert.equal(src.signals().length, 0);

	// still cooling down: a re-request does not fetch again
	src.request(['z12/1/1']);
	await src.idle();
	assert.equal(f.calls.length, 1);
});

await t('subscribe fires when signals or status change', async () => {
	let changes = 0;
	const f = fakeFetch(() => okBody([REIMS]));
	const src = createSignalSource({ fetch: f.fn, cache: memoryCache() });
	src.subscribe(() => changes++);
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

await t('request() during fetch does not re-queue the tile; with an unreliable cache, exactly 1 fetch', async () => {
	const cache = {
		get: async () => { throw new Error('cache broken'); },
		set: async () => { throw new Error('cache broken'); }
	};
	let resolveFirst = null;
	const fetchPromise = new Promise(r => { resolveFirst = r; });
	const f = fakeFetch(async (i) => {
		if (i === 1) await fetchPromise;
		return okBody([REIMS]);
	});
	const src = createSignalSource({ fetch: f.fn, cache });
	src.request(['z12/2074/1409']);
	await new Promise((r) => setImmediate(r));
	src.request(['z12/2074/1409']);
	resolveFirst();
	await src.idle();
	assert.equal(f.calls.length, 1);
	assert.equal(src.signals().length, 1);
});

await t('request() replaces the waiting queue with the latest view: B and C never fetched once D supersedes them', async () => {
	let resolveA = null;
	const gate = new Promise((r) => { resolveA = r; });
	const f = fakeFetch(async (i) => { if (i === 1) await gate; return okBody([REIMS]); });
	const src = createSignalSource({ fetch: f.fn, cache: memoryCache() });
	src.request(['A', 'B', 'C']);
	await new Promise((r) => setImmediate(r)); // A is now in flight, B/C queued
	src.request(['D']);
	resolveA();
	await src.idle();
	assert.equal(f.calls.length, 2, 'only A then D — B and C were dropped from the superseded queue');
});

await t('a tile fails, then another tile is a cache hit → status is idle and signals are available', async () => {
	const cache = memoryCache();
	await cache.set('z12/1/2', { v: MODEL_VERSION, at: Date.now(), signals: [{ id: 'wd:Q191783', tile: 'z12/1/2' }] });

	let fail = true;
	const f = fakeFetch(() => { if (fail) throw new Error('offline'); return okBody([]); });
	const src = createSignalSource({ fetch: f.fn, cache });

	src.request(['z12/1/1']);
	await src.idle();
	assert.equal(src.status(), 'unavailable');

	src.request(['z12/1/2']);
	await src.idle();
	assert.equal(src.status(), 'idle');
	assert.equal(src.signals().length, 1);
});

await t('subscribe: every listener hears every change; unsubscribe stops it', async () => {
	const f = fakeFetch(() => okBody([REIMS]));
	const src = createSignalSource({ fetch: f.fn, cache: memoryCache() });
	let a = 0, b = 0;
	const offA = src.subscribe(() => a++);
	src.subscribe(() => b++);
	src.request(['z12/2074/1409']);
	await src.idle();
	assert.ok(a >= 1 && b >= 1 && a === b, `a=${a} b=${b}`);
	offA();
	const before = a;
	src.request(['z12/2075/1409']);
	await src.idle();
	assert.equal(a, before);
	assert.ok(b > before);
});

await t('a listener that throws does not stop the others', async () => {
	const f = fakeFetch(() => okBody([REIMS]));
	const src = createSignalSource({ fetch: f.fn, cache: memoryCache() });
	let heard = 0;
	src.subscribe(() => { throw new Error('boom'); });
	src.subscribe(() => heard++);
	// The source warns about the throwing listener; keep the test output clean.
	const warn = console.warn;
	let warned = 0;
	console.warn = () => { warned++; };
	try {
		src.request(['z12/2074/1409']);
		await src.idle();
	} finally { console.warn = warn; }
	assert.ok(heard >= 1);
	assert.ok(warned >= 1);
});

console.log(`signal-source: ${n} ok`);

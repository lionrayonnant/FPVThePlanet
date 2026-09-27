// Selftest of the place-info client (issue #185, lot 2b). Fake fetch keyed by
// URL origin, memory cache: no network, no browser. Run:
// node tools/place-info-selftest.mjs
import assert from 'node:assert/strict';
import { createPlaceInfo, PLACE_TTL_MS, PLACE_VERSION } from '../src/place-info.js';
import { memoryCache } from '../src/signal-source.js';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); };

// Trimmed from the real Panthéon answers (see tools/wikidata-model-selftest.mjs).
const ENTITY_OK = { entities: { Q188856: {
	descriptions: { en: { language: 'en', value: 'mausoleum in Paris for the most distinguished French people' } },
	claims: {
		P18: [{ rank: 'normal', mainsnak: { datavalue: { value: 'Panthéon, Paris 25 March 2012.jpg' } } }],
		P571: [{ rank: 'normal', mainsnak: { datavalue: { value: { time: '+1758-00-00T00:00:00Z', precision: 9 } } } }],
		P2048: [{ rank: 'normal', mainsnak: { datavalue: { value: { amount: '+83', unit: 'http://www.wikidata.org/entity/Q11573' } } } }],
	},
} } };

const ENTITY_NO_IMAGE = { entities: { Q188856: {
	descriptions: { en: { language: 'en', value: 'mausoleum in Paris for the most distinguished French people' } },
	claims: {},
} } };

const COMMONS_OK = { query: { pages: { 38044545: { imageinfo: [{
	thumburl: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/5/58/Panth%C3%A9on%2C_Paris_25_March_2012.jpg/500px-Panth%C3%A9on%2C_Paris_25_March_2012.jpg',
	thumbwidth: 480, thumbheight: 326,
	extmetadata: {
		Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:Trizek">Camille G&eacute;vaudan</a>' },
		LicenseShortName: { value: 'CC BY-SA 3.0' },
	},
}] } } } };

const EXPECTED_PHOTO = {
	url: COMMONS_OK.query.pages[38044545].imageinfo[0].thumburl,
	w: 480, h: 326, artist: 'Camille Gévaudan', license: 'CC BY-SA 3.0',
};

// A fetch that answers by the URL's origin: wikidata.org for the entity,
// commons.wikimedia.org for the photo. `respond` maps origin -> a response
// (or a function of the call count for that origin), and records every call.
function fakeFetch(respond) {
	const calls = [];
	const counts = new Map();
	const fn = async (url) => {
		calls.push(url);
		const origin = new URL(url).origin;
		const i = (counts.get(origin) ?? 0) + 1;
		counts.set(origin, i);
		const r = respond[origin];
		const out = typeof r === 'function' ? r(i) : r;
		if (out instanceof Error) throw out;
		return out;
	};
	return { fn, calls };
}

const ok = (json) => ({ ok: true, status: 200, json: async () => json });
const fail500 = { ok: false, status: 500, json: async () => ({}) };

await t('constants', () => {
	assert.equal(PLACE_TTL_MS, 30 * 24 * 3600 * 1000);
	assert.equal(PLACE_VERSION, 1);
});

await t('two concurrent info() for the same qid: one entity fetch, one Commons fetch, same object', async () => {
	const f = fakeFetch({
		'https://www.wikidata.org': ok(ENTITY_OK),
		'https://commons.wikimedia.org': ok(COMMONS_OK),
	});
	const pi = createPlaceInfo({ fetch: f.fn, cache: memoryCache() });
	const [a, b] = await Promise.all([pi.info('wd:Q188856'), pi.info('wd:Q188856')]);
	assert.equal(a, b);
	assert.deepEqual(a, {
		description: 'mausoleum in Paris for the most distinguished French people',
		year: 1758, heightM: 83, photo: EXPECTED_PHOTO,
	});
	assert.equal(f.calls.filter((u) => u.startsWith('https://www.wikidata.org')).length, 1);
	assert.equal(f.calls.filter((u) => u.startsWith('https://commons.wikimedia.org')).length, 1);
});

await t('a second info() after resolution is a cache hit: no fetch', async () => {
	const cache = memoryCache();
	const f = fakeFetch({
		'https://www.wikidata.org': ok(ENTITY_OK),
		'https://commons.wikimedia.org': ok(COMMONS_OK),
	});
	const pi = createPlaceInfo({ fetch: f.fn, cache });
	await pi.info('wd:Q188856');
	const before = f.calls.length;
	const again = await pi.info('wd:Q188856');
	assert.equal(f.calls.length, before);
	assert.deepEqual(again, {
		description: 'mausoleum in Paris for the most distinguished French people',
		year: 1758, heightM: 83, photo: EXPECTED_PHOTO,
	});
});

await t('entity fetch fails: resolves null, caches nothing, a later call retries', async () => {
	const cache = memoryCache();
	let entityCalls = 0;
	const f = fakeFetch({
		'https://www.wikidata.org': () => { entityCalls++; return fail500; },
		'https://commons.wikimedia.org': ok(COMMONS_OK),
	});
	const pi = createPlaceInfo({ fetch: f.fn, cache });
	assert.equal(await pi.info('wd:Q188856'), null);
	assert.equal(entityCalls, 1);
	assert.equal(await cache.get('Q188856'), null);
	assert.equal(await pi.info('wd:Q188856'), null);
	assert.equal(entityCalls, 2, 'retried, not cached as a failure');
});

await t('entity OK, Commons throws: photo null, not cached, a later call retries Commons', async () => {
	const cache = memoryCache();
	let commonsCalls = 0;
	const f = fakeFetch({
		'https://www.wikidata.org': ok(ENTITY_OK),
		'https://commons.wikimedia.org': () => { commonsCalls++; throw new Error('offline'); },
	});
	const warn = console.warn;
	console.warn = () => {};
	let pi, first, second;
	try {
		pi = createPlaceInfo({ fetch: f.fn, cache });
		first = await pi.info('wd:Q188856');
	} finally { console.warn = warn; }
	assert.deepEqual(first, {
		description: 'mausoleum in Paris for the most distinguished French people',
		year: 1758, heightM: 83, photo: null,
	});
	assert.equal(commonsCalls, 1);
	assert.equal(await cache.get('Q188856'), null, 'the entity had an image: a null photo is not final, not cached');

	// A later call (image known, Commons still failing) retries Commons, not the
	// cache: the entity had an image, so a null photo is not final.
	console.warn = () => {};
	try { second = await pi.info('wd:Q188856'); } finally { console.warn = warn; }
	assert.deepEqual(second, first);
	assert.equal(commonsCalls, 2, 'retried Commons — a P18 image with no photo yet is not final');
});

await t('entity without P18: photo null, no Commons fetch, cached', async () => {
	const cache = memoryCache();
	const f = fakeFetch({
		'https://www.wikidata.org': ok(ENTITY_NO_IMAGE),
		'https://commons.wikimedia.org': () => { throw new Error('should not be called'); },
	});
	const pi = createPlaceInfo({ fetch: f.fn, cache });
	const info = await pi.info('wd:Q188856');
	assert.deepEqual(info, {
		description: 'mausoleum in Paris for the most distinguished French people',
		year: null, heightM: null, photo: null,
	});
	assert.equal(f.calls.filter((u) => u.startsWith('https://commons.wikimedia.org')).length, 0);
	const cached = await cache.get('Q188856');
	assert.ok(cached);

	const before = f.calls.length;
	const again = await pi.info('wd:Q188856');
	assert.deepEqual(again, info);
	assert.equal(f.calls.length, before, 'no image ever: the cached null photo is final');
});

await t('a stale v in the cache is a miss: refetched', async () => {
	const cache = memoryCache();
	await cache.set('Q188856', { v: 0, at: Date.now(), info: { description: 'old', year: null, heightM: null, photo: null } });
	const f = fakeFetch({
		'https://www.wikidata.org': ok(ENTITY_NO_IMAGE),
		'https://commons.wikimedia.org': () => { throw new Error('should not be called'); },
	});
	const pi = createPlaceInfo({ fetch: f.fn, cache });
	const info = await pi.info('wd:Q188856');
	assert.equal(info.description, 'mausoleum in Paris for the most distinguished French people');
	assert.equal(f.calls.filter((u) => u.startsWith('https://www.wikidata.org')).length, 1);
});

await t('an expired cache entry is a miss: refetched', async () => {
	const cache = memoryCache();
	let now = 1_000_000;
	await cache.set('Q188856', { v: PLACE_VERSION, at: now, info: { description: 'old', year: null, heightM: null, photo: null } });
	const f = fakeFetch({
		'https://www.wikidata.org': ok(ENTITY_NO_IMAGE),
		'https://commons.wikimedia.org': () => { throw new Error('should not be called'); },
	});
	const fresh = createPlaceInfo({ fetch: f.fn, cache, now: () => now + PLACE_TTL_MS - 1 });
	await fresh.info('wd:Q188856');
	assert.equal(f.calls.length, 0, 'still fresh: no fetch');

	const stale = createPlaceInfo({ fetch: f.fn, cache, now: () => now + PLACE_TTL_MS + 1 });
	const info = await stale.info('wd:Q188856');
	assert.equal(info.description, 'mausoleum in Paris for the most distinguished French people');
	assert.equal(f.calls.length, 1);
});

await t('a malformed qid resolves null with no fetch', async () => {
	const f = fakeFetch({
		'https://www.wikidata.org': () => { throw new Error('should not be called'); },
		'https://commons.wikimedia.org': () => { throw new Error('should not be called'); },
	});
	const pi = createPlaceInfo({ fetch: f.fn, cache: memoryCache() });
	assert.equal(await pi.info('osm:way/1'), null);
	assert.equal(await pi.info(''), null);
	assert.equal(await pi.info(undefined), null);
	assert.equal(f.calls.length, 0);
});

console.log(`place-info: ${n} ok`);

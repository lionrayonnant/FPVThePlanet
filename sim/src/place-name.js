// A short place name for a lat/lon (issue #185): what the DATA screen shows
// next to a cluster of signals, e.g. "REIMS". Wraps
// tools/place-name-model.mjs's pure URL/parsing with a fetch, a cache and a
// queue, following src/signal-source.js's and src/place-info.js's pattern.
//
// Nominatim's usage policy caps public requests at 1/s: every lookup goes
// through one queue, one request in flight, spaced by MIN_GAP_MS regardless
// of how fast each answer comes back. A failure never surfaces past this
// module: nameOf() only ever resolves, with a name or null.
import { reverseUrl, placeNameOf, placeKey } from '../tools/place-name-model.mjs';
import { memoryCache, idbCache } from './signal-source.js';

// Place names change far less often than the landmarks around them.
export const CACHE_TTL_MS = 90 * 24 * 3600 * 1000;
export const PLACE_VERSION = 1;
export const MIN_GAP_MS = 1000;

export function createPlaceNames({ fetch: fetchFn, cache = memoryCache(), now = Date.now, schedule = setTimeout } = {}) {
	const memo = new Map();  // placeKey -> Promise<string|null>
	const queue = [];        // { lat, lon, resolve }
	let busy = false;
	let lastStart = -Infinity;

	async function fromCache(key) {
		try {
			const hit = await cache.get(key);
			if (hit && hit.v === PLACE_VERSION && now() - hit.at < CACHE_TTL_MS) return { name: hit.name };
		} catch { /* a broken cache is a missing cache */ }
		return null; // "not cached" — distinct from "cached as no name"
	}
	async function toCache(key, name) {
		try { await cache.set(key, { v: PLACE_VERSION, at: now(), name }); } catch { /* see fromCache */ }
	}

	// Resolves { name, failed }: a genuine "no name here" answer is kept (cache
	// and memo), a failed request is not — the next nameOf() asks again.
	async function run(key, job) {
		let name = null;
		let failed = false;
		try {
			const res = await fetchFn(reverseUrl(job.lat, job.lon));
			if (!res.ok) throw new Error(String(res.status));
			name = placeNameOf(await res.json());
			await toCache(key, name);
		} catch { failed = true; /* unavailable: passed on as null, never a rejection */ }
		job.resolve({ name, failed });
	}

	function pump() {
		if (busy || !queue.length) return;
		busy = true;
		const wait = Math.max(0, MIN_GAP_MS - (now() - lastStart));
		schedule(() => {
			const { key, job } = queue.shift();
			lastStart = now();
			run(key, job).finally(() => { busy = false; pump(); });
		}, wait);
	}

	return {
		nameOf(lat, lon) {
			const key = placeKey(lat, lon);
			if (key === null) return Promise.resolve(null);
			const running = memo.get(key);
			if (running) return running;
			const p = fromCache(key).then((hit) => {
				if (hit) return hit.name;
				return new Promise((resolve) => { queue.push({ key, job: { lat, lon, resolve } }); pump(); })
					.then(({ name, failed }) => {
						// Offline or rate-limited now is not "unnamed" for the page's life.
						if (failed && memo.get(key) === p) memo.delete(key);
						return name;
					});
			});
			memo.set(key, p);
			return p;
		},
	};
}

// One per page: every consumer (DATA, the scanner) shares its memo, its
// queue and its IndexedDB cache, so the 1 req/s budget is spent once, not
// per caller. Created on first use — Node imports this module in selftests
// and must not touch indexedDB or AbortSignal.timeout.
let shared = null;
export function sharedPlaceNames() {
	return shared ??= createPlaceNames({
		fetch: (url) => fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) }),
		cache: idbCache('fpvtp-place-names'),
	});
}

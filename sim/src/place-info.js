// The Wikidata / Commons facts of a landmark, cached (issue #185, lot 2b).
// Parsing is pure (tools/wikidata-model.mjs); this module owns the fetch, the
// in-flight dedup and the cache, following src/signal-source.js's pattern.
//
// The entity and its Commons photo are cached apart (`e:<qid>`, `p:<qid>`), so
// retrying a photo never refetches the entity. A failure of either is never
// cached as data: it goes in an in-memory negative cache instead (retry after
// RETRY_MS, RETRY_429_MS when rate-limited), so a landmark held in frame for
// seconds, or a server saying "slow down", does not become a request storm.
// An entity without a P18 image has a final null photo: nothing to fetch.
import { entityUrl, parseEntity, commonsUrl, parseCommons, qidOf } from '../tools/wikidata-model.mjs';
import { memoryCache, idbCache } from './signal-source.js';

export const PLACE_TTL_MS = 30 * 24 * 3600 * 1000;
export const PLACE_VERSION = 2;
export const RETRY_MS = 5 * 60 * 1000;
export const RETRY_429_MS = 30 * 60 * 1000;

async function fetchJson(fetchFn, url) {
	const res = await fetchFn(url);
	if (!res.ok) {
		const err = new Error(`${url} answered ${res.status}`);
		err.status = res.status;
		throw err;
	}
	return res.json();
}

export function createPlaceInfo({ fetch: fetchFn, cache = memoryCache(), now = Date.now } = {}) {
	const inFlight = new Map(); // qid -> Promise<Info|null>
	const retryAfter = new Map(); // cache key -> epoch ms before which it is not refetched

	const backingOff = (key) => (retryAfter.get(key) ?? -Infinity) > now();
	const backOff = (key, e) => retryAfter.set(key, now() + (e?.status === 429 ? RETRY_429_MS : RETRY_MS));

	async function fromCache(key) {
		try {
			const hit = await cache.get(key);
			if (hit && hit.v === PLACE_VERSION && now() - hit.at < PLACE_TTL_MS) return hit;
		} catch { /* a broken cache is a missing cache */ }
		return null;
	}
	async function toCache(key, value) {
		try { await cache.set(key, { v: PLACE_VERSION, at: now(), ...value }); } catch { /* see fromCache */ }
	}

	async function entityOf(qid) {
		const key = `e:${qid}`;
		const hit = await fromCache(key);
		if (hit) return hit.entity;
		if (backingOff(key)) return null;
		try {
			const entity = parseEntity(await fetchJson(fetchFn, entityUrl(qid)), qid);
			await toCache(key, { entity });
			return entity;
		} catch (e) {
			backOff(key, e);
			return null;
		}
	}

	async function photoOf(qid, image) {
		if (!image) return null; // no P18: null is final
		const key = `p:${qid}`;
		const hit = await fromCache(key);
		if (hit) return hit.photo;
		if (backingOff(key)) return null;
		try {
			// Commons answered (even with no usable image): final, cached.
			const photo = parseCommons(await fetchJson(fetchFn, commonsUrl(image)));
			await toCache(key, { photo });
			return photo;
		} catch (e) {
			console.warn('[place-info] Commons fetch failed', e);
			backOff(key, e);
			return null;
		}
	}

	async function load(qid) {
		const entity = await entityOf(qid);
		if (!entity) return null;
		const photo = await photoOf(qid, entity.image);
		return { description: entity.description, year: entity.year, heightM: entity.heightM, photo };
	}

	return {
		info(signalId) {
			const qid = qidOf(signalId);
			if (!qid) return Promise.resolve(null);
			const running = inFlight.get(qid);
			if (running) return running;
			const p = load(qid).finally(() => inFlight.delete(qid));
			inFlight.set(qid, p);
			return p;
		},
	};
}

// One per page: the card and any recap share its memory and its IndexedDB
// cache. Created on first use — Node imports this module in selftests and
// must not touch indexedDB or AbortSignal.timeout.
let shared = null;
export function sharedPlaceInfo() {
	return shared ??= createPlaceInfo({
		fetch: (url) => fetch(url, { signal: AbortSignal.timeout(15_000) }),
		cache: idbCache('fpvtp-places'),
	});
}

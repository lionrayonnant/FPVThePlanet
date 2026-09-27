// The Wikidata / Commons facts of a landmark, cached (issue #185, lot 2b).
// Parsing is pure (tools/wikidata-model.mjs); this module owns the fetch, the
// in-flight dedup and the cache, following src/signal-source.js's pattern.
//
// Caching rule: an entity fetch failure is never cached — retry next time.
// A Commons failure IS cached once the entity had no image to begin with
// (photo: null is final), but NOT cached when the entity has a P18 image and
// Commons still failed (the photo is worth retrying later).
import { entityUrl, parseEntity, commonsUrl, parseCommons, qidOf } from '../tools/wikidata-model.mjs';
import { memoryCache, idbCache } from './signal-source.js';

export const PLACE_TTL_MS = 30 * 24 * 3600 * 1000;
export const PLACE_VERSION = 1;

async function fetchJson(fetchFn, url) {
	const res = await fetchFn(url);
	if (!res.ok) throw new Error(`${url} answered ${res.status}`);
	return res.json();
}

export function createPlaceInfo({ fetch: fetchFn, cache = memoryCache(), now = Date.now } = {}) {
	const inFlight = new Map(); // qid -> Promise<Info|null>

	async function load(qid) {
		let entity;
		try {
			entity = parseEntity(await fetchJson(fetchFn, entityUrl(qid)), qid);
		} catch {
			// Not cached: a later call retries the whole entity.
			return null;
		}

		let photo = null;
		let photoFinal = true; // no image at all: null is the answer, cache it
		if (entity.image) {
			photoFinal = false; // an image exists: a failed fetch is not final
			try {
				photo = parseCommons(await fetchJson(fetchFn, commonsUrl(entity.image)));
				photoFinal = true; // Commons answered (even with no usable image): final
			} catch (e) {
				console.warn('[place-info] Commons fetch failed', e);
			}
		}

		const info = { description: entity.description, year: entity.year, heightM: entity.heightM, photo };
		if (photoFinal) {
			try { await cache.set(qid, { v: PLACE_VERSION, at: now(), info }); } catch { /* a broken cache is a missing cache */ }
		}
		return info;
	}

	return {
		async info(signalId) {
			const qid = qidOf(signalId);
			if (!qid) return null;

			try {
				const hit = await cache.get(qid);
				if (hit && hit.v === PLACE_VERSION && now() - hit.at < PLACE_TTL_MS) return hit.info;
			} catch { /* a broken cache is a missing cache */ }

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

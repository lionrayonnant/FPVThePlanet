// The Overpass client for signals (issue #185, spec §1). Everything the
// browser would own — fetch, cache, timer — is injected, so the queue logic is
// checked in Node (tools/signal-source-selftest.mjs).
//
// The public Overpass instance allows ~10 000 queries/day/IP and 2 concurrent
// slots. The rules that keep us far from both: one request in flight, one
// request per tile until the cache expires, Retry-After honoured on 429.
// Failure never blocks anything: the scanner shows UNAVAILABLE and the game
// plays without signals.
import { tileBounds, overpassQuery, parseOverpass } from '../tools/signal-model.mjs';

export const ENDPOINT = 'https://overpass-api.de/api/interpreter';
// Landmarks do not move.
export const CACHE_TTL_MS = 30 * 24 * 3600 * 1000;
export const DEFAULT_RETRY_S = 60;

export function memoryCache() {
	const m = new Map();
	return {
		get: async (k) => m.get(k) ?? null,
		set: async (k, v) => { m.set(k, v); },
	};
}

// One object store, keyed by tile. Any IndexedDB failure (private window,
// blocked storage) degrades to a memory cache for this page's life.
export function idbCache(name = 'fpvtp-signals') {
	const STORE = 'tiles';
	let dbP = null;
	const open = () => dbP ??= new Promise((resolve, reject) => {
		const req = indexedDB.open(name, 1);
		req.onupgradeneeded = () => req.result.createObjectStore(STORE);
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
	const fallback = memoryCache();
	const tx = async (mode, fn) => {
		const db = await open();
		return new Promise((resolve, reject) => {
			const r = fn(db.transaction(STORE, mode).objectStore(STORE));
			r.onsuccess = () => resolve(r.result ?? null);
			r.onerror = () => reject(r.error);
		});
	};
	return {
		get: (k) => tx('readonly', (s) => s.get(k)).catch(() => fallback.get(k)),
		set: (k, v) => tx('readwrite', (s) => s.put(v, k)).then(() => {}).catch(() => fallback.set(k, v)),
	};
}

const tileOfKey = (key) => {
	const [, x, y] = key.split('/').map(Number);
	return { x, y };
};

export function createSignalSource({
	fetch: fetchFn,
	cache = memoryCache(),
	now = Date.now,
	schedule = setTimeout,
	onChange = () => {},
} = {}) {
	const loaded = new Map();     // tileKey -> Signal[]
	const queue = [];             // tileKeys waiting
	let busy = false;             // a request (or a backoff) is running
	let current = null;           // the tile key currently in flight (or being waited on after 429)
	let state = 'idle';
	let idleWaiters = [];

	// Reassignable: the source outlives a scanner mount, each mount plugs its
	// own listener in (src/scanner.js).
	const api = { onChange };
	const setState = (s) => { if (s !== state) { state = s; api.onChange(); } };
	const settle = () => {
		if (busy || queue.length) return;
		const w = idleWaiters; idleWaiters = [];
		for (const r of w) r();
	};

	async function fromCache(key) {
		try {
			const hit = await cache.get(key);
			if (hit && Array.isArray(hit.signals) && now() - hit.at < CACHE_TTL_MS) return hit.signals;
		} catch { /* a broken cache is a missing cache */ }
		return null;
	}

	async function pump() {
		if (busy) return;
		const key = queue.shift();
		if (key === undefined) { settle(); return; }
		busy = true;
		current = key;
		try {
			const cached = await fromCache(key);
			if (cached) {
				loaded.set(key, cached);
				setState('idle');
				api.onChange();
			} else {
				setState('loading');
				const res = await fetchFn(ENDPOINT, {
					method: 'POST',
					headers: { 'content-type': 'application/x-www-form-urlencoded' },
					body: `data=${encodeURIComponent(overpassQuery(tileBounds(tileOfKey(key))))}`,
				});
				if (res.status === 429) {
					const s = Number(res.headers?.get?.('retry-after'));
					const waitMs = (Number.isFinite(s) && s > 0 ? s : DEFAULT_RETRY_S) * 1000;
					queue.unshift(key);
					setState('waiting');
					// `busy` stays true through the wait: nothing else may start. `current` stays
					// set so request() won't re-queue it.
					schedule(() => { busy = false; pump(); }, waitMs);
					return;
				}
				if (!res.ok) throw new Error(`Overpass answered ${res.status}`);
				const signals = parseOverpass(await res.json());
				loaded.set(key, signals);
				try { await cache.set(key, { at: now(), signals }); } catch { /* see fromCache */ }
				setState('idle');
				api.onChange();
			}
		} catch {
			// Not cached, not marked loaded: a later request() retries it.
			setState('unavailable');
		}
		busy = false;
		current = null;
		pump();
	}

	return Object.assign(api, {
		request(keys) {
			for (const k of keys ?? []) {
				if (typeof k !== 'string' || loaded.has(k) || queue.includes(k) || current === k) continue;
				queue.push(k);
			}
			pump();
		},
		signals() {
			const byId = new Map();
			for (const list of loaded.values()) for (const s of list) if (!byId.has(s.id)) byId.set(s.id, s);
			return [...byId.values()];
		},
		status: () => state,
		idle: () => new Promise((r) => { idleWaiters.push(r); settle(); }),
	});
}

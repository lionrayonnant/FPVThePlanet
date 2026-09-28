// The Overpass client for signals (issue #185, spec §1). Everything the
// browser would own — fetch, cache, timer — is injected, so the queue logic is
// checked in Node (tools/signal-source-selftest.mjs).
//
// The public Overpass instance allows ~10 000 queries/day/IP and 2 concurrent
// slots. The rules that keep us far from both: one request in flight, one
// request per tile until the cache expires, Retry-After honoured on 429.
// Failure never blocks anything: the scanner shows UNAVAILABLE and the game
// plays without signals.
import { tileBounds, overpassQuery, parseOverpass, MODEL_VERSION } from '../tools/signal-model.mjs';

export const ENDPOINT = 'https://overpass-api.de/api/interpreter';
// Landmarks do not move.
export const CACHE_TTL_MS = 30 * 24 * 3600 * 1000;
export const DEFAULT_RETRY_S = 60;

export function memoryCache() {
	const m = new Map();
	return {
		get: async (k) => m.get(k) ?? null,
		set: async (k, v) => { m.set(k, v); },
		entries: async () => [...m.entries()],
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
		entries: () => open().then((db) => new Promise((resolve, reject) => {
			const out = [];
			const req = db.transaction(STORE, 'readonly').objectStore(STORE).openCursor();
			req.onsuccess = () => {
				const cur = req.result;
				if (cur) { out.push([cur.key, cur.value]); cur.continue(); }
				else resolve(out);
			};
			req.onerror = () => reject(req.error);
		})).catch(() => fallback.entries()),
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
} = {}) {
	const loaded = new Map();     // tileKey -> Signal[]
	const queue = [];             // tileKeys waiting
	const failedUntil = new Map(); // tileKey -> ms timestamp before which it must not be re-asked
	let busy = false;             // a request (or a backoff) is running
	let current = null;           // the tile key currently in flight (or being waited on after 429)
	let backoff = false;          // true while `current` is a key waiting out a 429, not actively fetching
	let state = 'idle';
	let idleWaiters = [];
	let batch = new Set();        // tileKeys of the latest request() call, for progress()

	const listeners = new Set();
	const emit = () => {
		for (const fn of listeners) {
			try { fn(); } catch (e) { console.warn('[signals] listener failed', e); }
		}
	};
	const api = {};
	const setState = (s) => { if (s !== state) { state = s; emit(); } };
	const settle = () => {
		if (busy || queue.length) return;
		const w = idleWaiters; idleWaiters = [];
		for (const r of w) r();
	};

	const validCache = (hit) => hit && hit.v === MODEL_VERSION && Array.isArray(hit.signals) && now() - hit.at < CACHE_TTL_MS;
	async function fromCache(key) {
		try {
			const hit = await cache.get(key);
			if (validCache(hit)) return hit.signals;
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
				failedUntil.delete(key); // a stale cooldown from an earlier failure no longer applies
				// No emit here, not even through setState: `current` is still set,
				// and a listener would see a cache hit as a tile in flight. The emit
				// after `current` resets below reports both changes.
				state = 'idle';
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
					backoff = true;
					setState('waiting');
					// `busy` stays true through the wait: nothing else may start. `current` stays
					// set so request() won't re-queue it.
					schedule(() => { busy = false; backoff = false; pump(); }, waitMs);
					return;
				}
				if (!res.ok) throw new Error(`Overpass answered ${res.status}`);
				const raw = await res.json();
				// A 200 can still carry an Overpass runtime error (timeout, maxsize):
				// treat it exactly like a failed request, not a tile with 0 signals.
				if (typeof raw?.remark === 'string' && /error/i.test(raw.remark)) throw new Error(`Overpass: ${raw.remark}`);
				const signals = parseOverpass(raw);
				loaded.set(key, signals);
				try { await cache.set(key, { v: MODEL_VERSION, at: now(), signals }); } catch { /* see fromCache */ }
				failedUntil.delete(key); // a stale cooldown from an earlier failure no longer applies
				setState('idle');
				emit();
			}
		} catch {
			// Not cached, not marked loaded: a later request() retries it, once its
			// cooldown has expired.
			failedUntil.set(key, now() + DEFAULT_RETRY_S * 1000);
			setState('unavailable');
		}
		const wasCurrent = current;
		busy = false;
		current = null;
		// `current` returning to null is itself a progress change, even when the
		// tile's outcome didn't flip `state` (e.g. it was already 'unavailable').
		if (wasCurrent !== null) emit();
		pump();
	}

	return Object.assign(api, {
		// Replaces the waiting queue with this view's missing tiles: what is no
		// longer on screen is no longer worth asking for. The key actively in
		// flight, or waiting out a 429, is untouched — and kept at the head if it
		// was already there, so its retry is not lost.
		request(keys) {
			const t = now();
			const head = backoff && queue[0] === current ? current : null;
			const wanted = [];
			batch = new Set(); // a new batch starts: progress() reports on this view only
			for (const k of keys ?? []) {
				if (typeof k !== 'string') continue;
				batch.add(k);
				if (loaded.has(k) || k === current || k === head) continue;
				const cd = failedUntil.get(k);
				if (cd !== undefined && t < cd) continue; // cooling down
				if (!wanted.includes(k)) wanted.push(k);
			}
			queue.length = 0;
			if (head) queue.push(head);
			queue.push(...wanted);
			emit(); // the batch reset alone is a progress change
			pump();
		},
		signals() {
			const byId = new Map();
			for (const list of loaded.values()) for (const s of list) if (!byId.has(s.id)) byId.set(s.id, s);
			return [...byId.values()];
		},
		// Every fresh, current-version cached tile's signals — what the scanner
		// can show before (or instead of) asking Overpass again. Not restricted
		// to `loaded`: a tile cached by an earlier source (or an earlier batch)
		// still counts.
		async cachedSignals() {
			let all = [];
			try { all = await cache.entries(); } catch { /* a broken cache is a missing cache */ }
			const byId = new Map();
			for (const [, hit] of all) {
				if (!validCache(hit)) continue;
				for (const s of hit.signals) if (!byId.has(s.id)) byId.set(s.id, s);
			}
			return [...byId.values()];
		},
		// done = batch tiles already loaded; queued/in-flight fill in the rest of
		// `total`, so a tile that failed and dropped into cooldown quietly leaves
		// the total rather than stalling the bar.
		progress() {
			let done = 0, queued = 0, inFlight = 0;
			for (const k of batch) {
				if (loaded.has(k)) done++;
				else if (queue.includes(k)) queued++;
				else if (busy && k === current) inFlight++;
			}
			let retryAt = null;
			if (state === 'unavailable') {
				const t = now();
				for (const v of failedUntil.values()) if (v > t && (retryAt === null || v < retryAt)) retryAt = v;
			}
			return { done, total: done + queued + inFlight, current: busy ? current : null, retryAt };
		},
		// The tiles still waiting their turn (the scanner outlines them). A copy:
		// the caller cannot reorder the queue.
		queued: () => [...queue],
		status: () => state,
		idle: () => new Promise((r) => { idleWaiters.push(r); settle(); }),
		// Several consumers now: the scanner map and the flight. Each keeps the
		// unsubscribe it was given and calls it when it goes away.
		subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
	});
}

// One source per page: the scanner and the flight share its memory, its
// queue and its IndexedDB cache. Created on first use — Node imports this
// module in selftests and must not touch indexedDB or AbortSignal.timeout.
let shared = null;
export function sharedSignalSource() {
	return shared ??= createSignalSource({
		// A stuck Overpass request must not stay in flight forever: the timeout
		// aborts, which lands in the source's catch → UNAVAILABLE + cooldown.
		fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(40_000) }),
		cache: idbCache(),
	});
}

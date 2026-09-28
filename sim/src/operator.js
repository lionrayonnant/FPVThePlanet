// Operator state, client side. No DOM.
//
// The client's identity lives in localStorage (fpvtp.operatorId) and rides
// along with every request: that is what lets two people play at once on the
// same dev server. The server never decides "who you are".
// Fallback when the key is missing (a fresh or cleared browser): the caller
// always shows OPERATOR SELECT — even with a single operator on disk, so a
// new client (e.g. a friend on a shared ngrok tunnel) can create their own
// instead of inheriting yours.
//
// The operator KEY (fpvtp.operatorKey, issue #60) is a different thing: a
// 128-bit secret handed out once at creation, sent as `Authorization: Bearer`
// on every request. A `local` server never looks at it; a `shared` one
// requires it. It has NOTHING to do with the Control Vector (Bible §33): that
// one is an in-game ritual, this one a technical secret. It is NEVER shown at
// signup — the browser keeps it, full stop. On 401/403 both the id and the
// key are erased and the caller shows OPERATOR KEY.

const OP_BASE = '/__operator';
const KEY = 'fpvtp.operatorId';
const OP_KEY = 'fpvtp.operatorKey';
const DEBOUNCE_MS = 500;

let _fetch = (...a) => globalThis.fetch(...a);
let _store = safeStore();
export function _setFetch(fn) { _fetch = fn; }
export function _setStore(obj) { _store = obj; }

function safeStore() {
	try {
		const s = globalThis.localStorage;
		s.getItem(KEY); // throws in a locked-down private window
		return s;
	} catch {
		const m = new Map();
		return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
	}
}

let cache = null;
const pending = new Map();        // key -> value waiting to be written
let timer = null;

export function getKey() { return _store.getItem(OP_KEY); }
export function hasKey() { return Boolean(getKey()); }
export function setKey(key) {
	const k = String(key ?? '').trim();
	if (k) _store.setItem(OP_KEY, k); else _store.removeItem(OP_KEY);
}

// Erases the local identity. Neither the id nor the key survives a refusal
// from the server: keeping one without the other would replay the same 401 on
// every screen.
export function forgetOperator() {
	cache = null;
	_store.removeItem(KEY);
	_store.removeItem(OP_KEY);
}

export function authHeaders() {
	const k = getKey();
	return k ? { authorization: `Bearer ${k}` } : {};
}

async function req(method, path, body) {
	const headers = authHeaders();
	const res = await _fetch(OP_BASE + path, body === undefined ? { method, headers } : {
		method,
		headers: { ...headers, 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
	const payload = await res.json().catch(() => ({}));
	if (!res.ok) { const e = new Error(payload.error ?? `HTTP ${res.status}`); e.status = res.status; throw e; }
	return payload;
}

export function getOperator() { return cache; }

// Returns exactly one of four shapes: a loaded operator, needsBootstrap, a
// list of choices, or needsKey (the `shared` server does not know us — key
// missing, wrong, or an operator from before #60 that has none).
const NEEDS_KEY = { operator: null, needsBootstrap: false, choices: null, needsKey: true };

function refused(e) { return e.status === 401 || e.status === 403; }

export async function loadOperator() {
	const id = _store.getItem(KEY);
	if (id) {
		try {
			cache = (await req('GET', `/${id}`)).operator;
			return { operator: cache, needsBootstrap: false, choices: null, needsKey: false };
		} catch (e) {
			if (refused(e)) { forgetOperator(); return NEEDS_KEY; }
			if (e.status !== 404) throw e;
			_store.removeItem(KEY);
		}
	}
	let operators;
	try { operators = (await req('GET', '')).operators; }
	catch (e) {
		// 404 on the list: a `shared` server, which publishes none. 401 / 403:
		// the key we carry is worthless. Either way, the OPERATOR KEY screen —
		// enter a key, or start over with a new operator.
		if (refused(e) || e.status === 404) { forgetOperator(); return NEEDS_KEY; }
		throw e;
	}
	if (operators.length === 0) return { operator: null, needsBootstrap: true, choices: null, needsKey: false };
	return {
		operator: null, needsBootstrap: false, needsKey: false,
		choices: operators.map(({ id, name }) => ({ id, name })),
	};
}

export async function createOperator(name) {
	// Creation is the one route `shared` mode leaves open without a key:
	// without it, nobody could ever sign up on the VPS.
	const { operator, key } = await req('POST', '', { name });
	cache = operator;
	_store.setItem(KEY, cache.id);
	// SILENTLY. Nobody who came to fly is asked to write down a 128-bit
	// secret: the browser keeps it, and [ SHOW KEY ] (DATA → OPERATOR) gives it
	// back the day the profile has to move elsewhere.
	if (key) setKey(key);
	return cache;
}

// Getting one's operator back from another browser: set the key, then ask
// the server whom it designates. The key is what identifies — a `shared`
// server publishes no list to choose from.
export async function resumeWithKey(key) {
	const previous = getKey();
	setKey(key);
	try {
		const { operator } = await req('GET', '/whoami');
		cache = operator;
		_store.setItem(KEY, cache.id);
		return cache;
	} catch (e) {
		setKey(previous ?? '');
		throw e;
	}
}

export async function selectOperator(id) {
	cache = (await req('GET', `/${id}`)).operator;
	_store.setItem(KEY, cache.id);
	return cache;
}

export function patch(key, value) {
	if (!cache) throw new Error('no operator loaded');
	cache[key] = value;
	pending.set(key, value);
	if (!timer) timer = setTimeout(flush, DEBOUNCE_MS);
}

export async function listOperators() {
	return (await req('GET', '')).operators;
}

// Attaches an already acquired terrain to the current operator (PHASE 05, KEEP
// TERRAIN). Unlike patch(), a direct server call rather than a debounce: the
// decision is one-off and its screen waits for the confirmation.
// Optional `extra`: { signalDensity: { level, range } } — a Global Scanner
// on-screen estimate the server cannot recompute (see the route).
export async function keepTerrain(slug, extra = {}) {
	if (!cache) throw new Error('no operator loaded');
	cache = (await req('POST', `/${cache.id}/terrain-cache`, { slug, ...extra })).operator;
	return cache;
}

// Sessions (PHASE 06). The full lifecycle lives in src/session.js; only the
// network calls are here, because this layer is the one that knows the
// current operator's id.
export async function postSession(body) {
	if (!cache) throw new Error('no operator loaded');
	return (await req('POST', `/${cache.id}/sessions`, body)).session;
}

export async function patchSession(sid, body) {
	if (!cache) throw new Error('no operator loaded');
	return (await req('PATCH', `/${cache.id}/sessions/${sid}`, body)).session;
}

// OPERATOR NOTE (PHASE 15): separate from patchSession — it also applies to a
// session already closed, which closeSessionRoute (PENDING only) would refuse.
export async function patchSessionComment(sid, comment) {
	if (!cache) throw new Error('no operator loaded');
	return (await req('PATCH', `/${cache.id}/sessions/${sid}/comment`, { comment })).session;
}

// The COMPLETE session, captures included (PHASE 17). Every other answer
// elides the `dataUrl`s: only VIEW SESSION pays for the images, and only when
// it opens.
export async function getSession(sid) {
	if (!cache) throw new Error('no operator loaded');
	return (await req('GET', `/${cache.id}/sessions/${sid}`)).session;
}

// DELETE SESSION (PHASE 17). The local cache is updated at once: the Home
// rebuilds behind the detail screen, and its footer must count right without
// another full GET.
export async function deleteSession(sid) {
	if (!cache) throw new Error('no operator loaded');
	const { removed } = await req('DELETE', `/${cache.id}/sessions/${sid}`);
	cache.sessions = (cache.sessions ?? []).filter((s) => s.id !== sid);
	return removed;
}

// One capture (PHASE 16). Written at once, not at session close: a tab that
// dies mid-flight must not lose the photos already taken.
export async function postPhoto(sid, body) {
	if (!cache) throw new Error('no operator loaded');
	return (await req('POST', `/${cache.id}/sessions/${sid}/photos`, body)).session;
}

// One session photo, as bytes (issue #185, task 7). Unlike req(), this route
// never answers JSON, and the bearer key still has to ride along — so it
// fetches directly rather than going through req(). The caller owns the
// returned object URL and must revoke it when done with it.
export async function fetchPhoto(sessionId, index) {
	if (!cache) throw new Error('no operator loaded');
	const res = await _fetch(`${OP_BASE}/${cache.id}/sessions/${encodeURIComponent(sessionId)}/photos/${encodeURIComponent(index)}`, {
		headers: authHeaders(),
	});
	if (!res.ok) return null;
	return URL.createObjectURL(await res.blob());
}

// The flight track (issue #24). One write, at close, AFTER the session's
// PATCH: it has its own route because it has its own file (D5), and
// OP_WRITABLE_KEYS does not know it.
export async function putTrack(sid, stored) {
	if (!cache) throw new Error('no operator loaded');
	return req('PUT', `/${cache.id}/sessions/${sid}/track`, stored);
}

// The track index for the enriched map: decimated polylines, starts, ends and
// geolocated photos, never the raw samples.
export async function listTracks(bbox = null) {
	if (!cache) throw new Error('no operator loaded');
	const q = bbox ? `?bbox=${[bbox.south, bbox.west, bbox.north, bbox.east].join(',')}` : '';
	return (await req('GET', `/${cache.id}/tracks${q}`)).tracks;
}

export function operatorBase() { return OP_BASE; }

// How many writes are still waiting for their PATCH. Diagnostic only
// (`__sim.endState()`, #20): an exit that hangs in flush() cannot say on its
// own whether it had anything to send.
export function pendingCount() { return pending.size; }

export async function flush() {
	if (timer) { clearTimeout(timer); timer = null; }
	if (!cache || pending.size === 0) return;
	const entries = [...pending.entries()];
	pending.clear();
	let successCount = 0;
	let lastError = null;
	for (const [key, value] of entries) {
		try { await req('PATCH', `/${cache.id}`, { key, value }); successCount++; }
		catch (e) {
			console.warn('[operator] patch failed, will retry', e);
			lastError = e;
			pending.set(key, value);
			// Re-arm the debounce: an unwatched failure must still retry.
			if (!timer) timer = setTimeout(flush, DEBOUNCE_MS);
		}
	}
	// Nothing was written: tell the caller rather than pretend it was saved.
	if (entries.length > 0 && successCount === 0) throw lastError;
}

export async function ensureDevOperator() {
	if (cache) return cache;
	const id = _store.getItem(KEY);
	if (id) {
		try { return await selectOperator(id); }
		catch (e) { if (e.status !== 404) throw e; _store.removeItem(KEY); }
	}
	const { operators } = await req('GET', '');
	return operators.length ? selectOperator(operators[0].id) : createOperator('dev');
}

// --- the key on EVERY request to the game's API ------------------------------
//
// One attachment point, deliberately: `/__map-api` is called from scanner.js,
// bootstrap.js, session-log.js and terminal.js, `/__operator/:id` from
// weather.js too. Repeating the header in each module invites the first
// omission — which would only show in `shared`, the one hosting where it
// matters. In `local` the server never reads the header: what follows changes
// nothing there.
const API_PREFIXES = [OP_BASE, '/__map-api'];

function isGameApi(url) {
	const u = String(url ?? '');
	const p = u.startsWith('/') ? u : (() => { try { return new URL(u, location.href).pathname; } catch { return ''; } })();
	return API_PREFIXES.some((pre) => p === pre || p.startsWith(pre + '/') || p.startsWith(pre + '?'));
}

function headerObject(h) {
	if (!h) return {};
	// Headers, Map, or an array of pairs: all iterable with forEach.
	if (typeof h.forEach === 'function') { const o = {}; h.forEach((v, k) => { o[Array.isArray(h) ? v[0] : k] = Array.isArray(h) ? v[1] : v; }); return o; }
	return { ...h };
}

export function installAuthFetch(target = globalThis) {
	const raw = target.fetch?.bind(target);
	if (!raw) return;
	target.fetch = (input, init) => {
		const url = typeof input === 'string' ? input : (input?.url ?? '');
		const key = getKey();
		if (!key || !isGameApi(url)) return raw(input, init);
		const headers = headerObject(init?.headers ?? (typeof input === 'object' ? input?.headers : null));
		if (!Object.keys(headers).some((k) => k.toLowerCase() === 'authorization')) {
			headers.authorization = `Bearer ${key}`;
		}
		return raw(input, { ...init, headers });
	};
}

if (typeof window !== 'undefined') {
	installAuthFetch();
	window.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
	window.addEventListener('beforeunload', () => { flush(); });
}

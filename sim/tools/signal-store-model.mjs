// The signals an operator has resolved (issue #185, spec §6), stored under the
// operator's `signals` key. Bounded here, on the client side — the server does
// not validate writable keys (server/api.mjs, OP_WRITABLE_KEYS). No image
// bytes: the frame lives in the session's photos, an entry only points at it.
//
// The whole value travels in one PATCH, and the server reads at most 1e6
// bytes of body (server/api.mjs readBody): MAX_RESOLVED is sized so a
// worst-case store (4-byte names at TEXT_MAX, a 4-byte place at its own cap)
// stays under 85 % of that (tools/signal-store-selftest.mjs measures it).
export const MAX_RESOLVED = 1200;
const TEXT_MAX = 60;
// family and sessionId are machine ids (a profile slug, a UUID): ASCII tokens.
const TOKEN_MAX = 40;
const TOKEN_RE = /^[A-Za-z0-9_.:-]+$/;
const ID_RE = /^wd:Q\d{1,12}$/;
// The place name (src/place-name.js), same 40-code-point cap as a token, but
// free text: a Nominatim answer can carry any script.
const PLACE_MAX = 40;

const cleanText = (v, max) => (typeof v === 'string'
	? Array.from(v.replace(/[\u0000-\u001f\u007f]/g, '')).slice(0, max).join('')
	: null);
const text = (v) => cleanText(v, TEXT_MAX);
const place = (v) => (typeof v === 'string' ? cleanText(v, PLACE_MAX) || null : null);
const token = (v) => (typeof v === 'string' && TOKEN_RE.test(v) ? v.slice(0, TOKEN_MAX) : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function entryOf(e) {
	if (!e || typeof e !== 'object') return null;
	const at = num(e.at), lat = num(e.lat), lon = num(e.lon), holdS = num(e.holdS), distM = num(e.distM);
	if (at === null || lat === null || lon === null || holdS === null || distM === null) return null;
	if (![1, 2, 3].includes(e.tier)) return null;
	const photo = e.photo === null || e.photo === undefined ? null : (Number.isInteger(e.photo) && e.photo >= 0 ? e.photo : null);
	return {
		at, name: text(e.name) ?? '', lat, lon, tier: e.tier,
		family: token(e.family), holdS, distM,
		sessionId: token(e.sessionId), photo,
		place: place(e.place),
	};
}

export function fromStored(value) {
	const out = { resolved: {} };
	const r = value && typeof value === 'object' && !Array.isArray(value) ? value.resolved : null;
	if (!r || typeof r !== 'object' || Array.isArray(r)) return out;
	for (const [id, e] of Object.entries(r)) {
		if (!ID_RE.test(id)) continue;
		const v = entryOf(e);
		if (v) out.resolved[id] = v;
	}
	return out;
}

export function withResolved(store, id, entry) {
	const base = fromStored(store);
	if (!ID_RE.test(id) || base.resolved[id]) return base;
	const e = entryOf(entry);
	if (!e) return base;
	base.resolved[id] = e;
	const ids = Object.keys(base.resolved);
	if (ids.length > MAX_RESOLVED) {
		ids.sort((a, b) => base.resolved[a].at - base.resolved[b].at);
		for (const old of ids.slice(0, ids.length - MAX_RESOLVED)) delete base.resolved[old];
	}
	return base;
}

// Sets the frame of an entry written before its photo landed (the resolution
// is written at once, the upload follows). Never overwrites a photo.
export function withPhoto(store, id, index) {
	const base = fromStored(store);
	const e = base.resolved[id];
	if (e && e.photo === null && Number.isInteger(index) && index >= 0) e.photo = index;
	return base;
}

// Sets the place name of an entry resolved before src/place-name.js answered
// (same timing as withPhoto: the resolution is written at once, the name
// follows). Never overwrites a place.
export function withPlace(store, id, name) {
	const base = fromStored(store);
	const e = base.resolved[id];
	if (e && e.place === null) {
		const p = place(name);
		if (p !== null) e.place = p;
	}
	return base;
}

// Called per flight refresh with the same operator value: the last parse is
// kept per stored object (operator.patch() replaces the object, never mutates it).
const _ids = new WeakMap();
export function resolvedIds(store) {
	const key = store && typeof store === 'object' ? store : null;
	if (key && _ids.has(key)) return _ids.get(key);
	const set = new Set(Object.keys(fromStored(store).resolved));
	if (key) _ids.set(key, set);
	return set;
}

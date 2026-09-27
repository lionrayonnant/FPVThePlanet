// The signals an operator has resolved (issue #185, spec §6), stored under the
// operator's `signals` key. Bounded here, on the client side — the server does
// not validate writable keys (server/api.mjs, OP_WRITABLE_KEYS). No image
// bytes: the frame lives in the session's photos, an entry only points at it.
export const MAX_RESOLVED = 5000;
const TEXT_MAX = 60;
const ID_RE = /^wd:Q\d+$/;

const text = (v) => (typeof v === 'string'
	? Array.from(v.replace(/[\u0000-\u001f\u007f]/g, '')).slice(0, TEXT_MAX).join('')
	: null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function entryOf(e) {
	if (!e || typeof e !== 'object') return null;
	const at = num(e.at), lat = num(e.lat), lon = num(e.lon), holdS = num(e.holdS), distM = num(e.distM);
	if (at === null || lat === null || lon === null || holdS === null || distM === null) return null;
	if (![1, 2, 3].includes(e.tier)) return null;
	const photo = e.photo === null || e.photo === undefined ? null : (Number.isInteger(e.photo) && e.photo >= 0 ? e.photo : null);
	return {
		at, name: text(e.name) ?? '', lat, lon, tier: e.tier,
		family: text(e.family), holdS, distM,
		sessionId: text(e.sessionId), photo,
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

export const resolvedIds = (store) => new Set(Object.keys(fromStored(store).resolved));

// The SIGNALS section of DATA, pure half (issue #185, lot 3 task 9): the
// operator's uplinked signals grouped by place, what is still out there
// around each place, the rows of a place, and the key/value rows and credit
// of one opened capture. No DOM — src/signals-data.js draws it.
import { fromStored } from './signal-store-model.mjs';
import { LEVELS } from './signal-clearance-model.mjs';
import { scramble } from './signal-callout-model.mjs';
import { distanceM } from './signal-model.mjs';
import { cardRows, MACHINE_NAMES } from './signal-card-model.mjs';

// Where an entry resolved before src/place-name.js answered (or never did) goes.
export const ELSEWHERE = 'ELSEWHERE';
// A known signal belongs to a place when its nearest resolution is that
// place's and lies within this distance.
export const KNOWN_RADIUS_M = 5000;
// Known rows shown under a place before a `…N MORE` line.
export const MAX_KNOWN_ROWS = 12;
// Always shown, photo or not: the facts come from these two.
export const DATA_CREDIT = 'DATA © OPENSTREETMAP · WIKIDATA';

const ROMAN = { 1: 'I', 2: 'II', 3: 'III' };
const COMMONS_FILE = 'https://commons.wikimedia.org/wiki/File:';

const pad2 = (v) => String(v).padStart(2, '0');
const ddmm = (d) => `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}`;
const distText = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);
const machineOf = (family) => (family ? MACHINE_NAMES[family] ?? family.toUpperCase() : null);
// Stable per landmark: the Wikidata number (ids are `wd:Q<digits>`).
const seedOf = (id) => (Number(/\d+/.exec(id ?? '')?.[0] ?? 0) >>> 0);

// The lowest clearance whose tiers include `tier`.
export function clearanceFor(tier) {
	const i = LEVELS.findIndex((l) => l.tiers.includes(tier));
	return i < 0 ? LEVELS.length - 1 : i;
}

export function sessionLabel(sessionId) {
	return typeof sessionId === 'string' && sessionId ? sessionId.toUpperCase().replace(/-/g, ' ') : null;
}

// `store`: the operator's `signals` value. `known`: the cached signals
// (src/signal-source.js cachedSignals()). Entries come back with their `id`.
export function buildSignals({ store, known = [] } = {}) {
	const { resolved } = fromStored(store);
	const entries = Object.entries(resolved).map(([id, e]) => ({ id, ...e }));
	if (!entries.length) return { uplinked: 0, knownCount: 0, places: [] };

	const byName = new Map();
	const placeOf = (e) => e.place ?? ELSEWHERE;
	for (const e of entries) {
		const name = placeOf(e);
		if (!byName.has(name)) byName.set(name, { name, uplinked: [], known: [], total: 0 });
		byName.get(name).uplinked.push(e);
	}

	let knownCount = 0;
	for (const s of Array.isArray(known) ? known : []) {
		if (!s || typeof s.id !== 'string' || resolved[s.id]) continue;
		if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
		let best = null, bestD = Infinity;
		// A degree of latitude is ~111 km: an entry further than the best so far
		// in latitude alone cannot be nearer.
		for (const e of entries) {
			if (Math.abs(e.lat - s.lat) * 111_000 > bestD) continue;
			const d = distanceM(e, s);
			if (d < bestD) { bestD = d; best = e; }
		}
		if (best && bestD <= KNOWN_RADIUS_M) {
			byName.get(placeOf(best)).known.push(s);
			knownCount++;
		}
	}

	const places = [...byName.values()];
	for (const p of places) {
		p.uplinked.sort((a, b) => b.at - a.at);
		p.total = p.uplinked.length + p.known.length;
	}
	places.sort((a, b) => b.uplinked.length - a.uplinked.length || a.name.localeCompare(b.name));
	return { uplinked: entries.length, knownCount, places };
}

// The rows of one place: uplinked (newest first), then what is still out
// there, nearest to the place's centroid first, scrambled; `locked` when the
// operator's clearance does not open the tier yet.
export function listRows(place, clearance = 0) {
	if (!place) return [];
	const rows = place.uplinked.map((e) => ({
		kind: 'uplinked',
		id: e.id,
		text: (e.name || e.id).toUpperCase(),
		right: [ddmm(new Date(e.at)), machineOf(e.family)].filter(Boolean).join('  '),
	}));
	if (!place.known.length) return rows;
	const n = place.uplinked.length;
	const c = n
		? { lat: place.uplinked.reduce((a, e) => a + e.lat, 0) / n, lon: place.uplinked.reduce((a, e) => a + e.lon, 0) / n }
		: null;
	const known = place.known
		.map((s) => ({ s, d: c ? distanceM(c, s) : 0 }))
		.sort((a, b) => a.d - b.d);
	for (const { s, d } of known.slice(0, MAX_KNOWN_ROWS)) {
		const need = clearanceFor(s.tier);
		const locked = need > clearance;
		rows.push({
			kind: locked ? 'locked' : 'known',
			id: s.id,
			text: scramble((s.name || s.id).toUpperCase(), seedOf(s.id)),
			right: locked ? `CLEARANCE ${need}` : `${distText(d)}  TIER ${ROMAN[s.tier] ?? '?'}`,
		});
	}
	if (known.length > MAX_KNOWN_ROWS) {
		rows.push({ kind: 'more', id: null, text: `…${known.length - MAX_KNOWN_ROWS} MORE`, right: '' });
	}
	return rows;
}

// The opened capture's key/value rows: the capture itself, a `null` spacer,
// then the landmark's facts (signal-card-model's rows, shared with the card).
// `signal` and `info` may be null (not cached, offline).
export function detailRows(entry, signal, info) {
	const d = new Date(entry.at);
	const rows = [['UPLINKED', `${ddmm(d)}.${pad2(d.getFullYear() % 100)} / ${pad2(d.getHours())}:${pad2(d.getMinutes())}`]];
	const machine = machineOf(entry.family);
	if (machine) rows.push(['MACHINE', machine]);
	rows.push(['HOLD', `${entry.holdS.toFixed(1)} s`]);
	rows.push(['RANGE', distText(entry.distM)]);
	const session = sessionLabel(entry.sessionId);
	if (session) rows.push(['SESSION', session]);
	const facts = cardRows(signal, info);
	return facts.length ? [...rows, null, ...facts] : rows;
}

// A link only to a Commons file page, parsed rather than prefix-matched alone.
function commonsPage(u) {
	if (typeof u !== 'string' || !u.startsWith(COMMONS_FILE) || u.length <= COMMONS_FILE.length) return null;
	try {
		const url = new URL(u);
		if (url.protocol !== 'https:' || url.host !== 'commons.wikimedia.org' || url.username || url.password) return null;
		return url.pathname.startsWith('/wiki/File:') ? u : null;
	} catch {
		return null;
	}
}

// The reference photo's credit; null when there is no photo. DATA_CREDIT is
// shown separately, always.
export function creditOf(info) {
	const photo = info?.photo;
	if (!photo) return null;
	const artist = (photo.artist || 'UNKNOWN').toUpperCase();
	const license = (photo.license || 'UNKNOWN').toUpperCase();
	return { text: `© ${artist} · ${license} · WIKIMEDIA COMMONS`, href: commonsPage(photo.page) };
}

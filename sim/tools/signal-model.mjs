// Signals (issue #185, spec 2026-09-27-signals-design.md): OSM landmarks the
// operator captures in flight. This module is pure and Node-safe — no DOM, no
// fetch — so everything that can be decided without a browser is checked in
// tools/signal-model-selftest.mjs.
//
// Not to be confused with signalDensity() in scanner-model.mjs: that is the
// drone RF density of an area.

// ---------------------------------------------------------------- tile grid
// One Overpass query per z12 tile, ever (until the cache expires). z12 is
// ~6.4 km at Paris: a city is a handful of tiles, and a query stays small.
export const TILE_Z = 12;
// Below this map zoom the scanner does not scan at all: the view is a region,
// not a place you would fly.
export const MIN_QUERY_ZOOM = 10;
// Tiles asked per view, nearest the centre first. A wide view is not refused
// (the operator had to zoom to 14-15 on a large screen before anything came);
// it scans its centre, and panning scans the rest. The queue keeps only the
// latest view, so this bounds Overpass load, not what the operator can reach.
export const MAX_TILES_PER_VIEW = 16;
// Bump whenever parsing, ranking, tiers or fields change: cached tiles are
// parsed signals, not raw Overpass answers, so a stale cache entry must miss.
export const MODEL_VERSION = 1;

const N = 2 ** TILE_Z;
const D = Math.PI / 180;

export function tileOf(lat, lon) {
	const x = Math.floor(((lon + 180) / 360) * N);
	const φ = Math.max(-85.0511, Math.min(85.0511, lat)) * D;
	const y = Math.floor(((1 - Math.log(Math.tan(φ) + 1 / Math.cos(φ)) / Math.PI) / 2) * N);
	return { x: ((x % N) + N) % N, y: Math.max(0, Math.min(N - 1, y)) };
}

export const tileKey = ({ x, y }) => `z${TILE_Z}/${x}/${y}`;

const latOfY = (y) => Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / N))) / D;

export function tileBounds({ x, y }) {
	return {
		s: latOfY(y + 1), n: latOfY(y),
		w: (x / N) * 360 - 180, e: ((x + 1) / N) * 360 - 180,
	};
}

const R_EARTH = 6371008.8;

export function distanceM(a, b) {
	const dLat = (b.lat - a.lat) * D, dLon = (b.lon - a.lon) * D;
	const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * D) * Math.cos(b.lat * D) * Math.sin(dLon / 2) ** 2;
	return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
}

// The tiles a flight needs: every z12 tile that comes within `radiusM` of the
// take-off point, its own tile first, then by distance. The flight asks for
// these once at spawn (spec §1: only the zone's signals are live in flight).
export function tilesAround(lat, lon, radiusM) {
	const c = tileOf(lat, lon);
	const own = tileKey(c);
	const out = [{ key: own, d: 0 }];
	const R = 3; // z12 tiles are >= ~4 km wide below 60° N: 3 rings cover any radius we use
	for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
		if (!dx && !dy) continue;
		const x = (((c.x + dx) % N) + N) % N, y = c.y + dy;
		if (y < 0 || y >= N) continue;
		const b = tileBounds({ x, y });
		// Shift the tile's longitude span to the copy nearest `lon` before
		// clamping: a bare clamp at the date line picks the far side of the
		// world (~40 000 km away instead of a few hundred metres).
		let w = b.w, e = b.e;
		if (w - lon > 180) { w -= 360; e -= 360; }
		else if (lon - e > 180) { w += 360; e += 360; }
		const near = { lat: Math.max(b.s, Math.min(b.n, lat)), lon: Math.max(w, Math.min(e, lon)) };
		const d = distanceM({ lat, lon }, near);
		if (d <= radiusM) out.push({ key: tileKey({ x, y }), d });
	}
	return out.sort((p, q) => p.d - q.d || (p.key < q.key ? -1 : 1)).map((t) => t.key);
}

export function tilesForView({ s, w, n, e }, zoom) {
	if (!(zoom >= MIN_QUERY_ZOOM)) return null;
	const a = tileOf(n, w), b = tileOf(s, e);
	// Across the antimeridian the east edge wraps below the west one.
	const inX = b.x >= a.x ? (x) => x >= a.x && x <= b.x : (x) => x >= a.x || x <= b.x;
	const c = tileOf((s + n) / 2, e >= w ? (w + e) / 2 : ((w + e + 360) / 2 + 180) % 360 - 180);
	// Rings around the centre tile, far enough to hold MAX_TILES_PER_VIEW.
	const R = Math.ceil(Math.sqrt(MAX_TILES_PER_VIEW) / 2) + 1;
	const cand = [];
	for (let dy = -R; dy <= R; dy++) {
		const y = c.y + dy;
		if (y < a.y || y > b.y) continue;
		for (let dx = -R; dx <= R; dx++) {
			const x = (((c.x + dx) % N) + N) % N;
			if (!inX(x)) continue;
			cand.push({ key: tileKey({ x, y }), d: dx * dx + dy * dy });
		}
	}
	cand.sort((p, q) => p.d - q.d || (p.key < q.key ? -1 : p.key > q.key ? 1 : 0));
	return cand.slice(0, MAX_TILES_PER_VIEW).map((t) => t.key);
}

// ---------------------------------------------------------------- query
// `wikidata` on every clause is the notability filter (spec §1): it keeps the
// cathedral and drops the bench. `out tags center` gives nodes their position
// and ways/relations a centre, with no geometry to download.
// Safety net, not a filter: at 200 the Paris tile was truncated (Notre-Dame
// and the Louvre never received). Paris returns ~400 elements (~240 kB).
const OUT_CAP = 2000;
const MAXSIZE = 4 * 1024 * 1024;

export function overpassQuery({ s, w, n, e }) {
	const bb = `(${s},${w},${n},${e})`;
	return `[out:json][timeout:25][maxsize:${MAXSIZE}];(`
		+ `nwr["wikidata"]["historic"]${bb};`
		+ `nwr["wikidata"]["tourism"~"^(attraction|viewpoint)$"]${bb};`
		+ `nwr["wikidata"]["man_made"~"^(tower|lighthouse|dam)$"]${bb};`
		+ `nwr["wikidata"]["building"~"^(cathedral|church|castle)$"]${bb};`
		+ `nwr["wikidata"]["natural"="peak"]${bb};`
		+ `nwr["wikidata"]["man_made"="bridge"]${bb};`
		+ `);out tags center ${OUT_CAP};`;
}

// ---------------------------------------------------------------- signals
const TEXT_MAX = 60;

// OSM text goes to the HUD and the map. Stripped of control characters and
// capped here; it is ALWAYS rendered as text (textContent / fillText), which
// is what makes markup in a tag inert.
function clean(v) {
	if (typeof v !== 'string') return null;
	const s = v.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
	return s ? Array.from(s).slice(0, TEXT_MAX).join('').toUpperCase() : null;
}

export function parseHeightM(raw) {
	if (typeof raw !== 'string') return null;
	const m = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(m|ft|')?$/i);
	if (!m) return null;
	const v = Number(m[1]) * (m[2] && m[2].toLowerCase() !== 'm' ? 0.3048 : 1);
	return v > 0 ? v : null;
}

// The TYPE line, in precedence order: the most specific tag wins.
function kindOf(tags) {
	if (tags.natural === 'peak') return 'PEAK';
	if (tags.man_made === 'dam') return 'DAM';
	if (tags.man_made === 'bridge') return 'BRIDGE';
	if (tags.man_made === 'lighthouse') return 'LIGHTHOUSE';
	if (tags.man_made === 'tower') return 'TOWER';
	if (tags.building && tags.building !== 'yes') return clean(tags.building.replace(/_/g, ' '));
	if (tags.historic && tags.historic !== 'yes') return clean(tags.historic.replace(/_/g, ' '));
	if (tags.tourism) return clean(tags.tourism.replace(/_/g, ' '));
	return 'LANDMARK';
}

// Spec §2: I get close, II climb and hold at altitude, III go far.
function tierOf(tags, heightM) {
	if (tags.natural === 'peak' || tags.man_made === 'dam' || tags.man_made === 'bridge') return 3;
	if (tags.man_made === 'tower' || tags.man_made === 'lighthouse' || (heightM !== null && heightM > 50)) return 2;
	return 1;
}

function statusOf(tags) {
	if (!tags.heritage) return null;
	return tags['heritage:operator'] === 'whc' ? 'UNESCO WORLD HERITAGE' : 'PROTECTED';
}

function commonsOf(tags) {
	const wc = typeof tags.wikimedia_commons === 'string' ? tags.wikimedia_commons.trim() : '';
	if (/^File:.+/.test(wc)) return wc;
	const img = typeof tags.image === 'string' ? tags.image.trim() : '';
	const m = img.match(/^https:\/\/commons\.wikimedia\.org\/wiki\/(File:.+)$/);
	if (m) {
		try { return decodeURIComponent(m[1]).replace(/_/g, ' '); }
		catch { return null; }
	}
	return null;
}

// Fields are an ordered list, not an object: the callout shows them in this
// order, and a later source (Wikidata) adds rows with its own `source` without
// changing anything here (spec §6).
const field = (key, label, value) => (value ? { key, label, value, source: 'osm' } : null);

const TYPES = new Set(['node', 'way', 'relation']);

export function signalFromElement(el) {
	if (!el || typeof el !== 'object' || !TYPES.has(el.type) || !Number.isFinite(el.id)) return null;
	const tags = el.tags && typeof el.tags === 'object' ? el.tags : null;
	if (!tags || typeof tags.wikidata !== 'string' || !tags.wikidata) return null;
	const name = clean(tags['name:en']) ?? clean(tags.name);
	if (!name) return null;
	const lat = Number(el.lat ?? el.center?.lat), lon = Number(el.lon ?? el.center?.lon);
	if (el.lat === undefined && el.center === undefined) return null;
	if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
	const heightM = parseHeightM(tags.height);
	const kind = kindOf(tags);
	const builtRaw = typeof tags.start_date === 'string' ? tags.start_date : null;
	const fields = [
		field('name', 'NAME', name),
		field('type', 'TYPE', kind),
		field('built', 'BUILT', clean(builtRaw)),
		field('height', 'HEIGHT', heightM !== null ? `${Math.round(heightM)} M` : null),
		field('architect', 'ARCHITECT', clean(tags.architect)),
		field('status', 'STATUS', statusOf(tags)),
	].filter(Boolean);
	const wikidata = tags.wikidata.trim();
	if (!/^Q\d+$/.test(wikidata)) return null;
	const tier = tierOf(tags, heightM);
	return {
		id: `wd:${wikidata}`,
		osm: `${el.type}/${el.id}`,
		lat, lon,
		tile: tileKey(tileOf(lat, lon)),
		tier,
		rank: rankOf(el, tags, heightM),
		name, kind, fields,
		wikipedia: typeof tags.wikipedia === 'string' && tags.wikipedia.length > 0,
		heightM,
		commons: commonsOf(tags),
	};
}

// ---------------------------------------------------------------- density
// Paris must not become hundreds of dots (spec §1). Measured on the real Reims
// tile (86 elements, 2026-09-27): nearly everything is tier I, so the tier
// alone ranks nothing. Worse, on the real Paris tile the tier promoted every
// metro/RER viaduct — every way that merely crosses a bridge carries the
// `bridge` tag — above every monument. The tier is difficulty, not notability:
// it must not enter the rank. What separates the cathedral from a plaque is
// the kind of place, its heritage level, a Wikipedia article,
// tourism=attraction, whether OSM draws it as a building (way/relation) or a
// point (node), and height.
export const PER_TILE_CAP = 12;

const MAJOR = new Set(['cathedral', 'castle', 'palace', 'fort', 'tower', 'lighthouse', 'monastery', 'basilica', 'dam']);
const MINOR = new Set(['church', 'chapel', 'city_gate', 'museum', 'ruins', 'abbey', 'bridge', 'peak']);

export function rankOf(el, tags, heightM) {
	const kinds = [tags.building, tags.historic, tags.man_made, tags.natural, tags.tourism, tags.man_made === 'bridge' ? 'bridge' : null];
	const kind = kinds.some((k) => MAJOR.has(k)) ? 300 : kinds.some((k) => MINOR.has(k)) ? 150 : 0;
	const h = tags['heritage:operator'] === 'whc' || tags.heritage === '1' ? 200
		: tags.heritage === '2' ? 100 : tags.heritage ? 50 : 0;
	return kind + h
		+ (typeof tags.wikipedia === 'string' && tags.wikipedia ? 100 : 0)
		+ (tags.tourism === 'attraction' ? 80 : 0)
		+ (el.type === 'node' ? 0 : 100)
		+ Math.min(heightM ?? 0, 300) / 3;
}

const byRank = (a, b) => b.rank - a.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function capPerTile(signals, cap = PER_TILE_CAP) {
	const byTile = new Map();
	for (const s of signals) {
		if (!byTile.has(s.tile)) byTile.set(s.tile, []);
		byTile.get(s.tile).push(s);
	}
	const out = [];
	for (const list of byTile.values()) out.push(...list.sort(byRank).slice(0, cap));
	return out;
}

// One landmark is often several OSM elements (Reims cathedral: a node AND the
// building way). They share a Wikidata id, which is the signal's identity; the
// best-ranked element carries it.
export function parseOverpass(json) {
	const els = Array.isArray(json?.elements) ? json.elements : [];
	const best = new Map();
	for (const el of els) {
		let s;
		try { s = signalFromElement(el); } catch { continue; } // one bad element is dropped, never the tile
		if (!s) continue;
		const cur = best.get(s.id);
		if (!cur || byRank(s, cur) < 0) best.set(s.id, s);
	}
	return capPerTile([...best.values()]);
}

// ---------------------------------------------------------------- map
// Names are drawn only from this zoom on: below it they overlap into noise.
export const LABEL_ZOOM = 15;

export function signalsInView(signals, { minLat, maxLat, minLon, maxLon }) {
	const wraps = minLon > maxLon;
	return signals.filter((s) => s.lat >= minLat && s.lat <= maxLat
		&& (wraps ? (s.lon >= minLon || s.lon <= maxLon) : (s.lon >= minLon && s.lon <= maxLon)));
}

// One point per screen cell of `cellPx`, the best-ranked kept: at low zoom a
// city's signals would otherwise pile into one blinding blob. Points are
// { s: Signal, x, y } in screen pixels; ties go to the smaller id.
export function declutter(points, cellPx) {
	const best = new Map();
	for (const p of points) {
		const k = `${Math.floor(p.x / cellPx)},${Math.floor(p.y / cellPx)}`;
		const cur = best.get(k);
		if (!cur || p.s.rank > cur.s.rank || (p.s.rank === cur.s.rank && p.s.id < cur.s.id)) best.set(k, p);
	}
	return [...best.values()];
}

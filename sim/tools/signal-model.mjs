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
// Below this map zoom the view spans too many tiles to be worth querying.
export const MIN_QUERY_ZOOM = 11;
// Hard cap per view: past it, nothing is queried and the scanner says ZOOM IN.
export const MAX_TILES_PER_VIEW = 12;

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

export function tilesForView({ s, w, n, e }, zoom) {
	if (!(zoom >= MIN_QUERY_ZOOM)) return null;
	const a = tileOf(n, w), b = tileOf(s, e);
	// Across the antimeridian the east edge wraps below the west one.
	const xs = [];
	if (b.x >= a.x) for (let x = a.x; x <= b.x; x++) xs.push(x);
	else { for (let x = a.x; x < N; x++) xs.push(x); for (let x = 0; x <= b.x; x++) xs.push(x); }
	const count = xs.length * (b.y - a.y + 1);
	if (count > MAX_TILES_PER_VIEW) return null;
	const keys = [];
	for (const x of xs) for (let y = a.y; y <= b.y; y++) keys.push(tileKey({ x, y }));
	return [...new Set(keys)].sort();
}

// ---------------------------------------------------------------- query
// `wikidata` on every clause is the notability filter (spec §1): it keeps the
// cathedral and drops the bench. `out tags center` gives nodes their position
// and ways/relations a centre, with no geometry to download.
const OUT_CAP = 200;
const MAXSIZE = 4 * 1024 * 1024;

export function overpassQuery({ s, w, n, e }) {
	const bb = `(${s},${w},${n},${e})`;
	return `[out:json][timeout:25][maxsize:${MAXSIZE}];(`
		+ `nwr["wikidata"]["historic"]${bb};`
		+ `nwr["wikidata"]["tourism"~"^(attraction|viewpoint)$"]${bb};`
		+ `nwr["wikidata"]["man_made"~"^(tower|lighthouse|dam)$"]${bb};`
		+ `nwr["wikidata"]["building"~"^(cathedral|church|castle)$"]${bb};`
		+ `nwr["wikidata"]["natural"="peak"]${bb};`
		+ `way["wikidata"]["bridge"]["name"]${bb};`
		+ `);out tags center ${OUT_CAP};`;
}

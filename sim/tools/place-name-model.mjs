// Pure helpers for a place name from Nominatim reverse geocoding (issue
// #185): the URL to ask and how to read the answer. No fetch, no cache, no
// timers — src/place-name.js owns those, following src/signal-source.js's
// pattern; checked in tools/place-name-selftest.mjs.

// z10 (~150 km at the equator): a place name is stable across a tile this
// size, so every signal in an area shares one request and one cache entry.
export const TILE_Z = 10;
const NAME_MAX = 40;

export function reverseUrl(lat, lon) {
	const p = new URLSearchParams({
		format: 'jsonv2', zoom: String(TILE_Z), lat: String(lat), lon: String(lon),
		'accept-language': 'en',
	});
	return `https://nominatim.openstreetmap.org/reverse?${p}`;
}

const clean = (v) => (typeof v === 'string'
	? (Array.from(v.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim()).slice(0, NAME_MAX).join('') || null)
	: null);

// city > town > village covers built-up places; municipality catches the
// administrative names some countries use instead; county/state is the
// fallback for a natural area (a mountain, a stretch of coast) that carries
// no settlement name at all.
export function placeNameOf(json) {
	const a = json?.address;
	if (!a || typeof a !== 'object') return null;
	const raw = a.city ?? a.town ?? a.village ?? a.municipality ?? a.county ?? a.state ?? null;
	const name = clean(raw);
	return name ? name.toUpperCase() : null;
}

const N = 2 ** TILE_Z;
const D = Math.PI / 180;

// Same slippy-tile grid as tools/signal-model.mjs's tileOf/tileKey, at this
// module's own (coarser) zoom.
export function placeKey(lat, lon) {
	if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
	const x = Math.floor(((lon + 180) / 360) * N);
	const φ = Math.max(-85.0511, Math.min(85.0511, lat)) * D;
	const y = Math.floor(((1 - Math.log(Math.tan(φ) + 1 / Math.cos(φ)) / Math.PI) / 2) * N);
	return `z${TILE_Z}/${((x % N) + N) % N}/${Math.max(0, Math.min(N - 1, y))}`;
}

// The flight track: what a session actually did, not just its maxima
// (issue #24, spec 2026-09-08-flight-track-enriched-map-data-design.md §1).
//
// Pure and Node-importable: no DOM, no THREE, no Rapier, no node:crypto — it is
// imported by src/session.js in the browser AND by server/api.mjs, and covered
// by tools/track-selftest.mjs in selftest:ci.
//
// The wire form is parallel arrays of integers, not an array of objects: a
// 5 min flight is 1500 samples, ~15 kB of JSON that way and three times that as
// objects. t/lat/lon/alt are delta-encoded against the previous SAMPLE (not the
// previous real value), so decoding is a running sum and quantization error
// never accumulates.

export const TRACK_VERSION = 1;

// One hour armed at 5 Hz. A hard cap rather than unbounded growth; a longer
// flight is truncated and says so, it is never refused.
export const MAX_SAMPLES = 18000;

// D3: 200 tracks retained per operator, ~15 kB each → ~3 MB ceiling. Beyond
// that the oldest tracks go; the sessions and their aggregates survive.
export const TRACK_KEEP = 200;

// Quantization: the factor each field is multiplied by before rounding.
// 1e5 on a degree is ≈ 1 m, the resolution the map actually draws at.
export const QUANT = { t: 10, lat: 1e5, lon: 1e5, alt: 10, spd: 10, thr: 100, rate: 1 };

// Fields carried as deltas against the previous sample. The others are small
// enough absolute that a delta would not pay for itself.
const DELTA_FIELDS = ['t', 'lat', 'lon', 'alt'];
const FIELDS = ['t', 'lat', 'lon', 'alt', 'spd', 'thr', 'rate'];

// The verdicts a flight can end on. Duplicated from session-model rather than
// imported: that module pulls node:crypto, which has no business in the browser
// half of this one. STORED_RESULTS there, LANDED included — a track written
// before the landing verdict disappeared (D9) must still validate.
const END_RESULTS = new Set(['CRASHED', 'LANDED']);

const q = (v, k) => Math.round(v * QUANT[k]);

function finite(v) { return typeof v === 'number' && Number.isFinite(v); }

// --- encode / decode -------------------------------------------------------

// `samples`: [{ t, lat, lon, alt, spd, thr, rate }] in real units, in order.
// `events`: { start, end, photos } — see the spec table. Everything malformed
// is dropped rather than throwing: a bad event must never cost the samples, and
// a degenerate position (drone under the terrain during a fall, #182) must
// never become a NaN on the wire.
//
// `truncated` lets a caller that already capped its own buffer say so: the
// recorder in src/session.js stops pushing at MAX_SAMPLES rather than growing a
// tab's memory without bound, so encodeTrack alone cannot see the overflow.
export function encodeTrack(samples, events = {}, { truncated = false } = {}) {
	const src = Array.isArray(samples) ? samples : [];
	const cols = {};
	for (const k of FIELDS) cols[k] = [];
	const prev = {};
	let n = 0;
	for (const s of src) {
		if (n >= MAX_SAMPLES) break;
		if (!s || typeof s !== 'object') continue;
		if (!FIELDS.every((k) => finite(s[k]))) continue;
		for (const k of FIELDS) {
			const v = q(s[k], k);
			cols[k].push(DELTA_FIELDS.includes(k) && n > 0 ? v - prev[k] : v);
			prev[k] = v;
		}
		n++;
	}
	return {
		v: TRACK_VERSION,
		n,
		// Counted on the input, not on what survived: a track cut at the cap is
		// truncated, one that merely dropped a NaN is not.
		truncated: Boolean(truncated) || src.length > MAX_SAMPLES,
		...cols,
		start: encodeStart(events.start),
		end: encodeEnd(events.end),
		photos: encodePhotos(events.photos),
	};
}

export function decodeTrack(stored) {
	const st = validateTrack(stored);
	const samples = [];
	const run = {};
	for (let i = 0; i < st.n; i++) {
		const s = {};
		for (const k of FIELDS) {
			const raw = st[k][i];
			run[k] = DELTA_FIELDS.includes(k) && i > 0 ? run[k] + raw : raw;
			s[k] = run[k] / QUANT[k];
		}
		samples.push(s);
	}
	return {
		v: st.v,
		truncated: st.truncated,
		samples,
		start: st.start ? { lat: st.start.lat / QUANT.lat, lon: st.start.lon / QUANT.lon } : null,
		end: st.end ? {
			lat: st.end.lat / QUANT.lat, lon: st.end.lon / QUANT.lon,
			alt: st.end.alt / QUANT.alt, spd: st.end.spd / QUANT.spd,
			result: st.end.result,
		} : null,
		photos: st.photos.map((p) => ({
			i: p.i, lat: p.lat / QUANT.lat, lon: p.lon / QUANT.lon, heading: p.heading,
		})),
	};
}

function encodeStart(e) {
	if (!e || !finite(e.lat) || !finite(e.lon)) return null;
	return { lat: q(e.lat, 'lat'), lon: q(e.lon, 'lon') };
}

function encodeEnd(e) {
	if (!e || !finite(e.lat) || !finite(e.lon) || !finite(e.alt) || !finite(e.spd)) return null;
	if (!END_RESULTS.has(e.result)) return null;
	return {
		lat: q(e.lat, 'lat'), lon: q(e.lon, 'lon'),
		alt: q(e.alt, 'alt'), spd: q(e.spd, 'spd'),
		result: e.result,
	};
}

function encodePhotos(list) {
	if (!Array.isArray(list)) return [];
	return list.filter((p) => p && Number.isInteger(p.i) && p.i >= 0
		&& finite(p.lat) && finite(p.lon) && finite(p.heading))
		.map((p) => ({
			i: p.i, lat: q(p.lat, 'lat'), lon: q(p.lon, 'lon'),
			// Degrees, normalized: the map only ever draws a direction.
			heading: ((Math.round(p.heading) % 360) + 360) % 360,
		}));
}

// --- validate --------------------------------------------------------------

// Throws on anything that is not exactly the stored shape, the way
// validateSession does. Called by decodeTrack, so a corrupt file on disk fails
// loudly at the route rather than silently drawing garbage on the map.
export function validateTrack(stored) {
	const st = stored;
	if (!st || typeof st !== 'object' || Array.isArray(st)) throw new Error('track: not an object');
	if (st.v !== TRACK_VERSION) throw new Error(`track: unknown version ${st.v}`);
	if (typeof st.truncated !== 'boolean') throw new Error('track.truncated: not a boolean');
	if (!Number.isInteger(st.n) || st.n < 0) throw new Error('track.n: not a sample count');
	if (st.n > MAX_SAMPLES) throw new Error(`track.n: ${st.n} over MAX_SAMPLES`);
	for (const k of FIELDS) {
		const col = st[k];
		if (!Array.isArray(col)) throw new Error(`track.${k}: not an array`);
		if (col.length !== st.n) throw new Error(`track.${k}: array length ${col.length}, expected n = ${st.n}`);
		if (!col.every(Number.isInteger)) throw new Error(`track.${k}: non-integer value`);
	}
	if (st.start !== null && !(st.start && Number.isInteger(st.start.lat) && Number.isInteger(st.start.lon))) {
		throw new Error('track.start: not a point');
	}
	if (st.end !== null && !(st.end
		&& Number.isInteger(st.end.lat) && Number.isInteger(st.end.lon)
		&& Number.isInteger(st.end.alt) && Number.isInteger(st.end.spd)
		&& END_RESULTS.has(st.end.result))) {
		throw new Error('track.end: not an end event');
	}
	if (!Array.isArray(st.photos)) throw new Error('track.photos: not an array');
	for (const p of st.photos) {
		if (!p || !Number.isInteger(p.i) || p.i < 0
			|| !Number.isInteger(p.lat) || !Number.isInteger(p.lon)
			|| !Number.isInteger(p.heading)) {
			throw new Error('track.photos: malformed photo point');
		}
	}
	return st;
}

// --- retention -------------------------------------------------------------

// D3. `list` is [{ id, ts, ... }] — whatever the caller carries, as long as it
// has a comparable `ts`. Returns both halves, newest first, without mutating
// the input: the server deletes `dropped` and leaves `kept` alone.
export function pruneTracks(list, keep = TRACK_KEEP) {
	const sorted = [...(Array.isArray(list) ? list : [])]
		.sort((a, b) => (b?.ts ?? 0) - (a?.ts ?? 0));
	return { kept: sorted.slice(0, Math.max(0, keep)), dropped: sorted.slice(Math.max(0, keep)) };
}

// --- the map index ---------------------------------------------------------

// Douglas-Peucker down to `maxPoints`. DP takes a tolerance, not a count, so
// the tolerance is bisected: the coarsest line that still fits the budget. The
// ends are always kept, and a straight flight collapses to its two ends.
//
// `points` are [lat, lon] pairs. Longitude is scaled by cos(lat) so the
// tolerance means the same thing on both axes away from the equator.
export function decimate(points, maxPoints = 100) {
	const pts = Array.isArray(points) ? points : [];
	if (pts.length <= Math.max(2, maxPoints)) return pts.slice();
	const kx = Math.cos(pts[0][0] * Math.PI / 180) || 1;
	const span = Math.max(
		Math.abs(pts[pts.length - 1][0] - pts[0][0]),
		Math.abs(pts[pts.length - 1][1] - pts[0][1]) * kx,
		1e-9,
	);
	let lo = 0, hi = span, best = null;
	for (let it = 0; it < 24; it++) {
		const mid = (lo + hi) / 2;
		const out = douglasPeucker(pts, mid, kx);
		if (out.length <= maxPoints) { best = out; hi = mid; } else lo = mid;
	}
	return best ?? [pts[0], pts[pts.length - 1]];
}

function douglasPeucker(pts, eps, kx) {
	// Explicit stack: 18000 points can nest deeper than the JS call stack likes.
	const keep = new Uint8Array(pts.length);
	keep[0] = keep[pts.length - 1] = 1;
	const stack = [[0, pts.length - 1]];
	while (stack.length) {
		const [a, b] = stack.pop();
		if (b <= a + 1) continue;
		let far = -1, best = eps;
		for (let i = a + 1; i < b; i++) {
			const d = segDist(pts[i], pts[a], pts[b], kx);
			if (d > best) { best = d; far = i; }
		}
		if (far < 0) continue;
		keep[far] = 1;
		stack.push([a, far], [far, b]);
	}
	const out = [];
	for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
	return out;
}

function segDist(p, a, b, kx) {
	const px = (p[1] - a[1]) * kx, py = p[0] - a[0];
	const bx = (b[1] - a[1]) * kx, by = b[0] - a[0];
	const len2 = bx * bx + by * by;
	if (len2 === 0) return Math.hypot(px, py);
	const t = Math.max(0, Math.min(1, (px * bx + py * by) / len2));
	return Math.hypot(px - t * bx, py - t * by);
}

// What GET /:operatorId/tracks ships: a decimated polyline plus the three point
// events. NEVER the raw sample arrays — that is the whole point of the index.
export function trackIndexEntry(stored, { sessionId, maxPoints = 100 } = {}) {
	const d = decodeTrack(stored);
	return {
		sessionId: sessionId ?? null,
		n: stored.n,
		truncated: d.truncated,
		line: decimate(d.samples.map((s) => [s.lat, s.lon]), maxPoints),
		start: d.start,
		end: d.end,
		photos: d.photos,
	};
}

// The bounding box of a track, for the ?bbox= filter. Null when the track has
// no geometry at all.
export function trackBounds(entry) {
	const pts = [...(entry.line ?? [])];
	if (entry.start) pts.push([entry.start.lat, entry.start.lon]);
	if (entry.end) pts.push([entry.end.lat, entry.end.lon]);
	for (const p of entry.photos ?? []) pts.push([p.lat, p.lon]);
	if (!pts.length) return null;
	let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
	for (const [lat, lon] of pts) {
		if (lat < minLat) minLat = lat;
		if (lat > maxLat) maxLat = lat;
		if (lon < minLon) minLon = lon;
		if (lon > maxLon) maxLon = lon;
	}
	return { minLat, maxLat, minLon, maxLon };
}

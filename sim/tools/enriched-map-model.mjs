// The enriched map, geometry half (issue #25, spec
// 2026-09-08-flight-track-enriched-map-data-design.md §2).
//
// Pure and Node-importable: no DOM, no Leaflet. Everything that decides WHAT
// goes on the map — which tracks the current view still needs, which loss
// crosses have collapsed into one another, how big a photo mark is at a given
// zoom — lives here and is covered by tools/enriched-map-selftest.mjs in
// selftest:ci. src/map-tracks.js is then only a canvas and a layer lifecycle,
// the same split as coverage.js / map-coverage.js.

import { trackBounds } from './track-model.mjs';

// Two loss crosses closer than this on screen are one mark carrying a count.
// The map declusters as you zoom in, never before: a heavily flown area must
// stay readable at world zoom (spec §2, "Losses").
export const CLUSTER_PX = 20;

// Below this zoom a photo is a small square; at and above it, a thumbnail.
export const THUMB_ZOOM = 16;

// Mark sizes, in CSS pixels. The square is deliberately small — a photo is a
// trace left on the map, not a widget.
export const PHOTO_PX = 5;
export const THUMB_PX = 36;
export const CROSS_PX = 7;

// How close a pointer must be to a mark for it to count as a hit. Larger than
// the marks themselves: a 5 px square is impossible to click otherwise.
export const HIT_PX = 10;

// --- view filtering --------------------------------------------------------

// `box` is { minLat, minLon, maxLat, maxLon }, as trackBounds returns.
export function boxesIntersect(a, b) {
	if (!a || !b) return false;
	return !(a.maxLat < b.minLat || a.minLat > b.maxLat
		|| a.maxLon < b.minLon || a.minLon > b.maxLon);
}

export function pointInBox(lat, lon, box) {
	if (!box) return true;
	return lat >= box.minLat && lat <= box.maxLat && lon >= box.minLon && lon <= box.maxLon;
}

// The index is fetched once and refiltered on every move: this is that filter.
// A track is kept whole as soon as its bounding box touches the view — clipping
// the polyline itself would cost more than letting the canvas clip it.
// `box` null means "no filter", which is what the first, unbounded fetch wants.
export function tracksInView(tracks, box) {
	const list = Array.isArray(tracks) ? tracks : [];
	if (!box) return list.slice();
	return list.filter((t) => boxesIntersect(trackBounds(t), box));
}

// --- clustering ------------------------------------------------------------

// Collapse marks that land within `px` of one another into single marks
// carrying a count. Greedy against each cluster's ANCHOR, not against a moving
// centroid: a centroid lets a chain of marks drag a cluster arbitrarily far
// from where it started, and the anchor keeps the drawn cross exactly on a real
// loss point when the count is 1.
//
// `marks` are { x, y, ...payload } in container pixels. Input is sorted first
// so the result depends only on the set, never on the order the server happened
// to list the track files in.
export function clusterMarks(marks, px = CLUSTER_PX) {
	const src = [...(Array.isArray(marks) ? marks : [])]
		.filter((m) => m && Number.isFinite(m.x) && Number.isFinite(m.y))
		.sort((a, b) => (a.x - b.x) || (a.y - b.y));
	const r2 = px * px;
	const out = [];
	for (const m of src) {
		let host = null;
		for (const c of out) {
			const dx = c.x - m.x, dy = c.y - m.y;
			if (dx * dx + dy * dy <= r2) { host = c; break; }
		}
		if (host) { host.items.push(m); host.count++; }
		else out.push({ x: m.x, y: m.y, count: 1, items: [m] });
	}
	return out;
}

// --- marks -----------------------------------------------------------------

// A photo is a square below THUMB_ZOOM and a thumbnail at or above it. Returned
// as a shape plus a side so the drawer never repeats the threshold.
export function photoMarkStyle(zoom) {
	const thumb = Number.isFinite(zoom) && zoom >= THUMB_ZOOM;
	return { thumb, side: thumb ? THUMB_PX : PHOTO_PX };
}

// Nearest mark to a pointer, or null. Marks are { x, y, r? }: `r` lets a
// thumbnail claim its own size instead of the default radius, so a 36 px
// thumbnail is clickable across its whole face.
export function hitMark(marks, x, y, radius = HIT_PX) {
	let best = null, bestD2 = Infinity;
	for (const m of Array.isArray(marks) ? marks : []) {
		if (!m || !Number.isFinite(m.x) || !Number.isFinite(m.y)) continue;
		const r = Math.max(radius, m.r ?? 0);
		const dx = m.x - x, dy = m.y - y;
		const d2 = dx * dx + dy * dy;
		if (d2 <= r * r && d2 < bestD2) { best = m; bestD2 = d2; }
	}
	return best;
}

// The label a loss mark carries on hover: the date of the flight that ended
// there, or the count when several have collapsed. Dates come from the session
// id's timestamp when the caller has one — the index itself carries no date, so
// the caller passes what it knows and this only formats.
export function lossLabel(cluster, dateOf) {
	if (!cluster) return '';
	if (cluster.count > 1) return `${cluster.count} LOSSES`;
	const d = dateOf?.(cluster.items[0]);
	return d ? String(d).toUpperCase() : 'LOSS';
}

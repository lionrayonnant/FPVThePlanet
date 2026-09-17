// The flight history overlay, geometry half (issue #160, was the ENRICHED map
// of issue #25 / spec 2026-09-08-flight-track-enriched-map-data-design.md §2).
//
// The overlay draws two things and only two: the tracks left on the ground and
// the crosses where a link was lost. The photo marks, the hover labels and the
// click-through to a session sheet went with the ENRICHED mode — nobody read
// them, and a toggle nobody can read costs more than it gives (Bible §3).
//
// Pure and Node-importable: no DOM, no Leaflet. Everything that decides WHAT
// goes on the map — which tracks the current view still needs, which loss
// crosses have collapsed into one another — lives here and is covered by
// tools/flight-history-selftest.mjs in selftest:ci. src/map-tracks.js is then
// only a canvas and a layer lifecycle, the same split as coverage.js /
// map-coverage.js.

import { trackBounds } from './track-model.mjs';

// Two loss crosses closer than this on screen are one mark carrying a count.
// The map declusters as you zoom in, never before: a heavily flown area must
// stay readable at world zoom (spec §2, "Losses").
export const CLUSTER_PX = 20;

// Mark size, in CSS pixels.
export const CROSS_PX = 7;

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

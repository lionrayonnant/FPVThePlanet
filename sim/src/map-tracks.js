// The flight history overlay on the scanner (issue #160, was the ENRICHED map
// of issue #25 / spec 2026-09-08-flight-track-enriched-map-data-design.md §2):
// the Leaflet glue.
//
// Two things, and only two: the tracks left on the ground and the crosses where
// a link was lost. The layer is purely visual — no hit testing, no tooltip, no
// click-through. It draws what the operator has already flown and says nothing
// about it.
//
// Same split as coverage.js / map-coverage.js — everything that can be decided
// without a browser (which tracks the view needs, which crosses have collapsed)
// lives in tools/flight-history-model.mjs and is checked there; here there is
// only a canvas and a layer lifecycle.
//
// `L` is a parameter, not an import: the module then stays importable under
// Node (Leaflet touches `window` at load time).
import { CLUSTER_PX, CROSS_PX, tracksInView, clusterMarks } from '../tools/flight-history-model.mjs';

// Above the coverage stain (PANE_Z 350 in map-coverage.js), below overlayPane
// (400) and its area frames. The stain is a background; a track is a trace the
// operator left, and it reads over the stain — but neither of them outranks the
// frames you actually designate.
const PANE = 'tracks';
const PANE_Z = 360;

// Warm white at low alpha, no per-flight colour (spec §2, Bible §38: no
// permanent cyan or magenta). Overlapping flights add up on their own — this is
// the density, and it is the only thing the line is allowed to say.
const TRACK_ALPHA = 0.16;
const TRACK_WIDTH = 1;
// Crosses are the same ink, just less shy.
const MARK_ALPHA = 0.72;

export function createTracksLayer(L, {
	getTracks,          // () -> the /tracks index, already fetched
	ink = '#ece7dd',
} = {}) {

	const Layer = L.Layer.extend({
		onAdd(map) {
			this._map = map;
			if (!map.getPane(PANE)) map.createPane(PANE).style.zIndex = String(PANE_Z);
			const pane = map.getPane(PANE);
			const canvas = L.DomUtil.create('canvas', 'map-tracks leaflet-zoom-hide', pane);
			// The canvas never takes the pointer: nothing on this layer is a
			// target, and anything else would swallow a drag that started over a
			// track.
			canvas.style.pointerEvents = 'none';
			this._canvas = canvas;
			this._ctx = canvas.getContext('2d');
			map.on('moveend zoomend viewreset resize', this._redraw, this);
			this._redraw();
		},

		onRemove(map) {
			map.off('moveend zoomend viewreset resize', this._redraw, this);
			L.DomUtil.remove(this._canvas);
			this._canvas = null;
			this._ctx = null;
			this._map = null;
		},

		// Redraw from whatever getTracks() now returns. Harmless off the map, so
		// the caller can fire it without knowing whether the toggle is still on.
		refresh() { if (this._map) this._redraw(); },

		_redraw() {
			const map = this._map, canvas = this._canvas, ctx = this._ctx;
			if (!map || !canvas) return;
			const size = map.getSize();
			// Same buffer discipline as map-coverage: round before comparing, or a
			// fractional devicePixelRatio reallocates on every moveend.
			const dpr = window.devicePixelRatio || 1;
			const bw = Math.round(size.x * dpr), bh = Math.round(size.y * dpr);
			if (canvas.width !== bw || canvas.height !== bh) {
				canvas.width = bw;
				canvas.height = bh;
				canvas.style.width = `${size.x}px`;
				canvas.style.height = `${size.y}px`;
			}
			L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]));
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			ctx.clearRect(0, 0, size.x, size.y);

			const tracks = getTracks?.() ?? null;
			if (!Array.isArray(tracks) || !tracks.length) return;

			const b = map.getBounds();
			const view = {
				minLat: b.getSouth(), maxLat: b.getNorth(),
				minLon: b.getWest(), maxLon: b.getEast(),
			};
			const visible = tracksInView(tracks, view);
			if (!visible.length) return;

			const px = (lat, lon) => map.latLngToContainerPoint([lat, lon]);

			// --- tracks. One path per flight rather than one for all of them: a
			// single path would join the end of a flight to the start of the next
			// with a straight line across the city.
			ctx.strokeStyle = ink;
			ctx.globalAlpha = TRACK_ALPHA;
			ctx.lineWidth = TRACK_WIDTH;
			ctx.lineJoin = 'round';
			ctx.lineCap = 'round';
			for (const t of visible) {
				const line = t.line ?? [];
				if (line.length < 2) continue;
				ctx.beginPath();
				for (let i = 0; i < line.length; i++) {
					const p = px(line[i][0], line[i][1]);
					if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
				}
				ctx.stroke();
			}

			// --- losses. Clustered in PIXELS, at the current zoom: that is what
			// keeps a heavily flown area readable, and what makes it decluster as
			// you come down (spec §2).
			ctx.globalAlpha = MARK_ALPHA;
			const raw = [];
			for (const t of visible) {
				if (!t.end) continue;
				const p = px(t.end.lat, t.end.lon);
				if (p.x < -CLUSTER_PX || p.y < -CLUSTER_PX
					|| p.x > size.x + CLUSTER_PX || p.y > size.y + CLUSTER_PX) continue;
				raw.push({ x: p.x, y: p.y, sessionId: t.sessionId, end: t.end });
			}
			for (const c of clusterMarks(raw)) this._drawCross(ctx, c);
			ctx.globalAlpha = 1;
		},

		// A cross, and its count when several losses have collapsed into it. No
		// halo, no colour: this is where a link died, the map does not dramatize
		// it (Bible §24 — nothing rewards or punishes a crash after the fact).
		_drawCross(ctx, c) {
			const r = CROSS_PX / 2;
			const x = Math.round(c.x) + 0.5, y = Math.round(c.y) + 0.5;
			ctx.strokeStyle = ink;
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r);
			ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r);
			ctx.stroke();
			if (c.count > 1) {
				ctx.fillStyle = ink;
				ctx.font = '10px monospace';
				ctx.textBaseline = 'middle';
				ctx.fillText(String(c.count), x + r + 2, y);
			}
		},
	});

	return new Layer();
}

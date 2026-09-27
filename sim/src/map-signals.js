// The signals overlay on the scanner (issue #185, spec §1): landmarks the
// operator can go and capture. Same split as map-tracks.js — what can be
// decided without a browser lives in tools/signal-model.mjs; here there is a
// canvas and a layer lifecycle. `L` is a parameter so the module stays
// importable under Node.
import { signalsInView, LABEL_ZOOM, declutter } from '../tools/signal-model.mjs';

// Above the tracks (360): a signal is a place to go, it reads over where you
// have been. Below overlayPane (400) and the area frames you designate.
const PANE = 'signals';
const PANE_Z = 370;

// A point of light: a hard core in a soft halo. An outlined warm-white
// diamond was tried first and disappeared among the basemap's own
// pictograms, and a warm-white glow still read as part of the map. The ink is
// a functional colour (Bible §38: colour only when it carries information) —
// the scanner passes --yellow, "watch it": a place to go. Lot 3 adds the
// other states (resolved → green). The tier reads as the size of the halo.
const CORE = 4;
const HALO = [0, 14, 18, 23];   // by tier
const LABEL_DX = 11;
// One light per cell of this size at most: a city seen from zoom 10 would
// otherwise be a single blinding blob.
const CELL_PX = 26;

export function createSignalsLayer(L, { getSignals, ink = '#d4b155', white = '#ece7dd' } = {}) {
	const Layer = L.Layer.extend({
		onAdd(map) {
			this._map = map;
			if (!map.getPane(PANE)) map.createPane(PANE).style.zIndex = String(PANE_Z);
			const canvas = L.DomUtil.create('canvas', 'map-signals leaflet-zoom-hide', map.getPane(PANE));
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

		refresh() { if (this._map) this._redraw(); },

		// Leaflet's attribution control picks this up while the layer is on the
		// map (ODbL requires credit wherever OSM data is shown, not just tiles).
		getAttribution() { return 'Signals © OpenStreetMap contributors'; },

		_redraw() {
			const map = this._map, canvas = this._canvas, ctx = this._ctx;
			if (!map || !canvas) return;
			const size = map.getSize();
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

			const all = getSignals?.() ?? [];
			if (!all.length) return;
			const b = map.getBounds();
			const visible = signalsInView(all, {
				minLat: b.getSouth(), maxLat: b.getNorth(),
				minLon: b.getWest(), maxLon: b.getEast(),
			});
			// Halos first, added together ('lighter'): overlapping signals brighten
			// instead of covering each other.
			const pts = declutter(visible.map((sig) => {
				const p = map.latLngToContainerPoint([sig.lat, sig.lon]);
				return { s: sig, x: p.x, y: p.y };
			}), CELL_PX);
			ctx.globalCompositeOperation = 'lighter';
			for (const { s, x, y } of pts) {
				const r = HALO[s.tier] ?? HALO[1];
				const g = ctx.createRadialGradient(x, y, 0, x, y, r);
				g.addColorStop(0, withAlpha(ink, 0.75));
				g.addColorStop(0.3, withAlpha(ink, 0.35));
				g.addColorStop(1, withAlpha(ink, 0));
				ctx.fillStyle = g;
				ctx.beginPath();
				ctx.arc(x, y, r, 0, Math.PI * 2);
				ctx.fill();
			}
			ctx.globalCompositeOperation = 'source-over';
			ctx.fillStyle = ink;
			for (const { x, y } of pts) {
				ctx.beginPath();
				ctx.arc(x, y, CORE, 0, Math.PI * 2);
				ctx.fill();
			}
			// A warm-white pinpoint in the middle: the "lit" look, and the dot
			// stays visible over the yellow parts of the satellite basemap.
			ctx.fillStyle = withAlpha(white, 0.95);
			for (const { x, y } of pts) {
				ctx.beginPath();
				ctx.arc(x, y, CORE / 2, 0, Math.PI * 2);
				ctx.fill();
			}
			if (map.getZoom() >= LABEL_ZOOM) {
				ctx.font = '11px "IBM Plex Mono", monospace';
				ctx.textBaseline = 'middle';
				ctx.fillStyle = ink;
				ctx.globalAlpha = 0.95;
				// fillText, never innerHTML: OSM text is data (PR #81).
				for (const { s, x, y } of pts) ctx.fillText(s.name, x + LABEL_DX, y);
				ctx.globalAlpha = 1;
			}
		},
	});
	return new Layer();
}

// '#ece7dd' + alpha -> 'rgba(236, 231, 221, a)'. The ink comes from a CSS
// token, so it is a hex string; anything else falls back to warm white.
function withAlpha(hex, a) {
	const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
	const n = parseInt(m ? m[1] : 'ece7dd', 16);
	return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

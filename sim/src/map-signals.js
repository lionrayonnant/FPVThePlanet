// The signals overlay on the scanner (issue #185, spec §1): landmarks the
// operator can go and capture. Same split as map-tracks.js — what can be
// decided without a browser lives in tools/signal-model.mjs; here there is a
// canvas and a layer lifecycle. `L` is a parameter so the module stays
// importable under Node.
import { signalsInView, LABEL_ZOOM } from '../tools/signal-model.mjs';

// Above the tracks (360): a signal is a place to go, it reads over where you
// have been. Below overlayPane (400) and the area frames you designate.
const PANE = 'signals';
const PANE_Z = 370;

// Warm white only (Bible §38). Tier reads as ticks under the diamond, not as
// colour: colour is reserved for state, which lot 3 brings (resolved,
// encrypted).
const R = 5;
const ALPHA = 0.9;

export function createSignalsLayer(L, { getSignals, ink = '#ece7dd' } = {}) {
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
			const labels = map.getZoom() >= LABEL_ZOOM;
			ctx.globalAlpha = ALPHA;
			ctx.strokeStyle = ink;
			ctx.fillStyle = ink;
			ctx.lineWidth = 1.5;
			ctx.font = '10px "IBM Plex Mono", monospace';
			ctx.textBaseline = 'middle';
			for (const s of visible) {
				const p = map.latLngToContainerPoint([s.lat, s.lon]);
				const x = Math.round(p.x) + 0.5, y = Math.round(p.y) + 0.5;
				ctx.beginPath();
				ctx.moveTo(x, y - R); ctx.lineTo(x + R, y); ctx.lineTo(x, y + R); ctx.lineTo(x - R, y);
				ctx.closePath();
				ctx.stroke();
				for (let i = 0; i < s.tier; i++) ctx.fillRect(x - 4 + i * 3, y + R + 3, 2, 2);
				// fillText, never innerHTML: OSM text is data (PR #81).
				if (labels) ctx.fillText(s.name, x + R + 4, y);
			}
			ctx.globalAlpha = 1;
		},
	});
	return new Layer();
}

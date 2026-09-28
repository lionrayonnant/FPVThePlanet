// The signals overlay on the scanner (issue #185, spec §1): landmarks the
// operator can go and capture. Same split as map-tracks.js — what can be
// decided without a browser lives in tools/signal-model.mjs; here there is a
// canvas and a layer lifecycle. `L` is a parameter so the module stays
// importable under Node.
import { signalsInView, LABEL_ZOOM, declutter, placeLabels, tileBounds } from '../tools/signal-model.mjs';
import { tierAllowed, MAX_CLEARANCE } from '../tools/signal-clearance-model.mjs';

// Above the tracks (360): a signal is a place to go, it reads over where you
// have been. Below overlayPane (400) and the area frames you designate.
const PANE = 'signals';
const PANE_Z = 370;

// A point of light: a hard core in a soft halo. An outlined warm-white
// diamond was tried first and disappeared among the basemap's own
// pictograms, and a warm-white glow still read as part of the map. The ink is
// a functional colour (Bible §38: colour only when it carries information) —
// the scanner passes --yellow, "watch it": a place to go. The tier reads as
// the size of the halo. Three shapes, so colour is never the only cue
// (flight-da.html §3): to capture = filled yellow light; uplinked = hollow
// green ring with a tick; locked by clearance = small dim warm-white dot.
const CORE = 4;
const RING = 5;       // uplinked ring radius, 2 px stroke
const LOCKED_R = 2.5;
const HALO = [0, 14, 18, 23];   // by tier
const LABEL_DX = 11;
const LABEL_H = 14;     // 11 px text + a little air
// One light per cell of this size at most: a dense district seen from zoom 13
// would otherwise be a single blinding blob.
const CELL_PX = 26;

// The glitch on the tile being asked (scanning-v3.html). ~11 Hz, only while
// the source has a tile in flight and it is on screen.
const GLITCH_MS = 90;
const GLITCH_SLICES = 9;
const GLITCH_SHIFT = 0.18;       // max horizontal displacement, share of the tile width
const NOISE = '░▒▓█▚▞■□▪·:.';
const NOISE_DENSITY = 0.16;
const NOISE_CW = 6, NOISE_LH = 10;
const EDGE_BLINK_MS = 180;

// getClearance() → the operator's level; a signal above it is drawn locked.
// getScan() → { current: tileKey | null, queued: tileKey[] }: the tile being
// asked glitches, the rest of the batch gets a dashed outline.
export function createSignalsLayer(L, {
	getSignals, getResolved = () => null, getClearance = () => MAX_CLEARANCE,
	getScan = () => null,
	ink = '#d4b155', resolvedInk = '#7aa96b', white = '#ece7dd', black = '#0a0908',
} = {}) {
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
			this._stopGlitch();
			L.DomUtil.remove(this._canvas);
			this._canvas = null;
			this._ctx = null;
			this._map = null;
		},

		refresh() { if (this._map) this._redraw(); },

		_startGlitch() {
			if (this._glitchTimer) return;
			this._glitchTimer = setInterval(() => this._redraw(), GLITCH_MS);
		},
		_stopGlitch() {
			clearInterval(this._glitchTimer);
			this._glitchTimer = null;
		},

		// The screen rect of a z12 tile key, or null when it is off screen.
		_tileRect(key, size) {
			const m = /^z\d+\/(\d+)\/(\d+)$/.exec(key ?? '');
			if (!m) return null;
			const b = tileBounds({ x: +m[1], y: +m[2] });
			const a = this._map.latLngToContainerPoint([b.n, b.w]);
			const c = this._map.latLngToContainerPoint([b.s, b.e]);
			const r = { x: a.x, y: a.y, w: c.x - a.x, h: c.y - a.y };
			if (r.x > size.x || r.y > size.y || r.x + r.w < 0 || r.y + r.h < 0) return null;
			return r;
		},

		// The basemap inside the tile tears into displaced grey slices under
		// ASCII noise; its hairline flickers. Drawing the tile images taints the
		// canvas — fine, it is never read back. A z12 tile is 4096 px wide at
		// zoom 16 and 131072 px at 21: the slices and the noise cover only its
		// part on screen (`v`), which also scales the slice displacement; the full
		// rect `r` only draws the hairline.
		_drawGlitch(ctx, r, size) {
			const map = this._map;
			const x0 = Math.max(r.x, 0), y0 = Math.max(r.y, 0);
			const v = { x: x0, y: y0, w: Math.min(r.x + r.w, size.x) - x0, h: Math.min(r.y + r.h, size.y) - y0 };
			if (v.w <= 0 || v.h <= 0) return;
			const origin = map.getContainer().getBoundingClientRect();
			const imgs = [];
			const pane = map.getPane('tilePane');
			for (const img of pane?.querySelectorAll('img.leaflet-tile-loaded') ?? []) {
				const b = img.getBoundingClientRect();
				const x = b.left - origin.left, y = b.top - origin.top;
				if (x > v.x + v.w || y > v.y + v.h || x + b.width < v.x || y + b.height < v.y) continue;
				imgs.push({ img, x, y, w: b.width, h: b.height });
			}
			// The basemap's own CSS filter (MONO inverts a light tile), so the
			// slices tear the map as it is shown, then the grey of the glitch.
			let css = '';
			for (let el = imgs[0]?.img; el && el !== pane; el = el.parentElement) {
				const f = getComputedStyle(el).filter;
				if (f && f !== 'none') css = `${f} ${css}`;
			}
			ctx.save();
			ctx.beginPath();
			ctx.rect(v.x, v.y, v.w, v.h);
			ctx.clip();
			ctx.fillStyle = black;
			ctx.fillRect(v.x, v.y, v.w, v.h);
			ctx.filter = `${css}grayscale(1) brightness(1.25) contrast(1.2)`;
			let y = v.y;
			for (let i = 0; i < GLITCH_SLICES && y < v.y + v.h; i++) {
				const hh = i === GLITCH_SLICES - 1 ? v.y + v.h - y : Math.max(4, Math.random() * v.h / GLITCH_SLICES * 1.8);
				const dx = Math.random() < 0.5 ? (Math.random() - 0.5) * v.w * GLITCH_SHIFT : 0;
				ctx.save();
				ctx.beginPath();
				ctx.rect(v.x, y, v.w, hh);
				ctx.clip();
				ctx.globalAlpha = Math.random() < 0.2 ? 0.35 : 1;
				for (const t of imgs) {
					try { ctx.drawImage(t.img, t.x + dx, t.y, t.w, t.h); } catch { /* a broken tile is a black slice */ }
				}
				ctx.restore();
				y += hh;
			}
			ctx.filter = 'none';
			// Sparse noise, screened over the slices.
			ctx.globalCompositeOperation = 'screen';
			ctx.font = `${NOISE_LH}px "Departure Mono", monospace`;
			ctx.textBaseline = 'top';
			ctx.fillStyle = withAlpha(white, 0.55);
			for (let yy = v.y; yy < v.y + v.h; yy += NOISE_LH) {
				for (let xx = v.x; xx < v.x + v.w; xx += NOISE_CW) {
					if (Math.random() < NOISE_DENSITY) ctx.fillText(NOISE[(Math.random() * NOISE.length) | 0], xx, yy);
				}
			}
			ctx.globalCompositeOperation = 'source-over';
			ctx.restore();
			if (Math.floor(performance.now() / EDGE_BLINK_MS) % 2 === 0) {
				ctx.strokeStyle = white;
				ctx.lineWidth = 1;
				ctx.strokeRect(Math.round(r.x) + 0.5, Math.round(r.y) + 0.5, Math.round(r.w) - 1, Math.round(r.h) - 1);
			}
		},

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

			// The scan: the tile in flight glitches, the queued ones are outlined.
			// The timer runs only while there is a tile in flight on screen.
			const scan = getScan?.() ?? null;
			const cur = scan?.current ? this._tileRect(scan.current, size) : null;
			if (cur) this._startGlitch(); else this._stopGlitch();
			if (scan?.queued?.length) {
				ctx.save();
				ctx.strokeStyle = withAlpha(white, 0.3);
				ctx.lineWidth = 1;
				ctx.setLineDash([4, 3]);
				for (const k of scan.queued) {
					const r = this._tileRect(k, size);
					if (r) ctx.strokeRect(Math.round(r.x) + 0.5, Math.round(r.y) + 0.5, Math.round(r.w) - 1, Math.round(r.h) - 1);
				}
				ctx.restore();
			}
			if (cur) this._drawGlitch(ctx, cur, size);

			const all = getSignals?.() ?? [];
			if (!all.length) return;
			const b = map.getBounds();
			const visible = signalsInView(all, {
				minLat: b.getSouth(), maxLat: b.getNorth(),
				minLon: b.getWest(), maxLon: b.getEast(),
			});
			const pts = declutter(visible.map((sig) => {
				const p = map.latLngToContainerPoint([sig.lat, sig.lon]);
				return { s: sig, x: p.x, y: p.y };
			}), CELL_PX);
			const done = getResolved?.() ?? null;
			const level = getClearance?.() ?? MAX_CLEARANCE;
			const open = [], uplinked = [], locked = [];
			for (const p of pts) {
				if (done && done.has(p.s.id)) uplinked.push(p);
				else if (!tierAllowed(level, p.s.tier)) locked.push(p);
				else open.push(p);
			}
			// Halos first, added together ('lighter'): overlapping signals brighten
			// instead of covering each other. The uplinked halo is fainter: the
			// place is done, it no longer calls.
			ctx.globalCompositeOperation = 'lighter';
			const halo = (x, y, r, c, a) => {
				const g = ctx.createRadialGradient(x, y, 0, x, y, r);
				g.addColorStop(0, withAlpha(c, a));
				g.addColorStop(0.3, withAlpha(c, a * 0.47));
				g.addColorStop(1, withAlpha(c, 0));
				ctx.fillStyle = g;
				ctx.beginPath();
				ctx.arc(x, y, r, 0, Math.PI * 2);
				ctx.fill();
			};
			for (const { s, x, y } of open) halo(x, y, HALO[s.tier] ?? HALO[1], ink, 0.75);
			for (const { x, y } of uplinked) halo(x, y, HALO[1], resolvedInk, 0.3);
			ctx.globalCompositeOperation = 'source-over';
			// To capture: a filled light with a warm-white pinpoint — the "lit"
			// look, visible over the yellow parts of the satellite basemap.
			ctx.fillStyle = ink;
			for (const { x, y } of open) {
				ctx.beginPath();
				ctx.arc(x, y, CORE, 0, Math.PI * 2);
				ctx.fill();
			}
			ctx.fillStyle = withAlpha(white, 0.95);
			for (const { x, y } of open) {
				ctx.beginPath();
				ctx.arc(x, y, CORE / 2, 0, Math.PI * 2);
				ctx.fill();
			}
			// Uplinked: a hollow ring with a tick inside.
			ctx.strokeStyle = resolvedInk;
			ctx.lineCap = 'square';
			for (const { x, y } of uplinked) {
				ctx.lineWidth = 2;
				ctx.beginPath();
				ctx.arc(x, y, RING, 0, Math.PI * 2);
				ctx.stroke();
				ctx.lineWidth = 1.5;
				ctx.beginPath();
				ctx.moveTo(x - 2, y);
				ctx.lineTo(x - 0.5, y + 1.6);
				ctx.lineTo(x + 2.2, y - 1.8);
				ctx.stroke();
			}
			// Locked by clearance: a small dim dot, no halo.
			ctx.fillStyle = withAlpha(white, 0.6);
			for (const { x, y } of locked) {
				ctx.beginPath();
				ctx.arc(x, y, LOCKED_R, 0, Math.PI * 2);
				ctx.fill();
			}
			if (map.getZoom() >= LABEL_ZOOM) {
				ctx.font = '11px "IBM Plex Mono", monospace';
				ctx.textBaseline = 'middle';
				// A dark halo under each name: yellow text alone drowns in a
				// bright satellite basemap.
				ctx.strokeStyle = withAlpha(black, 0.85);
				ctx.lineWidth = 3;
				ctx.lineJoin = 'round';
				ctx.globalAlpha = 0.95;
				// Best-ranked names first; one that would cover another name or
				// another light is dropped. fillText, never innerHTML: OSM text is
				// data (PR #81).
				const widths = new Map();
				const measure = (name) => {
					if (!widths.has(name)) widths.set(name, ctx.measureText(name).width);
					return widths.get(name);
				};
				// A name takes its light's colour: yellow only for what can be
				// captured (functional colours, Bible §19).
				const tone = new Map();
				for (const p of uplinked) tone.set(p.s.id, resolvedInk);
				for (const p of locked) tone.set(p.s.id, withAlpha(white, 0.6));
				for (const { s, x, y } of placeLabels(pts, measure, { dx: LABEL_DX, h: LABEL_H, core: CORE })) {
					ctx.fillStyle = tone.get(s.id) ?? ink;
					ctx.strokeText(s.name, x + LABEL_DX, y);
					ctx.fillText(s.name, x + LABEL_DX, y);
				}
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

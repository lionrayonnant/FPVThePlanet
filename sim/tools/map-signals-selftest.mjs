// Selftest of the scanner's signals canvas (src/map-signals.js, issue #185):
// a stub Leaflet, a stub map and a counting 2D context — no browser. Checks
// that the scan glitch works on the part of the z12 tile on screen only (a
// z12 tile is 131072 px wide at zoom 21), and that each name gets its dark
// halo before its ink. Run: node tools/map-signals-selftest.mjs
import assert from 'node:assert/strict';
import { createSignalsLayer } from '../src/map-signals.js';
import { tileOf, tileKey, LABEL_ZOOM } from './signal-model.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

globalThis.window = { devicePixelRatio: 1 };
globalThis.getComputedStyle = () => ({ filter: 'none' });

const L = {
	Layer: { extend(proto) { return function Layer() { Object.assign(this, proto); }; } },
	DomUtil: { create: () => ({ style: {} }), remove() {}, setPosition() {} },
};

// Every call on the context is counted; strokeText/fillText also log the
// stroke style they were drawn with.
function countingCtx() {
	const calls = {}, texts = [];
	const ctx = new Proxy({ measureText: (s) => ({ width: s.length * 7 }), createRadialGradient: () => ({ addColorStop() {} }) }, {
		get(target, k) {
			if (k in target) return target[k];
			return (...a) => {
				calls[k] = (calls[k] ?? 0) + 1;
				if (k === 'strokeText' || k === 'fillText') texts.push({ k, text: a[0], stroke: target.strokeStyle, lw: target.lineWidth });
			};
		},
		set(target, k, v) { target[k] = v; return true; },
	});
	return { ctx, calls, texts };
}

// Web Mercator at `zoom`, `center` at the middle of a `w`×`h` container.
function stubMap({ center, zoom, w = 1280, h = 800, tiles = 12 }) {
	const world = 256 * 2 ** zoom;
	const project = (lat, lon) => {
		const s = Math.sin(lat * Math.PI / 180);
		return { x: (lon + 180) / 360 * world, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * world };
	};
	const unproject = (x, y) => ({
		lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * y / world))) * 180 / Math.PI,
		lon: x / world * 360 - 180,
	});
	const c = project(center.lat, center.lon);
	const toC = (ll) => {
		const [lat, lon] = Array.isArray(ll) ? ll : [ll.lat, ll.lng];
		const p = project(lat, lon);
		return { x: p.x - c.x + w / 2, y: p.y - c.y + h / 2 };
	};
	const nw = unproject(c.x - w / 2, c.y - h / 2), se = unproject(c.x + w / 2, c.y + h / 2);
	// `tiles` loaded basemap images covering the viewport.
	const imgs = Array.from({ length: tiles }, (_, i) => ({
		getBoundingClientRect: () => ({ left: (i % 4) * 320, top: Math.floor(i / 4) * 267, width: 320, height: 267 }),
		parentElement: null,
	}));
	return {
		getPane: (name) => (name === 'tilePane' ? { querySelectorAll: () => imgs } : {}),
		createPane: () => ({ style: {} }),
		on() {}, off() {},
		getSize: () => ({ x: w, y: h }),
		getZoom: () => zoom,
		getContainer: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }),
		containerPointToLayerPoint: (p) => p,
		latLngToContainerPoint: toC,
		getBounds: () => ({ getSouth: () => se.lat, getNorth: () => nw.lat, getWest: () => nw.lon, getEast: () => se.lon }),
	};
}

function mount(map, opts) {
	const layer = createSignalsLayer(L, { black: '#0a0908', ...opts });
	const c = countingCtx();
	layer._map = map;
	layer._canvas = { width: 0, height: 0, style: {} };
	layer._ctx = c.ctx;
	return { layer, ...c };
}

const PARIS = { lat: 48.8584, lon: 2.2945 };
const scanHere = () => ({ current: tileKey(tileOf(PARIS.lat, PARIS.lon)), queued: [] });

t('glitch at zoom 21: bounded by the viewport, not by the 131072 px tile', () => {
	const map = stubMap({ center: PARIS, zoom: 21 });
	const { layer, calls } = mount(map, { getSignals: () => [], getScan: scanHere });
	const r = layer._tileRect(scanHere().current, map.getSize());
	assert.ok(r && r.w > 100_000, `the z12 tile is huge on screen (${r?.w | 0} px)`);
	const random = Math.random;
	Math.random = () => 0;          // every cell draws a glyph: the worst case
	try { layer._redraw(); } finally { Math.random = random; layer._stopGlitch(); }
	const cells = Math.ceil(1280 / 6) * Math.ceil(800 / 10);
	assert.ok(calls.fillText > 0, 'the noise is drawn');
	assert.ok(calls.fillText <= cells, `fillText ${calls.fillText} <= ${cells} screen cells`);
	assert.ok(calls.drawImage <= 9 * 12, `drawImage ${calls.drawImage} <= slices × loaded tiles`);
});

t('glitch at zoom 16: same bound, the tile only partly on screen', () => {
	const map = stubMap({ center: PARIS, zoom: 16 });
	const { layer, calls } = mount(map, { getSignals: () => [], getScan: scanHere });
	const random = Math.random;
	Math.random = () => 0;
	try { layer._redraw(); } finally { Math.random = random; layer._stopGlitch(); }
	assert.ok(calls.fillText > 0 && calls.fillText <= Math.ceil(1280 / 6) * Math.ceil(800 / 10));
});

t('glitch: a tile off screen draws nothing and stops the timer', () => {
	const map = stubMap({ center: { lat: 10, lon: 10 }, zoom: 16 });
	const { layer, calls } = mount(map, { getSignals: () => [], getScan: scanHere });
	layer._redraw();
	assert.equal(calls.fillText ?? 0, 0);
	assert.equal(layer._glitchTimer, null);
});

t('labels: a dark halo stroked under each name, from the black token', () => {
	const map = stubMap({ center: PARIS, zoom: LABEL_ZOOM + 1 });
	const signals = [
		{ id: 'wd:Q243', name: 'TOUR EIFFEL', lat: PARIS.lat, lon: PARIS.lon, tier: 3 },
		{ id: 'wd:Q1', name: 'CHAMP DE MARS', lat: PARIS.lat - 0.003, lon: PARIS.lon + 0.004, tier: 1 },
	];
	const { layer, texts } = mount(map, { getSignals: () => signals, black: '#102030' });
	layer._redraw();
	assert.ok(texts.length >= 2, 'at least one name drawn');
	for (let i = 0; i < texts.length; i += 2) {
		assert.equal(texts[i].k, 'strokeText');
		assert.equal(texts[i + 1].k, 'fillText');
		assert.equal(texts[i].text, texts[i + 1].text);
		assert.equal(texts[i].stroke, 'rgba(16, 32, 48, 0.85)');
		assert.equal(texts[i].lw, 3);
	}
});

console.log(`map-signals-selftest: ${n} ok`);

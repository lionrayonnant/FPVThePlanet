// Where a signal sits in the 3D world (issue #185, spec §1): OSM gives lat/lon,
// the height is found in flight by probing the streamed mesh. Pure: the probe
// is injected (main.js passes physics.groundBelow), so it is checked without
// Rapier in tools/signal-anchor-selftest.mjs.
//
// A landmark's OSM point is often its centroid — a cathedral's is over the
// nave, a castle's over the courtyard. The probe samples a ring and keeps the
// HIGHEST hit: the callout belongs on the spire, not in the yard.
export const RING_M = 12;
export const RING_N = 8;
export const ABOVE_M = 3;
export const PROBE_FROM_M = 600;
export const RETRY_S = 0.5;
export const RISE_TAU_S = 0.4;
const PROBE_BUDGET = 4;
const REPROBE_S = 5;

export class SignalAnchors {
	constructor({ toLocal, ground }) {
		this._toLocal = toLocal;
		this._ground = ground;
		this._list = [];
		this._by = new Map();
		this._cursor = 0;
	}

	set(signals) {
		this._list = [];
		this._by = new Map();
		for (const s of signals ?? []) {
			const p = this._toLocal(s.lat, s.lon);
			if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
			const a = { id: s.id, x: p.x, z: p.z, y: null, target: null, wait: 0 };
			this._list.push(a);
			this._by.set(s.id, a);
		}
		this._cursor = 0;
	}

	update(dt) {
		for (const a of this._list) {
			a.wait -= dt;
			if (a.y !== null && a.target !== null) a.y += (a.target - a.y) * (1 - Math.exp(-dt / RISE_TAU_S));
		}
		let budget = PROBE_BUDGET;
		for (let i = 0; i < this._list.length && budget > 0; i++) {
			const a = this._list[(this._cursor + i) % this._list.length];
			if (a.wait > 0) continue;
			budget--;
			const top = this._probe(a.x, a.z);
			if (top === null) { a.wait = RETRY_S; continue; }
			const target = top + ABOVE_M;
			if (a.target === null || target > a.target) a.target = target;
			if (a.y === null) a.y = a.target;
			a.wait = REPROBE_S;
		}
		if (this._list.length) this._cursor = (this._cursor + PROBE_BUDGET) % this._list.length;
	}

	pos(id) {
		const a = this._by.get(id);
		return a && a.y !== null ? { x: a.x, y: a.y, z: a.z } : null;
	}

	_probe(x, z) {
		let top = this._ground(x, z, PROBE_FROM_M);
		for (let k = 0; k < RING_N; k++) {
			const th = (k / RING_N) * Math.PI * 2;
			const h = this._ground(x + Math.cos(th) * RING_M, z + Math.sin(th) * RING_M, PROBE_FROM_M);
			if (h !== null && (top === null || h > top)) top = h;
		}
		return top;
	}
}

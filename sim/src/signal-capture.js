// Signal capture in flight (issue #185, spec §3): hold a landmark in the FPV
// frame, the gauge fills, at 100 % it is UPLINKED. Pure — no THREE, no
// Rapier, no DOM — so it is checked with synthetic poses
// (tools/signal-capture-selftest.mjs). main.js feeds it the camera pose and a
// line-of-sight probe, and drains `out.uplinked` like FlightEnd.out.closes.
//
// A target above the operator's clearance carries `encrypted: true` (spec
// author's decision 2026-09-28, tools/signal-clearance-model.mjs): it is
// shown, within SHOW_M, so it teaches the ladder exists, but it is never a
// candidate, never gauges, never takes focus. Row states:
// hidden|near|capturing|held|resolved|encrypted.
//
// The spec's starting points, widened after the author's first flights
// (2026-09-27: "a bit hard to capture"). Kept here and nowhere else.
export const CONE_DEG = 20;
export const HOLD_S = 5;
// Out of frame the gauge drains at a third of the rate it fills: a bad pass
// costs seconds, not the capture.
export const DRAIN_RATE = 1 / 3;
export const RANGE_M = { 1: [30, 300], 2: [30, 300], 3: [30, 450] };
// The callout appears inside this distance (it is inside the fog range).
export const SHOW_M = 400;
// Another candidate must be strictly nearer the axis this long to take the
// focus: two landmarks side by side must not make the gauge flicker.
export const FOCUS_SWITCH_S = 0.5;

const COS_CONE = Math.cos(CONE_DEG * Math.PI / 180);

export class SignalCapture {
	constructor() {
		this._targets = [];
		this._gauge = new Map();
		this._resolved = new Set();
		this._focus = null;
		this._challenger = null;
		this._challengeS = 0;
		this.out = { rows: [], focus: null, uplinked: null };
	}

	setTargets(list) {
		this._targets = Array.isArray(list) ? list.filter((t) => t && t.id) : [];
		const ids = new Set(this._targets.map((t) => t.id));
		for (const id of [...this._gauge.keys()]) if (!ids.has(id)) this._gauge.delete(id);
		for (const t of this._targets) if (t.resolved) this._resolved.add(t.id);
		if (this._focus && !ids.has(this._focus)) this._focus = null;
	}

	markResolved(id) {
		this._resolved.add(id);
		if (this._focus === id) this._focus = null;
	}

	update({ dt, cam, fpv, los }) {
		const o = this.out;
		o.uplinked = null;
		const rows = [];
		let best = null;
		for (const t of this._targets) {
			const r = { id: t.id, dist: Infinity, angleDeg: 180, state: 'hidden', gauge: this._gauge.get(t.id) ?? 0 };
			rows.push(r);
			if (this._resolved.has(t.id)) { r.state = 'resolved'; r.gauge = 1; }
			if (!t.pos) continue;
			const dx = t.pos.x - cam.x, dy = t.pos.y - cam.y, dz = t.pos.z - cam.z;
			const dist = Math.hypot(dx, dy, dz);
			r.dist = dist;
			const cos = dist > 1e-6 ? (dx * cam.fx + dy * cam.fy + dz * cam.fz) / dist : 1;
			r.angleDeg = Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
			// Resolved: shown (green) only while near, so it never hogs the callout.
			if (r.state === 'resolved') { if (dist > SHOW_M) r.state = 'hidden'; continue; }
			// Encrypted: shown within SHOW_M, but never a candidate — checked
			// before the range/cone gate, so it can never fall through to it.
			if (t.encrypted) { r.state = dist <= SHOW_M ? 'encrypted' : 'hidden'; continue; }
			if (dist > SHOW_M && !(t.tier === 3 && dist <= RANGE_M[3][1])) continue;
			r.state = r.gauge > 0 ? 'held' : 'near';
			const [lo, hi] = RANGE_M[t.tier] ?? RANGE_M[1];
			if (dist >= lo && dist <= hi && cos >= COS_CONE && (!best || r.angleDeg < best.row.angleDeg)) {
				best = { t, row: r };
			}
		}

		// Focus with hysteresis.
		const cur = rows.find((r) => r.id === this._focus && r.state !== 'resolved');
		const curIsCandidate = cur && best && this._isCandidate(cur);
		if (!best) {
			this._focus = null; this._challenger = null; this._challengeS = 0;
		} else if (!this._focus || !curIsCandidate) {
			this._focus = best.t.id; this._challenger = null; this._challengeS = 0;
		} else if (best.t.id !== this._focus) {
			if (this._challenger === best.t.id) this._challengeS += Math.max(0, dt);
			else { this._challenger = best.t.id; this._challengeS = Math.max(0, dt); }
			if (this._challengeS >= FOCUS_SWITCH_S) { this._focus = best.t.id; this._challenger = null; this._challengeS = 0; }
		} else {
			this._challenger = null; this._challengeS = 0;
		}
		o.focus = this._focus;

		if (dt > 0) {
			const focusT = this._targets.find((t) => t.id === this._focus);
			const rising = focusT && fpv && los(focusT);
			for (const r of rows) {
				if (r.state === 'resolved' || r.state === 'hidden' || r.state === 'encrypted') continue;
				let g = this._gauge.get(r.id) ?? 0;
				if (r.id === this._focus && rising) {
					g = Math.min(1, g + dt / HOLD_S);
					r.state = 'capturing';
				} else {
					g = Math.max(0, g - dt * DRAIN_RATE / HOLD_S);
					r.state = g > 0 ? 'held' : 'near';
				}
				this._gauge.set(r.id, g);
				r.gauge = g;
				if (g >= 1) {
					this._resolved.add(r.id);
					r.state = 'resolved';
					o.uplinked = r.id;
					this._focus = null;
					o.focus = null;
				}
			}
		} else if (this._focus) {
			const r = rows.find((x) => x.id === this._focus);
			if (r && r.gauge > 0) r.state = 'held';
		}
		o.rows = rows;
		return o;
	}

	_isCandidate(r) {
		const t = this._targets.find((x) => x.id === r.id);
		if (!t || !t.pos) return false;
		const [lo, hi] = RANGE_M[t.tier] ?? RANGE_M[1];
		return r.dist >= lo && r.dist <= hi && r.angleDeg <= CONE_DEG;
	}
}

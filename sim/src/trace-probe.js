// The trace's view of the world (issue #185, spec
// docs/superpowers/specs/2026-09-28-signals-traces-design.md): budgeted polar
// probing of the collision mesh around a signal, the bridge axis, incremental
// validation of a built trace and the lift that clears a blocked stretch.
// The rays are injected (main.js passes physics.groundBelow / rayUp /
// obstructionBetween), so tools/trace-probe-selftest.mjs runs it against a fake
// world. No THREE, no Rapier. Local ENU metres: X east, Y up, Z south.
//
// Profile (consumed by tools/trace-model.mjs buildTrace): ring i, angle k of n
// at (anchor.x + r·cos θ, anchor.z + r·sin θ), θ = 2πk/n; heights are absolute
// Y, NaN where the ray missed (the model reads it as `ground`).
//
// Nothing is allocated per ray: the grid arrays are allocated once per start().

export const RINGS_M = [0, 10, 20, 35, 55, 80];
export const ANGLES = 16;
export const PROBE_ABOVE_M = 300;    // down rays start this far above the anchor
export const PROBE_DEPTH_M = 1000;   // and reach this far down
export const PARTIAL_MISS_FRAC = 0.25; // more misses than this: the profile is `partial`
// Bridge axis.
export const DECK_ABOVE_M = 4;       // a deck point sits this far above its ring's floor
export const MIN_DECK_POINTS = 3;
export const AXIS_ELONGATION = 4;    // λ1 ≥ 4·λ2: a line, not a blob (a plain building)
export const FLOOR_NEAR_M = 30;      // floor under the deck centre: grid points this close
export const UNDER_START_M = 2;      // rayUp starts this far above that floor
// Water (or road) to deck underside. Real city bridges measure 6–9 m in the
// mesh (Mirabeau 6.0): 3 m either side of a line centred in the gap.
// tools/trace-model.mjs reads it from here.
export const UNDER_MIN_CLEARANCE_M = 6;
export const PASS_HALF_M = 40;       // the under-pass reach, either side of the deck
export const PASS_SHIFTS_M = [0, 8, -8]; // trace-model's per-attempt shifts along the deck
// Validation / lift.
export const VALIDATE_CLEAR = -1;
export const VALIDATE_PENDING = -2;
export const LIFT_BLEND_M = 30;
const MIN_BLEND_M = 1e-3;

const TAU = 2 * Math.PI;
const GRID_N = 1 + (RINGS_M.length - 1) * ANGLES; // ring 0 is a single point

// Grid point j → ring index, angle index (ring 0 has one point).
function ringOf(j) { return j === 0 ? 0 : 1 + Math.floor((j - 1) / ANGLES); }
function angleOf(j) { return j === 0 ? 0 : (j - 1) % ANGLES; }

export class TraceProbe {
	constructor({ groundBelow, rayUp, obstructionBetween, raysPerFrame = 24 }) {
		this._down = groundBelow;
		this._up = rayUp;
		this._obs = obstructionBetween;
		this.raysPerFrame = raysPerFrame;
		this._phase = 'idle';           // idle | grid | axis | done
		this._profile = null;
		this._deck = new Uint8Array(GRID_N);
		this._scratch = new Float64Array(ANGLES);
		// Validation job.
		this._vTrace = null;
		this._vCursor = 0;
	}

	get busy() { return this._phase === 'grid' || this._phase === 'axis'; }
	get profile() { return this._phase === 'done' ? this._profile : null; }

	// axis: also look for a bridge deck (BRIDGE / ARCH kinds).
	start(anchor, { axis = false } = {}) {
		this._anchor = { x: anchor.x, y: anchor.y, z: anchor.z };
		this._wantAxis = !!axis;
		this._rings = RINGS_M.map((r) => ({ r, heights: new Float32Array(r === 0 ? 1 : ANGLES).fill(NaN) }));
		this._j = 0;
		this._misses = 0;
		this._rays = 0;
		this._profile = null;
		this._ax = null;
		this._axStep = 0;
		this._phase = 'grid';
	}

	cancel() { this._phase = 'idle'; this._profile = null; }

	// Spends at most `budget` rays. -> the profile once complete (and on every
	// later call, without casting), null while probing or when idle.
	step(budget = this.raysPerFrame) {
		if (this._phase === 'done') return this._profile;
		if (!this.busy) return null;
		const a = this._anchor;
		const y0 = a.y + PROBE_ABOVE_M;
		while (budget > 0 && this._phase === 'grid') {
			const j = this._j;
			const ring = this._rings[ringOf(j)];
			const k = angleOf(j);
			const th = (k / ring.heights.length) * TAU;
			const h = this._down(a.x + ring.r * Math.cos(th), y0, a.z + ring.r * Math.sin(th), PROBE_DEPTH_M);
			budget--; this._rays++;
			if (h === null || !Number.isFinite(h)) this._misses++;
			else ring.heights[k] = h;
			if (++this._j >= GRID_N) this._endGrid();
		}
		while (budget > 0 && this._phase === 'axis') {
			budget -= this._axisRay();
		}
		return this._phase === 'done' ? this._profile : null;
	}

	_endGrid() {
		let ground = Infinity, top = -Infinity;
		for (const ring of this._rings) {
			for (const h of ring.heights) {
				if (!Number.isFinite(h)) continue;
				if (h < ground) ground = h;
				if (h > top) top = h;
			}
		}
		const partial = this._misses > PARTIAL_MISS_FRAC * GRID_N || !Number.isFinite(this._rings[0].heights[0]);
		this._profile = {
			rings: this._rings,
			ground: ground === Infinity ? NaN : ground,
			top: top === -Infinity ? NaN : top,
			partial,
			misses: this._misses,
			rays: this._rays,
		};
		if (this._wantAxis && !partial && this._deckCandidate()) this._phase = 'axis';
		else this._phase = 'done';
	}

	// Deck points (≥ 4 m above their ring's floor, the median of its lower
	// half), then their principal direction. False when they are too few or
	// form a blob rather than a line.
	_deckCandidate() {
		const a = this._anchor, rings = this._rings, deck = this._deck, s = this._scratch;
		const floors = this._floors ?? (this._floors = new Float64Array(rings.length));
		for (let i = 0; i < rings.length; i++) {
			const h = rings[i].heights;
			let m = 0;
			for (let k = 0; k < h.length; k++) if (Number.isFinite(h[k])) s[m++] = h[k];
			if (m === 0) { floors[i] = NaN; continue; }
			s.subarray(0, m).sort();
			floors[i] = s[Math.floor((m - 1) / 4)];
		}
		// Ring 0 is a single point: its floor is the next ring's.
		if (rings.length > 1) floors[0] = floors[1];
		let n = 0, sx = 0, sz = 0;
		for (let j = 0; j < GRID_N; j++) {
			const i = ringOf(j), ring = rings[i], k = angleOf(j);
			const h = ring.heights[k];
			deck[j] = Number.isFinite(h) && Number.isFinite(floors[i]) && h >= floors[i] + DECK_ABOVE_M ? 1 : 0;
			if (!deck[j]) continue;
			const th = (k / ring.heights.length) * TAU;
			sx += ring.r * Math.cos(th); sz += ring.r * Math.sin(th); n++;
		}
		if (n < MIN_DECK_POINTS) return false;
		const mx = sx / n, mz = sz / n;
		let cxx = 0, czz = 0, cxz = 0;
		for (let j = 0; j < GRID_N; j++) {
			if (!deck[j]) continue;
			const ring = rings[ringOf(j)], th = (angleOf(j) / ring.heights.length) * TAU;
			const dx = ring.r * Math.cos(th) - mx, dz = ring.r * Math.sin(th) - mz;
			cxx += dx * dx; czz += dz * dz; cxz += dx * dz;
		}
		const tr = (cxx + czz) / 2, d = Math.sqrt(((cxx - czz) / 2) ** 2 + cxz * cxz);
		const l1 = tr + d, l2 = tr - d;
		if (!(l1 > 0) || l1 < AXIS_ELONGATION * Math.max(l2, 0)) return false;
		let dx, dz;
		if (Math.abs(cxz) > 1e-9) { dx = l1 - czz; dz = cxz; } else if (cxx >= czz) { dx = 1; dz = 0; } else { dx = 0; dz = 1; }
		const len = Math.hypot(dx, dz);
		const cx = a.x + mx, cz = a.z + mz;
		// The floor under the deck centre: the lowest non-deck grid point near it.
		let floor = Infinity;
		for (let j = 0; j < GRID_N; j++) {
			if (deck[j]) continue;
			const ring = rings[ringOf(j)], k = angleOf(j), h = ring.heights[k];
			if (!Number.isFinite(h)) continue;
			const th = (k / ring.heights.length) * TAU;
			if (Math.hypot(a.x + ring.r * Math.cos(th) - cx, a.z + ring.r * Math.sin(th) - cz) <= FLOOR_NEAR_M && h < floor) floor = h;
		}
		if (floor === Infinity) floor = this._profile.ground;
		this._ax = { dx: dx / len, dz: dz / len, cx, cz, floor, topY: NaN, deckY: NaN, underY: NaN };
		this._axStep = 0;
		return true;
	}

	// One ray of the axis sequence: deck surface, deck underside, floor under
	// it, then the pass itself (at the three shifts trace-model may use) must
	// be open — a long building is elongated too, but walled. -> rays spent.
	_axisRay() {
		const ax = this._ax, a = this._anchor;
		const fail = () => { this._ax = null; this._phase = 'done'; };
		const s = this._axStep++;
		if (s === 0) {
			const top = this._down(ax.cx, a.y + PROBE_ABOVE_M, ax.cz, PROBE_DEPTH_M);
			if (top === null || !(top > ax.floor + UNDER_START_M)) { fail(); return 1; }
			ax.topY = top;
			return 1;
		}
		if (s === 1) {
			const from = ax.floor + UNDER_START_M;
			const deck = this._up(ax.cx, from, ax.cz, ax.topY + 1 - from);
			if (deck === null || !Number.isFinite(deck)) { fail(); return 1; }
			ax.deckY = deck;
			return 1;
		}
		if (s === 2) {
			const under = this._down(ax.cx, ax.deckY - 0.05, ax.cz, ax.deckY - ax.floor + 50);
			if (under === null || ax.deckY - under < UNDER_MIN_CLEARANCE_M) { fail(); return 1; }
			ax.underY = under;
			return 1;
		}
		const shift = PASS_SHIFTS_M[s - 3];
		const y = ax.underY + (ax.deckY - ax.underY) / 2;
		const px = -ax.dz, pz = ax.dx;
		const cx = ax.cx + ax.dx * shift, cz = ax.cz + ax.dz * shift;
		const r = this._obs(cx - px * PASS_HALF_M, y, cz - pz * PASS_HALF_M, cx + px * PASS_HALF_M, y, cz + pz * PASS_HALF_M);
		if (!r || !r.blocked) {
			this._profile.axis = { dx: ax.dx, dz: ax.dz, deckY: ax.deckY, underY: ax.underY, topY: ax.topY, cx: ax.cx, cz: ax.cz };
			this._phase = 'done';
		} else if (s - 3 >= PASS_SHIFTS_M.length - 1) fail();
		return 1;
	}

	// One obstructionBetween per segment (i → i+1), from `fromIndex`, at most
	// `budget` per call. -> the first blocked segment's start index,
	// VALIDATE_CLEAR, or VALIDATE_PENDING (call again next frame: the cursor
	// carries on, jumping ahead if fromIndex has moved past it). A definite
	// answer ends the job: the next call starts a fresh pass.
	validate(trace, fromIndex = 0, budget = this.raysPerFrame) {
		const P = trace.points, last = P.length / 3 - 1;
		const from = Math.max(0, fromIndex | 0);
		if (this._vTrace !== trace) { this._vTrace = trace; this._vCursor = from; }
		else if (from > this._vCursor) this._vCursor = from;
		while (budget > 0 && this._vCursor < last) {
			const i = 3 * this._vCursor;
			const r = this._obs(P[i], P[i + 1], P[i + 2], P[i + 3], P[i + 4], P[i + 5]);
			budget--;
			if (r && r.blocked) { const hit = this._vCursor; this._vTrace = null; return hit; }
			this._vCursor++;
		}
		if (this._vCursor >= last) { this._vTrace = null; return VALIDATE_CLEAR; }
		return VALIDATE_PENDING;
	}

	// A collider flush changed the world: the next validate() starts afresh
	// from its fromIndex (the unflown part), whatever the cursor had passed.
	resetValidation() { this._vTrace = null; this._vCursor = 0; }

	// blockedIndex (optional): the blend ends there, so the blocked point gets
	// the full dy even when fromIndex is less than 30 m before it.
	lift(trace, fromIndex, dy, blockedIndex = null) {
		if (this._vTrace === trace) this._vTrace = null;
		liftTrace(trace, fromIndex, dy, blockedIndex === null ? LIFT_BLEND_M : liftBlend(trace, fromIndex, blockedIndex));
	}
}

// The blend length for a lift from fromIndex that must be complete at blockedIndex.
export function liftBlend(trace, fromIndex, blockedIndex) {
	const cum = trace.cum, last = cum.length - 1;
	const from = Math.min(last, Math.max(0, fromIndex | 0));
	const b = Math.min(last, Math.max(from, blockedIndex | 0));
	return Math.max(MIN_BLEND_M, Math.min(LIFT_BLEND_M, cum[b] - cum[from]));
}

// Where to start a lift so its 30 m blend ends at the blocked segment, never
// before `minIndex` (the flown part).
export function liftStart(trace, blockedIndex, minIndex = 0) {
	const cum = trace.cum;
	let i = Math.min(blockedIndex, cum.length - 1);
	const lo = Math.max(0, minIndex | 0);
	while (i > lo && cum[blockedIndex] - cum[i] < LIFT_BLEND_M) i--;
	return Math.max(i, lo);
}

// Raises points ≥ fromIndex by dy, blended in with a smoothstep over the
// first blendM metres (30 by default; the point at fromIndex does not move),
// in place; cum and length recomputed. The part before fromIndex is untouched.
export function liftTrace(trace, fromIndex, dy, blendM = LIFT_BLEND_M) {
	const P = trace.points, cum = trace.cum, n = cum.length;
	const from = Math.max(0, fromIndex | 0);
	if (from >= n || !Number.isFinite(dy) || dy === 0) return trace;
	const s0 = cum[from];
	const blend = Math.max(MIN_BLEND_M, Number.isFinite(blendM) ? blendM : LIFT_BLEND_M);
	for (let i = from; i < n; i++) {
		const t = Math.min(1, (cum[i] - s0) / blend);
		P[3 * i + 1] += dy * t * t * (3 - 2 * t);
	}
	// cum[i] only depends on the points ≤ i, and the point at fromIndex does
	// not move: recompute from the next one (cum[from] kept bit for bit).
	for (let i = from + 1; i < n; i++) {
		cum[i] = cum[i - 1] + Math.hypot(P[3 * i] - P[3 * i - 3], P[3 * i + 1] - P[3 * i - 2], P[3 * i + 2] - P[3 * i - 1]);
	}
	trace.length = cum[n - 1];
	return trace;
}

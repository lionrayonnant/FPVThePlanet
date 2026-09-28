// The trace's view of the world (issue #185, spec
// docs/superpowers/specs/2026-09-28-signals-traces-design.md): budgeted polar
// probing of the collision mesh around a signal (outer rings when the
// landmark reaches the grid's edge), the bridge deck (a square grid scored
// for a raised band over lower ground, then checked with rays: an underside,
// a gap, an open pass — up to three sites), incremental validation of a built
// trace and the lift that clears a blocked stretch.
// The rays are injected (main.js passes physics.groundBelow / rayUp /
// obstructionBetween), so tools/trace-probe-selftest.mjs runs it against a fake
// world. No THREE, no Rapier. Local ENU metres: X east, Y up, Z south.
//
// Profile (consumed by tools/trace-model.mjs buildTrace): ring i, angle k of n
// at (anchor.x + r·cos θ, anchor.z + r·sin θ), θ = 2πk/n; heights are absolute
// Y, NaN where the ray missed (the model reads it as `ground`).
//
// Nothing is allocated per ray: the grid arrays are allocated once per start()
// (the deck grid and its candidates once per TraceProbe).

export const RINGS_M = [0, 10, 20, 35, 55, 80];
export const ANGLES = 16;
export const PROBE_ABOVE_M = 300;    // down rays start this far above the anchor
export const PROBE_DEPTH_M = 1000;   // and reach this far down
export const PARTIAL_MISS_FRAC = 0.25; // more misses than this: the profile is `partial`
// Outer rings: a dive asks them always (its 45° descent's reach). `outer: true`
// asks them only when the landmark still stands at the 80 m ring; the game no
// longer does (an orbit is capped at 50 m, tools/trace-model.mjs).
export const OUTER_RINGS_M = [110, 140];
export const OUTER_ANGLES = 32;
export const OUTER_REACH_M = 11;     // a height this close under the anchor (its top 3 m + the 8 m band) reaches
// Bridge deck: a square grid of down rays, then for each grid point near the
// anchor and each axis angle, is it a deck? Heights stay at its level along
// the axis for ≥ 30 m, and both sides across it drop to a lower surface
// (water, a road) within 35 m. Candidates are then checked with rays, best
// first: a deck underside over a gap, and an open pass under it — which a long
// building (a raised band too) and an island (no underside) fail.
export const DECK_GRID_M = 5;
export const DECK_HALF_M = 60;       // the grid spans ±60 m around the anchor
export const DECK_CENTRE_M = 45;     // candidate centres this close to the anchor (an OSM point beside the deck)
export const DECK_ANGLES = 24;       // axis angles, every 7.5°
export const DECK_TOL_M = 2.5;       // along the axis: heights within this of the deck
export const DECK_ALONG_M = 60;      // scanned this far each way (a longer run tells the right angle)
export const DECK_MIN_RUN_M = 30;    // deck length seen, both ways together
export const DECK_ACROSS_M = 35;     // the lower surface within this, each side
export const DECK_LOW_M = 5;         // lower: this far under the deck
export const DECK_WALL_M = 6;        // higher than this over the deck across it: a wall, not a deck edge
export const DECK_SIDES_M = 4;       // both sides' lower surfaces agree within this (one water level)
export const DECK_CANDIDATES = 8;    // verified with rays, best first
export const DECK_SITES = 3;         // verified sites kept: one per trace attempt
export const DECK_SAME_M = 12;       // two candidates closer than this, on an angle within DECK_SAME_DEG, are one
export const DECK_SAME_DEG = 45;
// The ranking reads the deck grid (no rays) but is CPU work: spread over
// frames, whole grid points per step() until this many grid samples are spent.
// One point costs at most DECK_ANGLES × (2 edges + 2 runs) samples, so a step
// stays under RANK_SAMPLES_PER_STEP + RANK_POINT_MAX_SAMPLES.
export const RANK_SAMPLES_PER_STEP = 1000;
export const UNDER_START_M = 2;      // rayUp starts this far above the lower surface
// Water (or road) to deck underside. Real city bridges measure 6–9 m in the
// mesh (Mirabeau 6.0): 3 m either side of a line centred in the gap.
// tools/trace-model.mjs reads it from here.
export const UNDER_MIN_CLEARANCE_M = 6;
export const PASS_HALF_M = 40;       // the under-pass reach, either side of the deck
export const PASS_SHIFTS_M = [0, 8, -8]; // trace-model's per-attempt shifts along the deck
export const OVER_ALONG_M = [-12, 24]; // tier III's pass back over the deck: its reach along it (shifts ±8, drift 12)
export const OVERHEAD_ACROSS_M = 3;  // the deck overhead this far either side of the centre: a band, not a corner
export const OVERHEAD_SLACK_M = 1.5; // a shifted pass: the deck underside within this of the centre's
// Validation / lift.
export const VALIDATE_CLEAR = -1;
export const VALIDATE_PENDING = -2;
export const LIFT_BLEND_M = 30;
const MIN_BLEND_M = 1e-3;

const TAU = 2 * Math.PI;
const GRID_N = 1 + (RINGS_M.length - 1) * ANGLES; // ring 0 is a single point
const OUTER_N = OUTER_RINGS_M.length * OUTER_ANGLES;
const DECK_N = 2 * DECK_HALF_M / DECK_GRID_M + 1;   // grid points per side
export const RANK_POINT_MAX_SAMPLES = DECK_ANGLES
	* (2 * (DECK_ACROSS_M / DECK_GRID_M + 1) + 2 * (DECK_ALONG_M / DECK_GRID_M));

// Grid point j → ring index, angle index (ring 0 has one point).
function ringOf(j) { return j === 0 ? 0 : 1 + Math.floor((j - 1) / ANGLES); }
function angleOf(j) { return j === 0 ? 0 : (j - 1) % ANGLES; }

export class TraceProbe {
	constructor({ groundBelow, rayUp, obstructionBetween, raysPerFrame = 24 }) {
		this._down = groundBelow;
		this._up = rayUp;
		this._obs = obstructionBetween;
		this.raysPerFrame = raysPerFrame;
		this._phase = 'idle';           // idle | grid | outer | deck | rank | axis | done
		this._profile = null;
		this._deckH = new Float32Array(DECK_N * DECK_N);
		// Deck candidates, best first: preallocated, reused by every probe.
		this._cands = Array.from({ length: DECK_CANDIDATES }, () => ({ i: 0, j: 0, k: 0, top: 0, low: 0, score: -Infinity }));
		this._nCands = 0;
		this._rankJ = 0;                // next deck-grid point to rank
		this._samples = 0;              // deck-grid samples read (_deckAt)
		this.lastStepSamples = 0;       // of the last step(): the selftest's work bound
		// Validation job.
		this._vTrace = null;
		this._vCursor = 0;
	}

	get busy() { const f = this._phase; return f === 'grid' || f === 'outer' || f === 'deck' || f === 'rank' || f === 'axis'; }
	get profile() { return this._phase === 'done' ? this._profile : null; }

	// axis: also look for a bridge deck (BRIDGE / ARCH kinds). outer: probe
	// the outer rings when the landmark reaches the grid's edge (orbit,
	// under), or 'always' (a dive: its 45° descent needs the reach).
	start(anchor, { axis = false, outer = false } = {}) {
		this._anchor = { x: anchor.x, y: anchor.y, z: anchor.z };
		this._wantAxis = !!axis;
		this._wantOuter = outer === 'always' ? 'always' : !!outer;
		this._rings = RINGS_M.map((r) => ({ r, heights: new Float32Array(r === 0 ? 1 : ANGLES).fill(NaN) }));
		this._j = 0;
		this._misses = 0;
		this._rays = 0;
		this._profile = null;
		this._ax = null;
		this._nCands = 0;
		this._phase = 'grid';
	}

	cancel() { this._phase = 'idle'; this._profile = null; }

	// Spends at most `budget` rays. -> the profile once complete (and on every
	// later call, without casting), null while probing or when idle.
	step(budget = this.raysPerFrame) {
		if (this._phase === 'done') return this._profile;
		if (!this.busy) return null;
		const a = this._anchor;
		const s0 = this._samples;
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
		while (budget > 0 && this._phase === 'outer') {
			const j = this._j;
			const ring = this._rings[RINGS_M.length + Math.floor(j / OUTER_ANGLES)];
			const k = j % OUTER_ANGLES;
			const th = (k / OUTER_ANGLES) * TAU;
			const h = this._down(a.x + ring.r * Math.cos(th), y0, a.z + ring.r * Math.sin(th), PROBE_DEPTH_M);
			budget--; this._rays++;
			if (h !== null && Number.isFinite(h)) ring.heights[k] = h;
			if (++this._j >= OUTER_N) this._next();
		}
		// Before the deck rays: the step that casts the last of them does not
		// rank too. No rays spent.
		if (this._phase === 'rank') this._rankSome(s0 + RANK_SAMPLES_PER_STEP);
		while (budget > 0 && this._phase === 'deck') {
			const j = this._j;
			const x = a.x - DECK_HALF_M + (j % DECK_N) * DECK_GRID_M;
			const z = a.z - DECK_HALF_M + Math.floor(j / DECK_N) * DECK_GRID_M;
			const h = this._down(x, y0, z, PROBE_DEPTH_M);
			budget--; this._rays++;
			this._deckH[j] = h === null || !Number.isFinite(h) ? NaN : h;
			if (++this._j >= DECK_N * DECK_N) { this._nCands = 0; this._rankJ = 0; this._phase = 'rank'; }
		}
		while (budget > 0 && this._phase === 'axis') {
			budget -= this._axisRay();
		}
		this.lastStepSamples = this._samples - s0;
		if (this._phase !== 'done') return null;
		this._profile.rays = this._rays;
		return this._profile;
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
		this._j = 0;
		if (partial) { this._phase = 'done'; return; }
		if (this._wantOuter === 'always' || (this._wantOuter && this._reachesEdge())) {
			for (const r of OUTER_RINGS_M) this._rings.push({ r, heights: new Float32Array(OUTER_ANGLES).fill(NaN) });
			this._phase = 'outer';
			return;
		}
		this._next();
	}

	// The landmark still stands at the last ring: a height there within
	// OUTER_REACH_M under the anchor (and not over it).
	_reachesEdge() {
		const y = this._anchor.y;
		for (const h of this._rings[RINGS_M.length - 1].heights) if (h >= y - OUTER_REACH_M && h <= y) return true;
		return false;
	}

	_next() {
		this._j = 0;
		this._phase = this._wantAxis ? 'deck' : 'done';
	}

	// Bilinear height in the deck grid at (x, z) metres from the anchor; NaN
	// outside it or next to a miss.
	_deckAt(x, z) {
		const fx = (x + DECK_HALF_M) / DECK_GRID_M, fz = (z + DECK_HALF_M) / DECK_GRID_M;
		this._samples++;
		if (!(fx >= 0 && fz >= 0 && fx <= DECK_N - 1 && fz <= DECK_N - 1)) return NaN;
		const i = Math.min(DECK_N - 2, Math.floor(fx)), j = Math.min(DECK_N - 2, Math.floor(fz));
		const u = fx - i, v = fz - j, g = this._deckH, o = j * DECK_N + i;
		return (g[o] * (1 - u) + g[o + 1] * u) * (1 - v) + (g[o + DECK_N] * (1 - u) + g[o + DECK_N + 1] * u) * v;
	}

	// Every grid point within DECK_CENTRE_M × every axis angle, scored as a
	// deck; the best DECK_CANDIDATES kept (near duplicates merged). No rays.
	// Whole points, from this._rankJ, until `until` samples are reached; the
	// candidate list carries over to the next step.
	_rankSome(until) {
		const g = this._deckH;
		while (this._rankJ < DECK_N * DECK_N && this._samples < until) {
			const p = this._rankJ++;
			const i = p % DECK_N, j = (p - i) / DECK_N;
			const cx = -DECK_HALF_M + i * DECK_GRID_M, cz = -DECK_HALF_M + j * DECK_GRID_M;
			const dist = Math.hypot(cx, cz);
			if (dist > DECK_CENTRE_M) continue;
			const D = g[p];
			if (!Number.isFinite(D)) continue;
			for (let k = 0; k < DECK_ANGLES; k++) {
				const th = (k / DECK_ANGLES) * Math.PI, ux = Math.cos(th), uz = Math.sin(th);
				// The edges first: off a deck (flat ground, a roof) one of them
				// fails within a few samples, where the runs read up to 24.
				if (this._deckEdge(cx, cz, -uz, ux, D) === null) continue;
				const sDist = this._edgeS, lowA = this._edgeLow;
				if (this._deckEdge(cx, cz, uz, -ux, D) === null) continue;
				const sB = this._edgeS, lowB = this._edgeLow;
				if (Math.abs(lowA - lowB) > DECK_SIDES_M) continue;
				const run = this._deckRun(cx, cz, ux, uz, D) + this._deckRun(cx, cz, -ux, -uz, D);
				if (run < DECK_MIN_RUN_M) continue;
				// Long, narrow, centred on the deck, near the anchor.
				const score = Math.min(run, 2 * DECK_ALONG_M) - 0.5 * (sDist + sB) - 0.5 * Math.abs(sDist - sB) - 0.25 * dist;
				this._keep(i, j, k, D, Math.min(lowA, lowB), score);
			}
		}
		if (this._rankJ < DECK_N * DECK_N) return;
		this._cand = 0;
		this._axStep = 0;
		this._phase = this._nCands ? 'axis' : 'done';
	}

	// Metres of deck from (cx, cz) along (ux, uz): heights within DECK_TOL_M
	// of D, one odd sample forgiven (a lamp post, a statue).
	_deckRun(cx, cz, ux, uz, D) {
		let last = 0, bad = 0;
		for (let t = DECK_GRID_M; t <= DECK_ALONG_M; t += DECK_GRID_M) {
			const h = this._deckAt(cx + ux * t, cz + uz * t);
			if (!Number.isFinite(h)) break;
			if (Math.abs(h - D) <= DECK_TOL_M) { last = t; bad = 0; } else if (++bad >= 2) break;
		}
		return last;
	}

	// Across the deck from (cx, cz) along (px, pz): the first sample DECK_LOW_M
	// under D, confirmed by the next one (a surface, not a gutter), before any
	// wall. -> 1 (and this._edgeS, this._edgeLow), or null.
	_deckEdge(cx, cz, px, pz, D) {
		for (let s = DECK_GRID_M; s <= DECK_ACROSS_M; s += DECK_GRID_M) {
			const h = this._deckAt(cx + px * s, cz + pz * s);
			if (!Number.isFinite(h) || h > D + DECK_WALL_M) return null;
			if (h > D - DECK_LOW_M) continue;
			const h2 = this._deckAt(cx + px * (s + DECK_GRID_M), cz + pz * (s + DECK_GRID_M));
			if (!(h2 <= D - DECK_LOW_M)) return null;
			this._edgeS = s;
			this._edgeLow = Math.min(h, h2);
			return 1;
		}
		return null;
	}

	// Insert into the sorted candidate list, merging near duplicates.
	_keep(i, j, k, top, low, score) {
		const C = this._cands;
		let n = this._nCands;
		for (let q = 0; q < n; q++) {
			const c = C[q];
			const dk = Math.abs(c.k - k), dAng = Math.min(dk, DECK_ANGLES - dk) * 180 / DECK_ANGLES;
			if (dAng > DECK_SAME_DEG || Math.hypot(c.i - i, c.j - j) * DECK_GRID_M >= DECK_SAME_M) continue;
			if (c.score >= score) return;
			// The better one replaces it: remove it, then insert below.
			for (let r = q; r < n - 1; r++) { const t = C[r]; C[r] = C[r + 1]; C[r + 1] = t; }
			n--;
			break;
		}
		if (n === C.length && C[n - 1].score >= score) { this._nCands = n; return; }
		let p = Math.min(n, C.length - 1);
		const slot = C[p];
		while (p > 0 && C[p - 1].score < score) { C[p] = C[p - 1]; p--; }
		C[p] = slot;
		slot.i = i; slot.j = j; slot.k = k; slot.top = top; slot.low = low; slot.score = score;
		this._nCands = Math.min(n + 1, C.length);
	}

	// One ray of the current candidate's check: the deck underside (rayUp from
	// the lower surface), the floor under it (the gap ≥ UNDER_MIN_CLEARANCE_M),
	// the deck overhead 3 m either side of the centre (a corner has none), then
	// at each of the shifts trace-model may use, the deck overhead (off the
	// centre) and the pass itself open — a long building is a raised band too,
	// but walled. A failed
	// candidate hands over to the next. -> rays spent (0: a skipped check).
	_axisRay() {
		const a = this._anchor, c = this._cands[this._cand];
		const fail = () => {
			this._axStep = 0;
			if (++this._cand >= this._nCands) this._phase = 'done';
		};
		const cx = a.x - DECK_HALF_M + c.i * DECK_GRID_M, cz = a.z - DECK_HALF_M + c.j * DECK_GRID_M;
		const s = this._axStep++;
		if (s === 0) {
			const from = c.low + UNDER_START_M;
			const deck = this._up(cx, from, cz, c.top + 1 - from);
			if (deck === null || !Number.isFinite(deck) || deck > c.top + 1) { fail(); return 1; }
			c.deckY = deck;
			return 1;
		}
		if (s === 1) {
			const under = this._down(cx, c.deckY - 0.05, cz, c.deckY - c.low + 50);
			if (under === null || !Number.isFinite(under) || c.deckY - under < UNDER_MIN_CLEARANCE_M) { fail(); return 1; }
			c.underY = under;
			return 1;
		}
		const th = (c.k / DECK_ANGLES) * Math.PI, dx = Math.cos(th), dz = Math.sin(th);
		const px = -dz, pz = dx;
		const y = c.underY + (c.deckY - c.underY) / 2;
		if (s < 4) {
			const e = s === 2 ? OVERHEAD_ACROSS_M : -OVERHEAD_ACROSS_M;
			const over = this._up(cx + px * e, y, cz + pz * e, c.deckY - y + OVERHEAD_SLACK_M);
			if (over === null || !Number.isFinite(over)) fail();
			return 1;
		}
		const q = s - 4, shift = PASS_SHIFTS_M[q >> 1];
		const sx = cx + dx * shift, sz = cz + dz * shift;
		const last = (q >> 1) >= PASS_SHIFTS_M.length - 1;
		if ((q & 1) === 0) {
			if (shift === 0) return 0;
			const over = this._up(sx, y, sz, c.deckY - y + OVERHEAD_SLACK_M);
			if (over === null || !Number.isFinite(over)) { if (last) fail(); else this._axStep++; }
			return 1;
		}
		const r = this._obs(sx - px * PASS_HALF_M, y, sz - pz * PASS_HALF_M, sx + px * PASS_HALF_M, y, sz + pz * PASS_HALF_M);
		if (!r || !r.blocked) {
			// The open pass is where trace-model lays it. overTopY: the highest
			// surface under tier III's pass back over the deck (trees on an
			// island, a truss), from the deck grid — no ray. The next candidates
			// are checked too, up to DECK_SITES: each attempt gets its own site
			// (another span, clear of what blocked the last one).
			const site = { dx, dz, deckY: c.deckY, underY: c.underY, topY: c.top, cx: sx, cz: sz, overTopY: this._overTop(sx - a.x, sz - a.z, dx, dz, c.top) };
			const p = this._profile;
			if (!p.axes) { p.axis = site; p.axes = [site]; } else p.axes.push(site);
			if (p.axes.length >= DECK_SITES) this._phase = 'done';
			else fail();
		} else if (last) fail();
		return 1;
	}

	// The highest deck-grid height over the rectangle tier III's over-deck
	// pass may cross: PASS_HALF_M either side of the deck, OVER_ALONG_M along
	// it (the model's shifts and drift). (x, z) from the anchor.
	_overTop(x, z, dx, dz, top) {
		let m = top;
		for (let q = OVER_ALONG_M[0]; q <= OVER_ALONG_M[1]; q += DECK_GRID_M) {
			for (let e = -PASS_HALF_M; e <= PASS_HALF_M; e += DECK_GRID_M) {
				const h = this._deckAt(x + dx * q - dz * e, z + dz * q + dx * e);
				if (h > m) m = h;
			}
		}
		return m;
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

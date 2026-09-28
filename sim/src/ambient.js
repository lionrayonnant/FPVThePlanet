// Ambient drones (issue #250) — the PURE model. No Three, no Rapier, no DOM:
// rays are injected functions ({ groundBelow, obstructionBetween }, duck-typed
// like src/entry-state.js), the rendering lives in src/drone-mesh.js and the
// sound in src/ambient-audio.js.
//
// This file holds: the set (who flies), the routines (how each family flies),
// the curves (where), the bubble (around whom), the anchors and their
// validation, the attitude (how the body holds itself). Everything is
// deterministic on the scan's seed, and update() allocates nothing.
//
// Validation works on TWO grids, and that is deliberate: the ground is
// measured fine (HEIGHT_SAMPLES), walls are tested coarse (SAMPLES). The why
// is above the two constants.

import { generateTargetScan } from '../tools/target-model.mjs';
import {
	G, TILT_MAX_DEG, ATTITUDE_TAU, rngFrom, attitudeFrom, clampTilt, tiltOf, lateralAccelMax,
} from './drone-kinematics.js';

export { G, TILT_MAX_DEG, ATTITUDE_TAU, rngFrom, attitudeFrom, clampTilt, tiltOf, lateralAccelMax };

export const MAX_DRONES = 4;
// The swarm unit (issue #29): a 3" recon quad, never flown by the player, so it
// has no entry in PROFILES and no PID. As an ambient it needs a routine, which
// ROUTINES carries below.
export const SWARM_UNIT_FAMILY = 'swarmUnit';
// Its RECIPE now exists (src/drone-shape.js, RECIPE_PROFILES), so the lone
// ambient looks like a swarm unit — see `shapeFamily` below. Its BUILD still
// borrows the closest existing airframe, a 3" micro: swarmUnit is deliberately
// absent from PROFILES (no PID, no tune, never flown), and targetBuild() needs
// a real family to draw an instance's mass, drag and rates from.
export const SWARM_UNIT_BUILD_FAMILY = 'toothpick';
// v²/r ≤ TURN_MARGIN · a_max: a quad does not turn at the limit of its thrust.
export const TURN_MARGIN = 0.6;

const lerp = (rand, [a, b]) => a + rand() * (b - a);

// The candidates not taken, with the individual seed resolveTarget() would
// have given them. Pure and deterministic: the same scan renders the same sky.
export function ambientSet(scan) {
	// The swarm keys travel with the scan (issue #29) so the regeneration is
	// exact. Absent, they mean no cluster — a v2 session or a dev scan predates
	// swarms, and a redraw on today's default chance would invent one.
	// `families` (issue #185, clearance) does the same job for the draw pool:
	// absent means the full pool — an older session or a dev scan predates
	// clearance, and a redraw on today's operator clearance could draw a
	// family the flight never had a chance to show.
	const { candidates } = generateTargetScan({
		seed: scan.seed, count: scan.count,
		swarmChance: scan.swarmChance ?? 0,
		swarmAt: scan.swarmAt ?? null,
		families: scan.families,
	});
	const out = [];
	for (let i = 0; i < candidates.length; i++) {
		if (i === scan.index) continue;
		const c = candidates[i];
		// A cluster the player did NOT take flies as a SINGLE swarmUnit on an
		// ordinary routine, not as a flock of twelve in the distance — that would
		// be a second system. You see the machine you let go, alone.
		const swarm = !!c._swarm;
		out.push({
			i, id: c.id, family: swarm ? SWARM_UNIT_FAMILY : c._family,
			// The airframe the BUILD comes from. Same as the routine family for
			// everything else; see SWARM_UNIT_BUILD_FAMILY.
			buildFamily: swarm ? SWARM_UNIT_BUILD_FAMILY : c._family,
			// The airframe the MESH comes from — its own, now that the recipe
			// exists. This is the only place the two differ.
			shapeFamily: swarm ? SWARM_UNIT_FAMILY : c._family,
			buildSeed: `${scan.seed}::${i}`,
			rssiDbm: c.rssiDbm, mode: c._videoHint,
		});
		if (out.length === MAX_DRONES) break;
	}
	return out;
}

// One routine per family. Ranges chosen by pilot's ear, like the entry
// state's RANGES; it is the net (validation) that makes every draw right,
// not the range. Long range's `radius` = the half-turn's radius.
export const ROUTINES = {
	race5: { kind: 'loop', agl: [3, 10], speed: [15, 22], radius: [12, 20] },
	freestyle5: { kind: 'eight', agl: [10, 40], speed: [12, 18], radius: [18, 28], vertical: 8 },
	heavy5: { kind: 'eight', agl: [10, 30], speed: [9, 14], radius: [22, 30], vertical: 0 },
	cinewhoop: { kind: 'orbit', agl: [15, 30], speed: [3, 6], radius: [10, 25], faceAnchor: true },
	longrange: { kind: 'cruise', agl: [60, 120], speed: [18, 26], radius: [120, 120], leg: 400 },
	toothpick: { kind: 'orbit', agl: [1, 5], speed: [2, 5], radius: [4, 8], jitter: true },
	// The unit of a cluster nobody took (issue #29). Fast low orbit: a recon
	// machine holding a pattern, not a drone-show quad drifting.
	swarmUnit: { kind: 'orbit', agl: [5, 25], speed: [12, 20], radius: [15, 25] },
};

export function routineFor({ family, twr, rand }) {
	const spec = ROUTINES[family];
	if (!spec) throw new Error(`family with no routine: ${family}`);
	const radius = lerp(rand, spec.radius);
	const agl = lerp(rand, spec.agl);
	let speed = lerp(rand, spec.speed);
	// The TWR bounds the turn, and g·tan(TILT_MAX) bounds it again: this second
	// ceiling does not GUARANTEE the tilt (attitudeFrom is what imposes it,
	// vertical included), it keeps the drawn speeds within a quad's domain —
	// a 20 m radius is not taken at 40 m/s.
	const vMax = Math.sqrt(Math.min(TURN_MARGIN * lateralAccelMax(twr), G * Math.tan(TILT_MAX_DEG * Math.PI / 180)) * radius);
	if (speed > vMax) speed = vMax;
	const dir = rand() < 0.5 ? -1 : 1;
	const phase = rand() * Math.PI * 2;
	// The race's loop plane: tilted 10 to 35° so the loop is not a flat
	// circle — a race gains height coming out of the turn.
	const tiltPlane = spec.kind === 'loop' ? (10 + rand() * 25) * Math.PI / 180 : 0;
	// Lemniscate of Gerono (the eight): not at constant speed in w — it is
	// reparametrised by arc length. 64 segments, cumulative lengths in
	// arc[1..64], arc[0] = 0; the period is the path's TRUE length / speed
	// (not the "two circle turns" approximation) so that |v| ≈ speed holds.
	// arcSlope[k] = dw/ds at node k (1/|dp/dw|): the s → w inversion is done
	// in cubic Hermite (C1) on each segment, not linear (C0 only), otherwise
	// every node breaks w(t)'s derivative and the acceleration spikes there.
	// arc[] is integrated by Simpson (not by chord): a chord underestimates
	// the true arc length where curvature is strongest, which makes it
	// inconsistent with arcSlope's ANALYTICAL slope — Hermite then has to
	// "catch up" the gap mid-segment and the speed there overshoots the
	// target by 25+% (measured) whatever the derivation step. Simpson (one
	// midpoint per segment, the same speedW function as arcSlope) renders
	// arc[] faithful to the true length: see the report for the numbers.
	let arc = null, arcSlope = null;
	if (spec.kind === 'eight') {
		arc = new Float64Array(65);
		arcSlope = new Float64Array(65);
		const V = spec.vertical ?? 0;
		const speedW = (w) => {
			const dxdw = -2 * radius * Math.sin(w);
			const dzdw = 2 * radius * Math.cos(2 * w);
			const dydw = 2 * V * Math.cos(2 * w + 1);
			return Math.hypot(dxdw, dzdw, dydw);
		};
		arcSlope[0] = 1 / speedW(0);
		for (let k = 1; k <= 64; k++) {
			const w0 = (Math.PI * 2 * (k - 1)) / 64, w1 = (Math.PI * 2 * k) / 64, wm = (w0 + w1) / 2;
			const dw = w1 - w0;
			arc[k] = arc[k - 1] + (dw / 6) * (speedW(w0) + 4 * speedW(wm) + speedW(w1));
			arcSlope[k] = 1 / speedW(w1);
		}
	}
	let period;
	if (spec.kind === 'cruise') period = (2 * spec.leg + Math.PI * radius) / speed;
	else if (spec.kind === 'eight') period = arc[64] / speed;
	else period = (2 * Math.PI * radius) / speed;
	// The micro's jitter: the nominal frequencies (Hz) are rounded to the
	// nearest whole number of harmonics over the routine's period, otherwise
	// curveLocal(0) ≠ curveLocal(period) (the jitter would not loop with the
	// rest). amp at 0.3, the spec value (#262): differentiated at the
	// simulation step (1/60 s), the jitter's derivative (up to 2.1 Hz) would
	// dominate the differentiated speed — which is why it had stayed at 0.15.
	// derive() now widens its differentiation window for any jittered routine
	// (VEL_SMOOTH_H): position itself stays exact, only vel/acc see the
	// jitter attenuated.
	const jitter = spec.jitter
		? [0.7, 1.3, 2.1].map((hz) => ({
			amp: 0.3,
			nx: Math.max(1, Math.round(hz * period)),
			nz: Math.max(1, Math.round(hz * period * 0.7)),
			phase: rand() * Math.PI * 2,
		}))
		: [];
	return {
		kind: spec.kind, family, aglMin: spec.agl[0], agl, speed, radius, dir, phase,
		tiltPlane, vertical: spec.vertical ?? 0, leg: spec.leg ?? 0,
		faceAnchor: !!spec.faceAnchor, jitter, period, arc, arcSlope,
	};
}

// Two grids, two jobs.
//
// SAMPLES: the number of SEGMENTS obstruction is tested on. A segment is a
// chord, `obstructionBetween` crosses it with a ray: densifying it reveals
// nothing new, it replays the same wall.
//
// HEIGHT_SAMPLES: the number of GROUND RAYS in the height profile. The
// ground, unlike a wall, is not a chord: it is a continuous sheet under the
// curve, and between two nodes it can rise without ever crossing the
// segment. At 16 nodes, two neighbouring rays are 22 m apart on an eight and
// 74 m apart on a cruise (400 m leg) — measured on `havre`
// (tools/selftest.mjs): a +37 m building was hiding between two nodes under
// a long range (real AGL 45.8 m for a 60 m floor), and a heavy5 passed 1.06 m
// from a quay for a 10 m floor. The wall rule could see none of it — the
// curve passes ABOVE the roof, no segment crosses it. 64 rays bring the
// step down to 5.5 m (eight) / 18 m (cruise), under a building's size.
export const SAMPLES = 16;
export const HEIGHT_SAMPLES = 64;
const TWO_PI = Math.PI * 2;

// Offset relative to the anchor, at instant t, in the routine's plane. `y` is
// the VERTICAL offset of the figure alone (the race's tilted plane, the
// eight's sine, the micro's jitter) — AGL and terrain are added by
// curveAt(). Non-negative for the loop and the eight: the figure climbs out
// of the turn, it never dives under the AGL drawn for the routine.
export function curveLocal(r, t, out) {
	const u = (t / r.period) * TWO_PI * r.dir + r.phase;
	switch (r.kind) {
		case 'loop': {
			out.x = r.radius * Math.cos(u);
			out.z = r.radius * Math.sin(u);
			// Tilted plane: height follows one of the two components, never
			// negative — the race climbs out of the turn, it does not dive
			// under its AGL.
			out.y = Math.sin(r.tiltPlane) * r.radius * (1 + Math.sin(u));
			break;
		}
		case 'orbit': {
			out.x = r.radius * Math.cos(u);
			out.z = r.radius * Math.sin(u);
			out.y = 0;
			break;
		}
		case 'eight': {
			// Lemniscate of Gerono, two lobes of radius ~r, reparametrised by
			// arc length (r.arc, precomputed in routineFor) for a constant
			// speed: w does not advance linearly with t, but with the length
			// already travelled, recovered by interpolation in arc[].
			// s → w inversion in cubic Hermite (C1, value AND slope dw/ds
			// matched at every node) — a linear interpolation of w would be C0
			// only and would spike the acceleration at every node (64 spikes
			// per lap), see r.arcSlope in routineFor.
			const frac = (((t / r.period) * r.dir + r.phase / (Math.PI * 2)) % 1 + 1) % 1;
			const target = frac * r.arc[64];
			let k = 0;
			while (k < 64 && r.arc[k + 1] < target) k++;
			if (k >= 64) k = 63;
			const s0 = r.arc[k], s1 = r.arc[k + 1];
			const segLen = s1 - s0;
			const tau = segLen > 1e-9 ? (target - s0) / segLen : 0;
			const w0 = (Math.PI * 2 * k) / 64, w1 = (Math.PI * 2 * (k + 1)) / 64;
			const m0 = r.arcSlope[k] * segLen, m1 = r.arcSlope[k + 1] * segLen;
			const tau2 = tau * tau, tau3 = tau2 * tau;
			const h00 = 2 * tau3 - 3 * tau2 + 1;
			const h10 = tau3 - 2 * tau2 + tau;
			const h01 = -2 * tau3 + 3 * tau2;
			const h11 = tau3 - tau2;
			const w = h00 * w0 + h10 * m0 + h01 * w1 + h11 * m1;
			out.x = 2 * r.radius * Math.cos(w);
			out.z = r.radius * Math.sin(2 * w);
			// Never negative, same reason as the loop.
			out.y = r.vertical * (1 + Math.sin(w * 2 + 1));
			break;
		}
		case 'cruise': {
			// Stadium shape: two `leg` segments, two half-turns of radius `radius`.
			const L = r.leg, R = r.radius;
			const total = 2 * L + Math.PI * R;
			let s = ((t * r.speed * r.dir) % total + total) % total;
			out.y = 0;
			if (s < L) { out.x = -L / 2 + s; out.z = -R / 2; }
			else if (s < L + Math.PI * R / 2) {
				// Half-turn of radius R/2: a goes from 0 to π over the whole arc
				// budget (piR/2), so da/ds = 2/R, not 1/R.
				const a = 2 * (s - L) / R;
				out.x = L / 2 + R / 2 * Math.sin(a); out.z = -R / 2 + R / 2 * (1 - Math.cos(a));
			} else if (s < 2 * L + Math.PI * R / 2) { s -= L + Math.PI * R / 2; out.x = L / 2 - s; out.z = R / 2; }
			else {
				const a = 2 * (s - 2 * L - Math.PI * R / 2) / R;
				out.x = -L / 2 - R / 2 * Math.sin(a); out.z = R / 2 - R / 2 * (1 - Math.cos(a));
			}
			break;
		}
		default: throw new Error(`unknown routine: ${r.kind}`);
	}
	for (let k = 0; k < r.jitter.length; k++) {
		const j = r.jitter[k];
		// Whole-number harmonics of the period (j.nx, j.nz precomputed in
		// routineFor): the jitter loops exactly with the rest of the figure.
		const ux = (t / r.period) * TWO_PI * j.nx + j.phase;
		const uz = (t / r.period) * TWO_PI * j.nz + j.phase;
		const s = Math.sin(ux);
		out.x += j.amp * s; out.z += j.amp * Math.cos(uz); out.y += j.amp * 0.5 * s;
	}
	return out;
}

const _c = { x: 0, y: 0, z: 0 };

// Absolute height of the curve at each of the HEIGHT_SAMPLES samples: ground
// + agl. `groundBelow(x, z)` renders the ground's height or null (no
// terrain). `heights` is HEIGHT_SAMPLES long.
export function curveHeights(r, anchor, groundBelow, heights) {
	for (let i = 0; i < HEIGHT_SAMPLES; i++) {
		curveLocal(r, r.period * i / HEIGHT_SAMPLES, _c);
		const g = groundBelow(anchor.x + _c.x, anchor.z + _c.z);
		if (g == null) return false;
		heights[i] = g + r.agl;
	}
	return true;
}

// Absolute position: the curve's XZ, Y interpolated between the sampled
// heights (the micro hugs the terrain) plus the figure's offset.
export function curveAt(r, anchor, heights, t, out) {
	curveLocal(r, t, out);
	const f = ((t / r.period) % 1 + 1) % 1 * HEIGHT_SAMPLES;
	const i = Math.floor(f) % HEIGHT_SAMPLES, j = (i + 1) % HEIGHT_SAMPLES, a = f - Math.floor(f);
	const y = heights[i] * (1 - a) + heights[j] * a;
	out.x += anchor.x; out.z += anchor.z; out.y += y;
	return out;
}

const _pm = { x: 0, y: 0, z: 0 }, _pp = { x: 0, y: 0, z: 0 };

// #262: widened differentiation window for vel/acc of a jittered routine
// (never for pos, which stays sampled exactly at `t`). A centred difference
// at the simulation step (1/60 s) follows the jitter's derivative (up to
// 2.1 Hz) almost without attenuating it: sin(wh)/h ≈ w. At VEL_SMOOTH_H,
// sin(wh)/(wh) ≈ 0.5 for the highest harmonic — the same attenuation that
// exactly compensates the amplitude's doubling from 0.15 to 0.3 (spec).
// Routines with no jitter (period much slower than the jitter) see almost no
// difference at this window.
const VEL_SMOOTH_H = 0.15;

// Position, velocity and acceleration by centred differences of step h
// (vel/acc widen this step to VEL_SMOOTH_H on a jittered routine — see above).
export function derive(r, anchor, heights, t, h, pos, vel, acc) {
	curveAt(r, anchor, heights, t, pos);
	const hv = r.jitter.length > 0 ? Math.max(h, VEL_SMOOTH_H) : h;
	curveAt(r, anchor, heights, t - hv, _pm);
	curveAt(r, anchor, heights, t + hv, _pp);
	vel.x = (_pp.x - _pm.x) / (2 * hv); vel.y = (_pp.y - _pm.y) / (2 * hv); vel.z = (_pp.z - _pm.z) / (2 * hv);
	acc.x = (_pp.x - 2 * pos.x + _pm.x) / (hv * hv);
	acc.y = (_pp.y - 2 * pos.y + _pm.y) / (hv * hv);
	acc.z = (_pp.z - 2 * pos.z + _pm.z) / (hv * hv);
}

export const R_SPAWN = [120, 250];
export const R_LEAVE = 320;
export const R_LEAVE_GAP = 70;      // rLeave = rMax + gap when the ring tightens
export const IN_VIEW_MIN_M = 220;   // in the field of view, only spawns beyond this
export const VIEW_MARGIN_DEG = 15;
export const BLOCK_SPAN_M = 2;      // geometrySafe's rule: a wall, not a grazed roof
export const FLOOR_MARGIN_M = 5;    // above the fence's FLOOR_HOLD
const SPAWN_TRIES_PER_FRAME = 3;
// A slot that fails in a loop goes to sleep: after SPAWN_FAILS_BEFORE_BACKOFF
// consecutive failed tries, it is not retried for SPAWN_BACKOFF_S. The sky is
// an ambience, not an emergency — a one-second delay on a spawn is not seen,
// three rays a frame are paid for.
const SPAWN_FAILS_BEFORE_BACKOFF = 10;
const SPAWN_BACKOFF_S = 1;
// Fixed differentiation step: attitude must not depend on the refresh rate.
const DERIVE_H = 1 / 60;
// Initial attitude at spawn: no wind (see spawnOne).
const NO_WIND = { x: 0, y: 0, z: 0 };

// The ring, bounded by the fence. Rect: `halfMin - hold`; direct: the trusted
// radius (180 m by default, under the nominal 250). A map that cannot hold
// the minimal ring keeps its drones forever.
// `out`, if given, is mutated and rendered (update() passes it its scratch:
// zero allocation per frame). With no `out`, allocates a literal (the tests'
// path).
export function bubbleFor(bounds, player, out) {
	const o = out || { rMin: 0, rMax: 0, rLeave: 0 };
	let rMax = R_SPAWN[1];
	if (bounds.bbox) {
		const halfMin = Math.min(
			(bounds.bbox.max[0] - bounds.bbox.min[0]) / 2,
			(bounds.bbox.max[2] - bounds.bbox.min[2]) / 2,
		);
		rMax = Math.min(rMax, halfMin - bounds.corridor.hold);
	} else {
		rMax = Math.min(rMax, bounds.trusted);
	}
	if (rMax < R_SPAWN[0]) { o.rMin = 0; o.rMax = Math.max(rMax, 10); o.rLeave = Infinity; return o; }
	o.rMin = R_SPAWN[0]; o.rMax = rMax; o.rLeave = rMax < R_SPAWN[1] ? rMax + R_LEAVE_GAP : R_LEAVE;
	return o;
}

// Does a point hold inside the fence, with `margin` (the routine's radius) added?
export function insideBounds(bounds, x, z, y, margin) {
	if (bounds.bbox) {
		const b = bounds.bbox;
		const m = bounds.corridor.hold + margin;
		return x >= b.min[0] + m && x <= b.max[0] - m
			&& z >= b.min[2] + m && z <= b.max[2] - m
			&& y >= b.min[1] + FLOOR_MARGIN_M;
	}
	if (!bounds.center) return false;
	return Math.hypot(x - bounds.center.x, z - bounds.center.z) + margin <= bounds.trusted;
}

// Outside the camera cone (FOV + margin)?
export function outOfView(dx, dz, dy, cam, fovDeg) {
	const d = Math.hypot(dx, dy, dz);
	if (d === 0) return false;
	const cosA = (dx * cam.fx + dy * cam.fy + dz * cam.fz) / d;
	return cosA < Math.cos((fovDeg / 2 + VIEW_MARGIN_DEG) * Math.PI / 180);
}

// An anchor in the ring, out of view, inside the fence, on the ground. ONE
// ray at most. `top`/`span`: from where and over what length to cast
// downward (bbox top + 50 and height + 100, like the entry state's
// groundAt). The floor is checked at FLIGHT height (ground + agl): the
// anchor itself stays on the ground (`y = g`), only the fence is tested at
// `g + agl`.
//
// The ORDER of the tests is half the work. The HORIZONTAL fence depends on
// no height: it is sliced before the ray, for free. A slot that CANNOT spawn
// here (a long range needs 320 m of margin on a map that offers 80) is thus
// rejected without casting a single ray, instead of three a frame forever.
//
// The view cone, on the other hand, comes AFTER the ray: it is measured at
// FLIGHT height (g + agl), not the anchor's height on the ground — a long
// range at 90 m AGL judged "hidden" because its anchor is low would spawn in
// plain view. That test therefore costs its ray; it is the price of a
// correct answer.
//
// `bubble`, if given, avoids recomputing the ring on every try (and the
// literal object that came with it).
export function pickAnchor({ rand, player, cam, fovDeg, bounds, radius, rays, top, span, agl, stats, bubble }) {
	const { rMin, rMax } = bubble || bubbleFor(bounds, player);
	const d = rMin + rand() * (rMax - rMin);
	const a = rand() * TWO_PI;
	const x = player.x + d * Math.cos(a), z = player.z + d * Math.sin(a);
	// Horizontal fence alone: y = +∞ always passes the floor rule.
	if (!insideBounds(bounds, x, z, Infinity, radius)) return null;
	if (stats) stats.raysCast++;
	const g = rays.groundBelow(x, top, z, span);
	if (g == null) return null;
	const y = g;
	if (!insideBounds(bounds, x, z, y + agl, radius)) return null;
	if (d < IN_VIEW_MIN_M && !outOfView(x - player.x, z - player.z, (y + agl) - player.y, cam, fovDeg)) return null;
	return { x, y, z };
}

const _a = { x: 0, y: 0, z: 0 }, _b = { x: 0, y: 0, z: 0 };

// The floor at fine sample i, on the FINE grid: this is where the terrain
// used to hide. Reads heights[i-1..i+1] (curveAt may land a hair below node
// i), all known once ray i+1 has been cast.
function floorHolds(routine, anchor, heights, i) {
	// The figure can dip under the drawn AGL (sine, tilted plane): it is
	// the family's MINIMUM AGL that matters, at the lowest point.
	curveAt(routine, anchor, heights, routine.period * i / HEIGHT_SAMPLES, _a);
	// At sample i exactly, heights[i] IS the ground under _a (the profile
	// put it there): `_a.y - (heights[i] - agl)` therefore always lands
	// exactly on `curveLocal.y + agl`, whatever the terrain — a tautology
	// that would never see a point under the terrain. It is instead
	// compared to the worse of the two neighbouring grounds (i and i+1):
	// if the terrain rises sharply between the two, that is where it
	// (where the curve interpolates linearly) grazes.
	const j = (i + 1) % HEIGHT_SAMPLES;
	const g = Math.max(heights[i], heights[j]) - routine.agl;
	return !(_a.y - g < routine.aglMin);
}

// 64 rays downward (the ground profile, and the floor tested on it), then 16
// obstructions between neighbouring segments. The two grids are deliberately
// different — see SAMPLES / HEIGHT_SAMPLES above.
//
// The floor is tested WHILE the profile is cast, not after it: sample i needs
// the ground at i and i+1 only (curveAt interpolates between neighbours), so
// it is judged as soon as ray i+1 lands, and a curve that fails at node 3
// stops at 5 rays instead of 64. Same verdict, same rays in the same order up
// to the failure — only the ones after it are no longer cast. That is the whole
// cost in LIVE: a slot that cannot spawn (a long range over the city) fails on
// the floor, near the first nodes, ~10 times a second before its backoff.
export function validateCurve({ routine, anchor, rays, heights, top, span, stats }) {
	for (let i = 0; i < HEIGHT_SAMPLES; i++) {
		curveLocal(routine, routine.period * i / HEIGHT_SAMPLES, _c);
		if (stats) stats.raysCast++;
		const g = rays.groundBelow(anchor.x + _c.x, top, anchor.z + _c.z, span);
		if (g == null) return false;
		heights[i] = g + routine.agl;
		if (i > 0 && !floorHolds(routine, anchor, heights, i - 1)) return false;
	}
	if (!floorHolds(routine, anchor, heights, HEIGHT_SAMPLES - 1)) return false;
	// The walls, on the COARSE grid: a segment is a chord, densifying it
	// would replay the same ray on the same geometry.
	for (let i = 0; i < SAMPLES; i++) {
		curveAt(routine, anchor, heights, routine.period * i / SAMPLES, _a);
		curveAt(routine, anchor, heights, routine.period * (i + 1) / SAMPLES, _b);
		if (stats) stats.raysCast += 2;
		const o = rays.obstructionBetween(_a.x, _a.y, _a.z, _b.x, _b.y, _b.z);
		if (o.blocked && o.span > BLOCK_SPAN_M) return false;
	}
	return true;
}

export class AmbientModel {
	constructor({ set, builds, bounds, seed }) {
		if (set.length > MAX_DRONES) throw new Error('too many ambients');
		this.set = set;
		this.builds = builds;
		this.bounds = bounds;
		this.seed = seed;
		this.families = set.map((d) => d.family);
		this.n = set.length;
		// One slot per possible ambient; `alive[k]` says whether it flies.
		this.alive = new Uint8Array(MAX_DRONES);
		this.pos = new Float64Array(3 * MAX_DRONES);
		this.vel = new Float64Array(3 * MAX_DRONES);
		this.acc = new Float64Array(3 * MAX_DRONES);
		this.quat = new Float64Array(4 * MAX_DRONES);
		this.anchors = new Float64Array(3 * MAX_DRONES);
		this.heights = Array.from({ length: MAX_DRONES }, () => new Float64Array(HEIGHT_SAMPLES));
		this.routines = new Array(MAX_DRONES).fill(null);
		this.t = new Float64Array(MAX_DRONES);
		this.stats = { relocations: 0, raysCast: 0, spawnFailures: 0 };
		this._pos = { x: 0, y: 0, z: 0 }; this._vel = { x: 0, y: 0, z: 0 }; this._acc = { x: 0, y: 0, z: 0 };
		this._anchor = { x: 0, y: 0, z: 0 };
		this._att = { ax: 0, ay: 0, az: 0, vx: 0, vy: 0, vz: 0, wind: null, drag: null, mass: 1, yawX: 0, yawZ: -1 };
		this._q = new Float64Array(4);
		this._bubble = { rMin: 0, rMax: 0, rLeave: 0 };
		this._spawnArgs = { player: null, cam: null, fovDeg: 0, rays: null, top: 0, span: 0, bubble: this._bubble };
		// Sleep for slots that fail: a count of consecutive failures and a
		// date (the model's clock, accumulated from dt) before which it is
		// not retried.
		this._clock = 0;
		this._fails = new Uint8Array(MAX_DRONES);
		this._retryAt = new Float64Array(MAX_DRONES);
		// The slot spawnOne() starts its sweep from. It ROTATES — see
		// spawnOne().
		this._spawnCursor = 0;
		this.reset();
	}

	get count() { let c = 0; for (let k = 0; k < this.n; k++) c += this.alive[k]; return c; }

	reset() {
		this.alive.fill(0);
		this.t.fill(0);
		this._spawnCursor = 0;
		this._clock = 0;
		this._fails.fill(0);
		this._retryAt.fill(0);
		this.rand = rngFrom(`${this.seed}::ambient`);
		for (let k = 0; k < this.n; k++) {
			this.routines[k] = routineFor({
				family: this.set[k].family, twr: this.builds[k].spec.twr,
				rand: rngFrom(`${this.set[k].buildSeed}::ambient::routine`),
			});
			this.quat[4 * k + 3] = 1;
		}
	}

	// Spawns ONE dead slot — one only per frame, whether it succeeds or not.
	// The sweep starts at `_spawnCursor`, which advances after every slot
	// TRIED: without this rotation, the first dead slot was always the same
	// one, and an impossible slot froze the whole sky behind it. That is
	// exactly what used to happen to a long range (radius leg/2 + radius =
	// 320 m) on a map that cannot hold it: 0 spawns out of 4, forever.
	// Renders true if a drone was born.
	spawnOne({ player, cam, fovDeg, rays, top, span, bubble }) {
		const bb = bubble || bubbleFor(this.bounds, player, this._bubble);
		for (let j = 0; j < this.n; j++) {
			const k = (this._spawnCursor + j) % this.n;
			if (this.alive[k]) continue;
			// Asleep: move to the next one without spending the frame's try.
			if (this._retryAt[k] > this._clock) continue;
			this._spawnCursor = (k + 1) % this.n;
			const r = this.routines[k];
			const radius = r.kind === 'cruise' ? r.leg / 2 + r.radius : r.kind === 'eight' ? 2 * r.radius : r.radius;
			for (let tries = 0; tries < SPAWN_TRIES_PER_FRAME; tries++) {
				const a = pickAnchor({ rand: this.rand, player, cam, fovDeg, bounds: this.bounds, radius, rays, top, span, agl: r.agl, stats: this.stats, bubble: bb });
				if (!a) { this._fail(k); continue; }
				if (!validateCurve({ routine: r, anchor: a, rays, heights: this.heights[k], top, span, stats: this.stats })) {
					this._fail(k); continue;
				}
				this.anchors[3 * k] = a.x; this.anchors[3 * k + 1] = a.y; this.anchors[3 * k + 2] = a.z;
				this.t[k] = this.rand() * r.period;
				this.alive[k] = 1;
				this._fails[k] = 0; this._retryAt[k] = 0;
				this._place(k, DERIVE_H);
				this._attitude(k, 10, NO_WIND);
				return true;
			}
			return false;   // one slot per frame, whether it succeeds or not
		}
		return false;
	}

	_fail(k) {
		this.stats.spawnFailures++;
		if (++this._fails[k] >= SPAWN_FAILS_BEFORE_BACKOFF) {
			this._fails[k] = 0;
			this._retryAt[k] = this._clock + SPAWN_BACKOFF_S;
		}
	}

	_place(k, h) {
		const r = this.routines[k];
		this._anchor.x = this.anchors[3 * k]; this._anchor.y = this.anchors[3 * k + 1]; this._anchor.z = this.anchors[3 * k + 2];
		derive(r, this._anchor, this.heights[k], this.t[k], h, this._pos, this._vel, this._acc);
		this.pos[3 * k] = this._pos.x; this.pos[3 * k + 1] = this._pos.y; this.pos[3 * k + 2] = this._pos.z;
		this.vel[3 * k] = this._vel.x; this.vel[3 * k + 1] = this._vel.y; this.vel[3 * k + 2] = this._vel.z;
		this.acc[3 * k] = this._acc.x; this.acc[3 * k + 1] = this._acc.y; this.acc[3 * k + 2] = this._acc.z;
	}

	update({ dt, player, cam, fovDeg, rays, top, span, wind }) {
		if (dt <= 0) return;
		this._clock += dt;
		bubbleFor(this.bounds, player, this._bubble);
		const rLeave = this._bubble.rLeave;
		// Departures: the anchor has left the bubble.
		for (let k = 0; k < this.n; k++) {
			if (!this.alive[k]) continue;
			const d = Math.hypot(this.anchors[3 * k] - player.x, this.anchors[3 * k + 2] - player.z);
			if (d > rLeave) { this.alive[k] = 0; this.stats.relocations++; }
		}
		// One spawn at most per frame. Args in a reused scratch: no literal
		// allocated here, even when every slot is already flying.
		const sa = this._spawnArgs;
		sa.player = player; sa.cam = cam; sa.fovDeg = fovDeg; sa.rays = rays; sa.top = top; sa.span = span;
		this.spawnOne(sa);
		// Advance and place. Fixed step (DERIVE_H): attitude does not depend
		// on the real dt.
		for (let k = 0; k < this.n; k++) {
			if (!this.alive[k]) continue;
			this.t[k] += dt;
			this._place(k, DERIVE_H);
			this._attitude(k, dt, wind);
		}
	}

	_attitude(k, dt, wind) {
		const r = this.routines[k];
		const b = this.builds[k].profile;
		let yawX = this.vel[3 * k], yawZ = this.vel[3 * k + 2];
		if (r.faceAnchor) { yawX = this.anchors[3 * k] - this.pos[3 * k]; yawZ = this.anchors[3 * k + 2] - this.pos[3 * k + 2]; }
		if (Math.hypot(yawX, yawZ) < 1e-6) { yawX = 0; yawZ = -1; }
		this._att.ax = this.acc[3 * k]; this._att.ay = this.acc[3 * k + 1]; this._att.az = this.acc[3 * k + 2];
		this._att.vx = this.vel[3 * k]; this._att.vy = this.vel[3 * k + 1]; this._att.vz = this.vel[3 * k + 2];
		this._att.wind = wind; this._att.drag = b.bodyDrag; this._att.mass = b.mass;
		this._att.yawX = yawX; this._att.yawZ = yawZ;
		attitudeFrom(this._att, this._q, 0);
		// Exponential smoothing (nlerp): segment changes do not jump.
		const o = 4 * k, a = 1 - Math.exp(-dt / ATTITUDE_TAU);
		let d = this.quat[o] * this._q[0] + this.quat[o + 1] * this._q[1] + this.quat[o + 2] * this._q[2] + this.quat[o + 3] * this._q[3];
		const sgn = d < 0 ? -1 : 1;
		let nx = this.quat[o] + a * (sgn * this._q[0] - this.quat[o]);
		let ny = this.quat[o + 1] + a * (sgn * this._q[1] - this.quat[o + 1]);
		let nz = this.quat[o + 2] + a * (sgn * this._q[2] - this.quat[o + 2]);
		let nw = this.quat[o + 3] + a * (sgn * this._q[3] - this.quat[o + 3]);
		const n = Math.hypot(nx, ny, nz, nw) || 1;
		this.quat[o] = nx / n; this.quat[o + 1] = ny / n; this.quat[o + 2] = nz / n; this.quat[o + 3] = nw / n;
		// The nlerp can leave the cone even between two targets that are
		// inside it: see clampTilt(). This is the quaternion that is
		// rendered, so it is the one that must hold the invariant.
		clampTilt(this.quat, o);
	}
}

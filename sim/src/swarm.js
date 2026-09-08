// The swarm model (issue #29): the wake, the slots, the doctrines, the ray
// budget. Pure — no Three, no Rapier, no DOM, no audio. tools/swarm-selftest.mjs
// runs it in Node with stubbed rays, the same way tools/entry-state-selftest.mjs
// stubs `{groundBelow, obstructionBetween}`. src/swarm-drones.js is what turns
// this into meshes; main.js never talks to this file directly.
//
// The idea in one line: the player's own wake is free of geometry BY
// CONSTRUCTION, so following it costs zero rays. Everything the units do that
// is NOT the wake — the lateral offset, the vertical offset, the forward
// extrapolation — is the only place a building can bite, and that is the only
// place rays are spent.
//
// Public API (what src/swarm-drones.js consumes):
//
//   const swarm = new SwarmModel({ size, doctrineSeed, seed });
//   swarm.reset(player)                                  // player {x,y,z} | null
//   swarm.update(player, time, dt, terrain, wind, fence)
//   swarm.pos    Float64Array(3 * size)   x, y, z per unit, local ENU metres
//   swarm.vel    Float64Array(3 * size)
//   swarm.acc    Float64Array(3 * size)   kinematic acceleration (what tilts it)
//   swarm.quat   Float64Array(4 * size)   x, y, z, w
//   swarm.size, swarm.doctrine
//   swarm.debug()                         // the same object every call
//
// update() arguments, all read-only and none of them retained:
//   player  {x, y, z}    the node's position this frame
//   time    seconds, monotonic, the caller's clock (physics time)
//   dt      seconds; <= 0 is a frozen frame and does nothing (the repo's
//           `frozen ? 0 : dt` convention)
//   terrain {obstructionBetween(x1,y1,z1,x2,y2,z2) -> {blocked, span}}
//           `groundBelow` is accepted by the stubs but never called: the ray
//           budget is spent entirely on obstruction, and the wake already
//           encodes "the player flew here, so it is above the ground".
//   wind    {x, y, z} — physics.wind.out, read ONCE per frame
//   fence   null, or {bbox: {min:[3], max:[3]}} pre-baked, or
//           {center: {x,y,z}, radius} live (rocktree nearestTrustedRadius()).
//           Pure geometry only: no Geofence instance is ever shared, it carries
//           hysteresis (spec constraint 10).
//
// update() allocates nothing. Every scratch is an instance field; the caller
// may keep the array references forever.

import {
	rngFrom, attitudeFrom, clampTilt, lateralAccelMax, ATTITUDE_TAU,
} from './drone-kinematics.js';
import { horizontalMargin, verticalMargin } from './geofence.js';
import { PROFILES } from './drone-profiles.js';

// ------------------------------------------------------------------ the unit
//
// `swarmUnit` is never flown, so it has no PROFILES entry, no PID and no bench
// tune (spec: "une recette géométrique et des constantes cinématiques dans
// src/swarm.js"). These are those constants.
//
// A 3" recon quad, ~330 g, ducted, nervous: twr ~5 and vMax ~24 m/s. The body
// drag is the toothpick's scaled by frontal area — same open-air coefficient
// per unit of area, a bigger airframe. (0.027/0.038)^2 = 0.505 on the arm span.
const TOOTHPICK = PROFILES.toothpick;
const DRAG_AREA_SCALE = (0.027 / 0.038) ** 2;

export const SWARM_UNIT = {
	family: 'swarmUnit',
	mass: 0.33,
	twr: 5,
	vMax: 24,
	propRadius: 0.038,
	bladeCount: 3,
	armX: 0.027,
	armZ: 0.027,
	maxOmega: 4200,
	bodyDrag: {
		x: TOOTHPICK.bodyDrag.x * DRAG_AREA_SCALE,
		y: TOOTHPICK.bodyDrag.y * DRAG_AREA_SCALE,
		z: TOOTHPICK.bodyDrag.z * DRAG_AREA_SCALE,
	},
};

// What the airframe can actually do. A unit cannot follow faster than the
// machine flies: full stick and the swarm falls behind, then catches up. That
// is the sensation the spec asks for, and it is nothing but these two numbers.
export const ACCEL_MAX = lateralAccelMax(SWARM_UNIT.twr);   // 48.1 m/s^2
export const SPEED_MAX = SWARM_UNIT.vMax;

export const MIN_SIZE = 6;
export const MAX_SIZE = 12;

// ------------------------------------------------------------------ the wake
//
// A ring of player positions: 512 entries, one write every 20 ms. At 20 m/s
// that is ~10 s and ~200 m of track. Pre-allocated once, never grown.
//
// x/y/z are Float32 as specified — local ENU metres, so ~1e-4 m of resolution
// at the far edge of the biggest scene. `t` is Float64 on purpose: it carries
// the caller's absolute clock, and Float32 would quantise a session-long clock
// coarsely enough to matter against a 20 ms spacing.
export const WAKE_SAMPLES = 512;
export const WAKE_DT_S = 0.020;

// How far back from a unit's own read index the nearest-wake-point search
// looks. 96 samples is ~1.9 s of track, far more than any doctrine's lag
// spread plus the slack a unit can build up while falling behind.
const WAKE_WINDOW = 96;

// Below this the track has no direction: the player is hovering. We walk back
// until we find real displacement rather than normalise noise.
const TRACK_EPS_M = 0.05;
const TRACK_BACKSTEPS = 25;

// --------------------------------------------------------------- the offsets
//
// A negative lag means "ahead of the player", which means extrapolating the
// track — terrain nobody has validated. Bounded hard, and given priority in
// the ray turnstile.
export const AHEAD_MAX_S = 0.4;
export const AHEAD_LATERAL_MAX_M = 4;

// The rule of geometrySafe() (src/entry-state.js): blocked AND thicker than
// 2 m. That is what tells a clipped roof edge from a wall in the way.
export const BLOCK_SPAN_M = 2;

// WHERE the ray is cast, and it is worth the paragraph.
//
// The obvious segment is "from the unit to its slot". Measured, it does not
// work: the unit tracks its slot closely, so that segment is short, and a
// margin that grows over 1.5 s walks the pair into a wall a few centimetres at
// a time — never enough material on one segment to trip `span > 2 m`. A cloud
// doctrine ended up 2.5 m inside a building with every ray coming back green.
//
// So the ray starts at the ANCHOR — the wake point, free by construction — and
// ends past the slot: OVERREACH_M further along the offset, so the 2 m of
// material the rule tolerates is spent OUTSIDE the offset instead of inside
// it, and LOOKAHEAD_S of track further on, so the wall a unit is about to be
// carried into is seen while there is still time to fold. The forward part
// scales with the margin like everything else: a unit already folded onto the
// wake asks no question it does not need answered.
const OVERREACH_M = 3;
const LOOKAHEAD_S = 0.8;

// The global turnstile: 6 rays per frame, ~360/s, the same order as the wind
// rosette. Never more, whatever the size or the doctrine.
export const RAY_BUDGET = 6;
// A unit behind the player is tested one turn in three; a unit ahead every
// turn. Assignment guarantees at most ~size/3 units are ahead, so "every turn"
// always fits inside the budget (asserted by the selftest).
const REAR_PERIOD = 3;

// A blocked unit loses its offsets in 0.3 s and folds back onto the pure wake
// — exactly where the player flew. They grow back in 1.5 s once the ray is
// green again.
export const MARGIN_FALL_S = 0.3;
export const MARGIN_RISE_S = 1.5;

// Short-range separation so units do not stack: 1.5 m, and at N <= 12 that is
// at most 66 pairs.
const SEPARATION_R = 1.5;
const SEPARATION_ACCEL = 14;

// How much of the fence's inside we refuse to use, in metres. The wake itself
// is inside by construction (the player is held there); only the offsets can
// reach out, and this is where they stop.
const FENCE_KEEP_M = 2;

// ------------------------------------------------------------- the doctrines
//
// `scouts` overrides the "about a third of them ahead" rule: a column has two
// scouts and a tail, not four abreast.
export const DOCTRINES = {
	column: { lagMin: -0.2, lagMax: 1.2, lateral: 2, vertical: 1, tau: 0.25, scouts: 2 },
	wedge: { lagMin: -0.4, lagMax: 0.5, lateral: 6, vertical: 2, tau: 0.35 },
	cloud: { lagMin: -0.4, lagMax: 2.0, lateral: 10, vertical: 4, tau: 0.80 },
	screen: { lagMin: -0.4, lagMax: 0.2, lateral: 10, vertical: 2, tau: 0.50 },
};
export const DOCTRINE_NAMES = Object.keys(DOCTRINES);

export function doctrineFor(doctrineSeed) {
	const rand = rngFrom(`${doctrineSeed}::doctrine`);
	return DOCTRINE_NAMES[Math.min(DOCTRINE_NAMES.length - 1, Math.floor(rand() * DOCTRINE_NAMES.length))];
}

export function scoutsFor(name, size) {
	const d = DOCTRINES[name];
	const scouts = d.scouts !== undefined ? d.scouts : Math.round(size / 3);
	return Math.max(1, Math.min(size - 1, scouts));
}

// Draws (lag, lateral, vertical) for every unit into three arrays. Pure and
// deterministic on `doctrineSeed` alone: same seed, same size, same slots.
//
// The shape of each doctrine lives here, not in the table: a wedge widens with
// lag (a V whose rear point is the player), a screen spreads abreast just
// ahead, a column stays on the centreline, a cloud is a cloud.
export function buildSlots(name, size, seed, lag, lat, vert) {
	const d = DOCTRINES[name];
	const rand = rngFrom(`${seed}::${name}::${size}::slots`);
	const scouts = scoutsFor(name, size);
	const rear = size - scouts;
	for (let k = 0; k < size; k++) {
		const ahead = k < scouts;
		let l, s;
		if (ahead) {
			// Spread the scouts over the ahead band, deepest first, and never
			// past the extrapolation bound.
			const u = scouts === 1 ? 1 : (k + 1) / scouts;
			l = Math.max(d.lagMin, -AHEAD_MAX_S) * (0.35 + 0.65 * u) * (0.85 + 0.15 * rand());
			s = 1;
		} else {
			const j = k - scouts;
			const u = rear === 1 ? 0.5 : j / (rear - 1);
			l = 0.05 + (d.lagMax - 0.05) * (0.15 + 0.85 * u) * (0.75 + 0.25 * rand());
			s = l / d.lagMax;
		}
		const side = (k % 2 === 0) ? 1 : -1;
		let width = d.lateral;
		if (name === 'wedge') width = d.lateral * Math.min(1, 0.25 + 0.75 * Math.abs(s));
		else if (name === 'column') width = d.lateral * (0.2 + 0.5 * rand());
		else width = d.lateral * (0.35 + 0.65 * rand());
		if (ahead) width = Math.min(width, AHEAD_LATERAL_MAX_M);
		lag[k] = l;
		lat[k] = side * width;
		vert[k] = (rand() * 2 - 1) * d.vertical;
	}
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

export class SwarmModel {
	constructor({ size, doctrineSeed, seed = doctrineSeed }) {
		const n = Math.max(MIN_SIZE, Math.min(MAX_SIZE, Math.round(size)));
		this.size = n;
		this.seed = seed;
		this.doctrineSeed = doctrineSeed;
		this.doctrine = doctrineFor(doctrineSeed);
		this.tau = DOCTRINES[this.doctrine].tau;
		this.scouts = scoutsFor(this.doctrine, n);

		// The slots, drawn once. They never change during a session.
		this.lag = new Float64Array(n);
		this.lat = new Float64Array(n);
		this.vert = new Float64Array(n);
		buildSlots(this.doctrine, n, doctrineSeed, this.lag, this.lat, this.vert);
		// A wind phase per unit, like the ambients: the gust does not hit
		// twelve machines at the same instant.
		this.phase = new Float64Array(n);
		{
			const rand = rngFrom(`${seed}::swarm::phase`);
			for (let k = 0; k < n; k++) this.phase[k] = rand() * Math.PI * 2;
		}

		// State the caller reads.
		this.pos = new Float64Array(3 * n);
		this.vel = new Float64Array(3 * n);
		this.acc = new Float64Array(3 * n);
		this.quat = new Float64Array(4 * n);
		// The offset budget each unit is currently allowed, 0..1.
		this.margin = new Float64Array(n);
		this.blocked = new Uint8Array(n);

		// The wake ring.
		this._wx = new Float32Array(WAKE_SAMPLES);
		this._wy = new Float32Array(WAKE_SAMPLES);
		this._wz = new Float32Array(WAKE_SAMPLES);
		this._wt = new Float64Array(WAKE_SAMPLES);
		this._head = -1;
		this._count = 0;
		this._oldest = 0;
		this._sinceWrite = 0;

		// Per-unit scratch that survives frames.
		this._slot = new Float64Array(3 * n);
		this._slotVel = new Float64Array(3 * n);
		this._anchor = new Float64Array(3 * n);
		this._tubeR = new Float64Array(n);
		this._readIdx = new Int32Array(n);
		// Track tangent (x, y, z) and speed at each unit's anchor, kept so the
		// ray can be aimed without re-reading the wake.
		this._frame = new Float64Array(4 * n);
		// The turn at which each rear unit may be tested again.
		this._due = new Int32Array(n);
		this._sep = new Float64Array(3 * n);

		// Per-frame scratch, allocated once.
		this._w = { x: 0, y: 0, z: 0, tx: 0, ty: 0, tz: -1, speed: 0 };
		this._wind = { x: 0, y: 0, z: 0 };
		this._att = { ax: 0, ay: 0, az: 0, vx: 0, vy: 0, vz: 0, wind: null, drag: SWARM_UNIT.bodyDrag, mass: SWARM_UNIT.mass, yawX: 0, yawZ: -1 };
		this._q = new Float64Array(4);
		this._p = { x: 0, y: 0, z: 0 };
		this._tan = { x: 0, y: 0, z: -1 };
		this._dbg = { size: n, doctrine: this.doctrine, raysCast: 0, blockedUnits: 0, lagRange: [0, 0], wake: 0 };
		this._dbg.lagRange[0] = Math.min(...this.lag);
		this._dbg.lagRange[1] = Math.max(...this.lag);

		this.raysCast = 0;
		this.raysLastFrame = 0;
		this._turn = 0;
		this._clock = 0;
		this.reset(null);
	}

	// Empties the wake and puts every unit back on the player with no offset
	// at all: margin 0 means "you are exactly where the player is", which is
	// the one position we know is free. respawn() and __sim.teleport call this.
	reset(player) {
		const n = this.size;
		const px = player ? player.x : 0, py = player ? player.y : 0, pz = player ? player.z : 0;
		this._head = -1; this._count = 0; this._oldest = 0; this._sinceWrite = 0;
		this._clock = 0; this._turn = 0;
		this.raysLastFrame = 0;
		this._tan.x = 0; this._tan.y = 0; this._tan.z = -1;
		this.margin.fill(0);
		// Pessimistic until proven otherwise: a unit's offsets only ever grow
		// behind a ray that came back green. Before its first cast it flies the
		// pure wake, which is the one place we know is free.
		this.blocked.fill(1);
		this._tubeR.fill(0);
		this._readIdx.fill(0);
		this._due.fill(0);
		this._frame.fill(0);
		this.vel.fill(0);
		this.acc.fill(0);
		this._sep.fill(0);
		this._slotVel.fill(0);
		for (let k = 0; k < n; k++) {
			const o = 3 * k;
			this.pos[o] = px; this.pos[o + 1] = py; this.pos[o + 2] = pz;
			this._slot[o] = px; this._slot[o + 1] = py; this._slot[o + 2] = pz;
			this._anchor[o] = px; this._anchor[o + 1] = py; this._anchor[o + 2] = pz;
			const q = 4 * k;
			this.quat[q] = 0; this.quat[q + 1] = 0; this.quat[q + 2] = 0; this.quat[q + 3] = 1;
		}
	}

	debug() {
		const d = this._dbg;
		d.raysCast = this.raysCast;
		d.wake = this._count;
		let b = 0;
		for (let k = 0; k < this.size; k++) if (this.blocked[k]) b++;
		d.blockedUnits = b;
		return d;
	}

	// ------------------------------------------------------------ wake ring

	_push(x, y, z, t) {
		this._head = (this._head + 1) % WAKE_SAMPLES;
		this._wx[this._head] = x; this._wy[this._head] = y; this._wz[this._head] = z;
		this._wt[this._head] = t;
		if (this._count < WAKE_SAMPLES) this._count++;
		this._oldest = (this._head - this._count + 1 + WAKE_SAMPLES) % WAKE_SAMPLES;
	}

	// Physical index of logical entry j, 0 = oldest.
	_at(j) { return (this._oldest + j) % WAKE_SAMPLES; }

	// Largest logical j with t[j] <= t, or 0 when t precedes the whole ring.
	_before(t) {
		let lo = 0, hi = this._count - 1;
		if (hi < 0) return 0;
		if (t <= this._wt[this._at(0)]) return 0;
		if (t >= this._wt[this._at(hi)]) return hi;
		while (hi - lo > 1) {
			const mid = (lo + hi) >> 1;
			if (this._wt[this._at(mid)] <= t) lo = mid; else hi = mid;
		}
		return lo;
	}

	// Unit tangent of the track around logical index j, walking back until the
	// displacement is real. Falls back to the last usable tangent — a hovering
	// player has no direction, and a normalised zero would be worse than stale.
	_tangentAt(j) {
		const n = this._count;
		for (let s = 0; s < TRACK_BACKSTEPS; s++) {
			const b = j - s, a = b - 1;
			if (a < 0 || b >= n) break;
			const ia = this._at(a), ib = this._at(b);
			const dx = this._wx[ib] - this._wx[ia], dy = this._wy[ib] - this._wy[ia], dz = this._wz[ib] - this._wz[ia];
			const len = Math.hypot(dx, dy, dz);
			if (len > TRACK_EPS_M) {
				this._tan.x = dx / len; this._tan.y = dy / len; this._tan.z = dz / len;
				return;
			}
		}
	}

	// Reads the wake at time `t` into this._w: position, unit tangent, speed.
	// Older than the ring -> the oldest entry (defined, and tested). Newer than
	// the ring -> extrapolated along the tangent; that is the "ahead" case, and
	// it is the caller's job to have bounded how far.
	_read(t) {
		const w = this._w, n = this._count;
		if (n === 0) { w.x = 0; w.y = 0; w.z = 0; w.tx = 0; w.ty = 0; w.tz = -1; w.speed = 0; return w; }
		const j = this._before(t);
		this._tangentAt(Math.min(n - 1, Math.max(1, j + 1)));
		w.tx = this._tan.x; w.ty = this._tan.y; w.tz = this._tan.z;
		const ij = this._at(j);
		if (n === 1) {
			w.x = this._wx[ij]; w.y = this._wy[ij]; w.z = this._wz[ij]; w.speed = 0;
			return w;
		}
		const last = this._at(n - 1);
		if (t <= this._wt[this._at(0)]) {
			const i0 = this._at(0);
			w.x = this._wx[i0]; w.y = this._wy[i0]; w.z = this._wz[i0];
			w.speed = this._speedAt(1);
			return w;
		}
		if (t >= this._wt[last]) {
			w.speed = this._speedAt(n - 1);
			const ahead = (t - this._wt[last]) * w.speed;
			w.x = this._wx[last] + w.tx * ahead;
			w.y = this._wy[last] + w.ty * ahead;
			w.z = this._wz[last] + w.tz * ahead;
			return w;
		}
		const i1 = this._at(j + 1);
		const t0 = this._wt[ij], t1 = this._wt[i1];
		const u = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
		w.x = this._wx[ij] + u * (this._wx[i1] - this._wx[ij]);
		w.y = this._wy[ij] + u * (this._wy[i1] - this._wy[ij]);
		w.z = this._wz[ij] + u * (this._wz[i1] - this._wz[ij]);
		w.speed = this._speedAt(j + 1);
		return w;
	}

	// Track speed over the segment ending at logical index j.
	_speedAt(j) {
		const b = Math.min(this._count - 1, Math.max(1, j)), a = b - 1;
		const ia = this._at(a), ib = this._at(b);
		const dt = this._wt[ib] - this._wt[ia];
		if (dt <= 0) return 0;
		return Math.hypot(this._wx[ib] - this._wx[ia], this._wy[ib] - this._wy[ia], this._wz[ib] - this._wz[ia]) / dt;
	}

	// ----------------------------------------------------------- the update

	update(player, time, dt, terrain, wind, fence) {
		if (!(dt > 0)) return;
		const n = this.size;
		this._clock += dt;

		// The wake, one write per 20 ms and not one allocation.
		this._sinceWrite += dt;
		if (this._count === 0 || this._sinceWrite >= WAKE_DT_S) {
			this._push(player.x, player.y, player.z, time);
			this._sinceWrite = 0;
		}

		// The wind is read ONCE per frame, like the ambients.
		const wx = wind ? wind.x : 0, wy = wind ? wind.y : 0, wz = wind ? wind.z : 0;

		// 1. The slots this frame (on last frame's margins), then the rays that
		//    judge them, then the margins that answer. The margin a ray earns
		//    lands on the NEXT frame's slot — one frame, and no way around it.
		for (let k = 0; k < n; k++) this._slotOf(k, time, dt, fence);
		this._castRays(terrain);
		for (let k = 0; k < n; k++) {
			this.margin[k] = clamp01(this.blocked[k]
				? this.margin[k] - dt / MARGIN_FALL_S
				: this.margin[k] + dt / MARGIN_RISE_S);
		}

		// 2. Separation, short range, at most 66 pairs at N = 12. Scaled by the
		//    two margins: at margin 0 nothing may push a unit off the wake.
		this._sep.fill(0);
		for (let i = 0; i < n; i++) {
			const oi = 3 * i;
			for (let j = i + 1; j < n; j++) {
				const oj = 3 * j;
				const dx = this.pos[oi] - this.pos[oj], dy = this.pos[oi + 1] - this.pos[oj + 1], dz = this.pos[oi + 2] - this.pos[oj + 2];
				const d = Math.hypot(dx, dy, dz);
				if (d >= SEPARATION_R) continue;
				const g = SEPARATION_ACCEL * (1 - d / SEPARATION_R) * Math.min(this.margin[i], this.margin[j]);
				let ux, uy, uz;
				if (d > 1e-6) { ux = dx / d; uy = dy / d; uz = dz / d; }
				else { ux = Math.cos(this.phase[i]); uy = 0; uz = Math.sin(this.phase[i]); }
				this._sep[oi] += g * ux; this._sep[oi + 1] += g * uy; this._sep[oi + 2] += g * uz;
				this._sep[oj] -= g * ux; this._sep[oj + 1] -= g * uy; this._sep[oj + 2] -= g * uz;
			}
		}

		// 3. Fly them.
		const om = 1 / this.tau;
		for (let k = 0; k < n; k++) {
			const o = 3 * k;
			// Per-unit gust: the same wind, not at the same instant.
			const gust = 0.85 + 0.3 * Math.sin(this._clock * 0.7 + this.phase[k]);
			this._wind.x = wx * gust; this._wind.y = wy * gust; this._wind.z = wz * gust;
			// Air drag, the same model as quad.js and attitudeFrom(): this is
			// what makes the wind push the unit around instead of decorating it.
			const rx = this.vel[o] - this._wind.x, ry = this.vel[o + 1] - this._wind.y, rz = this.vel[o + 2] - this._wind.z;
			const s = Math.hypot(rx, ry, rz);
			const dg = SWARM_UNIT.bodyDrag, m = SWARM_UNIT.mass;
			// Critically damped spring onto the slot, with the slot's own
			// velocity as the feed-forward: without it the swarm trails
			// permanently instead of only when it cannot keep up.
			let ax = om * om * (this._slot[o] - this.pos[o]) + 2 * om * (this._slotVel[o] - this.vel[o]) + this._sep[o] - dg.x * s * rx / m;
			let ay = om * om * (this._slot[o + 1] - this.pos[o + 1]) + 2 * om * (this._slotVel[o + 1] - this.vel[o + 1]) + this._sep[o + 1] - dg.y * s * ry / m;
			let az = om * om * (this._slot[o + 2] - this.pos[o + 2]) + 2 * om * (this._slotVel[o + 2] - this.vel[o + 2]) + this._sep[o + 2] - dg.z * s * rz / m;
			const an = Math.hypot(ax, ay, az);
			if (an > ACCEL_MAX) { const f = ACCEL_MAX / an; ax *= f; ay *= f; az *= f; }
			this.acc[o] = ax; this.acc[o + 1] = ay; this.acc[o + 2] = az;
			let vx = this.vel[o] + ax * dt, vy = this.vel[o + 1] + ay * dt, vz = this.vel[o + 2] + az * dt;
			const vn = Math.hypot(vx, vy, vz);
			if (vn > SPEED_MAX) { const f = SPEED_MAX / vn; vx *= f; vy *= f; vz *= f; }
			this.vel[o] = vx; this.vel[o + 1] = vy; this.vel[o + 2] = vz;
			this.pos[o] += vx * dt; this.pos[o + 1] += vy * dt; this.pos[o + 2] += vz * dt;
			// The fence first (convex), then the wake tube (a move towards a
			// point on the wake, which is inside the fence): doing it in this
			// order, neither undoes the other.
			this._fenceClamp(o, fence);
			this._tube(k);
			this._attitude(k, dt);
		}
	}

	// The slot: read the wake at t - lag, then step sideways in the frame of
	// the TRACK at that instant — tangent, horizontal normal, vertical.
	//
	// `margin` scales every offset, INCLUDING the forward extrapolation. That
	// is the whole safety argument: at margin 0 the slot is not "the wake plus
	// a little", it IS a point of the wake, bit for bit.
	_slotOf(k, time, dt, fence) {
		const o = 3 * k;
		const mk = this.margin[k];
		const lag = this.lag[k];
		// The anchor never extrapolates: for a unit ahead it is the newest
		// sample, i.e. exactly where the player is now.
		const tA = time - Math.max(0, lag);
		this._readIdx[k] = this._before(tA);
		const w = this._read(tA);
		const ax = w.x, ay = w.y, az = w.z;
		this._anchor[o] = ax; this._anchor[o + 1] = ay; this._anchor[o + 2] = az;
		const f = 4 * k;
		this._frame[f] = w.tx; this._frame[f + 1] = w.ty; this._frame[f + 2] = w.tz; this._frame[f + 3] = w.speed;
		// Horizontal normal of the track. Degenerate only if the track is
		// exactly vertical, and then any horizontal direction will do.
		let nx = w.tz, nz = -w.tx;
		const nl = Math.hypot(nx, nz);
		if (nl > 1e-6) { nx /= nl; nz /= nl; } else { nx = 1; nz = 0; }
		// Ahead: extrapolate along the tangent, bounded in TIME (the bound the
		// spec gives) and faded by the margin like every other offset.
		const ahead = lag < 0 ? Math.min(AHEAD_MAX_S, -lag) * w.speed * mk : 0;
		const lat = this.lat[k] * mk, ver = this.vert[k] * mk;
		let sx = ax + w.tx * ahead + nx * lat;
		let sy = ay + w.ty * ahead + ver;
		let sz = az + w.tz * ahead + nz * lat;
		// The wake is inside the fence because the player is; only the offsets
		// can leave, so only the offsets are pulled back.
		this._p.x = sx; this._p.y = sy; this._p.z = sz;
		this._fencePoint(this._p, fence);
		sx = this._p.x; sy = this._p.y; sz = this._p.z;
		// Slot velocity by difference, low-passed over one spring constant so
		// a wake write does not show up as a step.
		const a = 1 - Math.exp(-dt / Math.max(1e-3, this.tau));
		this._slotVel[o] += a * ((sx - this._slot[o]) / dt - this._slotVel[o]);
		this._slotVel[o + 1] += a * ((sy - this._slot[o + 1]) / dt - this._slotVel[o + 1]);
		this._slotVel[o + 2] += a * ((sz - this._slot[o + 2]) / dt - this._slotVel[o + 2]);
		this._slot[o] = sx; this._slot[o + 1] = sy; this._slot[o + 2] = sz;
		// How far from the wake this unit is entitled to be, this frame.
		const want = Math.hypot(sx - ax, sy - ay, sz - az);
		// The tube never shrinks (nor grows) faster than the airframe flies:
		// the safety net is allowed to constrain a unit, not to teleport it.
		const step = SPEED_MAX * dt;
		const r = this._tubeR[k];
		this._tubeR[k] = want > r ? Math.min(want, r + step) : Math.max(want, r - step);
	}

	// ------------------------------------------------------- the ray budget
	//
	// One obstruction test per unit and per turn, over the only stretch that is
	// not the wake: the offset (see _cast() for where exactly the segment
	// starts and ends). A unit ahead is tested every turn — its slot is
	// extrapolated, so nothing has ever validated it — a unit behind one turn
	// in three. Never more than RAY_BUDGET casts, whatever the size and
	// whatever the doctrine.
	_castRays(terrain) {
		this.raysLastFrame = 0;
		// No ray provider (a boot frame, a scene still loading): nobody is
		// cleared, so every unit stays folded onto the pure wake. Degrading
		// towards single file is the whole point of the fallback.
		if (!terrain || !terrain.obstructionBetween) return;
		const n = this.size;
		this._turn++;
		let budget = RAY_BUDGET;
		// Pass 1: everyone ahead. At most scoutsFor() units, which is <= 4 at
		// size 12 — it always fits.
		for (let k = 0; k < n && budget > 0; k++) {
			if (this.lag[k] >= 0) continue;
			this._cast(terrain, k); budget--;
		}
		// Pass 2: the rear. `_due` caps a unit at one turn in three; among the
		// units that are due, the most overdue goes first. That last part is
		// not decoration — with the budget the scouts leave (2 casts for 8
		// units at size 12) a plain rotating cursor starved two units of the
		// twelve for the whole flight, measured. Overdue grows without bound
		// for a starved unit, so it always wins in the end.
		while (budget > 0) {
			let best = -1, over = -1;
			for (let k = 0; k < n; k++) {
				if (this.lag[k] < 0) continue;
				const d = this._turn - this._due[k];
				if (d >= 0 && d > over) { over = d; best = k; }
			}
			if (best < 0) break;
			this._cast(terrain, best); budget--;
			this._due[best] = this._turn + REAR_PERIOD;
		}
	}

	_cast(terrain, k) {
		const o = 3 * k, f = 4 * k;
		const ax = this._anchor[o], ay = this._anchor[o + 1], az = this._anchor[o + 2];
		let ox = this._slot[o] - ax, oy = this._slot[o + 1] - ay, oz = this._slot[o + 2] - az;
		const l = Math.hypot(ox, oy, oz);
		if (l > 1e-3) { const g = (l + OVERREACH_M) / l; ox *= g; oy *= g; oz *= g; }
		const fwd = LOOKAHEAD_S * this._frame[f + 3] * this.margin[k];
		const r = terrain.obstructionBetween(
			ax, ay, az,
			ax + ox + this._frame[f] * fwd,
			ay + oy + this._frame[f + 1] * fwd,
			az + oz + this._frame[f + 2] * fwd,
		);
		this.raysCast++; this.raysLastFrame++;
		// geometrySafe()'s rule: blocked AND thicker than 2 m. A roof edge
		// clipped tangentially is not a wall.
		this.blocked[k] = (r && r.blocked && r.span > BLOCK_SPAN_M) ? 1 : 0;
	}

	// ---------------------------------------------------------- the fence

	_fencePoint(p, fence) {
		if (!fence) return;
		if (fence.bbox) {
			const b = fence.bbox;
			// The same two functions the geofence itself measures with, so the
			// swarm can never disagree with the fence about where the edge is.
			if (horizontalMargin(p, b) >= FENCE_KEEP_M && verticalMargin(p, b) >= FENCE_KEEP_M) return;
			const kx = Math.min(FENCE_KEEP_M, (b.max[0] - b.min[0]) / 2);
			const kz = Math.min(FENCE_KEEP_M, (b.max[2] - b.min[2]) / 2);
			if (p.x < b.min[0] + kx) p.x = b.min[0] + kx;
			if (p.x > b.max[0] - kx) p.x = b.max[0] - kx;
			if (p.z < b.min[2] + kz) p.z = b.min[2] + kz;
			if (p.z > b.max[2] - kz) p.z = b.max[2] - kz;
			if (p.y < b.min[1] + FENCE_KEEP_M) p.y = b.min[1] + FENCE_KEEP_M;
			return;
		}
		if (fence.center && fence.radius > 0) {
			const c = fence.center;
			const r = Math.max(0, fence.radius - FENCE_KEEP_M);
			const dx = p.x - c.x, dz = p.z - c.z;
			const d = Math.hypot(dx, dz);
			if (d > r && d > 1e-9) { p.x = c.x + dx / d * r; p.z = c.z + dz / d * r; }
		}
	}

	_fenceClamp(o, fence) {
		if (!fence) return;
		this._p.x = this.pos[o]; this._p.y = this.pos[o + 1]; this._p.z = this.pos[o + 2];
		this._fencePoint(this._p, fence);
		this.pos[o] = this._p.x; this.pos[o + 1] = this._p.y; this.pos[o + 2] = this._p.z;
	}

	// Is this point inside the fence at all? Used by the selftest, and cheap
	// enough that swarm-drones.js may use it for debug overlays.
	insideFence(x, y, z, fence) {
		if (!fence) return true;
		this._p.x = x; this._p.y = y; this._p.z = z;
		if (fence.bbox) return horizontalMargin(this._p, fence.bbox) >= 0 && verticalMargin(this._p, fence.bbox) >= 0;
		if (fence.center && fence.radius > 0) return Math.hypot(x - fence.center.x, z - fence.center.z) <= fence.radius;
		return true;
	}

	// ------------------------------------------------------- the wake tube
	//
	// THE safety net, and the reason the degraded case is benign. A unit is
	// never allowed further from the recorded wake than its own margin buys
	// it. With every ray blocked the margins reach 0 in 0.3 s, the tube radius
	// follows, and from then on every unit sits EXACTLY on the polyline the
	// player flew — single file in your own tracks, which is the worst thing
	// this system can do.
	//
	// The nearest point is taken on the polyline (segments, not vertices) in a
	// window around the unit's own read index: a unit that has fallen behind
	// is behind ON the wake, so the net pulls it sideways onto the track, it
	// never drags it forwards past where it has got to.
	_tube(k) {
		const n = this._count;
		if (n < 1) return;
		const o = 3 * k;
		const px = this.pos[o], py = this.pos[o + 1], pz = this.pos[o + 2];
		const lo = Math.max(0, this._readIdx[k] - WAKE_WINDOW);
		const hi = Math.min(n - 1, this._readIdx[k] + WAKE_WINDOW);
		let bx = 0, by = 0, bz = 0, best = Infinity;
		if (hi === lo) {
			const i = this._at(lo);
			bx = this._wx[i]; by = this._wy[i]; bz = this._wz[i];
			best = (px - bx) ** 2 + (py - by) ** 2 + (pz - bz) ** 2;
		}
		for (let j = lo; j < hi; j++) {
			const ia = this._at(j), ib = this._at(j + 1);
			const axp = this._wx[ia], ayp = this._wy[ia], azp = this._wz[ia];
			const ex = this._wx[ib] - axp, ey = this._wy[ib] - ayp, ez = this._wz[ib] - azp;
			const ee = ex * ex + ey * ey + ez * ez;
			let u = ee > 1e-12 ? ((px - axp) * ex + (py - ayp) * ey + (pz - azp) * ez) / ee : 0;
			if (u < 0) u = 0; else if (u > 1) u = 1;
			const cx = axp + u * ex, cy = ayp + u * ey, cz = azp + u * ez;
			const d2 = (px - cx) ** 2 + (py - cy) ** 2 + (pz - cz) ** 2;
			if (d2 < best) { best = d2; bx = cx; by = cy; bz = cz; }
		}
		const d = Math.sqrt(best);
		const r = this._tubeR[k];
		if (!(d > r)) return;
		const f = d > 1e-9 ? r / d : 0;
		const nx = px - bx, ny = py - by, nz = pz - bz;
		this.pos[o] = bx + nx * f; this.pos[o + 1] = by + ny * f; this.pos[o + 2] = bz + nz * f;
		// The unit hit a constraint: kill the outward part of its velocity so
		// the spring does not spend the next frames pushing against the net.
		if (d > 1e-9) {
			const ux = nx / d, uy = ny / d, uz = nz / d;
			const vr = this.vel[o] * ux + this.vel[o + 1] * uy + this.vel[o + 2] * uz;
			if (vr > 0) { this.vel[o] -= vr * ux; this.vel[o + 1] -= vr * uy; this.vel[o + 2] -= vr * uz; }
		}
	}

	// ------------------------------------------------------------ attitude
	//
	// Straight out of src/drone-kinematics.js, exactly like the ambients: the
	// acceleration tilts the machine, nlerp smooths it, clampTilt() holds the
	// 70° invariant on the quaternion that is actually rendered.
	_attitude(k, dt) {
		const o = 3 * k, q = 4 * k;
		let yawX = this.vel[o], yawZ = this.vel[o + 2];
		// Standing still: face the way the track was going at this unit's own
		// anchor, not wherever the last unit read.
		if (Math.hypot(yawX, yawZ) < 1e-6) { yawX = this._frame[4 * k]; yawZ = this._frame[4 * k + 2]; }
		if (Math.hypot(yawX, yawZ) < 1e-6) { yawX = 0; yawZ = -1; }
		this._att.ax = this.acc[o]; this._att.ay = this.acc[o + 1]; this._att.az = this.acc[o + 2];
		this._att.vx = this.vel[o]; this._att.vy = this.vel[o + 1]; this._att.vz = this.vel[o + 2];
		this._att.wind = this._wind;
		this._att.yawX = yawX; this._att.yawZ = yawZ;
		attitudeFrom(this._att, this._q, 0);
		const a = 1 - Math.exp(-dt / ATTITUDE_TAU);
		let d = this.quat[q] * this._q[0] + this.quat[q + 1] * this._q[1] + this.quat[q + 2] * this._q[2] + this.quat[q + 3] * this._q[3];
		const sgn = d < 0 ? -1 : 1;
		const nx = this.quat[q] + a * (sgn * this._q[0] - this.quat[q]);
		const ny = this.quat[q + 1] + a * (sgn * this._q[1] - this.quat[q + 1]);
		const nz = this.quat[q + 2] + a * (sgn * this._q[2] - this.quat[q + 2]);
		const nw = this.quat[q + 3] + a * (sgn * this._q[3] - this.quat[q + 3]);
		const nn = Math.hypot(nx, ny, nz, nw) || 1;
		this.quat[q] = nx / nn; this.quat[q + 1] = ny / nn; this.quat[q + 2] = nz / nn; this.quat[q + 3] = nw / nn;
		clampTilt(this.quat, q);
	}
}

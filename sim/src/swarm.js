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
// WHERE THE SAFETY ACTUALLY COMES FROM. A unit is not a free point in space
// pulled towards a target. Its position is, by construction and at every
// instant:
//
//     pos = wakeAt(s) + t̂·oT + n̂·oN + b̂·oB      with  |o| <= maxR
//
// `s` is a WAKE TIME: the unit's own reading head on the recorded polyline,
// with its own critically damped spring and its own speed limit. `o` is a
// small offset in the frame of the track at that point, and `maxR` is what the
// unit's margin currently buys — which the rays decide, and which reaches 0 in
// 0.3 s when a ray comes back blocked. At `maxR = 0` the unit is not near the
// wake, it IS on it. Nothing in the module can put it anywhere else: there is
// no free-space integration to drift away, no projection to catch it after the
// fact. (The first draft did exactly that — a 3D spring plus a corrective
// "tube" — and at 30 m/s a unit ended up 41 m from its slot with the ray still
// answering about the slot, 5 m inside a building. That is the failure this
// shape makes impossible rather than unlikely.)
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
// update() allocates nothing of its own. Every scratch is an instance field;
// the caller may keep the array references forever. (Math.hypot still costs V8
// a boxed rest-args allocation — the same one ambient.js and drone-kinematics.js
// pay, and for the same reason: it is the readable form of the expression.)

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
//
// The period is held by carrying the remainder, not by resetting to zero: the
// naive version rounds up to the frame and writes every 33 ms at 60 fps, which
// coarsens the polyline the whole safety argument rests on from 0.40 m to
// 0.67 m of track at 20 m/s.
export const WAKE_SAMPLES = 512;
export const WAKE_DT_S = 0.020;

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
// So the ray starts at the ANCHOR — the wake point the unit hangs from, free
// by construction — and sweeps the whole offset box: past whichever is bigger
// of the offset the unit HAS and the offset it WANTS (so the segment always
// covers where the unit actually is), OVERREACH_M further, so the 2 m of
// material the rule tolerates is spent outside the offset instead of inside
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
//
// "One turn in three" is held as a TIME, not as a frame count: three frames at
// 60 fps is 50 ms, and that is the number that means something. Counted in
// frames, a 250 ms frame would leave a rear unit unasked for three quarters of
// a second while it flew 5 m.
const REAR_PERIOD_S = 3 / 60;

// A margin is only worth what the ray behind it is worth, and a ray goes stale
// two ways: in TIME, and in GROUND COVERED. The clock alone is not enough —
// the budget is six rays per FRAME, so on a 250 ms frame a unit is asked about
// its surroundings once every 22 m of city instead of once every 1.5 m, and a
// 4 m hairpin happens entirely between two questions. Past either bound the
// margin stops growing and starts falling, exactly as if the ray had come back
// blocked: unasked is not the same as cleared.
const MARGIN_FRESH_S = 0.1;
const MARGIN_FRESH_M = 6;

// A blocked unit loses its offsets in 0.3 s and folds back onto the pure wake
// — exactly where the player flew. They grow back in 1.5 s once the ray is
// green again.
export const MARGIN_FALL_S = 0.3;
export const MARGIN_RISE_S = 1.5;
// How fast the offset ENVELOPE closes, in metres per second. As fast as the
// airframe flies and no faster: the fold is a flight, never a snap.
const MAX_RADIUS_FALL = SWARM_UNIT.vMax;

// Short-range separation so units do not stack: 1.5 m, and at N <= 12 that is
// at most 66 pairs.
const SEPARATION_R = 1.5;
const SEPARATION_ACCEL = 14;

// Where a scout goes when its margin is 0. It cannot stay ahead — ahead is
// extrapolated, i.e. unvalidated — and stacking every scout on the node would
// put four machines in one place. They drop into the file instead, at distinct
// lags: single file in your tracks, which is the worst case the spec asks for
// by name.
const FILE_LAG_STEP_S = 0.08;

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
		// Where each scout falls back to when its margin dies: evenly spread
		// between the node and the head of the file, so a folded swarm is a
		// file and not a heap. Spacing the scouts by a fixed step instead put
		// one of them 0.15 m from a rear unit.
		this.fileLag = new Float64Array(n);
		let head = Infinity;
		for (let k = 0; k < n; k++) if (this.lag[k] >= 0 && this.lag[k] < head) head = this.lag[k];
		if (!Number.isFinite(head)) head = FILE_LAG_STEP_S * (this.scouts + 1);
		for (let k = 0; k < n; k++) {
			this.fileLag[k] = this.lag[k] < 0 ? head * (k + 1) / (this.scouts + 1) : this.lag[k];
		}
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
		this._fresh = true;

		// Per-unit state that survives frames.
		this._s = new Float64Array(n);        // the unit's reading head, a wake time
		this._sv = new Float64Array(n);       // ds/dt, 1 = keeping up with the node
		this._sStar = new Float64Array(n);    // where the doctrine says it should read
		this._o = new Float64Array(3 * n);    // offset in the track frame: along, lateral, up
		this._ov = new Float64Array(3 * n);
		this._ot = new Float64Array(3 * n);   // what the doctrine asks for, same frame
		this._maxR = new Float64Array(n);     // the offset radius the margin currently buys
		this._anchor = new Float64Array(3 * n);
		// Track frame at each unit's anchor: t̂, n̂, b̂, then the track speed.
		this._frame = new Float64Array(12 * n);
		this._slot = new Float64Array(3 * n); // the ideal position, for debug and rays
		this._sAnchor = new Float64Array(3 * n);   // the wake point the doctrine asks for, THIS frame
		this._sFrame = new Float64Array(12 * n);   // and the track frame there
		this._readIdx = new Int32Array(n);
		this._due = new Float64Array(n);      // clock at which a rear unit is testable again
		this._green = new Float64Array(n);    // clock until which a green ray still counts
		this._greenAt = new Float64Array(3 * n);   // where the unit's anchor was when it was cleared
		this._lastCast = new Float64Array(n); // clock of this unit's last ray, for the lookahead
		this._sep = new Float64Array(3 * n);  // separation acceleration, world

		// Per-frame scratch, allocated once.
		this._w = { x: 0, y: 0, z: 0, tx: 0, ty: 0, tz: -1, speed: 0 };
		this._wind = { x: 0, y: 0, z: 0 };
		this._att = { ax: 0, ay: 0, az: 0, vx: 0, vy: 0, vz: 0, wind: null, drag: SWARM_UNIT.bodyDrag, mass: SWARM_UNIT.mass, yawX: 0, yawZ: -1 };
		this._q = new Float64Array(4);
		this._p = { x: 0, y: 0, z: 0 };
		this._tan = { x: 0, y: 0, z: -1 };
		this._f = new Float64Array(12);       // one frame, being built
		this._trial = new Float64Array(3);    // a candidate position during the speed search
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
		this._clock = 0; this._turn = 0; this._fresh = true;
		this.raysLastFrame = 0;
		this._tan.x = 0; this._tan.y = 0; this._tan.z = -1;
		this.margin.fill(0);
		// Pessimistic until proven otherwise: a unit's offsets only ever grow
		// behind a ray that came back green. Before its first cast it flies the
		// pure wake, which is the one place we know is free.
		this.blocked.fill(1);
		this._maxR.fill(0);
		this._readIdx.fill(0);
		this._due.fill(0);
		this._green.fill(0);
		this._greenAt.fill(0);
		this._lastCast.fill(0);
		this._frame.fill(0);
		this._sFrame.fill(0);
		this._sAnchor.fill(0);
		this._o.fill(0);
		this._ov.fill(0);
		this._ot.fill(0);
		this._s.fill(0);
		this._sv.fill(1);
		this._sStar.fill(0);
		this.vel.fill(0);
		this.acc.fill(0);
		this._sep.fill(0);
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

	// Time of the oldest entry still recorded.
	_oldestT() { return this._count ? this._wt[this._at(0)] : 0; }

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

	// Orthonormal frame of the track from a wake read, into `out` at `o`:
	// t̂ along the track, n̂ horizontal and across it, b̂ = n̂ × t̂ (the track's
	// own up, which is world up in level flight). Slot offsets are scalars in
	// this frame, which is what keeps "he is on my left" true through a turn —
	// and what lets one ray cover both where a unit is and where it is going.
	_frameOf(w, out, o) {
		let tx = w.tx, ty = w.ty, tz = w.tz;
		const tl = Math.hypot(tx, ty, tz);
		if (tl > 1e-9) { tx /= tl; ty /= tl; tz /= tl; } else { tx = 0; ty = 0; tz = -1; }
		// n̂ = t̂ × ŷ, horizontal by construction.
		let nx = -tz, ny = 0, nz = tx;
		const nl = Math.hypot(nx, nz);
		if (nl > 1e-9) { nx /= nl; nz /= nl; } else { nx = 1; nz = 0; }
		const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
		out[o] = tx; out[o + 1] = ty; out[o + 2] = tz;
		out[o + 3] = nx; out[o + 4] = ny; out[o + 5] = nz;
		out[o + 6] = bx; out[o + 7] = by; out[o + 8] = bz;
		out[o + 9] = w.speed;
	}

	// ----------------------------------------------------------- the update

	update(player, time, dt, terrain, wind, fence) {
		if (!(dt > 0)) return;
		const n = this.size;
		this._clock += dt;

		// The wake, one write per 20 ms, remainder carried so the period is the
		// period and not the frame time rounded up.
		this._sinceWrite += dt;
		if (this._count === 0 || this._sinceWrite >= WAKE_DT_S) {
			this._push(player.x, player.y, player.z, time);
			this._sinceWrite = Math.min(this._sinceWrite - WAKE_DT_S, WAKE_DT_S);
			if (this._sinceWrite < 0) this._sinceWrite = 0;
		}
		// First frame of a life: every reading head starts on the node itself.
		// `_s` is an absolute clock, so it cannot start at zero.
		if (this._fresh) { this._s.fill(time); this._sv.fill(1); this._fresh = false; }

		// The wind is read ONCE per frame, like the ambients.
		const wx = wind ? wind.x : 0, wy = wind ? wind.y : 0, wz = wind ? wind.z : 0;

		// 1. What the doctrine asks for this frame (on last frame's margins),
		//    then the rays — which describe the units where they are RIGHT NOW,
		//    since nothing has moved yet — then the margins that answer. The
		//    margin a ray earns lands on this frame's flying, so the loop is
		//    ask, decide, move, and there is no frame of parallax in it.
		for (let k = 0; k < n; k++) this._slotOf(k, time, dt);
		this._castRays(terrain);
		for (let k = 0; k < n; k++) {
			const o = 3 * k;
			const moved = Math.hypot(this._anchor[o] - this._greenAt[o], this._anchor[o + 1] - this._greenAt[o + 1], this._anchor[o + 2] - this._greenAt[o + 2]);
			const fresh = !this.blocked[k] && this._clock <= this._green[k] && moved <= MARGIN_FRESH_M;
			this.margin[k] = clamp01(fresh
				? this.margin[k] + dt / MARGIN_RISE_S
				: this.margin[k] - dt / MARGIN_FALL_S);
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
		for (let k = 0; k < n; k++) this._fly(k, dt, fence, wx, wy, wz);
	}

	// What the doctrine asks of unit k this frame: which wake time to read
	// (`_sStar`), which offsets to hold there (`_ot`), how far off the wake it
	// is allowed to be at all (`_maxR`), and the ideal position that follows
	// (`_slot`, for the rays' aim and for debug).
	//
	// `margin` scales every offset, INCLUDING the forward extrapolation: at
	// margin 0 a scout does not hover ahead of the node over unvalidated
	// ground, it drops into the file.
	_slotOf(k, time, dt) {
		const o = 3 * k;
		const m = this.margin[k];
		const lag = this.lag[k];
		const lagEff = lag < 0 ? lag * m + (1 - m) * this.fileLag[k] : lag;
		this._sStar[k] = time - lagEff;
		const w = this._read(this._sStar[k]);
		const sf = 12 * k;
		this._frameOf(w, this._sFrame, sf);
		this._sAnchor[o] = w.x; this._sAnchor[o + 1] = w.y; this._sAnchor[o + 2] = w.z;
		// A blocked unit is not asked to hold a smaller offset on the doctrine's
		// side — it is asked for NO offset. Through a hairpin the two are not
		// the same thing: the track frame turns over, so the doctrine's side
		// swaps, and a unit obediently swinging across the street to the new
		// side goes through the wall on the way.
		const oN = this.blocked[k] ? 0 : this.lat[k] * m, oB = this.blocked[k] ? 0 : this.vert[k] * m;
		this._ot[o] = 0; this._ot[o + 1] = oN; this._ot[o + 2] = oB;
		this._slot[o] = w.x + this._sFrame[sf + 3] * oN + this._sFrame[sf + 6] * oB;
		this._slot[o + 1] = w.y + this._sFrame[sf + 4] * oN + this._sFrame[sf + 7] * oB;
		this._slot[o + 2] = w.z + this._sFrame[sf + 5] * oN + this._sFrame[sf + 8] * oB;
		// The radius the margin buys, rate-limited so the fold is a flight and
		// not a teleport. It bounds the OFFSET — the unit's distance from its
		// own wake point — never its position in the world.
		const want = Math.hypot(oN, oB);
		const step = SPEED_MAX * dt;
		// Blocked: the envelope closes on the offset the unit actually HAS, so
		// that the 0.3 s the spec gives the fold is what the fold takes —
		// rather than the doctrine's own tau, which is up to 0.8 s and left a
		// unit 0.45 m inside a wall on the way round a hairpin.
		let r = this._maxR[k];
		if (this.blocked[k]) {
			const have = Math.hypot(this._o[o], this._o[o + 1], this._o[o + 2]);
			if (have < r) r = have;
		}
		this._maxR[k] = want > r ? Math.min(want, r + step) : Math.max(want, r - dt * MAX_RADIUS_FALL);
	}

	// One unit, one frame. Reads the wake at its own head `s`, holds its offset
	// in the frame there, and never leaves that description — which is why it
	// cannot end up somewhere no ray has answered about.
	_fly(k, dt, fence, wx, wy, wz) {
		const o = 3 * k, f = 12 * k;
		const om = 1 / this.tau;
		const px = this.pos[o], py = this.pos[o + 1], pz = this.pos[o + 2];
		const vpx = this.vel[o], vpy = this.vel[o + 1], vpz = this.vel[o + 2];

		// Per-unit gust: the same wind, not at the same instant.
		const gust = 0.85 + 0.3 * Math.sin(this._clock * 0.7 + this.phase[k]);
		this._wind.x = wx * gust; this._wind.y = wy * gust; this._wind.z = wz * gust;
		// Air drag, the same model as quad.js and attitudeFrom(): this is what
		// makes the wind push the unit around instead of decorating it.
		const rx = vpx - this._wind.x, ry = vpy - this._wind.y, rz = vpz - this._wind.z;
		const sp = Math.hypot(rx, ry, rz);
		const dg = SWARM_UNIT.bodyDrag, mass = SWARM_UNIT.mass;
		const dx = this._sep[o] - dg.x * sp * rx / mass;
		const dy = this._sep[o + 1] - dg.y * sp * ry / mass;
		const dz = this._sep[o + 2] - dg.z * sp * rz / mass;
		// Everything that is not the doctrine — wind, drag, separation — acts
		// on the OFFSET, in the track frame. At margin 0 the radius is 0, so
		// none of it can move a unit off the wake. That is deliberate: a gust
		// is not a reason to be inside a wall.
		const aT = dx * this._frame[f] + dy * this._frame[f + 1] + dz * this._frame[f + 2];
		const aN = dx * this._frame[f + 3] + dy * this._frame[f + 4] + dz * this._frame[f + 5];
		const aB = dx * this._frame[f + 6] + dy * this._frame[f + 7] + dz * this._frame[f + 8];

		// The offset: three critically damped springs on three scalars.
		const oT0 = this._o[o], oN0 = this._o[o + 1], oB0 = this._o[o + 2];
		let acT = om * om * (this._ot[o] - oT0) - 2 * om * this._ov[o] + aT;
		let acN = om * om * (this._ot[o + 1] - oN0) - 2 * om * this._ov[o + 1] + aN;
		let acB = om * om * (this._ot[o + 2] - oB0) - 2 * om * this._ov[o + 2] + aB;
		const an = Math.hypot(acT, acN, acB);
		if (an > ACCEL_MAX) { const g = ACCEL_MAX / an; acT *= g; acN *= g; acB *= g; }
		let ovT = this._ov[o] + acT * dt, ovN = this._ov[o + 1] + acN * dt, ovB = this._ov[o + 2] + acB * dt;
		const ovn = Math.hypot(ovT, ovN, ovB);
		if (ovn > SPEED_MAX) { const g = SPEED_MAX / ovn; ovT *= g; ovN *= g; ovB *= g; }
		let oT = oT0 + ovT * dt, oN = oN0 + ovN * dt, oB = oB0 + ovB * dt;
		// The radius the margin bought, and not a centimetre more.
		const orad = Math.hypot(oT, oN, oB);
		if (orad > this._maxR[k]) {
			const g = orad > 1e-12 ? this._maxR[k] / orad : 0;
			oT *= g; oN *= g; oB *= g;
		}

		// The reading head: a critically damped spring on a scalar whose target
		// advances at one second per second. Capped so the unit never reads the
		// wake faster than the airframe could fly it — that cap, and nothing
		// else, is what makes the swarm fall behind at full stick and catch up
		// afterwards.
		const speed = this._frame[f + 9];
		let sv = this._sv[k] + (om * om * (this._sStar[k] - this._s[k]) + 2 * om * (1 - this._sv[k])) * dt;
		if (sv < 0) sv = 0;
		if (speed > 1e-6) { const cap = SPEED_MAX / speed; if (sv > cap) sv = cap; }
		let sNew = this._s[k] + sv * dt;
		// Never read ahead of what the doctrine asked for: past `_sStar` lies
		// extrapolation nobody bounded, and at margin 0 `_sStar` is the newest
		// sample — which is what keeps the anchor ON the polyline.
		if (sNew > this._sStar[k]) sNew = this._sStar[k];
		// And never past the newest RECORDED sample either, beyond what being
		// a scout with a live margin buys. `time` runs ahead of the last write
		// by up to one wake period, so without this a folded scout read 3 ms
		// of extrapolation — 4.8 cm off its own wake, for nothing.
		if (this._count > 0) {
			const newest = this._wt[this._head] + (this.lag[k] < 0 ? AHEAD_MAX_S * this.margin[k] : 0);
			if (sNew > newest) sNew = newest;
		}
		// The tail: a unit outrun for longer than the ring is long has nothing
		// left to read. It follows the oldest entry there is — exactly, so it
		// stays on the wake — and that entry jumps forward by a whole SAMPLE
		// when a write retires one. That is the one case where a unit covers
		// more ground in a frame than its own airframe would, and the bound is
		// the node's speed times the LARGEST GAP the ring holds over the frame
		// length: at a steady 60 fps that gap is the 20 ms write period, but a
		// 250 ms hitch leaves a 267 ms gap in the ring, and a unit at the tail
		// then covers 5.9 m in the next 16 ms frame. Being on the wake matters
		// more than the bound — but the bound is that, not WAKE_DT_S.
		const floor = this._oldestT();
		let pinned = false;
		if (this._count > 0 && sNew < floor) { sNew = floor; pinned = true; }

		// Place it; and if a frame's worth of movement asks more of the
		// airframe than it has, walk the whole step back rather than break the
		// description: γ scales the advance of BOTH the head and the offset, so
		// the unit is exactly `anchor(s) + frame(s)·o` at every γ.
		let gamma = 1, ok = false;
		for (let i = 0; i < 8 && !ok; i++) {
			this._place(k, this._s[k] + gamma * (sNew - this._s[k]),
				oT0 + gamma * (oT - oT0), oN0 + gamma * (oN - oN0), oB0 + gamma * (oB - oB0), fence);
			const step = Math.hypot(this._trial[0] - px, this._trial[1] - py, this._trial[2] - pz);
			ok = step <= SPEED_MAX * dt + 1e-9;
			if (!ok && i < 7) gamma *= 0.5;
		}
		// γ cannot walk back the tail discontinuity (the position is the same
		// for every γ once the head is pinned), so the limiter is skipped
		// there and applies only where it can help.
		if (!ok && !pinned) {
			const ex = this._trial[0] - px, ey = this._trial[1] - py, ez = this._trial[2] - pz;
			const len = Math.hypot(ex, ey, ez), cap = SPEED_MAX * dt;
			if (len > cap && len > 1e-12) {
				const g = cap / len;
				this._trial[0] = px + ex * g; this._trial[1] = py + ey * g; this._trial[2] = pz + ez * g;
			}
		}
		const sFinal = this._s[k] + gamma * (sNew - this._s[k]);
		oT = oT0 + gamma * (oT - oT0); oN = oN0 + gamma * (oN - oN0); oB = oB0 + gamma * (oB - oB0);
		this._sv[k] = (sFinal - this._s[k]) / dt;
		this._s[k] = sFinal;
		this._ov[o] = (oT - oT0) / dt; this._ov[o + 1] = (oN - oN0) / dt; this._ov[o + 2] = (oB - oB0) / dt;
		this._o[o] = oT; this._o[o + 1] = oN; this._o[o + 2] = oB;
		this.pos[o] = this._trial[0]; this.pos[o + 1] = this._trial[1]; this.pos[o + 2] = this._trial[2];

		// Velocity and acceleration are MEASURED off the motion that actually
		// happened, so nothing a clamp does is invisible to the attitude.
		const vx = (this.pos[o] - px) / dt, vy = (this.pos[o + 1] - py) / dt, vz = (this.pos[o + 2] - pz) / dt;
		this.vel[o] = vx; this.vel[o + 1] = vy; this.vel[o + 2] = vz;
		let ax = (vx - vpx) / dt, ay = (vy - vpy) / dt, az = (vz - vpz) / dt;
		const am = Math.hypot(ax, ay, az);
		if (am > ACCEL_MAX) { const g = ACCEL_MAX / am; ax *= g; ay *= g; az *= g; }
		this.acc[o] = ax; this.acc[o + 1] = ay; this.acc[o + 2] = az;
		this._attitude(k, dt);
	}

	// Puts unit k at wake time `s` with offset (oT, oN, oB) into `_trial`, and
	// stores the anchor and frame it used. The fence may pull the result in —
	// never out: a clamp that LENGTHENED the offset would be the fence putting
	// a unit somewhere the wake never went, which is exactly the hole the first
	// version had (a live trust circle shrinking under the player pushed a unit
	// 59 m off its own wake with every ray blocked).
	_place(k, s, oT, oN, oB, fence) {
		const o = 3 * k, f = 12 * k;
		const w = this._read(s);
		this._readIdx[k] = this._before(s);
		this._frameOf(w, this._frame, f);
		this._anchor[o] = w.x; this._anchor[o + 1] = w.y; this._anchor[o + 2] = w.z;
		let x = w.x + this._frame[f] * oT + this._frame[f + 3] * oN + this._frame[f + 6] * oB;
		let y = w.y + this._frame[f + 1] * oT + this._frame[f + 4] * oN + this._frame[f + 7] * oB;
		let z = w.z + this._frame[f + 2] * oT + this._frame[f + 5] * oN + this._frame[f + 8] * oB;
		if (fence) {
			const before = Math.hypot(x - w.x, y - w.y, z - w.z);
			this._p.x = x; this._p.y = y; this._p.z = z;
			this._fencePoint(this._p, fence);
			const after = Math.hypot(this._p.x - w.x, this._p.y - w.y, this._p.z - w.z);
			if (after <= before + 1e-9) { x = this._p.x; y = this._p.y; z = this._p.z; }
		}
		this._trial[0] = x; this._trial[1] = y; this._trial[2] = z;
	}

	// ------------------------------------------------------- the ray budget
	//
	// One obstruction test per unit and per turn, over the only stretch that is
	// not the wake: the offset box around the unit's own anchor (see _cast()).
	// A unit ahead is tested every turn — its slot is extrapolated, so nothing
	// has ever validated it — a unit behind one turn in three. Never more than
	// RAY_BUDGET casts, whatever the size and whatever the doctrine.
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
				const d = this._clock - this._due[k];
				if (d >= 0 && d > over) { over = d; best = k; }
			}
			if (best < 0) break;
			this._cast(terrain, best); budget--;
			this._due[best] = this._clock + REAR_PERIOD_S;
		}
	}

	// The segment: from the anchor, out past whichever of "the offset it has"
	// and "the offset it wants" is bigger on each axis — so the unit's own
	// position is always inside what was asked about — plus the overreach and
	// the track lookahead.
	_cast(terrain, k) {
		const o = 3 * k, f = 12 * k;
		// The segment runs from WHERE THE UNIT IS to where the doctrine wants it
		// to be, extended past that (see OVERREACH_M / LOOKAHEAD_S). Starting
		// it at the unit's own position is what makes "the unit is inside what
		// was asked about" true rather than nearly true: the earlier version
		// started at the anchor and reached to whichever of the held and the
		// wanted offset was bigger, which loses the unit whenever the two have
		// opposite signs — i.e. every time the track frame turns over in a
		// hairpin, which is exactly when it matters (measured 4.7% of casts,
		// the unit up to 7.2 m from the segment asked about).
		const ax = this.pos[o], ay = this.pos[o + 1], az = this.pos[o + 2];
		const eT = Math.abs(this._o[o]) > Math.abs(this._ot[o]) ? this._o[o] : this._ot[o];
		let eN = Math.abs(this._o[o + 1]) > Math.abs(this._ot[o + 1]) ? this._o[o + 1] : this._ot[o + 1];
		const eB = Math.abs(this._o[o + 2]) > Math.abs(this._ot[o + 2]) ? this._o[o + 2] : this._ot[o + 2];
		// The overreach goes on the lateral axis, the one buildings bite: out
		// past the offset in its own direction, or on the doctrine's side when
		// the offset is folded flat.
		const side = eN !== 0 ? Math.sign(eN) : (this.lat[k] >= 0 ? 1 : -1);
		eN += side * OVERREACH_M;
		// The lookahead has to cover the ground this unit will cross before it is
		// asked again — which is the time since it was LAST asked, and that is
		// a frame at 60 fps and a second at 4. Reading it off the turnstile
		// rather than assuming a frame rate is what makes a 250 ms frame behave
		// like a slow flight instead of like a blind one.
		const since = Math.min(1, this._clock - this._lastCast[k]);
		this._lastCast[k] = this._clock;
		// Two candidate ends, and the ray takes the FARTHER of them: one measured
		// off the unit's own anchor and frame — the wake point it is actually
		// hanging from — and one off the slot's, where the doctrine is pulling
		// it. Neither alone is enough. Only the slot's, and a unit 45 m adrift
		// hears about the wall beside where it wishes it were instead of the
		// one beside it. Only its own, and a scout on a 250 ms frame is never
		// asked about the extrapolation it is being carried into. The farther
		// end is the conservative one: a longer segment can only find more
		// material, never less.
		const fwdA = eT + (LOOKAHEAD_S + since) * this._frame[f + 9] * this.margin[k];
		const ex = this._anchor[o] + this._frame[f] * fwdA + this._frame[f + 3] * eN + this._frame[f + 6] * eB;
		const ey = this._anchor[o + 1] + this._frame[f + 1] * fwdA + this._frame[f + 4] * eN + this._frame[f + 7] * eB;
		const ez = this._anchor[o + 2] + this._frame[f + 2] * fwdA + this._frame[f + 5] * eN + this._frame[f + 8] * eB;
		const fwdB = eT + (LOOKAHEAD_S + since) * this._sFrame[f + 9] * this.margin[k];
		const sx = this._sAnchor[o] + this._sFrame[f] * fwdB + this._sFrame[f + 3] * eN + this._sFrame[f + 6] * eB;
		const sy = this._sAnchor[o + 1] + this._sFrame[f + 1] * fwdB + this._sFrame[f + 4] * eN + this._sFrame[f + 7] * eB;
		const sz = this._sAnchor[o + 2] + this._sFrame[f + 2] * fwdB + this._sFrame[f + 5] * eN + this._sFrame[f + 8] * eB;
		const dA = (ex - ax) ** 2 + (ey - ay) ** 2 + (ez - az) ** 2;
		const dB = (sx - ax) ** 2 + (sy - ay) ** 2 + (sz - az) ** 2;
		const r = dA >= dB
			? terrain.obstructionBetween(ax, ay, az, ex, ey, ez)
			: terrain.obstructionBetween(ax, ay, az, sx, sy, sz);
		this.raysCast++; this.raysLastFrame++;
		// geometrySafe()'s rule: blocked AND thicker than 2 m. A roof edge
		// clipped tangentially is not a wall.
		this.blocked[k] = (r && r.blocked && r.span > BLOCK_SPAN_M) ? 1 : 0;
		if (!this.blocked[k]) {
			this._green[k] = this._clock + MARGIN_FRESH_S;
			this._greenAt[o] = this._anchor[o]; this._greenAt[o + 1] = this._anchor[o + 1]; this._greenAt[o + 2] = this._anchor[o + 2];
		}
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

	// Is this point inside the fence at all? Used by the selftest, and cheap
	// enough that swarm-drones.js may use it for debug overlays.
	insideFence(x, y, z, fence) {
		if (!fence) return true;
		this._p.x = x; this._p.y = y; this._p.z = z;
		if (fence.bbox) return horizontalMargin(this._p, fence.bbox) >= 0 && verticalMargin(this._p, fence.bbox) >= 0;
		if (fence.center && fence.radius > 0) return Math.hypot(x - fence.center.x, z - fence.center.z) <= fence.radius;
		return true;
	}

	// ------------------------------------------------------------ attitude
	//
	// Straight out of src/drone-kinematics.js, exactly like the ambients: the
	// acceleration tilts the machine, nlerp smooths it, clampTilt() holds the
	// 70° invariant on the quaternion that is actually rendered.
	_attitude(k, dt) {
		const o = 3 * k, q = 4 * k, f = 12 * k;
		let yawX = this.vel[o], yawZ = this.vel[o + 2];
		// Standing still: face the way the track was going at this unit's own
		// anchor, not wherever the last unit read.
		if (Math.hypot(yawX, yawZ) < 1e-6) { yawX = this._frame[f]; yawZ = this._frame[f + 2]; }
		if (Math.hypot(yawX, yawZ) < 1e-6) { yawX = 0; yawZ = -1; }
		this._att.ax = this.acc[o]; this._att.ay = this.acc[o + 1]; this._att.az = this.acc[o + 2];
		this._att.vx = this.vel[o]; this._att.vy = this.vel[o + 1]; this._att.vz = this.vel[o + 2];
		this._att.wind = this._wind;
		this._att.yawX = yawX; this._att.yawZ = yawZ;
		attitudeFrom(this._att, this._q, 0);
		const a = 1 - Math.exp(-dt / ATTITUDE_TAU);
		const d = this.quat[q] * this._q[0] + this.quat[q + 1] * this._q[1] + this.quat[q + 2] * this._q[2] + this.quat[q + 3] * this._q[3];
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

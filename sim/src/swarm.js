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
// Same bound for the vertical half of a scout's offset, and for the same
// reason: the forward probe follows the track's own tangent with no offset at
// all, so everything a scout holds sideways OR upwards of it is unasked-for.
export const AHEAD_VERTICAL_MAX_M = 3;

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

// THE FORWARD PROBE, and why a scout needs two margins rather than one.
//
// One ray used to answer for both halves of a scout's slot: the forward
// extrapolation AND the lateral offset. In a street they do not fail together
// — it is the 4 m of lateral that meets the wall, several times a second —
// but they were charged together, and the whole margin paid. Measured: a
// scout is asked every frame (60 casts/s) while a rear unit is asked every
// REAR_PERIOD_S (20/s), so the AIMD ceiling, charged per ray and rebuilt per
// second, breaks even at 0.2 / (0.25 * 60) = 1.3 % of blocked casts for a
// scout against 4 % for a rear unit. A real city is well past 1.3 %. Past it
// the ceiling pins the margin near 0, and at margin 0 the fold reads
// `fileLag`, which is POSITIVE — so a starved scout was filed 1.5 to 5 m
// BEHIND the node. Third of the swarm ahead by design, none of it ahead in
// flight; that is the bug this probe fixes.
//
// So the forward half gets its own ray and its own margin. The segment starts
// at the newest REAL wake sample and follows the track's own tangent with
// ZERO lateral and vertical offset: the volume the player is about to fly
// through, which is the safest extrapolation the scene has, and the same
// straight line every scout is carried along. Nothing else changes — the
// lateral probe, its margin, the fold, the offset envelope and every bound
// they hold are untouched, and a scout whose FORWARD probe really is blocked
// still drops into `fileLag` exactly as before.
//
// THE BUDGET IS STILL SIX RAYS A FRAME, and there are two reasons it fits.
//
// One: this costs ONE ray for the whole swarm, not one per scout. Every scout
// reading past the newest sample extrapolates from THAT sample along THAT
// tangent — `_read()` has no other answer to give — so their forward segments
// are collinear and share an origin, and the longest contains all the others.
// One cast at the deepest reach answers for every scout at once. Two rays per
// scout would have been 8 at size 12 and would not have fitted; one shared ray
// makes the peak 4 scouts + 2 in the pass-2 turnstile = 6, exactly as before.
//
// THAT COLLINEARITY IS INSTANTANEOUS, and the paragraph above reads like a
// standing guarantee, which it is not. It holds for the frame the probe is
// cast on. Between two casts the ring head advances and the tangent turns, so
// the line the scouts are actually being carried along drifts off the line
// that was cleared — measured up to 14.7 m PERPENDICULAR to it at 12 fps. The
// probe is a periodic sample of a moving line, exactly like the lateral probe,
// and it is bounded the same way: by the freshness rules, not by geometry.
// Scouts are not covered by the wake's own by-construction guarantee at all
// (issue #37).
//
// Two: the ray is not taken off the top. It queues in the pass-2 turnstile on
// the rear period, competing on overdue-ness like a rear unit, so it is one
// candidate among nine at size 12 rather than a standing tax. Spending it
// unconditionally every frame was tried and measured: it left ONE ray for
// eight rear units and at 20 fps the swarm folded into single file IN CLEAR
// SKY (mean margin 0.53 against 0.97), the exact failure this design exists
// to avoid. Queued instead, it costs the rear a ninth of its service; that is
// visible at 12 fps, where the worst penetration over 324 flights goes from
// 1.71 m to 2.39 m, and nowhere else — see the geometry block of the selftest.
//
// The floor is what makes recovery possible: at forward margin 0 the segment
// is still OVERREACH_M long, exactly as the lateral probe never shrinks below
// its own overreach. A zero-length segment would come back green for free and
// turn the AIMD into a bang-bang.

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
// There WAS a fourth staleness rule here, and it is gone: a verdict about a
// DIRECTION should go stale in ANGLE, so a tangent that had turned more than
// 0.1 rad away from the one the forward probe was cast on made the probe due
// at once. The reasoning is sound and the rule is inert. Re-measured over
// 3 240 hairpin flights built to be the regime where it must bite — 5
// geometries down to a 1.5 m hairpin in a 10 m street, 22/34/45 m/s, 60, 120
// AND 240 fps (the cadences where the rear period is many frames long and the
// rule has room to advance anything), sizes 6/9/12, 24 cluster seeds — the
// worst penetration is 0.000 m with the rule and 0.000 m without, and the
// share of scout-frames in front of the node moves by 0.2 points. What it
// does change is the bill: 6 to 9 % more forward probes, taken out of the
// rear units' share of a six-ray budget. A rule that cannot be told from its
// own absence except by what it spends is not a safety rule.
//
// How much track the forward probe reaches PAST the deepest scout, in seconds.
// It is small on purpose — the lateral probe's LOOKAHEAD_S is 0.8 s — and the
// number is a measured trade both ways.
//
// The BENEFIT it was introduced for does not reproduce. It was 0.027 m of a
// scout inside a hairpin's outer wall at 0 s; re-swept over 5 geometries, 8
// seeds per doctrine, sizes 6/8/10/12, 22/34/45 m/s, 60 and 120 fps, the worst
// penetration is 0.000 m at EVERY value including 0 — and 0.027 m was under
// the 0.15 m collision radius of a drone anyway.
//
// The COST is large and reproduces in every regime. Share of scout-frames in
// front of the pilot, 8 seeds per doctrine, four street slaloms, at 0 / 0.03 /
// 0.05 / 0.1 / 0.2 s:
//
//   15 m street, period 40, 15 m/s    75  72  66  51  30 %
//   10 m street, period 30, 15 m/s    74  69  64  57  42 %
//   12 m street, period 40, 14 m/s    86  77  79  79  65 %
//   12 m street, period 30, 17.7 m/s  11  10  10   5   1 %
//
// That is the whole point of the probe — keeping scouts AHEAD, which is what
// the pilot reported missing — being spent to buy nothing measurable.
//
// So 0.03 s rather than the 0.1 it replaces. Zero reads best on every line
// above, and the honest reason not to take it is that "no benefit" is a
// statement about the regimes swept, not a proof: 0.03 s keeps the probe
// reaching PAST the deepest scout, which is what it is for, for 3 to 9 points
// against the 24 to 30 that 0.1 costs.
const FWD_LOOKAHEAD_S = 0.03;

// A margin is only worth what the ray behind it is worth, and a ray goes stale
// two ways: in TIME, and in GROUND COVERED. The clock alone is not enough —
// the budget is six rays per FRAME, so on a 250 ms frame a unit is asked about
// its surroundings once every 22 m of city instead of once every 1.5 m, and a
// 4 m hairpin happens entirely between two questions. Past either bound the
// margin stops growing and starts falling, exactly as if the ray had come back
// blocked: unasked is not the same as cleared.
// Neither bound is a constant, because neither "often enough" nor "far enough"
// means anything on its own.
//
// The TIME bound is "until the turnstile was due back", read off how long this
// unit actually waited last time. A fixed 0.1 s was a 60 fps assumption in
// disguise: at 20 fps six rays a frame cannot honour it, every unit was
// permanently stale, and the swarm folded into single file IN CLEAR SKY (mean
// margin 0.44 against 0.94 — the failure this whole tranche exists to avoid).
//
// The GROUND bound is flat: past this much travel since the ray that cleared
// it, a unit is unasked whatever the clock says.
//
// And the third bound is the one that actually separates "a slow frame rate"
// from "a slow frame", because time and distance do not — a rear unit is asked
// every 5.3 m at 15 fps and every 22 m on a 250 ms frame, but the per-FRAME
// numbers are nearly the same. So the margin is bought PER GREEN RAY, not per
// second: one ray buys a tenth of it, whatever the frame length. At 60 fps a
// unit rises 0.033 per ray and never notices; at 15 fps it takes 2.7 s to
// deploy instead of 1.5; on a 250 ms frame it takes ten seconds, which is the
// caution that regime deserves.
const MARGIN_FRESH_S = 0.1;
const MARGIN_FRESH_GRACE = 2.0;
const MARGIN_FRESH_M = 6;
const MARGIN_RISE_PER_RAY = 0.09;

// A blocked unit loses its offsets in 0.3 s and folds back onto the pure wake
// — exactly where the player flew. They grow back in 1.5 s once the ray is
// green again.
export const MARGIN_FALL_S = 0.3;
export const MARGIN_RISE_S = 1.5;

// Fold and regrow alone make a bang-bang loop, and in a street barely wider
// than the doctrine's own lateral ambition that loop OSCILLATES: a unit folds
// on a red ray, redeploys on the next green one at up to 6 m/s sideways, and
// is back in the wall before the next verdict lands. Measured in a 12 m street
// with a 2.5 m hairpin, 60 fps, no hitch at all: 1.30 m inside a building,
// swinging from one side of the street to the other twice a second.
//
// So the margin also carries a CEILING, moved the way a congestion window is:
// a red ray drops it below what the unit was holding, and it only comes back
// additively. A unit that has just been told "wall" does not go back out as
// far as it was; a unit that is never blocked never sees the ceiling at all,
// so nothing is paid in open sky.
//
// It is NOT free everywhere, and the price is here rather than in a report:
//
//  - in open sky and in 15 m streets the mean margin is unchanged at every
//    cadence, and the offset actually held in the city goes UP (2.35 -> 2.58 m
//    at 60 fps) because the swarm stops spending its time crossing the street;
//  - but where the wake itself weaves — a slalom down a narrow street, every
//    unit blocked several times a second — the mean margin drops hard:
//    0.47 -> 0.29 in a 15 m street, 0.42 -> 0.26 in a 10 m one. The offset
//    HELD still goes up in those same runs (0.44 -> 0.52 m, 0.69 -> 0.90 m):
//    the swarm is more deployed with less margin, which is the oscillation
//    being gone, but the margin number itself is worse and would be read as a
//    regression by anyone who looked only at that;
//  - CEIL_RECOVER_PER_S is what a unit pays after the fact: coming out of a
//    city crossing into open sky, the swarm takes 3.48 s to get back to 90 %
//    of its nominal spread instead of 2.98 s. Raising it gives the time back
//    and gives the oscillation back with it;
//  - and at intermediate cadences the ceiling costs a little depth rather than
//    saving it: over 24 seeds x 6 geometries x 3 sizes, the worst penetration
//    at 20 fps goes 0.88 -> 1.08 m (at 15 fps it is 1.42 -> 1.43 m, i.e.
//    nothing). What it buys is 60 fps, where it is 1.30 -> 0.00 m.
const CEIL_BACKOFF = 0.25;
const CEIL_RECOVER_PER_S = 0.2;
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
// SURROUND, DO NOT TRAIL. The first real flight said it plainly: "the drones
// are too far from the master, I do not feel them around me". The doctrines
// used to spend their budget on LENGTH — up to 2.0 s of lag, which is 40 m of
// empty track behind the pilot at 20 m/s — and an FPV pilot looks FORWARD, so
// most of his swarm was never on screen at all.
//
// The fix is not to send more units ahead. Ahead means EXTRAPOLATING the track
// past the last validated sample, and the 0.4 s / 4 m forward window is the
// source of every penetration five rounds of fixes have just bounded. The
// lever is free instead: `lag` NEAR ZERO with generous lateral and vertical
// offsets. A unit at lag ~0.2 s reads the wake where the pilot was a moment
// ago — level with him, 9 m out to the side or 5 m above, inside the 105 deg
// field of the node's camera the moment he banks. No extrapolation, no extra
// ray: the lateral offset is exactly what the turnstile already validates.
//
// So `lagMax` collapses (2.0 -> 0.5 for the cloud), `vertical` grows, and the
// offsets are drawn AWAY from zero rather than uniformly across the envelope:
// a unit at 10 % of the envelope is a unit stacked on the node, and it costs a
// slot without buying any presence.
//
// The four doctrines stay DISTINCT and each is meant to be recognisable — they
// become the formation catalogue the pilot switches between in flight (#34).
// `column` is deliberately the one that still trails: it is the "file" mode,
// and it only reads as a choice because the other three surround.
//
//   column  a thin file in your tracks, two scouts, strung out over a second
//   wedge   a V whose vertex is the pilot: arms sweep out and back
//   cloud   a ball around the node: the widest vertical, the loosest tau
//   screen  a flat wide line abreast: the widest lateral, almost no depth
//
// `scouts` overrides the "about a third of them ahead" rule: a column has two
// scouts and a tail, not four abreast.
export const DOCTRINES = {
	column: { lagMin: -0.25, lagMax: 1.1, lateral: 2.5, vertical: 1.5, tau: 0.25, scouts: 2 },
	wedge: { lagMin: -0.4, lagMax: 0.45, lateral: 9, vertical: 3, tau: 0.35 },
	cloud: { lagMin: -0.4, lagMax: 0.5, lateral: 9, vertical: 6, tau: 0.80 },
	screen: { lagMin: -0.4, lagMax: 0.18, lateral: 12, vertical: 1.5, tau: 0.50 },
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
		// The floor matters as much as the ceiling: a unit drawn at 10 % of the
		// envelope sits on the node's own line and is neither seen nor felt.
		// Every doctrine but the column keeps its units out on the flanks.
		if (name === 'wedge') width = d.lateral * Math.min(1, 0.35 + 0.65 * Math.abs(s));
		else if (name === 'column') width = d.lateral * (0.2 + 0.5 * rand());
		else width = d.lateral * (0.55 + 0.45 * rand());
		if (ahead) width = Math.min(width, AHEAD_LATERAL_MAX_M);
		// Vertical alternates on its OWN parity, two units at a time, so that
		// "up" and "left" do not end up meaning the same thing: with a single
		// k % 2 side every left unit was also the high one and the swarm was a
		// tilted plane rather than a volume. Same reasoning as the width for
		// the magnitude — one above and one below is most of the sensation of
		// being inside something.
		//
		// It is NOT symmetric, and the camera is why: the node's lens is
		// uptilted 10-20 deg, so a unit above the pilot is in frame while its
		// mirror image below is under the bottom edge. Measured on the cloud,
		// which has the tallest envelope: a symmetric +-7 m draw put 7 % of the
		// swarm in frame at 10 m/s against 18 % before this tranche — the low
		// units were spending the envelope and buying nothing. Down gets half
		// the reach, which is also half the reach towards the ground.
		const vSide = (k % 4 < 2) ? 1 : -1;
		let up = d.vertical * (vSide > 0 ? 0.45 + 0.55 * rand() : 0.30 + 0.35 * rand());
		// A scout's vertical is capped like its lateral: it is the one offset
		// held over EXTRAPOLATED track, and 7 m of it points the unit at a roof
		// the forward probe never asked about.
		if (ahead) up = Math.min(up, AHEAD_VERTICAL_MAX_M);
		lag[k] = l;
		lat[k] = side * width;
		vert[k] = vSide * up;
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
		this._riseLeft = new Float64Array(n); // how much margin this unit's last green ray still buys
		this._ceil = new Float64Array(n);     // AIMD ceiling on the margin, see CEIL_BACKOFF
		this._wasBlocked = new Uint8Array(n); // the previous verdict, OR'd into this one
		// The forward probe: one ray and one margin for every scout at once,
		// see THE FORWARD PROBE above. Same freshness and AIMD law as a unit's
		// own margin, one scalar instead of an array.
		this._fwdMargin = 0;
		this._fwdCeil = 1;
		this._fwdBlocked = 1;
		this._fwdWasBlocked = 1;
		this._fwdGreen = 0;
		this._fwdRiseLeft = 0;
		this._fwdLastCast = 0;
		this._fwdDue = 0;
		this._fwdGreenAt = new Float64Array(3);
		// How deep, in seconds of track, the deepest scout asks to be carried.
		// Fixed by the slots, so the probe's reach is known without a scan.
		let deepest = 0;
		for (let k = 0; k < n; k++) if (-this.lag[k] > deepest) deepest = -this.lag[k];
		this._aheadS = deepest;
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
		this._riseLeft.fill(0);
		this._ceil.fill(1);
		this._wasBlocked.fill(1);
		this._fwdMargin = 0;
		this._fwdCeil = 1;
		this._fwdBlocked = 1;
		this._fwdWasBlocked = 1;
		this._fwdGreen = 0;
		this._fwdRiseLeft = 0;
		this._fwdLastCast = 0;
		this._fwdDue = 0;
		this._fwdGreenAt.fill(0);
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

		// 1. What the doctrine asks for this frame, then the rays that judge it,
		//    then the margins that answer. The rays describe the units where
		//    they are at the start of the frame, which is where they are when
		//    asked — but `_slotOf()` above has already run on LAST frame's
		//    verdict, so a doctrine that turns a unit towards a wall gets one
		//    frame of it before the fold starts. One frame of latency, and no
		//    way around it inside a single pass.
		for (let k = 0; k < n; k++) this._slotOf(k, time, dt);
		this._castRays(terrain);
		// The forward margin, on the same law as a unit's own: it decides how
		// far ahead a scout may read, and nothing else.
		{
			const g = this._fwdGreenAt;
			const hx = this._count ? this._wx[this._head] : g[0];
			const hy = this._count ? this._wy[this._head] : g[1];
			const hz = this._count ? this._wz[this._head] : g[2];
			const moved = Math.hypot(hx - g[0], hy - g[1], hz - g[2]);
			const fresh = !this._fwdBlocked && this._clock <= this._fwdGreen && moved <= MARGIN_FRESH_M;
			this._fwdCeil = Math.min(1, this._fwdCeil + dt * CEIL_RECOVER_PER_S);
			if (!fresh) {
				this._fwdMargin = clamp01(this._fwdMargin - dt / MARGIN_FALL_S);
			} else {
				const step = Math.min(dt / MARGIN_RISE_S, this._fwdRiseLeft);
				this._fwdRiseLeft -= step;
				this._fwdMargin = Math.min(this._fwdCeil, clamp01(this._fwdMargin + step));
			}
		}
		for (let k = 0; k < n; k++) {
			const o = 3 * k;
			const moved = Math.hypot(this._anchor[o] - this._greenAt[o], this._anchor[o + 1] - this._greenAt[o + 1], this._anchor[o + 2] - this._greenAt[o + 2]);
			const fresh = !this.blocked[k] && this._clock <= this._green[k] && moved <= MARGIN_FRESH_M;
			// The ceiling recovers on the clock, not per ray: it is the memory of
			// having been blocked here, and that memory should fade with time.
			this._ceil[k] = Math.min(1, this._ceil[k] + dt * CEIL_RECOVER_PER_S);
			if (!fresh) { this.margin[k] = clamp01(this.margin[k] - dt / MARGIN_FALL_S); continue; }
			const step = Math.min(dt / MARGIN_RISE_S, this._riseLeft[k]);
			this._riseLeft[k] -= step;
			this.margin[k] = Math.min(this._ceil[k], clamp01(this.margin[k] + step));
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
		// Ahead is bought by the FORWARD margin, sideways by the unit's own:
		// a scout whose lateral probe is dead still leads the node as long as
		// the corridor in front of the player is clear. Folding it into the
		// file on a lateral verdict is what emptied the pilot's field of view.
		const mf = this._fwdMargin;
		const lagEff = lag < 0 ? lag * mf + (1 - mf) * this.fileLag[k] : lag;
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
			const newest = this._wt[this._head] + (this.lag[k] < 0 ? AHEAD_MAX_S * this._fwdMargin : 0);
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
	// has ever validated it — a unit behind one turn in three. On top of those,
	// ONE shared forward probe (see THE FORWARD PROBE) queues with the rear.
	// Never more than RAY_BUDGET casts, whatever the size and whatever the
	// doctrine.
	_castRays(terrain) {
		this.raysLastFrame = 0;
		// No ray provider (a boot frame, a scene still loading): nobody is
		// cleared, so every unit stays folded onto the pure wake. Degrading
		// towards single file is the whole point of the fallback.
		if (!terrain || !terrain.obstructionBetween) return;
		const n = this.size;
		this._turn++;
		let budget = RAY_BUDGET;
		// Pass 1: everyone ahead, every frame, for the LATERAL half of its
		// slot. At most scoutsFor() units, which is <= 4 at size 12 — it
		// always fits.
		for (let k = 0; k < n && budget > 0; k++) {
			if (this.lag[k] >= 0) continue;
			this._cast(terrain, k); budget--;
		}
		// Pass 2: the rear, and the forward probe with them. `_due` caps a
		// unit at one turn in three; among the candidates that are due, the
		// most overdue goes first, ties to the forward probe. That ordering is
		// not decoration — with the budget the scouts leave (2 casts for 8
		// units at size 12) a plain rotating cursor starved two units of the
		// twelve for the whole flight, measured. Overdue grows without bound
		// for a starved candidate, so it always wins in the end.
		//
		// The forward probe queues HERE, on the rear period, rather than being
		// taken off the top: a ray spent unconditionally every frame left one
		// single ray for eight rear units, and at 20 fps that starved them past
		// the freshness bound — the swarm folded into single file IN CLEAR SKY,
		// which is the exact failure the whole tranche exists to avoid. On the
		// rear period it is asked 20 times a second, so its own AIMD break-even
		// sits at 4 % of blocked casts like a rear unit's, not at 1.3 % like a
		// scout's — and a segment with no lateral reach is nowhere near 4 %.

		// When the forward probe is due, computed once for the frame. It queues
		// on the rear period like a rear unit; there is no angle rule on top of
		// that any more (see REAR_PERIOD_S for what was measured).
		let fwdDue = -1;
		if (this._aheadS > 0 && this._count > 0) fwdDue = this._clock - this._fwdDue;
		while (budget > 0) {
			let best = -1, over = -1;
			if (fwdDue >= 0) { over = fwdDue; best = -2; }
			for (let k = 0; k < n; k++) {
				if (this.lag[k] < 0) continue;
				const d = this._clock - this._due[k];
				if (d >= 0 && d > over) { over = d; best = k; }
			}
			if (best === -1) break;
			budget--;
			if (best === -2) { this._castFwd(terrain); this._fwdDue = this._clock + REAR_PERIOD_S; fwdDue = -1; continue; }
			this._cast(terrain, best);
			this._due[best] = this._clock + REAR_PERIOD_S;
		}
	}

	// The forward probe: the newest real wake sample, straight along the
	// track's own tangent, no lateral and no vertical offset at all. See THE
	// FORWARD PROBE above for why it is one ray and not one per scout, and why
	// this volume is the safest extrapolation the scene has.
	_castFwd(terrain) {
		const g = this._fwdGreenAt;
		const h = this._head;
		const ax = this._wx[h], ay = this._wy[h], az = this._wz[h];
		// The tangent and the track speed AT THE HEAD — the same pair every
		// scout past the newest sample extrapolates along.
		const w = this._read(this._wt[h]);
		const since = Math.min(1, this._clock - this._fwdLastCast);
		this._fwdLastCast = this._clock;
		// Exactly as deep as the deepest scout is being carried, plus the
		// ground the track covers before the next verdict, plus the floor that
		// keeps the segment real at forward margin 0. There is no LOOKAHEAD_S
		// here, unlike the lateral probe, and the difference is the whole
		// point: what the lateral probe anticipates is a unit being CARRIED
		// sideways into a wall by a track turning under it, but no scout is
		// ever carried further along the tangent than AHEAD_MAX_S — the
		// extrapolation is bounded and the wake turns with the player instead
		// of running on. A lookahead here measures where the straight line
		// leaves the street, not where anything goes: down a slalom it made
		// the probe red almost always and left the scouts FURTHER behind than
		// before the fix (11 % of scout-frames in front against 34 %).
		const reach = OVERREACH_M + w.speed * this._fwdMargin * (this._aheadS + FWD_LOOKAHEAD_S + since);
		const r = terrain.obstructionBetween(ax, ay, az, ax + w.tx * reach, ay + w.ty * reach, az + w.tz * reach);
		this.raysCast++; this.raysLastFrame++;
		const hit = (r && r.blocked && r.span > BLOCK_SPAN_M) ? 1 : 0;
		if (hit) this._fwdCeil = Math.max(0, Math.min(this._fwdCeil, this._fwdMargin) - CEIL_BACKOFF);
		this._fwdBlocked = (hit || this._fwdWasBlocked) ? 1 : 0;
		this._fwdWasBlocked = hit;
		if (!this._fwdBlocked) {
			this._fwdGreen = this._clock + Math.max(MARGIN_FRESH_S, MARGIN_FRESH_GRACE * since);
			this._fwdRiseLeft = MARGIN_RISE_PER_RAY;
			g[0] = ax; g[1] = ay; g[2] = az;
		}
	}

	// The segment: from the unit's own WAKE POINT, out past whichever of "the
	// offset it has" and "the offset it wants" is bigger on each axis, plus the
	// overreach and the track lookahead.
	//
	// What this does NOT give is "the unit is inside what was asked about".
	// That was true of the version that started the segment at the unit's own
	// position, and it was traded away deliberately (see below): measured over
	// 404 000 instrumented casts at 60 fps (24 cluster seeds, two speeds, the
	// corner and the hairpin), the unit sits a mean 1.8 m from the segment,
	// 62 % of casts beyond 1 m, 24 % beyond 3 m, worst 7.6 m — and the numbers
	// at 20 fps are the same to a tenth (60 %, 24 %, 7.9 m). What covers the
	// unit is not containment but the LATERAL REACH ON THE SIDE THE UNIT IS ON: the segment
	// leaves the wake towards the unit, past the larger of the two offsets,
	// plus OVERREACH_M. It is a probe of the corridor the unit lives in, not a
	// line through the unit.
	_cast(terrain, k) {
		const o = 3 * k, f = 12 * k;
		// The origin is the unit's own WAKE POINT, not its position: a segment
		// that starts inside a wall leaves it again within a metre and the
		// `span > 2 m` rule calls that clear (measured: a unit sitting 0.74 m
		// into a corner, ray green, at 60 fps with no hitch at all). Starting
		// on the wake means the segment crosses the whole thickness of whatever
		// it meets. A scout's own anchor is extrapolated, so it is not on the
		// wake and not a legal origin — it uses the newest real sample.
		let ax = this._anchor[o], ay = this._anchor[o + 1], az = this._anchor[o + 2];
		if (this._count > 0 && this._s[k] > this._wt[this._head]) {
			ax = this._wx[this._head]; ay = this._wy[this._head]; az = this._wz[this._head];
		}
		const eT = Math.abs(this._o[o]) > Math.abs(this._ot[o]) ? this._o[o] : this._ot[o];
		const eB = Math.abs(this._o[o + 2]) > Math.abs(this._ot[o + 2]) ? this._o[o + 2] : this._ot[o + 2];
		// The lateral reach goes out on the side the unit is ACTUALLY on, past
		// whichever of the held and the wanted offset is bigger, plus the
		// overreach. Taking the bigger of the two with its own sign lost the
		// unit whenever the two disagreed — i.e. every time the track frame
		// turns over in a hairpin, which is exactly when it matters. This is what
		// pays for the origin being back on the wake — not containment (the
		// unit can be metres off this segment, see the note above the method)
		// but a probe that leaves the wake towards the unit and reaches past
		// it, so a wall between the two, or just beyond, comes back as
		// material.
		const held = this._o[o + 1], want = this._ot[o + 1];
		const side = held !== 0 ? Math.sign(held) : (want !== 0 ? Math.sign(want) : (this.lat[k] >= 0 ? 1 : -1));
		const eN = side * (Math.max(Math.abs(held), Math.abs(want)) + OVERREACH_M);
		// The lookahead has to cover the ground this unit will cross before it is
		// asked again — which is the time since it was LAST asked, and that is
		// a frame at 60 fps and a second at 4. Reading it off the turnstile
		// rather than assuming a frame rate is what makes a 250 ms frame behave
		// like a slow flight instead of like a blind one.
		const since = Math.min(1, this._clock - this._lastCast[k]);
		this._lastCast[k] = this._clock;
		// Two ends, and which one is asked about depends on what the unit is.
		// A REAR unit is asked about its own surroundings: its anchor, its
		// frame. Aiming at its slot instead sends a 57 m diagonal down streets
		// it is not in, which comes back clear while it clips the corner it IS
		// in — 0.74 m deep, ray green, at 60 fps with no hitch at all. A SCOUT
		// is asked about its slot, because its slot is the extrapolation it is
		// being carried into and its own anchor is that same extrapolation one
		// frame stale — 1.4 m in, on a 250 ms frame, when it was asked about
		// the stale one. Neither is a superset of the other: when the two
		// frames diverge, one segment is not "the longer one" in any useful
		// sense. What is measured is that this split misses nothing the other
		// would have caught (0 misses in 2.5 M instrumented casts).
		const fwdA = eT + (LOOKAHEAD_S + since) * this._frame[f + 9] * this.margin[k];
		const ex = this._anchor[o] + this._frame[f] * fwdA + this._frame[f + 3] * eN + this._frame[f + 6] * eB;
		const ey = this._anchor[o + 1] + this._frame[f + 1] * fwdA + this._frame[f + 4] * eN + this._frame[f + 7] * eB;
		const ez = this._anchor[o + 2] + this._frame[f + 2] * fwdA + this._frame[f + 5] * eN + this._frame[f + 8] * eB;
		const fwdB = eT + (LOOKAHEAD_S + since) * this._sFrame[f + 9] * this.margin[k];
		const sx = this._sAnchor[o] + this._sFrame[f] * fwdB + this._sFrame[f + 3] * eN + this._sFrame[f + 6] * eB;
		const sy = this._sAnchor[o + 1] + this._sFrame[f + 1] * fwdB + this._sFrame[f + 4] * eN + this._sFrame[f + 7] * eB;
		const sz = this._sAnchor[o + 2] + this._sFrame[f + 2] * fwdB + this._sFrame[f + 5] * eN + this._sFrame[f + 8] * eB;
		const r = this.lag[k] < 0
			? terrain.obstructionBetween(ax, ay, az, sx, sy, sz)
			: terrain.obstructionBetween(ax, ay, az, ex, ey, ez);
		this.raysCast++; this.raysLastFrame++;
		// geometrySafe()'s rule: blocked AND thicker than 2 m. A roof edge
		// clipped tangentially is not a wall.
		const hit = (r && r.blocked && r.span > BLOCK_SPAN_M) ? 1 : 0;
		// Multiplicative-ish decrease: below what the unit is holding right now,
		// not below what it was allowed in principle.
		if (hit) this._ceil[k] = Math.max(0, Math.min(this._ceil[k], this.margin[k]) - CEIL_BACKOFF);
		this.blocked[k] = (hit || this._wasBlocked[k]) ? 1 : 0;
		this._wasBlocked[k] = hit;
		if (!this.blocked[k]) {
			this._green[k] = this._clock + Math.max(MARGIN_FRESH_S, MARGIN_FRESH_GRACE * since);
			this._riseLeft[k] = MARGIN_RISE_PER_RAY;
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

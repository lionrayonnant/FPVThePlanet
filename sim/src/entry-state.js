// PHASE 11 — Entry State. After JACK IN (and after every in-session respawn)
// the drone starts already in flight: a weighted category picks how gentle or
// hairy that moment is, a candidate is sampled anywhere in the scene, and two
// safety nets (geometry, then a headless physics rollout) reject anything
// that would crash before the player can touch a stick. See
// docs/superpowers/specs/2026-08-29-phase-11-entry-state-design.md.
//
// Runs both in the browser (bundled by Vite) and in Node (selftest) — no
// browser-only API, no `node:` import.

import { FlightController, hoverThrottle } from './flightController.js';
import { crashThreshold } from './quad.js';
import { Geofence } from './geofence.js';

export const CATEGORIES = ['COMFORTABLE', 'ACTIVE', 'CHALLENGING', 'HOLY_SHIT'];
export const WEIGHTS = [60, 25, 12, 3];

// FNV-1a hash of a string -> 32-bit seed, then xorshift (the same idiom as
// tools/target-model.mjs and src/link.js: small, deterministic, replayable).
//
// The middle shift is a SIGNED `>>`, which a textbook xorshift32 writes `>>>`.
// It is kept: the generator is still deterministic and still well distributed,
// but it is not the canonical map, and every seeded thing in the game — entry
// states, target scans, the dialogue draw, the liveries — would come out
// different if it were corrected. Nine files carry a copy of this function,
// and tools/target-selftest.mjs freezes witness scans recorded before the
// swarm existed, which is a non-regression that re-recording would destroy.
// Correcting it is therefore one deliberate change to all of them at once, not
// a fix to be slipped into a file someone happens to be editing.
//
// What it costs, measured over the whole state space: the period from a
// typical seed is 536 870 911 rather than 2^32-1, and one state (0xFC001FFF)
// maps to 0, which is absorbing. That state has no preimage, so it is only
// reachable by being hashed into directly — about one seed string in four
// billion, and then rand() returns 0 for ever.
export function rngFrom(seed) {
	let h = 0x811c9dc5;
	const s = String(seed);
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	let x = h >>> 0 || 1;
	return () => {
		x ^= x << 13; x >>>= 0;
		x ^= x >> 17;
		x ^= x << 5; x >>>= 0;
		return x / 4294967296;
	};
}

export function pickCategory(rand) {
	const r = rand() * 100;
	let acc = 0;
	for (let i = 0; i < CATEGORIES.length; i++) {
		acc += WEIGHTS[i];
		if (r < acc) return CATEGORIES[i];
	}
	return CATEGORIES[CATEGORIES.length - 1];
}

const DEG = Math.PI / 180;

// Starting points, hand-picked like target-model.mjs's proportions — not
// measured, tunable to feel without touching the safety net (geometrySafe /
// rolloutSafe are what actually keep every draw fair).
export const RANGES = {
	COMFORTABLE: { aglM: [15, 40], speedMs: [2, 8], tiltDeg: [0, 10], rateDps: [0, 30] },
	ACTIVE: { aglM: [8, 25], speedMs: [8, 18], tiltDeg: [5, 25], rateDps: [20, 90] },
	CHALLENGING: { aglM: [3, 12], speedMs: [18, 30], tiltDeg: [20, 50], rateDps: [60, 200] },
	HOLY_SHIT: { aglM: [1.5, 5], speedMs: [25, 40], tiltDeg: [40, 80], rateDps: [150, 400] },
};

// The edge margin, now the fence's own (#139) rather than a local value. It
// used to be 10 m, which was enough not to draw a point beyond the last loaded
// chunk — but not enough to be born OUTSIDE the zone warning: R_CAUTION is tens
// of metres. A flight must never begin on a "NO COVERAGE".
//
// What is read is the scene's EFFECTIVE corridor (`effectiveCorridor.caution`)
// and not the R_CAUTION constant: the fence bounds its corridor to a third of
// the smallest half-side (geofence.js), so on a small map it warns FAR closer
// to the edge than 113 m. Taking the constant off each side would remove a band
// the fence does not ask for. Measured over the 25 scenes in public/scenes/: on
// parcdesprinces (half-sides 139 x 151 m) the constant would leave a band of
// only 51 x 76 m — 4.6 % of the footprint — where the effective corridor is
// 46.2 m and leaves 185 x 209. And on a map with a half-side under 113 m the
// inset would CROSS OVER (x0 > x1); the effective corridor, at most halfMin/3,
// cannot.
//
// A Geofence is built rather than the formula copied: it is what decides the
// bound, and there is no reason to keep a second copy of it here. The cost is
// nil — occupancyOf() only comes through on a cache miss, once per Physics
// instance.
//
// The margin is STRICT, and by construction rather than by luck: a draw is
// x = x0 + (i + rand()) * dx with 0 <= i <= cols-1, so x lies in ]x0, x1[ as
// long as rand() stays inside ]0, 1[. The upper bound holds for any 32-bit
// state (x / 2^32 < 1). The lower one holds for every state this generator
// actually visits, but NOT by the argument this comment used to make: see
// rngFrom() above — a state of 0 is unreachable from a non-zero one, yet the
// signed shift leaves exactly one seed that lands on 0 directly, and rand()
// then returns 0. A draw on x0 is what that would produce, and zoneOf()
// switching to CAUTION as soon as the margin is <= caution is what keeps it
// safe even then. The 10,000 draws in tools/selftest.mjs watch over it.
function edgeMarginOf(manifest) {
	return new Geofence(manifest.bbox).effectiveCorridor.caution;
}

function lerp(rand, [lo, hi]) { return lo + rand() * (hi - lo); }

function qAxisAngle(axis, angle) {
	const s = Math.sin(angle / 2);
	return { x: axis.x * s, y: axis.y * s, z: axis.z * s, w: Math.cos(angle / 2) };
}

function qMul(a, b) {
	return {
		x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
		y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
		z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
		w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
	};
}

// Local copy of flightController.js's rotate(): body-frame convention X=right,
// Y=up, Z=back (forward is -Z). No shared import — this file has no
// dependency on flightController.js beyond what rolloutSafe needs later.
function qRotateVec(q, v) {
	const tx = 2 * (q.y * v.z - q.z * v.y);
	const ty = 2 * (q.z * v.x - q.x * v.z);
	const tz = 2 * (q.x * v.y - q.y * v.x);
	return {
		x: v.x + q.w * tx + (q.y * tz - q.z * ty),
		y: v.y + q.w * ty + (q.z * tx - q.x * tz),
		z: v.z + q.w * tz + (q.x * ty - q.y * tx),
	};
}

const Y_AXIS = { x: 0, y: 1, z: 0 };
const X_AXIS = { x: 1, y: 0, z: 0 };
const Z_AXIS = { x: 0, y: 0, z: 1 };

// Height of the ground at an (x, z) with no prior y guess: cast from above the
// whole loaded scene downward, all the way to below it.
function groundAt(physics, manifest, x, z) {
	const top = manifest.bbox.max[1] + 50;
	const span = (manifest.bbox.max[1] - manifest.bbox.min[1]) + 100;
	return physics.groundBelow(x, top, z, span);
}

// Where, in this scene, is there any ground?
//
// The draw used to pick a point anywhere in the manifest bbox. A rectangular
// scene fills its own, so that worked. A scene traced with a polygon (issue
// #30) does not: on a river corridor, 315 draws out of 400 fell into the void,
// and generateEntryState() ended up falling back to a resting spawn — exactly
// what PHASE 13 exists to avoid.
//
// So a coarse grid is swept once, and the draw only ever picks from the cells
// that have ground. The sweep costs a few thousand rays; it replaces thousands
// of wasted draws.
//
// Cell size follows a slippy tile at zoom 20 (~25 m): fine enough to hug a
// corridor, coarse enough for the sweep to stay short.
const OCCUPANCY_CELL_M = 25;
const OCCUPANCY_MAX_SIDE = 64;

// Keyed on the Physics instance: the mesh is what decides occupancy, and a
// WeakMap lets the whole thing go away with the scene.
const occupancyCache = new WeakMap();

export function occupancyOf(physics, manifest) {
	const cached = occupancyCache.get(physics);
	if (cached) return cached;

	const edgeMargin = edgeMarginOf(manifest);
	const x0 = manifest.bbox.min[0] + edgeMargin, x1 = manifest.bbox.max[0] - edgeMargin;
	const z0 = manifest.bbox.min[2] + edgeMargin, z1 = manifest.bbox.max[2] - edgeMargin;
	const cols = Math.max(1, Math.min(OCCUPANCY_MAX_SIDE, Math.round((x1 - x0) / OCCUPANCY_CELL_M)));
	const rows = Math.max(1, Math.min(OCCUPANCY_MAX_SIDE, Math.round((z1 - z0) / OCCUPANCY_CELL_M)));
	const dx = (x1 - x0) / cols, dz = (z1 - z0) / rows;

	const cells = [];
	for (let j = 0; j < rows; j++) {
		for (let i = 0; i < cols; i++) {
			// The centre of the cell: one point per cell is enough to say
			// "there is terrain around here", and the draw then picks at random
			// inside whichever cell it kept.
			if (groundAt(physics, manifest, x0 + (i + 0.5) * dx, z0 + (j + 0.5) * dz) !== null) {
				cells.push(j * cols + i);
			}
		}
	}

	// No cell hit: either the scene is empty, or it is finer than the grid. The
	// whole footprint is returned rather than an empty list, which lands exactly
	// on the previous behaviour — the draw rejects, and generateEntryState()
	// keeps its fallback.
	const grid = cells.length
		? { x0, z0, dx, dz, cols, rows, cells, cellSize: Math.min(dx, dz), full: cells.length === cols * rows }
		// One cell covering the whole footprint: its size is that footprint, not
		// the dx/dz of the grid that found nothing — those are still the
		// per-cell values computed above.
		: { x0, z0, dx: x1 - x0, dz: z1 - z0, cols: 1, rows: 1, cells: [0], cellSize: Math.min(x1 - x0, z1 - z0), full: true };

	occupancyCache.set(physics, grid);
	return grid;
}

export function sampleCandidate(category, manifest, physics, rand) {
	const ranges = RANGES[category];
	// On a full scene every cell is occupied and the draw becomes uniform in the
	// bbox again: the historical behaviour, untouched.
	const grid = occupancyOf(physics, manifest);
	const cell = grid.cells[Math.min(grid.cells.length - 1, Math.floor(rand() * grid.cells.length))];
	const x = grid.x0 + (cell % grid.cols + rand()) * grid.dx;
	const z = grid.z0 + (Math.floor(cell / grid.cols) + rand()) * grid.dz;
	const ground = groundAt(physics, manifest, x, z);
	if (ground === null) return null;
	const y = ground + lerp(rand, ranges.aglM);

	const heading = rand() * Math.PI * 2;
	const tilt = lerp(rand, ranges.tiltDeg) * DEG;
	const tiltSplit = rand();
	const pitch = tilt * tiltSplit * (rand() < 0.5 ? -1 : 1);
	const roll = tilt * (1 - tiltSplit) * (rand() < 0.5 ? -1 : 1);

	const qYaw = qAxisAngle(Y_AXIS, heading);
	const qPitch = qAxisAngle(X_AXIS, pitch);
	const qRoll = qAxisAngle(Z_AXIS, roll);
	const qYawPitch = qMul(qYaw, qPitch);
	const quaternion = qMul(qYawPitch, qRoll);

	// Velocity follows heading+pitch (where the nose points), not the roll bank
	// on top of it — banking turns the drone without turning its velocity.
	const forward = qRotateVec(qYawPitch, { x: 0, y: 0, z: -1 });
	const speed = lerp(rand, ranges.speedMs);
	const linvel = { x: forward.x * speed, y: forward.y * speed, z: forward.z * speed };

	// Body-frame rate split across the three axes, converted to world frame —
	// Physics.step()/Rapier expect angvel in world frame (see physics.js).
	const rateMag = lerp(rand, ranges.rateDps) * DEG;
	const split1 = rand(), split2 = rand();
	const bodyRate = {
		x: rateMag * split1 * (rand() < 0.5 ? -1 : 1),
		y: rateMag * (1 - split1) * split2 * (rand() < 0.5 ? -1 : 1),
		z: rateMag * (1 - split1) * (1 - split2) * (rand() < 0.5 ? -1 : 1),
	};
	const angvel = qRotateVec(quaternion, bodyRate);

	return { category, position: { x, y, z }, quaternion, linvel, angvel };
}

// How far ahead along the velocity direction the obstruction check looks, and
// how much of that stretch may legitimately be "material" (a roof edge
// clipped tangentially) before it counts as a wall in the way.
const LOOKAHEAD_M = 15;
const BLOCK_SPAN_M = 2;

export function geometrySafe(candidate, physics) {
	const { position, linvel } = candidate;
	const ground = physics.groundBelow(position.x, position.y, position.z);
	if (ground === null || position.y - ground < 1) return false;

	const speed = Math.hypot(linvel.x, linvel.y, linvel.z);
	if (speed < 1e-6) return true;
	const dir = { x: linvel.x / speed, y: linvel.y / speed, z: linvel.z / speed };
	const ahead = {
		x: position.x + dir.x * LOOKAHEAD_M,
		y: position.y + dir.y * LOOKAHEAD_M,
		z: position.z + dir.z * LOOKAHEAD_M,
	};
	const o = physics.obstructionBetween(position.x, position.y, position.z, ahead.x, ahead.y, ahead.z);
	if (o.blocked && o.span > BLOCK_SPAN_M) return false;
	return true;
}

const NEUTRAL_STICKS = { throttle: 0, roll: 0, pitch: 0, yaw: 0 };
const ROLLOUT_SECONDS = 1.0;

// Validates a candidate by living one second with it, unattended: sticks
// neutral, throttle held at whatever cancels gravity at the current tilt (a
// drone "already in flight" is already near its own trim, not at the
// throttle floor — see the design doc's decision on this). If a contact
// force ever exceeds the game's own crash threshold during that second, the
// candidate is rejected. Reuses the real Physics/FlightController — no
// second physics model.
export function rolloutSafe(candidate, physics) {
	physics.applyEntryState(candidate);
	const profile = physics.profile;
	const controller = new FlightController({ profile });
	controller.setMode('acro');
	const dt = physics.world.timestep;
	const steps = Math.round(ROLLOUT_SECONDS / dt);
	const sticks = { ...NEUTRAL_STICKS };
	for (let i = 0; i < steps; i++) {
		sticks.throttle = hoverThrottle(profile, physics.rotation);
		const { motors } = controller.update(sticks, physics, dt);
		const impact = physics.step(motors, dt);
		if (impact > 0 && impact > crashThreshold(physics.rotation)) return false;
	}
	return true;
}

const DEFAULT_MAX_ATTEMPTS = 20;

// Which category this entry uses: the one the bench asked for, or the weighted
// draw of Bible §20. Split out of generateEntryState() so it can be checked
// without a scene and without a Physics — the rest of that function cannot.
//
// An unknown forced value falls back to the draw rather than throwing: the
// bench normalises its own config, so anything arriving here that isn't a
// category is a bug elsewhere, and a bug elsewhere should not stop a flight.
//
// Note that forcing skips pickCategory(), so the sampling stream starts one
// draw earlier for the same seed. FIELD never forces, so its sequence is
// untouched, seed for seed.
export function resolveCategory(forced, rand) {
	return forced && CATEGORIES.includes(forced) ? forced : pickCategory(rand);
}

// A ceiling on how hairy a drawn entry may be. CATEGORIES is ordered gentlest
// first, so this is just an index clamp.
//
// It exists for the keyboard. The weighted draw gives HOLY_SHIT 3 % of the
// time — 25-40 m/s, up to 80 degrees of bank, 1.5 m off the deck — which is a
// fine thing to inherit with a proportional stick in your hands and an
// impossible one with four arrow keys. main.js caps a keyboard-only pilot at
// ACTIVE (18 m/s, 25 degrees) and passes nothing at all when a pad is present,
// so the gamepad draw is untouched, weight for weight.
//
// A forced category (the bench's own choice) is NOT capped: asking for
// HOLY_SHIT at the bench is a request, not a draw, and the bench is where you
// go to ask for things. An unknown ceiling is ignored rather than throwing —
// same rule as resolveCategory().
export function capCategory(category, maxCategory) {
	const ceiling = CATEGORIES.indexOf(maxCategory);
	if (ceiling < 0) return category;
	const at = CATEGORIES.indexOf(category);
	if (at < 0) return category;
	return CATEGORIES[Math.min(at, ceiling)];
}

// The rectangle a flight is allowed to begin in: the bbox minus the scene's
// effective CAUTION corridor, exactly the one occupancyOf() uses for the draw.
// Pulled out into a function because the FALLBACK now has to come back into it
// as well (issue #149).
//
// The corridor bound (halfMin/3, geofence.js) forbids the inset from crossing
// over on a real map. A degenerate bbox — the bench, where there is no map —
// can: it falls back to the centre rather than returning a reversed interval.
export function insetRect(manifest) {
	const m = edgeMarginOf(manifest);
	const { min, max } = manifest.bbox;
	let x0 = min[0] + m, x1 = max[0] - m;
	let z0 = min[2] + m, z1 = max[2] - m;
	if (x0 > x1) { const c = (min[0] + max[0]) / 2; x0 = x1 = c; }
	if (z0 > z1) { const c = (min[2] + max[2]) / 2; z0 = z1 = c; }
	return { x0, x1, z0, z1 };
}

// zoneOf() switches to CAUTION as soon as the margin is <= caution, so landing
// EXACTLY on the edge of the inset would still be born inside the warning. Come
// in by a small length, bounded by half the side so it can never cross over.
const INSET_EPS_M = 0.5;

const clampInto = (v, lo, hi) => {
	const eps = Math.min(INSET_EPS_M, (hi - lo) / 2);
	return Math.min(hi - eps, Math.max(lo + eps, v));
};

// The height above ground given back to a fallback that had to be moved:
// geometrySafe() already demands more than a metre, and a fallback is meant to
// be the calmest point in the scene, not the tightest.
const FALLBACK_CLEARANCE_M = 2;

// The fallback point, at rest. Exported for the bench (PHASE 26), where sitting
// on the ground at idle is a state you ask for, not the one you end up in after
// twenty failed draws.
//
// manifest.spawn is NOT constrained by the fence: measured over the 25
// manifests in public/scenes/, it falls in HOLD on parcdesprinces and in
// CAUTION on bastille and triomphe (issue #149). A fallback — or any path that
// starts again from there — therefore began the flight on a "NO COVERAGE", and
// on parcdesprinces with the fence push already active.
//
// So the point is brought back into the inset. Moving it horizontally without
// touching its altitude would put it inside a building or under the terrain: as
// soon as there is a Physics, it is PUT BACK DOWN on the ground that is really
// there. Without a Physics (a manifest-only call), what can be corrected is —
// the x/z — and the y is left alone, which is still strictly better than the
// original point.
//
// manifest.spawn itself is not touched: it stays the ground station's position
// (main.js's `emitter`), which has no reason to move.
export function fallbackCandidate(manifest, physics = null) {
	const { x0, x1, z0, z1 } = insetRect(manifest);
	const spawn = manifest.spawn;
	const x = clampInto(spawn.x, x0, x1);
	const z = clampInto(spawn.z, z0, z1);

	let y = spawn.y;
	const moved = x !== spawn.x || z !== spawn.z;
	if (moved && physics) {
		const ground = groundAt(physics, manifest, x, z);
		if (ground !== null) {
			// Keep the original ground clearance when it is measurable and more
			// generous: a spawn already perched must not end up stuck to the
			// roof it has just been moved onto.
			const from = groundAt(physics, manifest, spawn.x, spawn.z);
			const agl = from === null ? FALLBACK_CLEARANCE_M : Math.max(FALLBACK_CLEARANCE_M, spawn.y - from);
			y = ground + agl;
		}
	}

	return {
		category: 'COMFORTABLE',
		position: { x, y, z },
		quaternion: { x: 0, y: 0, z: 0, w: 1 },
		linvel: { x: 0, y: 0, z: 0 },
		angvel: { x: 0, y: 0, z: 0 },
	};
}

// Never returns null: after maxAttempts unsuccessful draws it falls back to
// manifest.spawn at rest, which trivially satisfies both safety nets (it's
// exactly what physics.reset() has always spawned into).
//
// `category` and `idle` are the bench's two overrides (PHASE 26) and nothing
// else passes them. Omitted, the draw is the weighted one of Bible §20, seed
// for seed and bit for bit — which is what keeps FIELD untouched by the
// existence of a bench.
//   category: 'ACTIVE'  force that category, still through both safety nets
//   idle: true          spawn at rest on the ground, no draw at all
//
// `maxCategory` is a third, and it is not the bench's: it caps the DRAW (see
// capCategory), and main.js passes it for a keyboard-only pilot. It is applied
// after resolveCategory() so that the random stream is consumed identically
// either way — a capped draw and an uncapped one see the same seed produce the
// same subsequent sampling, which is what keeps the gamepad path bit for bit
// what it always was.
export function generateEntryState({
	physics, manifest, seed, maxAttempts = DEFAULT_MAX_ATTEMPTS,
	category: forced = null, idle = false, maxCategory = null,
} = {}) {
	if (idle) {
		const at = fallbackCandidate(manifest, physics);
		// IDLE ON GROUND, not IDLE IN THE AIR: the sampled categories carry
		// their own AGL, but manifest.spawn is the ground station's own point
		// and is already the one physics.reset() uses.
		at.category = 'IDLE';
		physics.applyEntryState(at);
		return at;
	}
	const rand = rngFrom(seed);
	// The cap applies to the draw only: a forced category is an explicit request.
	const drawn = resolveCategory(forced, rand);
	const category = forced ? drawn : capCategory(drawn, maxCategory);
	for (let i = 0; i < maxAttempts; i++) {
		const candidate = sampleCandidate(category, manifest, physics, rand);
		if (candidate && geometrySafe(candidate, physics) && rolloutSafe(candidate, physics)) {
			physics.applyEntryState(candidate);
			return candidate;
		}
	}
	const fallback = fallbackCandidate(manifest, physics);
	physics.applyEntryState(fallback);
	return fallback;
}

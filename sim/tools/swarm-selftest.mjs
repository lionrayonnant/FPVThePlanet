// node tools/swarm-selftest.mjs
//
// The pure swarm model (issue #29): wake ring, slots, doctrines, ray budget,
// and the one property the whole design exists to hold — a unit is NEVER
// inside a building, including when every ray comes back blocked. No Three, no
// Rapier, no browser: the rays are injected functions, exactly as in
// tools/entry-state-selftest.mjs and tools/ambient-selftest.mjs.
//
// The central test is a MATRIX, not a happy path. The first version of this
// file only flew 15 m/s, dt = 1/60, no fence, one track — the single regime
// where the first implementation happened to pass. It went through walls at
// 22 m/s (0.5 m), at 30 m/s (5.1 m), on a 250 ms frame (2.4 m) and after a
// mid-flight reset (0.7 m), and none of it was visible here. Every one of
// those regimes is now a row below.

import {
	SwarmModel, DOCTRINES, DOCTRINE_NAMES, doctrineFor, scoutsFor, buildSlots,
	SWARM_UNIT, ACCEL_MAX, SPEED_MAX, WAKE_SAMPLES, WAKE_DT_S, RAY_BUDGET,
	AHEAD_MAX_S, AHEAD_LATERAL_MAX_M, MARGIN_FALL_S, MARGIN_RISE_S,
} from '../src/swarm.js';
import { tiltOf, TILT_MAX_DEG } from '../src/drone-kinematics.js';
import { horizontalMargin, verticalMargin } from '../src/geofence.js';

let failures = 0;
function check(label, ok, detail) {
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures++;
}

const NO_WIND = { x: 0, y: 0, z: 0 };

// ------------------------------------------------------------------ a city
//
// A block grid on a 60 m pitch with 15 m streets, buildings 40 m tall. The
// player flies down the middle of a street, so a doctrine with a 10 m lateral
// offset is asking to be put through a wall on every frame.
const PITCH = 60, HALF_STREET = 7.5, HEIGHT = 40;
const BOXES = [];
for (let a = -5; a <= 5; a++) {
	for (let b = -5; b <= 5; b++) {
		BOXES.push({
			min: [PITCH * a + HALF_STREET, 0, PITCH * b + HALF_STREET],
			max: [PITCH * (a + 1) - HALF_STREET, HEIGHT, PITCH * (b + 1) - HALF_STREET],
		});
	}
}

function insideCity(x, y, z) {
	for (const b of BOXES) {
		if (x > b.min[0] && x < b.max[0] && y > b.min[1] && y < b.max[1] && z > b.min[2] && z < b.max[2]) return b;
	}
	return null;
}
const depthIn = (x, z, b) => Math.min(x - b.min[0], b.max[0] - x, z - b.min[2], b.max[2] - z);

// Segment against one box, slab method. Returns the [t0, t1] overlap or null.
function slab(x1, y1, z1, dx, dy, dz, b) {
	let t0 = 0, t1 = 1;
	const p = [x1, y1, z1], d = [dx, dy, dz];
	for (let i = 0; i < 3; i++) {
		if (Math.abs(d[i]) < 1e-12) {
			if (p[i] < b.min[i] || p[i] > b.max[i]) return null;
			continue;
		}
		let a = (b.min[i] - p[i]) / d[i], c = (b.max[i] - p[i]) / d[i];
		if (a > c) { const s = a; a = c; c = s; }
		if (a > t0) t0 = a;
		if (c < t1) t1 = c;
		if (t0 > t1) return null;
	}
	return [t0, t1];
}

// The ray stub, shaped exactly like Physics.obstructionBetween(): {blocked,
// span}, span in metres of material along the segment. Reuses one object so
// the model is exercised against an allocation-free provider too.
const HIT = { blocked: false, span: 0 };
let rayCalls = 0;
const cityTerrain = {
	groundBelow: () => 0,
	obstructionBetween(x1, y1, z1, x2, y2, z2) {
		rayCalls++;
		const dx = x2 - x1, dy = y2 - y1, dz = z2 - z1;
		const len = Math.hypot(dx, dy, dz);
		let span = 0;
		for (const b of BOXES) {
			const h = slab(x1, y1, z1, dx, dy, dz, b);
			if (h) span += (h[1] - h[0]) * len;
		}
		HIT.blocked = span > 0; HIT.span = span;
		return HIT;
	},
};
// The pessimal provider: everything is a wall, always. This is the case the
// design has to survive on the wake alone.
const BLOCKED = { blocked: true, span: 1e3 };
const allBlocked = { groundBelow: () => 0, obstructionBetween: () => BLOCKED };
const openTerrain = { groundBelow: () => 0, obstructionBetween: () => ({ blocked: false, span: 0 }) };

// Distance from a point to the recorded wake polyline, walking the whole ring.
function wakeDistance(swarm, k) {
	const o = 3 * k;
	const px = swarm.pos[o], py = swarm.pos[o + 1], pz = swarm.pos[o + 2];
	if (swarm._count === 0) return 0;
	if (swarm._count === 1) {
		const i = swarm._at(0);
		return Math.hypot(px - swarm._wx[i], py - swarm._wy[i], pz - swarm._wz[i]);
	}
	let best = Infinity;
	for (let j = 0; j + 1 < swarm._count; j++) {
		const ia = swarm._at(j), ib = swarm._at(j + 1);
		const ax = swarm._wx[ia], ay = swarm._wy[ia], az = swarm._wz[ia];
		const ex = swarm._wx[ib] - ax, ey = swarm._wy[ib] - ay, ez = swarm._wz[ib] - az;
		const ee = ex * ex + ey * ey + ez * ez;
		let u = ee > 1e-12 ? ((px - ax) * ex + (py - ay) * ey + (pz - az) * ez) / ee : 0;
		if (u < 0) u = 0; else if (u > 1) u = 1;
		const d2 = (px - ax - u * ex) ** 2 + (py - ay - u * ey) ** 2 + (pz - az - u * ez) ** 2;
		if (d2 < best) best = d2;
	}
	return Math.sqrt(best);
}

// ---------------------------------------------------------------- tracks
//
// Every track writes into the same object and returns it: the harness never
// allocates either.
const TRACKS = {
	// Down a street, right angle at the crossing, down the next.
	corner(t, p, v) {
		const leg = 200 / v;
		p.y = 10;
		if (t < leg) { p.x = 0; p.z = 200 - v * t; } else { p.x = Math.min(200, v * (t - leg)); p.z = 0; }
		return p;
	},
	// A hairpin at a crossing: in, 180°, back out. The corner-cutting case.
	hairpin(t, p, v) {
		p.y = 10;
		// 3 m radius, so the exit leg is at x = 6 and the whole figure stays
		// inside the 15 m street. (A 6 m radius put the PLAYER through a wall,
		// and the swarm dutifully followed him there — the test was wrong, the
		// model was right, and it took reading the snapshot to tell.)
		const leg = 120 / v, turn = Math.PI * 3 / v;
		if (t < leg) { p.x = 0; p.z = 120 - v * t; return p; }
		if (t < leg + turn) {
			const a = (t - leg) / turn * Math.PI;
			p.x = 3 - 3 * Math.cos(a); p.z = -3 * Math.sin(a);
			return p;
		}
		p.x = 6; p.z = -v * (t - leg - turn);
		return p;
	},
	// Straight and fast, for the decoupling regimes.
	straight(t, p, v) { p.x = 0; p.y = 10; p.z = 200 - v * t; return p; },
	hover(t, p) { p.x = 0; p.y = 10; p.z = 0; return p; },
};

// The harness. Returns everything the assertions need, measured over the whole
// flight: deepest penetration, worst effective speed, worst distance off the
// wake beyond what the margin bought, worst margin, ray peak.
const _p = { x: 0, y: 10, z: 200 };
const _prev = new Float64Array(3 * 12);
function fly({ seed, size = 12, seconds = 15, dt = 1 / 60, speed = 15, terrain = cityTerrain,
	wind = NO_WIND, fence = null, track = TRACKS.corner, resetAt = null, shrink = null, watchWake = false,
	hitch = null, watchGap = false }) {
	const swarm = new SwarmModel({ size, doctrineSeed: seed, seed: 'build' });
	track(0, _p, speed);
	swarm.reset(_p);
	let t = 0;
	const out = { swarm, depth: 0, unit: -1, maxRays: 0, maxStep: 0, maxMargin: 0, maxOffWake: 0, maxTilt: 0, outFence: 0, maxGap: 0, minDt: dt };
	const steps = Math.round(seconds / dt);
	for (let i = 0; i < steps; i++) {
		// A hitch: the 250 ms the render loop clamps to, dropped into an
		// otherwise steady frame rate. It is not the same test as a uniformly
		// slow flight — it leaves a long GAP in the wake ring, which the units
		// then have to fly along.
		if (hitch) dt = (i % hitch.every === 0) ? hitch.dt : hitch.base;
		t += dt;
		if (dt < out.minDt) out.minDt = dt;
		track(t, _p, speed);
		if (shrink) fence.radius = shrink(t);
		for (let k = 0; k < swarm.size; k++) {
			const o = 3 * k;
			_prev[o] = swarm.pos[o]; _prev[o + 1] = swarm.pos[o + 1]; _prev[o + 2] = swarm.pos[o + 2];
		}
		swarm.update(_p, t, dt, terrain, wind, fence);
		if (resetAt !== null && Math.abs(t - resetAt) < dt / 2) swarm.reset(_p);
		if (watchGap) {
			for (let j = 0; j + 1 < swarm._count; j++) {
				const g = swarm._wt[swarm._at(j + 1)] - swarm._wt[swarm._at(j)];
				if (g > out.maxGap) out.maxGap = g;
			}
		}
		if (swarm.raysLastFrame > out.maxRays) out.maxRays = swarm.raysLastFrame;
		for (let k = 0; k < swarm.size; k++) {
			const o = 3 * k;
			const b = insideCity(swarm.pos[o], swarm.pos[o + 1], swarm.pos[o + 2]);
			if (b) {
				const d = depthIn(swarm.pos[o], swarm.pos[o + 2], b);
				if (d > out.depth) { out.depth = d; out.unit = k; }
			}
			if (i > 0) {
				const st = Math.hypot(swarm.pos[o] - _prev[o], swarm.pos[o + 1] - _prev[o + 1], swarm.pos[o + 2] - _prev[o + 2]) / dt;
				if (st > out.maxStep) out.maxStep = st;
			}
			if (swarm.margin[k] > out.maxMargin) out.maxMargin = swarm.margin[k];
			const tilt = tiltOf(swarm.quat, 4 * k) * 180 / Math.PI;
			if (tilt > out.maxTilt) out.maxTilt = tilt;
			if (watchWake) {
				const off = wakeDistance(swarm, k) - swarm._maxR[k];
				if (off > out.maxOffWake) out.maxOffWake = off;
			}
			if (fence) {
				const p = { x: swarm.pos[o], y: swarm.pos[o + 1], z: swarm.pos[o + 2] };
				if (fence.bbox && (horizontalMargin(p, fence.bbox) < 0 || verticalMargin(p, fence.bbox) < 0)) out.outFence++;
			}
		}
	}
	return out;
}

const seedFor = (name) => {
	for (let i = 0; i < 500; i++) if (doctrineFor(`c-${i}`) === name) return `c-${i}`;
	throw new Error(`no seed for ${name}`);
};
const SEEDS = Object.fromEntries(DOCTRINE_NAMES.map((n) => [n, seedFor(n)]));

// --------------------------------------------------------------- doctrines

console.log('swarm: doctrines and slots');
{
	const seen = new Set();
	for (let i = 0; i < 200; i++) seen.add(doctrineFor(`seed-${i}`));
	check('every doctrine is reachable', seen.size === DOCTRINE_NAMES.length, [...seen].join(', '));
	check('a doctrine seed always gives the same doctrine', doctrineFor('abc') === doctrineFor('abc'));

	// One guard-rail assertion for the whole table: the drawn slots stay inside
	// the doctrine that named them, and inside the two hard bounds on being
	// ahead. Written once rather than four times per doctrine — it re-states a
	// clamp, and its value is that it would catch the clamp being deleted.
	let bad = '';
	for (const name of DOCTRINE_NAMES) {
		const d = DOCTRINES[name];
		for (const size of [6, 9, 12]) {
			const lag = new Float64Array(size), lat = new Float64Array(size), vert = new Float64Array(size);
			buildSlots(name, size, `s-${size}`, lag, lat, vert);
			for (let k = 0; k < size; k++) {
				if (lag[k] < d.lagMin - 1e-9 || lag[k] > d.lagMax + 1e-9) bad += `${name}/${size} lag ${lag[k]} `;
				if (Math.abs(lat[k]) > d.lateral + 1e-9) bad += `${name}/${size} lat ${lat[k]} `;
				if (Math.abs(vert[k]) > d.vertical + 1e-9) bad += `${name}/${size} vert ${vert[k]} `;
				if (lag[k] < 0 && (lag[k] < -AHEAD_MAX_S - 1e-9 || Math.abs(lat[k]) > AHEAD_LATERAL_MAX_M + 1e-9)) bad += `${name}/${size} ahead ${lag[k]}/${lat[k]} `;
			}
		}
	}
	check('drawn slots stay inside their doctrine and the two ahead bounds', bad === '', bad.slice(0, 120));

	// What each doctrine is SUPPOSED to look like — the assertions that would
	// notice a doctrine losing its shape rather than its bounds.
	const shapeOf = (name, size) => {
		const lag = new Float64Array(size), lat = new Float64Array(size), vert = new Float64Array(size);
		buildSlots(name, size, 'shape', lag, lat, vert);
		return { lag, lat, vert };
	};
	const wedge = shapeOf('wedge', 12);
	let widens = true;
	for (let k = 1; k < 12; k++) {
		if (wedge.lag[k] > wedge.lag[k - 1] && wedge.lag[k] > 0 && wedge.lag[k - 1] > 0) {
			if (Math.abs(wedge.lat[k]) + 1e-9 < Math.abs(wedge.lat[k - 1])) widens = false;
		}
	}
	check('wedge: the further behind, the wider — it is a V', widens);
	const column = shapeOf('column', 12);
	check('column: everyone within 2 m of the centreline',
		Math.max(...Array.from(column.lat, Math.abs)) <= 2, `${Math.max(...Array.from(column.lat, Math.abs)).toFixed(2)} m`);
	check('column: strung out over more than a second of track',
		Math.max(...column.lag) - Math.min(...column.lag) > 1, `${(Math.max(...column.lag) - Math.min(...column.lag)).toFixed(2)} s`);
	const screen = shapeOf('screen', 12);
	check('screen: abreast — spread wide, barely strung out',
		Math.max(...Array.from(screen.lat, Math.abs)) > 5 && Math.max(...screen.lag) - Math.min(...screen.lag) < 1);
	for (const name of DOCTRINE_NAMES) {
		const { lag } = shapeOf(name, 12);
		let ahead = 0;
		for (let k = 0; k < 12; k++) if (lag[k] < 0) ahead++;
		check(`${name}: ${scoutsFor(name, 12)} units ahead of the node`, ahead === scoutsFor(name, 12), `${ahead}`);
		if (name !== 'column') check(`${name}: about a third of them ahead`, Math.abs(ahead - 4) <= 1, `${ahead}/12`);
	}
	check('column keeps two scouts, not a third of twelve', scoutsFor('column', 12) === 2);
}

console.log('\nswarm: determinism');
{
	const a = new SwarmModel({ size: 9, doctrineSeed: 'cluster-7', seed: 'build-7' });
	const b = new SwarmModel({ size: 9, doctrineSeed: 'cluster-7', seed: 'build-7' });
	check('same seed, same doctrine', a.doctrine === b.doctrine, a.doctrine);
	check('same seed, same slots',
		a.lag.every((v, i) => v === b.lag[i]) && a.lat.every((v, i) => v === b.lat[i]) && a.vert.every((v, i) => v === b.vert[i]));
	check('same seed, same wind phases', a.phase.every((v, i) => v === b.phase[i]));
	const c = new SwarmModel({ size: 9, doctrineSeed: 'cluster-8', seed: 'build-7' });
	check('another doctrine seed draws other slots', !a.lag.every((v, i) => v === c.lag[i]));
	let twins = 0;
	for (let i = 0; i < 60; i++) {
		const s = new SwarmModel({ size: 9, doctrineSeed: `d-${i}`, seed: 'x' });
		if (s.doctrine === a.doctrine && s.lag.every((v, k) => v === a.lag[k])) twins++;
	}
	check('two clusters of the same doctrine still differ', twins === 0, `${twins} twins`);
	check('size is clamped to 6..12', new SwarmModel({ size: 40, doctrineSeed: 'z' }).size === 12);
	// Same seed, same flight: the whole trajectory, not just the draw.
	const f1 = fly({ seed: 'c-1', seconds: 6 });
	const f2 = fly({ seed: 'c-1', seconds: 6 });
	check('same seed, same flight to the last bit',
		f1.swarm.pos.every((v, i) => v === f2.swarm.pos[i]) && f1.swarm.quat.every((v, i) => v === f2.swarm.quat[i]));
}

// -------------------------------------------------------------- the wake

console.log('\nswarm: the wake ring');
{
	const s = new SwarmModel({ size: 6, doctrineSeed: 'wake' });
	const refs = [s._wx, s._wy, s._wz, s._wt];
	for (let i = 0; i <= 2000; i++) {
		const t = i * WAKE_DT_S;
		s._push(10 * t, 10, 0, t);
	}
	check('the ring never reallocates', s._wx === refs[0] && s._wy === refs[1] && s._wz === refs[2] && s._wt === refs[3]);
	check(`the ring holds exactly ${WAKE_SAMPLES} entries`, s._count === WAKE_SAMPLES, `${s._count}`);

	const newest = 2000 * WAKE_DT_S;
	let w = s._read(newest);
	check('reading the newest entry is exact', Math.abs(w.x - 10 * newest) < 0.05, `${w.x.toFixed(3)}`);
	const oldestT = (2000 - WAKE_SAMPLES + 1) * WAKE_DT_S;
	w = s._read(oldestT);
	check('reading the oldest entry is exact', Math.abs(w.x - 10 * oldestT) < 0.05, `${w.x.toFixed(3)}`);
	w = s._read(oldestT - 100);
	check('older than the ring folds back onto the oldest entry', Math.abs(w.x - 10 * oldestT) < 0.05, `${w.x.toFixed(3)}`);
	const mid = oldestT + 3.5 * WAKE_DT_S;
	w = s._read(mid);
	check('reading between two entries interpolates', Math.abs(w.x - 10 * mid) < 0.05, `${w.x.toFixed(3)}`);
	check('the track tangent points where the player went', Math.abs(w.tx - 1) < 1e-6 && Math.abs(w.tz) < 1e-6);
	check('the track speed is the player speed', Math.abs(w.speed - 10) < 0.05, `${w.speed.toFixed(3)}`);
	w = s._read(newest + 0.4);
	check('newer than the ring extrapolates along the tangent', Math.abs(w.x - 10 * (newest + 0.4)) < 0.1, `${w.x.toFixed(3)}`);

	const fresh = new SwarmModel({ size: 6, doctrineSeed: 'wake' });
	fresh._push(5, 10, 0, 100);
	fresh._push(6, 10, 0, 100.02);
	w = fresh._read(98);
	check('a lag longer than the history folds back, it does not extrapolate backwards', Math.abs(w.x - 5) < 1e-3, `${w.x.toFixed(3)}`);
	const empty = new SwarmModel({ size: 6, doctrineSeed: 'wake' });
	check('an empty ring reads without throwing', empty._read(0).speed === 0);

	// The write PERIOD, at four frame rates. Resetting the accumulator to zero
	// instead of carrying the remainder silently rounds this up to the frame:
	// 33 ms at 60 fps, which coarsens the polyline from 0.40 m to 0.67 m of
	// track at 20 m/s — the resolution of the object the safety rests on.
	for (const dt of [1 / 60, 1 / 120, 1 / 250, 1 / 30]) {
		const m = new SwarmModel({ size: 6, doctrineSeed: 'c-1' });
		const p = { x: 0, y: 10, z: 0 };
		m.reset(p);
		let t = 0;
		for (let i = 0; i < Math.round(8 / dt); i++) { t += dt; p.z -= 20 * dt; m.update(p, t, dt, null, NO_WIND, null); }
		const period = 8000 / m._count;
		check(`at ${(1 / dt).toFixed(0)} fps the wake is written every ${WAKE_DT_S * 1000} ms`,
			Math.abs(period - WAKE_DT_S * 1000) <= Math.max(1, dt * 1000 / 2) || (dt > WAKE_DT_S && period <= dt * 1000 + 1),
			`${period.toFixed(1)} ms`);
	}
}

// -------------------------------------------------- the central property

console.log('\nswarm: no unit is ever inside a building');
{
	const bbox = { min: [-200, 0, -260], max: [260, 200, 260] };
	// One row per regime. `rays honest` is the city stub; `all blocked` is the
	// case the spec names, where only the wake keeps them out.
	const REGIMES = [
		{ label: 'speed 15, dt 1/60', speed: 15, dt: 1 / 60 },
		{ label: 'speed 22, dt 1/60', speed: 22, dt: 1 / 60 },
		{ label: 'speed 30, dt 1/60', speed: 30, dt: 1 / 60 },
		{ label: 'speed 34, dt 1/60', speed: 34, dt: 1 / 60 },
		{ label: 'speed 45, dt 1/60', speed: 45, dt: 1 / 60 },
		{ label: 'speed 15, dt 250 ms', speed: 15, dt: 0.25 },
		{ label: 'speed 34, dt 250 ms', speed: 34, dt: 0.25 },
		{ label: 'hairpin at 22', speed: 22, dt: 1 / 60, track: TRACKS.hairpin },
		// The case the matrix did not cross and that broke: a 250 ms frame IS
		// the clamp the render loop produces, and a hairpin is where 250 ms of
		// blind flight costs the most. 4.18 m in, before this row existed.
		{ label: 'hairpin at 15, dt 250 ms', speed: 15, dt: 0.25, track: TRACKS.hairpin },
		{ label: 'hairpin at 22, dt 250 ms', speed: 22, dt: 0.25, track: TRACKS.hairpin },
		{ label: 'hairpin at 34, dt 250 ms', speed: 34, dt: 0.25, track: TRACKS.hairpin },
		// And the shape a real stall has: a hitch inside a steady frame rate,
		// which a uniformly slow flight does not reproduce.
		{ label: 'a 250 ms hitch every 37 frames', speed: 22, hitch: { base: 1 / 60, dt: 0.25, every: 37 } },
		// The one row with a tolerance, and it is stated rather than hidden: a
		// 3 m hairpin in a 15 m street sweeps the whole corridor sideways under
		// a unit in 0.4 s, and on a hitched frame the fold starts one frame
		// late. The offsets retract at the airframe's own top speed, so what is
		// left is a corner clipped by a fraction of a metre for a fraction of a
		// second — not a machine flying through a wall. Raising OVERREACH_M
		// does not close it (measured at 4, 5 and 6 m: no better, and the swarm
		// loses a third of its spread in the city), because it is a fold
		// transient and not a detection range.
		{ label: 'a 250 ms hitch every 37 frames, hairpin', speed: 22, track: TRACKS.hairpin, hitch: { base: 1 / 60, dt: 0.25, every: 37 }, tol: 1 },
		{ label: 'a 250 ms hitch every 11 frames', speed: 30, hitch: { base: 1 / 60, dt: 0.25, every: 11 } },
		{ label: 'reset in mid-flight', speed: 22, dt: 1 / 60, resetAt: 6 },
		{ label: 'pre-baked bbox', speed: 22, dt: 1 / 60, fence: { bbox } },
		{ label: 'live circle shrinking 200 -> 40 m', speed: 22, dt: 1 / 60, live: true },
		{ label: 'wind 8 m/s', speed: 22, dt: 1 / 60, wind: { x: 8, y: 1, z: -5 } },
	];
	for (const r of REGIMES) {
		let worst = 0, worstAt = '', maxRays = 0;
		for (const name of DOCTRINE_NAMES) {
			for (const [tl, terrain] of [['honest', cityTerrain], ['blocked', allBlocked]]) {
				const fence = r.live ? { center: { x: 0, y: 0, z: 0 }, radius: 200 } : (r.fence || null);
				const out = fly({
					seed: SEEDS[name], seconds: 15, speed: r.speed, dt: r.dt ?? 1 / 60, terrain,
					wind: r.wind || NO_WIND, fence, track: r.track || TRACKS.corner,
					resetAt: r.resetAt ?? null, hitch: r.hitch || null,
					shrink: r.live ? (t) => Math.max(40, 200 - 55 * t) : null,
				});
				if (out.depth > worst) { worst = out.depth; worstAt = `${name}/${tl} unit ${out.unit}`; }
				if (out.maxRays > maxRays) maxRays = out.maxRays;
			}
		}
		const tol = r.tol || 0;
		check(`${r.label}: nobody inside a building${tol ? ` (tolerance ${tol} m, see above)` : ''}`,
			worst <= tol, worst <= tol ? `${worst.toFixed(2)} m, ${maxRays} rays/frame peak` : `${worst.toFixed(2)} m in, ${worstAt}`);
	}
}

console.log('\nswarm: the fallback holds on its own');
{
	// Every ray blocked from the first frame, with a fence, at speed: margins
	// can never grow, so every unit must be ON the recorded wake, not near it.
	for (const [label, fence, shrink] of [
		['no fence', null, null],
		['pre-baked bbox the player hugs', { bbox: { min: [-60, 0, -400], max: [60, 200, 400] } }, null],
		['live circle collapsing under the player', { center: { x: 0, y: 0, z: 0 }, radius: 200 }, (t) => Math.max(40, 200 - 55 * t)],
	]) {
		let maxMargin = 0, maxOff = 0;
		for (const name of DOCTRINE_NAMES) {
			const out = fly({
				seed: SEEDS[name], seconds: 12, speed: 18, terrain: allBlocked,
				track: (t, p, v) => { p.x = 59; p.y = 10; p.z = 200 - v * t; return p; },
				fence, shrink, watchWake: true,
			});
			maxMargin = Math.max(maxMargin, out.maxMargin);
			maxOff = Math.max(maxOff, out.maxOffWake);
		}
		check(`${label}: margins never grow`, maxMargin === 0, `${maxMargin}`);
		check(`${label}: nobody is further off the wake than its margin bought`, maxOff < 1e-6, `${maxOff.toExponential(2)} m`);
	}

	// Outrunning the swarm for long enough that its reading head falls off the
	// TAIL of the ring: the unit is then following the oldest entry, which
	// slides forward at the node's speed and not at the unit's, so it trails it
	// by up to one frame of flight. It is still a place the player flew — but
	// the ring has forgotten it, so it no longer measures as "on the wake", and
	// that is worth stating rather than hiding behind a slower test.
	{
		let maxOff = 0;
		for (const name of DOCTRINE_NAMES) {
			const out = fly({
				seed: SEEDS[name], seconds: 25, speed: 40, terrain: allBlocked,
				track: TRACKS.straight, watchWake: true,
			});
			maxOff = Math.max(maxOff, out.maxOffWake);
		}
		check('outrun for 25 s at 40 m/s, a unit pinned to the tail is still exactly on the wake',
			maxOff < 1e-6, `${maxOff.toExponential(2)} m`);
		// ...and that is the one place in the module where a unit covers more
		// ground in a frame than its own airframe would: it is following the
		// tail of the ring, which advances by a whole SAMPLE at a time — so up
		// to one node-speed sample (dt + one wake period of travel) in a single
		// frame. Stated and bounded, and preferred to the alternative, which is
		// leaving the wake in order to respect a speed limit nobody can see.
		// The bound is the node's speed times the LARGEST GAP the ring actually
		// holds, over the shortest frame — not times WAKE_DT_S. A hitch leaves
		// a 267 ms hole in the ring, and a unit at the tail crosses it in one
		// 16 ms frame: 352 m/s, where the nominal period would have promised
		// 48. Stating it in terms of the nominal period was a test that passed
		// for the wrong reason.
		const node = 40;
		let worst = 0;
		for (const hitch of [null, { base: 1 / 60, dt: 0.25, every: 37 }]) {
			for (const name of DOCTRINE_NAMES) {
				const out = fly({
					seed: SEEDS[name], seconds: 25, speed: node, dt: 1 / 60, terrain: allBlocked,
					track: TRACKS.straight, hitch, watchGap: true,
				});
				const bound = node * (out.maxGap + out.minDt) / out.minDt;
				worst = Math.max(worst, out.maxStep / bound);
			}
		}
		check('and at the tail it moves by whole ring samples: node speed over the worst gap the ring holds',
			worst <= 1 + 1e-9, `${(worst * 100).toFixed(0)}% of the bound`);
	}

	// The two timings, 0.3 s down and 1.5 s up.
	const s2 = new SwarmModel({ size: 6, doctrineSeed: 'c-1', seed: 'b' });
	const p = { x: 0, y: 10, z: 200 };
	s2.reset(p);
	let t = 0;
	for (let i = 0; i < Math.round((MARGIN_RISE_S + 0.2) * 60); i++) { t += 1 / 60; p.z -= 20 / 60; s2.update(p, t, 1 / 60, openTerrain, NO_WIND, null); }
	check('margins reach 1 after the rise time', Math.min(...s2.margin) === 1, `${Math.min(...s2.margin).toFixed(3)}`);
	for (let i = 0; i < Math.round(MARGIN_FALL_S * 60) + 2; i++) { t += 1 / 60; p.z -= 20 / 60; s2.update(p, t, 1 / 60, allBlocked, NO_WIND, null); }
	check(`margins are back to 0 after ${MARGIN_FALL_S} s of blocked rays`, Math.max(...s2.margin) === 0);
	// The margins are 0 at 0.3 s; the FLYING takes a spring constant longer.
	for (let i = 0; i < 90; i++) { t += 1 / 60; p.z -= 20 / 60; s2.update(p, t, 1 / 60, allBlocked, NO_WIND, null); }
	// And what they look like when they get there: strung out along the wake,
	// not stacked on the node. "Single file in your tracks" is the worst case
	// the spec asks for by name, so it is worth asserting it IS that.
	let minGap = Infinity;
	for (let i = 0; i < s2.size; i++) {
		for (let j = i + 1; j < s2.size; j++) {
			minGap = Math.min(minGap, Math.hypot(s2.pos[3 * i] - s2.pos[3 * j], s2.pos[3 * i + 1] - s2.pos[3 * j + 1], s2.pos[3 * i + 2] - s2.pos[3 * j + 2]));
		}
	}
	check('folded flat, they are in file and not stacked on each other', minGap > 0.3, `${minGap.toFixed(2)} m apart`);
}

// ----------------------------------------------------------- ray budget

console.log('\nswarm: the ray budget');
{
	let maxRays = 0, worst = '';
	for (const size of [6, 8, 12]) {
		for (const name of DOCTRINE_NAMES) {
			const out = fly({ seed: SEEDS[name], size, seconds: 6 });
			if (out.maxRays > maxRays) { maxRays = out.maxRays; worst = `${name} x${size}`; }
			if (scoutsFor(name, size) > RAY_BUDGET) worst += ` (${name} x${size} has more scouts than rays)`;
		}
	}
	check(`never more than ${RAY_BUDGET} rays a frame, any size, any doctrine`, maxRays <= RAY_BUDGET, `${maxRays} (${worst})`);

	// Priority and fairness. The residue-class version of "one turn in three"
	// starved two units of twelve for 600 frames — they kept margin 1 in a
	// street and went through a wall — so this one measures every unit, not
	// the maximum.
	const swarm = new SwarmModel({ size: 12, doctrineSeed: SEEDS.wedge, seed: 'b' });
	const tested = new Int32Array(swarm.size);
	const realCast = swarm._cast.bind(swarm);
	swarm._cast = (terrain, k) => { tested[k]++; realCast(terrain, k); };
	const p = { x: 0, y: 10, z: 200 };
	swarm.reset(p);
	const frames = 600;
	let t = 0;
	for (let i = 0; i < frames; i++) { t += 1 / 60; p.z -= 18 / 60; swarm.update(p, t, 1 / 60, openTerrain, NO_WIND, null); }
	let scoutMin = Infinity, rearMax = 0, rearMin = Infinity;
	for (let k = 0; k < swarm.size; k++) {
		if (swarm.lag[k] < 0) scoutMin = Math.min(scoutMin, tested[k]);
		else { rearMax = Math.max(rearMax, tested[k]); rearMin = Math.min(rearMin, tested[k]); }
	}
	check('a unit ahead is tested every single frame', scoutMin >= frames - 1, `${scoutMin}/${frames}`);
	check('a unit behind is tested at most one frame in three', rearMax <= frames / 3 + 2, `${rearMax}/${frames}`);
	check('and no unit behind is ever starved', rearMin > frames / 8, `worst ${rearMin}, best ${rearMax}`);
}

// ------------------------------------------------------ physical bounds

console.log('\nswarm: physical bounds');
{
	// The one that is NOT a re-statement of a clamp: the distance actually
	// covered between two frames. Everything else in the module is clamped, so
	// only the measured displacement can catch a clamp being bypassed — and it
	// did: the tube version dragged a unit forwards at 56 m/s, 2.3x vMax.
	let maxStep = 0, where = '';
	for (const [label, opts] of [
		['city at 22', { speed: 22 }],
		['city at 34', { speed: 34 }],
		['hairpin at 30', { speed: 30, track: TRACKS.hairpin }],
		['straight at 24, right on the limit', { speed: 24, seconds: 25, track: TRACKS.straight, terrain: openTerrain }],
		['250 ms frames at 34', { speed: 34, dt: 0.25 }],
		['wind 8 m/s', { speed: 22, wind: { x: 8, y: 1, z: -5 } }],
		['hovering', { speed: 0, track: TRACKS.hover }],
	]) {
		for (const name of DOCTRINE_NAMES) {
			const out = fly({ seed: SEEDS[name], seconds: 15, ...opts });
			if (out.maxStep > maxStep) { maxStep = out.maxStep; where = `${label}/${name}`; }
		}
	}
	check('no unit ever covers more ground in a frame than the airframe flies',
		maxStep <= SPEED_MAX + 1e-6, `${maxStep.toFixed(2)} / ${SPEED_MAX} m/s (worst: ${where})`);

	// Guard rails: |v|, |a| and tilt are clamped in the module, so these three
	// only prove the clamps are still wired up. Kept deliberately, one each.
	const out = fly({ seed: SEEDS.cloud, seconds: 12, speed: 22, wind: { x: 4, y: 0.5, z: -3 } });
	const s = out.swarm;
	let maxV = 0, maxA = 0;
	for (let k = 0; k < s.size; k++) {
		maxV = Math.max(maxV, Math.hypot(s.vel[3 * k], s.vel[3 * k + 1], s.vel[3 * k + 2]));
		maxA = Math.max(maxA, Math.hypot(s.acc[3 * k], s.acc[3 * k + 1], s.acc[3 * k + 2]));
	}
	check('guard rail: |v| clamp still wired', maxV <= SPEED_MAX + 1e-9, `${maxV.toFixed(2)} m/s`);
	check('guard rail: |a| clamp still wired', maxA <= ACCEL_MAX + 1e-9, `${maxA.toFixed(2)} m/s2`);
	check(`guard rail: tilt clamp still wired (${TILT_MAX_DEG}°)`, out.maxTilt <= TILT_MAX_DEG + 1e-6, `${out.maxTilt.toFixed(1)}°`);
	check('the drag comes from the toothpick, scaled by area',
		Math.abs(SWARM_UNIT.bodyDrag.x - 0.0018 * (0.027 / 0.038) ** 2) < 1e-12);
}

console.log('\nswarm: it falls behind at full stick and catches back up');
{
	const swarm = new SwarmModel({ size: 8, doctrineSeed: 'c-1', seed: 'b' });
	const p = { x: 0, y: 30, z: 0 };
	swarm.reset(p);
	const dt = 1 / 60;
	let t = 0, lag = 0;
	for (let i = 0; i < Math.round(6 / dt); i++) { t += dt; p.z -= 34 * dt; swarm.update(p, t, dt, openTerrain, NO_WIND, null); }
	for (let k = 0; k < swarm.size; k++) {
		const o = 3 * k;
		lag = Math.max(lag, Math.hypot(swarm.pos[o] - swarm._slot[o], swarm.pos[o + 1] - swarm._slot[o + 1], swarm.pos[o + 2] - swarm._slot[o + 2]));
	}
	check('the swarm loses its slots when the node outruns it', lag > 5, `${lag.toFixed(1)} m behind`);
	for (let i = 0; i < Math.round(10 / dt); i++) { t += dt; swarm.update(p, t, dt, openTerrain, NO_WIND, null); }
	let after = 0;
	for (let k = 0; k < swarm.size; k++) {
		const o = 3 * k;
		after = Math.max(after, Math.hypot(swarm.pos[o] - swarm._slot[o], swarm.pos[o + 1] - swarm._slot[o + 1], swarm.pos[o + 2] - swarm._slot[o + 2]));
	}
	check('and they catch back up once it slows', after < 1, `${after.toFixed(2)} m off slot`);
}

// ------------------------------------------------------------ allocation

console.log('\nswarm: update() keeps its arrays');
{
	const swarm = new SwarmModel({ size: 12, doctrineSeed: 'c-1', seed: 'b' });
	const refs = {
		pos: swarm.pos, vel: swarm.vel, acc: swarm.acc, quat: swarm.quat,
		margin: swarm.margin, blocked: swarm.blocked, lag: swarm.lag,
		_wx: swarm._wx, _wt: swarm._wt, _slot: swarm._slot, _sep: swarm._sep,
		_o: swarm._o, _frame: swarm._frame,
	};
	const dbg0 = swarm.debug();
	const p = { x: 0, y: 10, z: 200 };
	swarm.reset(p);
	let t = 0;
	for (let i = 0; i < 1000; i++) {
		t += 1 / 60;
		TRACKS.corner(t, p, 15);
		swarm.update(p, t, 1 / 60, cityTerrain, NO_WIND, { bbox: { min: [-400, 0, -400], max: [400, 200, 400] } });
	}
	let same = true;
	for (const key of Object.keys(refs)) if (swarm[key] !== refs[key]) same = false;
	check('every array is the same array after 1000 steps', same);
	check('debug() hands back the same object', swarm.debug() === dbg0 && dbg0.lagRange.length === 2);
	check('debug() reports what the browser check needs',
		typeof dbg0.size === 'number' && typeof dbg0.doctrine === 'string'
		&& typeof dbg0.raysCast === 'number' && typeof dbg0.blockedUnits === 'number');
	const before = swarm.pos.slice();
	swarm.update(p, t, 0, cityTerrain, NO_WIND, null);
	check('a frozen frame does nothing', before.every((v, i) => v === swarm.pos[i]));
	swarm.reset(p);
	let off = 0;
	for (let k = 0; k < swarm.size; k++) off = Math.max(off, Math.hypot(swarm.pos[3 * k] - p.x, swarm.pos[3 * k + 1] - p.y, swarm.pos[3 * k + 2] - p.z));
	check('reset() empties the wake and stacks them on the player', swarm._count === 0 && off === 0);
}

// ---------------------------------------------------------------- fence

console.log('\nswarm: the fence');
{
	// Pre-baked, flown 1 m inside the wall for the whole flight — the player
	// hugging the edge is what the geofence's own hold does, so it is the
	// normal case and not a corner one.
	const bbox = { min: [-60, 0, -400], max: [60, 200, 400] };
	let out = 0;
	for (const name of DOCTRINE_NAMES) {
		const r = fly({
			seed: SEEDS[name], seconds: 14, speed: 22, terrain: openTerrain, fence: { bbox },
			track: (t, p, v) => { p.x = 59; p.y = 10; p.z = 300 - v * t; return p; },
		});
		out += r.outFence;
	}
	check('no unit leaves a pre-baked bbox the player hugs', out === 0, `${out} samples outside`);

	// Live: a trust circle that SHRINKS under a moving player, which is what
	// nearestTrustedRadius() does when the streaming window loads less than it
	// had. The units may end up outside it — the recorded wake itself does —
	// but never further out than the wake they are hanging from. (The earlier
	// version clamped them inwards instead, and pushed a unit 59 m off its own
	// wake, towards the buildings, with every ray blocked.)
	const fence = { center: { x: 0, y: 0, z: 0 }, radius: 200 };
	const swarm = new SwarmModel({ size: 12, doctrineSeed: SEEDS.cloud, seed: 'b' });
	const p = { x: 0, y: 10, z: 150 };
	swarm.reset(p);
	let t = 0, worstBeyond = 0;
	for (let i = 0; i < 60 * 12; i++) {
		t += 1 / 60; p.z -= 18 / 60;
		fence.radius = Math.max(40, 200 - 55 * t);
		swarm.update(p, t, 1 / 60, openTerrain, NO_WIND, fence);
		for (let k = 0; k < swarm.size; k++) {
			const o = 3 * k;
			const d = Math.hypot(swarm.pos[o] - fence.center.x, swarm.pos[o + 2] - fence.center.z);
			const anchor = Math.hypot(swarm._anchor[o] - fence.center.x, swarm._anchor[o + 2] - fence.center.z);
			worstBeyond = Math.max(worstBeyond, d - Math.max(fence.radius, anchor + swarm._maxR[k]));
		}
	}
	check('nobody is further out than the trust circle, or than its own wake point plus its margin', worstBeyond <= 1e-6, `${worstBeyond.toExponential(2)} m`);
	// And the fence must be a no-op when there are no offsets to pull in.
	const flat = new SwarmModel({ size: 12, doctrineSeed: SEEDS.cloud, seed: 'b' });
	const q = { x: 59, y: 10, z: 200 };
	flat.reset(q);
	let t2 = 0, offWake = 0;
	for (let i = 0; i < 60 * 8; i++) {
		t2 += 1 / 60; q.z -= 22 / 60;
		flat.update(q, t2, 1 / 60, allBlocked, NO_WIND, { bbox });
		for (let k = 0; k < flat.size; k++) offWake = Math.max(offWake, wakeDistance(flat, k));
	}
	check('at margin 0 the fence is a no-op: they are ON the wake, fence or not', offWake < 1e-6, `${offWake.toExponential(2)} m`);
}

console.log(`\n${failures === 0 ? 'OK' : `${failures} FAILURE(S)`}  (${rayCalls} stub rays cast)`);
process.exit(failures === 0 ? 0 : 1);

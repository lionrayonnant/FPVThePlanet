// node tools/swarm-selftest.mjs
//
// The pure swarm model (issue #29): wake ring, slots, doctrines, ray budget,
// the wake tube. No Three, no Rapier, no browser — the rays are injected
// functions, exactly as in tools/entry-state-selftest.mjs and
// tools/ambient-selftest.mjs.
//
// The one property this file exists for: a unit is NEVER inside a building,
// including when every ray comes back blocked. That case is not a special
// path, it is the fallback the whole design leans on — margins reach zero and
// every unit sits on the polyline the player actually flew.

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

// Distance from a unit to the recorded wake polyline, walking the whole ring
// rather than the model's search window: the check must not reuse the model's
// own shortcut.
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

const NO_WIND = { x: 0, y: 0, z: 0 };

// ------------------------------------------------------------------ a city
//
// A block grid on a 60 m pitch with 15 m streets, buildings 40 m tall. The
// player flies down the middle of a street, so a doctrine with a 10 m lateral
// offset is asking to be put through a wall on every frame.
const PITCH = 60, HALF_STREET = 7.5, HEIGHT = 40;
const BOXES = [];
for (let a = -3; a <= 3; a++) {
	for (let b = -3; b <= 3; b++) {
		BOXES.push({
			min: [PITCH * a + HALF_STREET, 0, PITCH * b + HALF_STREET],
			max: [PITCH * (a + 1) - HALF_STREET, HEIGHT, PITCH * (b + 1) - HALF_STREET],
		});
	}
}

function insideBox(x, y, z, b) {
	return x > b.min[0] && x < b.max[0] && y > b.min[1] && y < b.max[1] && z > b.min[2] && z < b.max[2];
}
function insideCity(x, y, z) {
	for (const b of BOXES) if (insideBox(x, y, z, b)) return b;
	return null;
}

// Segment against one box, slab method. Returns the [t0, t1] overlap or null.
function slab(x1, y1, z1, dx, dy, dz, b) {
	let t0 = 0, t1 = 1;
	const lo = b.min, hi = b.max;
	const p = [x1, y1, z1], d = [dx, dy, dz];
	for (let i = 0; i < 3; i++) {
		if (Math.abs(d[i]) < 1e-12) {
			if (p[i] < lo[i] || p[i] > hi[i]) return null;
			continue;
		}
		let a = (lo[i] - p[i]) / d[i], c = (hi[i] - p[i]) / d[i];
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

// A player track down one street, a right-angle turn at the crossing, then
// down the next: the hairpin is where corner-cutting would show.
function trackAt(t, out, speed = 15) {
	const legTime = 120 / speed;
	out.y = 10;
	if (t < legTime) { out.x = 0; out.z = 120 - speed * t; return out; }
	const u = Math.min(120, speed * (t - legTime));
	out.x = u; out.z = 0;
	return out;
}

function fly({ swarm, terrain, seconds = 8, dt = 1 / 60, speed = 15, wind = NO_WIND, fence = null, track = trackAt, onStep }) {
	const p = { x: 0, y: 10, z: 120 };
	track(0, p, speed);
	swarm.reset(p);
	let t = 0;
	for (let i = 0; i < Math.round(seconds / dt); i++) {
		t += dt;
		track(t, p, speed);
		swarm.update(p, t, dt, terrain, wind, fence);
		if (onStep) onStep(t, p, i);
	}
	return t;
}

// --------------------------------------------------------------- doctrines

console.log('swarm: doctrines and slots');
{
	const seen = new Set();
	for (let i = 0; i < 200; i++) seen.add(doctrineFor(`seed-${i}`));
	check('every doctrine is reachable', seen.size === DOCTRINE_NAMES.length, [...seen].join(', '));
	check('a doctrine seed always gives the same doctrine', doctrineFor('abc') === doctrineFor('abc'));

	for (const name of DOCTRINE_NAMES) {
		const d = DOCTRINES[name];
		const size = 12;
		const lag = new Float64Array(size), lat = new Float64Array(size), vert = new Float64Array(size);
		buildSlots(name, size, 'seed', lag, lat, vert);
		const scouts = scoutsFor(name, size);
		let ahead = 0, worstAheadLat = 0, worstAheadLag = 0;
		for (let k = 0; k < size; k++) {
			if (lag[k] < 0) { ahead++; worstAheadLat = Math.max(worstAheadLat, Math.abs(lat[k])); worstAheadLag = Math.min(worstAheadLag, lag[k]); }
		}
		check(`${name}: lags stay inside the doctrine's range`,
			Math.min(...lag) >= d.lagMin - 1e-9 && Math.max(...lag) <= d.lagMax + 1e-9,
			`${Math.min(...lag).toFixed(2)}..${Math.max(...lag).toFixed(2)}`);
		check(`${name}: lateral stays inside the doctrine's width`,
			Math.max(...Array.from(lat, Math.abs)) <= d.lateral + 1e-9);
		check(`${name}: ${scouts} units ahead`, ahead === scouts, `${ahead}`);
		check(`${name}: ahead is bounded to ${AHEAD_MAX_S} s`, worstAheadLag >= -AHEAD_MAX_S - 1e-9, `${worstAheadLag.toFixed(3)} s`);
		check(`${name}: ahead lateral is bounded to ${AHEAD_LATERAL_MAX_M} m`,
			worstAheadLat <= AHEAD_LATERAL_MAX_M + 1e-9, `${worstAheadLat.toFixed(2)} m`);
		if (name !== 'column') {
			check(`${name}: about a third of them ahead`, Math.abs(ahead - size / 3) <= 1, `${ahead}/${size}`);
		} else {
			check('column: two scouts, the rest in file', ahead === 2);
		}
	}
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
	// Same doctrine, different cluster: the shape must not be a photocopy.
	let twins = 0;
	for (let i = 0; i < 60; i++) {
		const s = new SwarmModel({ size: 9, doctrineSeed: `d-${i}`, seed: 'x' });
		if (s.doctrine === a.doctrine && s.lag.every((v, k) => v === a.lag[k])) twins++;
	}
	check('two clusters of the same doctrine still differ', twins === 0, `${twins} twins`);
	check('size is clamped to 6..12', new SwarmModel({ size: 40, doctrineSeed: 'z' }).size === 12);
}

// -------------------------------------------------------------- the wake

console.log('\nswarm: the wake ring');
{
	const s = new SwarmModel({ size: 6, doctrineSeed: 'wake' });
	const refs = [s._wx, s._wy, s._wz, s._wt];
	const p = { x: 0, y: 10, z: 0 };
	// Straight line east at 10 m/s, one sample per 20 ms, well past a full ring.
	for (let i = 0; i <= 2000; i++) {
		const t = i * WAKE_DT_S;
		s._push(10 * t, 10, 0, t);
	}
	check('the ring never reallocates', s._wx === refs[0] && s._wy === refs[1] && s._wz === refs[2] && s._wt === refs[3]);
	check(`the ring holds exactly ${WAKE_SAMPLES} entries`, s._count === WAKE_SAMPLES, `${s._count}`);

	const newest = 2000 * WAKE_DT_S;
	let w = s._read(newest);
	check('reading the newest entry is exact', Math.abs(w.x - 10 * newest) < 0.05, `${w.x.toFixed(3)} vs ${(10 * newest).toFixed(3)}`);
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
	check('newer than the ring extrapolates along the tangent',
		Math.abs(w.x - 10 * (newest + 0.4)) < 0.1, `${w.x.toFixed(3)}`);

	// A short history — the first frames of a flight, or right after reset().
	const fresh = new SwarmModel({ size: 6, doctrineSeed: 'wake' });
	fresh._push(5, 10, 0, 100);
	fresh._push(6, 10, 0, 100.02);
	w = fresh._read(98);   // two seconds before anything was recorded
	check('a lag longer than the history folds back, it does not extrapolate backwards',
		Math.abs(w.x - 5) < 1e-3, `${w.x.toFixed(3)}`);
	const empty = new SwarmModel({ size: 6, doctrineSeed: 'wake' });
	check('an empty ring reads without throwing', empty._read(0).speed === 0);
}

// -------------------------------------------------- the central property

console.log('\nswarm: no unit is ever inside a building');
for (const name of DOCTRINE_NAMES) {
	// Pick a cluster seed that lands on this doctrine, so every doctrine is
	// actually flown through the city rather than whichever one comes up.
	let seed = null;
	for (let i = 0; i < 500 && seed === null; i++) if (doctrineFor(`c-${i}`) === name) seed = `c-${i}`;
	for (const [label, terrain] of [['rays honest', cityTerrain], ['every ray blocked', allBlocked]]) {
		const swarm = new SwarmModel({ size: 12, doctrineSeed: seed, seed: 'build' });
		let worst = null, worstDepth = 0, maxRays = 0;
		fly({
			swarm, terrain, seconds: 14, speed: 15,
			onStep: () => {
				maxRays = Math.max(maxRays, swarm.raysLastFrame);
				for (let k = 0; k < swarm.size; k++) {
					const o = 3 * k;
					const b = insideCity(swarm.pos[o], swarm.pos[o + 1], swarm.pos[o + 2]);
					if (!b) continue;
					const d = Math.min(
						swarm.pos[o] - b.min[0], b.max[0] - swarm.pos[o],
						swarm.pos[o + 2] - b.min[2], b.max[2] - swarm.pos[o + 2],
					);
					if (d > worstDepth) { worstDepth = d; worst = k; }
				}
			},
		});
		check(`${name} / ${label}: no penetration`, worst === null,
			worst === null ? '' : `unit ${worst} ${worstDepth.toFixed(2)} m in`);
		check(`${name} / ${label}: within the ray budget`, maxRays <= RAY_BUDGET, `${maxRays} rays/frame`);
	}
}

console.log('\nswarm: the fallback holds on its own');
{
	// Every ray blocked from the first frame: margins can never grow, so every
	// unit must be ON the recorded wake, not merely near it.
	const swarm = new SwarmModel({ size: 12, doctrineSeed: 'c-1', seed: 'b' });
	let worstOffset = 0, worstMargin = 0;
	fly({
		swarm, terrain: allBlocked, seconds: 10, speed: 18,
		onStep: () => {
			for (let k = 0; k < swarm.size; k++) {
				worstMargin = Math.max(worstMargin, swarm.margin[k]);
				worstOffset = Math.max(worstOffset, wakeDistance(swarm, k) - swarm._tubeR[k]);
			}
		},
	});
	check('margins never grow while blocked', worstMargin === 0, `${worstMargin}`);
	check('no unit leaves its tube', worstOffset < 1e-6, `${worstOffset.toExponential(2)} m`);

	// And the margin timings themselves: 0.3 s down, 1.5 s back up.
	const s2 = new SwarmModel({ size: 6, doctrineSeed: 'c-1', seed: 'b' });
	const open = { groundBelow: () => 0, obstructionBetween: () => ({ blocked: false, span: 0 }) };
	fly({ swarm: s2, terrain: open, seconds: MARGIN_RISE_S + 0.2, speed: 12 });
	check('margins reach 1 after the rise time', Math.min(...s2.margin) === 1, `${Math.min(...s2.margin).toFixed(3)}`);
	const p = { x: 0, y: 10, z: 0 };
	let t = MARGIN_RISE_S + 0.2;
	for (let i = 0; i < Math.round(MARGIN_FALL_S / (1 / 60)) + 2; i++) {
		t += 1 / 60; trackAt(t, p, 12);
		s2.update(p, t, 1 / 60, allBlocked, NO_WIND, null);
	}
	check(`margins are back to 0 after ${MARGIN_FALL_S} s of blocked rays`, Math.max(...s2.margin) === 0);
}

// ----------------------------------------------------------- ray budget

console.log('\nswarm: the ray budget');
{
	for (const size of [6, 8, 12]) {
		for (const name of DOCTRINE_NAMES) {
			let seed = null;
			for (let i = 0; i < 500 && seed === null; i++) if (doctrineFor(`c-${i}`) === name) seed = `c-${i}`;
			const swarm = new SwarmModel({ size, doctrineSeed: seed });
			let maxRays = 0;
			fly({ swarm, terrain: cityTerrain, seconds: 4, onStep: () => { maxRays = Math.max(maxRays, swarm.raysLastFrame); } });
			check(`${name} x${size}: at most ${RAY_BUDGET} rays a frame`, maxRays <= RAY_BUDGET, `${maxRays}`);
			check(`${name} x${size}: every unit ahead fits in the budget`, scoutsFor(name, size) <= RAY_BUDGET);
		}
	}

	// Priority: a unit ahead is tested every turn, a unit behind one in three.
	const swarm = new SwarmModel({ size: 12, doctrineSeed: 'c-1' });
	const tested = new Int32Array(swarm.size);
	const counting = {
		groundBelow: () => 0,
		obstructionBetween: () => ({ blocked: false, span: 0 }),
	};
	// Wrap _cast to see who was tested, without changing the model.
	const realCast = swarm._cast.bind(swarm);
	swarm._cast = (terrain, k) => { tested[k]++; realCast(terrain, k); };
	const frames = 240;
	fly({ swarm, terrain: counting, seconds: frames / 60 });
	let scoutMin = Infinity, rearMax = 0;
	for (let k = 0; k < swarm.size; k++) {
		if (swarm.lag[k] < 0) scoutMin = Math.min(scoutMin, tested[k]);
		else rearMax = Math.max(rearMax, tested[k]);
	}
	check('a unit ahead is tested every frame', scoutMin >= frames - 1, `${scoutMin}/${frames}`);
	check('a unit behind is tested about one frame in three', rearMax <= frames / 3 + 2, `${rearMax}/${frames}`);
}

// ------------------------------------------------------ physical bounds

console.log('\nswarm: physical bounds');
{
	const swarm = new SwarmModel({ size: 12, doctrineSeed: 'c-1', seed: 'b' });
	let maxV = 0, maxA = 0, maxTilt = 0, maxStep = 0;
	const prev = new Float64Array(3 * swarm.size);
	const dt = 1 / 60;
	fly({
		swarm, terrain: cityTerrain, seconds: 12, speed: 22, dt,
		wind: { x: 4, y: 0.5, z: -3 },
		onStep: (t, p, i) => {
			for (let k = 0; k < swarm.size; k++) {
				const o = 3 * k;
				maxV = Math.max(maxV, Math.hypot(swarm.vel[o], swarm.vel[o + 1], swarm.vel[o + 2]));
				maxA = Math.max(maxA, Math.hypot(swarm.acc[o], swarm.acc[o + 1], swarm.acc[o + 2]));
				maxTilt = Math.max(maxTilt, tiltOf(swarm.quat, 4 * k) * 180 / Math.PI);
				if (i > 0) maxStep = Math.max(maxStep, Math.hypot(swarm.pos[o] - prev[o], swarm.pos[o + 1] - prev[o + 1], swarm.pos[o + 2] - prev[o + 2]) / dt);
				prev[o] = swarm.pos[o]; prev[o + 1] = swarm.pos[o + 1]; prev[o + 2] = swarm.pos[o + 2];
			}
		},
	});
	check('speed stays under what the airframe flies', maxV <= SPEED_MAX + 1e-9, `${maxV.toFixed(2)} / ${SPEED_MAX} m/s`);
	check('acceleration stays under what the TWR buys', maxA <= ACCEL_MAX + 1e-9, `${maxA.toFixed(2)} / ${ACCEL_MAX.toFixed(2)} m/s2`);
	check(`tilt stays under ${TILT_MAX_DEG}°`, maxTilt <= TILT_MAX_DEG + 1e-6, `${maxTilt.toFixed(1)}°`);
	// The wake tube is a constraint, not a teleport: it may add at most its own
	// rate limit on top of the spring, and never more than that.
	check('no unit is ever moved faster than two airframes', maxStep <= 2 * SPEED_MAX + 1e-6, `${maxStep.toFixed(2)} m/s`);
	check('the drag comes from the toothpick, scaled by area',
		Math.abs(SWARM_UNIT.bodyDrag.x - 0.0018 * (0.027 / 0.038) ** 2) < 1e-12);
}

console.log('\nswarm: it falls behind at full stick and catches back up');
{
	const swarm = new SwarmModel({ size: 8, doctrineSeed: 'c-1', seed: 'b' });
	const open = { groundBelow: () => 0, obstructionBetween: () => ({ blocked: false, span: 0 }) };
	const p = { x: 0, y: 30, z: 0 };
	swarm.reset(p);
	const dt = 1 / 60;
	let t = 0, lag = 0;
	// 6 s at 34 m/s: well past what a unit can fly.
	for (let i = 0; i < Math.round(6 / dt); i++) {
		t += dt; p.z -= 34 * dt;
		swarm.update(p, t, dt, open, NO_WIND, null);
	}
	for (let k = 0; k < swarm.size; k++) {
		const o = 3 * k;
		lag = Math.max(lag, Math.hypot(swarm.pos[o] - swarm._slot[o], swarm.pos[o + 1] - swarm._slot[o + 1], swarm.pos[o + 2] - swarm._slot[o + 2]));
	}
	check('the swarm loses its slots when the node outruns it', lag > 5, `${lag.toFixed(1)} m behind`);
	// Now the node stops. They must come back onto their slots.
	for (let i = 0; i < Math.round(8 / dt); i++) {
		t += dt;
		swarm.update(p, t, dt, open, NO_WIND, null);
	}
	let after = 0;
	for (let k = 0; k < swarm.size; k++) {
		const o = 3 * k;
		after = Math.max(after, Math.hypot(swarm.pos[o] - swarm._slot[o], swarm.pos[o + 1] - swarm._slot[o + 1], swarm.pos[o + 2] - swarm._slot[o + 2]));
	}
	check('and they catch back up once it slows', after < 1, `${after.toFixed(2)} m off slot`);
}

// ------------------------------------------------------------ allocation

console.log('\nswarm: update() allocates nothing');
{
	const swarm = new SwarmModel({ size: 12, doctrineSeed: 'c-1', seed: 'b' });
	const refs = {
		pos: swarm.pos, vel: swarm.vel, acc: swarm.acc, quat: swarm.quat,
		margin: swarm.margin, blocked: swarm.blocked, lag: swarm.lag,
		wx: swarm._wx, wt: swarm._wt, slot: swarm._slot, sep: swarm._sep,
	};
	const dbg0 = swarm.debug();
	const p = { x: 0, y: 10, z: 120 };
	swarm.reset(p);
	let t = 0;
	for (let i = 0; i < 1000; i++) {
		t += 1 / 60;
		trackAt(t, p, 15);
		swarm.update(p, t, 1 / 60, cityTerrain, NO_WIND, { bbox: { min: [-400, 0, -400], max: [400, 200, 400] } });
	}
	let same = true;
	for (const key of Object.keys(refs)) same = same && refs[key] === (swarm[key] || swarm[`_${key}`]);
	check('every array is the same array after 1000 steps',
		swarm.pos === refs.pos && swarm.vel === refs.vel && swarm.acc === refs.acc && swarm.quat === refs.quat
		&& swarm.margin === refs.margin && swarm.blocked === refs.blocked && swarm.lag === refs.lag
		&& swarm._wx === refs.wx && swarm._wt === refs.wt && swarm._slot === refs.slot && swarm._sep === refs.sep);
	check('debug() hands back the same object', swarm.debug() === dbg0 && dbg0.lagRange.length === 2);
	check('debug() reports what the browser check needs',
		typeof dbg0.size === 'number' && typeof dbg0.doctrine === 'string'
		&& typeof dbg0.raysCast === 'number' && typeof dbg0.blockedUnits === 'number');
	check('a frozen frame does nothing', (() => {
		const before = swarm.pos.slice();
		swarm.update(p, t, 0, cityTerrain, NO_WIND, null);
		return before.every((v, i) => v === swarm.pos[i]);
	})());
	// reset() must put them back where nothing can be wrong: on the player.
	swarm.reset(p);
	let off = 0;
	for (let k = 0; k < swarm.size; k++) off = Math.max(off, Math.hypot(swarm.pos[3 * k] - p.x, swarm.pos[3 * k + 1] - p.y, swarm.pos[3 * k + 2] - p.z));
	check('reset() empties the wake and stacks them on the player', swarm._count === 0 && off === 0);
}

// ---------------------------------------------------------------- fence

console.log('\nswarm: the fence');
{
	// Pre-baked: a bbox the player hugs the edge of. cloud has the widest
	// offsets, so it is the doctrine that would spill.
	const bbox = { min: [-60, 0, -200], max: [60, 200, 200] };
	const swarm = new SwarmModel({ size: 12, doctrineSeed: 'c-1', seed: 'b' });
	const open = { groundBelow: () => 0, obstructionBetween: () => ({ blocked: false, span: 0 }) };
	let out = 0;
	fly({
		swarm, terrain: open, seconds: 12, speed: 15, fence: { bbox },
		// Fly along the very edge of the box: x = 55, 5 m from the wall.
		track: (t, o, speed) => { o.x = 55; o.y = 10; o.z = 150 - speed * t; return o; },
		onStep: () => {
			for (let k = 0; k < swarm.size; k++) {
				const p = { x: swarm.pos[3 * k], y: swarm.pos[3 * k + 1], z: swarm.pos[3 * k + 2] };
				if (horizontalMargin(p, bbox) < 0 || verticalMargin(p, bbox) < 0) out++;
			}
		},
	});
	check('no unit leaves a pre-baked bbox', out === 0, `${out} samples outside`);

	// Live: a trust circle around the window centre.
	const fence = { center: { x: 0, y: 0, z: 0 }, radius: 120 };
	const s2 = new SwarmModel({ size: 12, doctrineSeed: 'c-1', seed: 'b' });
	let outLive = 0;
	fly({
		swarm: s2, terrain: open, seconds: 12, speed: 15, fence,
		track: (t, o, speed) => { o.x = 0; o.y = 10; o.z = 115 - speed * t * 0; return o; },
		onStep: () => {
			for (let k = 0; k < s2.size; k++) {
				if (Math.hypot(s2.pos[3 * k] - fence.center.x, s2.pos[3 * k + 2] - fence.center.z) > fence.radius) outLive++;
			}
		},
	});
	check('no unit leaves the live trust circle', outLive === 0, `${outLive} samples outside`);
}

console.log(`\n${failures === 0 ? 'OK' : `${failures} FAILURE(S)`}  (${rayCalls} stub rays cast)`);
process.exit(failures === 0 ? 0 : 1);

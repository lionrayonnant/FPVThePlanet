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
	AHEAD_MAX_S, AHEAD_LATERAL_MAX_M, AHEAD_VERTICAL_MAX_M, MARGIN_FALL_S, MARGIN_RISE_S,
	MIN_SIZE, MAX_SIZE,
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
// Built by a factory, because the street WIDTH is a sampling axis of its own:
// three rounds of this file varied seeds, speeds and cadences and left the
// geometry at one value, and a 12 m street is where the doctrines' own +-10 m
// ambition stops fitting (see the geometry sweep further down).
const HEIGHT = 40;
function makeCity(pitch, halfStreet) {
	const boxes = [];
	for (let a = -5; a <= 5; a++) {
		for (let b = -5; b <= 5; b++) {
			boxes.push({
				min: [pitch * a + halfStreet, 0, pitch * b + halfStreet],
				max: [pitch * (a + 1) - halfStreet, HEIGHT, pitch * (b + 1) - halfStreet],
			});
		}
	}
	const hit = { blocked: false, span: 0 };
	return {
		boxes, pitch, halfStreet,
		inside(x, y, z) {
			for (const b of boxes) {
				if (x > b.min[0] && x < b.max[0] && y > b.min[1] && y < b.max[1] && z > b.min[2] && z < b.max[2]) return b;
			}
			return null;
		},
		terrain: {
			groundBelow: () => 0,
			obstructionBetween(x1, y1, z1, x2, y2, z2) {
				rayCalls++;
				const dx = x2 - x1, dy = y2 - y1, dz = z2 - z1;
				const len = Math.hypot(dx, dy, dz);
				let span = 0;
				for (const b of boxes) {
					const h = slab(x1, y1, z1, dx, dy, dz, b);
					if (h) span += (h[1] - h[0]) * len;
				}
				hit.blocked = span > 0; hit.span = span;
				return hit;
			},
		},
	};
}
const CITY = makeCity(60, 7.5);
const BOXES = CITY.boxes;
const insideCity = (x, y, z) => CITY.inside(x, y, z);
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
let rayCalls = 0;
const cityTerrain = CITY.terrain;
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
	// 3 m radius by default, so the exit leg is at x = 6 and the whole figure
	// stays inside the 15 m street. (A 6 m radius put the PLAYER through a
	// wall, and the swarm dutifully followed him there — the test was wrong,
	// the model was right, and it took reading the snapshot to tell. Which is
	// why hairpinOf() below is only ever used through fitsCity().)
	hairpin(t, p, v) { return hairpinOf(3)(t, p, v); },
	// Straight and fast, for the decoupling regimes.
	straight(t, p, v) { p.x = 0; p.y = 10; p.z = 200 - v * t; return p; },
	hover(t, p) { p.x = 0; p.y = 10; p.z = 0; return p; },
};

// The same figure at any radius, for the geometry sweep.
function hairpinOf(radius) {
	return (t, p, v) => {
		p.y = 10;
		const leg = 120 / v, turn = Math.PI * radius / v;
		if (t < leg) { p.x = 0; p.z = 120 - v * t; return p; }
		if (t < leg + turn) {
			const a = (t - leg) / turn * Math.PI;
			p.x = radius - radius * Math.cos(a); p.z = -radius * Math.sin(a);
			return p;
		}
		p.x = 2 * radius; p.z = -v * (t - leg - turn);
		return p;
	};
}

// A slalom down one street: the player weaves from wall to wall, so the track
// frame rolls continuously and the wake itself sweeps sideways at several
// metres a second under units that are holding an offset. It is not a corner
// case — it is what flying down a street looks like — and it is where the
// penetration that this suite accepts for v1 actually happens.
function slalomOf(amplitude, period) {
	return (t, p, v) => {
		p.y = 10;
		p.z = 200 - v * t;
		p.x = amplitude * Math.sin(2 * Math.PI * v * t / period);
		return p;
	};
}

// Does the PLAYER's own figure fit down this city's streets, with a metre to
// spare? A track that flies the node through a wall measures nothing about the
// swarm — it was already the bug in one earlier version of the hairpin — so
// every geometry pair is filtered through this before it is flown.
function fitsCity(city, track, v, seconds = 14) {
	const p = { x: 0, y: 10, z: 0 };
	for (let t = 0; t <= seconds; t += 0.02) {
		track(t, p, v);
		if (city.inside(p.x, p.y, p.z)) return false;
		if (city.inside(p.x + 1, p.y, p.z) || city.inside(p.x - 1, p.y, p.z)) return false;
		if (city.inside(p.x, p.y, p.z + 1) || city.inside(p.x, p.y, p.z - 1)) return false;
	}
	return true;
}

// The harness. Returns everything the assertions need, measured over the whole
// flight: deepest penetration, worst effective speed, worst distance off the
// wake beyond what the margin bought, worst margin, ray peak.
const _p = { x: 0, y: 10, z: 200 };
const _prev = new Float64Array(3 * 12);
function fly({ seed, size = 12, seconds = 15, dt = 1 / 60, speed = 15, terrain = null, city = CITY,
	wind = NO_WIND, fence = null, track = TRACKS.corner, resetAt = null, shrink = null, watchWake = false,
	hitch = null, watchGap = false }) {
	terrain = terrain || city.terrain;
	const swarm = new SwarmModel({ size, doctrineSeed: seed, seed: 'build' });
	track(0, _p, speed);
	swarm.reset(_p);
	let t = 0;
	const out = { swarm, depth: 0, unit: -1, maxRays: 0, maxStep: 0, maxMargin: 0, maxOffWake: 0, maxTilt: 0, outFence: 0, maxGap: 0, maxWait: 0, minDt: dt, meanMargin: 0, meanOffset: 0 };
	let mSum = 0, oSum = 0, mN = 0;
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
		// How long a unit actually waits between two of its own rays, read off
		// the model's own turnstile rather than assumed. This is the latency
		// the whole reaction chain runs at, and the bound below is derived from
		// it — see the geometry block.
		for (let k = 0; k < swarm.size; k++) {
			if (swarm._lastCast[k] <= 0) continue;
			const wait = swarm._clock - swarm._lastCast[k];
			if (wait > out.maxWait) out.maxWait = wait;
		}
		for (let k = 0; k < swarm.size; k++) {
			const o = 3 * k;
			const b = city.inside(swarm.pos[o], swarm.pos[o + 1], swarm.pos[o + 2]);
			if (b) {
				const d = depthIn(swarm.pos[o], swarm.pos[o + 2], b);
				if (d > out.depth) { out.depth = d; out.unit = k; }
			}
			if (i > 0) {
				const st = Math.hypot(swarm.pos[o] - _prev[o], swarm.pos[o + 1] - _prev[o + 1], swarm.pos[o + 2] - _prev[o + 2]) / dt;
				if (st > out.maxStep) out.maxStep = st;
			}
			if (swarm.margin[k] > out.maxMargin) out.maxMargin = swarm.margin[k];
			// After the first second: what the swarm looks like in flight, not
			// while it is still climbing out of reset().
			if (t > 1) {
				mSum += swarm.margin[k];
				oSum += Math.hypot(swarm._o[o], swarm._o[o + 1], swarm._o[o + 2]);
				mN++;
			}
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
	if (mN) { out.meanMargin = mSum / mN; out.meanOffset = oSum / mN; }
	return out;
}

const seedFor = (name) => {
	for (let i = 0; i < 500; i++) if (doctrineFor(`c-${i}`) === name) return `c-${i}`;
	throw new Error(`no seed for ${name}`);
};
const SEEDS = Object.fromEntries(DOCTRINE_NAMES.map((n) => [n, seedFor(n)]));

// Six cluster seeds per doctrine. One seed per doctrine is not a sample: the
// slots it draws are one shape out of a family, and a shape that happens to fit
// down the middle of a street proves nothing about the one that does not. The
// regression this caught (0.74 m inside a building at 60 fps with no hitch at
// all) was invisible to a four-seed matrix and showed on the fifty-fifth seed.
const SEED_SWEEP = [];
for (const name of DOCTRINE_NAMES) {
	let found = 0;
	for (let i = 0; i < 500 && found < 6; i++) {
		if (doctrineFor(`c-${i}`) === name) { SEED_SWEEP.push(`c-${i}`); found++; }
	}
}

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
				if (lag[k] < 0 && (lag[k] < -AHEAD_MAX_S - 1e-9 || Math.abs(lat[k]) > AHEAD_LATERAL_MAX_M + 1e-9 || Math.abs(vert[k]) > AHEAD_VERTICAL_MAX_M + 1e-9)) bad += `${name}/${size} ahead ${lag[k]}/${lat[k]}/${vert[k]} `;
			}
		}
	}
	check('drawn slots stay inside their doctrine and the three ahead bounds', bad === '', bad.slice(0, 120));

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

// The only regime with a tolerance, and it is a CEILING, not a reading: a
// 3 m hairpin in a 15 m street sweeps the whole corridor sideways under a unit
// in 0.4 s, and on a frame the render loop has clamped to 250 ms the fold
// starts one frame late. The offsets retract at the airframe's own top speed,
// so what is left is a corner clipped for a fraction of a second — not a
// machine flying through a wall. Raising OVERREACH_M does not close it
// (measured at 4, 5 and 6 m: 0.80 / 0.92 / 0.79 m, no better, and the swarm
// loses well over a third of its spread in the city): it is a fold transient,
// not a detection range.
//
// The number is set from the sweep below, with real headroom, and the sweep
// lives in this file so the ceiling keeps its evidence. The headroom is not
// timidity: the depth of a fold transient is not a monotone function of the
// constants around it (MARGIN_RISE_PER_RAY at 0.07 gives 0.97 m, at 0.09 gives
// 0.61), so a ceiling pinned to the last reading would break on an unrelated
// tweak.
//
// AND IT DID, TWICE, THE SAME WAY. 1 m was read off four seeds at size twelve
// and called a tolerance; the same regime over 96 seeds and four sizes reaches
// 3.41 m ON THE CODE THAT WROTE IT — tranche 7 measured it while checking that
// the new doctrines had not caused the 1.49 m it happened to hit, and they had
// not: the same 3072-flight sweep gives 3.41 m before the doctrine change and
// 3.47 m after. The seed set was the whole difference. So the number below is
// no longer a reading with a round number over it, it is a ceiling over a
// sweep wide enough to have a distribution, and the sweep now carries the size
// axis that was missing.
//
// WHAT IT MEANS, said plainly: on 250 ms frames a unit can be three and a half
// metres inside the inside wall of a 3 m hairpin for a fraction of a second.
// That is the render loop's own clamp — 4 fps — and it is the regime issue #38
// tracks. It is not the nominal cadences: those are held to ACCEPTED_TIGHT_M
// and ACCEPTED_WEAVE_M below, which are an order of magnitude smaller.
const LONG_FRAME_CEILING_M = 4.5;

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
		// The ceilings below come from LONG_FRAME_CEILING_M, which is a sweep
		// and not a reading (see the check after the matrix).
		//
		// The fast rows were once dropped from this block on the argument that
		// a 3 m hairpin at 34 m/s asks for 385 m/s2 of lateral acceleration,
		// "fourteen times what the node's TWR allows". That argument was
		// arithmetic with two different denominators (385/27 against 161/43),
		// and applied honestly it condemned the rows that were KEPT as well —
		// 15 m/s is 2.8x the same bound and 22 m/s is 6.0x. There is no
		// plausibility criterion here, so none is stated: the rows are back at
		// zero tolerance because they measure 0.00 m, which is the only reason
		// a row belongs in a matrix.
		{ label: 'hairpin at 15, dt 250 ms', speed: 15, dt: 0.25, track: TRACKS.hairpin, tol: LONG_FRAME_CEILING_M },
		{ label: 'hairpin at 22, dt 250 ms', speed: 22, dt: 0.25, track: TRACKS.hairpin, tol: LONG_FRAME_CEILING_M },
		{ label: 'hairpin at 34, dt 250 ms', speed: 34, dt: 0.25, track: TRACKS.hairpin },
		{ label: 'hairpin at 45, dt 250 ms', speed: 45, dt: 0.25, track: TRACKS.hairpin },
		{ label: 'hairpin at 34', speed: 34, dt: 1 / 60, track: TRACKS.hairpin },
		{ label: 'hairpin at 45', speed: 45, dt: 1 / 60, track: TRACKS.hairpin },
		// And the shape a real stall has: a hitch inside a steady frame rate,
		// which a uniformly slow flight does not reproduce.
		{ label: 'a 250 ms hitch every 37 frames', speed: 22, hitch: { base: 1 / 60, dt: 0.25, every: 37 } },
		{ label: 'a 250 ms hitch every 37 frames, hairpin', speed: 22, track: TRACKS.hairpin, hitch: { base: 1 / 60, dt: 0.25, every: 37 }, tol: LONG_FRAME_CEILING_M },
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

console.log('\nswarm: ...over a sweep of cluster seeds, not one per doctrine');
{
	// 24 seeds x 2 tracks x 5 speeds at 60 fps, honest rays. The speeds around
	// 15 m/s are there on purpose: that is where the regression lived, and a
	// matrix that only sampled 15, 22, 30, 34 and 45 stepped straight over it.
	let worst = 0, at = '';
	for (const seed of SEED_SWEEP) {
		for (const track of [TRACKS.corner, TRACKS.hairpin]) {
			for (const speed of [14, 15, 16, 22, 30]) {
				const out = fly({ seed, seconds: 10, speed, track });
				if (out.depth > worst) { worst = out.depth; at = `${seed}/${doctrineFor(seed)} at ${speed}`; }
			}
		}
	}
	check(`${SEED_SWEEP.length} cluster seeds x 2 tracks x 5 speeds, nobody inside a building`,
		worst === 0, worst === 0 ? `${SEED_SWEEP.length * 10} flights` : `${worst.toFixed(2)} m in, ${at}`);

	// And the evidence behind LONG_FRAME_CEILING_M: the same sweep in the two
	// regimes that have one. A tolerance read off four seeds is a measurement
	// pretending to be a bound.
	// SIZE is an axis here too, and it was missing: this block flew fly()'s
	// default twelve. Six is where the worst reading below happens — a small
	// swarm gets a ray per unit per frame, so its margins stay high and it
	// stays DEPLOYED into the corner, where a starved swarm of twelve would
	// already have folded onto the wake.
	let long1 = 0, long2 = 0, at1 = '', at2 = '', flights = 0;
	for (const seed of SEED_SWEEP) {
		for (const speed of [12, 15, 18, 22]) {
			for (const size of [6, 9, 12]) {
				flights += 2;
				const d1 = fly({ seed, size, seconds: 12, speed, dt: 0.25, track: TRACKS.hairpin }).depth;
				if (d1 > long1) { long1 = d1; at1 = `${doctrineFor(seed)}/${seed} n=${size} at ${speed}`; }
				const d2 = fly({ seed, size, seconds: 12, speed, track: TRACKS.hairpin, hitch: { base: 1 / 60, dt: 0.25, every: 37 } }).depth;
				if (d2 > long2) { long2 = d2; at2 = `${doctrineFor(seed)}/${seed} n=${size} at ${speed}`; }
			}
		}
	}
	check(`the 250 ms hairpin stays under the ${LONG_FRAME_CEILING_M} m ceiling across the sweep`,
		long1 <= LONG_FRAME_CEILING_M, `${long1.toFixed(2)} m over ${flights} flights (${at1})`);
	check(`so does the hitched hairpin`, long2 <= LONG_FRAME_CEILING_M, `${long2.toFixed(2)} m (${at2})`);
}

console.log('\nswarm: ...and over the geometry, over the swarm size, and over the cadence');
{
	// The fourth and fifth sampling axes. Three rounds of fixes each found the
	// hole the round before had left on ONE new axis — a cluster seed, a speed,
	// a cadence — while the CITY stayed 15 m wide and the swarm stayed twelve
	// strong. Both of those turned out to matter, and neither was sampled:
	//
	//  - street width, because the doctrines ask for +-10 m of lateral offset
	//    whatever the street is. In a 12 m street the fold/redeploy loop
	//    oscillated against the walls and put a unit 1.30 m inside a building
	//    at 60 fps with no hitch at all (closed by the margin ceiling,
	//    CEIL_BACKOFF in swarm.js);
	//  - swarm size, because the ray budget is per FRAME: a swarm of six gets a
	//    ray per rear unit per frame, a swarm of twelve one in three or four.
	//    Size twelve is therefore the SAFEST size, and it was the only one
	//    tested.
	//
	// THE BOUND. An earlier version of this block asserted "one frame of flight
	// at SPEED_MAX", presented as the mechanism's own bound. That reasoning
	// forgot the turnstile: a rear unit is not asked every frame, it is asked
	// once per slot, and the model's own `_lastCast` says the wait reaches
	// three frames. The latency of the whole chain is therefore several frames,
	// and the bound built on one frame was simply false — it broke at 10 and
	// 12 fps (3.39 m against 2.40) on cadences the block did not sample.
	//
	// So the ceiling is read off the model instead of postulated. It is the
	// whole reaction chain, in the units the model actually works in:
	//
	//     SPEED_MAX * (maxWait + dt + MARGIN_FALL_S)
	//
	// `maxWait` is the longest a unit actually went between two of its own rays
	// during THIS flight, read off `_lastCast`; `dt` is the frame it acts on
	// the verdict in; and MARGIN_FALL_S is the fold itself, which is a FLIGHT
	// of 0.3 s and not an instant.
	//
	// WHAT THAT BOUND IS AND IS NOT. It says what the LATENCY ALLOWS, not what
	// the mechanism guarantees. The distinction is not pedantic, and the fold
	// term is not padding: the earlier form, SPEED_MAX * (maxWait + dt), was
	// false per unit and only ever held by accident. A scout is asked every
	// single frame, so its own wait is one frame — and it still reaches 317 %
	// of SPEED_MAX * dt, because acting on a red verdict takes 0.3 s of folding
	// whatever the ray cadence was. What kept the old check green was that
	// `maxWait` is a maximum over the WHOLE FLIGHT and over every unit, so the
	// worst-served rear unit's wait silently paid for the fold time of the
	// best-served scout. Add one geometry where that no longer covers — a
	// period-30 slalom at 60 fps, where the wait stays at 50 ms — and it breaks
	// at 140 %, on code that had not changed. Written with the fold in, it is a
	// budget rather than a proof, and it is loose at low frame rates on
	// purpose: it should not flatter the model.
	//
	// A loose bound is not a guard, so a second, ABSOLUTE ceiling holds at the
	// cadences the render loop is not clamping (dt <= 1/30). Those numbers are
	// not derived: they are the penetration ACCEPTED for v1, decided rather
	// than measured away — closing them would cost either a fold faster than
	// the spec's 0.3 s or more than six rays a frame, and the call was to keep
	// both. They are here so the accepted figure is visible and cannot drift.
	const NOMINAL_DT = 1 / 30 + 1e-9;
	// Both numbers below were re-measured in tranche 7 over a sweep wide enough
	// to have a distribution: 48 cluster seeds (twelve per doctrine), sizes
	// 6/8/10/12, 12/15/22 m/s, all twelve geometries, 60 and 30 fps — 3 456
	// flights per cadence and per figure. They are ACCEPTED PENETRATIONS for
	// v1, decided rather than measured away; the job here is to make them TRUE,
	// not to make them small.
	//
	// hairpin: the track frame turns over, but nothing sweeps sideways.
	// 0.5 m was FALSE, and pre-existing: the wide sweep reads 1.11 m on the
	// code before tranche 7 and 1.13 m after, both at 30 fps in a 10 m street
	// with a 2 m hairpin, both on a `screen` — the seed set was the entire
	// difference, and the six fixed seeds this block used to fly simply never
	// drew that shape. 1.5 m is the reading with a third of headroom.
	const ACCEPTED_TIGHT_M = 1.5;
	// slalom: the wake itself crosses the street under the swarm — the regime
	// where a unit holding a lateral offset is carried through a wall by the
	// track rolling under it, and the one this suite accepts the most from.
	//
	// 2.5 m came from the same wide sweep on the OLD doctrines: 2.36 m at
	// 60 fps, a `cloud` of twelve in a 10 m street. Recentring the doctrines
	// around lag ~0 (tranche 7) cuts it to 0.75 m — a swarm that spends its
	// budget on width instead of length is holding its offset over track the
	// player validated a fraction of a second ago instead of two seconds ago,
	// and the weave has that much less time to sweep out from under it. So the
	// accepted figure comes DOWN to 1.5 m, which is twice the reading. It lands
	// on the same number as the hairpin above by coincidence, not by kinship:
	// the two figures fail through different mechanisms and stay separate.
	const ACCEPTED_WEAVE_M = 1.5;
	const HAIRPINS = [[60, 7.5, 3], [60, 7.5, 2.5], [60, 6, 2.5], [60, 6, 2], [60, 5, 2], [60, 5, 1.5]];
	// A slalom's shape is its AMPLITUDE and its PERIOD; the street width sets
	// the amplitude and the hairpin radius has nothing to do with it. Sharing
	// the hairpin list meant slalomOf(half - 2, 40) was built twice per street
	// width, so six geometries were three cities and the "324 flights" were 162
	// flown twice. Here each width appears once and the period is a real axis:
	// 40 m is the shape ACCEPTED_WEAVE_M used to be calibrated on, 30 m is the
	// tighter weave that costs 2.30 m.
	const SLALOMS = [];
	for (const half of [7.5, 6, 5]) for (const period of [30, 40]) SLALOMS.push([60, half, period]);
	// Every size from MIN_SIZE to MAX_SIZE, not 6/9/12. The ray budget is per
	// FRAME, so the number of units is a first-class axis of the safety
	// argument, and the three-size sample stepped straight over n=8 — the size
	// on which the weave that raised ACCEPTED_WEAVE_M is worst.
	const SIZES = [];
	for (let n = MIN_SIZE; n <= MAX_SIZE; n++) SIZES.push(n);
	// THE SEED DRAW. `SEED_SWEEP.filter((_, i) => i % 4 === 0)` used to pick the
	// six seeds this block flies. SEED_SWEEP is doctrine-major, six per
	// doctrine, so every fourth entry is 2/1/2/1 per doctrine — an accidental
	// imbalance nobody chose, and six slot draws to calibrate two accepted
	// penetrations that a seventh draw falsifies (ACCEPTED_TIGHT_M was 0.5 m
	// and a wide sweep reads 1.13 m).
	//
	// So: a pool of twelve seeds per doctrine, and each cell of the loop below
	// takes TWO PER DOCTRINE from it, advancing through the pool cell by cell.
	// Eight cells x eight seeds walks the whole 48-seed pool while flying the
	// same eight seeds per line — sixteen times the slot draws at no cost. The
	// price is that the sample is no longer fully crossed: a given seed does
	// not see every cadence. For a WORST-OF over a distribution that is the
	// right trade, and it is stated here rather than left to be discovered.
	const POOL_PER_DOCTRINE = 12;
	const SEED_POOL = [];
	for (const name of DOCTRINE_NAMES) {
		let found = 0;
		for (let i = 0; i < 4000 && found < POOL_PER_DOCTRINE; i++) {
			if (doctrineFor(`c-${i}`) === name) { SEED_POOL.push(`c-${i}`); found++; }
		}
	}
	let cell = 0;
	const nextSeeds = () => {
		const out = [];
		for (let d = 0; d < DOCTRINE_NAMES.length; d++) {
			for (let j = 0; j < 2; j++) out.push(SEED_POOL[d * POOL_PER_DOCTRINE + (2 * cell + j) % POOL_PER_DOCTRINE]);
		}
		cell++;
		return out;
	};
	let skipped = 0;
	// 60 fps and 30 fps are what a machine that copes looks like; 12 fps is the
	// intermediate cadence where the old bound broke and nothing sampled it;
	// 4 fps is the 250 ms clamp itself.
	for (const dt of [1 / 60, 1 / 30, 1 / 12, 0.25]) {
		for (const [kind, accepted, cases] of [['hairpin', ACCEPTED_TIGHT_M, HAIRPINS], ['slalom', ACCEPTED_WEAVE_M, SLALOMS]]) {
			let worst = 0, at = '', flights = 0, ratio = 0, ratioAt = '';
			const cellSeeds = nextSeeds();
			for (const [pitch, half, shape] of cases) {
				const city = makeCity(pitch, half);
				const track = kind === 'hairpin' ? hairpinOf(shape) : slalomOf(half - 2, shape);
				// The figure, named for what it actually is: the old label said
				// "N m hairpin" on the slalom lines too, which pointed at a
				// radius nothing in those flights ever used.
				const figure = kind === 'hairpin' ? `${shape} m hairpin` : `period ${shape} m slalom`;
				if (!fitsCity(city, track, 15)) { skipped++; continue; }
				for (const size of SIZES) {
					for (const speed of [12, 15, 22]) {
						for (const seed of cellSeeds) {
							const out = fly({ seed, size, seconds: 12, speed, dt, city, track });
							flights++;
							// Every flight is judged against ITS OWN latency, so a
							// flight whose units happened to be asked often
							// cannot buy room for one whose units were not.
							const bound = SPEED_MAX * (out.maxWait + dt + MARGIN_FALL_S);
							if (out.depth / bound > ratio) {
								ratio = out.depth / bound;
								ratioAt = `${out.depth.toFixed(2)} m against ${bound.toFixed(2)} m (${(out.maxWait * 1000).toFixed(0)} ms of wait)`;
							}
							if (out.depth > worst) { worst = out.depth; at = `${half * 2} m street, ${figure}, n=${size}, ${speed} m/s, ${seed}`; }
						}
					}
				}
			}
			const fps = (1 / dt).toFixed(0);
			check(`${fps} fps, ${kind}: never further in than SPEED_MAX x (this flight's own worst ray wait + one frame + the fold)`,
				ratio <= 1, `worst ${(ratio * 100).toFixed(0)} % of the bound over ${flights} flights — ${ratioAt}`);
			if (dt <= NOMINAL_DT) {
				check(`${fps} fps, ${kind}: under the ${accepted} m accepted for v1 (a decision, not a measurement)`,
					worst <= accepted, `worst ${worst.toFixed(2)} m — ${at}`);
			}
		}
	}
	check('the geometries that put the PLAYER through a wall are skipped, not flown',
		skipped === 0, `${skipped} of ${(HAIRPINS.length + SLALOMS.length) * 4} rejected by fitsCity()`);
}

console.log('\nswarm: it stays deployed when the frame rate does not');
{
	// The failure this whole tranche exists to avoid is "they fly in single
	// file for no reason". A ray budget counted per FRAME makes that a function
	// of frame rate unless the freshness rules are written in the right units,
	// and they were not: at 20 fps the swarm folded flat IN CLEAR SKY.
	for (const fps of [60, 30, 20, 15]) {
		let open = 0, town = 0, spread = 0, n = 0;
		for (const seed of SEED_SWEEP) {
			const a = fly({ seed, seconds: 12, speed: 20, dt: 1 / fps, terrain: openTerrain });
			const b = fly({ seed, seconds: 12, speed: 20, dt: 1 / fps });
			open += a.meanMargin; town += b.meanMargin; spread += b.meanOffset; n++;
		}
		open /= n; town /= n; spread /= n;
		check(`${fps} fps: deployed in clear sky`, open >= 0.9, `mean margin ${open.toFixed(2)}`);
		// The 1.5 m floor is CALIBRATED ON THIS CITY, whose streets are 15 m
		// wide. It is not a property of the model: in 12 m streets the same
		// swarm holds 0.87 m and that is the right answer, not a regression.
		// What the floor guards is a silent drift of the safety constants
		// towards single file at a fixed geometry; the number itself waits on
		// the real-scene block of the spec.
		check(`${fps} fps: still spread out in the city (floor calibrated on 15 m streets)`,
			town >= 0.6 && spread >= 1.5,
			`mean margin ${town.toFixed(2)}, mean offset held ${spread.toFixed(2)} m`);
	}
}

console.log('\nswarm: the scouts stay in front of the pilot');
{
	// The defect this block exists for, reported from a real flight: "there is
	// no drone in front of me". A third of the swarm is built ahead of the node
	// and buildSlots() does put them there — but one margin used to answer for
	// both halves of a scout's slot, the forward extrapolation and the lateral
	// offset. In a 12 m street the lateral half is dead most of the time (that
	// is what a 4 m offset in a 12 m street means), and at margin 0 the fold
	// reads `fileLag`, which is POSITIVE: the scout was filed BEHIND the node.
	//
	// So the case that matters is not "a scout is ahead" — in clear sky it
	// always was — it is A SCOUT WHOSE LATERAL MARGIN IS 0 AND WHICH IS STILL
	// AHEAD. The first check makes sure the flight actually produces that
	// situation, so the second one cannot pass by never meeting it.
	const street = makeCity(60, 6);
	const dt = 1 / 60, speed = 14, amplitude = 4;
	let folded = 0, foldedAhead = 0, scouts = 0, scoutsAhead = 0;
	for (const name of DOCTRINE_NAMES) {
		const swarm = new SwarmModel({ size: 12, doctrineSeed: SEEDS[name], seed: 'build' });
		const p = { x: 0, y: 10, z: 200 };
		swarm.reset(p);
		let t = 0;
		for (let i = 0; i < Math.round(20 / dt); i++) {
			t += dt;
			// A slalom wall to wall down the street: the wake sweeps sideways
			// under the swarm, which is what kills the lateral probes.
			p.z = 200 - speed * t;
			p.x = amplitude * Math.sin(2 * Math.PI * speed * t / 40);
			swarm.update(p, t, dt, street.terrain, NO_WIND, null);
			if (t < 4) continue;
			for (let k = 0; k < swarm.size; k++) {
				if (swarm.lag[k] >= 0) continue;
				// The street runs along -z, so "ahead" is a smaller z.
				const ahead = swarm.pos[3 * k + 2] < p.z;
				scouts++; if (ahead) scoutsAhead++;
				if (swarm.margin[k] < 0.05) { folded++; if (ahead) foldedAhead++; }
			}
		}
	}
	check('the 12 m street does kill the scouts\' lateral margins (else the next line proves nothing)',
		folded >= 200, `${folded} scout-frames at lateral margin 0 out of ${scouts}`);
	check('a scout holds its forward margin while its lateral margin is 0',
		foldedAhead / folded >= 0.5, `${(foldedAhead / folded * 100).toFixed(0)} % of them still in front of the node`);
	check('and the scouts are in front of the pilot down a 12 m street',
		scoutsAhead / scouts >= 0.6, `${(scoutsAhead / scouts * 100).toFixed(0)} % of scout-frames ahead`);

	// And the line that pins FWD_LOOKAHEAD_S, because nothing else does. How
	// far the shared forward probe reaches past the deepest scout is paid for
	// in exactly this number: the reach is what the scouts' forward margin is
	// charged against, and a longer one is blocked more often, folds the
	// scouts onto `fileLag` — which is POSITIVE — and puts them behind the
	// pilot. Measured over 8 seeds per doctrine down a 15 m street weave:
	// 75 % of scout-frames ahead at a reach of 0 s, 72 % at 0.03, 66 % at 0.05,
	// 51 % at 0.1, 30 % at 0.2. The floor below sits between 0.05 and 0.1, so
	// the constant cannot drift back up unnoticed.
	let wide = 0, wideAhead = 0;
	{
		const street = makeCity(60, 7.5);
		const dt = 1 / 60, speed = 15, amplitude = 5.5;
		for (const seed of SEED_SWEEP) {
			const swarm = new SwarmModel({ size: 12, doctrineSeed: seed, seed: 'build' });
			const p = { x: 0, y: 10, z: 200 };
			swarm.reset(p);
			let t = 0;
			for (let i = 0; i < Math.round(20 / dt); i++) {
				t += dt;
				p.z = 200 - speed * t;
				p.x = amplitude * Math.sin(2 * Math.PI * speed * t / 40);
				swarm.update(p, t, dt, street.terrain, NO_WIND, null);
				if (t < 4) continue;
				for (let k = 0; k < swarm.size; k++) {
					if (swarm.lag[k] >= 0) continue;
					wide++; if (swarm.pos[3 * k + 2] < p.z) wideAhead++;
				}
			}
		}
	}
	check('the forward probe does not reach so far that it files the scouts behind the pilot',
		wideAhead / wide >= 0.62, `${(wideAhead / wide * 100).toFixed(0)} % of scout-frames ahead down a 15 m street weave`);
}

console.log('\nswarm: the pilot is INSIDE his swarm, not in front of it');
{
	// The second report from a real flight, and the one that changed the
	// design: "they are too far from the master, I do not feel them around me;
	// I pictured being SURROUNDED by my swarm, not followed by it". The spec
	// was written around "the flock follows you", which puts most of it behind
	// an FPV pilot — i.e. permanently off screen.
	//
	// A feeling can be measured, and this block is the measurement. Four
	// numbers, all read through the node's OWN camera (tools/target-camera.mjs,
	// swarmNode: 95-115 deg of vertical field, 10-20 deg of uptilt, 16:9 — the
	// midpoints below):
	//
	//   near    fraction of unit-frames within 25 m of the pilot. "Too far" is
	//           this number, and it is what the cloud's 2.0 s of lag cost.
	//   inView  fraction ALSO inside the frustum and not behind a wall. It is
	//           capped by design at about the scout share (~1/3): a unit
	//           exactly abreast is at 90 deg and no field of view holds it.
	//   flank   fraction within 25 m and between 60 and 120 deg off the
	//           tangent. THIS is "around me": the units that sweep through the
	//           frame every time the pilot banks. A trail scores ~2 %.
	//   spread  1 - |mean azimuth resultant|. 0 is a file in one direction,
	//           1 is evenly distributed around the pilot.
	//
	// The thresholds are floors under measured values, not targets: see the
	// tranche 7 report for the before/after table they were read from.
	const FOV_V_DEG = 105, ASPECT = 16 / 9, UPTILT = 15 * Math.PI / 180, NEAR_M = 25;
	const TAN_V = Math.tan(FOV_V_DEG * Math.PI / 360), TAN_H = TAN_V * ASPECT;

	function presence(name, city, terrain) {
		let tot = 0, inView = 0, ahead = 0, near = 0, flank = 0, dist = 0, frames = 0, resultant = 0;
		const p = { x: 0, y: 10, z: 200 }, prev = { x: 0, y: 10, z: 200 };
		// Three of the six seeds of this doctrine: the slot draw is a family,
		// and one shape proves nothing — but presence is an average over the
		// whole flight, not a worst case, so it does not need all six.
		let taken = 0;
		for (const seed of SEED_SWEEP) {
			if (doctrineFor(seed) !== name || (taken++ % 2)) continue;
			for (const size of [6, 9, 12]) {
				for (const speed of [10, 15, 20]) {
					const swarm = new SwarmModel({ size, doctrineSeed: seed, seed: 'build' });
					TRACKS.corner(0, p, speed);
					swarm.reset(p);
					let t = 0;
					for (let i = 0; i < Math.round(15 * 60); i++) {
						const dt = 1 / 60;
						t += dt;
						prev.x = p.x; prev.y = p.y; prev.z = p.z;
						TRACKS.corner(t, p, speed);
						swarm.update(p, t, dt, terrain, NO_WIND, null);
						if (t < 3) continue;
						// The pilot's own frame: the tangent he is flying along,
						// his right, and the camera axis tilted up off it.
						let tx = p.x - prev.x, ty = p.y - prev.y, tz = p.z - prev.z;
						const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
						const rx = -tz, rz = tx;
						const cfx = tx * Math.cos(UPTILT), cfy = Math.sin(UPTILT), cfz = tz * Math.cos(UPTILT);
						const cux = -tx * Math.sin(UPTILT), cuy = Math.cos(UPTILT), cuz = -tz * Math.sin(UPTILT);
						frames++;
						let sx = 0, sy = 0, n = 0;
						for (let k = 0; k < swarm.size; k++) {
							const o = 3 * k;
							const dx = swarm.pos[o] - p.x, dy = swarm.pos[o + 1] - p.y, dz = swarm.pos[o + 2] - p.z;
							const d = Math.hypot(dx, dy, dz);
							const along = dx * tx + dy * ty + dz * tz;
							tot++; dist += d;
							if (along > 0) ahead++;
							if (d > NEAR_M) continue;
							near++;
							const c = along / (d || 1);
							if (c > -0.5 && c < 0.5) flank++;
							const zc = dx * cfx + dy * cfy + dz * cfz;
							const xc = dx * rx + dz * rz, yc = dx * cux + dy * cuy + dz * cuz;
							if (zc > 0.3 && Math.abs(xc) <= TAN_H * zc && Math.abs(yc) <= TAN_V * zc
								&& !terrain.obstructionBetween(p.x, p.y, p.z, swarm.pos[o], swarm.pos[o + 1], swarm.pos[o + 2]).blocked) inView++;
							if (d > 0.5) { const az = Math.atan2(xc, along); sx += Math.cos(az); sy += Math.sin(az); n++; }
						}
						resultant += n ? Math.hypot(sx, sy) / n : 1;
					}
				}
			}
		}
		return { near: near / tot, inView: inView / tot, ahead: ahead / tot, flank: flank / tot, dist: dist / tot, spread: 1 - resultant / frames };
	}

	// The three doctrines that are meant to SURROUND, and the one that is meant
	// not to. `column` is the file, deliberately kept as the trailing formation
	// so the catalogue the pilot will switch between in flight (#34) has one —
	// it only reads as a choice because the other three envelop.
	const SURROUND = DOCTRINE_NAMES.filter((n) => n !== 'column');
	for (const name of DOCTRINE_NAMES) {
		const o = presence(name, CITY, openTerrain);
		const c = presence(name, CITY, cityTerrain);
		const fmt = (r) => `near ${(r.near * 100).toFixed(0)} %, inView ${(r.inView * 100).toFixed(0)} %, flank ${(r.flank * 100).toFixed(0)} %, spread ${r.spread.toFixed(2)}, mean ${r.dist.toFixed(1)} m`;
		check(`${name}: in clear sky the swarm is WITHIN REACH — ${fmt(o)}`,
			o.near >= 0.95 && o.dist <= 12, `${(o.near * 100).toFixed(1)} % under 25 m, mean ${o.dist.toFixed(1)} m`);
		check(`${name}: and in the city too, where the folds pull it into file — ${fmt(c)}`,
			c.near >= 0.85 && c.dist <= 15, `${(c.near * 100).toFixed(1)} % under 25 m, mean ${c.dist.toFixed(1)} m`);
		// A minority ahead, both ways. Too few and the pilot sees nothing; too
		// many and the swarm is living on extrapolated track, which is the one
		// place a building can bite.
		check(`${name}: a minority of the swarm is ahead of the pilot, and it is not none`,
			o.ahead >= 0.15 && o.ahead <= 0.4, `${(o.ahead * 100).toFixed(0)} % ahead`);
		if (SURROUND.includes(name)) {
			check(`${name}: a quarter of the swarm is out on the flanks, abreast of the pilot`,
				o.flank >= 0.25, `${(o.flank * 100).toFixed(0)} % between 60 and 120 deg off the tangent`);
			check(`${name}: the azimuths are spread around the pilot, not pooled behind him`,
				o.spread >= 0.7, `spread ${o.spread.toFixed(2)}`);
		} else {
			check(`${name}: stays the FILE — that is the point of keeping it`,
				o.flank <= 0.1 && o.spread <= 0.6, `flank ${(o.flank * 100).toFixed(0)} %, spread ${o.spread.toFixed(2)}`);
		}
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

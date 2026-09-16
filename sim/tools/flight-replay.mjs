// Flight replay: fly a FIXED stick sequence through the real FlightController
// and the real Physics, record the trajectory, and compare two recordings.
//
// Why this exists. The benches in this repo assert invariants — the thrust
// split sums back to the force, the trim lands on the body as real weight, the
// prop curve is smooth in chord. Every one of them can be green while the
// machine flies completely differently, and that is exactly what happened: four
// measured gravity defects were found and fixed, and the pilot's verdict was
// "better, but not striking". Nothing in the tooling could have predicted that,
// and nothing could quantify it afterwards.
//
// So this does not assert anything about the flight model. It MEASURES it, in
// quantities a pilot would recognise — how high it ended up, how far it drifted,
// how long the climb took, what stick held the hover, how fast it got — and
// puts two versions side by side.
//
// What makes it trustworthy is in flight-replay-selftest.mjs: the replay is
// bit-deterministic, it is (within a declared tolerance) independent of the
// step it is played at, and the diff reads exactly zero between a trace and
// itself. A diff that moves on its own would be worse than no diff at all — it
// would dress noise up as a regression.
//
// Usage:
//   node tools/flight-replay.mjs --list
//   node tools/flight-replay.mjs hover-hold
//   node tools/flight-replay.mjs --all --out before.json
//   node tools/flight-replay.mjs --diff before.json after.json
//   node tools/flight-replay.mjs punch-out --family toothpick --samples --out t.json
//   node tools/flight-replay.mjs --all --family all --quiet --out reference.json
//   node tools/flight-replay.mjs --all --aero bem --out bem.json
//
// Nothing here writes into src/. It is a reader of the flight stack, never a
// participant in it.

import fs from 'node:fs';
import path from 'node:path';
import { initPhysics, Physics, unrotateVec } from '../src/physics.js';
import { PROFILES, FAMILIES, DEFAULT_FAMILY } from '../src/drone-profiles.js';
import { FlightController, hoverThrottle } from '../src/flightController.js';
import { CONTROL_SUBSTEPS, FIXED_STEP } from '../src/frame-pacing.js';

export const TRACE_FORMAT = 2;

// The step the whole sim runs on. Everything below is expressed in seconds, so
// a replay at another step plays the SAME sequence, just sampled differently —
// that is what makes the step-independence check meaningful.
export const DT = 1 / 250;

// Still air, always. Weather is a separate axis and mixing it in here would
// make every metric a measurement of two things at once; the wind field is
// inert at speed 0 (`WindField.active`), so no probe rays are cast either.
const STILL = { speed: 0, gust: 0, turbulence: 0 };

// Fixed seeds. `Propulsion` is seed-deterministic by contract (the downwash and
// buffet noise is the only nondeterminism in the flight model), and pinning the
// seed here is what turns "two runs differ" from expected into a bug.
const SEED = 0x5eed;
const WIND_SEED = 0x117d;

const EMPTY = { vertices: new Float32Array(0), indices: new Uint32Array(0) };

// A flat 400 m square at y = 0, for the sequences that need a ground: ground
// effect is driven by `Physics._agl`, which comes from a real downward raycast,
// so there has to be something to hit. Two triangles cost nothing and, unlike
// passing a synthetic `agl`, they also give the drone something to hit if a
// sequence flies it into the floor.
const GROUND = {
	vertices: new Float32Array([
		-200, 0, -200,
		200, 0, -200,
		200, 0, 200,
		-200, 0, 200,
	]),
	indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
};

// ---------------------------------------------------------------------------
// Stick sequences
//
// A sequence is a list of keyframes on a common clock, linearly interpolated
// between (`interp: 'step'` holds each keyframe instead). Sticks follow the
// input.js contract: throttle 0..1, roll/pitch/yaw -1..1.
//
// A throttle keyframe may also be the string 'hover', which resolves at every
// step to `hoverThrottle(profile, attitude, volts)` — the stick that cancels
// the current weight at the current tilt on the current pack. That is not a
// convenience: it is the point. It makes "what stick held the hover" a
// measurable output, and it is the single number most sensitive to anything
// that touches the weight the machine has to carry.

export const SEQUENCES = {
	'hover-hold': {
		title: 'Hover held for 20 s',
		exercises: 'gravity trim, hoverThrottle, battery sag, rotor/body drag at rest',
		seconds: 20,
		spawn: { x: 0, y: 100, z: 0 },
		hoverWindow: [2, 20],
		keys: [
			{ t: 0, throttle: 'hover', roll: 0, pitch: 0, yaw: 0 },
			{ t: 20, throttle: 'hover', roll: 0, pitch: 0, yaw: 0 },
		],
	},

	'climb-descend': {
		title: 'Hover, full-throttle climb, throttle chop, catch it',
		exercises: 'axial inflow, vortex ring band, propwash, gravity trim fade with vertical speed',
		seconds: 22,
		spawn: { x: 0, y: 100, z: 0 },
		hoverWindow: [0, 3],
		settleAt: 17,
		keys: [
			{ t: 0, throttle: 'hover' },
			{ t: 3, throttle: 'hover' },
			{ t: 3.05, throttle: 1 },
			{ t: 9, throttle: 1 },
			{ t: 9.05, throttle: 0 },
			{ t: 16, throttle: 0 },
			{ t: 16.05, throttle: 'hover' },
			{ t: 22, throttle: 'hover' },
		],
	},

	'level-turn': {
		title: 'Forward cruise, then a sustained yawing turn in level flight',
		exercises: 'edgewise rotor drag, body drag, yaw authority against prop-drag torque, cruise speed',
		seconds: 18,
		// Altitude hold: "level" has to mean level, or the turn is measuring a
		// climb. Pitch and yaw are still the pilot's, the mode only owns the
		// throttle.
		mode: 'altitude',
		spawn: { x: 0, y: 100, z: 0 },
		hoverWindow: [0, 2],
		settleAt: 15,
		keys: [
			{ t: 0, throttle: 0.5, pitch: 0, yaw: 0 },
			{ t: 2, throttle: 0.5, pitch: 0, yaw: 0 },
			// Nose down and accelerate; the hold pays for the tilt.
			{ t: 2.5, throttle: 0.5, pitch: -0.6, yaw: 0 },
			{ t: 7, throttle: 0.5, pitch: -0.6, yaw: 0 },
			// Then hold the pitch and feed yaw: a flat, powered turn.
			{ t: 7.5, throttle: 0.5, pitch: -0.6, yaw: 0.45 },
			{ t: 14, throttle: 0.5, pitch: -0.6, yaw: 0.45 },
			{ t: 14.5, throttle: 0.5, pitch: 0, yaw: 0 },
			{ t: 18, throttle: 0.5, pitch: 0, yaw: 0 },
		],
	},

	'punch-out': {
		title: 'Motors at idle, let it fall, then full throttle from zero',
		exercises: 'motor torque balance spin-up, pack sag under a step load, inflow on a re-accelerating disc',
		seconds: 14,
		spawn: { x: 0, y: 200, z: 0 },
		settleAt: 12,
		interp: 'step',
		keys: [
			{ t: 0, throttle: 0 },
			{ t: 3, throttle: 1 },
			{ t: 10, throttle: 'hover' },
		],
	},

	'flip': {
		title: 'A single fast roll flip and the recovery after it',
		exercises: 'rate loop, airmode mixer, rotor angular momentum, attitude recovery',
		seconds: 12,
		spawn: { x: 0, y: 150, z: 0 },
		hoverWindow: [0, 2],
		settleAt: 6,
		// A flip is deliberately chaotic: full stick saturates the mixer and any
		// difference in the model is amplified by the rotation. Trajectory
		// metrics from this sequence are NOT comparable between versions — see
		// CHAOTIC below and what the diff does with it.
		chaotic: true,
		interp: 'step',
		keys: [
			{ t: 0, throttle: 'hover', roll: 0 },
			{ t: 2, throttle: 0.55, roll: 1 },
			{ t: 2.45, throttle: 0.55, roll: 0 },
			{ t: 2.6, throttle: 'hover', roll: 0 },
		],
	},

	'ground-pass': {
		title: 'Held at knee height over a floor, crossed, then climbed away out of it',
		exercises: 'ground effect in and out, the AGL raycast path, propwash close to the ground',
		seconds: 16,
		ground: true,
		// Altitude hold, so the pass happens at a KNOWN height above the floor
		// instead of at wherever an open-loop throttle happened to leave it.
		// Ground effect is a function of AGL: a sequence that cannot repeat its
		// AGL cannot measure it.
		mode: 'altitude',
		// Spawned already in ground effect rather than descending into it. A
		// descent that ends near the floor either touches it — and then the
		// metrics are measuring a bounce — or has to be flown so gently that
		// most of the sequence is the descent. Starting low and climbing OUT at
		// the end puts both regimes in the same trace, with no contact at all.
		spawn: { x: 0, y: 0.55, z: 0 },
		hoverWindow: [0, 2],
		settleAt: 14,
		// In altitude mode the throttle stick is a climb demand around 0.5, not
		// a motor command: 0.5 holds, below descends, above climbs.
		keys: [
			{ t: 0, throttle: 0.5, pitch: 0 },
			{ t: 2, throttle: 0.5, pitch: 0 },
			// Cross the floor in ground effect.
			{ t: 2.5, throttle: 0.5, pitch: -0.2 },
			{ t: 9.5, throttle: 0.5, pitch: -0.2 },
			{ t: 10, throttle: 0.5, pitch: 0 },
			// And climb away out of it.
			{ t: 11, throttle: 0.68, pitch: 0 },
			{ t: 12.5, throttle: 0.5, pitch: 0 },
			{ t: 16, throttle: 0.5, pitch: 0 },
		],
	},
};

export const SEQUENCE_NAMES = Object.keys(SEQUENCES);

// ---------------------------------------------------------------------------
// Sequence evaluation

const HOVER = 'hover';
const AXES = ['throttle', 'roll', 'pitch', 'yaw'];

function keyValue(key, axis) {
	const v = key[axis];
	if (v === undefined) return axis === 'throttle' ? 0 : 0;
	return v;
}

function resolve(v, hoverValue) {
	return v === HOVER ? hoverValue : v;
}

// The sticks at time `t`. `hoverValue` is what 'hover' means on this step.
export function sticksAt(seq, t, hoverValue) {
	const keys = seq.keys;
	const step = seq.interp === 'step';
	let i = 0;
	while (i < keys.length - 1 && keys[i + 1].t <= t) i++;
	const a = keys[i];
	const b = keys[Math.min(i + 1, keys.length - 1)];
	const span = b.t - a.t;
	const u = step || span <= 0 ? 0 : Math.min(1, Math.max(0, (t - a.t) / span));
	const out = {};
	for (const axis of AXES) {
		const va = resolve(keyValue(a, axis), hoverValue);
		const vb = resolve(keyValue(b, axis), hoverValue);
		out[axis] = va + (vb - va) * u;
	}
	return out;
}

// ---------------------------------------------------------------------------
// The replay itself

// FNV-1a over the raw bytes of every recorded double. The point is a single
// value that changes if ANY step of the full-rate trajectory changed, so the
// determinism check does not depend on which samples happened to be kept.
class Checksum {
	constructor() {
		this.h = 0xcbf29ce4 >>> 0;
		this.buf = new ArrayBuffer(8);
		this.f64 = new Float64Array(this.buf);
		this.u8 = new Uint8Array(this.buf);
	}

	push(x) {
		// Normalise -0 to 0 so a sign that carries no information cannot make
		// two identical trajectories read as different.
		this.f64[0] = x === 0 ? 0 : x;
		for (let i = 0; i < 8; i++) {
			this.h ^= this.u8[i];
			this.h = Math.imul(this.h, 0x01000193) >>> 0;
		}
		return this;
	}

	get value() { return this.h.toString(16).padStart(8, '0'); }
}

const COLUMNS = [
	't',
	'px', 'py', 'pz',
	'vx', 'vy', 'vz',
	'qx', 'qy', 'qz', 'qw',
	'wx', 'wy', 'wz',
	'thr', 'm0', 'm1', 'm2', 'm3',
	'rpm', 'thrustN', 'volts', 'amps', 'agl',
];

const RAD = 180 / Math.PI;

// Tilt of body +Y away from world +Y, in degrees.
function tiltDeg(q) {
	// Third column of the rotation matrix's middle row: (R * [0,1,0]).y
	const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
	return Math.acos(Math.min(1, Math.max(-1, upY))) * RAD;
}

/**
 * Fly one sequence. Returns a trace object (see TRACE_FORMAT).
 *
 * opts:
 *   family        drone family key (default freestyle5)
 *   dt            integration step, seconds (default 1/250)
 *   sampleHz      how often to keep a row in `samples` (default 0 = keep none)
 *   gravityTrim   override the model's own default, for making a deliberately
 *                 different trace to test the diff with
 *   preset        rate preset override
 *   gyroNoise     override the family's own sensor noise, rad/s RMS. 0 silences
 *                 the gyro and the notches with it — for benches whose question
 *                 is about the integrator rather than about the sensor.
 *   aero          rotor model, 'classic' (default) or 'bem' — the ?aero= flag,
 *                 so that a diff can put the two models side by side on the
 *                 same six sequences. See src/quad.js:parseAeroFlag.
 */
export function replay(name, opts = {}) {
	const seq = SEQUENCES[name];
	if (!seq) throw new Error(`unknown sequence "${name}" (have: ${SEQUENCE_NAMES.join(', ')})`);
	const family = opts.family ?? DEFAULT_FAMILY;
	const profile = PROFILES[family];
	if (!profile) throw new Error(`unknown family "${family}"`);
	const dt = opts.dt ?? DT;
	// The CONTROL RATE is pinned, not the substep ratio. src/main.js divides a
	// fixed 250 Hz step sixteen ways; here `dt` is a knob, and dividing it by a
	// fixed sixteen would mean --dt 1/500 quietly ran the loop at 8 kHz — a
	// different machine, with a different noise density and different notches,
	// which is precisely what the step-independence bench must NOT be handed.
	const CONTROL_RATE = CONTROL_SUBSTEPS / FIXED_STEP;
	const SUB = Math.max(1, Math.round(dt * CONTROL_RATE));
	const sampleHz = opts.sampleHz ?? 0;

	const p = new Physics(
		seq.ground ? GROUND : EMPTY,
		seq.spawn,
		{ profile, weather: STILL, seed: SEED, windSeed: WIND_SEED, aero: opts.aero },
	);
	if (opts.gravityTrim !== undefined) p.propulsion.setGravityTrim(opts.gravityTrim);
	const gravityTrim = p.propulsion.gravityTrimEnabled;

	// Acro unless the sequence says otherwise. A sequence that wants to HOLD an
	// attitude has to fly angle mode: in acro the pitch stick is a rate command,
	// so "nose down 15 degrees" is really "keep pitching forever" and the run
	// measures a tumble instead of a cruise. Both modes are the real controller.
	// `gyroNoise` is an override, not a new knob for its own sake: the
	// step-independence benches need the sensor silenced to ask their question.
	// A hover under a real gyro is a random walk — 20 s of it drifts metres, and
	// the drift is a property of the noise, not of the integrator — so a bench
	// that halves the step and compares trajectories has to silence the sensor
	// or it is measuring the wrong thing. Left alone it is the family's own.
	const c = new FlightController({
		profile, preset: opts.preset, mode: seq.mode,
		...(opts.gyroNoise === undefined ? {} : { gyroNoise: opts.gyroNoise, filters: opts.gyroNoise > 0 }),
	});
	c.armed = true;

	const steps = Math.round(seq.seconds / dt);
	const sampleEvery = sampleHz > 0 ? Math.max(1, Math.round(1 / (sampleHz * dt))) : 0;
	const samples = [];
	const sum = new Checksum();

	const y0 = seq.spawn.y;
	const x0 = seq.spawn.x;
	const z0 = seq.spawn.z;

	// Accumulators, all in SI, all read back by metricsOf().
	const acc = {
		steps: 0,
		pathLength: 0,
		peakSpeed: 0,
		peakAltitude: -Infinity,
		peakClimbRate: 0,
		peakDescentRate: 0,
		maxTiltDeg: 0,
		peakRollRate: 0,
		peakYawRate: 0,
		rollAngle: 0,          // integral of body roll rate, rad
		throttleSum: 0,
		hoverSum: 0, hoverN: 0,
		rpmSum: 0, peakRpm: 0,
		minVolts: Infinity,
		peakAmps: 0,
		minAgl: Infinity,
		usedMah: 0,
		peakImpact: 0,
		timeToClimb5: null,
		timeToLevel: null,
		firstStickMove: null,
	};

	p.beginForceBudget();
	let prev = { x: x0, y: y0, z: z0 };

	for (let i = 0; i < steps; i++) {
		const t = i * dt;
		const q = p.body.rotation();
		const hoverValue = hoverThrottle(profile, q, p.propulsion.battery.voltage);
		const sticks = sticksAt(seq, t, hoverValue);
		// The controller substeps inside the physics step, at the ratio
		// src/main.js uses (src/frame-pacing.js). A replay that ran the loop at
		// the physics rate would be replaying a machine the game does not fly:
		// the gyro noise, the notches and the delay line all live at the control
		// rate. The body state is a zero-order hold across the substeps and the
		// physics takes the LAST motor command, the way an ESC holds its last
		// DSHOT frame.
		const dtc = dt / SUB;
		let motors, throttle;
		for (let c2 = 0; c2 < SUB; c2++) ({ motors, throttle } = c.update(sticks, p, dtc));
		const impact = p.step(motors, dt);

		const pos = p.body.translation();
		const vel = p.body.linvel();
		const w = p.body.angvel();
		const rot = p.body.rotation();
		const om = p.propulsion.omega;
		const rpm = ((om[0] + om[1] + om[2] + om[3]) / 4) * (60 / (2 * Math.PI));
		const thrustN = p.propulsion.thrust[0] + p.propulsion.thrust[1]
			+ p.propulsion.thrust[2] + p.propulsion.thrust[3];
		const volts = p.propulsion.battery.voltage;
		const amps = p.propulsion.battery.current;
		const agl = p._agl;

		// Checksum: the full kinematic state plus what the motors were told, at
		// every single step. Anything that changes the flight changes this.
		sum.push(pos.x).push(pos.y).push(pos.z)
			.push(vel.x).push(vel.y).push(vel.z)
			.push(rot.x).push(rot.y).push(rot.z).push(rot.w)
			.push(w.x).push(w.y).push(w.z)
			.push(motors[0]).push(motors[1]).push(motors[2]).push(motors[3]);

		// --- accumulators
		acc.steps++;
		acc.pathLength += Math.hypot(pos.x - prev.x, pos.y - prev.y, pos.z - prev.z);
		prev = { x: pos.x, y: pos.y, z: pos.z };
		const speed = Math.hypot(vel.x, vel.y, vel.z);
		if (speed > acc.peakSpeed) acc.peakSpeed = speed;
		const alt = pos.y - y0;
		if (alt > acc.peakAltitude) acc.peakAltitude = alt;
		if (vel.y > acc.peakClimbRate) acc.peakClimbRate = vel.y;
		if (-vel.y > acc.peakDescentRate) acc.peakDescentRate = -vel.y;
		const tilt = tiltDeg(rot);
		if (tilt > acc.maxTiltDeg) acc.maxTiltDeg = tilt;
		// Body-frame rates, recomputed here rather than read off Physics's own
		// scratch object: this file is a reader of the flight stack, and a private
		// field is not an interface.
		const wBody = unrotateVec(rot, w.x, w.y, w.z);
		if (Math.abs(wBody.z) > acc.peakRollRate) acc.peakRollRate = Math.abs(wBody.z);
		if (Math.abs(wBody.y) > acc.peakYawRate) acc.peakYawRate = Math.abs(wBody.y);
		acc.rollAngle += wBody.z * dt;
		acc.throttleSum += throttle;
		if (seq.hoverWindow && t >= seq.hoverWindow[0] && t < seq.hoverWindow[1]) {
			acc.hoverSum += throttle; acc.hoverN++;
		}
		acc.rpmSum += rpm;
		if (rpm > acc.peakRpm) acc.peakRpm = rpm;
		if (volts < acc.minVolts) acc.minVolts = volts;
		if (amps > acc.peakAmps) acc.peakAmps = amps;
		if (agl !== null && agl < acc.minAgl) acc.minAgl = agl;
		if (impact > acc.peakImpact) acc.peakImpact = impact;
		acc.usedMah = p.propulsion.battery.usedMah;
		if (acc.timeToClimb5 === null && alt >= 5) acc.timeToClimb5 = +(t + dt).toFixed(3);
		if (seq.settleAt !== undefined && acc.timeToLevel === null
			&& t >= seq.settleAt && tilt < 15) {
			acc.timeToLevel = +(t + dt - seq.settleAt).toFixed(3);
		}

		if (sampleEvery && i % sampleEvery === 0) {
			samples.push([
				+t.toFixed(4),
				pos.x, pos.y, pos.z,
				vel.x, vel.y, vel.z,
				rot.x, rot.y, rot.z, rot.w,
				w.x, w.y, w.z,
				throttle, motors[0], motors[1], motors[2], motors[3],
				rpm, thrustN, volts, amps, agl,
			].map((v) => (typeof v === 'number' ? +v.toFixed(6) : v)));
		}
	}

	const budget = p.forceBudget();
	const end = p.body.translation();
	const endRot = p.body.rotation();
	const endVel = p.body.linvel();

	const trace = {
		format: TRACE_FORMAT,
		sequence: name,
		title: seq.title,
		exercises: seq.exercises,
		chaotic: !!seq.chaotic,
		family,
		preset: c.preset,
		mode: c.mode,
		dt,
		seconds: seq.seconds,
		steps,
		seed: SEED,
		gyroNoise: opts.gyroNoise ?? profile.gyroNoise ?? 0,
		gravityTrim,
		spawn: { ...seq.spawn },
		ground: !!seq.ground,
		checksum: sum.value,
		metrics: null,
		budget,
		columns: sampleEvery ? COLUMNS : null,
		samples: sampleEvery ? samples : null,
	};

	trace.metrics = finishMetrics(acc, seq, { end, endRot, endVel, x0, y0, z0 }, budget);
	return trace;
}

// ---------------------------------------------------------------------------
// Metrics
//
// Named quantities a pilot would recognise, NOT an L2 distance over the whole
// state vector. An L2 number tells you something moved; it never tells you the
// machine now takes 0.4 s longer to reach 5 m, or that the stick holding the
// hover went up by two points.
//
// `kind` drives the diff's display and its relative-change arithmetic:
//   'm', 's', 'm/s', 'deg', 'deg/s', 'stick' (0..1), 'V', 'A', 'rpm', 'N',
//   'mAh', 'rev', 'weight' (a fraction of airframe weight).

export const METRIC_UNITS = {
	finalAltitude: 'm', peakAltitude: 'm', lateralDrift: 'm', pathLength: 'm',
	peakSpeed: 'm/s', peakClimbRate: 'm/s', peakDescentRate: 'm/s', finalSpeed: 'm/s',
	timeToClimb5m: 's', timeToLevel: 's',
	maxTiltDeg: 'deg', finalTiltDeg: 'deg',
	peakRollRate: 'deg/s', peakYawRate: 'deg/s', rollRevolutions: 'rev',
	hoverStick: 'stick', meanThrottle: 'stick',
	minVoltage: 'V', peakCurrent: 'A', usedMah: 'mAh',
	peakRpm: 'rpm', meanRpm: 'rpm',
	minAgl: 'm', peakImpact: 'N',
	thrustUp: 'weight', inflowUp: 'weight', groundEffectUp: 'weight',
	vortexRingUp: 'weight', bodyDragUp: 'weight', rotorDragUp: 'weight',
	gravityTrimUp: 'weight',
};

// Metrics whose value is a position or a heading far downstream of a chaotic
// event, and which therefore must not be read as a regression on a chaotic
// sequence. See the note in diff().
const TRAJECTORY_METRICS = new Set([
	'finalAltitude', 'lateralDrift', 'pathLength', 'finalSpeed', 'finalTiltDeg',
	'timeToLevel', 'peakAltitude',
]);

function finishMetrics(acc, seq, k, budget) {
	const round = (v, n = 4) => (v === null || !Number.isFinite(v) ? v : +v.toFixed(n));
	return {
		finalAltitude: round(k.end.y - k.y0),
		peakAltitude: round(acc.peakAltitude),
		lateralDrift: round(Math.hypot(k.end.x - k.x0, k.end.z - k.z0)),
		pathLength: round(acc.pathLength),
		peakSpeed: round(acc.peakSpeed),
		finalSpeed: round(Math.hypot(k.endVel.x, k.endVel.y, k.endVel.z)),
		peakClimbRate: round(acc.peakClimbRate),
		peakDescentRate: round(acc.peakDescentRate),
		timeToClimb5m: acc.timeToClimb5,
		timeToLevel: acc.timeToLevel,
		maxTiltDeg: round(acc.maxTiltDeg, 2),
		finalTiltDeg: round(tiltDeg(k.endRot), 2),
		peakRollRate: round(acc.peakRollRate * RAD, 1),
		peakYawRate: round(acc.peakYawRate * RAD, 1),
		rollRevolutions: round(acc.rollAngle / (2 * Math.PI), 4),
		hoverStick: acc.hoverN ? round(acc.hoverSum / acc.hoverN, 5) : null,
		meanThrottle: round(acc.throttleSum / acc.steps, 5),
		minVoltage: round(acc.minVolts, 4),
		peakCurrent: round(acc.peakAmps, 3),
		usedMah: round(acc.usedMah, 3),
		peakRpm: round(acc.peakRpm, 1),
		meanRpm: round(acc.rpmSum / acc.steps, 1),
		minAgl: Number.isFinite(acc.minAgl) ? round(acc.minAgl) : null,
		peakImpact: round(acc.peakImpact, 1),
		// From the force budget — where the weight actually went, averaged over
		// the whole sequence. These are the ones that say WHICH mechanism moved.
		thrustUp: budget?.thrustUp ?? null,
		inflowUp: budget?.ofWhich.inflow ?? null,
		groundEffectUp: budget?.ofWhich.groundEffect ?? null,
		vortexRingUp: budget?.ofWhich.vortexRing ?? null,
		bodyDragUp: budget?.bodyDragUp ?? null,
		rotorDragUp: budget?.rotorDragUp ?? null,
		gravityTrimUp: budget?.gravityTrimUp ?? null,
	};
}

// ---------------------------------------------------------------------------
// Diff

// How much of a change is worth showing at all. Below this the two runs are
// reported as unchanged: floating-point reassociation from an unrelated edit
// can move the last digits, and a diff that shouts about 1e-12 trains people to
// stop reading it. Absolute floor per unit, plus a relative floor.
const NOISE = {
	m: 1e-4, 's': 1e-3, 'm/s': 1e-4, deg: 1e-3, 'deg/s': 1e-2,
	stick: 1e-6, V: 1e-4, A: 1e-3, mAh: 1e-3, rpm: 1e-2, N: 1e-2,
	rev: 1e-4, weight: 1e-4,
};
const REL_NOISE = 1e-6;

/**
 * Compare two traces. Returns { sequence, comparable, rows, changed, warnings }.
 * Each row: { metric, unit, a, b, abs, rel, significant }.
 */
export function diff(a, b) {
	const warnings = [];
	if (a.sequence !== b.sequence) warnings.push(`different sequences: ${a.sequence} vs ${b.sequence}`);
	if (a.family !== b.family) warnings.push(`different families: ${a.family} vs ${b.family}`);
	if (a.dt !== b.dt) warnings.push(`different steps: ${a.dt} vs ${b.dt}`);
	if (a.seed !== b.seed) warnings.push(`different seeds: ${a.seed} vs ${b.seed}`);
	if (a.gyroNoise !== b.gyroNoise) warnings.push(`different gyro noise: ${a.gyroNoise} vs ${b.gyroNoise}`);

	const identical = a.checksum === b.checksum;
	const rows = [];
	const keys = Object.keys(a.metrics);
	for (const key of keys) {
		const va = a.metrics[key];
		const vb = b.metrics[key];
		if (va === null && vb === null) continue;
		const unit = METRIC_UNITS[key] ?? '';
		if (va === null || vb === null) {
			rows.push({ metric: key, unit, a: va, b: vb, abs: null, rel: null, significant: true });
			continue;
		}
		const abs = vb - va;
		// Relative to the BEFORE value, the way a pilot would read it ("the climb
		// got 8% slower"). Null when the before value is zero: a change from
		// nothing to something has no percentage, and printing 100% there would
		// be read as "it doubled".
		const rel = abs === 0 ? 0 : (va !== 0 ? abs / Math.abs(va) : null);
		const floor = NOISE[unit] ?? 1e-6;
		const significant = Math.abs(abs) > floor && (rel === null || Math.abs(rel) > REL_NOISE);
		rows.push({
			metric: key, unit, a: va, b: vb,
			abs: +abs.toFixed(6),
			rel: rel === null ? null : +(rel * 100).toFixed(3),
			significant,
			// On a chaotic sequence a trajectory metric says "the flip diverged",
			// which it always will. Kept and shown, but never counted as a result.
			advisory: !!a.chaotic && TRAJECTORY_METRICS.has(key),
		});
	}

	const changed = rows.filter((r) => r.significant && !r.advisory);
	if (a.chaotic) {
		warnings.push(
			'chaotic sequence: a flip amplifies any difference, so the trajectory '
			+ 'metrics below are ADVISORY. What stays comparable is the peak rates, '
			+ 'the max tilt, the revolutions completed, the current and rpm peaks '
			+ 'and the force budget — all of them properties of the manoeuvre, not '
			+ 'of where it left the machine.',
		);
	}

	return {
		sequence: a.sequence,
		title: a.title,
		identical,
		checksums: [a.checksum, b.checksum],
		rows,
		changed,
		warnings,
	};
}

// Diff whole runs (a run is { traces: [...] } or a single trace).
export function diffRuns(a, b) {
	const ta = tracesOf(a);
	const tb = tracesOf(b);
	const byName = new Map(tb.map((t) => [`${t.sequence}/${t.family}`, t]));
	const out = [];
	for (const t of ta) {
		const other = byName.get(`${t.sequence}/${t.family}`);
		if (!other) continue;
		out.push(diff(t, other));
	}
	return out;
}

function tracesOf(x) {
	if (Array.isArray(x?.traces)) return x.traces;
	if (Array.isArray(x)) return x;
	return [x];
}

// ---------------------------------------------------------------------------
// Rendering

function fmt(v, unit) {
	if (v === null || v === undefined) return '-';
	if (typeof v !== 'number') return String(v);
	const digits = unit === 'rpm' || unit === 'N' ? 0
		: unit === 'stick' || unit === 'weight' ? 4
			: unit === 'deg/s' ? 1 : 3;
	return v.toFixed(digits);
}

export function renderDiff(d) {
	const L = [];
	L.push(`── ${d.sequence} — ${d.title ?? ''}`);
	L.push(`   checksum ${d.checksums[0]} ${d.identical ? '==' : '!='} ${d.checksums[1]}`);
	for (const w of d.warnings) L.push(`   ! ${w}`);
	if (d.identical && d.changed.length === 0) {
		L.push('   identical: every metric zero.');
		return L.join('\n');
	}
	const w0 = Math.max(...d.rows.map((r) => r.metric.length), 6);
	L.push(`   ${'metric'.padEnd(w0)}  ${'a'.padStart(11)}  ${'b'.padStart(11)}  ${'Δ'.padStart(11)}  ${'Δ%'.padStart(8)}  unit`);
	for (const r of d.rows) {
		if (!r.significant) continue;
		const mark = r.advisory ? '~' : ' ';
		L.push(`  ${mark}${r.metric.padEnd(w0)}  ${fmt(r.a, r.unit).padStart(11)}  ${fmt(r.b, r.unit).padStart(11)}  `
			+ `${(r.abs === null ? '-' : (r.abs > 0 ? '+' : '') + fmt(r.abs, r.unit)).padStart(11)}  `
			+ `${(r.rel === null ? '-' : (r.rel > 0 ? '+' : '') + r.rel.toFixed(2)).padStart(8)}  ${r.unit}`);
	}
	if (d.changed.length === 0) L.push('   no significant change (advisory rows only).');
	return L.join('\n');
}

export function renderTrace(t) {
	const L = [];
	L.push(`── ${t.sequence} [${t.family}] — ${t.title}`);
	L.push(`   exercises: ${t.exercises}`);
	L.push(`   ${t.seconds}s at dt=${t.dt.toFixed(6)} (${t.steps} steps), seed 0x${t.seed.toString(16)}, `
		+ `gravityTrim=${t.gravityTrim}, checksum ${t.checksum}`);
	const m = t.metrics;
	const w0 = Math.max(...Object.keys(m).map((k) => k.length));
	for (const [k, v] of Object.entries(m)) {
		if (v === null) continue;
		L.push(`   ${k.padEnd(w0)}  ${fmt(v, METRIC_UNITS[k] ?? '').padStart(11)}  ${METRIC_UNITS[k] ?? ''}`);
	}
	return L.join('\n');
}

// ---------------------------------------------------------------------------
// CLI

function parseDt(s) {
	if (s.includes('/')) {
		const [a, b] = s.split('/').map(Number);
		return a / b;
	}
	return Number(s);
}

function readTrace(file) {
	const j = JSON.parse(fs.readFileSync(file, 'utf8'));
	if (j.format !== TRACE_FORMAT && !Array.isArray(j.traces)) {
		throw new Error(`${file}: trace format ${j.format}, expected ${TRACE_FORMAT}`);
	}
	return j;
}

function writeOut(file, run) {
	fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
	if (file.endsWith('.ndjson')) {
		fs.writeFileSync(file, run.traces.map((t) => JSON.stringify(t)).join('\n') + '\n');
	} else {
		fs.writeFileSync(file, JSON.stringify(run, null, '\t') + '\n');
	}
}

async function main(argv) {
	const args = argv.slice(2);
	const flag = (name) => args.includes(name);
	const value = (name, def) => {
		const i = args.indexOf(name);
		return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
	};

	if (flag('--list') || args.length === 0) {
		console.log('sequences:');
		for (const [name, s] of Object.entries(SEQUENCES)) {
			console.log(`  ${name.padEnd(14)} ${s.seconds}s  ${s.title}${s.chaotic ? '  [chaotic]' : ''}`);
			console.log(`  ${''.padEnd(14)} exercises: ${s.exercises}`);
		}
		console.log(`\nfamilies: ${FAMILIES.join(', ')} (default ${DEFAULT_FAMILY})`);
		return 0;
	}

	if (flag('--diff')) {
		const i = args.indexOf('--diff');
		const fa = args[i + 1];
		const fb = args[i + 2];
		if (!fa || !fb) { console.error('--diff needs two files'); return 2; }
		const ds = diffRuns(readTrace(fa), readTrace(fb));
		if (ds.length === 0) { console.error('no sequence in common between the two files'); return 2; }
		let changed = 0;
		for (const d of ds) { console.log(renderDiff(d)); console.log(''); changed += d.changed.length; }
		console.log(changed === 0
			? 'No significant change on any sequence.'
			: `${changed} metric${changed > 1 ? 's' : ''} moved across ${ds.length} sequence${ds.length > 1 ? 's' : ''}.`);
		return 0;
	}

	await initPhysics();

	const familyArg = value('--family', DEFAULT_FAMILY);
	const families = familyArg === 'all' ? FAMILIES : [familyArg];
	const dt = parseDt(value('--dt', String(DT)));
	const sampleHz = flag('--samples') ? Number(value('--samples-hz', '25')) : 0;
	const opts = { dt, sampleHz };
	if (args.includes('--aero')) opts.aero = value('--aero', undefined);
	if (flag('--no-gravity-trim')) opts.gravityTrim = false;
	if (flag('--gravity-trim')) opts.gravityTrim = true;

	const names = flag('--all')
		? SEQUENCE_NAMES
		: args.filter((a) => SEQUENCES[a]);
	if (names.length === 0) { console.error('no sequence named; try --list'); return 2; }

	const quiet = flag('--quiet');
	const traces = [];
	for (const family of families) {
		for (const name of names) {
			const t = replay(name, { ...opts, family });
			traces.push(t);
			if (!quiet) { console.log(renderTrace(t)); console.log(''); }
		}
	}

	const out = value('--out', null);
	if (out) {
		// Deliberately no timestamp and no machine name in the file: a recording
		// that is meant to be committed and compared months later has to be
		// BYTE-stable, so that `git diff` on it shows a change in the flight and
		// nothing else.
		writeOut(out, { format: TRACE_FORMAT, traces });
		console.log(`wrote ${out} (${traces.length} trace${traces.length > 1 ? 's' : ''})`);
	}
	return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	process.exit(await main(process.argv));
}

// The loop-realism lot, asserted where it meets the flight controller.
//
// The lot added a gyro that lies, a loop that is late, notches that answer the
// lies, anti-gravity and D-max, and it shipped all of them INERT because the
// PID blocks in src/drone-profiles.js had been swept against a loop with none
// of them. They are now ON: every family carries a measured `gyroNoise` and
// `loopDelay`, the controller runs at 4000 Hz (src/frame-pacing.js), and
// tools/tune-pid.mjs sweeps at that rate with the rotor speeds in hand, so the
// tune and the plant are the same machine again.
//
// So the first half of this file no longer says "none of this does anything".
// It says the opposite, family by family: the settings are live, they are in
// the range they were derived for, and forcing them off changes the answer.
// The second half is the machinery itself.
//
// D-max is the one that is still at its no-op value, and that is a measured
// refusal rather than an unfinished job — see D_MAX_RATIO's comment in
// src/flightController.js. It is asserted here at 1.0 so that raising it has to
// go through this file.
//
// tools/loop-rate-bench.mjs is where the case for each setting is measured;
// this file only says that the settings do what they say.
import assert from 'node:assert/strict';
import { FlightController, ANTI_GRAVITY_GAIN, D_MAX_RATIO } from '../src/flightController.js';
import { PROFILES, FAMILIES } from '../src/drone-profiles.js';
import { Propulsion } from '../src/quad.js';
import { FIXED_STEP, CONTROL_SUBSTEPS, CONTROL_RATES, parseControlRate } from '../src/frame-pacing.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

const ZERO = { x: 0, y: 0, z: 0 };
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const DT = FIXED_STEP;

// A short scripted flight against the real airframe, returning every motor
// command as it was issued. Everything the lot touches is on this path: the
// sensor, the delay, the notches, anti-gravity, D-max.
function flight(profile, opts = {}, steps = 400) {
	const fc = new FlightController({ profile, ...opts });
	const prop = new Propulsion({ profile });
	const I = profile.inertia;
	let w = { x: 0, y: 0, z: 0 };
	const out = [];
	for (let i = 0; i < steps; i++) {
		const t0 = i * DT;
		const sticks = {
			throttle: t0 < 0.5 ? 0.35 : 0.8,
			roll: t0 > 0.2 && t0 < 0.6 ? 1 : 0,
			pitch: t0 > 0.8 ? -0.5 : 0,
			yaw: 0,
		};
		const state = {
			rotation: IDENTITY, angularVelocity: w, position: ZERO, velocity: ZERO,
			rotorOmega: prop.omega,
		};
		const { motors } = fc.update(sticks, state, DT);
		out.push([...motors]);
		const { torque } = prop.step(motors, { v: ZERO, omega: w, agl: null, shake: 0 }, DT);
		const Iw = { x: I.x * w.x, y: I.y * w.y, z: I.z * w.z };
		w = {
			x: w.x + ((torque.x - (w.y * Iw.z - w.z * Iw.y)) / I.x) * DT,
			y: w.y + ((torque.y - (w.z * Iw.x - w.x * Iw.z)) / I.y) * DT,
			z: w.z + ((torque.z - (w.x * Iw.y - w.y * Iw.x)) / I.z) * DT,
		};
	}
	return out;
}

// ---------------------------------------------------------------------------
// 1. The defaults are LIVE

t('every family carries a measured gyro noise and a measured loop latency', () => {
	for (const f of FAMILIES) {
		const p = PROFILES[f];
		// The band the derivation in src/drone-profiles.js can produce. The floor
		// is not 0: a family at 0 would be a perfect gyro and would silently turn
		// its own notches off (FlightController reads `filters ?? noise > 0`).
		assert.ok(p.gyroNoise >= 0.05 && p.gyroNoise <= 0.5, `${f}.gyroNoise = ${p.gyroNoise}`);
		// 0.8 ms on every family, uniform on purpose: what it stands for is the
		// same silicon on every build. A tenth of a millisecond either way would
		// be a different claim about the hardware, so the bound is tight.
		assert.ok(p.loopDelay >= 0.0005 && p.loopDelay <= 0.002, `${f}.loopDelay = ${p.loopDelay}`);
	}
});

t('the two settings with no profile field are where the bench left them', () => {
	// Anti-gravity is anchored on the thrust ratio across a punch: 1 + 0.70 * g
	// must land on the 5.9-7.8 the six families measure.
	assert.ok(ANTI_GRAVITY_GAIN > 0, 'anti-gravity is off');
	const peakBoost = 1 + 0.70 * ANTI_GRAVITY_GAIN;
	assert.ok(peakBoost >= 5.9 && peakBoost <= 7.8, `peak boost ${peakBoost} is off the thrust ratio`);
	// D-max stays at its no-op value, measured. See its comment.
	assert.equal(D_MAX_RATIO, 1.0);
});

t('the control loop runs at 4000 Hz, sixteen substeps of the physics grid', () => {
	assert.equal(CONTROL_SUBSTEPS, 16);
	assert.equal(Math.round(CONTROL_SUBSTEPS / FIXED_STEP), 4000);
	for (const raw of [null, undefined, '']) assert.equal(parseControlRate(raw), CONTROL_SUBSTEPS);
});

t('every family builds the conditioning chain, and none builds the D-max filter', () => {
	for (const f of FAMILIES) {
		const fc = new FlightController({ profile: PROFILES[f] });
		for (const axis of ['roll', 'pitch', 'yaw']) {
			assert.ok(fc.pid[axis].notches, `${f}.${axis} has no notches`);
			assert.equal(fc.pid[axis].dMaxLpf, null, `${f}.${axis} D-max`);
		}
	}
});

t('turning the whole path off changes the motor commands, on every family', () => {
	// The inverse of the assertion this file used to make. If the path were
	// still inert, forcing it to zero would change nothing.
	for (const f of FAMILIES) {
		const a = flight(PROFILES[f]);
		const b = flight(PROFILES[f], { gyroNoise: 0, loopDelay: 0, antiGravity: 0, dMax: 1, filters: false });
		assert.notDeepEqual(a, b, f);
	}
});

t('the gyro no longer hands the loop the true body rates', () => {
	const fc = new FlightController({ profile: PROFILES.freestyle5 });
	const w = { x: 0.7, y: -0.2, z: 1.3 };
	const read = fc.gyro.sample(w, [2000, 2000, 2000, 2000], DT);
	assert.notEqual(read.x, w.x, 'the sensor is still a pass-through');
	// A pass-through returns the caller's own object; a sensor returns its own.
	assert.notEqual(read, w);
	// And the delay line is a delay line: the first read is what came before.
	assert.notEqual(fc.loopDelay.step(w, 1 / 4000), w);
});

t('the noise is deterministic per family, run for run', () => {
	// Every bench in tools/ leans on this, and tools/flight-replay.mjs proves it
	// in a fresh child process. Here it is asserted on the shipped settings.
	for (const f of FAMILIES) assert.deepEqual(flight(PROFILES[f]), flight(PROFILES[f]), f);
});

// ---------------------------------------------------------------------------
// 2. The machinery, at settings nothing ships with

t('noise on: still deterministic, and different from noise off', () => {
	const on = { gyroNoise: 0.08, seed: 0x1234 };
	const a = flight(PROFILES.freestyle5, on);
	const b = flight(PROFILES.freestyle5, on);
	assert.deepEqual(a, b, 'two runs at the same seed must agree to the bit');
	assert.notDeepEqual(a, flight(PROFILES.freestyle5, {}), 'noise changed nothing');
	assert.notDeepEqual(a, flight(PROFILES.freestyle5, { ...on, seed: 0x4321 }), 'the seed changed nothing');
});

t('noise on builds the conditioning chain, and `filters` can still refuse it', () => {
	const on = new FlightController({ profile: PROFILES.freestyle5, gyroNoise: 0.08 });
	assert.ok(on.pid.roll.notches, 'noise should bring the notches with it');
	const off = new FlightController({ profile: PROFILES.freestyle5, gyroNoise: 0.08, filters: false });
	assert.equal(off.pid.roll.notches, null);
});

t('at 250 Hz not one rotor notch can be built — the lot\'s central finding', () => {
	// The tones are 155-816 Hz across the families (tools/loop-rate-bench.mjs
	// --tones); 0.45 * Nyquist at 250 Hz is 56 Hz. This is the assertion that
	// makes the substep machinery necessary rather than decorative, so it is
	// worth failing loudly the day somebody changes the ceiling.
	const fc = new FlightController({ profile: PROFILES.freestyle5, gyroNoise: 0.08 });
	const prop = new Propulsion({ profile: PROFILES.freestyle5 });
	prop.primeFor(0.4);
	for (let i = 0; i < 200; i++) {
		fc.update({ throttle: 0.4, roll: 0, pitch: 0, yaw: 0 },
			{ rotation: IDENTITY, angularVelocity: ZERO, position: ZERO, velocity: ZERO, rotorOmega: prop.omega },
			1 / 250);
	}
	const rpm = fc.pid.roll.notches.rpm.notches;
	assert.ok(rpm.every((e) => e.n.bypass), 'a rotor notch was built at 250 Hz');

	// And at the rate that ships, every one of the eight is there: four
	// fundamentals and four second harmonics, all under the 900 Hz ceiling at
	// this throttle. That is the whole reason CONTROL_SUBSTEPS is 16.
	const rate = Math.round(CONTROL_SUBSTEPS / FIXED_STEP);
	const fast = new FlightController({ profile: PROFILES.freestyle5, gyroNoise: 0.08 });
	for (let i = 0; i < 200; i++) {
		fast.update({ throttle: 0.4, roll: 0, pitch: 0, yaw: 0 },
			{ rotation: IDENTITY, angularVelocity: ZERO, position: ZERO, velocity: ZERO, rotorOmega: prop.omega },
			1 / rate);
	}
	const built = fast.pid.roll.notches.rpm.notches.filter((e) => !e.n.bypass);
	assert.equal(built.length, 8, `only ${built.length} of 8 rotor notches at ${rate} Hz`);
});

t('loop latency is what delays the loop, and nothing else does', () => {
	// The delay is isolated with the noise explicitly off. With the shipped
	// noise on, the delay line's first outputs are zeros against a sensor that
	// is already lying, and the two paths differ from the first sample for a
	// reason that is the sensor's rather than the delay's.
	const quiet = { gyroNoise: 0, filters: false };
	const none = flight(PROFILES.freestyle5, quiet);
	const late = flight(PROFILES.freestyle5, { ...quiet, loopDelay: 4 * DT });
	assert.notDeepEqual(none, late);
	// Four steps of delay, so the first four commands are issued against a gyro
	// that has not reported anything yet: the loop sees zero rate, which at
	// t = 0 is also the true rate, so those first commands must still agree.
	assert.deepEqual(none.slice(0, 4), late.slice(0, 4));
});

t('anti-gravity is exactly 1 at a steady throttle and more than 1 in a punch', () => {
	const profile = PROFILES.freestyle5;
	const state = { rotation: IDENTITY, angularVelocity: ZERO, position: ZERO, velocity: ZERO };
	// A small stick, deliberately: held against a body that never rotates, a
	// full-stick error winds I straight into its clamp and a saturated I term
	// cannot show a boost at all.
	const hold = (fc, throttle, steps) => {
		for (let i = 0; i < steps; i++) fc.update({ throttle, roll: 0.02, pitch: 0, yaw: 0 }, state, DT);
		return fc.pid.roll.i;
	};
	const boosted = new FlightController({ profile, antiGravity: 3.5 });
	const plain = new FlightController({ profile, antiGravity: 0 });

	// Steady throttle: the high-pass reads zero, the boost is exactly 1, and the
	// two I terms are the same double.
	assert.equal(hold(boosted, 0.4, 300), hold(plain, 0.4, 300));
	assert.ok(Math.abs(boosted.pid.roll.i) < 0.35, 'the I term must not be at its clamp for this test to mean anything');

	// Punch: the boost fires and winds I further than the same loop without it.
	const beforeI = boosted.pid.roll.i;
	hold(boosted, 0.95, 40);
	hold(plain, 0.95, 40);
	assert.ok(Math.abs(boosted.pid.roll.i) > Math.abs(beforeI), 'the punch should keep winding I');
	assert.ok(
		Math.abs(boosted.pid.roll.i) > Math.abs(plain.pid.roll.i),
		`anti-gravity should wind it further: ${boosted.pid.roll.i} vs ${plain.pid.roll.i}`,
	);
});

t('D-max raises D only while the stick is moving', () => {
	const profile = PROFILES.freestyle5;
	const a = flight(profile, { dMax: 1.0 });
	const b = flight(profile, { dMax: 1.8 });
	// (both at the shipped noise: D-max multiplies D, and D is what the noise
	// arrives through, so the difference is larger with the sensor live, not
	// smaller.)
	assert.notDeepEqual(a, b, 'D-max changed nothing at all');
	// Held still for long enough, the boost decays and the two agree again.
	const hold = (dMax) => {
		const fc = new FlightController({ profile, dMax });
		const state = { rotation: IDENTITY, angularVelocity: ZERO, position: ZERO, velocity: ZERO };
		let last;
		for (let i = 0; i < 2000; i++) last = fc.update({ throttle: 0.4, roll: 0, pitch: 0, yaw: 0 }, state, DT).motors;
		return [...last];
	};
	assert.deepEqual(hold(1.0), hold(1.8), 'a motionless stick must not see D-max at all');
});

// ---------------------------------------------------------------------------
// 3. The substep arithmetic

t('?loop= accepts only the rates the accumulator can honour exactly', () => {
	for (const hz of CONTROL_RATES) {
		const sub = parseControlRate(String(hz));
		assert.equal(sub, hz * FIXED_STEP);
		assert.ok(Number.isInteger(sub) && sub >= 1);
	}
	for (const bad of ['0', '60', '333', '1001', 'fast', '-1000', '8000']) {
		assert.throws(() => parseControlRate(bad), /loop=/, `?loop=${bad} should be refused`);
	}
});

t('a substepped loop divides the step exactly, and 1 substep divides nothing', () => {
	const h = FIXED_STEP;
	// The expression main.js runs. At 1 substep it must be h itself, not h/1 —
	// which is the same double, but the point is that the branch exists.
	const hc = (subs) => (subs === 1 ? h : h / subs);
	assert.equal(hc(1), h);
	for (const subs of [2, 4, 8, 16]) {
		assert.ok(Math.abs(hc(subs) * subs - h) < 1e-18, `${subs} substeps`);
	}
});

// ---------------------------------------------------------------------------
// 4. filterScale, and the two chains it is allowed to touch (#167)
//
// `filterScale` scales the SENSOR cutoffs — gyro and D-term — and roll and
// pitch also take it on the SETPOINT cutoffs, the feedforward and the RC
// smoothing. Yaw takes neither: its sensor chain stays at the reference
// airframe's, and its setpoint chain goes the OTHER WAY, 1 / filterScale,
// because yaw torque is made by spinning rotors up and down and a rotor time
// constant does not shrink with the airframe. The reasoning, and the sweep that
// measured it, are in src/flightController.js.
//
// The toothpick is the only family with a filterScale, so it is the only family
// any of this moves — which is the other half of what these assertions pin.
const CUTOFFS = (fc, axis) => ({
	gyro: fc.pid[axis].gyroLpf.hz,
	d: fc.pid[axis].dLpf.hz,
	ff: fc.pid[axis].ffLpf.hz,
	rc: fc.pid[axis].rcLpf[0].hz,
});

t('yaw keeps the reference sensor chain on every family', () => {
	const ref = CUTOFFS(new FlightController({ profile: PROFILES[FAMILIES[0]] }), 'yaw');
	for (const family of Object.keys(PROFILES)) {
		const c = CUTOFFS(new FlightController({ profile: PROFILES[family] }), 'yaw');
		assert.equal(c.gyro, ref.gyro, `${family}: yaw gyro cutoff`);
		assert.equal(c.d, ref.d, `${family}: yaw D-term cutoff`);
	}
});

t('yaw shapes its setpoint by 1 / filterScale, the other way up', () => {
	const ref = CUTOFFS(new FlightController({ profile: PROFILES.freestyle5 }), 'yaw');
	for (const family of Object.keys(PROFILES)) {
		const profile = PROFILES[family];
		const fs = profile.filterScale ?? 1;
		const c = CUTOFFS(new FlightController({ profile }), 'yaw');
		assert.ok(Math.abs(c.ff - ref.ff / fs) < 1e-9, `${family}: yaw feedforward cutoff`);
		assert.ok(Math.abs(c.rc - ref.rc / fs) < 1e-9, `${family}: yaw RC smoothing cutoff`);
	}
	// And the one family it is not 1 on is the one family with a filterScale.
	assert.equal(PROFILES.toothpick.filterScale, 2);
	const tp = CUTOFFS(new FlightController({ profile: PROFILES.toothpick }), 'yaw');
	assert.ok(Math.abs(tp.rc - ref.rc / 2) < 1e-9, 'the toothpick smooths yaw twice as slowly');
});

t('roll and pitch take filterScale on both chains', () => {
	const ref = CUTOFFS(new FlightController({ profile: PROFILES.freestyle5 }), 'roll');
	for (const axis of ['roll', 'pitch']) {
		const c = CUTOFFS(new FlightController({ profile: PROFILES.toothpick }), axis);
		for (const k of ['gyro', 'd', 'ff', 'rc']) {
			assert.ok(Math.abs(c[k] - ref[k] * 2) < 1e-9, `toothpick ${axis} ${k} cutoff`);
		}
	}
});

t('a family without a filterScale is untouched by any of it', () => {
	// Every cutoff on every axis equals the reference chain, which is what makes
	// the split above a no-op for five families out of six.
	const ref = new FlightController({ profile: PROFILES.freestyle5 });
	for (const family of Object.keys(PROFILES)) {
		if ((PROFILES[family].filterScale ?? 1) !== 1) continue;
		const fc = new FlightController({ profile: PROFILES[family] });
		for (const axis of ['roll', 'pitch', 'yaw']) {
			assert.deepEqual(CUTOFFS(fc, axis), CUTOFFS(ref, axis), `${family} ${axis}`);
		}
	}
});

console.log(`loop-realism-selftest : ${n} tests ok`);

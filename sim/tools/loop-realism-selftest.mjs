// The loop-realism lot, asserted where it meets the flight controller.
//
// The lot added a gyro that lies, a loop that is late, notches that answer the
// lies, anti-gravity and D-max — and it added all of them INERT. That is not
// modesty: the PID blocks in src/drone-profiles.js were swept by
// tools/tune-pid.mjs against a loop with none of these, and every one of them
// moves the plant that sweep was run against. They go on together with a
// re-sweep.
//
// So the first half of this file is one claim, made five ways: with the
// profiles as they ship, the controller produces the same motor commands it
// produced before any of this existed. The second half is the machinery
// itself, exercised at settings nothing ships with.
//
// tools/loop-rate-bench.mjs is where the case for each setting is measured;
// this file only says that the settings do what they say and that the defaults
// do nothing.
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
// 1. The defaults are inert

t('every family ships with a perfect gyro and a loop with no latency', () => {
	for (const f of FAMILIES) {
		assert.equal(PROFILES[f].gyroNoise, 0, `${f}.gyroNoise`);
		assert.equal(PROFILES[f].loopDelay, 0, `${f}.loopDelay`);
	}
});

t('the two settings with no profile field ship at the value that does nothing', () => {
	assert.equal(ANTI_GRAVITY_GAIN, 0);
	assert.equal(D_MAX_RATIO, 1.0);
});

t('the control loop ships on the physics grid, one substep', () => {
	assert.equal(CONTROL_SUBSTEPS, 1);
	assert.equal(parseControlRate(null), 1);
	assert.equal(parseControlRate(undefined), 1);
	assert.equal(parseControlRate(''), 1);
});

t('no notch is even CONSTRUCTED on a default airframe', () => {
	for (const f of FAMILIES) {
		const fc = new FlightController({ profile: PROFILES[f] });
		for (const axis of ['roll', 'pitch', 'yaw']) {
			assert.equal(fc.pid[axis].notches, null, `${f}.${axis}`);
			assert.equal(fc.pid[axis].dMaxLpf, null, `${f}.${axis} D-max`);
		}
	}
});

t('the motor commands are bit-identical with the new path explicitly zeroed', () => {
	// If the defaults were anything but inert, forcing them to zero would change
	// the answer. Run for run, motor for motor, bit for bit — on every family,
	// because filterScale and the per-family tunes take different branches.
	for (const f of FAMILIES) {
		const a = flight(PROFILES[f]);
		const b = flight(PROFILES[f], { gyroNoise: 0, loopDelay: 0, antiGravity: 0, dMax: 1, filters: false });
		assert.deepEqual(a, b, f);
	}
});

t('the gyro hands the loop the true body rates, object and all', () => {
	const fc = new FlightController({ profile: PROFILES.freestyle5 });
	const w = { x: 0.7, y: -0.2, z: 1.3 };
	assert.equal(fc.gyro.sample(w, [2000, 2000, 2000, 2000], DT).x, w.x);
	assert.equal(fc.loopDelay.step(w, DT), w);
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

	// And at 1 kHz the fundamentals are there.
	const fast = new FlightController({ profile: PROFILES.freestyle5, gyroNoise: 0.08 });
	for (let i = 0; i < 200; i++) {
		fast.update({ throttle: 0.4, roll: 0, pitch: 0, yaw: 0 },
			{ rotation: IDENTITY, angularVelocity: ZERO, position: ZERO, velocity: ZERO, rotorOmega: prop.omega },
			1 / 1000);
	}
	assert.ok(fast.pid.roll.notches.rpm.notches.some((e) => !e.n.bypass), 'no notch at 1 kHz either');
});

t('loop latency is what delays the loop, and nothing else does', () => {
	const none = flight(PROFILES.freestyle5, {});
	const late = flight(PROFILES.freestyle5, { loopDelay: 4 * DT });
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

console.log(`loop-realism-selftest : ${n} tests ok`);

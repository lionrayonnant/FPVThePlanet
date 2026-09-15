// Acro3D (§2.5 ControlMode 3, §3.2, §4.1) — the bidirectional gas.
//
// Acro3D is not a mode in the sense angle mode is. It adds no loop, no gain and
// no state machine: it lifts a single assumption, "a rotor turns one way", that
// three separate places in the flight stack had baked in. This bench exists to
// check both halves of that sentence:
//
//   1. THE LIFT WORKS. Reversed props make reversed thrust, reversed prop-drag
//      torque, and a rate loop that still closes with the right sign when the
//      machine is upside down. Inverted hover is the acceptance test a pilot
//      would run, so it is the one run here.
//
//   2. THE LIFT COSTS NOTHING. Every generalisation below is written so that
//      the forward direction reduces to the arithmetic that was there before —
//      `s` is 1, `aw` is `w`, `bidirectional` is false. That is asserted here
//      bit for bit, on the motor model and on the mixer, and by
//      tools/flight-replay.mjs on the whole machine.
//
// Run: node tools/acro3d-selftest.mjs

import assert from 'node:assert/strict';
import { initPhysics, Physics } from '../src/physics.js';
import { PROFILES, FAMILIES, DEFAULT_FAMILY } from '../src/drone-profiles.js';
import { FlightController, hoverThrottle } from '../src/flightController.js';
import { Propulsion } from '../src/quad.js';
import { motorConstants, stepMotor } from '../src/motor.js';

let n = 0;
function t(label, fn) { fn(); n++; console.log(`  ok  ${label}`); }

const DT = 1 / 250;
const STILL = { speed: 0, gust: 0, turbulence: 0 };
const EMPTY = { vertices: new Float32Array(0), indices: new Uint32Array(0) };
const PROFILE = PROFILES[DEFAULT_FAMILY];

// ---------------------------------------------------------------------------
// 1. The forward path is untouched, at the level of the three lifted assumptions

console.log('\nACRO3D — the forward path is bit-identical');

t('stepMotor: bidirectional off reproduces the legacy balance exactly', () => {
	const c = motorConstants(PROFILE);
	const volts = PROFILE.battery.cells * 4.0;
	// The expression this function used to be, transcribed. If the
	// generalisation ever stops reducing to it, this is where it shows.
	const legacy = (omega, duty, loadTorque) => {
		const drive = duty * volts;
		const gain = drive >= c.Ke * omega ? 1 : c.braking;
		const a = gain * c.electricalDamping;
		const b = gain * (c.Ke * drive) / c.R - c.Ke * c.i0 - loadTorque;
		let next = a > 0
			? (b / a) + (omega - b / a) * Math.exp(-(a * DT) / c.J)
			: omega + (b / c.J) * DT;
		if (next < 0) next = 0;
		const winding = (drive - c.Ke * next) / c.R;
		const i = winding > 0 ? winding : gain * winding;
		return { omega: next, current: i, packCurrent: duty * i };
	};
	for (let w = 0; w <= 4000; w += 137) {
		for (let duty = 0; duty <= 1.0001; duty += 0.05) {
			for (const load of [0, 1e-4, 3e-3, 2e-2]) {
				const got = stepMotor(c, w, duty, volts, load, DT);
				const want = legacy(w, duty, load);
				assert.equal(got.omega, want.omega);
				assert.equal(got.current, want.current);
				assert.equal(got.packCurrent, want.packCurrent);
			}
		}
	}
});

t('the mixer: acro3d above centre stick is the acro mixer, command for command', () => {
	// Same PID outputs, same effective throttle: mix3d with dir = +1 must be
	// mix(). Not "close to": the same doubles, because it is the same code with
	// a factor of one through it.
	const c = new FlightController({ profile: PROFILE });
	for (const [r, p, y, th] of [
		[0, 0, 0, 0.5], [0.4, -0.2, 0.1, 0.3], [1.2, 0.9, -0.7, 0.9], [-2, 2, 2, 0.05],
	]) {
		const a = [...c.mix(r, p, y, th)];
		const b = [...c.mix3d(r, p, y, th, 1)];
		assert.deepEqual(b, a);
	}
});

t('Propulsion: a forward command never reaches the bidirectional branch', () => {
	// The branch is chosen by the command's own sign, so this is really the
	// claim that the acro mixer cannot emit a negative number — which the
	// MOTOR_IDLE floor guarantees — and that a forward shaft never goes
	// negative on its own.
	const prop = new Propulsion({ profile: PROFILE });
	const c = new FlightController({ profile: PROFILE });
	const air = { v: { x: 0, y: 0, z: 0 }, agl: null, shake: 0 };
	for (let i = 0; i < 2000; i++) {
		const th = 0.5 + 0.5 * Math.sin(i * 0.03);
		const motors = c.mix(Math.sin(i * 0.07) * 2, Math.cos(i * 0.05) * 2, 0.3, th);
		for (const m of motors) assert.ok(m >= 0, `mixer emitted ${m}`);
		prop.step(motors, air, DT);
		for (const w of prop.omega) assert.ok(w >= 0, `forward shaft went to ${w}`);
	}
});

// ---------------------------------------------------------------------------
// 2. The lift works

console.log('\nACRO3D — reversed rotors');

t('centre stick is zero gas, either half of the travel is a full range', () => {
	const c = new FlightController({ profile: PROFILE, mode: 'acro3d' });
	const state = restState();
	const at = (throttle) => {
		c.reset();
		return c.update({ throttle, roll: 0, pitch: 0, yaw: 0 }, state, DT);
	};
	assert.ok(Math.abs(at(0.5).throttle) < 1e-12, 'centre stick is not zero gas');
	assert.equal(at(1).direction, 1);
	assert.equal(at(0).direction, -1);
	// Symmetric: the same distance from centre is the same magnitude.
	assert.ok(Math.abs(at(0.75).throttle - at(0.25).throttle) < 1e-12);
	// And the full range is reachable both ways.
	assert.ok(at(1).throttle > 0.99 && at(0).throttle > 0.99);
});

t('below centre every motor command is negative, above it none is', () => {
	const c = new FlightController({ profile: PROFILE, mode: 'acro3d' });
	const state = restState();
	const low = c.update({ throttle: 0.15, roll: 0.3, pitch: -0.2, yaw: 0.1 }, state, DT);
	assert.ok(low.motors.every((m) => m < 0), `got ${low.motors}`);
	c.reset();
	const high = c.update({ throttle: 0.85, roll: 0.3, pitch: -0.2, yaw: 0.1 }, state, DT);
	assert.ok(high.motors.every((m) => m > 0), `got ${high.motors}`);
});

t('a reversed rotor makes reversed thrust and reversed prop-drag torque', () => {
	const prop = new Propulsion({ profile: PROFILE });
	const air = { v: { x: 0, y: 0, z: 0 }, agl: null, shake: 0 };
	const settle = (cmd) => {
		prop.reset();
		for (let i = 0; i < 1500; i++) prop.step([cmd, cmd, cmd, cmd], air, DT);
		return { force: { ...prop.force }, torque: { ...prop.torque }, omega: [...prop.omega] };
	};
	const fwd = settle(0.6);
	const rev = settle(-0.6);
	assert.ok(fwd.force.y > 0 && rev.force.y < 0, `${fwd.force.y} / ${rev.force.y}`);
	// Same magnitude to within the ESC's own asymmetry (driving one way and
	// braking the other is not symmetric), but well within a factor.
	const ratio = Math.abs(rev.force.y / fwd.force.y);
	assert.ok(ratio > 0.9 && ratio < 1.1, `reversed thrust is ${ratio.toFixed(3)}x forward`);
	for (let i = 0; i < 4; i++) assert.ok(rev.omega[i] < 0, `shaft ${i} = ${rev.omega[i]}`);
	// A symmetric X cancels its own yaw either way; what must NOT happen is a
	// net yaw appearing out of the reversal.
	assert.ok(Math.abs(rev.torque.y) < 1e-6, `yaw torque ${rev.torque.y}`);
});

t('the shaft crosses zero rather than sticking at it', () => {
	const prop = new Propulsion({ profile: PROFILE });
	const air = { v: { x: 0, y: 0, z: 0 }, agl: null, shake: 0 };
	for (let i = 0; i < 800; i++) prop.step([-0.7, -0.7, -0.7, -0.7], air, DT);
	assert.ok(prop.omega[0] < -100, `did not spin up in reverse: ${prop.omega[0]}`);
	let crossed = false;
	for (let i = 0; i < 800; i++) {
		prop.step([0.7, 0.7, 0.7, 0.7], air, DT);
		if (prop.omega[0] > 100) { crossed = true; break; }
	}
	assert.ok(crossed, 'the reversal never completed');
});

t('the rate loop closes the right way round with the props reversed', () => {
	// The real check on mix3d's placement of `dir`. Hold the machine inverted,
	// ask for a roll rate, and the body must actually turn that way. Get the
	// sign wrong and this diverges instead.
	const c = new FlightController({ profile: PROFILE, mode: 'acro3d' });
	const prop = new Propulsion({ profile: PROFILE });
	const air = { v: { x: 0, y: 0, z: 0 }, agl: null, shake: 0 };
	// Inverted: 180 degrees about the body X axis.
	const q = { x: 1, y: 0, z: 0, w: 0 };
	const rate = { x: 0, y: 0, z: 0 };
	const inertia = PROFILE.inertia;
	for (let i = 0; i < 400; i++) {
		const state = {
			rotation: q,
			angularVelocity: rate,
			position: { x: 0, y: 50, z: 0 },
			velocity: { x: 0, y: 0, z: 0 },
			rotorOmega: prop.omega,
		};
		const { motors } = c.update({ throttle: 0.05, roll: 1, pitch: 0, yaw: 0 }, state, DT);
		prop.step(motors, { ...air, omega: rate }, DT);
		// Free body, one axis, no integration of the attitude: all that is being
		// asked is whether the torque points the way the setpoint does.
		rate.z += (prop.torque.z / inertia.z) * DT;
	}
	// Roll stick +1 is roll right, which is -omega.z (see the header of
	// flightController.js). The machine must be turning that way, not the other.
	assert.ok(rate.z < -1, `roll command produced omega.z = ${rate.z.toFixed(3)}`);
});

// ---------------------------------------------------------------------------
// 3. Inverted hover, on the real Physics

console.log('\nACRO3D — inverted hover, per family');

await initPhysics();

for (const family of FAMILIES) {
	const profile = PROFILES[family];
	const p = new Physics(EMPTY, { x: 0, y: 200, z: 0 },
		{ profile, weather: STILL, seed: 0x5eed, windSeed: 0x117d });
	// Upside down and level: 180 degrees about body X.
	p.applyEntryState({
		position: { x: 0, y: 200, z: 0 },
		quaternion: { x: 1, y: 0, z: 0, w: 0 },
		linvel: { x: 0, y: 0, z: 0 },
		angvel: { x: 0, y: 0, z: 0 },
	});
	const c = new FlightController({ profile, mode: 'acro3d' });
	// The stick that holds an upright hover, read the other way round: the
	// magnitude is the same, the half of the travel is not.
	const upright = hoverThrottle(profile, { x: 0, y: 0, z: 0, w: 1 }, p.battery.voltage);
	let y0 = null;
	for (let i = 0; i < Math.round(6 / DT); i++) {
		p.step(c.update({ throttle: (1 - upright) / 2, roll: 0, pitch: 0, yaw: 0 }, p, DT).motors, DT);
		if (i === Math.round(1 / DT)) y0 = p.position.y;
	}
	const drift = p.position.y - y0;
	const inverted = p.rotation.w * p.rotation.w < 0.5;
	console.log(`  ${family.padEnd(11)} 5 s inverted: ${drift >= 0 ? '+' : ''}${drift.toFixed(2)} m`
		+ `   still inverted: ${inverted ? 'yes' : 'NO'}`);
	assert.ok(inverted, `${family} did not stay inverted`);
	// It holds itself up in the wrong attitude. The tolerance is generous on
	// purpose: this is an OPEN-LOOP throttle with no altitude hold under it, and
	// what is being asserted is that reversed thrust carries the weight at all,
	// not that it carries it to the centimetre.
	assert.ok(Math.abs(drift) < 12, `${family} drifted ${drift.toFixed(2)} m in 5 s inverted`);
	n++;
}

function restState() {
	return {
		rotation: { x: 0, y: 0, z: 0, w: 1 },
		angularVelocity: { x: 0, y: 0, z: 0 },
		position: { x: 0, y: 100, z: 0 },
		velocity: { x: 0, y: 0, z: 0 },
	};
}

console.log(`\nacro3d-selftest : ${n} tests ok`);

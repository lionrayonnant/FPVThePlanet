// GPS position hold (§2.5 ControlMode 5, §9.6).
//
// The mode is a position loop that produces an ATTITUDE and hands it to the
// existing self-levelling branch, exactly as angle mode hands it a stick. So
// what there is to check divides in two:
//
//   - the arithmetic §9.6 actually specifies: the `distance ^ 1.35` shaping,
//     the tilt bound, the two integral-reset thresholds, and the heading
//     normalised into [-180, 180];
//   - the only thing that matters to a pilot, which the spec states as a
//     warning rather than a number — "sinon le retour au neutre oscille". So
//     this bench flies the real Physics, displaces the machine, and measures
//     the return: how long, how far past, how many times back and forth.
//
// The gains in GPS_DEFAULTS were swept with this file. They are in METRES:
// §9.6 is written in centimetres, and `distance ^ 1.35` is the one expression
// in the whole spec that a change of unit does not survive — the same exponent
// on centimetres is 631 times the number it is on metres, so a gain copied out
// of a centimetre implementation is wrong by that factor and nothing about the
// symptom would say so.
//
// Run: node tools/gps-hold-selftest.mjs

import assert from 'node:assert/strict';
import { initPhysics, Physics } from '../src/physics.js';
import { PROFILES, FAMILIES, DEFAULT_FAMILY } from '../src/drone-profiles.js';
import { FlightController, GPS_DEFAULTS, normaliseHeading } from '../src/flightController.js';

let n = 0;
function t(label, fn) { fn(); n++; console.log(`  ok  ${label}`); }

const DT = 1 / 250;
const DEG = Math.PI / 180;
const STILL = { speed: 0, gust: 0, turbulence: 0 };
const EMPTY = { vertices: new Float32Array(0), indices: new Uint32Array(0) };
const CENTRE = { throttle: 0.5, roll: 0, pitch: 0, yaw: 0 };

await initPhysics();

function rig(family = DEFAULT_FAMILY, gps = {}) {
	const profile = PROFILES[family];
	const p = new Physics(EMPTY, { x: 0, y: 200, z: 0 },
		{ profile, weather: STILL, seed: 0x5eed, windSeed: 0x117d });
	p.applyEntryState({
		position: { x: 0, y: 200, z: 0 },
		quaternion: { x: 0, y: 0, z: 0, w: 1 },
		linvel: { x: 0, y: 0, z: 0 },
		angvel: { x: 0, y: 0, z: 0 },
	});
	const c = new FlightController({ profile, mode: 'gps', gps });
	return { p, c, profile };
}

function fly(p, c, seconds, sticks = CENTRE) {
	const steps = Math.round(seconds / DT);
	for (let i = 0; i < steps; i++) p.step(c.update(sticks, p, DT).motors, DT);
}

// ---------------------------------------------------------------------------

console.log('\nGPS — what §9.6 specifies');

t('the heading normalises into [-180, 180)', () => {
	assert.equal(normaliseHeading(0), 0);
	assert.equal(normaliseHeading(179), 179);
	assert.equal(normaliseHeading(181), -179);
	assert.equal(normaliseHeading(-181), 179);
	assert.equal(normaliseHeading(360 * 7 + 30), 30);
	assert.equal(normaliseHeading(-360 * 7 - 30), -30);
	// The interval is closed at -180 and open at 180, so a heading walked all
	// the way round in small steps never leaves it and never jumps by 360.
	let h = 0;
	for (let i = 0; i < 5000; i++) {
		h = normaliseHeading(h + 0.37);
		assert.ok(h >= -180 && h < 180, `${h} left the interval`);
	}
});

t('the yaw target integrates the stick at GpsYawSpeedFactor, and wraps', () => {
	const { p, c } = rig();
	fly(p, c, 0.5);
	const start = c.gpsHeading;
	// Full yaw stick for one second is exactly the factor, before the machine
	// has had time to follow it.
	const one = { ...CENTRE, yaw: 1 };
	const steps = Math.round(1 / DT);
	for (let i = 0; i < steps; i++) c.update(one, p, DT);
	const moved = normaliseHeading(c.gpsHeading - start);
	assert.ok(Math.abs(moved - GPS_DEFAULTS.yawSpeedFactor) < 1,
		`moved ${moved.toFixed(2)} deg, expected ${GPS_DEFAULTS.yawSpeedFactor}`);
	// Ten seconds of it is two and a half turns, and the target is still in
	// range rather than at 900.
	for (let i = 0; i < steps * 10; i++) c.update(one, p, DT);
	assert.ok(c.gpsHeading >= -180 && c.gpsHeading < 180, `${c.gpsHeading}`);
});

t('the distance error is shaped by distance^1.35, not by each axis on its own', () => {
	// The observable consequence: the demanded lean must depend only on how far
	// the machine is, never on the compass bearing of the drift. Shape the two
	// components separately and a drift at 45 degrees leans 1.19x as hard as the
	// same drift due east.
	const { p, c } = rig();
	fly(p, c, 0.5);
	const d = 12;
	const lean = (bearing) => {
		c.gpsPid.x.reset(); c.gpsPid.z.reset();
		c.gpsHold = { x: p.position.x + d * Math.cos(bearing), z: p.position.z + d * Math.sin(bearing) };
		const upB = { x: 0, y: 1, z: 0 };
		const g = c.stabGps(CENTRE, p, upB, DT);
		return Math.hypot(Math.asin(g.pitch), Math.asin(g.roll));
	};
	const ref = lean(0);
	for (let b = 0; b < 2 * Math.PI; b += Math.PI / 8) {
		assert.ok(Math.abs(lean(b) - ref) < 1e-9, `bearing ${b} leans ${lean(b)} not ${ref}`);
	}
	// And the shaping really is the power law: doubling the distance must
	// multiply the P part of the demand by 2^1.35 = 2.55, not by 2.
	const demand = (dist) => {
		c.gpsPid.x.reset(); c.gpsPid.z.reset();
		c.gpsHold = { x: p.position.x + dist, z: p.position.z };
		return Math.abs(Math.asin(c.stabGps(CENTRE, p, { x: 0, y: 1, z: 0 }, DT).roll));
	};
	// Small distances, so neither call is anywhere near the tilt bound.
	const a = demand(1), b = demand(2);
	assert.ok(Math.abs(b / a - Math.pow(2, 1.35)) < 0.05, `ratio ${(b / a).toFixed(3)}`);
});

t('the lean is bounded by MaxGpsTiltAngle on the COMPOSITE, not per axis', () => {
	const { p, c } = rig();
	fly(p, c, 0.5);
	// Far enough out that both PIDs saturate.
	c.gpsHold = { x: p.position.x + 400, z: p.position.z + 400 };
	const g = c.stabGps(CENTRE, p, { x: 0, y: 1, z: 0 }, DT);
	const tilt = Math.hypot(Math.asin(g.pitch), Math.asin(g.roll));
	assert.ok(tilt <= GPS_DEFAULTS.maxTilt + 1e-9,
		`composite tilt ${(tilt / DEG).toFixed(2)} deg past the ${(GPS_DEFAULTS.maxTilt / DEG)} deg limit`);
	// Not merely under the limit — AT it, or the bound is doing nothing.
	assert.ok(tilt > GPS_DEFAULTS.maxTilt * 0.99);
});

t('the integrals are reset past 20 deg on an axis and 30 deg composed', () => {
	const { p, c } = rig();
	fly(p, c, 0.5);
	const upright = { x: 0, y: 1, z: 0 };
	// Half a metre out: the lean it asks for is under a degree, so the
	// thresholds below are about the ATTITUDE handed in and nothing else. The
	// hold point is left where it is for the rest of the test — moving it is a
	// step in the error, and a step in the error is a derivative spike big
	// enough to saturate the demand and trip the thresholds on its own.
	const wind = () => {
		c.gpsPid.x.reset(); c.gpsPid.z.reset();
		c.gpsHold = { x: p.position.x + 0.5, z: p.position.z };
		for (let i = 0; i < 200; i++) c.stabGps(CENTRE, p, upright, DT);
		assert.ok(Math.abs(c.gpsPid.x.integral) > 0, 'the integral never wound up');
	};
	// One step with an attitude `pitchDeg` / `rollDeg` off level. The identities
	// are sin(pitch) = -upB.z and sin(roll) = -upB.x.
	const handIn = (pitchDeg, rollDeg) => c.stabGps(CENTRE, p, {
		x: -Math.sin(rollDeg * DEG), y: 1, z: -Math.sin(pitchDeg * DEG),
	}, DT);

	// 25 degrees on one axis is past the 20 degree axis threshold.
	wind();
	handIn(0, 25);
	assert.equal(c.gpsPid.x.integral, 0, 'the 20 deg axis threshold did not fire');
	assert.equal(c.gpsPid.z.integral, 0, 'both integrals must go, not one');

	// 16 on each axis is under 20 on either and 22.6 composed — under 30 too,
	// so nothing must fire. This is the half of the rule it is easy to get wrong
	// by only ever testing the trigger.
	wind();
	handIn(16, 16);
	assert.notEqual(c.gpsPid.x.integral, 0, '22.6 deg composed is under the 30 deg threshold');

	// And the composite rule does fire when the hypotenuse asks it to.
	wind();
	handIn(25, 25);
	assert.equal(c.gpsPid.x.integral, 0, 'the composed threshold did not fire');

	// A NOTE ON THE TWO NUMBERS §9.6 GIVES. Two axes each under 20 degrees can
	// compose to at most 28.3, which is under 30 — so the composite rule can
	// never fire on an attitude the axis rule has not already caught. It is
	// redundant as specified. Both are implemented anyway, because the spec says
	// both and because a future change to either number makes the other live.
	assert.ok(Math.hypot(20, 20) < 30);
});

t('resetting the mode clears the PIDs and re-arms the hold point and the heading', () => {
	const { p, c } = rig();
	fly(p, c, 1);
	p.body.setTranslation({ x: 40, y: p.position.y, z: 25 }, true);
	fly(p, c, 0.5);
	assert.ok(Math.abs(c.gpsPid.x.integral) > 0);
	c.setMode('gps');
	assert.equal(c.gpsHold, null);
	assert.equal(c.gpsHeading, null);
	assert.equal(c.gpsPid.x.integral, 0);
	assert.equal(c.gpsPid.z.integral, 0);
	// One step re-arms it where the machine actually is, not where the mode
	// was first entered.
	c.update(CENTRE, p, DT);
	assert.ok(Math.abs(c.gpsHold.x - p.position.x) < 1e-6);
	assert.ok(Math.abs(c.gpsHold.z - p.position.z) < 1e-6);
});

t('above the dead zone the pilot flies and the hold point follows the machine', () => {
	const { p, c } = rig();
	fly(p, c, 1);
	const held = c.stabGps(CENTRE, p, { x: 0, y: 1, z: 0 }, DT);
	assert.equal(held.held, true);
	const flown = c.stabGps({ ...CENTRE, pitch: -1 }, p, { x: 0, y: 1, z: 0 }, DT);
	assert.equal(flown.held, false);
	// Full forward stick is the tilt limit, nose DOWN, which is a negative
	// sin(pitch).
	assert.ok(Math.asin(flown.pitch) < -GPS_DEFAULTS.maxTilt * 0.99);
	// And having flown, letting go parks it here rather than flying it back.
	// The hold point trails by exactly one step, which at the speed two seconds
	// of full stick reaches is a few centimetres — not the tens of metres it
	// would be if the point had stayed where the mode was entered.
	fly(p, c, 2, { ...CENTRE, pitch: -1 });
	assert.ok(Math.hypot(c.gpsHold.x - p.position.x, c.gpsHold.z - p.position.z) < 0.2);
});

// ---------------------------------------------------------------------------

console.log('\nGPS — the return to the point, per family, on the real Physics');
console.log('\n  family       disp   settle   overshoot   reversals   alt drift');

for (const family of FAMILIES) {
	for (const displacement of [2, 20, 60]) {
		const { p, c } = rig(family);
		fly(p, c, 1);
		const y0 = p.position.y;
		const hold = { x: c.gpsHold.x, z: c.gpsHold.z };
		p.body.setTranslation({ x: hold.x + displacement, y: y0, z: hold.z }, true);

		let settle = null, overshoot = 0, reversals = 0, prev = 1;
		const steps = Math.round(40 / DT);
		for (let i = 0; i < steps; i++) {
			p.step(c.update(CENTRE, p, DT).motors, DT);
			const ex = p.position.x - hold.x;
			const d = Math.hypot(ex, p.position.z - hold.z);
			// A reversal only counts while the machine is still meaningfully off
			// the point: sign changes inside a centimetre are it sitting there.
			if (d > 0.02 * displacement) {
				const sign = ex < 0 ? -1 : 1;
				if (sign !== prev) reversals++;
				prev = sign;
			}
			if (ex < 0) overshoot = Math.max(overshoot, -ex);
			if (settle === null && d < 0.05 * displacement) settle = i * DT;
		}
		const final = Math.hypot(p.position.x - hold.x, p.position.z - hold.z);
		const altDrift = p.position.y - y0;
		console.log(`  ${family.padEnd(11)} ${String(displacement).padStart(3)} m`
			+ `  ${(settle === null ? '  --' : settle.toFixed(1) + ' s').padStart(6)}`
			+ `   ${(100 * overshoot / displacement).toFixed(1).padStart(5)} %`
			+ `   ${String(reversals).padStart(6)}`
			+ `   ${(altDrift >= 0 ? '+' : '') + altDrift.toFixed(2)} m`);

		// It goes back. This is the whole mode.
		assert.ok(final < 0.02 * displacement + 0.05,
			`${family} @${displacement}m ended ${final.toFixed(2)} m off the point`);
		assert.ok(settle !== null && settle < 25,
			`${family} @${displacement}m never settled`);
		// "sinon le retour au neutre oscille" — one overshoot is a return, three
		// reversals is a ring, and the integral resets are what keep it at one.
		assert.ok(reversals <= 2, `${family} @${displacement}m reversed ${reversals} times`);
		assert.ok(overshoot < 0.12 * displacement,
			`${family} @${displacement}m overshot by ${(100 * overshoot / displacement).toFixed(1)} %`);
		// The vertical hold is a separate loop and must not be disturbed by the
		// horizontal one leaning the machine over.
		assert.ok(Math.abs(altDrift) < 2,
			`${family} @${displacement}m drifted ${altDrift.toFixed(2)} m vertically`);
		n += 5;
	}
}

// ---------------------------------------------------------------------------

console.log('\nGPS — the heading hold, on the real Physics');

{
	const { p, c } = rig();
	fly(p, c, 1);
	// Kick the nose 60 degrees off and let go.
	const a = 30 * DEG;
	p.body.setRotation({ x: 0, y: Math.sin(a), z: 0, w: Math.cos(a) }, true);
	fly(p, c, 8);
	const fwd = p.rotation;
	// Heading back out of the quaternion, the same way stabGps reads it.
	const f = { x: 2 * (fwd.x * fwd.z + fwd.w * fwd.y), z: -(1 - 2 * (fwd.x * fwd.x + fwd.y * fwd.y)) };
	const heading = Math.atan2(f.x, -f.z) / DEG;
	const err = normaliseHeading(heading - c.gpsHeading);
	console.log(`  nose kicked 60 deg, 8 s later: ${err.toFixed(2)} deg off the held heading`);
	assert.ok(Math.abs(err) < 3, `heading hold left ${err.toFixed(2)} deg`);
	n++;
}

console.log(`\ngps-hold-selftest : ${n} tests ok`);

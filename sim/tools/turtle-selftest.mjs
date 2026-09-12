// Selftest of the assisted flip (#105). No DOM, no Rapier: a one-degree-of-
// freedom rigid body integrated by hand is enough — the flip turns about a
// single horizontal axis, which is exactly what this file simulates.
// Run: node tools/turtle-selftest.mjs
import assert from 'node:assert/strict';
import { Turtle, TURTLE, maxRollTorque } from '../src/turtle.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

const DT = 1 / 250;                  // the sim's fixed step
const I = 0.0031;                    // roll/pitch inertia of the reference build
const MAX_TORQUE = 1.56;             // two motors at full thrust on one arm

// Attitude as one angle from upright, turning about world X. Rotating (0,1,0)
// by theta gives this `up`, and the body rate is simply dtheta/dt.
const upAt = (theta) => ({ x: 0, y: Math.cos(theta), z: Math.sin(theta) });

const ON_ITS_BACK = Math.PI - 0.05;  // just off dead flat, so the axis is defined

function frame(over = {}) {
	return {
		dt: DT, armed: true, stuck: true, pressed: false,
		up: upAt(ON_ITS_BACK), angularVelocity: { x: 0, y: 0, z: 0 },
		inertia: I, maxTorque: MAX_TORQUE,
		...over,
	};
}

// Integrates the machine under whatever torque the module asks for, and returns
// how it ended up. `hold: true` refuses the torque — a machine wedged under a
// balcony that the flip cannot move.
function flip(tu, { theta0 = ON_ITS_BACK, seconds = 3, hold = false } = {}) {
	let theta = theta0, w = 0, peak = 0;
	const steps = Math.round(seconds / DT);
	for (let i = 0; i < steps; i++) {
		tu.update(frame({ up: upAt(theta), angularVelocity: { x: w, y: 0, z: 0 } }));
		peak = Math.max(peak, Math.abs(tu.out.torque.x), Math.abs(tu.out.torque.z));
		if (!tu.out.active) return { theta, w, peak, t: i * DT };
		if (!hold) {
			w += (tu.out.torque.x / I) * DT;
			theta += w * DT;
		}
	}
	return { theta, w, peak, t: seconds };
}

t('upright: nothing is offered, whatever else is true', () => {
	const tu = new Turtle();
	tu.update(frame({ up: upAt(0) }));
	assert.equal(tu.out.eligible, false);
	assert.equal(tu.out.active, false);
});

t('on its side is not on its back: the flip is not offered at 90 degrees', () => {
	const tu = new Turtle();
	tu.update(frame({ up: upAt(Math.PI / 2) }));
	assert.equal(tu.out.eligible, false);
});

t('on its back and stuck: the line is offered', () => {
	const tu = new Turtle();
	tu.update(frame());
	assert.equal(tu.out.eligible, true);
});

t('moving, or disarmed, is not stuck: nothing is offered', () => {
	const tu = new Turtle();
	tu.update(frame({ stuck: false }));
	assert.equal(tu.out.eligible, false);
	tu.update(frame({ armed: false }));
	assert.equal(tu.out.eligible, false);
});

t('a press outside the offer does nothing', () => {
	const tu = new Turtle();
	tu.update(frame({ up: upAt(0), pressed: true }));
	assert.equal(tu.out.active, false);
	assert.deepEqual(tu.out.torque, { x: 0, y: 0, z: 0 });
});

t('a press on the offer starts the flip', () => {
	const tu = new Turtle();
	tu.update(frame({ pressed: true }));
	assert.equal(tu.out.active, true);
	// The invitation goes out the moment it is accepted.
	assert.equal(tu.out.eligible, false);
});

t('the flip puts the machine back on its feet, and stops by itself', () => {
	const tu = new Turtle();
	tu.update(frame({ pressed: true }));
	const r = flip(tu);
	assert.equal(tu.out.active, false, 'the mode released');
	assert.ok(Math.cos(r.theta) > TURTLE.RIGHTED, `upright, up.y = ${Math.cos(r.theta).toFixed(3)}`);
	assert.ok(r.t < TURTLE.TIMEOUT_S, `on its feet before the timeout (${r.t.toFixed(2)} s)`);
	// The gains are written for FLIP_S; a flip that took five times that would
	// mean the loop is not doing what its comment claims.
	assert.ok(r.t < TURTLE.FLIP_S * 3, `roughly the flip that was asked for (${r.t.toFixed(2)} s)`);
});

t('the flip never overshoots onto the other side', () => {
	const tu = new Turtle();
	tu.update(frame({ pressed: true }));
	let theta = ON_ITS_BACK, w = 0, minTheta = theta;
	for (let i = 0; i < Math.round(3 / DT) && tu.out.active; i++) {
		tu.update(frame({ up: upAt(theta), angularVelocity: { x: w, y: 0, z: 0 } }));
		w += (tu.out.torque.x / I) * DT;
		theta += w * DT;
		minTheta = Math.min(minTheta, theta);
	}
	assert.ok(minTheta > -0.35, `no tumble past level (min ${minTheta.toFixed(3)} rad)`);
});

t('a machine the flip cannot move gives up at the timeout', () => {
	const tu = new Turtle();
	tu.update(frame({ pressed: true }));
	const r = flip(tu, { hold: true, seconds: 5 });
	assert.equal(tu.out.active, false, 'the mode can never latch');
	assert.ok(Math.abs(r.t - TURTLE.TIMEOUT_S) < 0.05, `stopped at the timeout (${r.t.toFixed(2)} s)`);
});

t('the assist never asks for more torque than the airframe could make', () => {
	const tu = new Turtle();
	tu.update(frame({ pressed: true }));
	const r = flip(tu);
	assert.ok(r.peak <= MAX_TORQUE + 1e-9, `capped (peak ${r.peak.toFixed(3)} N·m)`);
	// And the cap is a real figure, not a number picked here.
	assert.equal(maxRollTorque({ maxThrustPerMotor: 10, armX: 0.078 }), 1.56);
});

t('dead flat on its back: a degenerate axis still produces a torque', () => {
	const tu = new Turtle();
	tu.update(frame({ pressed: true, up: { x: 0, y: -1, z: 0 } }));
	tu.update(frame({ up: { x: 0, y: -1, z: 0 } }));
	const { x, y, z } = tu.out.torque;
	assert.ok(Math.hypot(x, z) > 0, 'it rolls over one side rather than dividing by zero');
	assert.equal(y, 0, 'and never touches the yaw');
});

t('losing the machine mid-flip ends it', () => {
	const tu = new Turtle();
	tu.update(frame({ pressed: true }));
	tu.update(frame({ armed: false }));
	assert.equal(tu.out.active, false);
	assert.deepEqual(tu.out.torque, { x: 0, y: 0, z: 0 });
});

t('reset() clears everything a respawn must not carry over', () => {
	const tu = new Turtle();
	tu.update(frame({ pressed: true }));
	tu.reset();
	assert.equal(tu.out.active, false);
	assert.equal(tu.out.eligible, false);
	assert.deepEqual(tu.out.torque, { x: 0, y: 0, z: 0 });
});

console.log(`\n${n} tests OK — turtle`);

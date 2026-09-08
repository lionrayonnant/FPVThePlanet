// Selftest for the pure chase-camera placement model (src/chase-camera.js).
// The module is Three-free and takes plain vectors, so every rule it enforces
// can be checked here without a renderer.
// Run: node tools/chase-camera-selftest.mjs
import assert from 'node:assert/strict';
import { CHASE, chaseTarget, chaseStep, headingVector } from '../src/chase-camera.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

// --- constants --------------------------------------------------------------

t('CHASE carries the D11 numbers', () => {
	assert.equal(CHASE.back, 1.1);
	assert.equal(CHASE.up, 0.45);
	assert.equal(CHASE.tau, 0.12);
	// V6: chase is an outside camera, not the video feed — the target's wide
	// FPV optics turned the machine into a mark on the sky.
	assert.equal(CHASE.fovDeg, 75);
	assert.ok(CHASE.fovDeg <= 90);
});

// --- chaseTarget ------------------------------------------------------------

t('the target sits behind the heading and above it', () => {
	for (const yaw of [0, 0.7, Math.PI / 2, 2.4, -1.1, Math.PI]) {
		const pos = { x: 3, y: 20, z: -7 };
		const c = chaseTarget(pos, yaw);
		const f = headingVector(yaw);
		const rel = { x: c.x - pos.x, y: c.y - pos.y, z: c.z - pos.z };
		// Behind: the camera-to-drone offset points against the nose.
		assert.ok(dot(rel, f) < 0, `yaw ${yaw} is not behind the heading`);
		// Above: ENU Y is up.
		assert.ok(c.y > pos.y, `yaw ${yaw} is not above the drone`);
		assert.ok(Math.abs(c.y - pos.y - CHASE.up) < 1e-9);
		// The horizontal setback is exactly CHASE.back.
		assert.ok(Math.abs(Math.hypot(rel.x, rel.z) - CHASE.back) < 1e-9);
	}
});

t('yaw 0 looks north (-Z is north in local ENU)', () => {
	const c = chaseTarget({ x: 0, y: 0, z: 0 }, 0);
	assert.ok(Math.abs(c.x) < 1e-9);
	assert.ok(Math.abs(c.z - CHASE.back) < 1e-9);   // camera is south of the drone
});

// --- chaseStep --------------------------------------------------------------

t('chaseStep with dt = 0 returns the current position untouched', () => {
	const current = { x: 1, y: 2, z: 3 };
	const out = chaseStep(current, { x: 9, y: 9, z: 9 }, 0);
	assert.deepEqual(out, current);
});

t('chaseStep converges to under 1 % of the initial gap in one second', () => {
	const desired = { x: 10, y: 4, z: -2 };
	let current = { x: 0, y: 0, z: 0 };
	const initial = dist(current, desired);
	for (let i = 0; i < 60; i++) current = chaseStep(current, desired, 1 / 60);
	assert.ok(dist(current, desired) < initial * 0.01,
		`still ${dist(current, desired).toFixed(3)} m away out of ${initial.toFixed(3)}`);
});

t('chaseStep never overshoots, whatever the frame length', () => {
	// A long frame (a stall, a tab coming back) must not throw the camera past
	// its target: the exponential blend saturates at 1.
	const desired = { x: 5, y: 5, z: 5 };
	const out = chaseStep({ x: 0, y: 0, z: 0 }, desired, 10);
	assert.ok(dist(out, desired) < 1e-6);
	for (const k of ['x', 'y', 'z']) assert.ok(out[k] <= desired[k] + 1e-9);
});

t('a larger tau is slower', () => {
	const desired = { x: 1, y: 0, z: 0 };
	const fast = chaseStep({ x: 0, y: 0, z: 0 }, desired, 1 / 60, 0.05);
	const slow = chaseStep({ x: 0, y: 0, z: 0 }, desired, 1 / 60, 0.5);
	assert.ok(fast.x > slow.x);
});

t('chaseStep is pure: it does not mutate its inputs', () => {
	const current = { x: 1, y: 1, z: 1 };
	const desired = { x: 2, y: 2, z: 2 };
	chaseStep(current, desired, 1 / 60);
	assert.deepEqual(current, { x: 1, y: 1, z: 1 });
	assert.deepEqual(desired, { x: 2, y: 2, z: 2 });
});

console.log(`chase-camera selftest: ${n} checks ok`);

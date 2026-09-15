// Simulated time must track wall-clock time, and gravity must be integrated
// over the step the caller actually asked for. Two defects made the flight
// model look broken without either one being in the flight model:
//
//   1. Physics.step(motors, dt) ignored dt for Rapier — the airframe advanced
//      by dt while gravity, velocity and contacts advanced by a fixed 1/250 s,
//      so a 1/50 s step fell at a fifth of g.
//   2. The frame loop bought at most 12 * 1/250 s = 48 ms of world per frame
//      and discarded the rest of the accumulator, so anything below ~21 fps
//      ran the whole simulation in slow motion (48 % of real time at 10 fps).
//
// Both read to a pilot as "the drone does not fall properly".
import assert from 'node:assert/strict';
import { initPhysics, Physics } from '../src/physics.js';
import { PROFILES } from '../src/drone-profiles.js';
import {
	FIXED_STEP, MAX_STEPS_PER_FRAME, MAX_CATCHUP_STEP, catchUpStep, maxFrameTime,
} from '../src/frame-pacing.js';

await initPhysics();

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

const EMPTY = { vertices: new Float32Array(0), indices: new Uint32Array(0) };
const GRAVITY = 9.81;

// A drone with its rotors stopped, far from any geometry: the only force on it
// is weight, so every reading below is gravity and nothing else. primeFor()
// leaves the props at hover rpm on construction (PHASE 13), which would hold
// the quad up for the ~50 ms of spin-down; the test is about the integrator,
// so the rotors are stopped explicitly.
// 1000 m rather than something enormous: Rapier keeps translations as f32, and
// at 1e6 m one step's v*dt falls below the ulp, so the drone reads as never
// moving at all.
// The §8.1 gravity trim is off here for the same reason the rotors are stopped:
// these tests are about the integrator honouring its dt, and the trim adds a
// deliberate 7-15% to the weight. Left on, every free-fall assertion reads
// g*trim*dt and the bench measures the force model instead of the pacing.
// src/tools/force-budget-selftest.mjs is where the trim itself is asserted.
function deadStick(profile = PROFILES.freestyle5) {
	const p = new Physics(EMPTY, { x: 0, y: 1000, z: 0 }, { profile, weather: { wind: 0 } });
	p.propulsion.omega.fill(0);
	p.propulsion.thrust.fill(0);
	p.propulsion.setGravityTrim(false);
	return p;
}

// ---------------------------------------------------------------------------
// 1. Physics.step() honours its dt

t('one step of dt integrates exactly g*dt, for every dt', () => {
	for (const dt of [1 / 250, 1 / 120, 1 / 100, 1 / 60, 1 / 50]) {
		const p = deadStick();
		p.step([0, 0, 0, 0], dt);
		const dv = p.body.linvel().y;
		const want = -GRAVITY * dt;
		assert.ok(
			Math.abs(dv - want) < 1e-6,
			`dt=${dt}: dv=${dv} want=${want} (Rapier integrated world.timestep, not dt)`,
		);
	}
});

t('the same simulated second falls the same way whatever the step size', () => {
	const fall = (dt) => {
		const p = deadStick();
		for (let i = 0; i < Math.round(1 / dt); i++) p.step([0, 0, 0, 0], dt);
		return p.body.linvel().y;
	};
	const fine = fall(1 / 250);
	for (const dt of [1 / 120, 1 / 60]) {
		// Drag makes this slightly step-dependent; 2 % is the integration error,
		// not the factor-of-five the ignored dt used to produce.
		assert.ok(
			Math.abs(fall(dt) - fine) / Math.abs(fine) < 0.02,
			`dt=${dt}: v=${fall(dt)} vs ${fine} at 1/250`,
		);
	}
});

t('a stretched step does not leave world.timestep behind for the next caller', () => {
	const p = deadStick();
	p.step([0, 0, 0, 0], 1 / 60);
	p.step([0, 0, 0, 0], FIXED_STEP);
	assert.equal(p._timestep, FIXED_STEP);
	// A dt-less call defaults to the mirrored value, so it must stay exactly on
	// the 250 Hz grid rather than on Rapier's f32 rounding of it — which is
	// what reading world.timestep back would have given.
	const p2 = deadStick();
	p2.step([0, 0, 0, 0], 1 / 60);
	p2.step([0, 0, 0, 0], FIXED_STEP);
	p2.step([0, 0, 0, 0]);
	assert.equal(p2._timestep, FIXED_STEP);
});

// ---------------------------------------------------------------------------
// 2. The frame schedule

t('a frame that is keeping up steps on the exact 250 Hz grid', () => {
	// Every backlog that MAX_STEPS_PER_FRAME steps of 1/250 s can pay off must
	// come back as FIXED_STEP itself — bit for bit, so an unstalled machine
	// flies precisely as it did before this change.
	for (const fps of [144, 120, 60, 30, 25, 21]) {
		const acc = 1 / fps;
		if (acc > MAX_STEPS_PER_FRAME * FIXED_STEP) continue;
		assert.equal(catchUpStep(acc), FIXED_STEP, `fps=${fps}`);
	}
	assert.equal(catchUpStep(0), FIXED_STEP);
	assert.equal(catchUpStep(MAX_STEPS_PER_FRAME * FIXED_STEP), FIXED_STEP);
});

t('a stretched step never exceeds the accuracy floor', () => {
	for (const acc of [0.05, 0.1, 0.2, 0.25, 1, 10]) {
		assert.ok(catchUpStep(acc) <= MAX_CATCHUP_STEP + 1e-12, `acc=${acc}`);
	}
});

t('a stretched step is never shorter than the nominal one', () => {
	for (const acc of [0.049, 0.05, 0.08, 0.2, 5]) {
		assert.ok(catchUpStep(acc) >= FIXED_STEP, `acc=${acc}`);
	}
});

t('simulated time tracks wall-clock time down to 5 fps', () => {
	// The regression itself: at 10 fps the old loop advanced the world by 48 ms
	// per 100 ms frame and dropped the remaining 52 ms. Measured over a run
	// rather than over one frame, because a single frame is allowed to leave a
	// remainder in the accumulator — that remainder being CARRIED instead of
	// discarded is the whole point.
	// Asserted rather than used to skip: without this the loop below would
	// quietly excuse every slow frame rate the moment the budget shrank, which
	// is exactly the regression it is here to catch.
	assert.ok(
		maxFrameTime() >= 0.2,
		`frame budget is only ${(maxFrameTime() * 1000).toFixed(0)} ms; 5 fps needs 200 ms`,
	);
	for (const fps of [120, 60, 30, 20, 15, 10, 6, 5]) {
		const frame = 1 / fps;
		let acc = 0, simulated = 0;
		for (let f = 0; f < Math.round(fps * 3); f++) {
			acc += frame;
			const h = catchUpStep(acc);
			let steps = 0;
			while (acc >= h - 1e-12 && steps < MAX_STEPS_PER_FRAME) { acc -= h; steps++; simulated += h; }
			if (steps === MAX_STEPS_PER_FRAME) acc = 0;
		}
		assert.ok(
			simulated / 3 > 0.99,
			`fps=${fps}: simulated ${(simulated / 3 * 100).toFixed(1)} % of the elapsed time`,
		);
	}
});

t('past the budget the excess is dropped, and the cost stays capped', () => {
	// A catastrophic stall (the 700-1700 ms streaming frames) is still
	// truncated on purpose — but it must never cost more than
	// MAX_STEPS_PER_FRAME steps, which is what stops a slow frame making the
	// next one slower.
	for (const frame of [0.3, 0.7, 1.7, 5]) {
		const h = catchUpStep(frame);
		let acc = frame, steps = 0;
		while (acc >= h - 1e-12 && steps < MAX_STEPS_PER_FRAME) { acc -= h; steps++; }
		assert.equal(steps, MAX_STEPS_PER_FRAME, `frame=${frame}`);
		assert.ok(steps * h <= maxFrameTime() + 1e-12);
	}
});

// ---------------------------------------------------------------------------
// 3. The two together: a stalling frame rate must not change how fast the
//    drone falls. This is the pilot-visible property the whole file is for.

t('free-fall distance over one simulated second is frame-rate independent', () => {
	const fallUnder = (fps) => {
		const p = deadStick();
		const frame = 1 / fps;
		let acc = 0, simulated = 0;
		const y0 = p.body.translation().y;
		// One second of WALL CLOCK at this frame rate.
		for (let f = 0; f < Math.round(fps); f++) {
			acc += frame;
			const h = catchUpStep(acc);
			let steps = 0;
			while (acc >= h - 1e-12 && steps < MAX_STEPS_PER_FRAME) {
				p.step([0, 0, 0, 0], h);
				acc -= h; steps++; simulated += h;
			}
			if (steps === MAX_STEPS_PER_FRAME) acc = 0;
		}
		return { drop: y0 - p.body.translation().y, simulated };
	};
	const ref = fallUnder(250);
	for (const fps of [60, 30, 15, 10, 6]) {
		const got = fallUnder(fps);
		assert.ok(
			Math.abs(got.simulated - 1) < 0.02,
			`fps=${fps}: only ${got.simulated.toFixed(3)} s of world for 1 s of wall clock`,
		);
		assert.ok(
			Math.abs(got.drop - ref.drop) / ref.drop < 0.05,
			`fps=${fps}: fell ${got.drop.toFixed(2)} m against ${ref.drop.toFixed(2)} m at 250 fps`,
		);
	}
});

console.log(`frame-pacing-selftest : ${n} tests ok`);

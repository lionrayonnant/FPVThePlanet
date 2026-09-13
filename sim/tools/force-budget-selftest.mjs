// The vertical force budget (src/physics.js) must ACCOUNT for the force, not
// approximate it: the thrust split quad.js reports has to sum back to the
// force it actually applied, or the budget is telling a story rather than
// measuring one. Structural checks only — no recorded numbers.
import assert from 'node:assert/strict';
import { initPhysics, Physics } from '../src/physics.js';
import { PROFILES, FAMILIES } from '../src/drone-profiles.js';
import { FlightController, hoverThrottle } from '../src/flightController.js';

await initPhysics();
let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };
const EMPTY = { vertices: new Float32Array(0), indices: new Uint32Array(0) };
const DT = 1 / 250;
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };

function fly(profile, { throttle, pitch = 0, seconds, weather = { wind: 0 } }) {
	const p = new Physics(EMPTY, { x: 0, y: 4000, z: 0 }, { profile, weather });
	const c = new FlightController({ profile });
	c.armed = true;
	p.beginForceBudget();
	for (let i = 0; i < 250 * seconds; i++) {
		const th = throttle ?? hoverThrottle(profile, IDENTITY, p.propulsion.battery.voltage);
		const { motors } = c.update({ throttle: th, roll: 0, pitch, yaw: 0 }, p, DT);
		p.step(motors, DT);
	}
	return p.forceBudget();
}

t('the thrust split accounts for the thrust exactly, every family', () => {
	for (const fam of FAMILIES) {
		for (const flight of [{ seconds: 3 }, { throttle: 1, seconds: 3 }, { throttle: 0, seconds: 4 }]) {
			const b = fly(PROFILES[fam], flight);
			assert.ok(
				Math.abs(b.residual) < 1e-9,
				`${fam} ${JSON.stringify(flight)}: residual ${b.residual}`,
			);
		}
	}
});

t('a hover is thrust carrying essentially the whole weight', () => {
	const b = fly(PROFILES.freestyle5, { seconds: 4 });
	assert.ok(Math.abs(b.thrustUp - 1) < 0.05, `thrustUp ${b.thrustUp}`);
	assert.ok(Math.abs(b.meanTiltDeg) < 1, `tilt ${b.meanTiltDeg}`);
	// Still air, far from the ground: nothing else should be carrying anything.
	assert.ok(Math.abs(b.bodyDragUp) < 0.02, `bodyDragUp ${b.bodyDragUp}`);
	assert.ok(b.ofWhich.groundEffect === 0, `groundEffect ${b.ofWhich.groundEffect}`);
	assert.ok(b.ofWhich.vortexRing === 0, `vortexRing ${b.ofWhich.vortexRing}`);
});

t('a throttle chop shows drag, not thrust, doing the carrying', () => {
	const b = fly(PROFILES.freestyle5, { throttle: 0, seconds: 5 });
	assert.ok(b.bodyDragUp > 0.3, `bodyDragUp ${b.bodyDragUp}`);
	assert.ok(b.thrustUp < 0.6, `thrustUp ${b.thrustUp}`);
});

t('meanVerticalSpeed is a speed, and matches the body it was read from', () => {
	// It shipped named meanVerticalAccel while accumulating linvel().y. Pinned
	// against a climb whose speed is known independently.
	const p = new Physics(EMPTY, { x: 0, y: 4000, z: 0 }, { profile: PROFILES.freestyle5, weather: { wind: 0 } });
	const c = new FlightController({ profile: PROFILES.freestyle5 });
	c.armed = true;
	// Settle at full throttle first, so the window averages a steady climb.
	for (let i = 0; i < 250 * 8; i++) {
		const { motors } = c.update({ throttle: 1, roll: 0, pitch: 0, yaw: 0 }, p, DT);
		p.step(motors, DT);
	}
	p.beginForceBudget();
	for (let i = 0; i < 250 * 2; i++) {
		const { motors } = c.update({ throttle: 1, roll: 0, pitch: 0, yaw: 0 }, p, DT);
		p.step(motors, DT);
	}
	const b = p.forceBudget();
	assert.ok(
		Math.abs(b.meanVerticalSpeed - p.body.linvel().y) < 0.5,
		`budget ${b.meanVerticalSpeed} vs body ${p.body.linvel().y}`,
	);
	assert.ok(b.meanVerticalSpeed > 20, `a full-throttle climb should be fast: ${b.meanVerticalSpeed}`);
});

t('the budget reads back once and then stops', () => {
	const p = new Physics(EMPTY, { x: 0, y: 4000, z: 0 }, { profile: PROFILES.freestyle5 });
	assert.equal(p.forceBudget(), null, 'a budget never begun reads null');
	p.beginForceBudget();
	for (let i = 0; i < 10; i++) p.step([0, 0, 0, 0], DT);
	assert.ok(p.forceBudget() !== null);
	assert.equal(p.forceBudget(), null, 'reading it back ends it');
});

console.log(`force-budget-selftest : ${n} tests ok`);

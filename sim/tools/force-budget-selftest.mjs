// The vertical force budget (src/physics.js) must ACCOUNT for the force, not
// approximate it: the thrust split quad.js reports has to sum back to the
// force it actually applied, or the budget is telling a story rather than
// measuring one. Structural checks only — no recorded numbers.
import assert from 'node:assert/strict';
import { initPhysics, Physics } from '../src/physics.js';
import { PROFILES, FAMILIES } from '../src/drone-profiles.js';
import { FlightController, hoverThrottle } from '../src/flightController.js';
import { GRAVITY, gravityTrimFactor, Propulsion } from '../src/quad.js';

await initPhysics();
let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };
const EMPTY = { vertices: new Float32Array(0), indices: new Uint32Array(0) };
const DT = 1 / 250;
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };

// `gravityTrim` defaults to OFF here. Every check that was in this file before
// L5 is a statement about the THRUST model, and modulated gravity (spec 8.1)
// is not part of it: leaving it on would make those checks measure two things
// at once. The section that tests the trim turns it on explicitly.
function fly(profile, { throttle, pitch = 0, seconds, weather = { wind: 0 }, gravityTrim = false }) {
	const p = new Physics(EMPTY, { x: 0, y: 4000, z: 0 }, { profile, weather });
	p.propulsion.setGravityTrim(gravityTrim);
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
		for (const flight of [
			{ seconds: 3 }, { throttle: 1, seconds: 3 }, { throttle: 0, seconds: 4 },
			// With the trim on too: it must not leak into the thrust split.
			{ seconds: 3, gravityTrim: true }, { throttle: 0, seconds: 4, gravityTrim: true },
		]) {
			const b = fly(PROFILES[fam], flight);
			assert.ok(
				Math.abs(b.residual) < 1e-9,
				`${fam} ${JSON.stringify(flight)}: residual ${b.residual}`,
			);
		}
	}
});

// The Physics-level sweep above flies over an EMPTY collider, so `agl` is null
// and ground effect never switches on. That is how the split could be wrong
// near the ground for as long as it was: the invariant was only ever measured
// where one of its four terms was zero. This one drives the rotor model
// directly, at the one state where both corrections are live at once.
t('the split still accounts for the thrust with ground effect AND propwash on', () => {
	for (const fam of FAMILIES) {
		const profile = PROFILES[fam];
		const prop = new Propulsion({ profile });
		const motors = [0.5, 0.5, 0.5, 0.5];
		let worst = 0;
		// Settle the motors, then drop it onto the ground: descending fast enough
		// to be in the vortex-ring band, close enough for the surface to push back.
		for (let i = 0; i < 400; i++) {
			const settled = i > 200;
			prop.step(motors, {
				v: { x: 0, y: settled ? -4 : 0, z: 0 },
				agl: settled ? 0.05 : null,
			}, DT);
			if (!settled) continue;
			const d = prop.diag;
			worst = Math.max(worst, Math.abs(d.staticThrust + d.inflow + d.groundEffect - d.vortexRing - d.thrust));
		}
		// The state has to be the one being tested, or the check passes vacuously.
		assert.ok(prop.propwash > 0, `${fam}: no propwash, nothing was tested`);
		assert.ok(prop.diag.groundEffect > 0, `${fam}: no ground effect, nothing was tested`);
		assert.ok(worst < 1e-9, `${fam}: residual ${worst} N`);
	}
});

t('a hover is thrust carrying essentially the whole weight', () => {
	const b = fly(PROFILES.freestyle5, { seconds: 4 });
	// The whole weight INCLUDING the §8.1 trim: hoverThrottle() now solves for
	// `mass * g * trim`, because the trim is a real world -Y force and a hover
	// has to cancel it too. So the budget reads the trim factor here, not 1 --
	// reading 1 would mean the hover command had stopped seeing the trim and the
	// altitude hold was quietly sinking.
	const want = gravityTrimFactor(PROFILES.freestyle5, 0);
	assert.ok(Math.abs(b.thrustUp - want) < 0.05, `thrustUp ${b.thrustUp} want ~${want}`);
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

// ---------------------------------------------------------------------------
// Modulated gravity (spec 8.1). It is a FORCE, not a change to the solver's g,
// and these checks are what make that distinction observable.

t('the trim has its own budget post, and nothing else moved into it', () => {
	const off = fly(PROFILES.freestyle5, { seconds: 3 });
	assert.equal(off.gravityTrimUp, 0, 'switched off it must be exactly zero');
	const on = fly(PROFILES.freestyle5, { seconds: 3, gravityTrim: true });
	assert.ok(on.gravityTrimUp < 0, `it pulls DOWN: ${on.gravityTrimUp}`);
	// The post is a fraction of nominal weight, and at the small vertical
	// speeds of a 3 s hover hold it must sit close to the formula's own value
	// at zero vertical speed. Compared against gravityTrimFactor, which shares
	// no code with the budget accumulator.
	const want = 1 - gravityTrimFactor(PROFILES.freestyle5, 0);
	assert.ok(
		Math.abs(on.gravityTrimUp - want) < 0.03,
		`budget ${on.gravityTrimUp} vs formula ${want.toFixed(4)}`,
	);
	// And the thrust split still accounts for the thrust exactly: the trim adds
	// no thrust component, so the invariant cannot have been touched.
	assert.ok(Math.abs(on.residual) < 1e-9, `residual ${on.residual}`);
});

t('the trim lands on the body as real weight, every family', () => {
	// The strong check: motors cut, from rest, in a vacuum of other forces, the
	// downward acceleration must be g x the trim factor. Read off the body's
	// own velocity, which knows nothing about quad.js's arithmetic. If the trim
	// had been implemented by changing Rapier's gravity this would still pass —
	// which is why the budget check above exists too.
	for (const fam of FAMILIES) {
		const profile = PROFILES[fam];
		for (const trim of [false, true]) {
			const p = new Physics(EMPTY, { x: 0, y: 4000, z: 0 }, { profile, weather: { wind: 0 } });
			p.propulsion.setGravityTrim(trim);
			// The constructor primes the motors at the hover stick so a drone
			// that spawns in flight does not show stopped props, so spin them
			// down first: a decaying thrust would be measured as anti-gravity.
			for (let i = 0; i < 500; i++) p.step([0, 0, 0, 0], DT);
			p.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
			// Ten steps only: long enough to measure, short enough that drag at
			// 0.4 m/s is still orders of magnitude below the weight.
			const steps = 10;
			for (let i = 0; i < steps; i++) p.step([0, 0, 0, 0], DT);
			const a = p.body.linvel().y / (steps * DT);
			// Against the factor at ZERO vertical speed, while the ten steps
			// reach -0.4 m/s: 8.1 fades the trim out with speed, so the mean
			// sits a few hundredths below the at-rest value. The tolerance is
			// that fade, not slop — at 0.05 it is still four times tighter than
			// the smallest trim any family has.
			const want = -GRAVITY * (trim ? gravityTrimFactor(profile, 0) : 1);
			assert.ok(
				Math.abs(a - want) < 0.05,
				`${fam} trim=${trim}: ${a.toFixed(4)} m/s^2, expected ${want.toFixed(4)}`,
			);
		}
	}
});

t('Rapier keeps the one true g: the trim is gone in a fast descent', () => {
	// 8.1 returns the multiplier to exactly 1.0 below its own `b`. Measured at
	// a vertical speed past every family's b (-8 to -13.9 m/s) by driving the
	// body straight down, so the only thing left holding it is plain gravity.
	for (const fam of FAMILIES) {
		const profile = PROFILES[fam];
		const p = new Physics(EMPTY, { x: 0, y: 4000, z: 0 }, { profile, weather: { wind: 0 } });
		p.propulsion.setGravityTrim(true);
		p.body.setLinvel({ x: 0, y: -25, z: 0 }, true);
		p.step([0, 0, 0, 0], DT);
		assert.equal(
			p.propulsion.extraGravity, 0,
			`${fam}: still trimming at -25 m/s (${p.propulsion.extraGravity})`,
		);
	}
});

t('the hover command carries the trim: it holds with it, and over-lifts without', () => {
	// hoverThrottle() solves for mass*g*trim (src/flightController.js), so the
	// command that hovers is the TRIMMED one. Both directions are asserted,
	// because each catches a different way of breaking the stitch: with the trim
	// on the machine must hold, and with the trim off that same command is now
	// too much thrust and must climb. Test the first alone and a hoverThrottle()
	// that had silently dropped the trim would still pass.
	const on = fly(PROFILES.freestyle5, { seconds: 4, gravityTrim: true });
	const off = fly(PROFILES.freestyle5, { seconds: 4 });
	assert.ok(Math.abs(on.meanVerticalSpeed) < 0.15, `on: ${on.meanVerticalSpeed}`);
	assert.ok(off.meanVerticalSpeed > 0.5, `off: ${off.meanVerticalSpeed}`);
});

console.log(`force-budget-selftest : ${n} tests ok`);

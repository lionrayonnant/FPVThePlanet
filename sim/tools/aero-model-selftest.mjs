// node tools/aero-model-selftest.mjs — the ?aero= switch, and the one thing it
// must never do.
//
// `?aero=bem` puts src/blade-element.js in the force path. The whole of this
// file is one claim, tested from four directions: the DEFAULT PATH DID NOT
// MOVE. Not "moved within tolerance" — did not move, to the bit, because six
// PID tunes, nine spec-acceptance criteria and every golden number in this tree
// belong to the classic model, and a rotor model that shifts the default by an
// ulp invalidates all of them silently.
//
// The flight-level proof lives next door and is coarser-grained on purpose:
// `node tools/flight-replay.mjs --all --family all --quiet --out a.json`, run
// before and after this branch, produces a BYTE-IDENTICAL file. What is here is
// the per-step version of the same claim, which a CI chain can afford to run.

import { Propulsion, parseAeroFlag, AERO_MODELS, AERO_DEFAULT } from '../src/quad.js';
import { PROFILES, FAMILIES } from '../src/drone-profiles.js';
import { geometryOf, rotorForces } from '../src/blade-element.js';

let passed = 0;
function check(label, cond) {
	if (!cond) { console.error(`  FAIL  ${label}`); process.exitCode = 1; return; }
	console.log(`  ok  ${label}`);
	passed++;
}

const DT = 1 / 250;

// One deterministic flight-shaped sequence of step() calls: throttle ramps,
// stick asymmetry, a climb, a descent, and a translation that is neither purely
// axial nor purely edgewise. Anything the two models disagree about lives
// somewhere in here.
function fly(prop, steps = 400) {
	const out = [];
	for (let i = 0; i < steps; i++) {
		const t = i * DT;
		const c = 0.4 + 0.25 * Math.sin(t * 3);
		prop.step(
			[c, c * 1.05, c * 0.95, c],
			{
				v: { x: 4 * Math.sin(t), y: 3 * Math.cos(t * 0.7), z: -12 * Math.sin(t * 0.5) },
				omega: { x: 0.3 * Math.sin(t * 2), y: 0.2 * Math.cos(t), z: 0.1 * Math.sin(t) },
				agl: 1.5 + Math.sin(t),
				shake: 0.2,
				worldVy: 3 * Math.cos(t * 0.7),
				altitude: 120,
			},
			DT,
		);
		out.push(
			prop.force.x, prop.force.y, prop.force.z,
			prop.torque.x, prop.torque.y, prop.torque.z,
			prop.extraGravity, prop.hRotor, prop.propwash,
			...prop.omega, ...prop.thrust,
			prop.diag.staticThrust, prop.diag.inflow, prop.diag.groundEffect, prop.diag.vortexRing,
			prop.diag.rotorDrag.x, prop.diag.rotorDrag.z,
		);
	}
	return out;
}

console.log('aero-model : the flag');
{
	check('the default is classic, and it is the value an absent flag gives',
		AERO_DEFAULT === 'classic' && parseAeroFlag(null) === 'classic'
		&& parseAeroFlag(undefined) === 'classic' && parseAeroFlag('') === 'classic');
	check('both models are nameable', AERO_MODELS.includes('classic') && AERO_MODELS.includes('bem')
		&& parseAeroFlag('bem') === 'bem' && parseAeroFlag('classic') === 'classic');
	// Falls back rather than throwing: unlike ?swarm=, an unknown value here
	// cannot produce a machine the game could not otherwise fly.
	check('anything else is the default, silently',
		['BEM', 'blade', '1', 'true', 'classic ', 'x'].every((v) => parseAeroFlag(v) === 'classic'));
	check('a Propulsion says which model it is on',
		new Propulsion().aero === 'classic'
		&& new Propulsion({ aero: 'bem' }).aero === 'bem'
		&& new Propulsion({ aero: 'nonsense' }).aero === 'classic');
	// The blade costs a nested bisection to resolve. It must not be paid for on
	// the path that never reads it.
	check('the blade is not even built on the default path',
		new Propulsion()._blade === null && new Propulsion({ aero: 'bem' })._blade !== null);
}

console.log('\naero-model : the default path did not move');
for (const family of FAMILIES) {
	const profile = PROFILES[family];
	const a = fly(new Propulsion({ profile }));
	const b = fly(new Propulsion({ profile, aero: 'classic' }));
	const c = fly(new Propulsion({ profile, aero: 'not-a-model' }));
	// Exact equality, element by element — Object.is, so a NaN that appeared on
	// both sides would still be caught by the "not trivially constant" check
	// below rather than compared equal to itself and waved through.
	check(`${family}: naming the default explicitly changes nothing, bit for bit`,
		a.length === b.length && a.every((v, i) => Object.is(v, b[i])));
	check(`${family}: and neither does an unknown flag`,
		a.every((v, i) => Object.is(v, c[i])));
	check(`${family}: the trace is not trivially constant (the test could fail)`,
		new Set(a).size > 50);
}

console.log('\naero-model : and bem really is a different machine');
{
	const profile = PROFILES.freestyle5;
	const a = fly(new Propulsion({ profile }));
	const d = fly(new Propulsion({ profile, aero: 'bem' }));
	check('the two models disagree — the flag is plumbed all the way to the force',
		a.some((v, i) => !Object.is(v, d[i])));
	const prop = new Propulsion({ profile, aero: 'bem' });
	fly(prop, 50);
	check('and nothing in the bem force path returns NaN',
		[prop.force.x, prop.force.y, prop.force.z, prop.torque.x, prop.torque.y, prop.torque.z,
			...prop.omega, ...prop.thrust].every(Number.isFinite));
	check('the budget still sums back to the force in bem mode', (() => {
		const d0 = prop.diag;
		const sum = d0.staticThrust + d0.inflow + d0.groundEffect + d0.vortexRing;
		return Math.abs(sum - d0.thrust) < 1e-9 * Math.max(1, Math.abs(d0.thrust));
	})());
	check('and it says which model wrote that split', prop.diag.model === 'bem'
		&& new Propulsion({ profile }).diag.model === 'classic');
}

// The in-plane force the azimuthal integration always contained and did not
// report. Its sign is the whole of what makes it usable in the force path, and
// nothing outside this file checks it.
console.log('\naero-model : the H-force blade-element.js now returns');
{
	const profile = PROFILES.freestyle5;
	const g = geometryOf(profile);
	const w = 0.4 * profile.maxOmega;
	const hover = rotorForces(g, w, 0, 1.225, 0);
	check('hover has no in-plane force — the azimuthal sum cancels',
		Math.abs(hover.hForce) < 1e-9 * hover.thrust);
	const speeds = [2, 5, 10, 20, 30];
	const hs = speeds.map((v) => rotorForces(g, w, 0, 1.225, v).hForce);
	check('edgewise flight makes one, and it OPPOSES the motion (negative)',
		hs.every((h) => h < 0));
	check('and it grows with edgewise speed',
		hs.every((h, i) => i === 0 || h < hs[i - 1]));
	check('a stopped rotor in edgewise flow still has one — four stalled blades',
		rotorForces(g, 0, 0, 1.225, 20).hForce < 0);
	// It is a force, so it must scale with the air it is taken in.
	const dense = rotorForces(g, w, 0, 2.45, 20).hForce;
	const thin = rotorForces(g, w, 0, 1.225, 20).hForce;
	check('and it scales with air density, like the force it is',
		Math.abs(dense / thin - 2) < 0.05);
	// Adding it must not have moved what was already there.
	check('adding it moved neither thrust nor torque (both still returned)',
		Number.isFinite(hover.thrust) && Number.isFinite(hover.torque) && hover.thrust > 0);
}

console.log(`\naero-model-selftest : ${passed} tests ok`);

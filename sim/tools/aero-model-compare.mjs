// node tools/aero-model-compare.mjs — the two rotor models, side by side.
//
// WHY THIS EXISTS. `?aero=bem` swaps the classic kThrust*omega^2 rotor for
// src/blade-element.js, and the one term that swap turns on — everything
// edgewise — is the one term no bench in this repo can VERIFY. The UIUC tunnel
// blows along the shaft; it says nothing about a rotor flying sideways, and
// sim/docs/PICKUP.md has been saying so since the blade-element model landed.
//
// So this does not assert that the blade is right. It makes the difference
// OBSERVABLE: for every family, what each model returns for thrust, torque and
// in-plane force over a sweep from hover to cruise, and the signed gap between
// them. A term that cannot be checked against measurement can at least be
// checked against the model it replaces, at every operating point a pilot
// flies through, with the sign written down.
//
// It is a reader of the flight stack. Nothing here writes into src/, and
// nothing here is a target: the numbers below are a description of two models
// disagreeing, not a statement that either one is the correct one.
//
// Usage:
//   node tools/aero-model-compare.mjs                  # sweeps + replay diff
//   node tools/aero-model-compare.mjs --no-replay      # sweeps + #103 gate only
//   node tools/aero-model-compare.mjs --no-replay --no-gate   # sweeps only
//   node tools/aero-model-compare.mjs --family race5
//   node tools/aero-model-compare.mjs --replay-family all

import { initPhysics } from '../src/physics.js';
import { PROFILES, FAMILIES, DEFAULT_FAMILY } from '../src/drone-profiles.js';
import {
	kThrustOf, kInflowOf, kLateralOf, vhPerOmegaOf, cruiseSpeedOf,
	hoverThrust, omegaForThrust, inducedVelocity, Propulsion,
} from '../src/quad.js';
import { propLossFactor } from '../src/motor.js';
import { geometryOf, rotorForces } from '../src/blade-element.js';
import { SEQUENCE_NAMES, replay, diffRuns, renderDiff } from './flight-replay.mjs';
import { airDensity } from '../src/air.js';
import { FlightController, RATE_PRESETS } from '../src/flightController.js';

const RHO = airDensity(0);

// One rotor, the classic way: src/quad.js's own arithmetic, lifted out of the
// per-motor loop and given the same three inputs blade-element.js takes. Kept
// as a transcription rather than an import because quad.js computes it inside a
// loop over four motors with ground effect and propwash already folded in, and
// what is wanted here is the ROTOR, bare.
//
// `vAxial` is deliberately 0 in every sweep below, so the axial clamp
// (AXIAL_INFLOW_LIMIT, which quad.js does not export) never bites and the two
// models are compared on the one axis this branch exists for.
function classicRotor(profile, k, omega, vAxial, vEdge) {
	const loss = propLossFactor(profile, omega);
	const vh = omega * k.vhPerOmega * Math.sqrt(loss);
	const dw = vAxial + 2 * (inducedVelocity(vh, vEdge * vEdge) - vh);
	const thrust = Math.max(0, k.kThrust * loss * omega * omega - k.kInflow * omega * dw);
	return {
		thrust,
		// The classic model does not predict a torque: it asserts one, from the
		// family's measured `torqueRatio`. That is exactly what makes the
		// blade's torque a PREDICTION and worth printing next to it.
		torque: profile.torqueRatio * thrust,
		// And its in-plane force is `kLateral`, fitted to observed behaviour and
		// carrying the flapback lumped inside it (see quad.js, above
		// cruiseSpeedOf). Signed like the blade's: negative opposes the motion.
		hForce: -k.kLateral * omega * vEdge,
	};
}

function pct(a, b) {
	if (!Number.isFinite(a) || !Number.isFinite(b)) return '     n/a';
	if (Math.abs(a) < 1e-12) return Math.abs(b) < 1e-12 ? '    0.0%' : '       -';
	return `${(((b - a) / Math.abs(a)) * 100).toFixed(1).padStart(7)}%`;
}

function fixed(v, w, d) { return v.toFixed(d).padStart(w); }

// The sweep, for one family.
//
// Two sweeps, because the models disagree for two separate reasons and mixing
// them would hide both.
//
//   1. AXIAL, rpm from idle to full in still air. This is where the classic
//      model's `propLossFactor` lives and the blade's calibration anchor sits.
//      The two are pinned together at maxOmega BY CONSTRUCTION (geometryOf
//      solves the chord so the blade makes `maxThrustPerMotor` there), so
//      everything this sweep shows below full throttle is the shape of the
//      curve, which is not anchored at all — and which is what decides where
//      the hover stick lands.
//
//   2. EDGEWISE, rpm held at hover, speed from 0 to twice the family's own
//      cruise. This is the term `?aero=bem` exists for and the term nothing
//      here can verify.
function sweepFamily(family) {
	const profile = PROFILES[family];
	const k = {
		kThrust: kThrustOf(profile),
		kInflow: kInflowOf(profile),
		kLateral: kLateralOf(profile),
		vhPerOmega: vhPerOmegaOf(profile),
	};
	const g = geometryOf(profile);
	const wHover = omegaForThrust(profile, hoverThrust(profile) / 4);
	const cruise = cruiseSpeedOf(profile);

	const rpm = (w) => (w * 60) / (2 * Math.PI);
	console.log(`\n=== ${family} — ${profile.label}`);
	console.log(`    hover ${rpm(wHover).toFixed(0)} rpm (${((100 * wHover) / profile.maxOmega).toFixed(0)}% of max), `
		+ `cruise ${cruise.toFixed(1)} m/s, one rotor holds ${(hoverThrust(profile) / 4).toFixed(2)} N at hover`);

	console.log('\n    1. AXIAL, still air — thrust and torque against rpm');
	console.log('       rpm    %max    T classic      T bem     dT        Q classic      Q bem     dQ');
	for (const frac of [0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0]) {
		const w = frac * profile.maxOmega;
		const a = classicRotor(profile, k, w, 0, 0);
		const b = rotorForces(g, w, 0, RHO, 0);
		console.log(`    ${fixed(rpm(w), 6, 0)}  ${fixed(100 * frac, 5, 0)}%  `
			+ `${fixed(a.thrust, 10, 3)} ${fixed(b.thrust, 10, 3)} ${pct(a.thrust, b.thrust)}   `
			+ `${fixed(a.torque, 10, 4)} ${fixed(b.torque, 10, 4)} ${pct(a.torque, b.torque)}`);
	}
	// The hover point on its own line: it is the one operating point the whole
	// flight model is arranged around, and the gap there is the gap that
	// decides whether the machine holds altitude at the stick the controller
	// computes from the CLASSIC model.
	{
		const a = classicRotor(profile, k, wHover, 0, 0);
		const b = rotorForces(g, wHover, 0, RHO, 0);
		console.log(`    ${fixed(rpm(wHover), 6, 0)}  hover  `
			+ `${fixed(a.thrust, 10, 3)} ${fixed(b.thrust, 10, 3)} ${pct(a.thrust, b.thrust)}   `
			+ `${fixed(a.torque, 10, 4)} ${fixed(b.torque, 10, 4)} ${pct(a.torque, b.torque)}`);
	}

	console.log('\n    2. EDGEWISE at hover rpm — thrust and in-plane force against airspeed');
	console.log('       V m/s    T classic      T bem     dT        H classic      H bem     dH');
	const speeds = [0, 0.25, 0.5, 0.75, 1, 1.5, 2].map((f) => f * cruise);
	const rows = [];
	for (const v of speeds) {
		const a = classicRotor(profile, k, wHover, 0, v);
		const b = rotorForces(g, wHover, 0, RHO, v);
		rows.push({ v, a, b });
		console.log(`    ${fixed(v, 7, 1)}  ${fixed(a.thrust, 10, 3)} ${fixed(b.thrust, 10, 3)} ${pct(a.thrust, b.thrust)}   `
			+ `${fixed(a.hForce, 10, 3)} ${fixed(b.hForce, 10, 3)} ${pct(a.hForce, b.hForce)}`);
	}
	return { family, wHover, cruise, rows };
}

async function replayDiff(families) {
	console.log('\n\n=== replay --diff: classic against bem, six sequences');
	console.log('    Same sticks, same seeds, same Rapier. The sticks are NOT re-tuned and');
	console.log('    the "hover" keyframe is resolved through hoverThrottle(), which is the');
	console.log('    CLASSIC model — so a thrust gap at hover rpm shows up here as an');
	console.log('    altitude the machine simply does not hold. That is a property of the');
	console.log('    comparison, not a crash.');
	await initPhysics();
	for (const family of families) {
		const a = [];
		const b = [];
		for (const name of SEQUENCE_NAMES) {
			a.push(replay(name, { family, aero: 'classic' }));
			b.push(replay(name, { family, aero: 'bem' }));
		}
		console.log(`\n--- ${family}`);
		for (const d of diffRuns({ traces: a }, { traces: b })) {
			console.log(renderDiff(d));
			console.log('');
		}
	}
}

// ---------------------------------------------------------------------------
// THE #103 GATE, RUN AGAINST BOTH MODELS.
//
// Translational rotor moments went in once (#91) and came out again (#103)
// because, flown, they made the airframe unusable: everything they added
// scales with airspeed and acts across pitch and roll, so a held roll or yaw at
// twice cruise speed swept an oscillation through the body axes that a rate
// loop cannot reject. Measured then: 1-2 deg/s of off-axis rate before, 115-222
// deg/s after.
//
// `?aero=bem` turns the same PHYSICAL mechanism back on — the dissymmetry of
// lift in edgewise flight — so the question "does bem bring the defect back"
// has to be asked in the same terms, not argued about. This is section 4 of
// tools/aero-selftest.mjs, transcribed rather than imported (importing a
// selftest runs it) and parameterised by the rotor model.
//
// What differs from #91 is WHERE the mechanism is applied: bem returns the
// in-plane FORCE and no moment, and quad.js puts it at the hub, exactly where
// `kLateral` already acted. The moments #103 removed — the rigid hub moment,
// and the lever of the discs sitting above the centre of mass — are not back.
const ALPHA = (35 * Math.PI) / 180;
const SPEED_FACTOR = 2;
const DT = 1 / 250;

function rotate(q, v) {
	const { x, y, z, w } = q;
	const tx = 2 * (y * v.z - z * v.y), ty = 2 * (z * v.x - x * v.z), tz = 2 * (x * v.y - y * v.x);
	return {
		x: v.x + w * tx + (y * tz - z * ty),
		y: v.y + w * ty + (z * tx - x * tz),
		z: v.z + w * tz + (x * ty - y * tx),
	};
}
const unrotate = (q, v) => rotate({ x: -q.x, y: -q.y, z: -q.z, w: q.w }, v);
function integrateQ(q, w, dt) {
	const h = dt / 2;
	return {
		x: q.x + h * (w.x * q.w + w.y * q.z - w.z * q.y),
		y: q.y + h * (w.y * q.w + w.z * q.x - w.x * q.z),
		z: q.z + h * (w.z * q.w + w.x * q.y - w.y * q.x),
		w: q.w - h * (w.x * q.x + w.y * q.y + w.z * q.z),
	};
}
function normalizeQ(q) {
	const n = Math.hypot(q.x, q.y, q.z, q.w);
	return { x: q.x / n, y: q.y / n, z: q.z / n, w: q.w / n };
}

function heldAtSpeed(profile, aero, sticks, seconds = 4) {
	const fc = new FlightController({ profile });
	const prop = new Propulsion({ profile, seed: 3, aero });
	const I = profile.inertia;
	const V = SPEED_FACTOR * cruiseSpeedOf(profile);
	let q = { x: Math.sin(-ALPHA / 2), y: 0, z: 0, w: Math.cos(-ALPHA / 2) };
	let w = { x: 0, y: 0, z: 0 };
	const peak = { x: 0, y: 0, z: 0 };
	const steps = Math.round(seconds / DT);
	for (let i = 0; i < steps; i++) {
		const vBody = unrotate(q, { x: 0, y: 0, z: -V });
		const state = { rotation: q, angularVelocity: rotate(q, w), position: { x: 0, y: 100, z: 0 }, velocity: { x: 0, y: 0, z: -V } };
		const { motors } = fc.update(sticks, state, DT);
		const { torque } = prop.step(motors, { v: vBody, omega: w, agl: null, shake: 0 }, DT);
		const Iw = { x: I.x * w.x, y: I.y * w.y, z: I.z * w.z };
		const gyro = {
			x: w.y * Iw.z - w.z * Iw.y,
			y: w.z * Iw.x - w.x * Iw.z,
			z: w.x * Iw.y - w.y * Iw.x,
		};
		w = {
			x: w.x + ((torque.x - gyro.x) / I.x) * DT,
			y: w.y + ((torque.y - gyro.y) / I.y) * DT,
			z: w.z + ((torque.z - gyro.z) / I.z) * DT,
		};
		q = normalizeQ(integrateQ(q, w, DT));
		if (i * DT > 0.5) {
			peak.x = Math.max(peak.x, Math.abs(w.x));
			peak.y = Math.max(peak.y, Math.abs(w.y));
			peak.z = Math.max(peak.z, Math.abs(w.z));
		}
	}
	return { peak, V };
}

function offAxisGate(families) {
	console.log('\n\n=== the #103 gate, both models — off-axis rate under a held input at 2x cruise');
	console.log('    The limit aero-selftest.mjs holds the default to is 25% of the commanded rate.');
	console.log('    #91 read 115-222 deg/s here; the model it replaced read 1-2.');
	const deg = (r) => (r * 180) / Math.PI;
	for (const input of [
		{ name: 'full roll', sticks: { throttle: 0.5, roll: 1, pitch: 0, yaw: 0 }, axes: ['x', 'y'], rate: 'roll' },
		{ name: 'full yaw ', sticks: { throttle: 0.5, roll: 0, pitch: 0, yaw: 1 }, axes: ['x', 'z'], rate: 'yaw' },
	]) {
		console.log(`\n    ${input.name} held:`);
		console.log('       family        V m/s   off-axis classic      off-axis bem');
		for (const family of families) {
			const profile = PROFILES[family];
			const commanded = (RATE_PRESETS[profile.rates][input.rate].max * Math.PI) / 180;
			const a = heldAtSpeed(profile, 'classic', input.sticks);
			const b = heldAtSpeed(profile, 'bem', input.sticks);
			const pa = Math.max(...input.axes.map((k) => a.peak[k]));
			const pb = Math.max(...input.axes.map((k) => b.peak[k]));
			console.log(`    ${family.padEnd(12)} ${a.V.toFixed(0).padStart(5)}   `
				+ `${deg(pa).toFixed(1).padStart(7)} deg/s ${((100 * pa) / commanded).toFixed(1).padStart(6)}%   `
				+ `${deg(pb).toFixed(1).padStart(7)} deg/s ${((100 * pb) / commanded).toFixed(1).padStart(6)}%`);
		}
	}
}

async function main(argv) {
	const args = argv.slice(2);
	const value = (name, def) => {
		const i = args.indexOf(name);
		return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
	};
	const familyArg = value('--family', 'all');
	const families = familyArg === 'all' ? FAMILIES : [familyArg];
	for (const f of families) {
		if (!PROFILES[f]) throw new Error(`unknown family "${f}" — ${FAMILIES.join(', ')}`);
	}

	console.log('aero-model-compare — classic (kThrust*w^2 + inflow slope) against bem (blade element)');
	console.log(`air density ${RHO} kg/m3, sea level, still air`);
	console.log('dT/dQ/dH are SIGNED: positive means the blade returns MORE than the classic model.');

	for (const f of families) sweepFamily(f);

	if (!args.includes('--no-gate')) offAxisGate(families);

	if (!args.includes('--no-replay')) {
		const rf = value('--replay-family', DEFAULT_FAMILY);
		await replayDiff(rf === 'all' ? FAMILIES : [rf]);
	}
	return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	process.exit(await main(process.argv));
}

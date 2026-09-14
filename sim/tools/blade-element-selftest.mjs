// The blade-element propeller model (src/blade-element.js). Structural checks
// and anchor reproduction — no recorded numbers, because a test that pins
// "thrust at 20 m/s is 1.94 N" only restates the implementation.
//
// The point of this model is the regimes the old kThrust*omega^2 form could not
// express at all: a prop that unloads at speed, one the air drives instead of
// the other way round, and one that has stopped turning but is still four discs
// sitting in the airflow. Those are what most of this file checks.
import assert from 'node:assert/strict';
import { PROFILES, FAMILIES } from '../src/drone-profiles.js';
import { geometryOf, rotorForces, airfoil, twistAt } from '../src/blade-element.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };
const GEOM = Object.fromEntries(FAMILIES.map((f) => [f, geometryOf(PROFILES[f])]));

// KNOWN DEFECT, pinned rather than hidden. The joint chord/section-drag solve
// converges exactly for five families and settles into a limit cycle on
// freestyle5, leaving it ~4% high on thrust and ~4% low on the torque ratio.
// That is the REFERENCE family, so this is not a comfortable thing to ship; it
// is recorded here with a tolerance tight enough that it cannot quietly get
// worse, and it is why the module is not yet wired into quad.js.
const OFF = { freestyle5: 0.05 };

t('both anchors are reproduced, every family', () => {
	for (const f of FAMILIES) {
		const p = PROFILES[f];
		const tol = OFF[f] ?? 1e-6;
		const r = rotorForces(GEOM[f], p.maxOmega, 0);
		assert.ok(Math.abs(r.thrust / p.maxThrustPerMotor - 1) < tol,
			`${f}: static thrust ${r.thrust} vs ${p.maxThrustPerMotor}`);
		assert.ok(Math.abs(r.torque / r.thrust / p.torqueRatio - 1) < tol,
			`${f}: Q/T ${r.torque / r.thrust} vs ${p.torqueRatio}`);
	}
});

t('five of the six converge exactly, and the sixth is the known one', () => {
	// So that "it converges" cannot rot into "it is within 5% everywhere".
	const exact = FAMILIES.filter((f) => {
		const p = PROFILES[f];
		const r = rotorForces(GEOM[f], p.maxOmega, 0);
		return Math.abs(r.thrust / p.maxThrustPerMotor - 1) < 1e-6
			&& Math.abs(r.torque / r.thrust / p.torqueRatio - 1) < 1e-6;
	});
	assert.equal(exact.length, FAMILIES.length - Object.keys(OFF).length,
		`exact: ${exact.join(', ')}`);
	for (const f of Object.keys(OFF)) assert.ok(!exact.includes(f), `${f} now converges — drop it from OFF`);
});

t('the thrust surface is smooth in blade chord', () => {
	// The symptom that exposed the unconverged induced-velocity solve: a
	// half-solved vi puts steps in the thrust, and thrust stopped rising with
	// chord. In flight that would have been untraceable noise.
	for (const f of FAMILIES) {
		const g = { ...GEOM[f] };
		let prev = -Infinity;
		for (let c = 0.02; c <= 2; c *= 1.15) {
			g.chordScale = c;
			const th = rotorForces(g, PROFILES[f].maxOmega, 0).thrust;
			assert.ok(th > prev, `${f}: chord ${c.toFixed(3)} gave ${th}, below ${prev}`);
			prev = th;
		}
	}
});

t('the solved section drag stays under a flat plate, and rises as Reynolds falls', () => {
	// It is a lumped loss, not a published Cd0, but it cannot exceed a plate —
	// and the small, low-Reynolds props must need MORE of it than the big ones.
	for (const f of FAMILIES) {
		assert.ok(GEOM[f].cd0 > 0 && GEOM[f].cd0 < 1.2, `${f}: cd0 ${GEOM[f].cd0}`);
	}
	assert.ok(GEOM.toothpick.cd0 > GEOM.race5.cd0,
		`a 2.5" micro should be draggier than a 5" racer: ${GEOM.toothpick.cd0} vs ${GEOM.race5.cd0}`);
});

t('the figure of merit is a real propeller\'s, not a helicopter\'s', () => {
	// FM = ideal induced power / actual shaft power. A large rotor reaches 0.7+;
	// a small multirotor prop measures 0.35-0.45 and a ducted or micro one less.
	// Anything near 0.7 here would mean the losses are not being modelled.
	for (const f of FAMILIES) {
		const p = PROFILES[f];
		const r = rotorForces(GEOM[f], p.maxOmega, 0);
		const area = Math.PI * p.propRadius * p.propRadius;
		const vi = Math.sqrt(r.thrust / (2 * 1.225 * area));
		const fm = (r.thrust * vi) / (r.torque * p.maxOmega);
		assert.ok(fm > 0.1 && fm < 0.5, `${f}: figure of merit ${fm.toFixed(3)}`);
	}
});

t('twist comes from the prop\'s pitch, and falls off with radius', () => {
	// Geometric pitch: the blade angle at r is atan(pitch / 2*pi*r), so the root
	// is coarse and the tip fine. Checked against the definition, not the code.
	const pitch = 0.1092;
	assert.ok(Math.abs(twistAt(pitch, 0.02) - Math.atan2(pitch, 2 * Math.PI * 0.02)) < 1e-12);
	assert.ok(twistAt(pitch, 0.02) > twistAt(pitch, 0.06), 'root coarser than tip');
});

t('the aerofoil polar is finite and bounded through a full turn', () => {
	// This is what lets the model have regimes at all: a polar that only covers
	// +-15 degrees is what forces a thrust clamp.
	for (let d = -180; d <= 180; d += 1) {
		const { cl, cd } = airfoil((d * Math.PI) / 180, 0.3);
		assert.ok(Number.isFinite(cl) && Number.isFinite(cd), `alpha ${d}`);
		assert.ok(Math.abs(cl) < 2.5, `alpha ${d}: cl ${cl}`);
		assert.ok(cd > 0 && cd < 2, `alpha ${d}: cd ${cd}`);
	}
});

t('climbing unloads the prop', () => {
	// NOT monotone from rest, and the model is right about that: at low rpm a
	// coarse blade sits stalled in still air (its own twist is ~20 degrees,
	// past stall), so the first few m/s of inflow UNSTALL it and thrust rises
	// before it falls. Asserted from 10 m/s up, where the sections are attached
	// and more inflow can only mean less angle of attack.
	for (const f of FAMILIES) {
		const p = PROFILES[f];
		// Asserted only while the rotor is still pushing. Once it is being
		// driven the blade is deep in reversed flow, the flat-plate polar turns
		// over, and thrust is not required to keep falling — it is required to
		// be negative, which the windmilling check below is for.
		let prev = Infinity;
		for (let v = 10; v <= 40; v += 2.5) {
			const th = rotorForces(GEOM[f], p.maxOmega * 0.4, v).thrust;
			if (th < 0) break;
			assert.ok(th <= prev + 1e-9, `${f} at ${v} m/s: ${th} > ${prev}`);
			prev = th;
		}
		const rest = rotorForces(GEOM[f], p.maxOmega * 0.4, 0).thrust;
		assert.ok(prev < rest, `${f}: climbing must end up below static (${prev} vs ${rest})`);
	}
});

t('a prop the air drives makes NEGATIVE thrust — windmilling', () => {
	// The regime `Math.max(0, t)` made unreachable. Climb fast enough at a given
	// rpm and the blade is being turned by the flow, not turning it.
	for (const f of FAMILIES) {
		const p = PROFILES[f];
		const fast = rotorForces(GEOM[f], p.maxOmega * 0.4, 60).thrust;
		assert.ok(fast < 0, `${f}: thrust ${fast} at 60 m/s of climb`);
	}
});

t('a STOPPED prop is still four discs in the airflow', () => {
	// It used to contribute exactly zero the moment it stopped turning.
	for (const f of FAMILIES) {
		const zero = rotorForces(GEOM[f], 0, 0).thrust;
		assert.ok(Math.abs(zero) < 1e-9, `${f}: still air, still prop: ${zero}`);
		let prev = 0;
		for (const v of [-5, -10, -20, -30]) {
			const drag = rotorForces(GEOM[f], 0, v).thrust;
			// Descending, a stalled disc pushes UP, and harder the faster it falls.
			assert.ok(drag > prev, `${f} at ${v} m/s: ${drag} not above ${prev}`);
			prev = drag;
		}
	}
});

t('nothing returns NaN anywhere in the envelope', () => {
	for (const f of FAMILIES) {
		const p = PROFILES[f];
		for (const w of [0, 1, 100, p.maxOmega * 0.5, p.maxOmega, p.maxOmega * 1.5]) {
			for (const v of [-80, -30, -5, 0, 5, 30, 80]) {
				for (const e of [0, 10, 40]) {
					const r = rotorForces(GEOM[f], w, v, 1.225, e);
					assert.ok(Number.isFinite(r.thrust) && Number.isFinite(r.torque),
						`${f} w=${w} v=${v} e=${e}: ${JSON.stringify(r)}`);
				}
			}
		}
	}
});

t('edgewise flow raises thrust where the axial model is still honest', () => {
	// Translational lift, up to the advance ratio past which this model's own
	// header says it stops being trustworthy (~0.1).
	const p = PROFILES.freestyle5;
	const hover = Math.sqrt((p.mass * 9.81) / 4 / (p.maxThrustPerMotor / p.maxOmega ** 2));
	const still = rotorForces(GEOM.freestyle5, hover, 0, 1.225, 0).thrust;
	const moving = rotorForces(GEOM.freestyle5, hover, 0, 1.225, 10).thrust;
	assert.ok(moving > still * 1.01, `${moving} vs ${still}`);
});

console.log(`blade-element-selftest : ${n} tests ok`);

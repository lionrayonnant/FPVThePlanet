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

// A GRID of blades the solver has never seen, spanning the pitch/diameter
// ratios, diameters, blade counts and section drags a small multirotor prop
// comes in. The families above are six points; a solver that converges only on
// the six it ships with is not a solver, and this is the check that says so. It
// is also what catches a family whose hardware numbers are corrected later: the
// geometry moves, and the solve has to hold anyway.
//
// The anchors are taken FROM the model rather than invented, which is what
// makes this a round trip and not a guess: build a blade with a known chord
// scale and section drag, read the static thrust and torque ratio it makes, and
// require the solver handed those two numbers to come back to the same blade.
// Inventing a thrust instead only tests whether the number was reachable.
const GRID = [];
for (const R of [0.03175, 0.0381, 0.0635, 0.0762]) {
	for (const pd of [0.3, 0.5, 0.7, 0.9, 1.1]) {
		for (const blades of [2, 3]) {
			for (const [chordScale, cd0] of [[0.12, 0.05], [0.25, 0.3], [0.45, 0.8]]) {
				const spec = {
					propRadius: R, propPitch: pd * 2 * R, bladeCount: blades,
					maxOmega: 340 / R / 4,          // a tip speed around Mach 0.25
					maxThrustPerMotor: 1, torqueRatio: 1,
				};
				const truth = { ...geometryOf(spec), chordScale, cd0 };
				const f = rotorForces(truth, spec.maxOmega, 0);
				if (!(f.thrust > 0) || !(f.torque > 0)) continue;
				spec.maxThrustPerMotor = f.thrust;
				spec.torqueRatio = f.torque / f.thrust;
				GRID.push({ spec, chordScale, cd0,
					label: `${(R * 2 / 0.0254).toFixed(1)}" p/D=${pd} ${blades}b cs=${chordScale} cd0=${cd0}` });
			}
		}
	}
}

t('both anchors are reproduced to machine precision, every family', () => {
	// This used to carry a tolerance. The joint chord/section-drag solve settled
	// into a limit cycle on freestyle5 — the REFERENCE family — and sat 4% off
	// both anchors, pinned here rather than fixed. It had two causes and both
	// are gone: the solve is nested rather than alternating, and the induced
	// velocity it reads is single-valued rather than whichever of three roots a
	// doubling bracket happened to straddle. There is no tolerance now because
	// there is nothing left to tolerate.
	for (const f of FAMILIES) {
		const p = PROFILES[f];
		const r = rotorForces(GEOM[f], p.maxOmega, 0);
		assert.ok(Math.abs(r.thrust / p.maxThrustPerMotor - 1) < 1e-9,
			`${f}: static thrust ${r.thrust} vs ${p.maxThrustPerMotor}`);
		assert.ok(Math.abs(r.torque / r.thrust / p.torqueRatio - 1) < 1e-9,
			`${f}: Q/T ${r.torque / r.thrust} vs ${p.torqueRatio}`);
	}
});

t('and on every blade in the grid, not just the six that ship', () => {
	// 1e-8 rather than the families' 1e-9: the outer bisection reads a quantity
	// the inner one has already solved, so the nesting's own floor is what is
	// being measured here, not a model error.
	for (const { spec, label } of GRID) {
		const g = geometryOf(spec);
		const r = rotorForces(g, spec.maxOmega, 0);
		assert.ok(Math.abs(r.thrust / spec.maxThrustPerMotor - 1) < 1e-8,
			`${label}: thrust ${r.thrust} vs ${spec.maxThrustPerMotor}`);
		assert.ok(Math.abs(r.torque / r.thrust / spec.torqueRatio - 1) < 1e-8,
			`${label}: Q/T ${r.torque / r.thrust} vs ${spec.torqueRatio}`);
	}
});

t('and it recovers the blade itself, not merely a blade that fits', () => {
	// Two anchors, two unknowns: the solution should be unique, so the solver
	// has to land back on the chord scale and section drag the anchors were
	// generated from. Matching the anchors while sitting somewhere else in the
	// plane would mean the two are degenerate and one of them is decoration.
	for (const { spec, chordScale, cd0, label } of GRID) {
		const g = geometryOf(spec);
		assert.ok(Math.abs(g.chordScale / chordScale - 1) < 1e-4, `${label}: chordScale ${g.chordScale}`);
		assert.ok(Math.abs(g.cd0 / cd0 - 1) < 1e-4, `${label}: cd0 ${g.cd0}`);
	}
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

t('and it is smooth, which monotone alone does not mean', () => {
	// The test above passed all the way through the defect it was written for.
	// A step UP is still monotone, and the induced-velocity solve had one: at
	// the reference family's own calibration point a 0.1% change in blade chord
	// jumped the thrust by 9%, because the residual has three roots and a
	// doubling bracket picked whichever one it happened to straddle. That is
	// what the calibration was cycling on, so this asserts the property that was
	// actually violated — a bounded response to a bounded change — rather than
	// the one that survived it.
	for (const f of FAMILIES) {
		const g = { ...GEOM[f] };
		const step = 1.002;                  // 0.2% of chord
		let prev = null;
		for (let c = 0.05; c <= 1.5; c *= step) {
			g.chordScale = c;
			const th = rotorForces(g, PROFILES[f].maxOmega, 0).thrust;
			if (prev !== null) {
				// Thrust is very nearly linear in chord, so 0.2% in must not give
				// more than 1% out. A discontinuity is orders past this.
				assert.ok(th - prev < Math.max(prev, 1e-3) * 0.01,
					`${f}: chord ${c.toFixed(4)} stepped thrust ${prev} -> ${th}`);
			}
			prev = th;
		}
	}
});

t('and smooth in rpm and in airspeed too, which is where a pilot would feel it', () => {
	// The same property along the two axes flight actually moves on, measured
	// against the ROTOR's own scale — its static thrust — rather than against
	// the local value, which goes to zero at the windmilling knee and makes any
	// relative measure meaningless exactly where it is least interesting.
	//
	// KNOWN LIMIT, and the reason the bounds here are 6-7% rather than a
	// fraction of a percent. Two folds survive, both of them on the boundary where momentum
	// theory stops having a solution at all: the vortex-ring state in a descent
	// near Vc/vh = -2, and the windmill transition in a fast climb at low rpm.
	// There the blade-element residual's first root merges with its second and
	// vanishes, and the induced velocity steps to the next one — worst measured
	// is 5% of static thrust across a 0.25 m/s change. Leishman's empirical
	// induced-velocity fit through the turbulent-wake state is the published
	// answer and it is a uniform-inflow model, so it is a restructuring, not a
	// patch. What this bound does hold against is the defect that WAS fixed: a
	// 9% step, at the calibration point, in the middle of the working envelope.
	//
	// The bound moved from 6% to 7% when longrange stopped being extrapolated
	// from freestyle5. longrange is the family that wrote the "5%" above and it
	// always was: on a 0.01 m/s sweep the OLD rotor already stepped 4.85% of
	// static thrust at w = 735 rad/s in a 8.7 m/s descent, against 1.4-3.0% for
	// the other five. Its catalogue rotor (a bi-blade 7037 at 2499 rad/s) puts
	// the same fold at 5.62% — 6.75% as this loop's 0.25 m/s grid reads it,
	// since the grid also collects the local slope on either side. Nothing about
	// the fold is new and nothing about the data is wrong: a 7" turning slowly
	// has the lowest disc loading of the six, so its own vh is small and the
	// Vc/vh = -2 boundary sits where a pilot actually descends, which is why
	// this family finds the discontinuity first. The bound is widened rather
	// than the hardware bent, and 7% still refuses the 9% defect it was written
	// for. Only the AIRSPEED sweep needed it; the rpm sweep below still holds at
	// 6%, and moving it would have hidden something.
	for (const f of FAMILIES) {
		const p = PROFILES[f];
		for (const vEdge of [0, 10, 30]) {
			for (const frac of [0.3, 0.5, 0.8, 1]) {
				const w = p.maxOmega * frac;
				const scale = rotorForces(GEOM[f], w, 0).thrust;
				let prev = null;
				for (let v = -40; v <= 40; v += 0.25) {
					const th = rotorForces(GEOM[f], w, v, 1.225, vEdge).thrust;
					// Only where the rotor is still doing something: past the
					// windmilling knee the sign is the interesting property, not the
					// slope, and the checks below are what assert it.
					if (prev !== null && th > 0.25 * scale && prev > 0.25 * scale) {
						assert.ok(Math.abs(th - prev) < 0.07 * scale,
							`${f} w=${w.toFixed(0)} vEdge=${vEdge}: vAxial ${v} stepped thrust ${prev} -> ${th}`);
					}
					prev = th;
				}
			}
		}
		// And along rpm, at a fixed point of the envelope.
		for (const vEdge of [0, 10, 30]) {
			const scale = rotorForces(GEOM[f], p.maxOmega, 0).thrust;
			let prev = null;
			for (let w = 200; w <= p.maxOmega; w *= 1.01) {
				const th = rotorForces(GEOM[f], w, 0, 1.225, vEdge).thrust;
				if (prev !== null) {
					assert.ok(Math.abs(th - prev) < 0.06 * scale,
						`${f} vEdge=${vEdge}: omega ${w.toFixed(0)} stepped thrust ${prev} -> ${th}`);
				}
				prev = th;
			}
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
	for (let d = -180; d <= 180; d += 0.25) {
		const { cl, cd } = airfoil((d * Math.PI) / 180, 0.3);
		assert.ok(Number.isFinite(cl) && Number.isFinite(cd), `alpha ${d}`);
		assert.ok(Math.abs(cl) < 2.5, `alpha ${d}: cl ${cl}`);
		assert.ok(cd > 0 && cd < 2, `alpha ${d}: cd ${cd}`);
	}
});

t('and it is continuous through a full turn, joins included', () => {
	// Viterna's extension meets the linear branch AT the stall angle by
	// construction, and the reversed half is the same curve mirrored about
	// broadside. Both joins are places a 360-degree polar is usually spliced by
	// hand and usually has a step. A step in cl is a step in torque, and a
	// blade in edgewise flight crosses these angles once per revolution.
	for (const cd0 of [0.02, 0.3, 1.0]) {
		let prev = null;
		for (let d = -180; d <= 180; d += 0.25) {
			const r = airfoil((d * Math.PI) / 180, cd0);
			if (prev) {
				assert.ok(Math.abs(r.cl - prev.cl) < 0.05, `cd0 ${cd0}, alpha ${d}: cl ${prev.cl} -> ${r.cl}`);
				assert.ok(Math.abs(r.cd - prev.cd) < 0.05, `cd0 ${cd0}, alpha ${d}: cd ${prev.cd} -> ${r.cd}`);
			}
			prev = r;
		}
	}
});

t('the section is CAMBERED, which is what a propeller blade is', () => {
	// The single term that was missing, checked as the identity it is rather
	// than by a number. A symmetric section makes no lift at zero incidence and
	// therefore stops pulling exactly where the blade stops slipping, J = p/D;
	// the tunnel says real props pull well past that, and this is why.
	const zero = airfoil(0, 0.3).cl;
	assert.ok(zero > 0, `a cambered section lifts at zero incidence: cl ${zero}`);
	// It lifts nothing at ITS own zero-lift angle, which is negative.
	let a0 = 0;
	for (let d = -0.5; d > -15; d -= 0.001) {
		if (airfoil((d * Math.PI) / 180, 0.3).cl <= 0) { a0 = d; break; }
	}
	assert.ok(a0 < -0.5 && a0 > -10, `zero-lift angle ${a0} degrees is not a propeller section's`);
	assert.ok(Math.abs(airfoil((a0 * Math.PI) / 180, 0.3).cl) < 1e-3, 'cl is zero at the zero-lift angle');
	// And the polar is that same curve shifted, not a new one: stall is a fixed
	// angle from the zero-lift line, so the positive stall peak sits nearer zero
	// incidence than the negative one.
	let peakPos = 0, peakNeg = 0;
	for (let d = 0; d < 90; d += 0.1) if (airfoil((d * Math.PI) / 180, 0.3).cl > airfoil((peakPos * Math.PI) / 180, 0.3).cl) peakPos = d;
	for (let d = 0; d > -90; d -= 0.1) if (airfoil((d * Math.PI) / 180, 0.3).cl < airfoil((peakNeg * Math.PI) / 180, 0.3).cl) peakNeg = d;
	assert.ok(peakPos < Math.abs(peakNeg), `stall peaks ${peakPos} / ${peakNeg} are not shifted by camber`);
});

t('lift runs out broadside and reverses behind it', () => {
	// The reversed half of the polar is not decoration: an inboard station on
	// the retreating side of a rotor in fast forward flight really does sit
	// there, once per revolution. Getting its SIGN wrong — which a flat-plate
	// continuation of cos^2/sin quietly does — puts lift where there is drag.
	assert.ok(Math.abs(airfoil(Math.PI / 2, 0.3).cl) < 0.1, 'a section broadside on makes no lift');
	assert.ok(airfoil((120 * Math.PI) / 180, 0.3).cl < 0, 'past broadside, lift reverses');
	assert.ok(airfoil((-120 * Math.PI) / 180, 0.3).cl > 0, 'and reverses the other way round too');
	assert.ok(airfoil(Math.PI, 0.3).cd < airfoil(Math.PI / 2, 0.3).cd,
		'edge-on to a reversed flow is low drag; broadside is not');
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

t('the blade elements SEE the edgewise flow, not just the momentum balance', () => {
	// The defect the azimuthal integration exists for, asserted as the regime it
	// unlocks rather than as a number. Fly fast enough and the inboard stations
	// on the retreating side go BACKWARDS through the air — omega*r is smaller
	// than vEdge there — and a model that only feeds edgewise flow to the
	// momentum balance cannot represent that at all: every element sees the same
	// tangential speed all the way round, so nothing on the disc ever reverses.
	for (const f of FAMILIES) {
		const p = PROFILES[f];
		const hover = Math.sqrt((p.mass * 9.81) / 4 / (p.maxThrustPerMotor / p.maxOmega ** 2));
		// The innermost station sits at 0.15 + half a step of the radius.
		const rInner = p.propRadius * (0.15 + (0.85 / 8) * 0.5);
		const vEdge = hover * rInner * 1.5;      // comfortably past reversal
		const r = rotorForces(GEOM[f], hover, 0, 1.225, vEdge);
		assert.ok(Number.isFinite(r.thrust) && Number.isFinite(r.torque),
			`${f}: reversed flow at vEdge ${vEdge} gave ${JSON.stringify(r)}`);
	}
});

t('and thrust is continuous in edgewise speed, station count included', () => {
	// The azimuthal quadrature uses one station in near-axial flight, four at
	// moderate advance ratio and eight above it, because a midpoint rule on a
	// smooth periodic integrand converges fast and hover should not pay for
	// forward flight. That is only legitimate if the switches are invisible: a
	// step at mu = 0.01 or mu = 0.1 would be an optimisation the pilot can feel.
	for (const f of FAMILIES) {
		const p = PROFILES[f];
		for (const frac of [0.3, 0.6, 1]) {
			const w = p.maxOmega * frac;
			const scale = rotorForces(GEOM[f], w, 0).thrust;
			let prev = null;
			for (let e = 0; e <= 60; e += 0.2) {
				const th = rotorForces(GEOM[f], w, 0, 1.225, e).thrust;
				if (prev !== null) {
					assert.ok(Math.abs(th - prev) < 0.02 * scale,
						`${f} w=${w.toFixed(0)}: vEdge ${e} stepped thrust ${prev} -> ${th}`);
				}
				prev = th;
			}
		}
	}
});

t('and in the limit of no edgewise flow it is the axial answer', () => {
	// One station and eight have to agree as mu goes to zero, or the switch
	// above is hiding a discontinuity rather than straddling one.
	for (const f of FAMILIES) {
		const p = PROFILES[f];
		const axial = rotorForces(GEOM[f], p.maxOmega, 0, 1.225, 0).thrust;
		const crawling = rotorForces(GEOM[f], p.maxOmega, 0, 1.225, 1e-4).thrust;
		assert.ok(Math.abs(crawling / axial - 1) < 1e-6, `${f}: ${crawling} vs ${axial}`);
	}
});

t('a rotor in fast edgewise flight gains thrust — translational lift', () => {
	// The property a real rotor has and the axial-only model did not: it lost
	// 44% of its thrust by 40 m/s of edgewise flight, because the momentum
	// balance took the induced velocity away and the sections, meeting their own
	// twist head on, stalled.
	//
	// Asserted at high advance ratio, which is where the effect is unambiguous.
	// Between rest and roughly 15 m/s the model shows a shallow DIP of a few
	// percent first, and that is not asserted either way: it is the coarse
	// inboard sections of a small prop, already past stall in still air, being
	// pushed further past it as the induced velocity falls. It is plausible and
	// it is unverified — the tunnel database this model is checked against is
	// axial-flow only and has nothing to say about edgewise rotors.
	for (const f of FAMILIES) {
		const p = PROFILES[f];
		const hover = Math.sqrt((p.mass * 9.81) / 4 / (p.maxThrustPerMotor / p.maxOmega ** 2));
		const still = rotorForces(GEOM[f], hover, 0, 1.225, 0).thrust;
		const fast = rotorForces(GEOM[f], hover, 0, 1.225, 40).thrust;
		assert.ok(fast > still * 1.05, `${f}: ${fast} at 40 m/s edgewise vs ${still} at rest`);
	}
});

console.log(`blade-element-selftest : ${n} tests ok`);

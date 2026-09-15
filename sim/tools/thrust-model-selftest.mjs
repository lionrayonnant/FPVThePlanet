// node tools/thrust-model-selftest.mjs — SPEC_PHYSIQUE_VOL.md §6.1, §6.4, §7
// and the acceptance criteria of §13 that go with them.
//
// WHY THIS IS A BENCH AND NOT A MODULE. §7 is, term for term, a second
// description of mechanisms src/quad.js already carries (see the header of that
// file for the five-row table). Wiring it into the force path would be the
// spec's own first classic error, "measuring the same mechanism twice", and
// §14.1 calls its weighting an open point anyway. So the spec's thrust model
// lives HERE, as a reference implementation that MEASURES the airframes instead
// of moving them: it says what §7 predicts a family should pull, next to what
// that family was measured pulling, and it says which of §13's criteria the
// spec's own numbers do and do not meet.
//
// UNITS. The spec is in centimetres, degrees and inches; this sim is in metres
// and radians. Every conversion is written out at the point it happens, because
// §13 warns that unit errors in this model are silent and propagate, and that is
// the single biggest risk in transcribing it.
//
// The rule, same as tools/aero-selftest.mjs: assert an IDENTITY or a structural
// property, never a recorded number. Where a number IS asserted it is one the
// spec states in prose (42 000 rpm, 1453.96 g, 8:1, 30 % of stick), so the check
// is "does the spec agree with itself", which is the point.
import {
	kvLossTipSpeed, kvLossPropPitch, thrustRatioByDiameter,
	thrustPerMotor5in, throttleShape5in,
} from '../src/curves.js';
import { map, propInchesOf, kThrustOf, vhPerOmegaOf, Propulsion } from '../src/quad.js';
import { PROFILES, FAMILIES } from '../src/drone-profiles.js';
import { SEA_LEVEL_AIR_DENSITY } from '../src/air.js';

let failures = 0;
function check(label, ok, detail) {
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures++;
}

const INCH = 0.0254;
const SPEED_OF_SOUND = 346;            // m/s, §6.1's constant
const near = (a, b, tol) => Math.abs(a - b) <= tol;

console.log('thrust model — spec §6.1 / §6.4 / §7 against the criteria of §13\n');

// ---------------------------------------------------------------------------
// §6.1, transcribed. `kv` is the spec's MotorsKV, i.e. KV IN THOUSANDS — §13
// names mixing that up with a catalogue's raw 8000 as the way to build a drone
// a thousand times too fast. `shaped` is §6.2's weighted throttle, 1 at the top
// of the stick with flat bands.
function calcRPM({ kv, cells, cellVolts, propSize, pitch, shaped = 1 }) {
	const diamM = propSize * INCH;
	const theoretical = kv * 1000 * cells * cellVolts * shaped;

	// KV loss 1: blade tip approaching the speed of sound.
	const tip = (theoretical / 60) * Math.PI * diamM;
	let rpm = theoretical * kvLossTipSpeed.eval(Math.min(1, Math.max(0, tip / SPEED_OF_SOUND)));
	// KV loss 2: prop pitch. Indexed by pitch/diameter, both in inches, so the
	// ratio is dimensionless and the unit does not matter — as long as the two
	// are the SAME unit, which is the trap.
	rpm *= kvLossPropPitch.eval(pitch / propSize);

	// Transonic saturation.
	const tip2 = (rpm / 60) * Math.PI * diamM;
	const limit = SPEED_OF_SOUND * map(propSize, 2, 6, 0.62, 1.0);
	const ratio = tip2 / limit;
	if (ratio >= 0.75) {
		const capped = (Math.min(tip2, limit * 0.85) / (Math.PI * diamM)) * 60;
		rpm += (capped - rpm) * map(ratio, 0.75, 1.0, 0, 1);
	}
	return { theoretical, rpm, tip, tip2, limit, ratio };
}

// §6.2, transcribed. `t` is throttle already in 0..1 (the spec's -1..1 axis is
// an input convention, not part of the weighting).
function throttleTravelWeight(t, { low = 1, med = 1, high = 1 } = {}) {
	return map(t, 0, 0.5, 1, 0) * low
		+ map(Math.abs(t - 0.5), 0, 0.5, 1, 0) * med
		+ map(t, 0.5, 1, 0, 1) * high;
}

// §7's flow velocity: the pitch is how far the prop screws forward per turn, so
// revolutions per second times pitch IS a speed. Metres here; the spec's
// `× 0.01` is its own cm/s -> m/s conversion and must NOT be carried over.
const flowVelocity = (rpm, pitchM) => (rpm / 60) * pitchM;

// ---------------------------------------------------------------------------
console.log('1. §6.1, and criterion 3 of §13');

{
	// §13: "6S / 1750 KV / 5" / 4.0 V: theoretical before losses = 42 000 rpm;
	// after the two loss curves, ~35 000."
	const r = calcRPM({ kv: 1.75, cells: 6, cellVolts: 4.0, propSize: 5.0, pitch: 4.3 });
	check(
		'the theoretical rpm before losses is the spec\'s 42 000 exactly',
		near(r.theoretical, 42000, 1),
		`${r.theoretical.toFixed(0)} rpm`,
	);
	check(
		'both loss curves bite, and in the right direction',
		kvLossTipSpeed.eval(r.tip / SPEED_OF_SOUND) < 1 && kvLossPropPitch.eval(4.3 / 5) < 1
			&& r.rpm < r.theoretical,
		`tip x${kvLossTipSpeed.eval(r.tip / SPEED_OF_SOUND).toFixed(4)}`
		+ ` pitch x${kvLossPropPitch.eval(4.3 / 5).toFixed(4)}`,
	);
	// SPEC DEFECT. The prose says ~35 000; the two curves it ships give 30 234,
	// 14 % lower. Nothing in §6.1 closes that gap: the transonic saturation is
	// inactive here (tip ratio 0.64, well under its 0.75 trigger) and the
	// throttle weighting is 1 at full stick. Either the curves or the 35 000 is
	// wrong. Asserted as the DISAGREEMENT, so the day the spec is corrected this
	// line fails and says so rather than silently agreeing with the new value.
	check(
		'SPEC DEFECT: §6.1\'s own curves do not reach the ~35 000 rpm §13 claims',
		r.rpm < 33000,
		`curves give ${r.rpm.toFixed(0)} rpm, §13 says ~35 000 — ${((1 - r.rpm / 35000) * 100).toFixed(1)}% short`,
	);
	check(
		'transonic saturation stays out of it at 5 inches',
		r.ratio < 0.75,
		`tip ${r.tip2.toFixed(0)} m/s of a ${r.limit.toFixed(0)} m/s limit, ratio ${r.ratio.toFixed(3)}`,
	);
	check(
		'§6.2\'s three bands are a partition: flat weights give 1 across the travel',
		[0, 0.25, 0.5, 0.75, 1].every((t) => near(throttleTravelWeight(t), 1, 1e-12)),
	);
}

// ---------------------------------------------------------------------------
console.log('\n2. §7 composed, and criterion 4 of §13');

// The composition §14.1 leaves open. §7 fixes the TERMS and says only that the
// thrust is "composed from normalise(flux), the disc area (PropSize x 0.0254)^2,
// ratioPoussee and accroche, with the normalised diameter/pitch ratio
// PropSize / (3.29546 x PropellerPitch) raised to the power 1.5". Everything
// below marked WEIGHT is a choice this bench had to make; each says why.
//
// WEIGHT 1 — DISC_AREA. The spec's "(PropSize x 0.0254)^2" is the square of the
// DIAMETER, not a disc area: a disc of diameter D has area pi*D^2/4. Using the
// real area, because the term is multiplied by a squared velocity and is
// therefore a mass flow, and a mass flow through a disc goes through pi*D^2/4.
const discArea = (propSize) => (Math.PI * (propSize * INCH) ** 2) / 4;
const specLiteralArea = (propSize) => (propSize * INCH) ** 2;

// WEIGHT 2 — DYNAMIC_PRESSURE. §7 has no air density in it at all, while §8.3
// makes exposing airDensity(altitude) a DOIT. Without a density the expression
// ratio * area * v^2 is not a force, it is a volume flow squared over a length:
// it does not even have units of newtons. The half-rho of a dynamic pressure is
// the only factor that makes the dimensions close, so it is supplied here.
const HALF_RHO = 0.5 * SEA_LEVEL_AIR_DENSITY;

// WEIGHT 3 — PITCH_RATIO_REFERENCE, the spec's 3.29546. Taken as given. It is a
// diameter/pitch ratio of 1/3.29546 = 0.3034, which is what a 5x4.3 nearly is,
// so the term is ~1 for a typical prop and pushes low-pitch props up.
const PITCH_RATIO_REFERENCE = 3.29546;
const pitchRatioTerm = (propSize, pitch) => (propSize / (PITCH_RATIO_REFERENCE * pitch)) ** 1.5;

// WEIGHT 4 — COMPOSITION_GAIN, the one free scalar left once the three above
// are fixed. Calibrated below against §13 criterion 4 and nothing else, through
// the spec's OWN rpm chain, so that the bench is self-consistent end to end.
// The value it lands on is reported by the check that sets it.
const COMPOSITION_GAIN = 1.4699;

// Static thrust of one motor, newtons.
function specThrust({ propSize, pitch, rpm, area = discArea, gain = COMPOSITION_GAIN }) {
	const v = flowVelocity(rpm, pitch * INCH);
	return gain * HALF_RHO * area(propSize)
		* v * v
		* thrustRatioByDiameter.eval(propSize)
		* pitchRatioTerm(propSize, pitch);
}

{
	const DEFAULT = { kv: 1.75, cells: 6, cellVolts: 4.0, propSize: 5.0, pitch: 4.3 };
	const { rpm } = calcRPM(DEFAULT);
	const N = specThrust({ ...DEFAULT, rpm });
	const grams = (N / 9.81) * 1000;
	// §11's own 5" thrust table tops out at 1453.96 g per motor, and §13's 8:1
	// is built on it. Matching it is what COMPOSITION_GAIN is for.
	const target = thrustPerMotor5in.eval(1);
	check(
		'§7 composed reproduces §11\'s 1453.96 g per motor at full stick',
		near(grams, target, target * 0.02),
		`${grams.toFixed(0)} g vs ${target.toFixed(0)} g (gain ${COMPOSITION_GAIN})`,
	);
	// What the gain WOULD be had the rpm chain delivered the 35 000 §13 claims:
	// the two defects partly cancel, and that is worth knowing before anyone
	// "fixes" one of them alone.
	const at35k = specThrust({ ...DEFAULT, rpm: 35000, gain: 1 });
	check(
		'the residual gain is the rpm shortfall, not the aerodynamics',
		near(target / ((at35k / 9.81) * 1000), 1.0, 0.15),
		`at the spec's own 35 000 rpm the gain would be ${(target / ((at35k / 9.81) * 1000)).toFixed(3)}, i.e. ~1`,
	);
	// SPEC DEFECT, and the reason WEIGHT 1 exists: read literally, "(PropSize x
	// 0.0254)^2" is 4/pi = 1.27x the real disc area, so the same composition
	// overshoots by 27 %.
	const literal = specThrust({ ...DEFAULT, rpm, area: specLiteralArea });
	check(
		'SPEC DEFECT: §7\'s "disc area" is a diameter squared, 4/pi too large',
		near(literal / N, 4 / Math.PI, 1e-9),
		`literal reading overshoots by ${((literal / N - 1) * 100).toFixed(1)}%`,
	);

	// Criterion 4's other half, which the shipped curves DO satisfy: hover at
	// 0.715 kg is 178.75 g a corner, and §11's thrust table puts that at 30 %
	// of stick, not 50 %.
	const hoverGrams = (0.715 * 9.81 / 4 / 9.81) * 1000;
	let lo = 0, hi = 1;
	for (let i = 0; i < 60; i++) {
		const m = (lo + hi) / 2;
		if (thrustPerMotor5in.eval(m) < hoverGrams) lo = m; else hi = m;
	}
	check(
		'criterion 4: hover is ~179 g a corner at ~30 % of stick, not 50 %',
		near(hoverGrams, 179, 1) && near(lo, 0.30, 0.02),
		`${hoverGrams.toFixed(1)} g at stick ${lo.toFixed(3)}`,
	);
	check(
		'criterion 4: the default build is ~8:1 thrust to weight',
		near((4 * target) / 715, 8, 0.3),
		`${((4 * target) / 715).toFixed(2)}:1`,
	);
	check(
		'§11\'s 5" thrust curve is monotone in the stick',
		(() => {
			let prev = -1;
			for (let i = 0; i <= 200; i++) {
				const y = thrustPerMotor5in.eval(i / 200);
				if (y < prev - 1e-9) return false;
				prev = y;
			}
			return true;
		})(),
	);
	check(
		'§11\'s 5" throttle shape is monotone and spans 0..1',
		near(throttleShape5in.eval(0), 0, 1e-12) && near(throttleShape5in.eval(1), 1, 1e-12)
			&& throttleShape5in.eval(0.5) < 0.5,
		`half stick shapes to ${throttleShape5in.eval(0.5).toFixed(3)}`,
	);
}

// ---------------------------------------------------------------------------
console.log('\n3. §7 against the airframes this sim actually flies');

// The cross-check the composition is FOR: what §7 predicts each family should
// pull at its own top rpm, next to the maxThrustPerMotor that family was given.
// Deliberately a loose gate — this is a second opinion, not a truth, and the
// families were measured on real hardware while §7 is a two-curve fit. What it
// would catch is an order-of-magnitude unit slip, which is exactly the failure
// §13 warns about.
{
	let worst = 0, worstAt = '';
	console.log('        family       prop      rpm     §7 says   profile has    ratio');
	for (const fam of FAMILIES) {
		const P = PROFILES[fam];
		const propSize = propInchesOf(P);
		const pitch = P.propPitch / INCH;
		const rpm = (P.maxOmega * 60) / (2 * Math.PI);
		const N = specThrust({ propSize, pitch, rpm });
		const ratio = N / P.maxThrustPerMotor;
		console.log(
			`        ${fam.padEnd(11)} ${propSize.toFixed(1)}x${pitch.toFixed(1)}`.padEnd(30)
			+ `${rpm.toFixed(0).padStart(7)}  ${(N / 9.81 * 1000).toFixed(0).padStart(7)} g`
			+ `  ${(P.maxThrustPerMotor / 9.81 * 1000).toFixed(0).padStart(7)} g`
			+ `  ${ratio.toFixed(2).padStart(7)}`,
		);
		const off = Math.abs(Math.log(ratio));
		if (off > worst) { worst = off; worstAt = `${fam} x${ratio.toFixed(2)}`; }
	}
	check(
		'§7 and the measured airframes agree to within a factor of 2.5, every family',
		worst < Math.log(2.5),
		`worst ${worstAt}`,
	);
}

// ---------------------------------------------------------------------------
console.log('\n4. §6.4, the vertical-speed thrust correction');

// §6.4 transcribed. The spec's `vFluxTheorique` is cm/s and its `× 2.54` is the
// inch->cm of the pitch; in metres the whole thing collapses to
// rev/s x pitch(m), the same quantity as §7's vFlux at a nominal 3.8 V/cell and
// 75 % of theoretical rpm.
function theoreticalFlow({ kv, cells, pitch }) {
	return (pitch * INCH) * ((kv * 1000 * cells * 3.8 * 0.75) / 60);
}
function relativeAirSpeedFactor({ vVertical, speed, vFlowTheoretical, relativeAirSpeed = 1 }) {
	const k = map(vVertical, -vFlowTheoretical, vFlowTheoretical, 0, 2);
	if (k >= 1) return 1;
	const mix = Math.min(1, Math.max(0, Math.abs(speed) / vFlowTheoretical)) ** 3;
	const d = k - 1;
	const soft = Math.sign(d) * Math.sqrt(Math.abs(d));
	return 1 + relativeAirSpeed * (soft + (d - soft) * mix);
}

{
	const B = { kv: 1.75, cells: 6, pitch: 4.3 };
	const vF = theoreticalFlow(B);
	const { rpm } = calcRPM({ ...B, cellVolts: 4.0, propSize: 5.0 });
	check(
		'§6.4\'s vFluxTheorique is §7\'s flow velocity in disguise, to within the cell voltage',
		near(vF, flowVelocity(rpm, 4.3 * INCH), 3),
		`${vF.toFixed(1)} m/s vs ${flowVelocity(rpm, 4.3 * INCH).toFixed(1)} m/s at max rpm`,
	);
	check(
		'it is neutral in level flight',
		near(relativeAirSpeedFactor({ vVertical: 0, speed: 0, vFlowTheoretical: vF }), 1, 1e-12),
	);
	// SPEC DEFECT, and this one changes the sign of a flight behaviour. §6.4's
	// own first line is "a drone climbing as fast as its own airflow stops
	// pushing". The formula does the opposite: k >= 1 (every climb) returns
	// exactly 1, and the only branch that reduces thrust is k < 1, which is
	// DESCENT. As written, a drone loses all its thrust falling and none of it
	// climbing.
	const climbing = relativeAirSpeedFactor({ vVertical: vF, speed: vF, vFlowTheoretical: vF });
	const falling = relativeAirSpeedFactor({ vVertical: -vF, speed: vF, vFlowTheoretical: vF });
	check(
		'SPEC DEFECT: §6.4 is inverted — it costs thrust in DESCENT, not in climb',
		near(climbing, 1, 1e-12) && falling < 0.05,
		`climb x${climbing.toFixed(3)} (its header says this should drop), descent x${falling.toFixed(3)}`,
	);
	// And the mechanism it means to describe is already in the sim, derived
	// rather than fitted: the axial branch of quad.js's inflow term. Checked as
	// a SIGN, which is the part §6.4 gets wrong.
	const p = new Propulsion({ profile: PROFILES.freestyle5, seed: 3 });
	const settle = (vy) => {
		let r = null;
		for (let i = 0; i < 600; i++) {
			r = p.step([0.6, 0.6, 0.6, 0.6], { v: { x: 0, y: vy, z: 0 }, agl: null, shake: 0 }, 1 / 250);
		}
		p.reset();
		return r.force.y;
	};
	const level = settle(0), up = settle(6), down = settle(-6);
	check(
		'quad.js has the sign the spec\'s own prose asks for: climbing costs thrust',
		up < level && down > level,
		`climb ${up.toFixed(2)} N < level ${level.toFixed(2)} N < descent ${down.toFixed(2)} N`,
	);
}

// ---------------------------------------------------------------------------
console.log('\n5. §7\'s vortex ring term against the band quad.js flies');

// §7's VRS, transcribed. `v.z` is the spec's vertical speed; its `x 0.01` is the
// cm/s -> m/s conversion and is dropped here, the input already being m/s.
function specVortexRing({ vVertical, vFlow, vFlowMax, propSize }) {
	return map((vVertical - vFlow) / vFlowMax, -1.0, -0.4, 1, 0)
		* map(propSize, 3, 6.5, 0, 1)
		* map(vVertical, -20, 3, 1, 0);
}

{
	const P = PROFILES.freestyle5;
	const propSize = propInchesOf(P);
	const pitchM = P.propPitch;
	const rpmMax = (P.maxOmega * 60) / (2 * Math.PI);
	const vFlowMax = flowVelocity(rpmMax, pitchM);
	// At a hover the disc turns at roughly the square root of the thrust ratio
	// of its maximum, so about 60 % of max rpm on an 8:1 machine.
	const vFlowHover = 0.6 * vFlowMax;

	const atHover = specVortexRing({ vVertical: 0, vFlow: vFlowHover, vFlowMax, propSize });
	const atFast = specVortexRing({ vVertical: -20, vFlow: vFlowHover, vFlowMax, propSize });
	// SPEC DEFECT. A vortex ring is a recirculation that exists only while the
	// descent rate is comparable to the induced velocity. §7's form has it
	// nonzero in a STATIONARY HOVER and largest at 20 m/s of descent, where the
	// rotor is well past the windmill-brake boundary (2*vh) and the flow through
	// the disc is fully established. Both ends are backwards.
	check(
		'SPEC DEFECT: §7\'s VRS term is nonzero in a hover and maximal in a fast descent',
		atHover > 0.01 && atFast > atHover,
		`hover ${atHover.toFixed(3)}, 20 m/s descent ${atFast.toFixed(3)}`,
	);

	// quad.js's band, read off the model itself rather than re-derived.
	const p = new Propulsion({ profile: P, seed: 5 });
	const propwashAt = (vy) => {
		let r = null;
		for (let i = 0; i < 600; i++) {
			r = p.step([0.5, 0.5, 0.5, 0.5], { v: { x: 0, y: vy, z: 0 }, agl: null, shake: 0 }, 1 / 250);
		}
		const out = r.propwash;
		p.reset();
		return out;
	};
	const vh = ((p.profile.maxOmega * 0.5) * vhPerOmegaOf(P));
	check(
		'quad.js is zero at hover, rises through the band, and is gone past the windmill brake',
		propwashAt(0) === 0 && propwashAt(-4) > 0 && propwashAt(-30) === 0,
		`hover ${propwashAt(0)}, -4 m/s ${propwashAt(-4).toFixed(3)}, -30 m/s ${propwashAt(-30)}`
		+ ` (vh ~ ${vh.toFixed(1)} m/s)`,
	);
	check(
		'and kThrust is a real coefficient, not a curve fit: thrust goes as rpm squared',
		(() => {
			const kT = kThrustOf(P);
			return near(kT * P.maxOmega ** 2, P.maxThrustPerMotor, 1e-9);
		})(),
	);
}

console.log(`\n${failures ? `${failures} FAIL` : 'all PASS'}`);
process.exit(failures ? 1 : 0);

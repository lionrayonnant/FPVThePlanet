// Physical model of a multirotor: four motors, propeller aerodynamics, airframe
// drag and a lithium pack. No Rapier in here on purpose — this is the part worth
// testing headlessly and the part that decides how the thing feels.
//
// Everything is in SI units and in the body frame used by the rest of the sim
// (X = right, Y = up, Z = back; forward is -Z).
//
// The airframe itself is a `profile` from src/drone-profiles.js — one of six
// families (PHASE 07). The default profile, `QUAD`, is the 5" freestyle build
// (2207/2450KV on 4S, 5x4.3x3 tri-blades) that used to be hard-coded here, and
// its numbers are byte-for-byte the same. Where a coefficient was fitted rather
// than looked up, the observation it was fitted to is in that file's comments.
//
// ---------------------------------------------------------------------------
// WHAT THIS FILE TAKES FROM SPEC_PHYSIQUE_VOL.md, AND WHAT IT REFUSES
//
// The spec's §7 (thrust) and §6.4 (vertical-speed thrust correction) are, term
// for term, a SECOND description of mechanisms this file already has. Written
// out:
//
//   spec term                              already here as
//   ------------------------------------   ----------------------------------
//   §7 ratio_poussee_par_diametre x disc    profile.maxThrustPerMotor, measured
//      area x (D / 3.29546*pitch)^1.5          per family (which folds in both
//                                              the diameter and the pitch)
//   §7 map(|v|, 0..20 -> 0.92..1.0)         inducedVelocity(), the edgewise
//      (thrust rises with airspeed)            branch — translational lift
//   §7 effective flux direction + AirGrip   kLateral rotor drag, which was
//      (the disc bites sideways)               fitted to the observed in-plane
//                                              force and contains it already
//   §7 vrs = map(...) x map(PropSize) x ... `propwash`, as a BAND in units of
//                                              the rotor's own vh
//   §6.4 1 + RelativeAirSpeed * lerp(...)   the axial branch of the same
//      (climbing into your own column)         inducedVelocity() term
//
// The spec lists "measuring the same mechanism twice" among its own classic
// errors (§13), and this file has already paid that bug once (issue #71, where
// one dial named kAxial was doing two unrelated jobs). So NONE of the five is
// added. Each is kept where it is, in the form that was derived from momentum
// theory and gated by a bench, and §7's own composition is implemented instead
// as a reference model in tools/thrust-model-selftest.mjs, where it measures
// the profiles rather than moving them. §14.1 calls §7's weighting an open
// point, which is a further reason not to put it in the force path.
//
// What §L5 DOES take, because this file had nothing for it: modulated gravity
// (§8.1), the shape of ground effect (§8.4), the live air density and the
// drag-scale hook (§8.3). Each is commented where it lands.
// ---------------------------------------------------------------------------

import { Turbulence, mulberry32 } from './wind.js';
import { DEFAULT_PROFILE } from './drone-profiles.js';
import { propLossFactor, motorConstants, stepMotor, steadyOmega, dutyForOmega } from './motor.js';
import { Battery, PACK_DRAINS } from './battery.js';
import { airDensity } from './air.js';
import { dragScaleByDiameter } from './curves.js';
import { geometryOf, rotorForces } from './blade-element.js';

// Sea level, and the density the ROTOR coefficients are non-dimensionalised
// against (kInflow, kBuffet, vhPerOmega). Those are built once per airframe, so
// making them follow the air the craft is currently in would mean rebuilding
// them every step for a law that is still flat. Airframe drag, the one term
// where density is a plain multiplier, does read the live value — see step().
// When airDensity() stops being constant, this is the line to revisit.
const AIR_DENSITY = airDensity(0);
export const GRAVITY = 9.81;

// The spec's bounded linear remap, `map(x, a..b -> c..d)` (§0.3). `b` may lie
// BELOW `a` — §8.1 relies on exactly that — and the clamp still holds at both
// ends, because it is applied to the normalised parameter and not to x.
export function map(x, a, b, c, d) {
	if (a === b) return x < a ? c : d;
	const t = (x - a) / (b - a);
	return c + (d - c) * (t < 0 ? 0 : t > 1 ? 1 : t);
}

// The default airframe. Callers that want a specific family pass its profile to
// `new Propulsion({ profile })` / the FlightController / Physics instead.
export const QUAD = DEFAULT_PROFILE;

// Prop DIAMETER in inches. Four of the spec's curves are indexed by `PropSize`,
// which is a diameter in inches; this file stores a radius in metres.
export function propInchesOf(profile = QUAD) {
	return (2 * profile.propRadius) / 0.0254;
}

// §8.3's `echelle_trainee`: what the spec thinks a family's drag scale should
// be, from its prop diameter alone. NOT applied automatically — `bodyDrag` is
// measured per family and already contains the size it was measured at, so
// multiplying by this on top would be the same quantity counted twice. It is
// exported so a family with no measurement has the spec's number to start
// `profile.dragScale` from, and so a bench can print the two side by side.
export function specDragScaleOf(profile = QUAD) {
	return dragScaleByDiameter.eval(propInchesOf(profile));
}

export function hoverThrust(profile = QUAD) { return profile.mass * GRAVITY; }
export const HOVER_THRUST = hoverThrust(QUAD);
// The "throttle cut" stick (PHASE 14), derived rather than chosen. Static
// thrust of one motor follows omega = omegaMax * cmd^rpmCurve (see Propulsion
// below) and thrust is proportional to omega^2, so total thrust(cmd) = 4 *
// maxThrustPerMotor * cmd^(2*rpmCurve). Below the stick where that thrust falls
// to half the weight, the machine accelerates downward at 0.5 g or more: that
// is no longer flying close to the ground, it is a landing in progress, whatever
// stick the pilot still happens to be holding. Solve cmd for thrust = weight / 2:
//   cmd = ((mass * g) / (8 * maxThrustPerMotor)) ^ (1 / (2 * rpmCurve))
// (the 8 rather than hoverThrust's 4 is that factor 1/2 on the target weight).
// Values per family: freestyle5 0.143 - race5 0.106 - cinewhoop 0.250 -
// longrange 0.185 - heavy5 0.169 - toothpick 0.231 — all well under the same
// family's hover stick (hoverStick, tools/selftest.mjs).
// Rotor speed that makes a given thrust, inverted through the prop-loss factor.
//
// `T = kThrust * loss(w) * w^2` has no closed form once `loss` depends on w, so
// it is a fixed point: start from the square-law answer and divide by the loss
// at that speed. `loss` is smooth and between ~1 and ~1.3 over the whole range,
// iterated to convergence rather than a fixed count, because the duty round
// trip through it is asserted at 1e-9 and three passes left 1.8e-6. Not in the
// per-step path.
export function omegaForThrust(profile, thrustPerMotor) {
	const k = kThrustOf(profile);
	if (!(thrustPerMotor > 0) || !(k > 0)) return 0;
	let w = Math.sqrt(thrustPerMotor / k);
	for (let i = 0; i < 40; i++) {
		const f = propLossFactor(profile, w);
		const next = f > 0 ? Math.sqrt(thrustPerMotor / (k * f)) : w;
		const moved = Math.abs(next - w);
		w = next;
		if (moved <= 1e-13 * (1 + w)) break;
	}
	return w;
}

export function idleThrottle(profile = QUAD) {
	// Solved through the motor (src/motor.js) rather than by inverting
	// cmd^(2*rpmCurve) by hand: rpm comes from a torque balance now, and that
	// power law was only ever an approximation of it.
	const c = motorConstants(profile);
	const omega = omegaForThrust(profile, (profile.mass * GRAVITY) / 2 / 4);
	return dutyForOmega(c, omega, profile.battery.cells * 4.2);
}

// Measured contact forces: gentle landing ~290N, 10 m/s touchdown ~1600N,
// 25 m/s into a building ~2450N. 1500 lets you land and bump walls, but calls
// slamming into something a crash.
export const CRASH_IMPULSE = 1500;

// Landing flat (belly down): arms and props take the hit, so it takes a lot
// more to break. ~16 m/s of vertical descent survives.
export const CRASH_IMPULSE_FLAT = 2800;

// A quad that arrives flat takes the hit: arms and props absorb it. Nose first
// or on its back it breaks more easily — so the threshold follows the attitude
// at the moment of impact (upY near 1 = flat/upright, near -1 = inverted).
export function crashThreshold(rotation) {
	const upY = 1 - 2 * (rotation.x * rotation.x + rotation.z * rotation.z);
	return upY > 0.4 ? CRASH_IMPULSE_FLAT : CRASH_IMPULSE;
}

// Motor layout in Betaflight order: 1 rear-right, 2 front-right, 3 rear-left,
// 4 front-left. spin = +1 for counter-clockwise seen from above (a positive
// rotation about body +Y), and diagonal pairs share a direction so the drag
// torques cancel in a hover.
export function motorsOf(profile = QUAD) {
	return [
		{ x: +profile.armX, z: +profile.armZ, spin: +1 },   // rear right
		{ x: +profile.armX, z: -profile.armZ, spin: -1 },   // front right
		{ x: -profile.armX, z: +profile.armZ, spin: -1 },   // rear left
		{ x: -profile.armX, z: -profile.armZ, spin: +1 },   // front left
	];
}

// Mixer coefficients, derived from the motor geometry rather than written out,
// so moving a motor cannot silently desynchronise the controller from physics.
//   roll  right = -omega.z   ->  right motors down, left motors up
//   pitch up    = +omega.x   ->  front motors up, rear motors down
//   yaw   left  = +omega.y   ->  spin-down motors up (reaction is opposed)
export function mixOf(profile = QUAD) {
	return motorsOf(profile).map((m) => ({
		roll: m.x / profile.armX,
		pitch: -m.z / profile.armZ,
		yaw: -m.spin,
	}));
}

export function kThrustOf(profile = QUAD) {
	return profile.maxThrustPerMotor / (profile.maxOmega * profile.maxOmega);
}

function diskAreaOf(profile) {
	return Math.PI * profile.propRadius * profile.propRadius;
}

// A rotor's local axial velocity difference dv changes its thrust by roughly
// coefficient*omega*dv (momentum-theory inflow slope). That one mechanism
// used to be measured twice under one name, `kAxial`: once for climb thrust
// loss (kInflowOf below) and once for the turbulence-buffet damping torque
// (kBuffetOf below) — two unrelated jobs sharing one dial, so rescaling it by
// disk size for one job broke the other (issue #71, commit fcfa19a).
//
// Non-dimensionalizing kAxial's old per-family values against
// sqrt(2*rho*diskArea*kThrust) — the actual inflow-slope scale from actuator
// disk theory — shows freestyle5/race5/longrange/heavy5 (propRadius 6.4-8.9
// cm, 0.55-0.92 kg) agree on the same constant (~0.169) to within 2%: the
// sim's implicit formula was already right in form, just never written down.
// Only smaller disks (cinewhoop, toothpick) need a correction, carried below
// in `inflowGain`/`buffetGain` — that missing correction, and nobody knowing
// how much more of it a ~34 g/~20 mm-prop craft would need, is why the
// prototyped 1S tinywhoop was pulled from PHASE 07.
// How far into a descent the linear axial inflow term stays applicable, in
// multiples of the rotor's own hover induced velocity vh. 2 is the windmill
// brake boundary: for Vc <= -2*vh momentum theory has a solution again, and
// between there and zero it has none at all (the vortex ring state, carried
// here by `propwash`). Beyond that boundary a first-order slope fitted around
// hover is not evidence of anything, so it stops growing. See its use in
// step().
const AXIAL_INFLOW_LIMIT = 2;

// The vortex ring band, in multiples of the rotor's hover induced velocity vh.
// ONSET and PEAK are freestyle5's old absolute 2 and 8 m/s divided by its own
// 7.17 m/s hover vh, so the reference airframe keeps the behaviour it was
// tuned to and every other family scales off its own disc. END is the windmill
// brake boundary: past it the flow through the disc is fully established and
// no ring can form, so the loss must be gone rather than saturated. LATERAL_IN
// / LATERAL_OUT are the same treatment of the sideways escape (2 and 8 m/s):
// translating fast enough leaves your own column behind.
const VRS_ONSET = 2 / 7.17;
const VRS_PEAK = 8 / 7.17;
const VRS_END = AXIAL_INFLOW_LIMIT;
const VRS_LATERAL_IN = 2 / 7.17;
const VRS_LATERAL_OUT = 8 / 7.17;

export const INFLOW_K0 = 0.169;
const BUFFET_K0 = INFLOW_K0;

// kLateral (rotor/body drag -> yaw damping) is one job, not two, and its own
// ratio to disk area is already tight across the same four families
// (~3.6-4.1e-3); non-dimensionalizing it the same way removes its last
// "no formula" complaint without needing a split.
const LATERAL_K0 = 3.95e-3;

export function kInflowOf(profile = QUAD) {
	const base = Math.sqrt(2 * AIR_DENSITY * diskAreaOf(profile) * kThrustOf(profile));
	return INFLOW_K0 * base * (profile.inflowGain ?? 1);
}

export function kBuffetOf(profile = QUAD) {
	const base = Math.sqrt(2 * AIR_DENSITY * diskAreaOf(profile) * kThrustOf(profile));
	return BUFFET_K0 * base * (profile.buffetGain ?? 1);
}

// Fraction of one rotor's thrust that propwash turbulence displaces, at full
// propwash. Calibrated on the historical behaviour: 0.05 N.m on freestyle5 at
// hover (thrust 1.594 N per motor, arm 0.078 m) gives 0.05 / (1.594 * 0.078) =
// 0.402. See the use in step() for what this scaling fixes (issue #144).
export const PROPWASH_TORQUE_FRAC = 0.402;

export function kLateralOf(profile = QUAD) {
	return LATERAL_K0 * diskAreaOf(profile) * (profile.lateralGain ?? 1);
}

// Hover induced velocity per unit rpm: vh = omega * sqrt(kThrust / (2*rho*A)),
// straight out of momentum theory (T = 2*rho*A*vh^2 with T = kThrust*omega^2).
// Precomputed once per airframe; it is the only scale the inflow below needs.
export function vhPerOmegaOf(profile = QUAD) {
	return Math.sqrt(kThrustOf(profile) / (2 * AIR_DENSITY * diskAreaOf(profile)));
}

// Glauert's induced velocity for a rotor in EDGEWISE flight, in closed form.
//
// The disc equation v_i * sqrt(Vx^2 + v_i^2) = vh^2 is a quadratic in v_i^2, so
// there is no reason to iterate for it — and every reason not to, at 250 Hz.
// Solving x*(Vx^2 + x) = vh^4 for x = v_i^2 and taking the positive root gives
//   v_i = sqrt( (sqrt(Vx^4 + 4*vh^4) - Vx^2) / 2 )
// which loses all its significant digits once Vx >> vh, precisely the fast
// forward flight this was added for. The conjugate form below is algebraically
// identical and numerically stable everywhere:
//   v_i = vh^2 * sqrt( 2 / (sqrt(Vx^4 + 4*vh^4) + Vx^2) )
//
// `vEdge2` is the SQUARED edgewise speed, because that is what the caller
// already has and squaring it back would only cost accuracy.
export function inducedVelocity(vh, vEdge2) {
	if (vh <= 0) return 0;
	// Hover and pure vertical flight are the common case AND the one that has to
	// come back unchanged to the last bit: the formula below does return vh
	// there, but only after a square root and a divide that cost it an ulp. Say
	// it exactly instead. Anything that used to hover still hovers identically.
	if (vEdge2 <= 0) return vh;
	const vh2 = vh * vh;
	return vh2 * Math.sqrt(2 / (Math.sqrt(vEdge2 * vEdge2 + 4 * vh2 * vh2) + vEdge2));
}

// Flapback is NOT here, and that is a decision (#103).
//
// A rotor in edgewise flight develops an in-plane force as well as a thrust,
// and the disc tilts back with it. That much is already in this file: with a
// flapping angle proportional to the advance ratio, the in-plane component of
// a tilted thrust has the same shape as the rotor drag `kLateral * w * v`
// below, which was fitted to observed behaviour and therefore contains both
// lumped together.
//
// #91 added the MOMENT of it, from two places — the hub moment of a rigid
// propeller, and the lever the in-plane forces never had, the discs sitting
// above the centre of mass. Both were removed again: flown, they made the
// airframe unusable (#103). Everything they add scales with airspeed, and both
// act across pitch and roll, so a held yaw at twice cruise speed rolled the
// craft at up to 79 % of the commanded yaw rate — measured by section 4 of
// tools/aero-selftest.mjs, which is the gate that was missing when they went
// in (the #144 gate holds the airframe in STILL air, where all of this is
// identically zero).
//
// There is also a modelling question to settle before any of it comes back: a
// rigid propeller does not tilt its disc, and a flapping one does not hand a
// hub moment to its hub. Taking the flapping picture for the force and the
// rigid picture for the moment looks like the same dissymmetry counted twice.
// Re-deriving that, and re-measuring what is left, is issue #91.

// The speed an airframe settles at when it is actually being flown: where the
// drag of a 35-degree nose-down attitude balances what it can push through the
// air. Derived rather than picked, so a bench that wants to ask a family about
// forward flight asks it about ITS forward flight and not a 5-inch's.
//
//   4*kLateral*w_hover*V + 0.5*rho*bodyDrag.z*V^2 = m*g*tan(35 deg)
//
// Rotor drag is linear in V and body drag quadratic, hence the quadratic; the
// positive root is the only physical one.
export function cruiseSpeedOf(profile = QUAD) {
	const wHover = Math.sqrt((profile.mass * GRAVITY) / 4 / kThrustOf(profile));
	const a = 0.5 * AIR_DENSITY * profile.bodyDrag.z;
	const b = 4 * kLateralOf(profile) * wHover;
	const c = -profile.mass * GRAVITY * Math.tan((35 * Math.PI) / 180);
	return (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
}

// Ground-effect reach as a multiple of propRadius, fixed to reproduce
// freestyle5's measured 0.22 m reach on its 0.0635 m prop exactly, so every
// other family's reach scales off its own disk instead of freestyle5's.
//
// THE SPEC SAYS THE OPPOSITE, and the disagreement is deliberate. §8.4 fixes
// the reach at 70 cm for every size and varies the STRENGTH with `PropSize`;
// this file fixed the strength at +18 % and varied the reach with the disc. A
// fixed 70 cm reach holds a 31 mm rotor in ground effect over twenty times its
// own diameter, which is why the reach was made proportional in the first
// place. What L5 takes from §8.4 is its SHAPE — see `groundEffectStrength`
// below and the `ground` term in step() — while the reach stays proportional.
const GROUND_EFFECT_REACH_RATIO = 0.22 / 0.0635;

// §8.4's two strength modulations, kept: the prop-size ramp, and the cell
// voltage. A pack at 3.4 V/cell pushes less air than a fresh one, so its
// cushion is weaker — the spec is right about that and this file had nothing
// for it. The base is DERIVED, not typed: it is whatever makes a full pack on
// a 5" disc come out at exactly the +18 % this file has always used, so the
// reference airframe keeps the feel it was tuned to and only the scaling
// between families changes. Same rule as INFLOW_K0 and the VRS band.
const GROUND_EFFECT_PROP_SIZE = (inches) => map(inches, 2, 7, 0.3, 1.1);
const GROUND_EFFECT_BASE = 0.18 / GROUND_EFFECT_PROP_SIZE(5);

export function groundEffectStrength(profile = QUAD, cellVolts = 4.2) {
	return GROUND_EFFECT_BASE
		* GROUND_EFFECT_PROP_SIZE(propInchesOf(profile))
		* map(cellVolts, 1.0, 4.2, 0, 1);
}

// ---------------------------------------------------------------------------
// Modulated gravity, spec §8.1 (PhysicsVersion V2).
//
// The drone is pulled down by 7 to 15 % MORE than its weight while it is level
// or climbing, and by exactly its weight once it is falling fast. The spec is
// explicit that this is a feel choice and not a correction: it is what gives a
// quad its sense of mass without making it sluggish to drop.
//
// Three things about how it is wired, all of them load-bearing:
//
//   - it is NOT Rapier's gravity. The solver keeps the one true g. This is an
//     explicit extra force with its own post in Physics.forceBudget()
//     (`gravityTrim`), because a budget that cannot see a force is a budget
//     that lies, and the thrust-split invariant asserted there
//     (staticThrust + inflow + groundEffect - vortexRing == thrust) must keep
//     holding — which it does, this adding nothing to the thrust split;
//   - it reads WORLD vertical speed, not body. Gravity has no idea which way
//     the airframe is pointing, and the spec's `vitesse.z` here is the body's
//     velocity in the world, not the projection on `axeHaut` that §6.4 goes
//     out of its way to define separately;
//   - it is switchable per instance (`setGravityTrim`), because it is the one
//     term in this file that is a taste and not a measurement.
//
// Units: the spec's `b` is in cm/s (-800..-1390), so -8.0..-13.9 m/s here.
// `a`'s mass term maps 1.5..6 kg, which is above every family in this sim, so
// it contributes exactly zero and is kept only so the formula reads the same.
export function gravityTrimFactor(profile = QUAD, worldVerticalSpeed = 0) {
	const inches = propInchesOf(profile);
	const a = map(inches, 2, 6, 1.15, 1.072) + map(profile.mass, 1.5, 6, 0, 0.1);
	const b = map(inches, 2, 5, -8.0, -13.9);
	return map(worldVerticalSpeed, 0, b, a, 1.0);
}

// `?aero=` — which rotor model the thrust comes out of.
//
//   classic  kThrust*w^2 with a first-order inflow correction. The DEFAULT,
//            the model every PID gain in drone-profiles.js was tuned against,
//            and bit-identical to what shipped before this flag existed.
//   bem      src/blade-element.js, integrated over the blade. NOT TUNED: it
//            moves thrust, torque and the in-plane force at once, and the six
//            tunes belong to `classic`. A dev switch, nothing more, until an
//            edgewise data source exists to check its one unverified term.
//
// The rule lives here rather than in tools/dev-flags.mjs because it belongs
// beside the model it selects — the same reason `?loop=`'s rule lives in
// frame-pacing.js beside the accumulator it substeps. Unlike `?swarm=` it
// FALLS BACK rather than throwing: an unknown value cannot produce a machine
// the game could not otherwise fly, it just gets the default one.
export const AERO_MODELS = ['classic', 'bem'];
export const AERO_DEFAULT = 'classic';
export function parseAeroFlag(raw) {
	return AERO_MODELS.includes(raw) ? raw : AERO_DEFAULT;
}

// Default for new Propulsion instances. One switch, because turning this off
// is how you answer "is the machine heavy or is the model wrong?".
export const GRAVITY_TRIM_DEFAULT = true;

// Compat exports for the handful of consumers that only ever want the default
// airframe (audio.js panning, tools reporting).
export const MOTORS = motorsOf(QUAD);
export const MIX = mixOf(QUAD);

// ---------------------------------------------------------------------------
// The pack lives in src/battery.js now. Re-exported here because quad.js was
// its home and several tools import it from this module.
export { Battery, PACK_DRAINS };

// ---------------------------------------------------------------------------

export class Propulsion {
	// Seeded rather than left on Math.random: the shake below is the only
	// nondeterminism in the flight model, and without a seed two runs of
	// tools/selftest.mjs differ from each other, which makes a regression
	// indistinguishable from noise.
	constructor({ profile = QUAD, seed = 0x5eed, aero = AERO_DEFAULT } = {}) {
		this.profile = profile;
		// Which rotor model step() asks for a thrust (see parseAeroFlag above).
		this.aero = parseAeroFlag(aero);
		// The blade, resolved once per airframe — geometryOf() runs a nested
		// bisection and has no business in a 250 Hz loop. Null on the default
		// path, where it is never read and never built.
		this._blade = this.aero === 'bem' ? geometryOf(profile) : null;
		this._motors = motorsOf(profile);
		this._mix = mixOf(profile);
		this._kThrust = kThrustOf(profile);
		this._kInflow = kInflowOf(profile);
		this._kBuffet = kBuffetOf(profile);
		this._kLateral = kLateralOf(profile);
		this._vhPerOmega = vhPerOmegaOf(profile);
		this._motor = motorConstants(profile);
		this.seed = seed >>> 0;
		this._rng = mulberry32(this.seed);
		this.battery = new Battery(profile.battery);
		this.omega = [0, 0, 0, 0];
		this.thrust = [0, 0, 0, 0];
		this.propwash = 0;
		// Net rotor angular momentum about body +Y, N.m.s. Read by the tests and
		// worth having by name: it is zero for every symmetric stick input and
		// only wakes up under yaw or motor saturation.
		this.hRotor = 0;
		// Band-limited noise for the two things that shake the airframe without
		// the pilot asking: its own downwash, and the air it is flying through.
		// The wind that produces the second one is not modelled here — quad.js
		// has no world frame — it arrives as `shake` in step().
		this._wash = [new Turbulence(14, this._rng), new Turbulence(14, this._rng), new Turbulence(14, this._rng)];
		this._buffet = [new Turbulence(6, this._rng), new Turbulence(6, this._rng), new Turbulence(6, this._rng)];
		// Filled in by step(); read by the HUD and the tests.
		this.force = { x: 0, y: 0, z: 0 };
		// Where force.y came from, mechanism by mechanism. Diagnostics only —
		// nothing in the flight model reads it. See Physics.forceBudget().
		this.diag = {
			// Which rotor model wrote the split below. On 'bem' the blade has no
			// static/inflow halves to report and `staticThrust` carries the whole
			// magnitude — see the call site in step().
			model: this.aero,
			staticThrust: 0, inflow: 0, groundEffect: 0, vortexRing: 0, thrust: 0,
			bodyDrag: { x: 0, y: 0, z: 0 }, rotorDrag: { x: 0, z: 0 },
		};
		this.torque = { x: 0, y: 0, z: 0 };
		// Modulated gravity (§8.1). `gravityTrim` is the surplus as a fraction
		// of weight (0 = plain g); `extraGravity` is that surplus in newtons,
		// along WORLD -Y. It is deliberately not in `force`, which is body
		// frame: the caller applies it in the world, unrotated. See the block
		// above gravityTrimFactor().
		this.gravityTrimEnabled = GRAVITY_TRIM_DEFAULT;
		this.gravityTrim = 0;
		this.extraGravity = 0;
	}

	// Modulated gravity on or off for this airframe. Returns `this`, like
	// Battery.setDrain, so a bench can chain it onto the constructor.
	setGravityTrim(enabled) {
		this.gravityTrimEnabled = enabled !== false;
		return this;
	}

	reset() {
		this.battery.reset();
		this.omega.fill(0);
		this.thrust.fill(0);
		this.propwash = 0;
		this.hRotor = 0;
		// Not `gravityTrimEnabled`: like Battery.drain, that is a setting for
		// the session and a respawn must not hand it back silently.
		this.gravityTrim = 0;
		this.extraGravity = 0;
		// Filter state and the noise stream too: without this a respawn lands in
		// the middle of whatever the airframe was doing when it hit the ground,
		// and no two runs of the same test are comparable.
		this._rng = mulberry32(this.seed);
		for (const t of [...this._wash, ...this._buffet]) { t.rng = this._rng; t.reset(); }
	}

	// Sets omega/thrust straight to their steady-state value for a throttle
	// command, skipping the motor-lag ramp step() normally applies — so a
	// drone that starts (or respawns) already in flight doesn't show stopped
	// props and silent audio on its first frame (PHASE 13). Ground effect and
	// axial inflow are left out on purpose: those need real airspeed/agl, and
	// the very next step() call folds them in anyway.
	primeFor(cmd) {
		const w = steadyOmega(this._motor, clamp01(cmd), this.battery.voltage);
		// Through the same rotor model step() will use, or the priming thrust
		// would be the other model's answer for one frame. Still air, no inflow:
		// that is what this function is for, and it is exactly the operating
		// point rotorForces() is calibrated on.
		const t = this._blade
			? rotorForces(this._blade, w, 0, AIR_DENSITY, 0).thrust
			: Math.max(0, this._kThrust * propLossFactor(this.profile, w) * w * w);
		for (let i = 0; i < 4; i++) {
			this.omega[i] = w;
			this.thrust[i] = t;
		}
	}

	get rpm() { return this.omega.map((w) => (w * 60) / (2 * Math.PI)); }

	// motors: four commands in 0..1, straight from the mixer.
	// air:    what the airframe is flying through, all in the body frame —
	//           v      velocity through the air, m/s (NOT ground speed)
	//           omega  body rates, rad/s, used for the per-motor inflow below
	//           agl    height above whatever is directly below, m, null if unknown
	//           shake  size of the air's own fluctuation, m/s, 0 in still air
	//           worldVy  vertical speed in the WORLD, m/s, for §8.1's modulated
	//                  gravity only. Not an airspeed and not body frame: see the
	//                  block above gravityTrimFactor(). Absent means 0, which is
	//                  the at-rest value, so a bench that never moves gets the
	//                  right answer by doing nothing.
	//           altitude  metres above sea level, for airDensity() (§8.3).
	//                  Absent means sea level. The value changes nothing today
	//                  and that is the point — the spec requires the argument to
	//                  travel now so a barometric law lands without touching a
	//                  single call site.
	//
	// Returns body-frame {force, torque}; the caller rotates them into the world.
	// `extraGravity` is set alongside and is NOT part of `force`: it is already
	// a world-frame quantity.
	step(motors, air, dt) {
		const vBody = air.v;
		const omega = air.omega ?? ZERO_RATE;
		const agl = air.agl ?? null;
		const shake = air.shake ?? 0;
		const bat = this.battery;
		const P = this.profile;

		// §8.1. Computed first so that it is a function of the step's INPUT
		// state, like every other force here, rather than of whatever the
		// thrust loop below happens to leave behind.
		this.gravityTrim = this.gravityTrimEnabled
			? gravityTrimFactor(P, air.worldVy ?? 0) - 1
			: 0;
		this.extraGravity = this.gravityTrim * P.mass * GRAVITY;

		// Descending into your own downwash: the disc is eating turbulent air it
		// already threw down, so it loses thrust and the airframe shakes. Moving
		// sideways fast enough gets you out of the column, which is why propwash
		// only bites on hard vertical stops and tight corners.
		// Two things were wrong with the old form
		// `clamp01((descent - 2) / 6) * clamp01((8 - lateral) / 6)`.
		//
		// First, its thresholds were in ABSOLUTE m/s, the same for every family
		// — exactly the mistake kAxial already made once (issue #71). The
		// regime is set by the rotor's own induced velocity vh, and that spans
		// 5.3 m/s (toothpick) to 11.5 m/s (cinewhoop) across the six families,
		// so a fixed 2 m/s onset meant entering VRS at 0.38 vh on one airframe
		// and 0.17 vh on another — a factor of 2.2 on a threshold that is
		// supposed to be a property of the flow, not of the model.
		//
		// Second, and worse, it SATURATED and stayed there: once past 8 m/s of
		// descent the disc was held in full vortex ring state for ever, at 20
		// or 40 m/s alike. A vortex ring cannot exist there. Past Vd = 2*vh the
		// rotor is in the windmill brake state — the same boundary the axial
		// inflow term stops at, and for the same reason — where the flow is
		// fully established upward through the disc and smooth. The real curve
		// is a BAND, not a ramp: it rises from onset, peaks while the ring is
		// fully formed, and is gone by the windmill brake boundary.
		//
		// The band is in units of vh, with the ends chosen to reproduce
		// freestyle5's measured onset and peak exactly on its own 7.17 m/s
		// hover vh (2 and 8 m/s -> 0.279 and 1.116 vh) — the same rule the rest
		// of this file follows (INFLOW_K0, LATERAL_K0,
		// GROUND_EFFECT_REACH_RATIO): the reference airframe keeps the feel it
		// was tuned to, every other family scales off its own disc instead of
		// borrowing freestyle5's numbers.
		//
		// vh here is the rotor group's, from the PREVIOUS step's mean rpm — the
		// per-rotor vh is not known until the loop below, and `buffet` already
		// uses the same mean for the same reason. With the motors stopped there
		// is no downwash to descend into and no vh to divide by, hence the
		// guard.
		const lateral = Math.hypot(vBody.x, vBody.z);
		// Descending into your own wake, read in the DISC's frame: with the
		// rotors reversed (Acro3D) the wake is above and a climb is what falls
		// into it. `discDir` is 1 whenever the rotors turn the normal way, which
		// is every step of a forward flight, so `descent` is `-vBody.y` there.
		const discDir = this.omega[0] + this.omega[1] + this.omega[2] + this.omega[3] < 0 ? -1 : 1;
		const descent = discDir > 0 ? -vBody.y : vBody.y;
		// Same correction as the per-rotor vh below: the vortex-ring band is
		// normalised in units of induced velocity, so it has to use the same
		// induced velocity the thrust does or the band drifts against the flow it
		// describes.
		const wMeanRef = meanRotorSpeed(this.omega);
		const vhRef = wMeanRef * this._vhPerOmega
			* Math.sqrt(propLossFactor(this.profile, wMeanRef));
		if (vhRef <= 0) {
			this.propwash = 0;
		} else {
			const x = descent / vhRef;
			const band = x <= VRS_ONSET || x >= VRS_END
				? 0
				: x < VRS_PEAK
					? (x - VRS_ONSET) / (VRS_PEAK - VRS_ONSET)
					: (VRS_END - x) / (VRS_END - VRS_PEAK);
			const escape = clamp01(
				(VRS_LATERAL_OUT - lateral / vhRef) / (VRS_LATERAL_OUT - VRS_LATERAL_IN),
			);
			this.propwash = band * escape;
		}

		// Ground effect: the disc pushes against a surface it cannot displace, so
		// thrust rises. Reach is one rotor diameter-ish, scaled off THIS profile's
		// own disk (issue #71) instead of hard-coded to freestyle5's 0.22 m: a
		// fixed reach made a whoop's tiny disk feel ground effect over a distance
		// several times its own body size, holding idle thrust — and so descent
		// rate — pinned near hover far longer than a real ~34 g airframe would.
		//
		// The SHAPE is §8.4's now, on three counts. The strength is no longer a
		// global 0.18: it ramps with prop size and falls with cell voltage
		// (`groundEffectStrength`), so a big slow disc gets a bigger cushion
		// than a 2.5" one and a tired pack gets less of it. And the falloff is
		// the spec's LINEAR one, `(reach - d)`, rather than the exponential
		// this file used: an exponential still has a third of its gain left at
		// one full reach and never actually reaches zero, which is why "out of
		// ground effect" had no edge. Both forms agree at contact, which is
		// where the +18 % was measured, so freestyle5 on a full pack is
		// unchanged there and only loses the long tail.
		//
		// What is NOT taken from §8.4 is its `Throttle` factor: the gain here
		// multiplies the thrust already produced, so the throttle is in the
		// product once and putting it in twice would make the cushion vanish at
		// the low stick where a landing actually happens. No per-family
		// measurement exists yet for how much a duct changes any of this (left
		// as follow-up, same as before).
		// Strength from the spec (scaled by prop size and by cell voltage, both of
		// which §8.4 has and this file did not); decay kept EXPONENTIAL, which the
		// spec does not have. The two do not mix naively: §8.4's linear falloff
		// assumes its own fixed 70 cm reach, and laying it over this file's
		// MEASURED 0.22 m reach cuts a 5" off at 28 cm, where both the spec (70 cm)
		// and the bench (0.76% at 70 cm) still read lift. Exponential keeps the
		// measured reach as the e-fold and stays non-zero beyond it.
		const groundReach = GROUND_EFFECT_REACH_RATIO * P.propRadius;
		const ground = agl === null
			? 1
			: 1 + groundEffectStrength(P, bat.voltage / bat.cells)
				* Math.exp(-Math.max(0, agl - P.propRadius) / groundReach);

		// The live air density, hoisted out of the drag block below so the rotor
		// model can be handed the same air the airframe flies through. Flat
		// today (src/air.js), so `0.5 * rho` below is the same double that
		// `0.5 * airDensity(...)` was.
		const rho = airDensity(air.altitude ?? 0);

		let current = 0, thrustTotal = 0;
		let staticTotal = 0, inflowTotal = 0, groundExtra = 0, vrsLoss = 0;
		let tx = 0, ty = 0, tz = 0;
		let dragX = 0, dragZ = 0;
		// Net angular momentum of the four spinning rotors, about body +Y.
		let hRotor = 0;

		for (let i = 0; i < 4; i++) {
			const m = this._motors[i];

			// Each rotor sees its own air, not the centre of gravity's. Rolling
			// right, the left motors are climbing and the right ones descending,
			// so the left disc gets extra inflow and loses thrust while the right
			// gains it — a moment opposing the roll that no coefficient had to be
			// invented for. v_i = v + omega x r, with r = (m.x, 0, m.z).
			const vx = vBody.x + omega.y * m.z;
			const vy = vBody.y + omega.z * m.x - omega.x * m.z;
			const vz = vBody.z - omega.y * m.x;

			// Command -> steady-state rpm, then a first-order lag toward it. The
			// lag is the single biggest contributor to how a quad feels: it is
			// what separates "snappy" from "floaty", and making spin-down slower
			// than spin-up is what makes an inverted save genuinely hard.
			// The prop's own aerodynamic torque is what loads the motor, and it is
			// THIS rotor's real thrust from the previous step, not kQ*omega^2:
			// descending into your own wake loads the disc harder and the rpm
			// droops for it. One step of lag on a 4 ms grid, and a coupling the
			// old first-order lag could not express at all.
			const prev = this.omega[i];
			// Acro3D (§3.2): a reversible ESC is asked for a SIGNED command and
			// the shaft is allowed through zero. Nothing is plumbed in to say so
			// — the condition IS the command. A forward flight never produces a
			// negative command and never leaves a negative shaft behind, so
			// `bidir` is false on every step of it and both branches below
			// collapse to the arithmetic that was here before.
			const bidir = motors[i] < 0 || prev < 0;
			const spun = stepMotor(
				this._motor, prev, bidir ? clampPm1(motors[i]) : clamp01(motors[i]), bat.voltage,
				P.torqueRatio * Math.abs(this.thrust[i]), dt, bidir,
			);
			this.omega[i] = spun.omega;
			const w = spun.omega;
			// Which way this rotor turns, and its magnitude. `s` is 1 and `aw` is
			// `w` for every forward step, so every `s *` and every `aw` below is
			// the identity there.
			const s = w < 0 ? -1 : 1;
			const aw = s < 0 ? -w : w;
			const dOmega = (w - prev) / dt;
			current += spun.packCurrent;

			// Thrust: static term minus what the inflow takes away. Clamped at
			// zero rather than allowed to go negative — a prop windmilling
			// backwards is outside anything this model claims to cover.
			//
			// `dw` is the flow through the disc in excess of what a hover already
			// has, and it carries BOTH the axial term this model always had and
			// the edgewise one it never did. Writing it as one quantity is the
			// whole point: kInflow IS the actuator-disc inflow slope, so a second
			// coefficient for forward flight would be the same mechanism measured
			// twice — the mistake `kAxial` already made once (issue #71).
			//
			// The factor 2 is what makes this a generalisation rather than an
			// addition. In pure axial flight the exact momentum-theory solution
			//   v_i = -Vc/2 + sqrt(Vc^2/4 + vh^2)
			// puts the disc-normal flow at vh + Vc/2 to first order, i.e. an
			// excess of Vc/2 over hover — so the term this file has always
			// applied, -kInflow*w*Vc, is exactly -kInflow*w*(2 * excess). Keep
			// that 2 and the axial branch comes back bit for bit while the
			// edgewise branch falls out for free.
			//
			// DESCENT IS DELIBERATELY LEFT ALONE. Between -2*vh and 0 the
			// momentum theory has no solution at all — that is the vortex ring
			// state — and this file already models that regime empirically, as
			// `propwash` above. The separable form below only ever adds the
			// edgewise term, which is the one that was missing.
			// vh carries the SAME prop-loss factor as the thrust, under a square
			// root: hover induced velocity is sqrt(T / 2*rho*A), so if the blade
			// makes `loss` times the thrust at this rpm it also pushes the air
			// sqrt(loss) times as hard. Leaving vh on the bare square law was the
			// first thing tried and it broke the hover: the static term went up
			// 32% while the inflow that pays for it did not, and the analytic hover
			// stick came out 6% light. The momentum theory and the blade share one
			// disc; they have to be scaled together or not at all.
			const vEdge2 = vx * vx + vz * vz;
			// The disc's own axial direction, not the body's: a rotor turning
			// backwards blows the other way and a climb is a descent for it.
			// `s` is 1 on the whole forward path, so this is `vy` there.
			const vyDisc = s > 0 ? vy : -vy;

			// THE ROTOR MODEL'S ONE CALL SITE (?aero=).
			//
			// Both branches produce the same three quantities and nothing else:
			// `tBare`, a thrust MAGNITUDE along the rotor's own axis; `hx`/`hz`,
			// the in-plane force in the body frame; and the two diagnostic
			// halves. Everything that is not the rotor model — ground effect,
			// propwash, the spin sign `s`, the lever arms, the yaw reaction —
			// stays outside and applies to whichever magnitude came back. That
			// is what makes this a switch between models rather than two
			// physics.
			let tBare, hx, hz, staticDiag, inflowDiag;
			if (this._blade) {
				// BLADE ELEMENT (?aero=bem). NOT TUNED — see parseAeroFlag.
				//
				// Signed, and deliberately NOT clamped at zero: a blade the air
				// drives really does pull backwards, and refusing to say so is
				// the first of the three defects blade-element.js exists for.
				// Nothing downstream needs it positive — ground effect and the
				// propwash band are multipliers, and the lever arms do not care.
				//
				// The axial velocity goes in RAW. `AXIAL_INFLOW_LIMIT` bounds a
				// first-order slope evaluated far outside where a linear
				// expansion can claim anything; there is no slope here to bound,
				// the annulus solves its own momentum balance. What the blade
				// does NOT model is the vortex-ring state, which has no momentum
				// solution at all — `propwash` still answers for that, below,
				// exactly as it does for the classic model.
				const vEdge = Math.sqrt(vEdge2);
				const f = rotorForces(this._blade, aw, vyDisc, rho, vEdge);
				tBare = f.thrust;
				// The in-plane force comes out of the SAME integral as the
				// thrust — the advancing blade meets more flow than the
				// retreating one — so `kLateral` is not applied on top of it.
				// That would be the dissymmetry of lift counted twice, which is
				// the mistake `kAxial` already made once (issue #71), and it is
				// also why the translational rotor MOMENTS are not added back
				// here: the same mechanism, and the one that made the airframe
				// unusable in flight (#103).
				//
				// Resolved along the edgewise flow, which is undefined when
				// there is none — hence the guard, not a special case: at
				// vEdge = 0 the azimuthal sum is zero by symmetry anyway.
				if (vEdge > 0) {
					hx = (f.hForce * vx) / vEdge;
					hz = (f.hForce * vz) / vEdge;
				} else {
					hx = 0;
					hz = 0;
				}
				// The blade does not HAVE a static term and an inflow
				// correction: it has one integral, and the flow through the disc
				// is inside it. Rather than invent a split — a second
				// rotorForces() call at zero inflow, per rotor per step, to
				// produce a number nothing in the model uses — the whole
				// magnitude is reported as the static half and the inflow half
				// reads zero. The budget's invariant (the split sums back to the
				// force) holds either way; `diag.model` below says which model
				// wrote it, so nobody reads `staticThrust` here as meaning what
				// it means on the default path.
				staticDiag = tBare;
				inflowDiag = 0;
			} else {
				const vh = aw * this._vhPerOmega * Math.sqrt(propLossFactor(P, aw));
				// The axial part of `dw` is a FIRST-ORDER slope — the comment above
				// derives it as such, from the Vc/2 excess that momentum theory gives
				// "to first order". Unbounded, it was being evaluated at Vc/vh as far
				// out as -3.5 in a fast descent, several times past anything a linear
				// expansion can claim. The consequence was backwards: at a held hover
				// throttle the quad produced 0.92x its weight at 8 m/s of descent but
				// 1.23x at 25 m/s, so the faster it fell the harder it pushed back.
				// It refused to fall, which is the "it floats, it has no weight"
				// the pilot reports — and `propwash` could not answer for it, being
				// saturated from 8 m/s onwards.
				//
				// The bound is the windmill-brake boundary Vc = -2*vh, not a chosen
				// number: it is where momentum theory has a valid solution again
				// (between it and zero lies the vortex ring state, which has none and
				// which this file models empirically as `propwash`). Past it, the
				// linear term stops growing instead of running away.
				//
				// ONLY the descent side of the axial term is clamped. Hover (vy = 0),
				// climb, and the edgewise term — translational lift, the whole point
				// of inducedVelocity() — come through untouched and bit-identical.
				const vyAxial = Math.max(vyDisc, -AXIAL_INFLOW_LIMIT * vh);
				const dw = vyAxial + 2 * (inducedVelocity(vh, vEdge2) - vh);
				// Prop losses (src/motor.js): a blade tip approaching Mach and a pitch
				// away from its design point stop making lift. Normalised at maxOmega,
				// so full-throttle thrust — and with it maxThrustPerMotor, the
				// thrust-to-weight and the top speed — is unchanged, and only the SHAPE
				// of the curve below it moves. It moves the right way: a real propeller
				// sits above the square law at part throttle and flattens at the top.
				// Everything from here to `t` is the rotor's own frame: a MAGNITUDE
				// of thrust along its own axis, which `s` then puts back on the
				// body. That is the whole of §3.2's `si (Throttle < 0) Poussee =
				// -Poussee` — not a second thrust law, the same one read the other
				// way up. With s = 1 and aw = w these are the original expressions,
				// operation for operation.
				const tStatic = this._kThrust * propLossFactor(P, aw) * aw * aw;
				const tInflow = -this._kInflow * aw * dw;
				const t0 = tStatic + tInflow;
				tBare = Math.max(0, t0);
				staticDiag = tStatic;
				inflowDiag = tBare - Math.max(0, tStatic);
				// Rotor drag: the disc resists translation in proportion to rpm,
				// fitted to the observed in-plane force and carrying the flapback
				// with it (see the block above cruiseSpeedOf). A disc resists
				// translation the same however it is turning, so this is the
				// magnitude. `aw` is `w` on the forward path.
				hx = -this._kLateral * aw * vx;
				hz = -this._kLateral * aw * vz;
			}
			let t = s * (tBare * ground * (1 - 0.22 * this.propwash));
			this.thrust[i] = t;
			thrustTotal += t;
			// Diagnostics, not physics: the same thrust split into where it came
			// from, so a force budget can say which mechanism is holding the
			// machine up. Five adds per rotor against a loop that already does
			// two square roots — see Physics.forceBudget().
			// Signed with the rotor, like `t` itself, so the split still sums
			// back to the force when a rotor is pushing the other way.
			staticTotal += s * staticDiag;
			inflowTotal += s * inflowDiag;
			groundExtra += s * (tBare * (ground - 1) * (1 - 0.22 * this.propwash));
			vrsLoss += s * (tBare * ground * 0.22 * this.propwash);

			// Roll and pitch torque come out of where the motors are, not out of
			// a coefficient: tau = sum(r x F) with F along body +Y.
			tx += -m.z * t;
			tz += m.x * t;

			// Yaw is the reaction to prop drag torque, opposed to the spin, plus
			// the reaction to spinning the prop up. That second term is small in
			// steady state and dominant in a snap — it is why yaw is crisp on a
			// quad despite yaw having the most inertia.
			ty += -m.spin * (P.torqueRatio * t + P.propInertia * dOmega);

			// Rotor drag: the disc resists translation in proportion to rpm. Once
			// the four discs see different air, their drag forces differ too, and
			// four different horizontal forces at four different places is a yaw
			// moment: tau_y = r_z*F_x - r_x*F_z. Under yaw rate it comes out
			// opposing the rotation, which is the aerodynamic yaw damping a real
			// quad has and this model did not.
			// Whichever model produced it, above.
			const dx = hx;
			const dz = hz;
			dragX += dx;
			dragZ += dz;
			ty += m.z * dx - m.x * dz;


			hRotor += m.spin * P.propInertia * w;
		}

		// Gyroscopic precession of the rotor group. The rotors carry angular
		// momentum H about body +Y, and in a rotating frame that costs a torque
		// -omega x H — tilt a spinning disc and it pushes back ninety degrees
		// round.
		//
		// This is NOT the propInertia term already in the yaw sum above. Writing
		// the rotor contribution to dL/dt in the body frame gives two pieces:
		// dH/dt, the reaction to spinning a prop up, which is that yaw term; and
		// omega x H, the precession, which is this one. Complementary, not
		// redundant — one needs the rpm to be CHANGING, the other only needs it
		// to be nonzero.
		//
		//   -omega x (0, H, 0) = (H*omega.z, 0, -H*omega.x)
		//
		// so it is pure roll<->pitch and touches yaw not at all, which it must
		// not, H being along Y.
		//
		// Worth knowing what this does and does not produce. On a symmetric X,
		// sum(spin_i * omega_i) is EXACTLY zero for a pure roll command and for
		// a pure pitch command, whatever the rpm curve: the two motors handed
		// +delta carry opposite spins, and so do the two handed -delta. H is
		// nonzero only under yaw, under motor saturation, and for a drawn
		// specimen whose props do not match. So what this adds is precisely what
		// a pilot reports: yaw while rolling and the nose moves.
		//
		// It cannot destabilise anything by adding energy — tau . omega =
		// -(omega x H) . omega is identically zero, so the term does no work.
		// What it can do is be integrated badly: an explicit step amplifies a
		// rotation at H/sqrt(Ix*Iz) by sqrt(1 + (rate*dt)^2) per step. That
		// product is checked per family in tools/aero-selftest.mjs.
		this.hRotor = hRotor;
		tx += hRotor * omega.z;
		tz -= hRotor * omega.x;

		bat.update(current, dt);

		// Airframe drag, quadratic and anisotropic in the body frame (§8.3).
		//
		// Density is the LIVE one: this is the single term where it is a plain
		// multiplier, so it is the one place an altitude law can land for free.
		// It is flat today, so no number moves — see the AIR_DENSITY comment at
		// the top for why the rotor coefficients do not do the same.
		//
		// `dragScale` is §8.3's `echelle_trainee` hook, applied to all three
		// axes. It defaults to 1 for every family, and that is not laziness:
		// `bodyDrag` was MEASURED per family and already contains the size it
		// was measured at, so evaluating the curve here as well would be the
		// prop diameter counted twice. `specDragScaleOf()` hands the curve's
		// value to whoever has to fill the field in for an unmeasured family.
		//
		// The anisotropy is the measured one and NOT §8.3's (1, 1, 0.93). The
		// spec has the vertical axis dragging 7 % LESS than the horizontal
		// ones; every family here measures it dragging two to three times MORE
		// (0.028 against 0.010 on freestyle5), which is what a flat plate of a
		// quad does when it is dropped. 0.93 is the divergence L5 refuses: a
		// ratio measured per family beats a constant, and the spec offers no
		// measurement behind it.
		const q = 0.5 * rho;
		const ds = P.dragScale ?? 1;
		const bx = -q * P.bodyDrag.x * ds * Math.abs(vBody.x) * vBody.x;
		const by = -q * P.bodyDrag.y * ds * Math.abs(vBody.y) * vBody.y;
		const bz = -q * P.bodyDrag.z * ds * Math.abs(vBody.z) * vBody.z;

		this.force.x = dragX + bx;
		this.force.y = thrustTotal + by;
		this.force.z = dragZ + bz;

		// The body-frame breakdown behind force.y, for the force budget. By
		// construction staticThrust + inflow + groundEffect - vortexRing is
		// thrustTotal exactly, which Physics asserts rather than assumes.
		const d = this.diag;
		d.model = this.aero;
		d.staticThrust = staticTotal;
		d.inflow = inflowTotal;
		d.groundEffect = groundExtra;
		d.vortexRing = vrsLoss;
		d.thrust = thrustTotal;
		d.bodyDrag = { x: bx, y: by, z: bz };
		d.rotorDrag = { x: dragX, z: dragZ };

		if (this.propwash > 0.01) {
			// Turbulent thrust across the disc is uneven, so the airframe gets
			// shaken about all three axes. 15 Hz-ish, which is where propwash
			// oscillation actually sits on video.
			//
			// The amplitude is NOT a taste constant — same rule as the buffet
			// just below, and for the same reason. It used to be a hard-coded
			// 0.05 N.m whatever the machine (issue #144). Against what the
			// motors can actually produce (thrust * arm), that is 40% of a 5"
			// build's authority... and 596% of a toothpick's. The disturbance
			// torque therefore exceeded SIX TIMES what the machine could oppose:
			// no PID tune recovers from that, and it is what made pitch and yaw
			// diverge under held roll, at micro scale only. Measured: 895 deg/s^2
			// of parasitic acceleration on freestyle5, 50 300 deg/s^2 on
			// toothpick.
			//
			// Turbulence perturbs a FRACTION of the thrust actually produced,
			// and that perturbation acts on the arm: the torque is that product.
			// The fraction is calibrated to reproduce exactly the historical
			// 0.05 N.m on freestyle5 at hover — the reference feel is preserved
			// to the hundredth, only the scaling between families changes.
			const s = this.propwash * PROPWASH_TORQUE_FRAC * (thrustTotal / 4) * P.armZ;
			tx += this._wash[0].next(dt) * s;
			ty += this._wash[1].next(dt) * s * 0.5;
			tz += this._wash[2].next(dt) * s;
		}

		if (shake > 0.05) {
			// An eddy smaller than the disc does not arrive at all four rotors at
			// once, so the same fluctuation that pushes the quad sideways also
			// twists it. The amplitude is not a taste constant: a velocity
			// difference dv across one rotor changes its thrust by kBuffet*w*dv,
			// and that acts on the arm — so the torque is that product, and it
			// grows with rpm exactly like the thrust it perturbs does.
			const wMean = meanRotorSpeed(this.omega);
			const s = this._kBuffet * wMean * shake * P.armZ;
			tx += this._buffet[0].next(dt) * s;
			ty += this._buffet[1].next(dt) * s * 0.4;
			tz += this._buffet[2].next(dt) * s;
		}

		this.torque.x = tx; this.torque.y = ty; this.torque.z = tz;
		return this;
	}
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
// The Acro3D command range. Never reached by a forward flight, whose mixer
// cannot produce a negative number at all.
function clampPm1(v) { return v < -1 ? -1 : v > 1 ? 1 : v; }
// How fast the four rotors are turning, regardless of which way. Every shaft
// speed is >= 0 on the forward path, so `Math.abs` hands back the same doubles
// and this is the mean it always was.
function meanRotorSpeed(omega) {
	return (Math.abs(omega[0]) + Math.abs(omega[1]) + Math.abs(omega[2]) + Math.abs(omega[3])) / 4;
}

const ZERO_RATE = { x: 0, y: 0, z: 0 };

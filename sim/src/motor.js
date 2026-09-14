// One brushless motor and its ESC, as a torque balance rather than a curve fit.
//
// What this replaces. quad.js used to turn a throttle command into rpm with
//
//   omega_target = omegaMax * cmd^rpmCurve
//   omega += (omega_target - omega) * (1 - exp(-dt/tau))
//
// and a tau that was tauSpinUp going up, tauSpinDown coming down. That is three
// fitted constants per family (`rpmCurve`, `tauSpinUp`, `tauSpinDown`) standing
// in for one mechanism, and being fitted they could absorb anything: no
// combination of them was ever wrong, so nothing could ever be checked.
//
// The mechanism is the textbook one:
//
//   e = Ke * omega                      back-EMF, Ke = 60 / (2*pi*KV)
//   i = (duty * V - e) / R              winding current
//   Q_motor = Ke * (i - i0)             torque, Kt = Ke in SI units
//   J * domega/dt = Q_motor - Q_load    the balance
//
// Everything the three constants used to encode falls out of it instead:
//
//   - the shape of rpm against stick, which is neither linear nor a power law
//     but the root of a quadratic (the old 0.65 exponent was an approximation
//     of it, which is why it sat between 0.5 and 1);
//   - spin-up and spin-down being different, because going up the ESC drives
//     the motor and coming down it does not, so the two have different damping;
//   - a sagging pack costing rpm, since V is in the drive term;
//   - current, which used to be a separate fit in Battery.update() and is now
//     simply what the winding draws.
//
// It also became possible to be WRONG, which the fit never was. Derived against
// each family's documented motor, freestyle5 comes out at R = 0.092 ohm (a real
// 2207 measures 0.05-0.09) with the bell carrying 18% of the prop's inertia and
// the ESC braking at 34%, all three plausible. race5 and toothpick come out at
// 48-51% of no-load rpm where a loaded prop sits at 65-75%, which is the model
// saying their scaled-from-freestyle5 numbers do not describe their own motors.
// That is a finding the old form could not have produced.

import { kvLossTipSpeed, kvLossPropPitch } from './curves.js';

// The bell's inertia as a fraction of the prop's, from freestyle5's measured
// tauSpinUp. A 2207 bell is roughly 8 g at r ~ 11 mm, so ~1e-6 kg.m2 against a
// 4e-6 prop = 0.25 — the same order, which is the check that this is a real
// quantity and not a fudge. Every other family scales off its own prop, the
// rule the rest of the model already follows.
const BELL_INERTIA_RATIO = 0.18;

// How much of the regenerative current the ESC actually allows when the motor
// is turning faster than the throttle commands. 0 is a freewheeling ESC (the
// prop alone slows the rotor), 1 is full complementary PWM. From freestyle5's
// measured tauSpinDown/tauSpinUp = 2.05. It is a property of the ESC, not of
// the airframe, so it is one number for every build rather than a per-family
// constant.
const ESC_BRAKING = 0.340;

// Back-EMF constant in V per rad/s, which in SI is also the torque constant in
// N.m per A. KV is given in rpm per volt, hence the 60/2pi.
export function backEmf(kv) { return 60 / (2 * Math.PI * kv); }

// Prop torque coefficient, Q = kQ * omega^2, from the airframe's own numbers:
// at maxOmega the prop makes maxThrustPerMotor and torqueRatio of it in torque.
export function kTorqueOf(profile) {
	return (profile.torqueRatio * profile.maxThrustPerMotor) / (profile.maxOmega * profile.maxOmega);
}

// Rotor inertia: the prop plus its bell.
export function rotorInertiaOf(profile) {
	return profile.propInertia * (1 + BELL_INERTIA_RATIO);
}

// Winding resistance, DERIVED rather than stored, so that maxOmega stays
// authoritative: R is whatever makes the motor settle at exactly maxOmega at
// full throttle on a full pack. That keeps every family's top-end rpm — and so
// its thrust, its thrust-to-weight and its hover stick — bit-identical to
// before this model existed, while the dynamics around that point become
// physical. It also means this file adds no fitted constant of its own: KV and
// the no-load current are the only new numbers, and both are the motor's.
//
// THE REFERENCE CELL VOLTAGE. Spec §10 names 4.0 V per cell as the reference
// for computing the maximum regime. It is not the anchor used here, and the
// disagreement is deliberate: `maxOmega` is this sim's measured full-throttle
// rpm on a FULL pack, and both discharge curves of §11 put a full cell at
// 4.2 V. Deriving R at 4.0 would let a full pack overspeed `maxOmega` by about
// 5%, which is exactly the authority the rest of this file is built to keep.
export const FULL_CELL_VOLTS = 4.2;

export function resistanceOf(profile) {
	const Ke = backEmf(profile.motor.kv);
	const volts = profile.battery.cells * FULL_CELL_VOLTS;
	const torqueAtMax = kTorqueOf(profile) * profile.maxOmega * profile.maxOmega;
	const currentAtMax = torqueAtMax / Ke + profile.motor.noLoadCurrent;
	return (volts - Ke * profile.maxOmega) / currentAtMax;
}

// Everything above, resolved once per airframe so the 250 Hz path does no
// algebra it does not have to. Memoised on the profile object itself: this is
// called from hoverThrottle(), which altitude hold runs on every step, and from
// idleThrottle(), which main.js runs every frame.
const CACHE = new WeakMap();
export function motorConstants(profile) {
	const hit = CACHE.get(profile);
	if (hit) return hit;
	const c = computeMotorConstants(profile);
	CACHE.set(profile, c);
	return c;
}

function computeMotorConstants(profile) {
	const Ke = backEmf(profile.motor.kv);
	const R = resistanceOf(profile);
	return {
		Ke,
		R,
		i0: profile.motor.noLoadCurrent,
		J: rotorInertiaOf(profile),
		kQ: kTorqueOf(profile),
		// The prop-loss factor as a function of rpm, carried here so the two
		// closed-form inversions below load the motor with the SAME torque the
		// plant does. quad.js loads it with `torqueRatio * thrust`, and thrust
		// carries this factor; leaving `kQ * w^2` bare here put the analytic hover
		// stick 6% light, because the two disagreed by exactly the factor.
		loss: (w) => propLossFactor(profile, w),
		// The electrical damping dQ/domega. Constant, and the term that makes
		// spin-up faster than spin-down.
		electricalDamping: (Ke * Ke) / R,
		braking: ESC_BRAKING,
		// Per-motor winding-current ceiling, amps. `null` on the profile means
		// no limiter, which is what this model did before one existed.
		iLimit: profile.escCurrentLimit > 0 ? profile.escCurrentLimit : Infinity,
	};
}

// The largest duty that will not push the winding past `c.iLimit` at this
// omega. Rearranging i = (duty*V - Ke*w)/R for duty.
//
// THIS IS THE WHOLE LIMITER, and the form matters more than the number. The
// obvious implementation — integrate the step, then clamp the current that
// comes out — oscillates, and not subtly: the clamp is a discontinuity sitting
// inside an integrator, so the rotor overshoots the limit, gets chopped, falls
// under it, is released, and rings at the loop rate forever. Capping the DUTY
// instead is what a real ESC does and it cannot ring, because the cap is a
// continuous, monotonically INCREASING function of omega: as the motor speeds
// up the back-EMF does part of the work, the cap relaxes, and the closed loop
// has no edge to bounce off. The current approaches the ceiling from below and
// stays there.
export function dutyCeiling(c, omega, volts) {
	if (!(c.iLimit < Infinity) || !(volts > 0)) return 1;
	const d = (c.R * c.iLimit + c.Ke * omega) / volts;
	return d < 0 ? 0 : d > 1 ? 1 : d;
}

// One step of the balance, returned as the new omega plus the current drawn.
//
// The electrical part is integrated analytically rather than by an explicit
// Euler step: J*domega/dt = b - a*omega is linear in omega once the load is
// held over the step, so omega goes to its own asymptote by exp(-a*dt/J) and
// the step is unconditionally stable at any dt. That matters — a micro's rotor
// inertia is 3e-7 kg.m2 and an explicit step at 4 ms would ring.
//
// `loadTorque` is the prop's aerodynamic torque, passed in rather than computed
// from omega alone, because the caller knows the real thrust including inflow:
// descending into your own wake loads the prop harder and the rpm droops for
// it, which is a coupling this model gets for free and the old lag could not
// express at all.
export function stepMotor(c, omega, duty, volts, loadTorque, dt) {
	// The ESC's current ceiling, applied where an ESC applies it: on the duty
	// it is about to command, before anything is integrated. See dutyCeiling().
	if (c.iLimit < Infinity) {
		const ceiling = dutyCeiling(c, omega, volts);
		if (duty > ceiling) duty = ceiling;
	}
	const drive = duty * volts;
	// Regenerating when the back-EMF exceeds what the ESC is applying. The ESC
	// only lets part of that current through, so both the drive and the damping
	// scale with it: a freewheeling ESC (braking 0) leaves the prop to do all
	// the slowing.
	const gain = drive >= c.Ke * omega ? 1 : c.braking;
	const a = gain * c.electricalDamping;
	// Losses that do not depend on omega: iron and bearing drag, plus the prop.
	const b = gain * (c.Ke * drive) / c.R - c.Ke * c.i0 - loadTorque;
	let next;
	if (a > 0) {
		const omegaInf = b / a;
		next = omegaInf + (omega - omegaInf) * Math.exp(-(a * dt) / c.J);
	} else {
		next = omega + (b / c.J) * dt;
	}
	if (next < 0) next = 0;
	// Winding current: what circulates in the motor.
	const winding = (drive - c.Ke * next) / c.R;
	const i = winding > 0 ? winding : gain * winding;
	// Pack current is NOT the winding current. An ESC is a buck converter: the
	// winding current keeps circulating through the freewheeling path during
	// the PWM off-time, and the pack only supplies it for the duty fraction.
	// Conflating the two costs a factor of 1/duty and it is not subtle — it put
	// a 5" freestyle hover at 34 A where a real one draws about 10.
	return { omega: next, current: i, packCurrent: duty * i };
}

// The inverse of steadyOmega: the throttle that holds a given rpm. Rearranging
// the same balance for duty instead of omega,
//
//   duty = (R*(kQ*w^2/Ke + i0) + Ke*w) / V
//
// closed form, no search. This is what hoverThrottle() and idleThrottle() need:
// both used to invert `cmd^(2*rpmCurve)` by hand, which stops being the right
// curve the moment the rpm comes from a torque balance instead of a power law.
export function dutyForOmega(c, omega, volts) {
	if (!(volts > 0)) return 1;
	const load = c.kQ * lossAt(c, omega) * omega * omega;
	let duty = (c.R * (load / c.Ke + c.i0) + c.Ke * omega) / volts;
	// A stick the ESC would refuse is not a stick that holds this rpm.
	const ceiling = dutyCeiling(c, omega, volts);
	if (duty > ceiling) duty = ceiling;
	return duty < 0 ? 0 : duty > 1 ? 1 : duty;
}

// The rpm a motor settles at for a held throttle, with no aerodynamic load
// beyond the prop's own quadratic torque. This is the curve the old
// `omegaMax * cmd^rpmCurve` was approximating.
//
//   Ke*((duty*V - Ke*w)/R - i0) = kQ*w^2
//
// is a quadratic in w; the positive root is the only physical one.
// `c.loss` is optional so a hand-built constants object still works.
function lossAt(c, omega) {
	const f = c.loss ? c.loss(omega) : 1;
	return f > 0 && Number.isFinite(f) ? f : 1;
}

// The closed form below solves `kQ*w^2` for w. With the loss factor the load is
// `kQ*loss(w)*w^2`, which has no closed form, so the root is walked: solve with
// the loss held at the previous estimate, three passes. Same shape as
// quad.js:omegaForThrust(), same reason, and the round trip through
// dutyForOmega() is asserted in tools/motor-selftest.mjs.
function steadyWithLoss(c, duty, volts, closed) {
	let w = closed(c, duty, volts);
	if (!c.loss) return w;
	// Iterated to convergence rather than a fixed three passes: three left 1.8e-6
	// on the duty round trip, and the round trip is asserted at 1e-9. This is not
	// in the per-step path — stepMotor() integrates analytically and never calls
	// it — so the extra passes cost nothing that matters. The cap is a guard, not
	// a budget: it converges in well under ten.
	for (let i = 0; i < 40; i++) {
		const f = lossAt(c, w);
		const next = closed({ ...c, kQ: c.kQ * f, loss: null }, duty, volts);
		const moved = Math.abs(next - w);
		w = next;
		if (moved <= 1e-13 * (1 + Math.abs(w))) break;
	}
	return w;
}

export function steadyOmega(c, duty, volts) {
	// Under a current ceiling the settling point is where the load torque meets
	// the torque the limiter allows: kQ*w^2 = Ke*(iLimit - i0), a single square
	// root, and the motor settles there instead of wherever the duty pointed.
	if (c.iLimit < Infinity) {
		const torqueAtLimit = c.Ke * (c.iLimit - c.i0);
		if (torqueAtLimit > 0) {
			const wLimit = Math.sqrt(torqueAtLimit / c.kQ);
			const free = steadyWithLoss(c, duty, volts, freeSteadyOmega);
			return free < wLimit ? free : wLimit;
		}
	}
	return steadyWithLoss(c, duty, volts, freeSteadyOmega);
}

function freeSteadyOmega(c, duty, volts) {
	const A = c.kQ;
	const B = c.electricalDamping;
	const C = c.Ke * c.i0 - (c.Ke * duty * volts) / c.R;
	if (C >= 0) return 0;                   // not enough volts to turn the prop
	return (-B + Math.sqrt(B * B - 4 * A * C)) / (2 * A);
}

// ---------------------------------------------------------------------------
// PROP LOSS (spec §6.1). The two keyed curves the spec calls `perte_kv_*`, plus
// its transonic saturation.
//
// WHERE THE SPEC PUTS THEM, AND WHY THIS FILE DOES NOT. §6.1 multiplies the
// rpm by `perte_kv_vitesse_son(vTip/346)` and `perte_kv_pas_helice(pitch/dia)`,
// i.e. it shaves the KV. That reading does not survive contact with a torque
// balance: KV is an electrical property of the winding, it does not know what
// prop is bolted on and it certainly does not change with airspeed at the blade
// tip. What the two curves actually describe is a BLADE — a tip approaching
// Mach where the section stops making lift, and a pitch/diameter ratio away
// from the one the blade was designed around. Both are prop coefficients.
//
// So they are exported here as a correction on the THRUST coefficient, not on
// the rpm. Thrust goes as kThrust*omega^2, so a spec factor f on omega is a
// factor f^2 on kThrust and the thrust at a given stick comes out the same;
// what does NOT happen is the motor silently losing its top-end rpm, which
// would make `maxOmega` stop being authoritative and would fight `resistanceOf`
// directly.
//
// NORMALISED AT maxOmega. `propLossFactor` divides by its own value at
// maxOmega, so it is exactly 1 there. That keeps every family's
// maxThrustPerMotor, thrust-to-weight and hover stick untouched and moves only
// the SHAPE of the thrust curve between idle and full: below maxOmega the tip
// is slower, loses less, and the prop is relatively more effective than the
// bare quadratic says. That is the right sign — a real prop's thrust curve sits
// above omega^2 at part throttle and flattens at the top — and it is the only
// form of the correction that does not quietly re-scale the whole airframe.
// `propTipLoss` is the raw, un-normalised spec value for anyone who wants it.
//
// The torque coefficient is deliberately NOT corrected. A stalled tip stops
// making lift; it does not stop making drag, it makes more. Scaling kQ by the
// same factor would say the prop gets cheaper to turn as it stalls, which is
// backwards, and it would break the closed form of `steadyOmega` for nothing.

// The spec is explicit: 346 m/s, not 340 and not the ISA value.
export const SPEED_OF_SOUND = 346;

const INCH = 0.0254;

// Prop diameter in inches, the unit every curve of §11 is indexed by.
export function propDiameterInches(profile) {
	return (2 * profile.propRadius) / INCH;
}

// vTip = rpm/60 * pi * diameter, which in rad/s and metres is just omega*r.
export function tipSpeed(profile, omega) {
	return omega * profile.propRadius;
}

// §6.1's transonic ceiling on tip speed: a 2" prop is allowed 62% of the speed
// of sound, a 6" or bigger the whole of it. `map` is the spec's bounded remap.
export function transonicLimit(profile) {
	const d = propDiameterInches(profile);
	const t = Math.min(1, Math.max(0, (d - 2) / 4));
	return SPEED_OF_SOUND * (0.62 + t * (1.0 - 0.62));
}

// The rpm §6.1 would have produced: the two loss curves, then the saturation.
// Kept as an "effective omega" rather than as a factor because the saturation
// step is written in the spec as a lerp between two SPEEDS, and expressing it
// any other way loses the fact that the result is bounded by `transonicLimit`.
export function effectiveOmega(profile, omega) {
	if (!(omega > 0)) return 0;
	const r = profile.propRadius;
	let w = omega * kvLossTipSpeed.eval(tipSpeed(profile, omega) / SPEED_OF_SOUND);
	w *= kvLossPropPitch.eval(profile.propPitch / (2 * r));
	const limit = transonicLimit(profile);
	const vTip = w * r;
	const ratio = vTip / limit;
	if (ratio >= 0.75) {
		const capped = Math.min(vTip, limit * 0.85) / r;
		const t = Math.min(1, (ratio - 0.75) / 0.25);
		w += (capped - w) * t;
	}
	return w;
}

// The raw spec factor on kThrust: (effective omega / omega)^2.
export function propTipLoss(profile, omega) {
	if (!(omega > 0)) return 1;
	const f = effectiveOmega(profile, omega) / omega;
	return f * f;
}

// The same thing normalised so that it is 1 at maxOmega — the one to multiply
// kThrust by. See the block comment above for why the normalisation is not a
// cosmetic detail.
export function propLossFactor(profile, omega) {
	const ref = propTipLoss(profile, profile.maxOmega);
	if (!(ref > 0)) return 1;
	return propTipLoss(profile, omega) / ref;
}

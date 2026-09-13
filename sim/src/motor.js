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
export function resistanceOf(profile) {
	const Ke = backEmf(profile.motor.kv);
	const volts = profile.battery.cells * 4.2;
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
		// The electrical damping dQ/domega. Constant, and the term that makes
		// spin-up faster than spin-down.
		electricalDamping: (Ke * Ke) / R,
		braking: ESC_BRAKING,
	};
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
	const load = c.kQ * omega * omega;
	const duty = (c.R * (load / c.Ke + c.i0) + c.Ke * omega) / volts;
	return duty < 0 ? 0 : duty > 1 ? 1 : duty;
}

// The rpm a motor settles at for a held throttle, with no aerodynamic load
// beyond the prop's own quadratic torque. This is the curve the old
// `omegaMax * cmd^rpmCurve` was approximating.
//
//   Ke*((duty*V - Ke*w)/R - i0) = kQ*w^2
//
// is a quadratic in w; the positive root is the only physical one.
export function steadyOmega(c, duty, volts) {
	const A = c.kQ;
	const B = c.electricalDamping;
	const C = c.Ke * c.i0 - (c.Ke * duty * volts) / c.R;
	if (C >= 0) return 0;                   // not enough volts to turn the prop
	return (-B + Math.sqrt(B * B - 4 * A * C)) / (2 * A);
}

// Stick -> angular rate setpoint. Spec §5, the five rate families.
//
// WHY FIVE. A pilot arrives with the rates of his real machine written down in
// his flight controller's own dialect, and expects to type the same numbers
// here and get the same throw. §5 says so in as many words: "la fidélité de ces
// formules est le critère". So the formulas below are transcribed, not
// designed: no clamp was added, no exponent tidied, no unit normalised.
//
// UNITS. Every function in this module returns DEGREES PER SECOND, which is
// what §5 specifies. The repository stores rates in rad/s. The whole conversion
// is ONE `* DEG` in src/flightController.js, where the setpoint `sp` is built
// (and in its compatibility wrapper `actualRate()`). Nothing else multiplies by
// DEG on this path, and nothing in this file knows what a radian is.
//
// TWO PARAMETERISATIONS, ON PURPOSE. The spec's five families are
// `(rcRate, superRate, expo)`. The controller this repo already flies uses a
// sixth, Betaflight's ACTUAL rates, parameterised `(centre, max, expo)` — and
// RATE_PRESETS, the six drone profiles, tools/target-build.mjs, tools/tune-pid.mjs
// and tools/geofence-measure.mjs all read that shape. Rewriting them into
// `(rcRate, superRate)` would be a change of feel disguised as a refactor.
//
// So the two coexist and are told apart BY SHAPE, which costs nothing and
// changes no existing table:
//
//   { centre, max, expo }               -> ACTUAL     (today's behaviour)
//   { type: 0..4, rcRate, superRate, expo } -> the spec family `type`
//
// `rateFor()` below is that dispatch. A later lot can put a `type` on an axis
// and get a spec family with no other edit; until one does, every axis in the
// repo lacks `type` and lands on ACTUAL, bit for bit as before.

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Marker for the sixth family, so an axis can name ACTUAL explicitly instead of
// relying on the absence of `type`. Deliberately NOT a number in 0..4: §5
// reserves those, and "tout type hors 0..4 renvoie 0".
export const RATE_ACTUAL = 'actual';

// The spec's five, by number. Names are descriptive of the formula only — §5
// numbers them and does not name them.
export const RATE_TYPES = [0, 1, 2, 3, 4];

// rates(type, rc, rcRate, superRate, expo) -> deg/s, spec §5.
//
// `rc` is the stick in [-1, 1]; anything outside saturates, a non-finite stick
// or gain gives 0 rather than poisoning the PID chain downstream. Any `type`
// outside 0..4 returns 0, as §5 requires.
export function rates(type, rc, rcRate = 0, superRate = 0, expo = 0) {
	if (!Number.isFinite(rc) || !Number.isFinite(rcRate)
		|| !Number.isFinite(superRate) || !Number.isFinite(expo)) return 0;
	rc = clamp(rc, -1, 1);
	const a = Math.abs(rc);

	switch (type) {
		case 0: {
			// rcRate is rescaled above 2.0 — the "RC rate incremental" of the
			// stock firmware, kept verbatim including the 14.54.
			if (rcRate > 2.0) rcRate += (rcRate - 2.0) * 14.54;
			const denom = clamp(1 - a * superRate, 0.01, 1.0);
			return rcRate * 200 * (rc * (a ** 3) * expo + rc * (1 - expo)) / denom;
		}
		case 1: {
			const sign = rc < 0 ? -1 : 1;
			return (rcRate * a
				+ (superRate - rcRate) * a * ((a ** 5) * expo + a * (1 - expo))) * sign;
		}
		case 2:
			// The one family whose expo and superRate are PERCENTS (the × 0.01).
			return rcRate * (expo * 0.01 * (rc * rc - 1) + 1) * rc * (a * superRate * 0.01 + 1);
		case 3: {
			const denom = clamp(1 - a * superRate, 0.01, 1.0);
			const out = (1 / denom) * 2000 * ((rc ** 3) * expo + rc * (1 - expo)) * (rcRate / 10);
			return clamp(out, -1998, 1998);
		}
		case 4: {
			if (Math.abs(rcRate) <= 1e-8) return 0;
			const centre = rcRate * 200;
			const maxR = Math.max(centre, superRate);
			const denom = clamp(
				1 - ((a ** 3) * expo + a * (1 - expo)) * ((maxR / centre - 1) / (maxR / centre)),
				0.01, 1.0);
			return clamp(rc * centre / denom, -1998, 1998);
		}
		default:
			return 0;
	}
}

// The sixth family: Betaflight ACTUAL rates, in deg/s. This is the body that
// used to live in flightController.js, moved here unchanged so that the two
// parameterisations sit in one module; flightController.js re-exports the rad/s
// wrapper under its old name for the benches that import it.
//
// Centre sensitivity sets the slope around centre, max rate sets the stops,
// expo bends the curve between them. The two are independent, which is the
// whole reason the rate system was reworked upstream — a calm centre and a
// violent full stick at the same time.
export function actualRateDeg(stick, r) {
	const rc = clamp(stick, -1, 1);
	const a = Math.abs(rc);
	const expof = r.expo * (a ** 3) + a * (1 - r.expo);
	const stickMovement = Math.max(0, r.max - r.centre);
	return Math.sign(rc) * (a * r.centre + stickMovement * expof);
}

// Dispatch on shape. `r` is one axis entry of a rates table.
export function rateFor(stick, r) {
	if (!r) return 0;
	if (r.type === undefined || r.type === null || r.type === RATE_ACTUAL) {
		return actualRateDeg(stick, r);
	}
	return rates(r.type, stick, r.rcRate, r.superRate, r.expo);
}

// Full-stick rate of an axis, deg/s. ACTUAL carries it as `max`; a spec family
// has no such field, so it is measured. Angle mode clamps its self-levelling
// demand to this, and it must keep meaning the same thing for both shapes.
export function maxRateDeg(r) {
	if (!r) return 0;
	if (r.max !== undefined && (r.type === undefined || r.type === null || r.type === RATE_ACTUAL)) {
		return r.max;
	}
	return Math.abs(rateFor(1, r));
}

// Throttle stick -> commanded throttle. Spec §4.1 (the mapping) and §6.2 (the
// three-band weighting of the throttle travel).
//
// THE STICK CONVENTION. §2.3 puts every ControlAxis, throttle included, in
// [-1, +1]. input.js in this repository hands the flight controller a throttle
// in [0, 1]. The first line of BOTH §4.1 and §6.2 is the same normalisation,
// `map(Throttle, -1..1 -> 0..1)`, and its result is exactly the repo's stick —
// so that step is folded into the calling convention: every function here takes
// the normalised throttle `u` in [0, 1]. `throttleFromSpecAxis()` is there for a
// caller that really holds a -1..1 axis. Folding it in is not cosmetic: routing
// a stick through `u*2-1` and back is not the identity in floating point, and
// the default throttle path has to be the identity to the last bit.
//
// DEFAULTS CHANGE NOTHING. DEFAULT_THROTTLE is bands at 1/1/1, MinThrottle 0
// and no shape curve, which makes the whole chain the identity —
// tools/throttle-selftest.mjs asserts that on a fine sweep. Wiring the 5" shape
// curve and a real MinThrottle in is a change of feel, and belongs to the lot
// that does the feel.

// Bounded linear remap, §0.3 `map(x, a..b -> c..d)`: x outside [a,b] saturates.
export function map(x, a, b, c, d) {
	if (!Number.isFinite(x)) return c;
	if (b === a) return x < a ? c : d;
	const t = (x - a) / (b - a);
	return c + (t < 0 ? 0 : t > 1 ? 1 : t) * (d - c);
}

// `shape` is a curves.js Curve (§11 `forme_gaz_5pouces` and its per-prop-size
// siblings) or null for no shaping. `minThrottle` is a PERCENT, DroneSettings
// field 9.
export const DEFAULT_THROTTLE = Object.freeze({
	minThrottle: 0,
	low: 1,
	medium: 1,
	high: 1,
	shape: null,
});

// §6.2 — the three bands, literally. `u` is the normalised throttle in [0, 1].
export function throttleBands(u, cfg = DEFAULT_THROTTLE) {
	return {
		high: map(u, 0.5, 1, 0, 1) * (cfg.high ?? 1),
		medium: map(Math.abs(u - 0.5), 0, 0.5, 1, 0) * (cfg.medium ?? 1),
		low: map(u, 0, 0.5, 1, 0) * (cfg.low ?? 1),
	};
}

// §6.2 — poidsCourseDeGaz(), the sum of the three.
//
// The three bands are a partition of unity: below mid they are (1-2u) and 2u,
// above it (2-2u) and (2u-1), and the third is zero on each side. So EQUAL
// gains give a flat weight equal to that gain at every stick position, and the
// case is taken directly — not as an optimisation, but because leaving float
// dust on a weight that is algebraically 1 would make the default throttle path
// differ from today's in the last bits.
export function throttleWeight(u, cfg = DEFAULT_THROTTLE) {
	const low = cfg.low ?? 1, medium = cfg.medium ?? 1, high = cfg.high ?? 1;
	if (low === medium && medium === high) return low;
	const b = throttleBands(u, cfg);
	return b.low + b.medium + b.high;
}

// §4.1 — the throttle mapping, then the shape curve.
//
// MinThrottle is a percent and §4.1 divides it by 80, not by 100: the floor it
// puts under the travel is 1.25x MinThrottle. §6.1 converts the same field with
// `x 0.01`. The /80 is transcribed as written — §5's rule holds here too — and
// the divergence is reported rather than papered over.
export function shapedThrottle(u, cfg = DEFAULT_THROTTLE) {
	const floor = (cfg.minThrottle ?? 0) / 80;
	const t = map(u, 0, 1, floor, 1);
	return cfg.shape ? cfg.shape.eval(t) : t;
}

// The controller-facing chain: 0..1 stick in, 0..1 throttle out.
//
// §6.1 multiplies the shaped throttle by the band weight before it reaches the
// motors (`forme = courbeFormeGaz.Eval(gaz) x poidsCourseDeGaz()`). That motor
// model belongs to another lot, so the product is formed here, where the
// controller's single throttle number is produced. The clamp is this repo's own
// contract — `update()` returns a throttle in [0, 1] — and cannot bite at
// 1/1/1, where the weight is exactly 1.
export function throttleChain(stick, cfg = DEFAULT_THROTTLE) {
	const u = Number.isFinite(stick) ? (stick < 0 ? 0 : stick > 1 ? 1 : stick) : 0;
	const out = shapedThrottle(u, cfg) * throttleWeight(u, cfg);
	return Number.isFinite(out) ? (out < 0 ? 0 : out > 1 ? 1 : out) : 0;
}

// Spec axis [-1, 1] -> normalised throttle [0, 1], for a caller holding one.
export function throttleFromSpecAxis(axis) {
	return map(axis, -1, 1, 0, 1);
}

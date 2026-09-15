// Keyed response curves (spec §11), and the ten the spec ships as data.
//
// This module is DATA + one interpolator, nothing else. It is deliberately
// inert: no caller uses it yet, so nothing here can move a number that the
// existing benches print. The lots that wire the spec's motor, thrust, drag and
// battery models in are what will start calling it.
//
// INTERPOLATION. The spec says "cubique" and does not say which cubic. The
// choice here is monotone cubic Hermite (Fritsch-Carlson, 1980): tangents are
// the usual centred finite differences, then clamped so that no segment can
// overshoot its own two keys. Three reasons it is the right reading of §11:
//
//   - every curve has to pass exactly through its keys, which any Hermite form
//     does, but several of them are ALSO monotone by meaning — a discharge
//     curve that rises as the pack empties, or a thrust curve that dips as the
//     stick goes up, is not a curve, it is a bug;
//   - `reponse_propwash` ends on two equal keys (0.3 -> 0.6, 1.0 -> 0.6). Plain
//     Catmull-Rom puts a bump between them; Fritsch-Carlson holds the plateau
//     flat, which is obviously what "saturates at 0.6" means;
//   - it still reproduces local extrema that the DATA has, so the one genuinely
//     non-monotone curve (`ratio_poussee_par_diametre`, which peaks at 5") keeps
//     its peak.
//
// Outside the key range the value SATURATES at the end key rather than
// extrapolating: §6.1 and §8.3 clamp their inputs before evaluating anyway, and
// an extrapolated cubic goes negative almost immediately on half of these.

export class Curve {
	// `keys` is [[x, y], ...]. Order does not matter; duplicates on x do not
	// belong here and are rejected rather than silently averaged.
	constructor(keys) {
		const pts = [...keys].map(([x, y]) => [Number(x), Number(y)]).sort((a, b) => a[0] - b[0]);
		if (pts.length === 0) throw new Error('Curve needs at least one key');
		for (let i = 1; i < pts.length; i++) {
			if (pts[i][0] === pts[i - 1][0]) throw new Error(`Curve has two keys at x=${pts[i][0]}`);
		}
		this.xs = pts.map((p) => p[0]);
		this.ys = pts.map((p) => p[1]);
		this.ms = tangents(this.xs, this.ys);
	}

	get first() { return this.xs[0]; }
	get last() { return this.xs[this.xs.length - 1]; }

	eval(x) {
		const { xs, ys, ms } = this;
		const n = xs.length;
		if (!Number.isFinite(x) || x <= xs[0]) return ys[0];
		if (x >= xs[n - 1]) return ys[n - 1];
		// Binary search for the segment holding x.
		let lo = 0, hi = n - 1;
		while (hi - lo > 1) {
			const mid = (lo + hi) >> 1;
			if (xs[mid] <= x) lo = mid; else hi = mid;
		}
		const h = xs[lo + 1] - xs[lo];
		const t = (x - xs[lo]) / h;
		const t2 = t * t;
		const t3 = t2 * t;
		// Hermite basis.
		return (2 * t3 - 3 * t2 + 1) * ys[lo]
			+ (t3 - 2 * t2 + t) * h * ms[lo]
			+ (-2 * t3 + 3 * t2) * ys[lo + 1]
			+ (t3 - t2) * h * ms[lo + 1];
	}
}

// Fritsch-Carlson: centred differences, then the clamp that kills overshoot.
function tangents(xs, ys) {
	const n = xs.length;
	if (n === 1) return [0];
	const d = [];
	for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
	const m = new Array(n);
	m[0] = d[0];
	m[n - 1] = d[n - 2];
	for (let i = 1; i < n - 1; i++) m[i] = (d[i - 1] + d[i]) / 2;
	for (let i = 0; i < n - 1; i++) {
		if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
		const a = m[i] / d[i];
		const b = m[i + 1] / d[i];
		if (a < 0) m[i] = 0;
		if (b < 0) m[i + 1] = 0;
		const s = a * a + b * b;
		if (s > 9) {
			const k = 3 / Math.sqrt(s);
			m[i] = k * a * d[i];
			m[i + 1] = k * b * d[i];
		}
	}
	return m;
}

// ---------------------------------------------------------------------------
// The ten curves of §11, transcribed key for key from donnees/courbes.json.
// Names are the English of the spec's; the spec's own key is kept in a comment
// so the two files can be diffed by hand.
//
// `thrustPerMotor5in` is in GRAMS, per motor, and `throttleShape5in` /
// `thrustPerMotor5in` are the 5" PAIR: §11 states a pair is needed per prop
// size, and only the 5" one is given.

// ratio_poussee_par_diametre — prop diameter (inches) -> thrust ratio (§7).
export const thrustRatioByDiameter = new Curve([
	[0.0, 1.15], [2.5, 1.25], [3.0, 1.9], [4.0, 1.945963], [5.0, 1.97],
	[6.0, 1.86], [7.0, 1.7], [10.0, 1.43], [15.0, 1.5],
]);

// perte_kv_vitesse_son — tip speed / 346 m/s -> KV factor (§6.1).
export const kvLossTipSpeed = new Curve([
	[0.0, 1.0], [0.138, 0.95], [0.285052, 0.880538], [0.459656, 0.828547],
	[0.804354, 0.752492], [1.0, 0.7],
]);

// perte_kv_pas_helice — pitch / diameter -> KV factor (§6.1).
export const kvLossPropPitch = new Curve([
	[0.0, 1.3], [0.57, 1.072], [0.72, 1.0], [3.0, 0.625],
]);

// consommation_batterie — prop diameter (inches) -> drain coefficient (§10).
export const batteryDrainByDiameter = new Curve([
	[-0.6, 200.0], [2.0, 125.0], [3.0, 95.0], [5.0, 45.0], [7.0, 34.0],
	[10.0, 22.0], [13.2, 19.999992],
]);

// reponse_propwash — throttle 0..1 -> propwash factor (§9.3).
export const propwashResponse = new Curve([
	[0.1, 0.0], [0.3, 0.6], [1.0, 0.6],
]);

// echelle_trainee — prop diameter (inches) -> drag scale (§8.3).
export const dragScaleByDiameter = new Curve([
	[0.0, 0.0], [3.0, 0.375], [5.0, 1.0], [6.0, 1.2], [7.0, 1.325],
	[10.0, 1.5], [15.0, 1.625],
]);

// forme_gaz_5pouces — throttle 0..1 -> shaped throttle, 5" (§6.1).
export const throttleShape5in = new Curve([
	[0.0, 0.0], [0.5, 0.42], [1.0, 1.0],
]);

// poussee_par_moteur_5pouces — throttle 0..1 -> GRAMS per motor, 5" (§7).
export const thrustPerMotor5in = new Curve([
	[0.0, 0.0], [0.05, 8.75], [0.2, 80.0], [0.3, 180.0], [0.4, 290.0],
	[0.6, 600.0], [0.902498, 1154.946655], [1.0, 1453.959961],
]);

// decharge_lipo — capacity CONSUMED 0..1 -> volts per cell (§10).
//
// The x axis is the one ambiguity in the shipped data: §11 calls it "capacité
// consommée", donnees/courbes.json names the same axis "capacite_restante_0_1".
// The keys settle it — 0 -> 4.2 V and 1.05 -> 0 V is a pack that empties as x
// grows — so §11 is right and the JSON label is wrong.
//
// THE KNEE IS SOFTENED, and this is a deliberate divergence from §11's keys.
// As shipped, the curve holds a very flat plateau (4.2 V down to 3.65 V across
// 90% of the pack) and then falls off a cliff: 3.65 -> 3.20 -> 2.00 over the
// last 9%. Flown, that left SIX SECONDS between 3.50 V/cell -- where a real
// pilot starts heading home -- and the point where full stick no longer holds a
// hover. A real pack gives a minute. The plateau below 0.8 is §11's, untouched;
// the keys from 0.85 on descend instead of collapsing, which is both what a LiPo
// actually does and what makes the end of a flight playable.
//
// §11's last key, 1.05 -> 0 V, is KEPT, and it turns out to be load-bearing for
// more than chemistry: a keyed curve saturates on its last key, so that zero is
// what ends the flight. Softened to 2.4 V instead, this pack hovered at 682% of
// rated capacity -- for ever. The collapse is therefore still here, just moved
// past 100% consumed, where no real pack goes and where the flight is over
// anyway.
export const lipoDischarge = new Curve([
	[0.0, 4.2], [0.1, 4.1], [0.2, 4.0], [0.3, 3.95], [0.4, 3.9], [0.5, 3.85],
	[0.7, 3.79], [0.8, 3.75], [0.85, 3.70], [0.9, 3.62], [0.93, 3.54],
	[0.96, 3.42], [0.98, 3.28], [1.0, 3.00], [1.02, 2.20], [1.05, 0.0],
]);

// decharge_liion — capacity CONSUMED 0..1 -> volts per cell (§10).
export const liionDischarge = new Curve([
	[0.0, 4.2], [0.1, 3.9], [0.2, 3.86], [0.5, 3.8], [0.7, 3.75], [0.8, 3.65],
	[0.9, 3.2], [0.95, 2.7], [1.05, 0.0],
]);

// Keyed by the spec's own names, for tools that walk all ten.
export const CURVES = {
	ratio_poussee_par_diametre: thrustRatioByDiameter,
	perte_kv_vitesse_son: kvLossTipSpeed,
	perte_kv_pas_helice: kvLossPropPitch,
	consommation_batterie: batteryDrainByDiameter,
	reponse_propwash: propwashResponse,
	echelle_trainee: dragScaleByDiameter,
	forme_gaz_5pouces: throttleShape5in,
	poussee_par_moteur_5pouces: thrustPerMotor5in,
	decharge_lipo: lipoDischarge,
	decharge_liion: liionDischarge,
};

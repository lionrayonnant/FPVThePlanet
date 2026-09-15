// The keyed response curves of spec §11 (src/curves.js). Structural checks
// only: a curve must pass through its own keys, saturate outside them, and stay
// monotone wherever the quantity it describes cannot physically turn around.
// Nothing here pins an interpolated value, because a recorded "y at x=0.37" only
// restates the interpolator.
import assert from 'node:assert/strict';
import { Curve, CURVES } from '../src/curves.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

const NAMES = Object.keys(CURVES);

t('all ten curves of §11 are present', () => {
	assert.equal(NAMES.length, 10, NAMES.join(', '));
});

t('every curve passes exactly through every one of its keys', () => {
	for (const name of NAMES) {
		const c = CURVES[name];
		for (let i = 0; i < c.xs.length; i++) {
			assert.equal(c.eval(c.xs[i]), c.ys[i], `${name} key ${i} at x=${c.xs[i]}`);
		}
	}
});

t('every curve saturates outside its key range', () => {
	for (const name of NAMES) {
		const c = CURVES[name];
		const first = c.ys[0];
		const last = c.ys[c.ys.length - 1];
		for (const d of [1e-9, 0.1, 5, 1e6]) {
			assert.equal(c.eval(c.first - d), first, `${name} below range by ${d}`);
			assert.equal(c.eval(c.last + d), last, `${name} above range by ${d}`);
		}
		// A non-finite input is a bug upstream, but it must not propagate a NaN
		// into a force: the low end is the safe answer.
		assert.equal(c.eval(NaN), first, name);
	}
});

// Sampling grid: dense, and deliberately including every key so the joins are
// covered too.
function samples(c, per = 64) {
	const out = [];
	for (let i = 0; i < c.xs.length - 1; i++) {
		for (let k = 0; k <= per; k++) out.push(c.xs[i] + (c.xs[i + 1] - c.xs[i]) * (k / per));
	}
	return out;
}

t('no curve overshoots the two keys of the segment it is in', () => {
	// This is what picks monotone cubic over plain Catmull-Rom: an overshoot on
	// `decharge_lipo` is a pack above 4.2 V, on `reponse_propwash` a factor over
	// its own plateau.
	for (const name of NAMES) {
		const c = CURVES[name];
		for (let i = 0; i < c.xs.length - 1; i++) {
			const lo = Math.min(c.ys[i], c.ys[i + 1]);
			const hi = Math.max(c.ys[i], c.ys[i + 1]);
			for (let k = 0; k <= 64; k++) {
				const y = c.eval(c.xs[i] + (c.xs[i + 1] - c.xs[i]) * (k / 64));
				assert.ok(y >= lo - 1e-12 && y <= hi + 1e-12,
					`${name} segment ${i}: ${y} outside [${lo}, ${hi}]`);
			}
		}
	}
});

// Direction each curve is required to hold over its whole range, from the
// meaning of the quantity in the spec. `ratio_poussee_par_diametre` is absent on
// purpose: §11 gives it a genuine peak at 5", so it is NOT monotone.
const DIRECTION = {
	perte_kv_vitesse_son: -1,        // §6.1 KV only ever falls as the tip nears Mach 1
	perte_kv_pas_helice: -1,         // §6.1 more pitch, less rpm
	consommation_batterie: -1,       // §10 a 2" drains ~6x faster than a 10"
	reponse_propwash: +1,            // §9.3 rises off zero, then holds its plateau
	echelle_trainee: +1,             // §8.3 a bigger prop drags more
	forme_gaz_5pouces: +1,           // §6.1 shaping the stick never inverts it
	poussee_par_moteur_5pouces: +1,  // §7 more throttle, more thrust
	decharge_lipo: -1,               // §10 volts fall as capacity is consumed
	decharge_liion: -1,
};

t('each curve holds the direction its quantity requires', () => {
	for (const [name, dir] of Object.entries(DIRECTION)) {
		const c = CURVES[name];
		const xs = samples(c);
		let prev = c.eval(xs[0]);
		for (const x of xs.slice(1)) {
			const y = c.eval(x);
			assert.ok(dir > 0 ? y >= prev - 1e-12 : y <= prev + 1e-12,
				`${name} reverses at x=${x}: ${prev} -> ${y}`);
			prev = y;
		}
	}
});

t('the one non-monotone curve keeps the peak the data gives it', () => {
	const c = CURVES.ratio_poussee_par_diametre;
	// §11: rises to 1.97 at 5", then falls away to 1.43 at 10".
	assert.ok(c.eval(5) > c.eval(4) && c.eval(5) > c.eval(6), `${c.eval(4)} ${c.eval(5)} ${c.eval(6)}`);
	assert.ok(c.eval(10) < c.eval(7));
});

t('an equal pair of keys holds a flat plateau between them', () => {
	// reponse_propwash is 0.6 from 0.3 to 1.0 and must not bulge in between.
	const c = CURVES.reponse_propwash;
	for (let k = 0; k <= 32; k++) {
		const y = c.eval(0.3 + 0.7 * (k / 32));
		assert.ok(Math.abs(y - 0.6) < 1e-12, `${y} at ${0.3 + 0.7 * (k / 32)}`);
	}
});

t('the spec anchors of §11 land where the table says', () => {
	// Two values quoted in prose rather than only in the key table.
	assert.ok(Math.abs(CURVES.perte_kv_vitesse_son.eval(0) - 1.0) < 1e-12);
	// §10: a 2" drains about 6x faster per unit of capacity than a 10".
	const ratio = CURVES.consommation_batterie.eval(2) / CURVES.consommation_batterie.eval(10);
	assert.ok(ratio > 5 && ratio < 6.5, `2" / 10" drain ratio ${ratio}`);
});

t('the interpolator itself behaves at the degenerate sizes', () => {
	const one = new Curve([[3, 7]]);
	assert.equal(one.eval(-1), 7);
	assert.equal(one.eval(3), 7);
	assert.equal(one.eval(99), 7);

	const two = new Curve([[0, 0], [1, 2]]);
	assert.equal(two.eval(0.5), 1);        // two keys degrade to a straight line
	assert.equal(two.eval(-1), 0);
	assert.equal(two.eval(2), 2);

	// Keys need not arrive sorted, and a repeated x is a data bug, not an average.
	const shuffled = new Curve([[1, 2], [0, 0]]);
	assert.equal(shuffled.eval(0.5), 1);
	assert.throws(() => new Curve([[0, 1], [0, 2]]), /two keys/);
	assert.throws(() => new Curve([]), /at least one key/);
});

console.log(`curves-selftest : ${n} tests ok`);

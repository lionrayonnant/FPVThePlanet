// The motor, the ESC limiter and the pack (src/motor.js, src/battery.js).
// Spec §6.1's two loss curves and its transonic saturation, §10's discharge
// curves, and the current ceiling.
//
// Structural checks, not recorded numbers: what is asserted is that maxOmega
// stays the authority, that the tip cannot go supersonic, that the limiter
// settles instead of ringing, and that switching every new mechanism off
// reproduces the model that existed before this file.
import assert from 'node:assert/strict';
import { PROFILES, FAMILIES } from '../src/drone-profiles.js';
import {
	motorConstants, stepMotor, steadyOmega, dutyForOmega, dutyCeiling,
	resistanceOf, kTorqueOf, effectiveOmega, tipSpeed, transonicLimit,
	propTipLoss, propLossFactor, propDiameterInches, FULL_CELL_VOLTS,
} from '../src/motor.js';
import { Battery, drainScaleForDiameter } from '../src/battery.js';
import { lipoDischarge, liionDischarge } from '../src/curves.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

const DT = 1 / 250;
// A profile with fields overridden, without touching src/drone-profiles.js.
const variant = (family, over) => ({ ...PROFILES[family], ...over });

// Run a motor to steady state under a held duty and a quadratic prop load.
function settle(profile, duty, { volts = null, seconds = 3 } = {}) {
	const c = motorConstants(profile);
	const V = volts ?? profile.battery.cells * FULL_CELL_VOLTS;
	let w = 0, last = null;
	const tail = [];
	for (let i = 0; i < seconds / DT; i++) {
		last = stepMotor(c, w, duty, V, c.kQ * w * w, DT);
		w = last.omega;
		tail.push(w);
		if (tail.length > 200) tail.shift();
	}
	return { omega: w, current: last.current, packCurrent: last.packCurrent, tail, c };
}

// ---------------------------------------------------------------------------
// 1. maxOmega is still the authority.

t('full throttle on a full pack settles at maxOmega, every family', () => {
	for (const f of FAMILIES) {
		const p = PROFILES[f];
		const { omega } = settle(p, 1);
		assert.ok(Math.abs(omega / p.maxOmega - 1) < 1e-3,
			`${f}: ${omega.toFixed(1)} vs maxOmega ${p.maxOmega}`);
	}
});

t('resistanceOf is derived from maxOmega, not stored', () => {
	for (const f of FAMILIES) {
		const p = PROFILES[f];
		const R = resistanceOf(p);
		assert.ok(R > 0.001 && R < 5, `${f}: R = ${R}`);
		// The closed form must agree with the integrated one.
		const c = motorConstants(p);
		assert.ok(Math.abs(steadyOmega(c, 1, p.battery.cells * FULL_CELL_VOLTS) / p.maxOmega - 1) < 1e-6, f);
	}
});

t('the reference cell voltage for the ceiling is 4.2, not the spec\'s 4.0', () => {
	// Deliberate: see FULL_CELL_VOLTS in src/motor.js. Both discharge curves of
	// §11 put a full cell at 4.2, and maxOmega is a full-pack number.
	assert.equal(FULL_CELL_VOLTS, 4.2);
	assert.equal(lipoDischarge.eval(0), 4.2);
	assert.equal(liionDischarge.eval(0), 4.2);
});

// ---------------------------------------------------------------------------
// 2. §6.1's loss curves, applied to the thrust coefficient.

t('the loss factor is exactly 1 at maxOmega, every family', () => {
	for (const f of FAMILIES) {
		const p = PROFILES[f];
		assert.ok(Math.abs(propLossFactor(p, p.maxOmega) - 1) < 1e-12,
			`${f}: ${propLossFactor(p, p.maxOmega)}`);
	}
});

t('the raw spec loss is a real loss, and it bites hardest on the fastest tip', () => {
	// propTipLoss < 1 everywhere these families turn: every one of them has a
	// tip well past the first key of perte_kv_vitesse_son.
	for (const f of FAMILIES) {
		const p = PROFILES[f];
		const loss = propTipLoss(p, p.maxOmega);
		assert.ok(loss > 0.2 && loss < 1, `${f}: ${loss}`);
	}
	const tips = FAMILIES.map((f) => [f, tipSpeed(PROFILES[f], PROFILES[f].maxOmega)]);
	tips.sort((a, b) => b[1] - a[1]);
	const fastest = tips[0][0], slowest = tips[tips.length - 1][0];
	assert.ok(propTipLoss(PROFILES[fastest], PROFILES[fastest].maxOmega)
		< propTipLoss(PROFILES[slowest], PROFILES[slowest].maxOmega),
		`${fastest} vs ${slowest}`);
});

t('below maxOmega the normalised factor is above 1: the tip is slower and loses less', () => {
	for (const f of FAMILIES) {
		const p = PROFILES[f];
		let prev = Infinity;
		for (const frac of [0.2, 0.4, 0.6, 0.8, 1.0]) {
			const v = propLossFactor(p, frac * p.maxOmega);
			assert.ok(v >= 1 - 1e-12, `${f} at ${frac}: ${v}`);
			assert.ok(v <= prev + 1e-12, `${f}: not monotone, ${v} after ${prev}`);
			prev = v;
		}
	}
});

t('the tip speed never exceeds the transonic limit, however hard it is pushed', () => {
	for (const f of FAMILIES) {
		const p = PROFILES[f];
		const limit = transonicLimit(p);
		assert.ok(limit > 0.6 * 346 && limit <= 346, `${f}: limit ${limit}`);
		// Far past anything the motor can reach, so the saturation is the only
		// thing that can hold this.
		for (let w = 0; w <= 40 * p.maxOmega; w += p.maxOmega / 8) {
			const v = tipSpeed(p, effectiveOmega(p, w));
			assert.ok(v <= limit + 1e-9, `${f} at omega ${w}: tip ${v} > ${limit}`);
		}
	}
});

t('the transonic ceiling follows prop size the way §6.1 says', () => {
	const two = variant('freestyle5', { propRadius: (2 * 0.0254) / 2 });
	const six = variant('freestyle5', { propRadius: (6 * 0.0254) / 2 });
	const ten = variant('freestyle5', { propRadius: (10 * 0.0254) / 2 });
	assert.ok(Math.abs(transonicLimit(two) - 346 * 0.62) < 1e-9);
	assert.ok(Math.abs(transonicLimit(six) - 346) < 1e-9);
	assert.ok(Math.abs(transonicLimit(ten) - 346) < 1e-9, 'map() is bounded');
	assert.ok(Math.abs(propDiameterInches(PROFILES.freestyle5) - 5) < 1e-9);
});

t('effectiveOmega is monotone in omega: more rpm is never less prop', () => {
	// KNOWN SPEC DEFECT, bounded rather than hidden. §6.1's saturation blends
	// toward `limit * 0.85` with a weight that rises faster than the tip speed
	// it is capping, so past roughly 1.9x maxOmega the effective rpm starts
	// going DOWN as the real rpm goes up. Every family is monotone over its own
	// whole range and well past it; none of them can reach twice maxOmega (the
	// motor settles at maxOmega on a full pack by construction), so the defect
	// is unreachable — but it is the spec's, not this file's, and the bound is
	// asserted so it cannot creep down into the flyable range.
	for (const f of FAMILIES) {
		const p = PROFILES[f];
		let prev = -1;
		for (let w = 0; w <= 1.5 * p.maxOmega; w += p.maxOmega / 256) {
			const e = effectiveOmega(p, w);
			assert.ok(e >= prev - 1e-9, `${f}: ${e} after ${prev} at ${w}`);
			prev = e;
		}
	}
});

// ---------------------------------------------------------------------------
// 3. The ESC current ceiling.

t('the ceiling clips the current and does not oscillate', () => {
	const LIMIT = 25;                      // A per motor, well under full throttle
	const p = variant('freestyle5', { escCurrentLimit: LIMIT });
	const c = motorConstants(p);
	const V = p.battery.cells * FULL_CELL_VOLTS;
	let w = 0;
	const currents = [];
	for (let i = 0; i < 3 / DT; i++) {
		const s = stepMotor(c, w, 1, V, c.kQ * w * w, DT);
		w = s.omega;
		currents.push(s.current);
		assert.ok(s.current <= LIMIT + 1e-6, `overshoot at step ${i}: ${s.current} A`);
	}
	// Residual amplitude over the last half second: a hard clamp on an
	// integrator rings at the loop rate, a duty ceiling does not.
	const tail = currents.slice(-125);
	const ripple = Math.max(...tail) - Math.min(...tail);
	assert.ok(ripple < 1e-6, `residual current ripple ${ripple.toExponential(2)} A`);
	const wTail = [];
	for (let i = 0; i < 125; i++) { const s = stepMotor(c, w, 1, V, c.kQ * w * w, DT); w = s.omega; wTail.push(w); }
	const wRipple = Math.max(...wTail) - Math.min(...wTail);
	assert.ok(wRipple < 1e-6, `residual rpm ripple ${wRipple.toExponential(2)} rad/s`);
	// And it actually bit: the motor sits short of maxOmega.
	assert.ok(w < 0.95 * p.maxOmega, `limiter did nothing: ${w} vs ${p.maxOmega}`);
});

t('the ceiling survives a stick that slams up and down without ringing', () => {
	const p = variant('freestyle5', { escCurrentLimit: 30 });
	const c = motorConstants(p);
	const V = p.battery.cells * FULL_CELL_VOLTS;
	let w = 0, worst = 0;
	for (let i = 0; i < 4 / DT; i++) {
		const duty = (i % 100) < 50 ? 1 : 0.15;
		const s = stepMotor(c, w, duty, V, c.kQ * w * w, DT);
		w = s.omega;
		worst = Math.max(worst, s.current);
		assert.ok(Number.isFinite(w) && w >= 0, `step ${i}: ${w}`);
	}
	assert.ok(worst <= 30 + 1e-6, `${worst} A`);
});

t('dutyCeiling relaxes as the motor speeds up, which is why it cannot ring', () => {
	const p = variant('freestyle5', { escCurrentLimit: 25 });
	const c = motorConstants(p);
	const V = p.battery.cells * FULL_CELL_VOLTS;
	let prev = -1;
	for (let w = 0; w <= p.maxOmega; w += 50) {
		const d = dutyCeiling(c, w, V);
		assert.ok(d >= prev - 1e-12, `${d} after ${prev} at ${w}`);
		prev = d;
	}
});

t('steadyOmega and dutyForOmega agree with the limiter that stepMotor applies', () => {
	const p = variant('freestyle5', { escCurrentLimit: 25 });
	const c = motorConstants(p);
	const V = p.battery.cells * FULL_CELL_VOLTS;
	const integrated = settle(p, 1).omega;
	assert.ok(Math.abs(steadyOmega(c, 1, V) / integrated - 1) < 1e-3,
		`${steadyOmega(c, 1, V)} vs ${integrated}`);
	assert.ok(dutyForOmega(c, p.maxOmega, V) <= dutyCeiling(c, p.maxOmega, V) + 1e-12);
});

// ---------------------------------------------------------------------------
// 4. The pack.

t('both discharge curves start at 4.2 V and fall monotonically', () => {
	for (const [name, curve] of [['lipo', lipoDischarge], ['liion', liionDischarge]]) {
		assert.equal(curve.eval(0), 4.2, name);
		let prev = Infinity;
		for (let x = 0; x <= 1.05; x += 0.005) {
			const v = curve.eval(x);
			assert.ok(v <= prev + 1e-9, `${name}: rose to ${v} from ${prev} at ${x}`);
			assert.ok(v >= 0, `${name}: ${v} at ${x}`);
			prev = v;
		}
		assert.ok(curve.eval(1.05) === 0, name);
	}
});

t('the pack axis is capacity CONSUMED, not remaining', () => {
	// The one known error in the shipped data: courbes.json labels the axis
	// `capacite_restante_0_1`. Reading it that way puts a full pack at 0 V.
	const b = new Battery({ ...PROFILES.freestyle5.battery, dischargeCurve: 'lipo' });
	assert.ok(Math.abs(b.voltage - 4.2 * 4) < 1e-9, `full pack ${b.voltage}`);
	// Asserted as the SHAPE, not a threshold pinned to where the knee happens to
	// sit: a pack that has given up its rated capacity must be well down from
	// full and still above the dead tail, and the curve must keep falling all the
	// way. A 0.5x-of-full threshold would have been a threshold on the knee, and
	// it broke the moment the knee was softened.
	b.usedMah = b.capacityMah;
	const empty = b.openCircuit() / b.cells;
	assert.ok(empty > 2.5 && empty < 3.4, `empty pack ${empty} V/cell`);
	b.usedMah = b.capacityMah * 1.05;
	assert.ok(b.openCircuit() / b.cells < empty, 'the tail past full discharge must keep falling');
});

t('the pack empties monotonically and the voltage falls with it', () => {
	const b = new Battery({ ...PROFILES.freestyle5.battery, dischargeCurve: 'lipo' });
	let prev = Infinity;
	for (let i = 0; i < 2000; i++) {
		const v = b.update(40, 0.05);
		assert.ok(v <= prev + 1e-9, `rose to ${v} from ${prev}`);
		assert.ok(v >= 0 && Number.isFinite(v));
		assert.ok(b.soc >= 0 && b.soc <= 1, `soc ${b.soc}`);
		prev = v;
	}
});

t('li-ion sags early then holds; lipo holds then declines, without a cliff', () => {
	// The reason the two chemistries are worth carrying at all -- plus the shape
	// the lipo knee was deliberately given. §11 as shipped dropped 1.65 V between
	// 0.90 and 0.99, which flown left six seconds between "a real pilot lands"
	// and "this no longer hovers". The decline is asserted as real but bounded,
	// so neither the cliff nor a flat tail can come back unnoticed.
	assert.ok(liionDischarge.eval(0.1) < lipoDischarge.eval(0.1));
	assert.ok(liionDischarge.eval(0.5) > 3.7);
	const decline = lipoDischarge.eval(0.9) - lipoDischarge.eval(0.99);
	assert.ok(decline > 0.25 && decline < 0.8, `lipo 0.90->0.99 falls ${decline.toFixed(3)} V`);
	// And it is still monotone across the knee, one sample per key interval.
	for (let x = 0.8; x < 1.0; x += 0.01) {
		assert.ok(lipoDischarge.eval(x + 0.01) < lipoDischarge.eval(x), `not falling at ${x.toFixed(2)}`);
	}
});

t('the sag floor never props the pack above its own curve', () => {
	const b = new Battery({ ...PROFILES.freestyle5.battery, dischargeCurve: 'lipo' });
	// Probed PAST full discharge, which is the only place the pack's own curve
	// goes under the 3.0 V/cell floor and so the only place the floor could prop
	// it up. At 0.99 the softened knee is still above 3.0 and the test would pass
	// for the wrong reason.
	b.usedMah = 1.04 * b.capacityMah;
	const v = b.update(0, DT);
	assert.ok(Math.abs(v - b.openCircuit()) < 1e-9, `${v} vs ${b.openCircuit()}`);
	assert.ok(b.openCircuit() < 3.0 * b.cells, `probe is not past the floor: ${b.openCircuit()}`);
	assert.ok(v < 3.0 * b.cells, `floor held a dead pack up at ${v}`);
});

t('the drain coefficient of §10 is a 5"-relative scale, and 2" really is ~6x a 10"', () => {
	assert.ok(Math.abs(drainScaleForDiameter(5) - 1) < 1e-12);
	const ratio = drainScaleForDiameter(2) / drainScaleForDiameter(10);
	assert.ok(ratio > 5 && ratio < 7, `${ratio}`);
	// And it is opt-in: a profile that says nothing counts plain coulombs.
	const plain = new Battery(PROFILES.freestyle5.battery);
	assert.equal(plain.drainScale, 1);
});

// ---------------------------------------------------------------------------
// 5. Everything off reproduces the model that was here before.

t('escCurrentLimit null and the legacy curve give the old behaviour exactly', () => {
	for (const f of FAMILIES) {
		const p = PROFILES[f];
		assert.equal(p.escCurrentLimit, null, `${f} has opted into the limiter`);
		const c = motorConstants(p);
		assert.equal(c.iLimit, Infinity, f);
		const V = p.battery.cells * FULL_CELL_VOLTS;
		// The closed forms are untouched by the ceiling when there is none.
		for (const duty of [0, 0.15, 0.4, 0.75, 1]) {
			const w = steadyOmega(c, duty, V);
			// A duty too low to overcome the no-load current parks the rotor;
			// the balance below only means anything once it is turning.
			if (w === 0) continue;
			assert.ok(Math.abs(c.kQ * w * w - c.Ke * ((duty * V - c.Ke * w) / c.R - c.i0)) < 1e-6 * (1 + w),
				`${f} at ${duty}`);
			assert.ok(Math.abs(dutyForOmega(c, w, V) - duty) < 1e-9, `${f} at ${duty}`);
		}
		assert.equal(c.kQ, kTorqueOf(p), f);
	}
	// The pack: 'legacy' is the analytic curve, key for key.
	const b = new Battery({ ...PROFILES.freestyle5.battery, dischargeCurve: 'legacy' });
	for (const used of [0, 0.25, 0.5, 0.9, 1]) {
		b.usedMah = used * b.capacityMah;
		const s = b.soc;
		const cell = s > 0.2 ? 3.75 + 0.45 * ((s - 0.2) / 0.8) ** 0.75 : 3.4 + 0.35 * (s / 0.2);
		assert.ok(Math.abs(b.openCircuit() - cell * b.cells) < 1e-12, `${used}`);
	}
});

t('a full pack is bit-identical under lipo and under the old analytic curve', () => {
	// Which is why switching the default chemistry on moved nothing that any
	// full-pack bench measures.
	const spec = PROFILES.freestyle5.battery;
	const a = new Battery({ ...spec, dischargeCurve: 'legacy' });
	const b = new Battery({ ...spec, dischargeCurve: 'lipo' });
	assert.equal(a.voltage, b.voltage);
});

console.log(`motor-selftest : ${n} tests ok`);

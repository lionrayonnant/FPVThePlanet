// The rate curves (src/rates.js): the spec's five families (§5) and the sixth,
// ACTUAL, that this repository already flies.
//
// Two jobs. First, structure: §5 states the properties the families must have
// (zero at centre, odd symmetry, monotone in |stick|, the two clamps, zero for
// an unknown type) and those are checked rather than a table of recorded
// numbers, which would only restate the implementation. Second, and the reason
// this file exists at all: an ANCHOR. The default rate path must still produce
// today's numbers to the last bit, on every preset the repo ships and on a fine
// sweep of the stick.
import assert from 'node:assert/strict';
import { rates, actualRateDeg, rateFor, maxRateDeg, RATE_ACTUAL, RATE_TYPES } from '../src/rates.js';
import { RATE_PRESETS, actualRate } from '../src/flightController.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

const DEG = Math.PI / 180;
// Gains that are in range PER FAMILY. The five do not share a domain: `expo`
// and `superRate` are fractions in types 0/1/3/4 but percentages in type 2, and
// `superRate` is a dimensionless super factor in 0/3 while it is a rate in
// deg/s in 1/4. §5 states none of this; the sets below are what the formulas
// themselves imply.
const GAINS = {
	0: [
		{ rcRate: 1.0, superRate: 0.0, expo: 0.0 },
		{ rcRate: 1.0, superRate: 0.5, expo: 0.4 },
		{ rcRate: 1.7, superRate: 0.7, expo: 0.7 },
		{ rcRate: 2.5, superRate: 0.3, expo: 0.2 },
	],
	// superRate is the full-stick rate and MUST be >= rcRate: see the fold-back
	// test below for what happens when it is not.
	1: [
		{ rcRate: 200, superRate: 200, expo: 0.0 },
		{ rcRate: 200, superRate: 800, expo: 0.4 },
		{ rcRate: 120, superRate: 1100, expo: 0.7 },
	],
	2: [
		{ rcRate: 200, superRate: 0, expo: 0 },
		{ rcRate: 300, superRate: 40, expo: 50 },
		{ rcRate: 400, superRate: 70, expo: 70 },
	],
	3: [
		{ rcRate: 1.0, superRate: 0.0, expo: 0.0 },
		{ rcRate: 1.0, superRate: 0.5, expo: 0.4 },
		{ rcRate: 2.5, superRate: 0.7, expo: 0.7 },
	],
	4: [
		{ rcRate: 1.0, superRate: 200, expo: 0.0 },
		{ rcRate: 1.0, superRate: 900, expo: 0.4 },
		{ rcRate: 2.5, superRate: 1100, expo: 0.7 },
	],
};
const sweep = (steps = 401) => Array.from({ length: steps }, (_, i) => -1 + (2 * i) / (steps - 1));

t('every family is zero at centre stick', () => {
	for (const type of RATE_TYPES) {
		for (const g of GAINS[type]) {
			const v = rates(type, 0, g.rcRate, g.superRate, g.expo);
			assert.equal(v, 0, `type ${type} @ rc=0 -> ${v}`);
		}
	}
});

t('every family is odd in the stick', () => {
	for (const type of RATE_TYPES) {
		for (const g of GAINS[type]) {
			for (const rc of sweep(101)) {
				const a = rates(type, rc, g.rcRate, g.superRate, g.expo);
				const b = rates(type, -rc, g.rcRate, g.superRate, g.expo);
				assert.ok(Math.abs(a + b) <= 1e-9 * Math.max(1, Math.abs(a)),
					`type ${type} rc=${rc}: ${a} vs ${b}`);
			}
		}
	}
});

t('every family grows with |stick|', () => {
	for (const type of RATE_TYPES) {
		for (const g of GAINS[type]) {
			let prev = 0;
			for (let i = 1; i <= 200; i++) {
				const v = Math.abs(rates(type, i / 200, g.rcRate, g.superRate, g.expo));
				assert.ok(v >= prev - 1e-12, `type ${type} not monotone at ${i / 200}: ${v} < ${prev}`);
				prev = v;
			}
			assert.ok(prev > 0, `type ${type} is flat zero for ${JSON.stringify(g)}`);
		}
	}
});

t('types 3 and 4 clamp at +/-1998, and reach it', () => {
	for (const type of [3, 4]) {
		// Gains large enough that the unclamped formula runs away.
		const hot = { rcRate: 40, superRate: type === 3 ? 0.95 : 20000, expo: 0.2 };
		for (const rc of sweep(201)) {
			const v = rates(type, rc, hot.rcRate, hot.superRate, hot.expo);
			assert.ok(v >= -1998 && v <= 1998, `type ${type} rc=${rc} -> ${v}`);
		}
		assert.equal(rates(type, 1, hot.rcRate, hot.superRate, hot.expo), 1998, `type ${type} top`);
		assert.equal(rates(type, -1, hot.rcRate, hot.superRate, hot.expo), -1998, `type ${type} bottom`);
	}
});

t('types 0, 1 and 2 are NOT clamped — the spec clamps only 3 and 4', () => {
	// Pinned because it is surprising, not because it is desirable: §5 puts the
	// +/-1998 guard on two families out of five. If a later reading of the spec
	// adds it everywhere, this test is the place that says it was a choice.
	assert.ok(rates(0, 1, 40, 0.95, 0.2) > 1998);
});

t('any type outside 0..4 returns 0', () => {
	for (const type of [-1, 5, 99, 1.5, NaN, null, undefined, 'actual', '0']) {
		assert.equal(rates(type, 0.7, 1.2, 0.6, 0.4), 0, `type ${String(type)}`);
	}
});

t('a non-finite stick or gain returns 0 rather than propagating NaN', () => {
	for (const type of RATE_TYPES) {
		assert.equal(rates(type, NaN, 1, 0.5, 0.3), 0);
		assert.equal(rates(type, 0.5, NaN, 0.5, 0.3), 0);
		assert.equal(rates(type, 0.5, 1, Infinity, 0.3), 0);
	}
});

t('the stick saturates at +/-1 instead of extrapolating', () => {
	for (const type of RATE_TYPES) {
		for (const g of GAINS[type]) {
			const full = rates(type, 1, g.rcRate, g.superRate, g.expo);
			assert.equal(rates(type, 4.2, g.rcRate, g.superRate, g.expo), full, `type ${type}`);
			assert.equal(rates(type, -4.2, g.rcRate, g.superRate, g.expo),
				rates(type, -1, g.rcRate, g.superRate, g.expo), `type ${type}`);
		}
	}
});

t('type 0 rescales an rcRate above 2.0 and only above it', () => {
	// The `rcRate += (rcRate - 2) * 14.54` of §5, observed from outside: the
	// curve is linear in rcRate up to 2.0 and 15.54x steeper past it.
	const at = (r) => rates(0, 1, r, 0, 0);
	assert.ok(Math.abs(at(2.0) / at(1.0) - 2) < 1e-12);
	assert.ok(Math.abs(at(3.0) / at(1.0) - (3 + 14.54)) < 1e-9);
});

t('type 1 folds back when superRate < rcRate — a real spec hazard, pinned', () => {
	// §5 gives type 1 no domain for its gains, and the formula has no guard
	// equivalent to ACTUAL's `max(0, max - centre)`. With superRate below
	// rcRate the curve peaks mid-stick and comes back DOWN: at rcRate 1,
	// superRate 0 the pilot gets 0.25 deg/s at half stick and exactly ZERO at
	// full stick. A UI that lets the two be set independently hands a pilot a
	// dead full-stick without saying so. Transcribed as written; recorded here.
	assert.equal(rates(1, 1, 1, 0, 0), 0);
	assert.ok(rates(1, 0.5, 1, 0, 0) > rates(1, 1, 1, 0, 0));
});

t('type 4 is zero when rcRate is (numerically) zero', () => {
	for (const rc of [-1, -0.3, 0.3, 1]) {
		assert.equal(rates(4, rc, 0, 900, 0.3), 0);
		assert.equal(rates(4, rc, 1e-9, 900, 0.3), 0);
	}
});

// --- The anchor -------------------------------------------------------------

// The pre-lot body of flightController.js:actualRate(), copied here verbatim.
// It is the thing this lot must not have moved, so it is written out rather
// than imported: importing the implementation to test the implementation would
// prove nothing.
function actualRateBefore(stick, r) {
	const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
	const rc = clamp(stick, -1, 1);
	const a = Math.abs(rc);
	const expof = r.expo * (a ** 3) + a * (1 - r.expo);
	const stickMovement = Math.max(0, r.max - r.centre);
	return Math.sign(rc) * (a * r.centre + stickMovement * expof) * DEG;
}

t('ACTUAL reproduces the old actualRate() bit for bit, every preset, fine sweep', () => {
	const sticks = sweep(4001).concat([-1.5, 1.5, 0, -0, 1e-12]);
	for (const [name, preset] of Object.entries(RATE_PRESETS)) {
		for (const axis of ['roll', 'pitch', 'yaw']) {
			const r = preset[axis];
			for (const s of sticks) {
				const want = actualRateBefore(s, r);
				assert.equal(actualRate(s, r), want, `${name}.${axis} @ ${s} (rad/s)`);
				assert.equal(actualRateDeg(s, r) * DEG, want, `${name}.${axis} @ ${s} (deg path)`);
				assert.equal(rateFor(s, r) * DEG, want, `${name}.${axis} @ ${s} (dispatch)`);
			}
		}
	}
});

t('an axis that names ACTUAL explicitly takes the same path', () => {
	const r = RATE_PRESETS.freestyle.roll;
	const tagged = { ...r, type: RATE_ACTUAL };
	for (const s of sweep(201)) assert.equal(rateFor(s, tagged), rateFor(s, r));
});

t('rateFor dispatches a typed axis to the spec family', () => {
	const axis = { type: 3, rcRate: 1.2, superRate: 0.5, expo: 0.3 };
	for (const s of sweep(101)) {
		assert.equal(rateFor(s, axis), rates(3, s, 1.2, 0.5, 0.3), `@ ${s}`);
	}
	assert.equal(rateFor(0.5, null), 0);
});

t('maxRateDeg is the preset max for ACTUAL and the measured full stick otherwise', () => {
	for (const preset of Object.values(RATE_PRESETS)) {
		assert.equal(maxRateDeg(preset.roll), preset.roll.max);
	}
	const axis = { type: 0, rcRate: 1.5, superRate: 0.6, expo: 0.4 };
	assert.equal(maxRateDeg(axis), Math.abs(rates(0, 1, 1.5, 0.6, 0.4)));
	assert.ok(maxRateDeg(axis) > 0);
});

console.log(`rates-selftest : ${n} tests ok`);

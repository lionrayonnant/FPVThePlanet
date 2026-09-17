// Selftest for the bench's build logic (issue #159). No I/O, no DOM.
// Run: node tools/bench-airframe-selftest.mjs
//
// Two things are worth more than the rest here, and they are the first two
// blocks:
//
//   1. NOMINAL with no override IS the family's profile — the same object, not
//      an equal copy. Forty parameters were added to the bench and not one
//      number moved, which is the acceptance criterion of the issue.
//   2. Every parameter key names something that actually exists. A typo in a
//      path would produce a control that reads `undefined`, writes into a
//      structure nobody reads, and looks like it works.
import assert from 'node:assert/strict';
import {
	BUILD_BASES, PARAM_GROUPS, PARAMS, DERIVATION, RPM_DROOP, THRUST_AUGMENT,
	FAMILY_PARTS, BLADE_COUNTS, RATE_FAMILIES, DISCHARGE_CURVES,
	partOptions, defaultParts, normalizeParts, normalizeOverrides,
	normalizeAirframe, airframeDefaults, airframeIdentity, airframeSummary,
	deriveCustomProfile, buildWarnings, resolveBenchAirframe, allowanceG,
	paramValue, formatParam,
} from './bench-airframe.mjs';
import { PROFILES, FAMILIES } from '../src/drone-profiles.js';
import { rateFor, RATE_ACTUAL } from '../src/rates.js';
import { throttleChain, DEFAULT_THROTTLE } from '../src/throttle.js';
import { normalizeBenchConfig, serializeBenchConfig, parseBenchConfig } from './bench-model.mjs';
import {
	SPEC_FRAMES, SPEC_MOTORS, SPEC_PROPELLERS, SPEC_BATTERIES, SPEC_CAMERAS,
	INCH, CELL_VOLTS_LOADED,
} from '../src/spec-data/index.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);

// ---------------------------------------------------------------------------
// The feature is inert until something is set

t('NOMINAL with no override IS the family profile, not a copy', () => {
	for (const family of FAMILIES) {
		const r = resolveBenchAirframe({ family });
		assert.equal(r.profile, PROFILES[family], `${family} flies its own reference object`);
		assert.equal(r.rates, null, 'and no rate table: the controller keeps its preset');
		assert.equal(r.throttle, null, 'and no throttle config: DEFAULT_THROTTLE stays inert');
		assert.equal(r.build, null);
		assert.deepEqual(r.warnings, []);
	}
});

t('an override never writes into the family profile', () => {
	const before = JSON.stringify(PROFILES.freestyle5);
	const r = resolveBenchAirframe({
		family: 'freestyle5',
		overrides: { mass: 0.9, 'inertia.x': 0.004, 'battery.cells': 6, 'pid.roll.p': 0.1 },
	});
	assert.equal(JSON.stringify(PROFILES.freestyle5), before, 'the reference build is untouched');
	assert.equal(r.profile.mass, 0.9);
	assert.equal(r.profile.inertia.x, 0.004);
	assert.equal(r.profile.inertia.y, PROFILES.freestyle5.inertia.y, 'the siblings come from the base');
	assert.equal(r.profile.battery.cells, 6);
	assert.equal(r.profile.pid.roll.p, 0.1);
	assert.equal(r.profile.pid.pitch.p, PROFILES.freestyle5.pid.pitch.p);
});

// ---------------------------------------------------------------------------
// The parameter table

t('every parameter key names something that exists, on every family', () => {
	for (const family of FAMILIES) {
		const r = resolveBenchAirframe({ family });
		for (const p of PARAMS.values()) {
			const v = paramValue(p.key, {
				profile: r.profile, rates: r.ratesView, rateFamily: r.rateFamily,
			});
			// escCurrentLimit is null on every shipped family and that IS its
			// value: null reads UNCAPPED, undefined would be a broken path.
			assert.notEqual(v, undefined, `${family}: ${p.key} resolves to nothing`);
		}
	}
});

t('a parameter written is a parameter read back', () => {
	// The round trip that catches a path which normalises fine and then lands
	// somewhere nothing reads.
	for (const p of PARAMS.values()) {
		const value = p.options ? p.options[p.options.length - 1] : (p.min + p.max) / 2;
		const set = p.int ? Math.round(value) : value;
		const r = resolveBenchAirframe({ family: 'freestyle5', overrides: { [p.key]: set } });
		const read = paramValue(p.key, {
			profile: r.profile, rates: r.ratesView, rateFamily: r.rateFamily,
		});
		if (p.nullAtMin && set <= p.min) assert.equal(read, null, `${p.key} at its floor is UNCAPPED`);
		else assert.equal(read, set, `${p.key} reads back what was written`);
	}
});

t('the table is coherent: unique keys, ordered bounds, a usable step', () => {
	const keys = PARAM_GROUPS.flatMap((g) => g.params.map((p) => p.key));
	assert.equal(new Set(keys).size, keys.length, 'no key appears twice');
	assert.equal(keys.length, PARAMS.size);
	for (const p of PARAMS.values()) {
		assert.ok(p.label && typeof p.label === 'string', `${p.key} has a label`);
		if (p.options) { assert.ok(p.options.length >= 2, `${p.key} offers a choice`); continue; }
		assert.ok(p.min < p.max, `${p.key}: ${p.min} < ${p.max}`);
		assert.ok(p.step > 0, `${p.key} has a step`);
		assert.ok(p.step <= (p.max - p.min), `${p.key}'s step fits inside its range`);
	}
	// Every group is named and non-empty: the headings are what make forty rows
	// readable as seven blocks.
	for (const g of PARAM_GROUPS) {
		assert.ok(g.label && g.params.length, `group ${g.key}`);
	}
});

t('the table covers what the flight stack actually reads off a profile', () => {
	// The known failure mode: a lot adds a field to drone-profiles.js, the
	// engine starts reading it, and the bench is silently the one place that
	// cannot set it. This list is the contract, and it is written out rather
	// than derived so that adding a field is a deliberate edit here too.
	const expected = [
		'mass', 'inertia.x', 'inertia.y', 'inertia.z', 'armX', 'armZ',
		'propRadius', 'propPitch', 'bladeCount', 'propInertia',
		'motor.kv', 'motor.noLoadCurrent', 'maxOmega', 'maxThrustPerMotor',
		'torqueRatio', 'escCurrentLimit',
		'battery.cells', 'battery.capacityMah', 'battery.internalOhm',
		'battery.maxCurrent', 'battery.dischargeCurve',
		'bodyDrag.x', 'bodyDrag.y', 'bodyDrag.z', 'dragScale',
		'inflowGain', 'buffetGain', 'lateralGain',
		'filterScale', 'gyroNoise', 'loopDelay',
		'minThrottle', 'throttleBands.low', 'throttleBands.med', 'throttleBands.high',
	];
	for (const key of expected) assert.ok(PARAMS.has(key), `${key} is not settable at the bench`);
	// `radius` is deliberately NOT here: the collision sphere is 0.15 m for
	// every family and camera.near is pinned to it (CLAUDE.md, physics.js).
	assert.ok(!PARAMS.has('radius'), 'the collision sphere is not a bench parameter');
});

// ---------------------------------------------------------------------------
// Normalisation: it brings back, it never rejects

t('normalizeOverrides: clamps, rounds, and drops what it does not know', () => {
	const o = normalizeOverrides({
		mass: 999,                     // over the ceiling
		'motor.kv': -40,               // under the floor
		'battery.cells': 3.7,          // an integer parameter
		'bodyDrag.x': 'beaucoup',      // not a number
		gyroNoise: NaN,
		loopDelay: null,
		'inertia.x': '0.004',          // a string that is a number
		'battery.dischargeCurve': 'liion',
		'pid.roll.z': 12,              // no such parameter
		nonsense: 3,
	});
	assert.equal(o.mass, PARAMS.get('mass').max);
	assert.equal(o['motor.kv'], PARAMS.get('motor.kv').min);
	assert.equal(o['battery.cells'], 4);
	assert.equal(o['inertia.x'], 0.004);
	assert.equal(o['battery.dischargeCurve'], 'liion');
	for (const gone of ['bodyDrag.x', 'gyroNoise', 'loopDelay', 'pid.roll.z', 'nonsense']) {
		assert.ok(!(gone in o), `${gone} was dropped`);
	}
});

t('normalizeOverrides: an enum only takes one of its own values', () => {
	assert.deepEqual(normalizeOverrides({ 'battery.dischargeCurve': 'nickel' }), {});
	for (const c of DISCHARGE_CURVES) {
		assert.equal(normalizeOverrides({ 'battery.dischargeCurve': c })['battery.dischargeCurve'], c);
	}
	for (const [v] of RATE_FAMILIES) {
		assert.equal(normalizeOverrides({ rateFamily: v }).rateFamily, v);
	}
});

t('normalizeAirframe: anything at all comes back resolvable', () => {
	for (const junk of [undefined, null, 0, '', 'nope', [], NaN, true, { base: 'MAGIC' }]) {
		const a = normalizeAirframe(junk);
		assert.ok(BUILD_BASES.includes(a.base));
		assert.ok(typeof a.family === 'string' && a.family);
		assert.deepEqual(a.overrides, {});
		// And it resolves without throwing, which is what the screen needs.
		assert.ok(resolveBenchAirframe(junk).profile.mass > 0);
	}
});

t('normalizeAirframe: the pre-#159 shape comes forward on its own', () => {
	// `{family, seed}`, where the presence of a seed WAS the base.
	assert.equal(normalizeAirframe({ family: 'race5', seed: '4f2a91' }).base, 'INDIVIDUAL');
	assert.equal(normalizeAirframe({ family: 'race5' }).base, 'NOMINAL');
	// And INDIVIDUAL with no seed is not a state: it would claim a drawn machine
	// while flying the nominal one. One gets drawn rather than the base refused.
	const a = normalizeAirframe({ family: 'race5', base: 'INDIVIDUAL' });
	assert.ok(a.seed, 'a seed was drawn instead of the base being rejected');
	assert.equal(resolveBenchAirframe(a).build.family, 'race5');
});

t('normalizeAirframe: the family list is the caller\'s, like the rest of the model', () => {
	// Without the list any name goes through — the model does not get to decide
	// a family has gone away (same rule as tools/bench-model.mjs).
	assert.equal(normalizeAirframe({ family: 'ornithopter' }).family, 'ornithopter');
	assert.equal(normalizeAirframe({ family: 'ornithopter' }, { families: FAMILIES }).family, 'freestyle5');
	for (const f of FAMILIES) {
		assert.equal(normalizeAirframe({ family: f }, { families: FAMILIES }).family, f);
	}
});

t('normalizeParts: a part that has left the catalogue falls back to the family\'s', () => {
	const p = normalizeParts({ frame: 'Mothership', motor: null, prop: '5043', blades: 7 }, 'race5');
	assert.equal(p.frame, FAMILY_PARTS.race5.frame);
	assert.equal(p.motor, FAMILY_PARTS.race5.motor);
	assert.equal(p.prop, '5043', 'a real part number goes through');
	assert.ok(BLADE_COUNTS.includes(p.blades));
	// A build with no motor is not a state the screen can show.
	for (const key of ['frame', 'motor', 'prop', 'battery', 'camera']) {
		assert.ok(normalizeParts(null, 'toothpick')[key], `${key} is always set`);
	}
});

t('every family declares a buildable bill, and the options are offered', () => {
	const opts = partOptions();
	for (const [family, parts] of Object.entries(FAMILY_PARTS)) {
		assert.ok(PROFILES[family], `${family} is a real family`);
		assert.ok(SPEC_FRAMES[parts.frame], `${family}: frame`);
		assert.ok(SPEC_MOTORS[parts.motor], `${family}: motor`);
		assert.ok(SPEC_PROPELLERS[parts.prop], `${family}: prop`);
		assert.ok(SPEC_BATTERIES[parts.battery], `${family}: battery`);
		assert.ok(SPEC_CAMERAS[parts.camera], `${family}: camera`);
		for (const key of ['frame', 'motor', 'prop', 'battery', 'camera']) {
			assert.ok(opts[key].some(([id]) => id === parts[key]), `${family}: ${key} is pickable`);
		}
	}
	// FAMILIES is what the screen offers; each of them needs a default bill.
	for (const f of FAMILIES) assert.ok(FAMILY_PARTS[f], `${f} has no bill of materials`);
	for (const [, label] of Object.values(opts).flat()) {
		assert.ok(!/undefined|NaN/.test(label), `no technical leak in "${label}"`);
	}
});

// ---------------------------------------------------------------------------
// CUSTOM — the four rules of drone-profiles.js, applied

t('CUSTOM: the four derivation rules are applied as written', () => {
	// race5's bill is the one its own comment names, part for part, so it is the
	// one build where the derivation can be checked against a shipped family
	// rather than against itself.
	const p = deriveCustomProfile({ family: 'race5' });
	const base = PROFILES.race5;
	const parts = FAMILY_PARTS.race5;
	const motor = SPEC_MOTORS[parts.motor];
	const pack = SPEC_BATTERIES[parts.battery];
	const prop = SPEC_PROPELLERS[parts.prop];

	// Rule 1, the rpm droop.
	const omega = DERIVATION.rpmDroop * motor.kv * pack.cells * CELL_VOLTS_LOADED * (2 * Math.PI) / 60;
	near(p.maxOmega, omega, 1e-6, 'maxOmega follows rule 1');
	near(p.maxOmega, base.maxOmega, 1, 'and lands on the family that was built that way');

	// Rule 2, the thrust coefficient.
	const D = prop.diameterIn * INCH;
	const ct = DERIVATION.ctK * (prop.pitchIn / prop.diameterIn) * (parts.blades / 3) ** DERIVATION.solidityExp;
	near(p.maxThrustPerMotor, ct * DERIVATION.rho * (omega / (2 * Math.PI)) ** 2 * D ** 4, 1e-6, 'thrust follows rule 2');
	near(p.maxThrustPerMotor, base.maxThrustPerMotor, 0.1, 'and lands on the family');

	// Rules 3 and 4.
	near(p.battery.maxCurrent, base.battery.maxCurrent, 1, 'pack draw follows rule 3');
	near(p.battery.internalOhm, base.battery.internalOhm, 1e-4, 'pack resistance follows rule 4');

	// Rules 5 and 6.
	near(p.armX, DERIVATION.armPerPropRadius * p.propRadius, 1e-9, 'the arm follows the prop');
	assert.equal(p.armX, p.armZ);
	near(p.propInertia, DERIVATION.propInertiaK * (prop.massG / 1000) * p.propRadius ** 2, 1e-12, 'rotor inertia follows rule 6');
});

t('CUSTOM: a family built from its own bill lands on its own mass', () => {
	// The allowance is read off each family rather than being one 5"-class
	// constant: without it a 90 g toothpick would come back 55 % heavier.
	for (const family of FAMILIES) {
		const p = deriveCustomProfile({ family });
		const slack = allowanceG(family);
		if (slack > 0) near(p.mass, PROFILES[family].mass, 1e-9, `${family} mass`);
		else assert.ok(p.mass >= PROFILES[family].mass, `${family}: its nearest bill already outweighs it`);
	}
});

t('CUSTOM: heavier parts make a heavier machine, and the readout follows', () => {
	const light = resolveBenchAirframe({ family: 'freestyle5', base: 'CUSTOM', parts: { ...defaultParts('freestyle5'), battery: '4s-650', camera: '0' } });
	const heavy = resolveBenchAirframe({ family: 'freestyle5', base: 'CUSTOM', parts: { ...defaultParts('freestyle5'), battery: '6s-3000', camera: '2' } });
	assert.ok(heavy.profile.mass > light.profile.mass, 'a bigger pack and a GoPro weigh more');
	assert.ok(heavy.derived.twr < light.derived.twr * 2, 'and six cells buy back some of it');
	assert.ok(light.derived.twr > 1, 'the light build leaves the ground');
	for (const r of [light, heavy]) {
		for (const v of Object.values(r.derived)) assert.ok(Number.isFinite(v), 'no NaN in the readout');
	}
});

t('CUSTOM: the family keeps what makes it that family', () => {
	// Issue #44's prohibition. A bill of materials decides mass, geometry,
	// rotor, motor and pack; it does not decide the measured tune, the drag
	// signature or the disc gains — those are the airframe's character.
	const base = PROFILES.cinewhoop;
	const p = deriveCustomProfile({ family: 'cinewhoop', parts: { ...defaultParts('cinewhoop'), battery: '6s-1700' } });
	assert.equal(p.family, 'cinewhoop');
	assert.deepEqual(p.pid, base.pid);
	assert.deepEqual(p.bodyDrag, base.bodyDrag);
	assert.equal(p.torqueRatio, base.torqueRatio);
	assert.equal(p.inflowGain, base.inflowGain);
	assert.equal(p.rates, base.rates);
	// And the ducts are still worth their +15 %, which is rule 2's one
	// documented exception.
	assert.equal(THRUST_AUGMENT.cinewhoop, 1.15);
	const open = deriveCustomProfile({ family: 'race5', parts: { ...defaultParts('race5'), prop: FAMILY_PARTS.cinewhoop.prop } });
	const duct = deriveCustomProfile({ family: 'cinewhoop', parts: { ...defaultParts('cinewhoop'), battery: FAMILY_PARTS.race5.battery, motor: FAMILY_PARTS.race5.motor } });
	assert.ok(open.maxThrustPerMotor > 0 && duct.maxThrustPerMotor > 0);
});

t('CUSTOM: rule 1\'s exception is heavy5\'s, and only heavy5\'s', () => {
	assert.deepEqual(Object.keys(RPM_DROOP), ['heavy5']);
	near(deriveCustomProfile({ family: 'heavy5' }).maxOmega, PROFILES.heavy5.maxOmega, 2, 'the spec\'s own worked example');
});

t('buildWarnings: a part that does not fit is said, never refused', () => {
	assert.deepEqual(buildWarnings(defaultParts('race5'), 'race5'), [], 'a coherent bill says nothing');
	// A 7" prop on a 5" race frame.
	const wrong = buildWarnings({ ...defaultParts('race5'), prop: '7055' }, 'race5');
	assert.ok(wrong.length >= 1);
	assert.ok(wrong.some((w) => /RATED/.test(w)), `a fitment window is named — ${wrong.join(' / ')}`);
	// And the resolution still produces a flyable profile: the bench informs,
	// it does not forbid (Bible §2).
	const r = resolveBenchAirframe({ family: 'race5', base: 'CUSTOM', parts: { ...defaultParts('race5'), prop: '7055' } });
	assert.ok(r.profile.maxThrustPerMotor > 0);
	assert.deepEqual(r.warnings, wrong);
	// Rule 4 under-reads a small pack by a factor of four; that is said rather
	// than flown silently.
	assert.ok(buildWarnings(defaultParts('toothpick'), 'toothpick')
		.some((w) => /EXTRAPOLATED BELOW 1 Ah/.test(w)));
});

// ---------------------------------------------------------------------------
// Rates and throttle — the two things that are not profile fields

t('rates: the table only materialises when something touches it', () => {
	assert.equal(resolveBenchAirframe({ family: 'race5' }).rates, null);
	const r = resolveBenchAirframe({ family: 'race5', overrides: { 'rates.roll.max': 900 } });
	assert.equal(r.rates.roll.max, 900);
	assert.equal(r.rates.pitch.max, PROFILES.race5 && r.ratesView.pitch.max, 'the other axes come from the preset');
	// And an individual's owner's rates are the base when there is one.
	const ind = resolveBenchAirframe({ family: 'race5', base: 'INDIVIDUAL', seed: '4f2a91' });
	assert.ok(ind.rates, 'a drawn individual always flies its own rates');
});

t('rates: a spec family changes the SHAPE src/rates.js dispatches on', () => {
	const r = resolveBenchAirframe({
		family: 'freestyle5',
		overrides: { rateFamily: 0, 'rates.roll.rcRate': 1.2, 'rates.roll.superRate': 0.65 },
	});
	assert.equal(r.rates.roll.type, 0, 'the axis carries a numeric type');
	assert.equal(r.rates.roll.rcRate, 1.2);
	assert.equal(r.rates.roll.superRate, 0.65);
	// Every axis is rewritten, not just the one that was set: leaving a
	// (centre, max) entry beside a (rcRate, superRate) one would fly two
	// parameterisations at once.
	for (const axis of ['roll', 'pitch', 'yaw']) {
		assert.equal(r.rates[axis].type, 0, `${axis} carries the family`);
		assert.ok(Number.isFinite(rateFor(1, r.rates[axis])), `${axis} evaluates`);
		assert.ok(Number.isFinite(rateFor(-0.3, r.rates[axis])));
	}
	// ACTUAL keeps this repo's own parameterisation, untyped.
	const actual = resolveBenchAirframe({ family: 'freestyle5', overrides: { rateFamily: RATE_ACTUAL } });
	assert.equal(actual.rates.roll.type, undefined);
	assert.equal(actual.rates.roll.max, PROFILES.freestyle5 && actual.ratesView.roll.max);
});

t('rates: all six families evaluate on every axis', () => {
	for (const [family] of RATE_FAMILIES) {
		const r = resolveBenchAirframe({ family: 'race5', overrides: { rateFamily: family } });
		for (const axis of ['roll', 'pitch', 'yaw']) {
			for (const stick of [-1, -0.5, 0, 0.5, 1]) {
				const v = rateFor(stick, r.rates[axis]);
				assert.ok(Number.isFinite(v), `${family} ${axis} at ${stick}`);
			}
		}
	}
});

t('throttle: the config is built only when it is touched, and converts once', () => {
	assert.equal(resolveBenchAirframe({ family: 'race5' }).throttle, null);
	assert.equal(resolveBenchAirframe({ family: 'race5', overrides: { mass: 0.6 } }).throttle, null,
		'an unrelated override does not conjure a throttle curve');
	const r = resolveBenchAirframe({ family: 'race5', overrides: { minThrottle: 0.055, 'throttleBands.high': 1.4 } });
	// The profile field is a fraction 0..1; src/throttle.js reads a PERCENT and
	// divides it by 80. That x100 happens in exactly one place.
	near(r.throttle.minThrottle, 5.5, 1e-9, 'the fraction became a percent');
	assert.equal(r.throttle.high, 1.4);
	assert.equal(r.throttle.medium, 1, 'the untouched bands stay flat');
	assert.equal(r.throttle.shape, null);
	// And the chain it feeds actually moves: a floor is a floor.
	assert.ok(throttleChain(0, r.throttle) > throttleChain(0, DEFAULT_THROTTLE), 'the floor lifts the bottom of the travel');
});

// ---------------------------------------------------------------------------
// Identity — what main.js keys its hot swap on

t('identity: every part of the build is in the hash', () => {
	const base = { family: 'race5', base: 'NOMINAL', seed: null, parts: null, overrides: {} };
	const id = (a) => airframeIdentity(a);
	const seen = new Set([id(base)]);
	for (const variant of [
		{ ...base, family: 'freestyle5' },
		{ ...base, base: 'INDIVIDUAL', seed: 'aaaaaa' },
		{ ...base, base: 'INDIVIDUAL', seed: 'bbbbbb' },
		{ ...base, base: 'CUSTOM' },
		{ ...base, base: 'CUSTOM', parts: { ...defaultParts('race5'), prop: '5043' } },
		{ ...base, overrides: { mass: 0.6 } },
		{ ...base, overrides: { mass: 0.61 } },
		{ ...base, overrides: { mass: 0.6, gyroNoise: 0.1 } },
	]) {
		const h = id(variant);
		assert.ok(!seen.has(h), `${JSON.stringify(variant)} collides`);
		seen.add(h);
	}
	// And it is stable: the same build hashes the same, whatever order the
	// overrides were typed in.
	assert.equal(id({ ...base, overrides: { mass: 0.6, gyroNoise: 0.1 } }),
		id({ ...base, overrides: { gyroNoise: 0.1, mass: 0.6 } }));
});

t('identity: the PLANT hash ignores what is not the plant', () => {
	// physics.setProfile() rebuilds the Propulsion and hands back a full pack.
	// A rate or a throttle band must not cost a recharge.
	const a = resolveBenchAirframe({ family: 'race5' });
	const rates = resolveBenchAirframe({ family: 'race5', overrides: { 'rates.roll.max': 900 } });
	assert.notEqual(rates.identity, a.identity, 'the build is not the same build');
	assert.equal(rates.profileIdentity, a.profileIdentity, 'but the plant has not moved');
	const mass = resolveBenchAirframe({ family: 'race5', overrides: { mass: 0.6 } });
	assert.notEqual(mass.profileIdentity, a.profileIdentity, 'a mass change is a new plant');
});

// ---------------------------------------------------------------------------
// Display

t('airframeSummary and formatParam never leak', () => {
	for (const a of [
		{ family: 'race5' },
		{ family: 'race5', base: 'INDIVIDUAL', seed: '4f2a91' },
		{ family: 'race5', base: 'CUSTOM' },
		{ family: 'race5', overrides: { mass: 0.6, gyroNoise: 0.2 } },
	]) {
		const line = airframeSummary(a);
		assert.ok(line.length && !/undefined|NaN|null|\[object/.test(line), `"${line}"`);
		const r = resolveBenchAirframe(a);
		for (const p of PARAMS.values()) {
			const shown = formatParam(p.key, paramValue(p.key, {
				profile: r.profile, rates: r.ratesView, rateFamily: r.rateFamily,
			}));
			assert.ok(shown.length && !/undefined|NaN|\[object/.test(shown), `${p.key}: "${shown}"`);
		}
	}
	assert.equal(airframeSummary({ family: 'race5', overrides: { mass: 0.6 } }), 'NOMINAL · 1 SET');
	assert.equal(formatParam('escCurrentLimit', null), 'UNCAPPED');
});

// ---------------------------------------------------------------------------
// Through the bench config, to disk and back

t('the build survives a round trip through the stored config', () => {
	const cfg = normalizeBenchConfig({
		airframe: {
			family: 'cinewhoop', base: 'CUSTOM',
			parts: { ...defaultParts('cinewhoop'), motor: '2700-2207' },
			overrides: { mass: 0.72, 'pid.yaw.p': 0.19, 'battery.dischargeCurve': 'liion' },
		},
	}, { families: FAMILIES });
	const back = parseBenchConfig(serializeBenchConfig(cfg), { families: FAMILIES });
	assert.deepEqual(back.airframe, cfg.airframe);
	const r = resolveBenchAirframe(back.airframe);
	assert.equal(r.profile.mass, 0.72);
	assert.equal(r.profile.pid.yaw.p, 0.19);
	assert.equal(r.profile.battery.dischargeCurve, 'liion');
	assert.equal(r.profile.motor.kv, SPEC_MOTORS['2700-2207'].kv, 'the catalogue motor came through');
});

t('the defaults are what the bench opens on, and they are inert', () => {
	const d = airframeDefaults();
	assert.equal(d.base, 'NOMINAL');
	assert.equal(d.seed, null);
	assert.equal(d.parts, null);
	assert.deepEqual(d.overrides, {});
	assert.equal(resolveBenchAirframe(d).profile, PROFILES[d.family]);
});

console.log(`\n${n} tests bench-airframe OK`);

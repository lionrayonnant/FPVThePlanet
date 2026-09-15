// BENCH — the exact machine (issue #159). Pure logic: no DOM, no I/O, no Three,
// importable by src/bench.js in the browser and by the selftest in Node.
//
// The bench's airframe was a dropdown over six families. A family is a TYPE of
// machine, not the machine you are about to fly, and the bench is the one place
// that is supposed to have total control. So the airframe becomes a build:
//
//   BASE       NOMINAL          the family's reference profile, untouched
//              INDIVIDUAL seed  the drawn exemplar (PHASE 07, target-build.mjs)
//              CUSTOM parts     assembled from the spec catalogue
//   OVERRIDES  any parameter of the resolved profile, set by hand
//
// The two compose: overrides apply on top of whichever base produced the
// profile, so an operator can roll an individual and then pin its pack
// resistance, or assemble a catalogue build and then push its gyro noise.
//
// NOMINAL with no override resolves to PROFILES[family] ITSELF — same object
// identity, not a copy. The whole module is inert until something is set, which
// is the acceptance criterion: adding it moved no number.
//
// Normalisation follows the bench's own rule (tools/bench-model.mjs): it BRINGS
// BACK, it never rejects. An unknown key is dropped, an out-of-range value is
// clamped, a corrupt parts list falls back to the family's own bill.

import { PROFILES, DEFAULT_FAMILY, FAMILIES } from '../src/drone-profiles.js';
import { RATE_PRESETS } from '../src/flightController.js';
import { RATE_ACTUAL } from '../src/rates.js';
import { targetBuild } from './target-build.mjs';
import {
	SPEC_FRAMES, SPEC_MOTORS, SPEC_PROPELLERS, SPEC_BATTERIES, SPEC_CAMERAS,
	INCH, CELL_VOLTS_LOADED,
} from '../src/spec-data/index.js';

export const BUILD_BASES = ['NOMINAL', 'INDIVIDUAL', 'CUSTOM'];

// ---------------------------------------------------------------------------
// The derivation constants
//
// NOT new physics and NOT new fitting: these are the four rules already written
// out at the head of src/drone-profiles.js ("WHERE THE HARDWARE NUMBERS COME
// FROM"), transcribed so a catalogue build goes through the same arithmetic
// that produced the six shipped families. Every one of them is anchored on
// freestyle5, which stays the reference build.
//
// Two more are needed because a catalogue entry says nothing about arms or
// rotor inertia, and both are anchored on that same build rather than guessed:
//
//   5. ARM. A quad's arms are as long as its props let them be — motor to
//      motor, the discs nearly touch. freestyle5 measures armX / propRadius =
//      0.078 / 0.0635 = 1.228, and that ratio is what sizes a catalogue build.
//   6. ROTOR INERTIA. I = k * m * r^2 for the rotor as a whole. freestyle5's
//      4.0e-6 on a 4 g 5" prop gives k = 0.248, which is a plausible disc-ish
//      distribution and, more to the point, is a measurement of the one build
//      every other number here is measured against.
export const DERIVATION = Object.freeze({
	rpmDroop: 0.765,            // rule 1, freestyle5's 29985 / (2450 * 4 * 4.0 V)
	ctK: 0.1460,                // rule 2
	solidityExp: 0.75,          // rule 2, BEMT blade-count exponent
	rho: 1.225,                 // kg/m3, sea level — src/air.js's constant
	packDrawK: 0.67,            // rule 3, motor/ESC efficiency lumped
	cellMilliOhm: 2.5,          // rule 4, the reference 4S 1300's own cell
	refCapacityMah: 1300,       // rule 4's anchor capacity
	armPerPropRadius: 0.078 / 0.0635,      // rule 5
	propInertiaK: 4.0e-6 / (0.004 * 0.0635 ** 2),  // rule 6
});

// Rule 1's one documented exception. heavy5 flies the spec's own worked example
// — 6S, 1750 KV, 5" — for which §13 states the answer outright, ~35 000 rpm,
// a droop of 0.833 rather than the reference build's 0.765.
export const RPM_DROOP = Object.freeze({ heavy5: 0.833 });

// Rule 2's one documented exception: a shrouded rotor is worth ~+15 % of static
// thrust, and the ducts are the whole point of a cinewhoop. Stated per family
// rather than per frame because the catalogue does not know a frame is ducted.
export const THRUST_AUGMENT = Object.freeze({ cinewhoop: 1.15 });

// The bill of materials each family is built from. Where the family's own
// comment in src/drone-profiles.js names its catalogue parts, these ARE those
// parts. Two families predate the catalogue and name no part number
// (freestyle5's 2450 KV 2207 is not a catalogue motor, longrange's 7" cruiser
// is heavier than any catalogue 7" adds up to): theirs are the nearest entries,
// and a CUSTOM build off them is therefore a NEW machine, not a reconstruction
// of the family. That is the honest behaviour — CUSTOM derives what the parts
// say, it does not chase the nominal.
export const FAMILY_PARTS = Object.freeze({
	freestyle5: { frame: 'Free5',    motor: '2700-2207', prop: '5043', blades: 3, battery: '4s-1300', camera: '0' },
	race5:      { frame: 'racer5',   motor: '1900-2207', prop: '5146', blades: 3, battery: '6s-1050', camera: '0' },
	cinewhoop:  { frame: 'Micro3_PG', motor: '3800-1404', prop: '3028', blades: 3, battery: '4s-1300', camera: '0' },
	longrange:  { frame: 'Light7',   motor: '1300-2807', prop: '7037', blades: 3, battery: '6s-3000', camera: '0' },
	heavy5:     { frame: 'Free5',    motor: '1750-2306', prop: '5136', blades: 3, battery: '6s-1700', camera: '2' },
	toothpick:  { frame: 'KM_2-5',   motor: '8000-1103', prop: '2521', blades: 2, battery: '2s-420',  camera: '0' },
	swarmNode:  { frame: 'Free6',    motor: '1500-2807', prop: '6030', blades: 3, battery: '6s-1700', camera: '0' },
});

export const BLADE_COUNTS = [2, 3, 4, 5];

// What a build carries that no catalogue lists: the camera, the VTX, the RX,
// the straps, the mesh radio at a swarm node's mast. drone-profiles.js states
// it per family in prose ("~48 g of analogue camera, VTX, RX and straps" on
// race5, "exactly the 90 g below" on the toothpick — that one carries nothing),
// so rather than a single 5"-class constant this reads each family's own: what
// its nominal mass leaves over its own bill. A CUSTOM build off a family's own
// parts therefore lands on that family's mass, and the allowance scales with
// the class instead of making a 90 g toothpick 55 % heavier.
//
// Clamped at zero: longrange's nearest-catalogue bill already outweighs its
// nominal, and a negative allowance would be a part that weighs less than
// nothing.
export function allowanceG(family) {
	const profile = PROFILES[family];
	const parts = FAMILY_PARTS[family];
	if (!profile || !parts) return 0;
	const bill = SPEC_FRAMES[parts.frame].massG
		+ 4 * SPEC_MOTORS[parts.motor].massG
		+ 4 * SPEC_PROPELLERS[parts.prop].massG
		+ SPEC_BATTERIES[parts.battery].massG
		+ SPEC_CAMERAS[parts.camera].massG;
	return Math.max(0, profile.mass * 1000 - bill);
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ---------------------------------------------------------------------------
// The catalogue, as pickable options
//
// [id, label] pairs in the shape src/bench.js's select() already takes. Labels
// carry the fact that decides the choice — grams, KV, pitch, capacity — because
// a part number alone tells an operator nothing.

const byLabel = (a, b) => a[1].localeCompare(b[1]);

export function partOptions() {
	return {
		frame: Object.values(SPEC_FRAMES)
			.map((f) => [f.id, `${f.name.toUpperCase()} — ${f.massG} g`]),
		motor: Object.values(SPEC_MOTORS)
			.map((m) => [m.id, `${m.name.toUpperCase()} — ${m.massG} g`]),
		prop: Object.values(SPEC_PROPELLERS)
			.map((p) => [p.id, `${p.name.toUpperCase()} — ${p.pitchIn.toFixed(1)}" PITCH, ${p.massG} g`]),
		blades: BLADE_COUNTS.map((n) => [n, `${n} BLADES`]),
		battery: Object.values(SPEC_BATTERIES)
			.map((b) => [b.id, `${b.name.toUpperCase()} — ${b.massG} g, ${b.dischargeC}C`]),
		camera: Object.values(SPEC_CAMERAS)
			.map((c) => [c.id, `${c.name.toUpperCase()}${c.massG ? ` — ${c.massG} g` : ''}`]),
	};
}

export function defaultParts(family) {
	return { ...(FAMILY_PARTS[family] ?? FAMILY_PARTS[DEFAULT_FAMILY]) };
}

// Brings a stored parts list back to a buildable one. A part number that has
// left the catalogue falls back to the family's own — never to nothing, because
// a build with no motor is not a state the bench can show.
export function normalizeParts(raw, family = DEFAULT_FAMILY) {
	const d = defaultParts(family);
	const r = (raw && typeof raw === 'object') ? raw : {};
	const pick = (v, table, fallback) => (typeof v === 'string' && table[v] ? v : fallback);
	const blades = Number(r.blades);
	return {
		frame: pick(r.frame, SPEC_FRAMES, d.frame),
		motor: pick(r.motor, SPEC_MOTORS, d.motor),
		prop: pick(r.prop, SPEC_PROPELLERS, d.prop),
		blades: BLADE_COUNTS.includes(blades) ? blades : d.blades,
		battery: pick(r.battery, SPEC_BATTERIES, d.battery),
		camera: pick(r.camera, SPEC_CAMERAS, d.camera),
	};
}

// ---------------------------------------------------------------------------
// CUSTOM — parts to profile
//
// What the parts decide: mass, geometry, rotor, motor, pack. What they do NOT
// decide stays the family's, and that is deliberate — torqueRatio, bodyDrag,
// the three disc gains, filterScale and the measured `pid` block are the
// character of an AIRFRAME, not of a bill of materials, and the family is the
// identity (issue #44: "a 5\" Race does not become a Cinewhoop because a value
// moved"). Anything in that list an operator disagrees with is one override
// away.
//
// `pid` in particular is never re-derived. Same reasoning as target-build.mjs:
// the tune was measured against the family's plant by tools/tune-pid.mjs, and
// nothing here is entitled to invent a new one. A heavy catalogue build is
// therefore a little soft and a light one a little sharp, exactly as a drawn
// individual is.
export function deriveCustomProfile({ family = DEFAULT_FAMILY, parts = null } = {}) {
	const base = PROFILES[family] ?? PROFILES[DEFAULT_FAMILY];
	const p = normalizeParts(parts, base.family);
	const frame = SPEC_FRAMES[p.frame];
	const motor = SPEC_MOTORS[p.motor];
	const prop = SPEC_PROPELLERS[p.prop];
	const pack = SPEC_BATTERIES[p.battery];
	const camera = SPEC_CAMERAS[p.camera];
	const D = DERIVATION;

	// Mass: what is on the bench, plus the allowance for what no catalogue lists.
	const massG = frame.massG + 4 * motor.massG + 4 * prop.massG + pack.massG
		+ camera.massG + allowanceG(base.family);
	const mass = massG / 1000;

	// Geometry. propRadius is half the catalogue diameter; the arms follow it by
	// rule 5, and the inertias follow mass and arm together — an inertia that did
	// not follow its own mass would be a physically impossible object, which is
	// the same guard tools/target-build.mjs applies to a drawn individual.
	const propRadius = (prop.diameterIn * INCH) / 2;
	const arm = D.armPerPropRadius * propRadius;
	const iScale = (mass / base.mass) * (arm / base.armX) ** 2;

	// Rule 1: a loaded rotor never reaches kv * volts.
	const droop = RPM_DROOP[base.family] ?? D.rpmDroop;
	const maxOmega = droop * motor.kv * pack.cells * CELL_VOLTS_LOADED
		* (2 * Math.PI) / 60;

	// Rule 2: T = C_T * rho * n^2 * D^4, n in rev/s, C_T from pitch ratio and
	// blade count.
	const diameter = prop.diameterIn * INCH;
	const pitch = prop.pitchIn * INCH;
	const ct = D.ctK * (pitch / diameter) * (p.blades / 3) ** D.solidityExp;
	const n = maxOmega / (2 * Math.PI);
	const augment = THRUST_AUGMENT[base.family] ?? 1;
	const maxThrustPerMotor = augment * ct * D.rho * n * n * diameter ** 4;

	// Rule 3: the build's own draw at four motors flat out, not the pack rating.
	const maxCurrent = D.packDrawK * 4 * maxThrustPerMotor * base.torqueRatio
		* maxOmega / (pack.cells * CELL_VOLTS_LOADED);

	// Rule 4: cell resistance goes as 1/capacity within one chemistry. The rule
	// UNDER-READS small packs badly — the toothpick's 2S 420 measures four times
	// what this extrapolation claims — which is why buildWarnings() says so
	// rather than letting a micro build quietly fly with no sag.
	const internalOhm = pack.cells * (D.cellMilliOhm / 1000)
		* (D.refCapacityMah / pack.capacityMah);

	return {
		...base,
		mass,
		armX: arm,
		armZ: arm,
		inertia: {
			x: base.inertia.x * iScale,
			y: base.inertia.y * iScale,
			z: base.inertia.z * iScale,
		},
		propRadius,
		propPitch: pitch,
		bladeCount: p.blades,
		// Rule 6, on the catalogue's own prop mass.
		propInertia: D.propInertiaK * (prop.massG / 1000) * propRadius ** 2,
		maxThrustPerMotor,
		maxOmega,
		motor: { ...base.motor, kv: motor.kv },
		battery: {
			...base.battery,
			cells: pack.cells,
			capacityMah: pack.capacityMah,
			internalOhm,
			maxCurrent,
		},
	};
}

// What the bench says about a bill of materials before it is flown. Warnings,
// never refusals — the fitment windows in the catalogue are the manufacturer's
// opinion, and a bench exists to ignore it knowingly.
export function buildWarnings(parts, family = DEFAULT_FAMILY) {
	const p = normalizeParts(parts, family);
	const frame = SPEC_FRAMES[p.frame];
	const motor = SPEC_MOTORS[p.motor];
	const prop = SPEC_PROPELLERS[p.prop];
	const pack = SPEC_BATTERIES[p.battery];
	const size = prop.diameterIn;
	const out = [];
	if (size < frame.minPropSize || size > frame.maxPropSize) {
		out.push(`${prop.diameterIn}" PROP ON A FRAME RATED ${frame.minPropSize}–${frame.maxPropSize}"`);
	}
	if (size < motor.propSizeMin || size > motor.propSizeMax) {
		out.push(`${motor.name.toUpperCase()} IS RATED ${motor.propSizeMin}–${motor.propSizeMax}" OF PROP`);
	}
	if (size < pack.framePropSizeMin || size > pack.framePropSizeMax) {
		out.push(`${pack.name.toUpperCase()} IS MEANT FOR ${pack.framePropSizeMin}–${pack.framePropSizeMax}" AIRFRAMES`);
	}
	if (pack.capacityMah < 1000) {
		out.push('PACK RESISTANCE IS EXTRAPOLATED BELOW 1 Ah AND READS TOO LOW — SET IT BY HAND');
	}
	return out;
}

// ---------------------------------------------------------------------------
// The parameters
//
// Every scalar the flight stack actually reads off a profile, plus the rate
// table the controller flies. One entry per editable number: where it lives,
// what it is called, its unit, and bounds wide enough to reach what the world
// would never produce — the bench is not a forecast.
//
// NOTHING INERT IS LISTED. A control that does nothing is worse than no control
// (the same rule benchBlockers() follows), so a field is here only if something
// downstream reads it: `throttleBands` and `minThrottle` are here because
// resolveBenchAirframe() hands them to the controller as a throttle config, and
// `rateFamily` is here because src/rates.js dispatches on the shape of the axis
// table. `filterScale` is listed for the same reason — flightController.js
// reads it — even though every shipped family leaves it at 1.

const AXES = ['roll', 'pitch', 'yaw'];

const param = (key, label, unit, min, max, step, extra = {}) =>
	({ key, label, unit, min, max, step, ...extra });

// The five spec rate families of §5, by the `type` src/rates.js dispatches on,
// plus ACTUAL — the sixth, the one this repo's presets are written in.
export const RATE_FAMILIES = [
	[RATE_ACTUAL, 'ACTUAL'],
	[0, 'BETAFLIGHT'],
	[1, 'ACTUAL (SPEC)'],
	[2, 'RACEFLIGHT'],
	[3, 'KISS'],
	[4, 'QUICK'],
];

export const DISCHARGE_CURVES = ['lipo', 'liion', 'legacy'];

export const PARAM_GROUPS = [
	{
		key: 'mass', label: 'MASS & GEOMETRY', params: [
			param('mass', 'ALL-UP MASS', 'kg', 0.02, 5, 0.005),
			param('inertia.x', 'INERTIA PITCH', 'kg·m²', 1e-6, 0.5, 1e-5, { digits: 6 }),
			param('inertia.y', 'INERTIA YAW', 'kg·m²', 1e-6, 0.5, 1e-5, { digits: 6 }),
			param('inertia.z', 'INERTIA ROLL', 'kg·m²', 1e-6, 0.5, 1e-5, { digits: 6 }),
			param('armX', 'ARM X', 'm', 0.01, 0.5, 0.001, { digits: 4 }),
			param('armZ', 'ARM Z', 'm', 0.01, 0.5, 0.001, { digits: 4 }),
		],
	},
	{
		key: 'rotor', label: 'ROTOR', params: [
			param('propRadius', 'PROP RADIUS', 'm', 0.01, 0.2, 0.0005, { digits: 4 }),
			param('propPitch', 'PROP PITCH', 'm', 0.005, 0.4, 0.0005, { digits: 4 }),
			param('bladeCount', 'BLADES', '', 2, 6, 1, { int: true }),
			param('propInertia', 'ROTOR INERTIA', 'kg·m²', 1e-8, 1e-3, 1e-7, { digits: 8 }),
		],
	},
	{
		key: 'motor', label: 'MOTOR', params: [
			param('motor.kv', 'KV', 'rpm/V', 100, 20000, 10, { int: true }),
			param('motor.noLoadCurrent', 'NO-LOAD CURRENT', 'A', 0, 10, 0.1, { digits: 2 }),
			param('maxOmega', 'MAX RATE', 'rad/s', 100, 8000, 10, { digits: 1 }),
			param('maxThrustPerMotor', 'THRUST PER MOTOR', 'N', 0.1, 60, 0.1, { digits: 2 }),
			param('torqueRatio', 'PROP TORQUE RATIO', '', 0.001, 0.1, 0.0005, { digits: 4 }),
			// null is what src/motor.js reads as "uncapped", and 0 A is not a
			// meaningful ESC either way, so the floor of the range IS the null.
			param('escCurrentLimit', 'ESC CURRENT LIMIT', 'A', 0, 200, 1,
				{ nullAtMin: true, nullLabel: 'UNCAPPED' }),
		],
	},
	{
		key: 'pack', label: 'PACK', params: [
			param('battery.cells', 'CELLS', 'S', 1, 12, 1, { int: true }),
			param('battery.capacityMah', 'CAPACITY', 'mAh', 50, 10000, 50, { int: true }),
			param('battery.internalOhm', 'INTERNAL RESISTANCE', 'Ω', 0.001, 0.5, 0.001, { digits: 4 }),
			param('battery.maxCurrent', 'DRAW AT FULL THROTTLE', 'A', 1, 400, 1, { digits: 1 }),
			param('battery.dischargeCurve', 'DISCHARGE CURVE', '', 0, 0, 0, { options: DISCHARGE_CURVES }),
		],
	},
	{
		key: 'aero', label: 'AERODYNAMICS', params: [
			param('bodyDrag.x', 'BODY DRAG X', '', 0, 0.5, 0.001, { digits: 3 }),
			param('bodyDrag.y', 'BODY DRAG Y', '', 0, 0.5, 0.001, { digits: 3 }),
			param('bodyDrag.z', 'BODY DRAG Z', '', 0, 0.5, 0.001, { digits: 3 }),
			param('dragScale', 'DRAG SCALE', '×', 0.1, 5, 0.05, { digits: 2 }),
			param('inflowGain', 'INFLOW GAIN', '×', 0.1, 5, 0.01, { digits: 3 }),
			param('buffetGain', 'PROPWASH GAIN', '×', 0.1, 5, 0.01, { digits: 3 }),
			param('lateralGain', 'LATERAL GAIN', '×', 0.1, 5, 0.01, { digits: 3 }),
		],
	},
	{
		key: 'loop', label: 'CONTROL LOOP', params: [
			...AXES.map((a) => param(`pid.${a}.p`, `P ${a.toUpperCase()}`, '', 0, 2, 0.001, { digits: 4 })),
			...AXES.map((a) => param(`pid.${a}.d`, `D ${a.toUpperCase()}`, '', 0, 0.02, 0.0001, { digits: 5 })),
			...AXES.map((a) => param(`pid.torquePerMix.${a}`, `TORQUE PER MIX ${a.toUpperCase()}`, 'N·m', 0.05, 20, 0.01, { digits: 3 })),
			// `fallback` is what flightController.js reads when the field is
			// absent, which it is on five of the six families. A row that showed
			// an empty box for a value the loop is actually using would be the
			// screen lying about the machine.
			param('filterScale', 'FILTER SCALE', '×', 0.25, 4, 0.05, { digits: 2, fallback: 1 }),
			param('gyroNoise', 'GYRO NOISE', 'rad/s', 0, 5, 0.01, { digits: 3 }),
			param('loopDelay', 'LOOP DELAY', 's', 0, 0.02, 0.0005, { digits: 4 }),
		],
	},
	{
		key: 'throttle', label: 'THROTTLE', params: [
			param('minThrottle', 'MIN THROTTLE', '', 0, 0.5, 0.005, { digits: 3 }),
			param('throttleBands.low', 'LOW BAND', '×', 0, 2, 0.05, { digits: 2 }),
			param('throttleBands.med', 'MID BAND', '×', 0, 2, 0.05, { digits: 2 }),
			param('throttleBands.high', 'HIGH BAND', '×', 0, 2, 0.05, { digits: 2 }),
		],
	},
	{
		key: 'rates', label: 'RATES', params: [
			param('rateFamily', 'RATE FAMILY', '', 0, 0, 0,
				{ options: RATE_FAMILIES.map(([v]) => v), optionLabels: RATE_FAMILIES }),
			// ACTUAL's parameterisation (centre, max, expo) — what every preset
			// in this repo is written in.
			...AXES.map((a) => param(`rates.${a}.centre`, `CENTRE ${a.toUpperCase()}`, '°/s', 10, 1000, 5, { digits: 0, shape: 'actual' })),
			...AXES.map((a) => param(`rates.${a}.max`, `MAX ${a.toUpperCase()}`, '°/s', 50, 2000, 10, { digits: 0, shape: 'actual' })),
			// The five spec families' parameterisation (rcRate, superRate).
			// The fallbacks are SPEC_RATE_SEED: this repo's presets carry no
			// rcRate at all, so without them the boxes would open empty on the
			// day a spec family is selected.
			...AXES.map((a) => param(`rates.${a}.rcRate`, `RC RATE ${a.toUpperCase()}`, '', 0.1, 4, 0.01, { digits: 2, shape: 'spec', fallback: 1.0 })),
			...AXES.map((a) => param(`rates.${a}.superRate`, `SUPER RATE ${a.toUpperCase()}`, '', 0, 0.99, 0.01, { digits: 2, shape: 'spec', fallback: 0.7 })),
			// Expo means the same thing in both parameterisations, so it has no
			// `shape` and is always shown.
			...AXES.map((a) => param(`rates.${a}.expo`, `EXPO ${a.toUpperCase()}`, '', 0, 0.95, 0.01, { digits: 2 })),
		],
	},
];

export const PARAMS = new Map(
	PARAM_GROUPS.flatMap((g) => g.params.map((p) => [p.key, p])),
);

// ---------------------------------------------------------------------------
// Paths

function readPath(obj, path) {
	let cur = obj;
	for (const seg of path.split('.')) {
		if (cur === null || cur === undefined) return undefined;
		cur = cur[seg];
	}
	return cur;
}

// Writes into a structure-sharing clone: every object on the path is copied,
// everything beside it is the base's own. A profile is read all over the flight
// stack and must never be mutated in place — physics.setProfile() keeps the one
// it was handed.
function writePath(obj, path, value) {
	const [head, ...rest] = path.split('.');
	const out = { ...obj };
	out[head] = rest.length ? writePath(obj[head] ?? {}, rest.join('.'), value) : value;
	return out;
}

// ---------------------------------------------------------------------------
// Overrides

// Brings a stored override map back to one that can be applied. Unknown keys
// are dropped (a parameter that has left the catalogue is not an error, it is
// an old config), values are coerced, rounded where the parameter is an
// integer, and clamped into the parameter's own bounds.
export function normalizeOverrides(raw) {
	const out = {};
	if (!raw || typeof raw !== 'object') return out;
	for (const [key, value] of Object.entries(raw)) {
		const p = PARAMS.get(key);
		if (!p) continue;
		if (p.options) {
			if (p.options.includes(value)) out[key] = value;
			continue;
		}
		let n;
		try { n = typeof value === 'number' ? value : Number(value); } catch { continue; }
		if (value === null || value === undefined || value === '' || !Number.isFinite(n)) continue;
		n = clamp(n, p.min, p.max);
		if (p.int) n = Math.round(n);
		out[key] = n;
	}
	return out;
}

// What a parameter reads when nothing overrides it, on this resolved base.
// `fallback` covers the fields a profile is allowed not to declare: the engine
// reads them through a `?? default` of its own, and the screen has to show the
// same number the loop is using rather than an empty box.
export function paramValue(key, { profile, rates, rateFamily }) {
	const p = PARAMS.get(key);
	if (!p) return undefined;
	if (key === 'rateFamily') return rateFamily;
	const raw = key.startsWith('rates.') ? readPath({ rates }, key) : readPath(profile, key);
	return raw === undefined ? p.fallback : raw;
}

// Reads for display. `null` on escCurrentLimit is UNCAPPED, not a missing value.
export function formatParam(key, value) {
	const p = PARAMS.get(key);
	if (!p) return String(value);
	if (p.optionLabels) {
		const hit = p.optionLabels.find(([v]) => v === value);
		return hit ? hit[1] : String(value).toUpperCase();
	}
	if (p.options) return String(value).toUpperCase();
	if (value === null || value === undefined) return p.nullLabel ?? '—';
	const n = Number(value);
	if (!Number.isFinite(n)) return '—';
	const digits = p.digits ?? 2;
	const text = digits >= 6 && n !== 0 && Math.abs(n) < 1e-3
		? n.toExponential(2)
		: n.toFixed(digits);
	return p.unit ? `${text} ${p.unit}` : text;
}

// ---------------------------------------------------------------------------
// Resolution
//
// One function, three bases, one output shape. main.js reads `profile`,
// `rates` and `throttle` and knows nothing else about how they were produced.

// The rate table a base flies before any override: an individual's owner's
// rates, or the family's named preset.
function baseRates(profile, build) {
	const table = build?.rates ?? RATE_PRESETS[profile.rates] ?? RATE_PRESETS.freestyle;
	return {
		label: table.label,
		roll: { ...table.roll },
		pitch: { ...table.pitch },
		yaw: { ...table.yaw },
	};
}

// Betaflight's stock defaults for the parameterisation this repo's presets are
// NOT written in. Not a measurement and not a tune: they are what the five spec
// families need to be evaluable at all, and an operator who selects one of
// those families is expected to type their own numbers over them — which is the
// point of exposing the family.
const SPEC_RATE_SEED = Object.freeze({ rcRate: 1.0, superRate: 0.7 });

export function airframeDefaults(family = DEFAULT_FAMILY) {
	return {
		family: FAMILIES.includes(family) ? family : DEFAULT_FAMILY,
		base: 'NOMINAL',
		seed: null,
		parts: null,
		overrides: {},
	};
}

// Brings any stored airframe block back to a resolvable one, including the two
// shapes that predate this module: `{ family, seed }`, where a seed meant
// INDIVIDUAL and its absence meant NOMINAL.
// `families` follows tools/bench-model.mjs's rule to the letter: the caller
// passes the real list when it has it, and without it any non-empty name goes
// through. The model does not get to decide a family has gone away.
export function normalizeAirframe(raw, { families = null } = {}) {
	const r = (raw && typeof raw === 'object') ? raw : {};
	const list = Array.isArray(families) && families.length ? families : null;
	const family = list
		? (list.includes(r.family) ? r.family
			: (list.includes(DEFAULT_FAMILY) ? DEFAULT_FAMILY : list[0]))
		: (typeof r.family === 'string' && r.family ? r.family : DEFAULT_FAMILY);
	const seed = typeof r.seed === 'string' && r.seed ? r.seed : null;
	// No `base` in the stored config: it is a pre-#159 bench, and there the seed
	// WAS the base.
	const base = BUILD_BASES.includes(r.base) ? r.base : (seed ? 'INDIVIDUAL' : 'NOMINAL');
	return {
		family,
		// INDIVIDUAL with no seed is not a state: it would resolve to NOMINAL
		// while claiming otherwise. Drawing one here rather than refusing is the
		// normalisation rule — bring it back, do not reject it.
		base,
		seed: base === 'INDIVIDUAL' ? (seed ?? rollSeed(family)) : seed,
		// The parts list survives a trip through NOMINAL: switching base to read
		// the reference profile and back must not lose a bill an operator spent
		// five minutes assembling.
		parts: (base === 'CUSTOM' || r.parts) ? normalizeParts(r.parts, family) : null,
		overrides: normalizeOverrides(r.overrides),
	};
}

// A build seed, deterministic in nothing: it is a draw. The family goes in so
// the two characters that read it (the portrait, the livery) differ per family
// even on the same number.
export function rollSeed() {
	return Math.random().toString(16).slice(2, 8);
}

// FNV-1a over the normalised airframe. main.js keys its hot swap on this:
// before #159 it compared `profile.family`, which meant changing the seed — or
// now any of forty parameters — silently did nothing in flight.
export function airframeIdentity(airframe) {
	const a = normalizeAirframe(airframe);
	const keys = Object.keys(a.overrides).sort();
	return hash(JSON.stringify([
		a.family, a.base, a.seed,
		a.base === 'CUSTOM' ? a.parts : null,
		keys.map((k) => [k, a.overrides[k]]),
	]));
}

// FNV-1a 32 bits, the same hash tools/target-build.mjs seeds its RNG with.
function hash(text) {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, '0');
}

// Resolves an airframe block into everything a flight needs.
//
//   profile   for physics.setProfile() and FlightController
//   rates     the axis table, or null to let the controller use its preset
//   throttle  the src/throttle.js config, or null for DEFAULT_THROTTLE
//   build     the drawn individual, or null — the portrait and the livery
//   warnings  what the bench has to say, never what it refuses
export function resolveBenchAirframe(airframe) {
	const a = normalizeAirframe(airframe);
	const warnings = [];

	let build = null;
	let profile;
	if (a.base === 'INDIVIDUAL') {
		build = targetBuild({ seed: a.seed, family: a.family });
		profile = build.profile;
	} else if (a.base === 'CUSTOM') {
		profile = deriveCustomProfile({ family: a.family, parts: a.parts });
		warnings.push(...buildWarnings(a.parts, a.family));
	} else {
		// The reference object itself, not a copy: NOMINAL with no override has
		// to BE the profile tools/tune-pid.mjs measured.
		profile = PROFILES[a.family];
	}

	let rates = build ? baseRates(profile, build) : null;
	let rateFamily = RATE_ACTUAL;
	let throttle = null;

	const keys = Object.keys(a.overrides);
	if (keys.length) {
		// The rate table only materialises once something touches it: a bench
		// with no rate override hands back null, and the controller keeps
		// reading RATE_PRESETS[preset] exactly as it does in FIELD.
		const touchesRates = keys.some((k) => k.startsWith('rates.') || k === 'rateFamily');
		if (touchesRates && !rates) rates = baseRates(profile, null);
		if (a.overrides.rateFamily !== undefined) rateFamily = a.overrides.rateFamily;

		for (const key of keys) {
			if (key === 'rateFamily') continue;
			const value = a.overrides[key];
			if (key.startsWith('rates.')) {
				const path = key.slice('rates.'.length);
				rates = writePath(rates, path, value);
				continue;
			}
			const p = PARAMS.get(key);
			profile = writePath(profile, key,
				(p?.nullAtMin && value <= p.min) ? null : value);
		}

		// The throttle chain is a controller option, not a profile field
		// (src/throttle.js), so it is assembled here from the two profile fields
		// that describe it. Untouched, it stays null and the controller keeps
		// DEFAULT_THROTTLE, which is inert.
		if (keys.some((k) => k === 'minThrottle' || k.startsWith('throttleBands.'))) {
			throttle = {
				// throttle.js reads minThrottle as the spec's PERCENT and divides
				// it by 80; the profile field is documented as a fraction 0..1.
				// The x100 is that conversion, and it is the only place it happens.
				minThrottle: (profile.minThrottle ?? 0) * 100,
				low: profile.throttleBands?.low ?? 1,
				medium: profile.throttleBands?.med ?? 1,
				high: profile.throttleBands?.high ?? 1,
				shape: null,
			};
		}
	}

	// A rate family other than ACTUAL changes the SHAPE src/rates.js dispatches
	// on, so the axis entries are rewritten into `{type, rcRate, superRate,
	// expo}`. Anything the operator has not set gets the stock firmware seed
	// rather than a number carried over from a parameterisation that does not
	// mean the same thing.
	if (rates && rateFamily !== RATE_ACTUAL) {
		const type = Number(rateFamily);
		for (const axis of AXES) {
			const r = rates[axis] ?? {};
			rates = writePath(rates, axis, {
				type,
				rcRate: a.overrides[`rates.${axis}.rcRate`] ?? r.rcRate ?? SPEC_RATE_SEED.rcRate,
				superRate: a.overrides[`rates.${axis}.superRate`] ?? r.superRate ?? SPEC_RATE_SEED.superRate,
				expo: a.overrides[`rates.${axis}.expo`] ?? r.expo ?? 0,
			});
		}
	}

	return {
		airframe: a,
		profile,
		rates,
		// The table to SHOW. `rates` is null whenever nothing touched it, which
		// is what the controller needs — it then keeps reading its own preset —
		// but a screen still has to print a number in the CENTRE ROLL box.
		ratesView: rates ?? baseRates(profile, null),
		throttle,
		build,
		rateFamily,
		warnings,
		identity: airframeIdentity(a),
		// The identity of the PLANT alone. Rebuilding the Propulsion and the
		// Rapier body is what physics.setProfile() does, and it hands back a
		// full pack on the way; a rate or a throttle band changes neither, and
		// must not cost a recharge. A profile is plain data, so stringifying it
		// is a complete comparison — no field can be added that this misses.
		profileIdentity: hash(JSON.stringify(profile)),
		derived: derivedReadout(profile),
	};
}

// What the bench shows about the machine it has just resolved. Not settings:
// consequences. Thrust-to-weight is the one number that says whether a build
// will fly at all, and it is the first thing anyone assembling parts looks for.
export function derivedReadout(profile) {
	const g = 9.81;
	const weight = profile.mass * g;
	const thrust = 4 * profile.maxThrustPerMotor;
	return {
		massG: profile.mass * 1000,
		thrustN: thrust,
		twr: thrust / weight,
		// The stick position that holds a hover, if thrust went linearly with
		// it. It does not — but as a reading of "how much of the travel is
		// spent standing still" it is exactly right.
		hoverFraction: clamp(weight / thrust, 0, 1),
		rpm: profile.maxOmega * 60 / (2 * Math.PI),
		packDrawA: profile.battery.maxCurrent,
		// Minutes at the pack's stated draw. A hover draws far less, so this is
		// the floor, and it is labelled as such.
		minutesFlatOut: (profile.battery.capacityMah / 1000) / profile.battery.maxCurrent * 60,
	};
}

// The airframe's one-line value on the bench's own screen.
export function airframeSummary(airframe) {
	const a = normalizeAirframe(airframe);
	const n = Object.keys(a.overrides).length;
	const base = a.base === 'INDIVIDUAL' ? `SEED ${a.seed}` : a.base;
	return n ? `${base} · ${n} SET` : base;
}

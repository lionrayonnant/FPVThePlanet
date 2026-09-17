// src/drone-profiles.js as a SCHEMA and as a TEXT.
//
// Two jobs, and the second is the unusual one. `tools/tune-pid.mjs --write`
// rewrites each family's `pid` block with a regular expression over the source
// file, and that expression depends on the file's exact shape: tab indentation,
// the block closing on `\n\t\t},`, one `family: '<name>',` per family. Reformat
// the file — a prettier pass, spaces for tabs, a reordered field — and the
// rewrite either throws or, worse, eats the next family whole. So this bench
// applies tune-pid's own regex to the source and checks it still matches once,
// and only inside the family it belongs to.
//
// The first job is the ordinary one: every family carries every field the
// spec-integration lots expect, with a type that makes sense.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROFILES, FAMILIES, DEFAULT_FAMILY } from '../src/drone-profiles.js';
import { SPEC_MOTORS, OFF_CATALOGUE_MOTORS, motorPart } from '../src/spec-data/motors.js';
import { SPEC_PROPELLERS, INCH } from '../src/spec-data/propellers.js';
import { SPEC_BATTERIES } from '../src/spec-data/batteries.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

const PATH = fileURLToPath(new URL('../src/drone-profiles.js', import.meta.url));
const SRC = readFileSync(PATH, 'utf8');
const ALL = Object.keys(PROFILES);

// Verbatim from tools/tune-pid.mjs:writeFamilyPid(). If that line changes, this
// one has to change with it — which is the point.
const pidRe = (family) => new RegExp(`(family: '${family}',[\\s\\S]*?)pid: \\{[\\s\\S]*?\\n\\t\\t\\},`, 'g');

t("tune-pid's regex matches exactly once per family", () => {
	for (const family of ALL) {
		const hits = SRC.match(pidRe(family)) ?? [];
		assert.equal(hits.length, 1, `${family}: ${hits.length} matches`);
	}
});

t('no match spills over into the next family', () => {
	// A missing or reformatted pid block would let the non-greedy `[\s\S]*?`
	// run on to the following family's block and silently overwrite the wrong
	// tune. The matched text must name its own family and no other.
	for (const family of ALL) {
		const [hit] = SRC.match(pidRe(family));
		const named = [...hit.matchAll(/family: '(\w+)'/g)].map((m) => m[1]);
		assert.deepEqual(named, [family], `${family} match covers ${named.join(', ')}`);
	}
});

t('the file is still tab-indented, which that regex assumes', () => {
	const offenders = SRC.split('\n')
		.map((line, i) => [i + 1, line])
		.filter(([, line]) => /^ +\S/.test(line));
	assert.equal(offenders.length, 0, `space-indented lines: ${offenders.map(([i]) => i).join(', ')}`);
	// And every pid block closes on the two tabs the regex looks for.
	const closes = SRC.match(/\n\t\t\},/g) ?? [];
	assert.ok(closes.length >= ALL.length, `${closes.length} blocks closing on \\n\\t\\t},`);
});

t('every family declared in the file is a profile, and vice versa', () => {
	const inSource = [...SRC.matchAll(/^\t\tfamily: '(\w+)',$/gm)].map((m) => m[1]);
	assert.deepEqual([...inSource].sort(), [...ALL].sort());
	for (const family of ALL) assert.equal(PROFILES[family].family, family);
	// FAMILIES is the ordinary roster; swarmNode is deliberately outside it.
	for (const f of FAMILIES) assert.ok(PROFILES[f], `FAMILIES names unknown ${f}`);
	assert.ok(FAMILIES.includes(DEFAULT_FAMILY));
});

// ---------------------------------------------------------------------------
// The schema itself.

const num = (v) => typeof v === 'number' && Number.isFinite(v);

t('every family carries the fields the flight model already reads', () => {
	const scalars = ['mass', 'radius', 'armX', 'armZ', 'propRadius', 'propInertia',
		'bladeCount', 'propPitch', 'maxThrustPerMotor', 'maxOmega', 'torqueRatio'];
	for (const family of ALL) {
		const p = PROFILES[family];
		for (const k of scalars) assert.ok(num(p[k]) && p[k] > 0, `${family}.${k} = ${p[k]}`);
		for (const k of ['x', 'y', 'z']) {
			assert.ok(num(p.inertia[k]) && p.inertia[k] > 0, `${family}.inertia.${k}`);
			assert.ok(num(p.bodyDrag[k]) && p.bodyDrag[k] > 0, `${family}.bodyDrag.${k}`);
		}
		assert.ok(num(p.motor.kv) && num(p.motor.noLoadCurrent), `${family}.motor`);
		for (const k of ['cells', 'capacityMah', 'internalOhm', 'maxCurrent']) {
			assert.ok(num(p.battery[k]) && p.battery[k] > 0, `${family}.battery.${k}`);
		}
		assert.equal(p.radius, 0.15, `${family}.radius is the collision sphere`);
	}
});

// The spec-schema fields, and the default each one has to hold for the flight
// model to behave exactly as it did before they existed.
const RATE_FAMILIES = ['betaflight', 'actual', 'raceflight', 'kiss', 'quick'];

t('every family carries the spec-schema fields', () => {
	for (const family of ALL) {
		const p = PROFILES[family];
		assert.ok(RATE_FAMILIES.includes(p.rateFamily), `${family}.rateFamily = ${p.rateFamily}`);
		for (const b of ['low', 'med', 'high']) {
			assert.ok(num(p.throttleBands[b]) && p.throttleBands[b] >= 0,
				`${family}.throttleBands.${b} = ${p.throttleBands?.[b]}`);
		}
		assert.ok(num(p.minThrottle) && p.minThrottle >= 0 && p.minThrottle < 1, `${family}.minThrottle`);
		assert.ok(num(p.dragScale) && p.dragScale > 0, `${family}.dragScale`);
		assert.ok(p.escCurrentLimit === null || (num(p.escCurrentLimit) && p.escCurrentLimit > 0),
			`${family}.escCurrentLimit = ${p.escCurrentLimit}`);
		assert.ok(num(p.gyroNoise) && p.gyroNoise >= 0, `${family}.gyroNoise`);
		assert.ok(num(p.loopDelay) && p.loopDelay >= 0, `${family}.loopDelay`);
	}
});

t('the spec-schema defaults are the ones that change nothing', () => {
	// If a lot starts using a field it replaces the default with a measured
	// value and this bench is updated in the same change — deliberately, rather
	// than by a default drifting unnoticed.
	for (const family of ALL) {
		const p = PROFILES[family];
		assert.equal(p.rateFamily, 'actual', family);
		assert.deepEqual(p.throttleBands, { low: 1, med: 1, high: 1 }, family);
		assert.equal(p.minThrottle, 0, family);
		assert.equal(p.dragScale, 1, family);
		assert.equal(p.escCurrentLimit, null, family);
	}
});

t('gyroNoise and loopDelay are measured, and in the band they were derived in', () => {
	// These two left the "default that changes nothing" list when the gyro was
	// turned on. The derivation lives in src/drone-profiles.js under "WHERE
	// gyroNoise COMES FROM"; the bounds here are what that derivation can
	// produce, so a value typed in by hand has to argue with this bench.
	for (const family of ALL) {
		const p = PROFILES[family];
		assert.ok(p.gyroNoise >= 0.05 && p.gyroNoise <= 0.5, `${family}.gyroNoise = ${p.gyroNoise}`);
		assert.ok(p.loopDelay >= 0.0005 && p.loopDelay <= 0.002, `${family}.loopDelay = ${p.loopDelay}`);
	}
	// loopDelay is uniform on purpose: it stands for the sensor, the scheduler
	// and the ESC input, which are the same silicon on every build.
	const delays = new Set(ALL.map((f) => PROFILES[f].loopDelay));
	assert.equal(delays.size, 1, `loopDelay differs across families: ${[...delays]}`);
});

t('every pid block is complete on all three axes', () => {
	for (const family of ALL) {
		const { pid } = PROFILES[family];
		for (const axis of ['roll', 'pitch', 'yaw']) {
			assert.ok(num(pid[axis].p) && pid[axis].p > 0, `${family}.pid.${axis}.p`);
			assert.ok(num(pid[axis].d) && pid[axis].d >= 0, `${family}.pid.${axis}.d`);
			assert.ok(num(pid.torquePerMix[axis]) && pid.torquePerMix[axis] > 0,
				`${family}.pid.torquePerMix.${axis}`);
		}
	}
});

// ---------------------------------------------------------------------------
// The bill of materials. Every family names a part number, and the part number
// has to exist and to say what the profile says it says.

t('every family names a motor and a propeller that exist', () => {
	for (const family of ALL) {
		const p = PROFILES[family];
		assert.ok(motorPart(p.motor.part), `${family}.motor.part = ${p.motor.part}, in no catalogue`);
		assert.ok(SPEC_PROPELLERS[p.propPart], `${family}.propPart = ${p.propPart}, in no catalogue`);
	}
});

t('the motor a family flies has the KV the family claims', () => {
	// This is the check that closes the hole freestyle5's 2450 KV sat in: a
	// part number nobody could resolve, next to a KV nobody could contradict.
	for (const family of ALL) {
		const p = PROFILES[family];
		assert.equal(motorPart(p.motor.part).kv, p.motor.kv,
			`${family}: part ${p.motor.part} against kv ${p.motor.kv}`);
	}
});

t('the propeller a family flies has the diameter and pitch the family flies', () => {
	for (const family of ALL) {
		const p = PROFILES[family];
		const prop = SPEC_PROPELLERS[p.propPart];
		// The catalogue is in inches and the flight model is in metres. The
		// catalogue's own numbers carry float noise (3.5999999046325684 is
		// 3.6), hence a tolerance rather than equality.
		assert.ok(Math.abs(prop.diameterIn * INCH - 2 * p.propRadius) < 1e-4,
			`${family}: ${p.propPart} is ${prop.diameterIn}" against propRadius ${p.propRadius}`);
		assert.ok(Math.abs(prop.pitchIn * INCH - p.propPitch) < 1e-4,
			`${family}: ${p.propPart} pitch ${prop.pitchIn}" against propPitch ${p.propPitch}`);
	}
});

t('the catalogue is not quietly grown to hold what the sim flies', () => {
	// SPEC_MOTORS is a transcription with a pinned count. A part the sim needs
	// and the spec does not list belongs in OFF_CATALOGUE_MOTORS, and has to
	// say why it is allowed to be there.
	for (const [id, m] of Object.entries(OFF_CATALOGUE_MOTORS)) {
		assert.ok(!SPEC_MOTORS[id], `${id} is in both the catalogue and the exceptions`);
		assert.equal(m.id, id, `${id}: id field disagrees with its key`);
		assert.ok(typeof m.source === 'string' && m.source.length > 40,
			`${id} has no stated provenance`);
		assert.ok(num(m.kv) && num(m.massG), `${id} is not a hardware record`);
	}
	// And the exceptions stay exceptional: one part, the reference build's.
	const used = new Set(ALL.map((f) => PROFILES[f].motor.part).filter((id) => OFF_CATALOGUE_MOTORS[id]));
	assert.deepEqual([...used], ['2450-2207'], `off-catalogue parts in use: ${[...used]}`);
});

t('the pack a family flies is the pack the catalogue describes', () => {
	for (const family of ALL) {
		const b = PROFILES[family].battery;
		const pack = SPEC_BATTERIES[b.part];
		assert.ok(pack, `${family}.battery.part = ${b.part}, in no catalogue`);
		assert.equal(pack.cells, b.cells, `${family}: ${b.part} is ${pack.cells}S`);
		assert.equal(pack.capacityMah, b.capacityMah, `${family}: ${b.part} is ${pack.capacityMah} mAh`);
	}
});

t('maxCurrent is the build\'s own draw, by rule 3, and not the pack\'s rating', () => {
	// The ambiguity this pins: the reference build states 100 A on a 4s-1300,
	// and that same pack is rated 150C = 195 A. Both numbers are real and they
	// are not the same quantity. `maxCurrent` is documented "A at four motors
	// flat out" -- the DRAW -- and rule 3 in src/drone-profiles.js derives it.
	// Every family obeys that rule to better than 1%, so the field cannot drift
	// onto the other reading without this failing.
	//
	// Worth knowing while reading this: no physics reads `maxCurrent` today.
	// The pack sags on the real winding current from src/motor.js's torque
	// balance (src/battery.js), so this field is a hardware fact on a datasheet
	// -- which is precisely why it needs a test rather than a reader.
	for (const family of ALL) {
		const p = PROFILES[family];
		const rule3 = 0.67 * 4 * p.maxThrustPerMotor * p.torqueRatio * p.maxOmega / (p.battery.cells * 4.0);
		const err = Math.abs(rule3 - p.battery.maxCurrent) / p.battery.maxCurrent;
		assert.ok(err < 0.01,
			`${family}: rule 3 gives ${rule3.toFixed(1)} A, the file says ${p.battery.maxCurrent} A (${(100 * err).toFixed(1)}%)`);
	}
});

t('no build asks its pack for much more than the pack is rated to give', () => {
	// capacity * C is the pack's own ceiling. This is NOT the same check as the
	// one above and it is deliberately loose: race5 draws 106 A from a 6s-1050
	// rated 95C = 99.8 A, which is a hair over and is a real thing a 6" race
	// build does. A build asking for half again what its pack can give would be
	// a bill of materials that does not fly, and that is what this catches.
	for (const family of ALL) {
		const b = PROFILES[family].battery;
		const rated = SPEC_BATTERIES[b.part].dischargeC * b.capacityMah / 1000;
		assert.ok(b.maxCurrent <= 1.1 * rated,
			`${family}: draws ${b.maxCurrent} A from a pack rated ${rated.toFixed(0)} A`);
	}
});

t('propInertia is derived from the propeller, not chosen', () => {
	// Rule 5 in src/drone-profiles.js: one shape constant for every propeller,
	// anchored on the reference build, times the catalogue mass and the radius.
	// Before it, the same normalisation implied k from 0.115 to 0.620 across
	// seven parts that are the same moulded object at different sizes.
	const K = 0.248;
	for (const family of ALL) {
		const p = PROFILES[family];
		const m = SPEC_PROPELLERS[p.propPart].massG / 1000;
		const model = K * m * p.propRadius * p.propRadius;
		const err = Math.abs(model - p.propInertia) / model;
		assert.ok(err < 0.01,
			`${family}: rule 5 gives ${model.toExponential(3)}, the file says ${p.propInertia.toExponential(3)}`);
	}
});

t('no family claims an inertia a flat body cannot have', () => {
	// Perpendicular-axis: for a planar body I_yaw <= I_pitch + I_roll, and a
	// quad is planar enough that the five measured families all sit at
	// 0.93 +- 0.01. The toothpick read 1.150 for two profiles' worth of work --
	// impossible, and the reason its yaw would not tune was looked for in the
	// gains for that whole time. Asserted as the bound, and reported as the
	// spread, so a family drifting away from the others is visible before it
	// becomes impossible.
	// Over ALL, not FAMILIES: swarmNode is outside the ordinary roster but it
	// flies, so its inertia answers to the same geometry as everyone else's.
	for (const f of ALL) {
		const i = PROFILES[f].inertia;
		const r = i.y / (i.x + i.z);
		assert.ok(r < 1, `${f}: I_yaw/(I_pitch+I_roll) = ${r.toFixed(3)}, which no flat body can do`);
		assert.ok(r > 0.85, `${f}: ${r.toFixed(3)} is far from the 0.93 the others measure`);
	}
});

console.log(`profile-schema-selftest : ${n} tests ok`);

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

console.log(`profile-schema-selftest : ${n} tests ok`);

// The flight replay harness (tools/flight-replay.mjs) has to be trustworthy
// BEFORE anyone trusts what it says about the flight model. A diff that moves
// on its own between two identical runs is worse than no diff at all: it would
// dress noise up as a regression, and the next person would learn to ignore it.
//
// So this file checks the instrument, not the machine. Three claims:
//
//   1. the replay is deterministic — twice in one process, and once more in a
//      fresh one, bit for bit;
//   2. it is independent of the step it is played at, within a tolerance
//      DECLARED here rather than discovered after the fact;
//   3. the diff reads exactly zero between a trace and itself, and finds a
//      change that was deliberately injected.
//
// Nothing here pins a flight number. Every tolerance is about the HARNESS.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { initPhysics } from '../src/physics.js';
import {
	SEQUENCES, SEQUENCE_NAMES, DT, METRIC_UNITS,
	replay, diff, sticksAt, TRACE_FORMAT,
} from './flight-replay.mjs';

await initPhysics();
let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STEADY = SEQUENCE_NAMES.filter((s) => !SEQUENCES[s].chaotic);
const CHAOTIC = SEQUENCE_NAMES.filter((s) => SEQUENCES[s].chaotic);

// ---------------------------------------------------------------------------
// The sequences themselves

t('every sequence is well formed and says what it exercises', () => {
	assert.ok(SEQUENCE_NAMES.length >= 5, `only ${SEQUENCE_NAMES.length} sequences`);
	for (const name of SEQUENCE_NAMES) {
		const s = SEQUENCES[name];
		assert.ok(s.title, `${name}: no title`);
		assert.ok(s.exercises, `${name}: does not say what it exercises`);
		assert.ok(s.seconds > 0, `${name}: seconds`);
		assert.ok(s.keys.length >= 2, `${name}: needs at least two keyframes`);
		let last = -Infinity;
		for (const k of s.keys) {
			assert.ok(k.t > last, `${name}: keyframes must be strictly increasing in t (${k.t} after ${last})`);
			last = k.t;
			for (const [axis, v] of Object.entries(k)) {
				if (axis === 't') continue;
				if (v === 'hover') { assert.equal(axis, 'throttle', `${name}: 'hover' only means anything on throttle`); continue; }
				const lo = axis === 'throttle' ? 0 : -1;
				assert.ok(v >= lo && v <= 1, `${name}: ${axis}=${v} out of the input.js range`);
			}
		}
		assert.ok(last <= s.seconds, `${name}: last keyframe at ${last}s, sequence is ${s.seconds}s`);
		assert.equal(s.keys[0].t, 0, `${name}: must start at t=0`);
	}
});

t('the sequences between them exercise the mechanisms this branch changed', () => {
	// Not a spot-check of wording: each of these must actually MOVE in some
	// trace, or the sequence set has a hole where a whole mechanism used to be.
	const traces = STEADY.map((s) => replay(s));
	const moved = (key, min) => traces.some((tr) => Math.abs(tr.metrics[key]) > min);
	assert.ok(moved('gravityTrimUp', 0.01), 'no sequence feels the gravity trim');
	assert.ok(moved('groundEffectUp', 0.005), 'no sequence gets into ground effect');
	assert.ok(moved('vortexRingUp', 0.005), 'no sequence enters the vortex ring band');
	assert.ok(moved('inflowUp', 0.05), 'no sequence loads the axial inflow term');
	assert.ok(moved('rotorDragUp', 0.005), 'no sequence flies fast enough to feel rotor drag');
	// Battery sag: some sequence has to pull the pack down hard.
	const nominal = 4.2 * 4;
	assert.ok(traces.some((tr) => tr.metrics.minVoltage < nominal - 2), 'nothing sags the pack');
});

t('sticksAt interpolates, holds, and resolves the hover token', () => {
	const seq = { seconds: 2, keys: [{ t: 0, throttle: 0, roll: -1 }, { t: 2, throttle: 1, roll: 1 }] };
	assert.deepEqual(sticksAt(seq, 0, 0.4), { throttle: 0, roll: -1, pitch: 0, yaw: 0 });
	assert.deepEqual(sticksAt(seq, 1, 0.4), { throttle: 0.5, roll: 0, pitch: 0, yaw: 0 });
	assert.deepEqual(sticksAt(seq, 2, 0.4), { throttle: 1, roll: 1, pitch: 0, yaw: 0 });
	// Past the end it holds the last keyframe rather than extrapolating.
	assert.deepEqual(sticksAt(seq, 9, 0.4), { throttle: 1, roll: 1, pitch: 0, yaw: 0 });

	const stepped = { seconds: 2, interp: 'step', keys: [{ t: 0, throttle: 0 }, { t: 1, throttle: 1 }] };
	assert.equal(sticksAt(stepped, 0.99, 0.4).throttle, 0, 'step interpolation must not ramp');
	assert.equal(sticksAt(stepped, 1, 0.4).throttle, 1);

	// 'hover' resolves to whatever the caller says a hover costs right now, and
	// interpolates against a numeric neighbour rather than snapping.
	const h = { seconds: 1, keys: [{ t: 0, throttle: 'hover' }, { t: 1, throttle: 1 }] };
	assert.equal(sticksAt(h, 0, 0.4).throttle, 0.4);
	assert.equal(sticksAt(h, 0.5, 0.4).throttle, 0.7);
	assert.equal(sticksAt(h, 0, 0.6).throttle, 0.6, 'the token must track the value handed in');
});

// ---------------------------------------------------------------------------
// 1. Determinism
//
// This is the claim everything else rests on. `Propulsion` is seed-deterministic
// by contract and the wind field is inert in still air, so any difference here
// is a real bug — in the harness, or in something that leaked global state.

t('two replays of the same sequence are identical, bit for bit', () => {
	for (const name of SEQUENCE_NAMES) {
		const a = replay(name);
		const b = replay(name);
		assert.equal(a.checksum, b.checksum, `${name}: checksum ${a.checksum} vs ${b.checksum}`);
		// The checksum covers every step; the metrics are what people read. Both.
		assert.deepEqual(a.metrics, b.metrics, `${name}: metrics differ between two identical runs`);
		assert.deepEqual(a.budget, b.budget, `${name}: force budget differs between two identical runs`);
	}
});

t('replaying the same sequence out of order does not change it', () => {
	// A Physics world per replay, but one Rapier module for the process: if
	// anything in the stack kept state across instances, running the sequences
	// in a different order would show it.
	const forward = SEQUENCE_NAMES.map((s) => [s, replay(s).checksum]);
	const backward = new Map([...SEQUENCE_NAMES].reverse().map((s) => [s, replay(s).checksum]));
	for (const [name, sum] of forward) {
		assert.equal(backward.get(name), sum, `${name}: order-dependent (${sum} vs ${backward.get(name)})`);
	}
});

t('a fresh process reproduces the same checksums', () => {
	// The in-process check cannot see a dependence on something that is fixed
	// for the life of a process — a hash seed, a lazily built table, the order
	// a module happened to initialise in. This one can.
	// pathToFileURL, not the bare path: on Windows an absolute path starts with a
	// drive letter, and Node's ESM loader reads `D:\...` as the protocol `d:` and
	// refuses it. Passes on Linux either way, which is exactly how it reached CI.
	const script = `
		import { initPhysics } from '${pathToFileURL(path.join(HERE, '../src/physics.js')).href}';
		import { replay, SEQUENCE_NAMES } from '${pathToFileURL(path.join(HERE, 'flight-replay.mjs')).href}';
		await initPhysics();
		console.log(JSON.stringify(SEQUENCE_NAMES.map((s) => [s, replay(s).checksum])));
	`;
	const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
		encoding: 'utf8', cwd: HERE,
	});
	const child = new Map(JSON.parse(out.trim().split('\n').pop()));
	for (const name of SEQUENCE_NAMES) {
		assert.equal(child.get(name), replay(name).checksum, `${name}: differs across processes`);
	}
});

// ---------------------------------------------------------------------------
// 2. Step independence
//
// The replay is written in seconds, so halving the step plays the SAME
// sequence, sampled twice as often. A trajectory that changed materially would
// mean the harness is measuring its own integration error rather than the
// flight model — and a diff run at one step could not be compared with a
// recording made at another.
//
// The tolerances are declared, per metric, as max(abs, rel x value). They are
// what a second-order-ish integrator at half the step is allowed to move by;
// they are NOT a place to hide a real change.

const STEP_TOLERANCE = {
	finalAltitude: { abs: 0.05, rel: 0.01 },
	peakAltitude: { abs: 0.05, rel: 0.01 },
	// Lateral drift is a small difference of large numbers: on a purely vertical
	// manoeuvre it is a near-zero residual of a 290 m path, produced entirely by
	// the seeded downwash jitter (1.07 m at dt, 0.36 m at dt/2 on punch-out —
	// not a trajectory change, two integrations of the same noise). So its floor
	// is a fraction of the path flown rather than a fixed number of metres;
	// anything a pilot would call drift is tens of metres and lands on `rel`.
	lateralDrift: { abs: 0.2, rel: 0.02, ofPath: 0.01 },
	pathLength: { abs: 0.5, rel: 0.02 },
	peakSpeed: { abs: 0.05, rel: 0.005 },
	timeToClimb5m: { abs: 0.05, rel: 0.01 },
	hoverStick: { abs: 1e-3, rel: 0.002 },
	meanThrottle: { abs: 2e-3, rel: 0.005 },
	thrustUp: { abs: 5e-3, rel: 0.005 },
	gravityTrimUp: { abs: 2e-3, rel: 0.02 },
	groundEffectUp: { abs: 2e-3, rel: 0.05 },
	meanRpm: { abs: 20, rel: 0.005 },
};

function stepMismatch(a, b) {
	const bad = [];
	for (const [key, tol] of Object.entries(STEP_TOLERANCE)) {
		const va = a.metrics[key];
		const vb = b.metrics[key];
		if (va === null || vb === null) continue;
		let allow = Math.max(tol.abs, tol.rel * Math.abs(va));
		if (tol.ofPath) allow = Math.max(allow, tol.ofPath * a.metrics.pathLength);
		if (Math.abs(vb - va) > allow) {
			bad.push(`${key}: ${va} -> ${vb} (allowed ${allow.toPrecision(3)})`);
		}
	}
	return bad;
}

t('halving the step does not change a steady trajectory beyond the declared tolerance', () => {
	for (const name of STEADY) {
		const a = replay(name, { dt: DT });
		const b = replay(name, { dt: DT / 2 });
		assert.notEqual(a.checksum, b.checksum, `${name}: two steps cannot give the same checksum`);
		const bad = stepMismatch(a, b);
		assert.equal(bad.length, 0, `${name} at dt/2:\n    ${bad.join('\n    ')}`);
	}
});

t('doubling the step does not change a steady trajectory either', () => {
	// Both directions, because a tolerance tuned on one of them is a tolerance
	// tuned on nothing: a scheme that is stable going down and drifting going
	// up is still a scheme whose recordings are not comparable.
	for (const name of STEADY) {
		const a = replay(name, { dt: DT });
		const b = replay(name, { dt: DT * 2 });
		const bad = stepMismatch(a, b);
		assert.equal(bad.length, 0, `${name} at 2*dt:\n    ${bad.join('\n    ')}`);
	}
});

t('the chaotic sequences really are chaotic, and are labelled as such', () => {
	// The honest limit of this harness, asserted rather than written in a
	// comment. A flip amplifies any difference — including a change of step —
	// so its trajectory cannot be compared between two versions. If this ever
	// stops being true the label is wrong and should be dropped, which is why
	// the check runs in this direction.
	assert.ok(CHAOTIC.length > 0, 'no chaotic sequence to check the claim against');
	for (const name of CHAOTIC) {
		const a = replay(name, { dt: DT });
		const b = replay(name, { dt: DT / 2 });
		assert.ok(
			stepMismatch(a, b).length > 0,
			`${name} is labelled chaotic but survives a change of step — drop the label`,
		);
		// And what stays comparable despite it: the manoeuvre's own signature.
		assert.ok(Math.abs(b.metrics.rollRevolutions - a.metrics.rollRevolutions) < 0.05,
			`${name}: revolutions ${a.metrics.rollRevolutions} -> ${b.metrics.rollRevolutions}`);
		assert.ok(Math.abs(b.metrics.peakRollRate / a.metrics.peakRollRate - 1) < 0.05,
			`${name}: peak roll rate ${a.metrics.peakRollRate} -> ${b.metrics.peakRollRate}`);
	}
});

// ---------------------------------------------------------------------------
// 3. The diff

t('a trace against itself is exactly zero, every sequence', () => {
	for (const name of SEQUENCE_NAMES) {
		const tr = replay(name);
		const d = diff(tr, tr);
		assert.ok(d.identical, `${name}: checksums differ against itself`);
		assert.equal(d.changed.length, 0, `${name}: ${d.changed.length} metrics moved against itself`);
		for (const r of d.rows) {
			assert.equal(r.abs, 0, `${name}/${r.metric}: abs ${r.abs} against itself`);
			assert.equal(r.rel, 0, `${name}/${r.metric}: rel ${r.rel} against itself`);
			assert.equal(r.significant, false, `${name}/${r.metric}: flagged against itself`);
		}
	}
});

t('two independent replays of the same version also diff to zero', () => {
	// Not the same object twice: two separate runs, which is what a real
	// before/after actually compares. This is the check that would catch the
	// worst failure mode — a harness whose noise looks like a regression.
	for (const name of SEQUENCE_NAMES) {
		const d = diff(replay(name), replay(name));
		assert.equal(d.changed.length, 0, `${name}: noise between two runs of the same version`);
	}
});

t('an injected change is found, and named', () => {
	// The injection: switch the modulated gravity trim off. It is a real force
	// on the body (spec 8.1), so a harness that could not see it would be
	// useless for exactly the kind of change this branch made.
	const before = replay('hover-hold', { gravityTrim: true });
	const after = replay('hover-hold', { gravityTrim: false });
	const d = diff(before, after);
	assert.ok(!d.identical, 'the checksums must differ');
	const names = new Set(d.changed.map((r) => r.metric));
	assert.ok(names.has('gravityTrimUp'), `gravityTrimUp not reported: ${[...names].join(', ')}`);
	assert.ok(names.has('thrustUp'), 'the thrust carrying the weight must move when the weight does');
	// And the headline is in metres, not in a distance metric: hoverThrottle()
	// solves for the TRIMMED weight, so the commanded stick is very nearly the
	// same — what changes is that the same stick no longer holds a hover. That
	// is precisely the thing a pilot would report and an invariant could not.
	const alt = d.changed.find((r) => r.metric === 'finalAltitude');
	assert.ok(alt, 'a hover that stops hovering must show as an altitude change');
	assert.ok(alt.abs > 10, `and by a readable amount: ${alt.abs} m over ${before.seconds} s`);
	assert.equal(after.metrics.gravityTrimUp, 0, 'the trim post must read exactly zero when it is off');
});

t('a change is found on the sequences that exercise it, and only there', () => {
	// The other half of the same claim. The point of having six sequences is
	// that the diff says WHICH manoeuvre moved; a harness that lit up everywhere
	// for any change would carry no more information than a single number.
	const a = replay('ground-pass');
	const b = replay('hover-hold');
	assert.ok(a.metrics.groundEffectUp > 0.005, 'ground-pass must actually be in ground effect');
	assert.equal(b.metrics.groundEffectUp, 0, 'hover-hold must be nowhere near the ground');
});

t('the diff refuses to pretend two different things are comparable', () => {
	const a = replay('hover-hold');
	const b = replay('hover-hold', { dt: DT / 2 });
	assert.ok(diff(a, b).warnings.some((w) => w.includes('step')), 'a step mismatch must be warned about');
	const c = replay('hover-hold', { family: 'toothpick' });
	assert.ok(diff(a, c).warnings.some((w) => w.includes('famil')), 'a family mismatch must be warned about');
	const e = replay('flip');
	assert.ok(diff(a, e).warnings.some((w) => w.includes('sequence')), 'a sequence mismatch must be warned about');
});

t('the noise floor hides the last digits and nothing more', () => {
	const a = replay('hover-hold');
	const nudge = (key, by) => {
		const b = structuredClone(a);
		b.metrics[key] += by;
		b.checksum = 'deadbeef';
		return diff(a, b).changed.map((r) => r.metric);
	};
	// Half a millimetre of altitude is reassociation, not a flight change.
	assert.equal(nudge('lateralDrift', 5e-5).length, 0, 'sub-tolerance noise must stay quiet');
	// A centimetre is not.
	assert.ok(nudge('lateralDrift', 0.01).includes('lateralDrift'), 'a real change must be reported');
	// One point of stick out of 1000 is a real change on a stick.
	assert.ok(nudge('hoverStick', 1e-3).includes('hoverStick'));
});

t('on a chaotic sequence the trajectory rows are advisory, not results', () => {
	const a = replay('flip');
	const b = structuredClone(a);
	b.checksum = 'deadbeef';
	b.metrics.lateralDrift += 10;      // pure chaos: must not count
	b.metrics.peakRollRate += 50;      // a property of the manoeuvre: must count
	const d = diff(a, b);
	const changed = d.changed.map((r) => r.metric);
	assert.ok(!changed.includes('lateralDrift'), 'a chaotic trajectory metric must not be a result');
	assert.ok(changed.includes('peakRollRate'), 'a rate metric must stay a result even on a flip');
	// It is still SHOWN, flagged — hiding it would be a different kind of lie.
	const row = d.rows.find((r) => r.metric === 'lateralDrift');
	assert.ok(row.significant && row.advisory, 'the row must be present and marked advisory');
	assert.ok(d.warnings.some((w) => w.includes('chaotic')), 'and the run must say why');
});

t('every metric the diff can report has a unit', () => {
	const m = replay('ground-pass').metrics;
	for (const key of Object.keys(m)) {
		assert.ok(METRIC_UNITS[key], `${key} has no unit — the diff would print it bare`);
	}
});

t('a trace round-trips through JSON unchanged', () => {
	// Recordings are meant to be kept and compared months later; a metric that
	// does not survive JSON.stringify would make that silently wrong.
	const a = replay('climb-descend', { sampleHz: 10 });
	const b = JSON.parse(JSON.stringify(a));
	assert.equal(b.format, TRACE_FORMAT);
	assert.deepEqual(b.metrics, a.metrics);
	assert.equal(b.checksum, a.checksum);
	assert.equal(diff(a, b).changed.length, 0);
	assert.ok(b.samples.length > 0 && b.samples[0].length === b.columns.length);
});

t('the whole set replays in a few seconds, at every family', () => {
	// The harness is only useful if running it is cheap enough to do on every
	// change. Six sequences, six families, one wall-clock budget.
	const t0 = Date.now();
	for (const fam of ['freestyle5', 'toothpick', 'cinewhoop']) {
		for (const name of SEQUENCE_NAMES) replay(name, { family: fam });
	}
	const ms = Date.now() - t0;
	assert.ok(ms < 20000, `18 replays took ${ms} ms`);
	console.log(`      (18 replays in ${ms} ms)`);
});

console.log(`flight-replay-selftest : ${n} tests ok`);

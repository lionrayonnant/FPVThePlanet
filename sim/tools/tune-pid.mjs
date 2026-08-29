// Step-response bench for the rate loop. Integrates an airframe's real
// rotational dynamics (Euler's equations with the inertia tensor from
// src/drone-profiles.js) against its real motor lag and mixer, with no Rapier
// and no renderer, so a full sweep of candidate gains runs in a second.
//
//   node tools/tune-pid.mjs                  # report every family's current tune
//   node tools/tune-pid.mjs <family>         # report one family
//   node tools/tune-pid.mjs --sweep [axis] [family]
//                                            # search P/D around one axis and rank
//   node tools/tune-pid.mjs --write <family|all>
//                                            # sweep every axis of a family,
//                                            # measure torquePerMix, and write the
//                                            # `pid` block back into drone-profiles.js
//
// What the numbers mean:
//   rise      time to first reach 90% of the commanded rate
//   overshoot peak beyond the setpoint
//   settle    time to stay inside +-5% of setpoint
//   bounce    rate left 100 ms after the stick centres, as a percentage of the
//             rate that was commanded
// A tune that fails "settle" is the one that feels like it is oscillating; one
// that fails "bounce" is the one that wobbles at the end of every flick.
//
// The rise and settle thresholds are not flat numbers: they are derived from
// how long the airframe physically needs to reach the commanded rate at its own
// peak angular acceleration, which sustainedAccel() measures off the profile.
// Otherwise a 1100 deg/s race preset would "fail" for being asked to do more
// work than a 380 deg/s cinematic one, and yaw — which has an eighth of roll's
// torque and twice its inertia — would fail permanently no matter how it were
// tuned.
//
// CLAUDE.md: PID values are measured, not hand-edited. `--write` is how a
// family's `pid` block is produced; do not type gains into drone-profiles.js.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Propulsion } from '../src/quad.js';
import { PROFILES, FAMILIES, DEFAULT_FAMILY } from '../src/drone-profiles.js';
import { FlightController, RATE_PRESETS, setGains } from '../src/flightController.js';

const ZERO = { x: 0, y: 0, z: 0 };
// Set BENCH_OMEGA=0 to bench the airframe without the per-motor inflow damping,
// which is how its cost was measured against the old model.
const BENCH_OMEGA = process.env.BENCH_OMEGA !== '0';

const DT = 1 / 250;
const DEG = Math.PI / 180;

const AXIS_RATE = { roll: 'z', pitch: 'x', yaw: 'y' };
const AXES = ['roll', 'pitch', 'yaw'];
const STEP_AT = 0.15;           // s, when the stick slams to the stop
const SIGN = { roll: -1, pitch: 1, yaw: -1 };
const FULL_MIX = { roll: [1, 1, -1, -1], pitch: [-1, 1, -1, 1], yaw: [-1, 1, 1, -1] };

// Rigid-body rotation only: the bench holds the quad in place and lets it spin,
// which is exactly the plant the rate loop sees. `override` is an optional
// { axis: {p, d} } applied on top of the family's tune, used by the sweep.
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };

function run({ profile, axis, seconds = 1.2, stick, throttle = 0.35, override }) {
	const fc = new FlightController({ profile });
	if (override) for (const ax of AXES) if (override[ax]) setGains(fc.gains, ax, override[ax]);
	const prop = new Propulsion({ profile });
	const I = profile.inertia;
	let w = { x: 0, y: 0, z: 0 };
	const trace = [];

	const steps = Math.round(seconds / DT);
	for (let i = 0; i < steps; i++) {
		const t = i * DT;
		const s = { throttle, roll: 0, pitch: 0, yaw: 0 };
		s[axis] = typeof stick === 'function' ? stick(t) : stick;

		// The bench frame IS the body frame and `w` is already body-frame, so the
		// controller gets identity orientation. Feeding it the integrated attitude
		// instead makes it unrotate a body-frame rate by a large angle and chase
		// the phantom cross-axis oscillation that falls out — which stays small
		// for the reference tune but diverges for a faster (micro) loop holding a
		// high rate. This bench only ever tests the acro rate loop; nothing here
		// reads orientation.
		const state = { rotation: IDENTITY, angularVelocity: w, position: ZERO, velocity: ZERO };
		const { motors } = fc.update(s, state, DT);
		const { torque } = prop.step(motors, { v: ZERO, omega: BENCH_OMEGA ? w : ZERO, agl: null, shake: 0 }, DT);

		// I*wdot = tau - w x (I*w)
		const Iw = { x: I.x * w.x, y: I.y * w.y, z: I.z * w.z };
		const gyro = {
			x: w.y * Iw.z - w.z * Iw.y,
			y: w.z * Iw.x - w.x * Iw.z,
			z: w.x * Iw.y - w.y * Iw.x,
		};
		w = {
			x: w.x + ((torque.x - gyro.x) / I.x) * DT,
			y: w.y + ((torque.y - gyro.y) / I.y) * DT,
			z: w.z + ((torque.z - gyro.z) / I.z) * DT,
		};

		trace.push({ t, w: { ...w }, motors: [...motors] });
	}
	return trace;
}

function metrics(profile, axis, override) {
	// Centre, then full stick for 0.6 s, then centre again. Starting at the stop
	// would prime the RC smoothing filters to it on their first sample, so no
	// smoothing — and therefore no feedforward — would ever happen and the bench
	// would be measuring a controller nobody flies.
	const preset = profile.rates;
	const trace = run({ profile, axis, override, seconds: 1.4, stick: (t) => (t >= STEP_AT && t < STEP_AT + 0.6 ? 1 : 0) });
	const comp = AXIS_RATE[axis];
	const target = RATE_PRESETS[preset][axis].max * DEG * SIGN[axis];
	const rate = trace.map((s) => s.w[comp]);

	const norm = rate.map((r) => r / target);        // 1.0 = on target
	const iStep = Math.round(STEP_AT / DT);
	const iEnd = Math.round((STEP_AT + 0.6) / DT);
	let rise = null, peak = 0;
	for (let i = iStep; i < iEnd; i++) {
		if (rise === null && norm[i] >= 0.9) rise = trace[i].t - STEP_AT;
		peak = Math.max(peak, norm[i]);
	}
	let settle = 0;
	for (let i = iEnd - 1; i >= iStep; i--) {
		if (Math.abs(norm[i] - 1) > 0.05) { settle = trace[i].t - STEP_AT; break; }
	}
	const after = trace.find((s) => s.t >= STEP_AT + 0.7);
	const bounce = (100 * Math.abs(after.w[comp])) / Math.abs(target);

	const sat = trace.slice(iStep, iEnd).filter((s) => s.motors.some((m) => m >= 0.999 || m <= 0.056)).length / (iEnd - iStep);

	return {
		rise: rise === null ? Infinity : rise * 1000,
		overshoot: (peak - 1) * 100,
		settle: settle * 1000,
		bounce,
		sat: sat * 100,
	};
}

// Sustained angular acceleration each axis can produce, measured by commanding
// the mixer hard over from a hover and reading the torque once the motors have
// settled. Deliberately the settled value and not the peak: spinning the props
// up throws a large one-off reaction torque into yaw that lasts about 20 ms and
// cannot be held, so using the peak would set targets no tune could meet.
function sustainedAccel(profile, axis) {
	const comp = AXIS_RATE[axis];
	const prop = new Propulsion({ profile });
	const motors = FULL_MIX[axis].map((m) => Math.max(0.055, Math.min(1, 0.5 + m * 0.5)));
	let torque = null;
	for (let i = 0; i < 500; i++) ({ torque } = prop.step(motors, { v: ZERO, omega: ZERO, agl: null, shake: 0 }, DT));
	return Math.abs(torque[comp]) / profile.inertia[comp];      // rad/s^2
}

// torquePerMix: the local "one mixer unit -> this much torque near a hover"
// slope the feedforward is derived from (F = I / torquePerMix). Measured, not
// guessed: hold a hover, push a small deflection on one axis' mix vector, let
// the motors settle, read the torque, divide by the deflection. Small enough
// (0.15) that motor saturation and the rpm-squared curvature do not bend the
// slope, large enough to sit well above numerical noise.
function measureTorquePerMix(profile) {
	const hover = ((profile.mass * 9.81) / (4 * profile.maxThrustPerMotor)) ** (1 / (2 * profile.rpmCurve));
	const level = 0.15;
	const out = {};
	for (const axis of AXES) {
		const comp = AXIS_RATE[axis];
		const motors = FULL_MIX[axis].map((m) => Math.max(0.055, Math.min(1, hover + level * m)));
		const prop = new Propulsion({ profile });
		let torque = null;
		for (let i = 0; i < 500; i++) ({ torque } = prop.step(motors, { v: ZERO, omega: ZERO, agl: null, shake: 0 }, DT));
		out[axis] = Math.abs(torque[comp]) / level;
	}
	return out;
}

// 35 ms covers the RC link and the filter chain; the rest is the airframe. The
// multipliers are the slack a closed loop needs over the open-loop minimum.
function limitsFor(profile, axis, alpha) {
	const tPhys = (RATE_PRESETS[profile.rates][axis].max * DEG) / alpha[axis];   // s
	return {
		rise: 35 + 1500 * tPhys,
		overshoot: 12,
		settle: 60 + 3000 * tPhys,
		bounce: Math.max(8, 100 * Math.max(0, 1 - 0.1 / tPhys) + 6),
	};
}

function alphaFor(profile) {
	return {
		roll: sustainedAccel(profile, 'roll'),
		pitch: sustainedAccel(profile, 'pitch'),
		yaw: sustainedAccel(profile, 'yaw'),
	};
}

function report(profile) {
	const alpha = alphaFor(profile);
	console.log(`\n${profile.family}  —  preset "${profile.rates}" (${RATE_PRESETS[profile.rates].roll.max} deg/s roll)`);
	console.log('  axis    rise    overshoot   settle   bounce   motor sat   (limit: rise/settle)');
	let bad = 0;
	for (const axis of AXES) {
		const m = metrics(profile, axis);
		const lim = limitsFor(profile, axis, alpha);
		const flag = (k) => (m[k] > lim[k] ? '!' : ' ');
		if (['rise', 'overshoot', 'settle', 'bounce'].some((k) => m[k] > lim[k])) bad++;
		console.log(
			`  ${axis.padEnd(6)}  ${m.rise.toFixed(0).padStart(4)}ms${flag('rise')}` +
			`  ${m.overshoot.toFixed(1).padStart(7)}%${flag('overshoot')}` +
			`  ${m.settle.toFixed(0).padStart(6)}ms${flag('settle')}` +
			`  ${m.bounce.toFixed(1).padStart(6)}%${flag('bounce')}` +
			`  ${m.sat.toFixed(0).padStart(6)}%` +
			`     ${lim.rise.toFixed(0)}/${lim.settle.toFixed(0)}ms`,
		);
	}
	return bad;
}

// Disturbance rejection: hold zero rate, kick the body, see how fast it stops.
function kickTest(profile) {
	console.log(`\n${profile.family} — disturbance rejection (200 deg/s kick, hands off)`);
	for (const axis of AXES) {
		const comp = AXIS_RATE[axis];
		const I = profile.inertia;
		const fc = new FlightController({ profile });
		const prop = new Propulsion({ profile });
		let w = { x: 0, y: 0, z: 0 };
		w[comp] = 200 * DEG;
		const q = { x: 0, y: 0, z: 0, w: 1 };
		let stopped = null;
		for (let i = 0; i < 250; i++) {
			const state = { rotation: q, angularVelocity: w, position: ZERO, velocity: ZERO };
			const { motors } = fc.update({ throttle: 0.35, roll: 0, pitch: 0, yaw: 0 }, state, DT);
			const { torque } = prop.step(motors, { v: ZERO, omega: BENCH_OMEGA ? w : ZERO, agl: null, shake: 0 }, DT);
			w = { x: w.x + (torque.x / I.x) * DT, y: w.y + (torque.y / I.y) * DT, z: w.z + (torque.z / I.z) * DT };
			if (stopped === null && Math.abs(w[comp]) < 10 * DEG) stopped = i * DT;
		}
		console.log(`  ${axis.padEnd(6)}  stopped in ${stopped === null ? '>1000' : (stopped * 1000).toFixed(0)} ms`);
	}
}

// Airmode: the same flick at zero throttle must still produce the rate.
function airmodeTest(profile) {
	console.log(`\n${profile.family} — airmode (full roll flick at each throttle position)`);
	for (const throttle of [0, 0.1, 0.25, 0.5, 0.85, 1.0]) {
		const trace = run({ profile, axis: 'roll', throttle, stick: 1, seconds: 0.5 });
		const peak = Math.max(...trace.map((s) => Math.abs(s.w.z))) / DEG;
		console.log(`  throttle ${(throttle * 100).toFixed(0).padStart(3)}%  ->  ${peak.toFixed(0).padStart(4)} deg/s peak`);
	}
}

// Coarse P/D grid, ranked by one explicit cost so the trade-off between rise
// time and ringing is made deliberately rather than by eye. Ki follows Kp, so
// only P and D are free.
//
// The standard P/D grid is the one the tool has always swept. Micro airframes
// (filterScale set, meaning a much faster plant) sit higher on P — the rotor
// drag on rate is large next to their thrust, so P has to hold most of the
// setpoint on its own — so they get a grid shifted up, the way a real micro
// tune is.
function sweepAxis(profile, axis) {
	const alpha = alphaFor(profile);
	const lim = limitsFor(profile, axis, alpha);
	const micro = (profile.filterScale ?? 1) > 1.5;
	const pRange = axis === 'yaw'
		? (micro ? [0.04, 0.07, 0.11, 0.16, 0.24, 0.32] : [0.10, 0.14, 0.18, 0.22, 0.28, 0.34])
		: (micro ? [0.08, 0.11, 0.15, 0.20, 0.26, 0.32] : [0.030, 0.038, 0.046, 0.054, 0.062, 0.072, 0.084, 0.098]);
	const dRange = axis === 'yaw'
		? (micro ? [0, 0.0005, 0.0010, 0.0020, 0.0035, 0.0055, 0.0080] : [0, 0.0005, 0.0010, 0.0020])
		: [0.0003, 0.0005, 0.0007, 0.0010, 0.0014, 0.0019];

	const results = [];
	for (const p of pRange) {
		for (const d of dRange) {
			const m = metrics(profile, axis, { [axis]: { p, d } });
			const cost = Math.max(0, m.rise - lim.rise * 0.75)
				+ 4 * Math.max(0, m.overshoot - 6)
				+ 0.25 * Math.max(0, m.settle - lim.settle * 0.6)
				+ 0.5 * m.bounce;
			results.push({ p, d, ...m, cost });
		}
	}
	results.sort((a, b) => a.cost - b.cost);
	// The bench cannot see gyro noise, so prefer the lower P — but only among
	// tunes that are genuinely well-behaved (bounded overshoot and settle) and
	// within a hair of the best cost. Without the quality gate the low-P
	// preference will happily pick a fragile corner that "won" a flat cost
	// landscape by a rounding error.
	const minCost = results[0].cost;
	const clean = results.filter((r) => r.cost <= minCost + 0.5 && r.overshoot <= 10 && r.settle <= lim.settle * 1.15 && Number.isFinite(r.rise));
	const pool = clean.length ? clean : [results[0]];
	pool.sort((a, b) => a.p - b.p || a.d - b.d);
	return { best: pool[0], results, lim, pRange, dRange };
}

const PROFILES_PATH = fileURLToPath(new URL('../src/drone-profiles.js', import.meta.url));

// Match the file's number style: plain decimal for the big ones, exponential
// for the small coefficients.
function fmt(v) {
	if (v === 0) return '0';
	if (Math.abs(v) >= 0.01) {
		const s = v.toFixed(4).replace(/0+$/, '');
		return s.endsWith('.') ? `${s}0` : s;
	}
	return v.toExponential(2);
}

function writeFamilyPid(family, pid) {
	const src = readFileSync(PROFILES_PATH, 'utf8');
	const block = `pid: {
			roll:  { p: ${fmt(pid.roll.p)}, d: ${fmt(pid.roll.d)} },
			pitch: { p: ${fmt(pid.pitch.p)}, d: ${fmt(pid.pitch.d)} },
			yaw:   { p: ${fmt(pid.yaw.p)}, d: ${fmt(pid.yaw.d)} },
			torquePerMix: { roll: ${pid.torquePerMix.roll.toFixed(3)}, pitch: ${pid.torquePerMix.pitch.toFixed(3)}, yaw: ${pid.torquePerMix.yaw.toFixed(3)} },
		},`;
	const re = new RegExp(`(family: '${family}',[\\s\\S]*?)pid: \\{[\\s\\S]*?\\n\\t\\t\\},`);
	if (!re.test(src)) throw new Error(`could not locate pid block for family ${family}`);
	writeFileSync(PROFILES_PATH, src.replace(re, `$1${block}`));
}

function writeFamily(family) {
	const profile = PROFILES[family];
	if (!profile) throw new Error(`unknown family: ${family}`);
	console.log(`\n${family}: measuring torquePerMix and sweeping P/D per axis…`);
	const torquePerMix = measureTorquePerMix(profile);
	// The sweep for one axis runs with the other two axes' gains as they stand,
	// and the closed loops do couple, so a single pass leaves each axis tuned
	// against the *old* other two. Two passes, mutating the in-memory profile as
	// we go, converge it — the second pass barely moves after the first.
	profile.pid.torquePerMix = torquePerMix;
	let last;
	for (let pass = 0; pass < 2; pass++) {
		last = {};
		for (const axis of AXES) {
			const { best } = sweepAxis(profile, axis);
			profile.pid[axis] = { p: best.p, d: best.d };
			last[axis] = best;
		}
	}
	for (const axis of AXES) {
		const b = last[axis];
		const l = limitsFor(profile, axis, alphaFor(profile));
		console.log(
			`  ${axis.padEnd(6)} P=${b.p.toFixed(3)} D=${b.d.toFixed(4)}` +
			`  rise ${b.rise.toFixed(0)}ms  over ${b.overshoot.toFixed(1)}%` +
			`  settle ${b.settle.toFixed(0)}ms  bounce ${b.bounce.toFixed(1)}%` +
			`  (limit rise/settle ${l.rise.toFixed(0)}/${l.settle.toFixed(0)}ms)` +
			`${b.rise > l.rise || b.settle > l.settle || b.overshoot > l.overshoot ? '  !' : ''}`,
		);
	}
	console.log(`  torquePerMix  roll ${torquePerMix.roll.toFixed(3)}  pitch ${torquePerMix.pitch.toFixed(3)}  yaw ${torquePerMix.yaw.toFixed(3)}`);
	writeFamilyPid(family, {
		roll: profile.pid.roll, pitch: profile.pid.pitch, yaw: profile.pid.yaw, torquePerMix,
	});
	console.log('  written to src/drone-profiles.js');
}

// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);

if (argv.includes('--write')) {
	const which = argv[argv.indexOf('--write') + 1];
	if (!which) { console.error('usage: --write <family|all>'); process.exit(2); }
	// freestyle5 is the reference tune — already measured and committed, and the
	// yardstick the refactor is checked against. `--write all` leaves it alone;
	// `--write freestyle5` still rewrites it if you really mean to.
	const fams = which === 'all' ? FAMILIES.filter((f) => f !== DEFAULT_FAMILY) : [which];
	for (const f of fams) writeFamily(f);
	console.log('\ndone. review the diff, run `npm run tune` and `npm run selftest`, then commit.');
} else if (argv.includes('--sweep')) {
	const rest = argv.filter((a) => a !== '--sweep');
	const axis = AXES.includes(rest[0]) ? rest[0] : 'roll';
	const family = rest.find((a) => FAMILIES.includes(a)) ?? DEFAULT_FAMILY;
	const profile = PROFILES[family];
	const { results } = sweepAxis(profile, axis);
	console.log(`\nsweep "${axis}" on ${family} — current is P=${profile.pid[axis].p} D=${profile.pid[axis].d}`);
	console.log('  P       D        rise   over   settle  bounce   cost');
	for (const r of results.slice(0, 10)) {
		console.log(`  ${r.p.toFixed(3)}  ${r.d.toFixed(4)}  ${r.rise.toFixed(0).padStart(4)}ms ${r.overshoot.toFixed(1).padStart(5)}% ${r.settle.toFixed(0).padStart(5)}ms ${r.bounce.toFixed(0).padStart(5)}  ${r.cost.toFixed(1).padStart(6)}`);
	}
	console.log(`\nrun \`node tools/tune-pid.mjs --write ${family}\` to sweep every axis and write the block.`);
} else {
	const only = argv.find((a) => FAMILIES.includes(a));
	const fams = only ? [only] : FAMILIES;
	let bad = 0;
	for (const f of fams) bad += report(PROFILES[f]);
	for (const f of fams) { kickTest(PROFILES[f]); airmodeTest(PROFILES[f]); }
	console.log(`\n${bad === 0 ? 'every axis inside the targets' : `${bad} axis/family combination(s) outside the targets`}`);
	process.exit(bad === 0 ? 0 : 1);
}

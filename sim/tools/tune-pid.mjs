// Step-response bench for the rate loop. Integrates the airframe's real
// rotational dynamics (Euler's equations with the inertia tensor from quad.js)
// against the real motor lag and mixer, with no Rapier and no renderer, so a
// full sweep of candidate gains runs in a second.
//
//   node tools/tune-pid.mjs              # report the current tune
//   node tools/tune-pid.mjs --sweep      # search P/D around it and rank
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
// peak angular acceleration, which peakAccel() measures off quad.js. Otherwise
// a 1100 deg/s race preset would "fail" for being asked to do more work than a
// 380 deg/s cinematic one, and yaw — which has an eighth of roll's torque and
// twice its inertia — would fail permanently no matter how it were tuned.

import { Propulsion, QUAD } from '../src/quad.js';

const ZERO = { x: 0, y: 0, z: 0 };
// Set BENCH_OMEGA=0 to bench the airframe without the per-motor inflow damping,
// which is how its cost was measured against the old model.
const BENCH_OMEGA = process.env.BENCH_OMEGA !== '0';
import { FlightController, RATE_PRESETS, PID, setGains } from '../src/flightController.js';

const DT = 1 / 250;
const DEG = Math.PI / 180;

// Rigid-body rotation only: the bench holds the quad in place and lets it spin,
// which is exactly the plant the rate loop sees.
function run({ axis, seconds = 1.2, stick, throttle = 0.35, preset = 'freestyle' }) {
	const fc = new FlightController(preset);
	const prop = new Propulsion();
	const I = QUAD.inertia;
	let w = { x: 0, y: 0, z: 0 };
	let q = { x: 0, y: 0, z: 0, w: 1 };
	const trace = [];

	const steps = Math.round(seconds / DT);
	for (let i = 0; i < steps; i++) {
		const t = i * DT;
		const s = { throttle, roll: 0, pitch: 0, yaw: 0 };
		s[axis] = typeof stick === 'function' ? stick(t) : stick;

		const state = { rotation: q, angularVelocity: w, position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 } };
		const { motors } = fc.update(s, state, DT);
		// The bench frame is the body frame, so `w` is already what quad.js wants.
		// BENCH_OMEGA lets the per-motor inflow damping be switched off, which is
		// how the before/after in the commit message was measured.
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

		// The bench frame is the body frame, so integrating the quaternion with
		// the body rate keeps the levelled modes honest if they are ever benched.
		const h = DT * 0.5;
		const nq = {
			x: q.x + h * (q.w * w.x + q.y * w.z - q.z * w.y),
			y: q.y + h * (q.w * w.y + q.z * w.x - q.x * w.z),
			z: q.z + h * (q.w * w.z + q.x * w.y - q.y * w.x),
			w: q.w - h * (q.x * w.x + q.y * w.y + q.z * w.z),
		};
		const n = Math.hypot(nq.x, nq.y, nq.z, nq.w);
		q = { x: nq.x / n, y: nq.y / n, z: nq.z / n, w: nq.w / n };

		trace.push({ t, w: { ...w }, motors: [...motors] });
	}
	return trace;
}

const AXIS_RATE = { roll: 'z', pitch: 'x', yaw: 'y' };
const SIGN = { roll: -1, pitch: 1, yaw: -1 };

const STEP_AT = 0.15;           // s, when the stick slams to the stop

function metrics(axis, preset = 'freestyle') {
	// Centre, then full stick for 0.6 s, then centre again. Starting at the stop
	// would prime the RC smoothing filters to it on their first sample, so no
	// smoothing — and therefore no feedforward — would ever happen and the bench
	// would be measuring a controller nobody flies.
	const trace = run({ axis, preset, seconds: 1.4, stick: (t) => (t >= STEP_AT && t < STEP_AT + 0.6 ? 1 : 0) });
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
	// Last moment before the stick centres at which we were outside +-5%.
	let settle = 0;
	for (let i = iEnd - 1; i >= iStep; i--) {
		if (Math.abs(norm[i] - 1) > 0.05) { settle = trace[i].t - STEP_AT; break; }
	}
	// Bounce as a fraction of the commanded rate, not an absolute: stopping
	// 1100 deg/s and stopping 380 deg/s are not the same job, and an absolute
	// threshold just punishes the fast presets for being fast.
	const after = trace.find((s) => s.t >= STEP_AT + 0.7);
	const bounce = (100 * Math.abs(after.w[comp])) / Math.abs(target);

	// Saturation tells you whether the tune is real or just riding the clamps.
	const sat = trace.slice(iStep, iEnd).filter((s) => s.motors.some((m) => m >= 0.999 || m <= 0.056)).length / (iEnd - iStep);

	return {
		rise: rise === null ? Infinity : rise * 1000,
		overshoot: (peak - 1) * 100,
		settle: settle * 1000,
		bounce,
		sat: sat * 100,
	};
}

// Yaw gets a longer rise budget on purpose. A quad yaws by unbalancing prop
// drag torque, which is roughly an eighth of the torque the same motors make
// in roll, against the largest of the three inertias. ~150 ms to 600 deg/s is
// the airframe, not the tune, and faking it away would be faking the quad.
// Sustained angular acceleration each axis can produce, measured by commanding
// the mixer hard over from a hover and reading the torque once the motors have
// settled. Deliberately the settled value and not the peak: spinning the props
// up throws a large one-off reaction torque into yaw that lasts about 20 ms and
// cannot be held, so using the peak would set targets no tune could meet.
function sustainedAccel(axis) {
	const comp = AXIS_RATE[axis];
	const prop = new Propulsion();
	const full = { roll: [1, 1, -1, -1], pitch: [-1, 1, -1, 1], yaw: [-1, 1, 1, -1] }[axis];
	const motors = full.map((m) => Math.max(0.055, Math.min(1, 0.5 + m * 0.5)));
	let torque = null;
	for (let i = 0; i < 500; i++) ({ torque } = prop.step(motors, { v: ZERO, omega: ZERO, agl: null, shake: 0 }, DT));
	return Math.abs(torque[comp]) / QUAD.inertia[comp];      // rad/s^2
}

const ALPHA = { roll: sustainedAccel('roll'), pitch: sustainedAccel('pitch'), yaw: sustainedAccel('yaw') };

// 35 ms covers the RC link and the filter chain; the rest is the airframe. The
// multipliers are the slack a closed loop needs over the open-loop minimum.
function limitsFor(axis, preset) {
	const tPhys = (RATE_PRESETS[preset][axis].max * DEG) / ALPHA[axis];   // s
	return {
		rise: 35 + 1500 * tPhys,
		overshoot: 12,
		settle: 60 + 3000 * tPhys,
		// Same reasoning for the stop: you cannot shed the rate faster than the
		// axis can decelerate, and 100 ms of that is all the metric allows.
		bounce: Math.max(8, 100 * Math.max(0, 1 - 0.1 / tPhys) + 6),
	};
}

function report(preset = 'freestyle') {
	console.log(`\npreset "${preset}"  (${RATE_PRESETS[preset].roll.max} deg/s roll)`);
	console.log('  axis    rise    overshoot   settle   bounce   motor sat   (limit: rise/settle)');
	let bad = 0;
	for (const axis of ['roll', 'pitch', 'yaw']) {
		const m = metrics(axis, preset);
		const lim = limitsFor(axis, preset);
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
function kickTest() {
	console.log('\ndisturbance rejection (200 deg/s kick, hands off)');
	for (const axis of ['roll', 'pitch', 'yaw']) {
		const comp = AXIS_RATE[axis];
		const I = QUAD.inertia;
		const fc = new FlightController('freestyle');
		const prop = new Propulsion();
		let w = { x: 0, y: 0, z: 0 };
		w[comp] = 200 * DEG;
		const q = { x: 0, y: 0, z: 0, w: 1 };
		let stopped = null;
		for (let i = 0; i < 250; i++) {
			const state = { rotation: q, angularVelocity: w, position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 } };
			const { motors } = fc.update({ throttle: 0.35, roll: 0, pitch: 0, yaw: 0 }, state, DT);
			const { torque } = prop.step(motors, { v: ZERO, omega: BENCH_OMEGA ? w : ZERO, agl: null, shake: 0 }, DT);
			w = { x: w.x + (torque.x / I.x) * DT, y: w.y + (torque.y / I.y) * DT, z: w.z + (torque.z / I.z) * DT };
			if (stopped === null && Math.abs(w[comp]) < 10 * DEG) stopped = i * DT;
		}
		console.log(`  ${axis.padEnd(6)}  stopped in ${stopped === null ? '>1000' : (stopped * 1000).toFixed(0)} ms`);
	}
}

// Airmode: the same flick at zero throttle must still produce the rate, which
// is the whole point of sliding throttle instead of clipping the mix.
function airmodeTest() {
	console.log('\nairmode (full roll flick at each throttle position)');
	for (const throttle of [0, 0.1, 0.25, 0.5, 0.85, 1.0]) {
		const trace = run({ axis: 'roll', throttle, stick: 1, seconds: 0.5 });
		const peak = Math.max(...trace.map((s) => Math.abs(s.w.z))) / DEG;
		console.log(`  throttle ${(throttle * 100).toFixed(0).padStart(3)}%  ->  ${peak.toFixed(0).padStart(4)} deg/s peak`);
	}
}

if (process.argv.includes('--sweep')) {
	// Coarse grid around the current tune, ranked by one explicit cost so the
	// trade-off between rise time and ringing is made deliberately rather than
	// by eye. Ki follows Kp through setGains, so only P and D are free here.
	const axis = process.argv[process.argv.indexOf('--sweep') + 1] ?? 'roll';
	const base = { ...PID[axis] };
	const results = [];
	const pRange = axis === 'yaw'
		? [0.10, 0.14, 0.18, 0.22, 0.28, 0.34]
		: [0.030, 0.038, 0.046, 0.054, 0.062, 0.072, 0.084];
	const dRange = axis === 'yaw'
		? [0, 0.0005, 0.0010, 0.0020]
		: [0.0003, 0.0005, 0.0007, 0.0010, 0.0014, 0.0019];

	for (const p of pRange) {
		for (const d of dRange) {
			setGains(axis, { p, d });
			const m = metrics(axis, 'freestyle');
			const lim = limitsFor(axis, 'freestyle');
			const cost = Math.max(0, m.rise - lim.rise * 0.75)
				+ 4 * Math.max(0, m.overshoot - 6)
				+ 0.25 * Math.max(0, m.settle - lim.settle * 0.6)
				+ 0.5 * m.bounce;
			results.push({ p, d, ...m, cost });
		}
	}
	setGains(axis, base);

	results.sort((a, b) => a.cost - b.cost);
	console.log(`\nsweep "${axis}" — current is P=${base.p} D=${base.d}`);
	console.log('  P       D        rise   over   settle  bounce   cost');
	for (const r of results.slice(0, 10)) {
		console.log(`  ${r.p.toFixed(3)}  ${r.d.toFixed(4)}  ${r.rise.toFixed(0).padStart(4)}ms ${r.overshoot.toFixed(1).padStart(5)}% ${r.settle.toFixed(0).padStart(5)}ms ${r.bounce.toFixed(0).padStart(5)}  ${r.cost.toFixed(1).padStart(6)}`);
	}
	console.log('\nput the winning P/D into PID in src/flightController.js');
} else {
	let bad = 0;
	for (const preset of Object.keys(RATE_PRESETS)) bad += report(preset);
	kickTest();
	airmodeTest();
	console.log(`\n${bad === 0 ? 'every axis inside the targets' : `${bad} axis/preset combination(s) outside the targets`}`);
	process.exit(bad === 0 ? 0 : 1);
}

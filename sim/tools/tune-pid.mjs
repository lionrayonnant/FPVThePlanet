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
// how long the airframe physically needs to reach the commanded rate with the
// mixer at the stop, which openLoopRise() MEASURES on the same plant the bench
// flies. Otherwise a 1100 deg/s race preset would "fail" for being asked to do
// more work than a 380 deg/s cinematic one, and yaw — which has an eighth of
// roll's torque and twice its inertia — would fail permanently no matter how it
// were tuned.
//
// CLAUDE.md: PID values are measured, not hand-edited. `--write` is how a
// family's `pid` block is produced; do not type gains into drone-profiles.js.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Propulsion, cruiseSpeedOf } from '../src/quad.js';
import { PROFILES, FAMILIES, DEFAULT_FAMILY } from '../src/drone-profiles.js';
import { FlightController, RATE_PRESETS, setGains, hoverThrottle } from '../src/flightController.js';
import { CONTROL_SUBSTEPS } from '../src/frame-pacing.js';

const IDENTITY_Q = { x: 0, y: 0, z: 0, w: 1 };

const ZERO = { x: 0, y: 0, z: 0 };
// Set BENCH_OMEGA=0 to bench the airframe without the per-motor inflow damping,
// which is how its cost was measured against the old model.
const BENCH_OMEGA = process.env.BENCH_OMEGA !== '0';

// The bench holds the quad in still air by default, which is the right plant
// for a rate loop and is why every number it prints is comparable back to the
// day it was written. It is ALSO why it is blind to everything issue #91 added:
// translational lift and flapback are identically zero at zero airspeed, and
// precession contributes nothing either, since on a symmetric X the net rotor
// momentum is exactly zero under a pure roll or pitch command and a yaw command
// spins the body about the very axis the momentum lies along.
//
// `--cruise` flies the bench forward at the family's own settling speed
// instead, which is the only way a sweep can be asked whether the new
// aerodynamics want a different tune. Off by default: turning it on changes
// what "measured" means, so it has to be asked for.
let CRUISE = false;

const DT = 1 / 250;
// The controller substeps inside the physics step, exactly as src/main.js does
// and at the same ratio (src/frame-pacing.js). This is not a refinement: the
// gyro noise, the notches and the delay line all live at the CONTROL rate, and
// a tune swept against a 250 Hz loop is a tune for a machine nobody flies. The
// airframe is still integrated on the 250 Hz grid — it does not rotate at
// 4 kHz, the gyro merely says it does — and the physics takes the LAST
// substep's motor command, the way an ESC holds its last DSHOT frame.
const SUB = Math.max(1, CONTROL_SUBSTEPS);
const DT_CONTROL = DT / SUB;
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

function run({ profile, axis, seconds = 1.2, stick, throttle = 0.35, override, cruise = CRUISE }) {
	const fc = new FlightController({ profile });
	if (override) for (const ax of AXES) if (override[ax]) setGains(fc.gains, ax, override[ax]);
	const prop = new Propulsion({ profile });
	// Body frame, forward is -Z. Zero unless --cruise, in which case the whole
	// bench is identical to the one that has always been run.
	const air = cruise ? { x: 0, y: 0, z: -cruiseSpeedOf(profile) } : ZERO;
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
		// `rotorOmega` is what the RPM notches follow. Without it the conditioning
		// chain is handed no telemetry and falls back to the dynamic notch alone,
		// which is a configuration the game never flies.
		const state = { rotation: IDENTITY, angularVelocity: w, position: ZERO, velocity: ZERO, rotorOmega: prop.omega };
		let motors;
		for (let c = 0; c < SUB; c++) ({ motors } = fc.update(s, state, DT_CONTROL));
		const { torque } = prop.step(motors, { v: air, omega: BENCH_OMEGA ? w : ZERO, agl: null, shake: 0 }, DT);

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

function metrics(profile, axis, override, cruise = CRUISE) {
	// Centre, then full stick for 0.6 s, then centre again. Starting at the stop
	// would prime the RC smoothing filters to it on their first sample, so no
	// smoothing — and therefore no feedforward — would ever happen and the bench
	// would be measuring a controller nobody flies.
	const preset = profile.rates;
	const trace = run({ profile, axis, override, cruise, seconds: 1.4, stick: (t) => (t >= STEP_AT && t < STEP_AT + 0.6 ? 1 : 0) });
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
	const hover = hoverThrottle(profile, IDENTITY_Q);
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

// The open-loop minimum: how long the airframe physically takes to reach 90% of
// the commanded rate when the mixer is slammed hard over from a settled hover,
// with no controller in the way. This is a MEASUREMENT of the same plant the
// bench flies — the real motor torque balance, the real prop load, the real
// inertia tensor — and no tune can beat it, because no tune can ask the mixer
// for more than the stop.
//
// It replaces `rate_max / sustainedAccel`, which was the same idea done as
// arithmetic and which counted the rotor's own spin-up NOWHERE. That mattered
// from the moment `propInertia` answered to one shape rule (drone-profiles.js,
// rule 5): a rotor time constant is 11 ms on the cinewhoop but 40 ms on
// swarmNode and 49 ms on longrange, and an actuator eating two thirds of a rise
// budget cannot be out-gained in class. The formula called that a tuning
// failure; it was a ruler that did not know rotors exist.
//
// The transient the old note warned about is counted here, and counted
// correctly, which is the whole reason this is an integration and not a
// division: the one-off reaction torque that accelerating the discs throws into
// yaw contributes exactly the rate it is worth over exactly the time it lasts,
// instead of being either extrapolated to a sustained value it cannot hold or
// thrown away entirely.
//
// The body rate is fed back into the rotors, the way `run()` has always fed it
// back, because a ruler measured on a different plant from the thing it judges
// is not a ruler. It is worth stating what that is and is not worth, so nobody
// re-derives it: holding `omega: ZERO` instead — which sustainedAccel()
// legitimately does, since it only wants the settled torque — costs 4-8 ms on
// yaw and nothing measurable on roll or pitch. Small, and free.
//
// What the measurement DOES say loudly is that these times are not one family
// scaled: roll ranges 20 ms (toothpick) to 64 ms (longrange), and yaw 8 ms to
// 128 ms. The toothpick's yaw really does reach 216 deg/s in 8 ms — a fiftieth
// of the reference yaw inertia — so it gets the tightest budget here by a
// factor of three. That is the machine. What it still fails is `settle`, and
// that one is the metric counting gyro noise rather than convergence (#171).
function openLoopRise(profile, axis) {
	const comp = AXIS_RATE[axis];
	const I = profile.inertia;
	const target = 0.9 * RATE_PRESETS[profile.rates][axis].max * DEG;
	const prop = new Propulsion({ profile });
	// Settle the rotors at a hover first. A step is measured FROM somewhere, and
	// a bench that starts the props at rest charges the airframe for a spin-up
	// no flick ever pays.
	const hover = hoverThrottle(profile, IDENTITY_Q);
	const hold = [hover, hover, hover, hover];
	for (let i = 0; i < 500; i++) prop.step(hold, { v: ZERO, omega: ZERO, agl: null, shake: 0 }, DT);
	const motors = FULL_MIX[axis].map((m) => Math.max(0.055, Math.min(1, 0.5 + m * 0.5)));
	let w = { x: 0, y: 0, z: 0 };
	const steps = Math.round(2 / DT);
	for (let i = 0; i < steps; i++) {
		const { torque } = prop.step(motors, { v: ZERO, omega: BENCH_OMEGA ? w : ZERO, agl: null, shake: 0 }, DT);
		// I*wdot = tau - w x (I*w), the same Euler step run() integrates.
		const Iw = { x: I.x * w.x, y: I.y * w.y, z: I.z * w.z };
		w = {
			x: w.x + ((torque.x - (w.y * Iw.z - w.z * Iw.y)) / I.x) * DT,
			y: w.y + ((torque.y - (w.z * Iw.x - w.x * Iw.z)) / I.y) * DT,
			z: w.z + ((torque.z - (w.x * Iw.y - w.y * Iw.x)) / I.z) * DT,
		};
		if (Math.abs(w[comp]) >= target) return (i + 1) * DT;       // s
	}
	// The mixer at the stop never gets there: the axis cannot reach its own
	// commanded rate, which is a rate preset the airframe does not have, not a
	// budget. Infinity makes every limit infinite and the report says nothing —
	// so say it here.
	console.warn(`  ! ${profile.family} ${axis}: the mixer at the stop never reaches ${(RATE_PRESETS[profile.rates][axis].max)} deg/s`);
	return Infinity;
}

// 35 ms covers the RC link and the filter chain; the rest is the airframe. The
// multipliers are the slack a closed loop needs over the open-loop minimum.
//
// `bounce` keeps `tPhys`, and deliberately: it asks how much rate is LEFT 100 ms
// after the stick centres, and its 0.1 s constant was calibrated against the
// sustained-torque time scale. Swapping the quantity underneath it without
// re-deriving the constant would move three yaw axes that pass today. Which
// time scale bounce should be written against is its own question (#170).
function limitsFor(profile, axis, budget) {
	const { tOpen, tPhys } = budget[axis];
	return {
		rise: 35 + 1500 * tOpen,
		overshoot: 12,
		settle: 60 + 3000 * tOpen,
		bounce: Math.max(8, 100 * Math.max(0, 1 - 0.1 / tPhys) + 6),
	};
}

// Both time scales, per axis. Memoised on the profile: `--write` asks for them
// once per sweep candidate and each one costs a settled hover.
const BUDGETS = new WeakMap();
function budgetFor(profile) {
	const hit = BUDGETS.get(profile);
	if (hit) return hit;
	const out = {};
	for (const axis of AXES) {
		out[axis] = {
			tOpen: openLoopRise(profile, axis),
			tPhys: (RATE_PRESETS[profile.rates][axis].max * DEG) / sustainedAccel(profile, axis),
		};
	}
	BUDGETS.set(profile, out);
	return out;
}

function report(profile) {
	const budget = budgetFor(profile);
	console.log(`\n${profile.family}  —  preset "${profile.rates}" (${RATE_PRESETS[profile.rates].roll.max} deg/s roll)`);
	console.log('  axis    rise    overshoot   settle   bounce   motor sat   (limit: rise/settle)');
	let bad = 0;
	for (const axis of AXES) {
		const m = metrics(profile, axis);
		const lim = limitsFor(profile, axis, budget);
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
			const state = { rotation: q, angularVelocity: w, position: ZERO, velocity: ZERO, rotorOmega: prop.omega };
			const sticks = { throttle: 0.35, roll: 0, pitch: 0, yaw: 0 };
			let motors;
			for (let c = 0; c < SUB; c++) ({ motors } = fc.update(sticks, state, DT_CONTROL));
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
//
// The roll/pitch D range used to stop at 0.0019, which is where freestyle5's
// own tune sits — a grid whose ceiling is the reference family's answer can
// only ever confirm it. It refused longrange: with a rise budget that finally
// counts its rotor (limitsFor), BOTH its axes picked the top of the D range and
// still rang past the settle limit, which is a grid ceiling and not a machine.
// Three more points on the same 1.35x progression put both inside every limit.
// This is the second half of what the heavy-rotor finding needed: the ruler had
// to learn rotors exist, and the search had to be allowed to damp them.
function sweepAxis(profile, axis) {
	const budget = budgetFor(profile);
	const lim = limitsFor(profile, axis, budget);
	const micro = (profile.filterScale ?? 1) > 1.5;
	const pRange = axis === 'yaw'
		? (micro ? [0.04, 0.07, 0.11, 0.16, 0.24, 0.32] : [0.10, 0.14, 0.18, 0.22, 0.28, 0.34])
		: (micro ? [0.08, 0.11, 0.15, 0.20, 0.26, 0.32] : [0.030, 0.038, 0.046, 0.054, 0.062, 0.072, 0.084, 0.098]);
	const dRange = axis === 'yaw'
		? (micro ? [0, 0.0005, 0.0010, 0.0020, 0.0035, 0.0055, 0.0080] : [0, 0.0005, 0.0010, 0.0020])
		: [0.0003, 0.0005, 0.0007, 0.0010, 0.0014, 0.0019, 0.0026, 0.0035, 0.0047];

	// One regime or two. A tune that is excellent in a hover and rings at speed
	// is not a better tune, it is a tune measured in one place — so under
	// --cruise the cost a candidate is judged on is the WORST of the two
	// regimes, not the cruise one. Optimising for cruise alone would just move
	// the blind spot from one end of the envelope to the other.
	const costOf = (m) => Math.max(0, m.rise - lim.rise * 0.75)
		+ 4 * Math.max(0, m.overshoot - 6)
		+ 0.25 * Math.max(0, m.settle - lim.settle * 0.6)
		+ 0.5 * m.bounce;

	const results = [];
	for (const p of pRange) {
		for (const d of dRange) {
			const still = metrics(profile, axis, { [axis]: { p, d } }, false);
			const costStill = costOf(still);
			if (!CRUISE) {
				results.push({ p, d, ...still, costStill, costCruise: null, cost: costStill });
				continue;
			}
			const fast = metrics(profile, axis, { [axis]: { p, d } }, true);
			const costCruise = costOf(fast);
			// The reported metrics stay the still-air ones, so the table reads
			// against every table this bench has ever printed; the two costs say
			// what the extra regime found.
			results.push({ p, d, ...still, costStill, costCruise, cost: Math.max(costStill, costCruise) });
		}
	}
	results.sort((a, b) => a.cost - b.cost);
	// Prefer the lower P — but only among
	// tunes that are genuinely well-behaved (bounded overshoot and settle) and
	// within a hair of the best cost. Without the quality gate the low-P
	// preference will happily pick a fragile corner that "won" a flat cost
	// landscape by a rounding error.
	const minCost = results[0].cost;
	// The gate that PREFERS a candidate is the same gate report() JUDGES it by.
	// It used to be looser — overshoot 10, settle 1.15 * the limit, rise 1.05 —
	// and a looser preference gate is a machine for choosing tunes the report
	// then flags. Measured on cinewhoop roll: the grid held P=0.098 D=0.0019 at
	// rise 78 / settle 138 / overshoot 5.2, inside every limit, and the sweep
	// preferred P=0.054 at rise 86 against an 83 ms limit because it cost 1.7
	// units less and the 5 % slack let it through. The tiered fallback below is
	// what handles a grid that holds nothing strictly inside.
	const wellBehaved = (r) => r.overshoot <= lim.overshoot && r.settle <= lim.settle && r.rise <= lim.rise
		&& r.bounce <= lim.bounce;
	const clean = results.filter((r) => r.cost <= minCost + 0.5 && wellBehaved(r));
	// When nothing is both cheapest AND well-behaved, take the cheapest that is
	// at least well-behaved, and only fall back to the raw winner when the grid
	// holds nothing well-behaved at all. Dropping straight to results[0] here
	// was how the two-regime cost handed longrange a pitch tune that overshot
	// 11.6 % and rang for 138 ms: a cost can be lowest and still describe a
	// tune nobody would fly.
	const decent = results.filter(wellBehaved);
	const pool = clean.length ? clean : (decent.length ? [decent[0]] : [results[0]]);
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
		const l = limitsFor(profile, axis, budgetFor(profile));
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

// Which names the CLI will answer to for ONE profile. `FAMILIES` is the roster
// the menu offers and the default report walks; `PROFILES` also holds swarmNode,
// which flies in the game and which the tuner could not name at all — so its
// tune was never reported and never swept, and the "N combinations outside"
// count silently did not cover it. Naming it explicitly is allowed; the default
// walk and `--write all` still take the roster, because that is the roster.
const TUNABLE = Object.keys(PROFILES);

const argv = process.argv.slice(2);
CRUISE = argv.includes('--cruise');
if (CRUISE) {
	console.log('--cruise: the bench flies forward at each family\'s own settling speed');
}

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
	const rest = argv.filter((a) => a !== '--sweep' && a !== '--cruise');
	const axis = AXES.includes(rest[0]) ? rest[0] : 'roll';
	const family = rest.find((a) => TUNABLE.includes(a)) ?? DEFAULT_FAMILY;
	const profile = PROFILES[family];
	const { results } = sweepAxis(profile, axis);
	console.log(`\nsweep "${axis}" on ${family} — current is P=${profile.pid[axis].p} D=${profile.pid[axis].d}`);
	console.log(`  P       D        rise   over   settle  bounce   cost${CRUISE ? '    (still / cruise)' : ''}`);
	for (const r of results.slice(0, 10)) {
		const both = CRUISE ? `   ${r.costStill.toFixed(1)} / ${r.costCruise.toFixed(1)}` : '';
		console.log(`  ${r.p.toFixed(3)}  ${r.d.toFixed(4)}  ${r.rise.toFixed(0).padStart(4)}ms ${r.overshoot.toFixed(1).padStart(5)}% ${r.settle.toFixed(0).padStart(5)}ms ${r.bounce.toFixed(0).padStart(5)}  ${r.cost.toFixed(1).padStart(6)}${both}`);
	}
	console.log(`\nrun \`node tools/tune-pid.mjs --write ${family}\` to sweep every axis and write the block.`);
} else {
	const only = argv.find((a) => TUNABLE.includes(a));
	const fams = only ? [only] : FAMILIES;
	let bad = 0;
	for (const f of fams) bad += report(PROFILES[f]);
	for (const f of fams) { kickTest(PROFILES[f]); airmodeTest(PROFILES[f]); }
	console.log(`\n${bad === 0 ? 'every axis inside the targets' : `${bad} axis/family combination(s) outside the targets`}`);
	process.exit(bad === 0 ? 0 : 1);
}

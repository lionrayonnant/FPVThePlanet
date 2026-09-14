import { mixOf, kThrustOf, gravityTrimFactor, omegaForThrust } from './quad.js';
import { motorConstants, dutyForOmega } from './motor.js';
import { DEFAULT_PROFILE } from './drone-profiles.js';
import { rateFor, actualRateDeg, maxRateDeg } from './rates.js';
import { throttleChain, DEFAULT_THROTTLE } from './throttle.js';
import { Gyro, AxisFilter, LoopDelay } from './gyro.js';

// Betaflight-shaped flight controller. The interface is
//
//   update(sticks, state, dt) -> { motors: [m1..m4], throttle, axes }
//
// which is deliberately the shape a real Betaflight SITL bridge speaks: SITL
// hands back four motor outputs, not a thrust and a torque. Everything below
// this line is rates, PID, filtering and mixing — nothing about the airframe,
// which lives in quad.js.
//
// Body axes follow three.js: X = right, Y = up, Z = back (forward is -Z), so
//   pitch up = +omega.x     yaw left = +omega.y     roll left = +omega.z
// and for the world-up vector seen from the body:
//   sin(pitch) = -upBody.z      sin(roll) = -upBody.x

const DEG = Math.PI / 180;
const GRAVITY = 9.81;

export const MODES = ['acro', 'angle', 'altitude'];

// Every preset here is in the ACTUAL family — { centre, max, expo }. src/rates.js
// carries the spec's five other families, parameterised { rcRate, superRate,
// expo }; an axis entry that names a `type` is dispatched there instead. Nothing
// in this table does yet, deliberately: switching a preset's family is a change
// of feel.
//
// Betaflight "Actual Rates": centre sensitivity sets the slope around centre,
// max rate sets the stops, expo bends the curve between them. Unlike the old
// single-exponent curve, these two are independent, which is the whole reason
// the rate system was reworked upstream — you can have a calm centre and a
// violent full stick at the same time.
export const RATE_PRESETS = {
	cinematic: {
		label: 'cinematic',
		roll:  { centre: 120, max: 380, expo: 0.40 },
		pitch: { centre: 120, max: 380, expo: 0.40 },
		yaw:   { centre: 110, max: 300, expo: 0.40 },
	},
	freestyle: {
		label: 'freestyle',
		roll:  { centre: 200, max: 820, expo: 0.55 },
		pitch: { centre: 200, max: 820, expo: 0.55 },
		yaw:   { centre: 180, max: 600, expo: 0.50 },
	},
	race: {
		label: 'race',
		roll:  { centre: 280, max: 1100, expo: 0.62 },
		pitch: { centre: 280, max: 1100, expo: 0.62 },
		yaw:   { centre: 250, max: 780, expo: 0.55 },
	},
	// PHASE 07: baseline rates for two of the seven families. Long range is
	// flown on deliberately calm rates — you are cruising, not throwing tricks.
	longrange: {
		label: 'long range',
		roll:  { centre: 90, max: 360, expo: 0.35 },
		pitch: { centre: 90, max: 360, expo: 0.35 },
		yaw:   { centre: 90, max: 260, expo: 0.35 },
	},
	// Micro builds (whoop, toothpick) fly a moderate rate — quick to react but
	// nowhere near a 5" freestyle quad's throw, and the fixed filter chain in
	// this controller is a 5"-centric assumption that a much faster airframe
	// cannot chase to a higher number anyway.
	micro: {
		label: 'micro',
		roll:  { centre: 120, max: 420, expo: 0.50 },
		pitch: { centre: 120, max: 420, expo: 0.50 },
		yaw:   { centre: 90, max: 240, expo: 0.45 },
	},
};

// Integral time constant. I exists to trim out a bent arm, a heavy battery
// strap or a steady crosswind — things that last seconds. Tying Ki to Kp
// through one time constant keeps it there: at 0.35 s it is far slower than the
// rate loop, so it cannot contribute to a flick. Setting Ki independently is
// what produced 56% overshoot on the bench before this was worked out; I was
// reaching its clamp inside 50 ms and simply adding a bias to every step.
export const I_TIME = 0.35;     // s

// The inertia each rate axis fights: roll about body Z, pitch about X, yaw about
// Y (three.js body frame).
const AXIS_INERTIA = { roll: 'z', pitch: 'x', yaw: 'y' };

// Turn a family's measured tune (src/drone-profiles.js `pid`, written by
// tools/tune-pid.mjs) into live gains in normalised mixer units per rad/s.
//   P, D  — swept against that family's real inertia and motor lag.
//   I     — tied to P through I_TIME, never set on its own.
//   F     — not swept: feedforward has a correct value, the mix that produces
//           exactly the angular acceleration the stick asks for, I * d(rate)/dt.
//           torquePerMix is the local "one mixer unit -> this much torque near a
//           hover" slope, also measured off quad.js by tools/tune-pid.mjs.
export function buildGains(profile = DEFAULT_PROFILE) {
	const pid = profile.pid;
	const out = {};
	for (const axis of ['roll', 'pitch', 'yaw']) {
		const I = profile.inertia[AXIS_INERTIA[axis]];
		out[axis] = {
			p: pid[axis].p,
			i: pid[axis].p / I_TIME,
			d: pid[axis].d,
			f: I / pid.torquePerMix[axis],
		};
	}
	return out;
}

// Kept as a module export for callers that only ever want the default airframe.
export const PID = buildGains(DEFAULT_PROFILE);

const I_LIMIT = 0.35;           // mixer units of authority I may claim

// Rewrites one axis' gains in place, keeping Ki tied to Kp. Used by the sweep in
// tools/tune-pid.mjs, which holds a live controller and its gains object.
export function setGains(gains, axis, { p, d, f }) {
	const g = gains[axis];
	if (p !== undefined) { g.p = p; g.i = p / I_TIME; }
	if (d !== undefined) g.d = d;
	if (f !== undefined) g.f = f;
}
const F_LIMIT = 0.9;            // and the ceiling on a single feedforward spike

// Throttle PID attenuation: props unload at high throttle and the same gains
// start to ring, so Betaflight backs P and D off above a breakpoint.
const TPA_BREAK = 0.35, TPA_FACTOR = 0.55;

// I-term relax. While the stick is going somewhere, the rate error is mostly
// "the quad has not got there yet", not a disturbance, and integrating it just
// buys bounce-back at the end of a flick. Betaflight measures that with a
// high-pass of the setpoint — the setpoint minus its own slow average — which
// stays non-zero for the whole manoeuvre rather than only at the instant the
// stick moves. Doing it on the slew instead let I wind up 15% of overshoot back
// in as soon as the stick stopped moving; the bench catches that.
const RELAX_CUTOFF = 15;        // Hz, the "slow average" of the setpoint
const RELAX_THRESHOLD = 40 * DEG;  // rad/s of high-passed setpoint that fully stops I

const GYRO_CUTOFF = 90;         // Hz, PT1
const DTERM_CUTOFF = 55;        // Hz, PT1 — D is the noisy one
const FF_CUTOFF = 30;           // Hz, PT1 on the feedforward

// RC smoothing. A real radio link delivers 250-500 discrete frames a second and
// Betaflight runs a low-pass over the setpoint before the PID ever sees it,
// because a step change in setpoint asks the feedforward for infinite torque.
// Three cascaded poles at 30 Hz is close to the stock PT3 and it is the single
// thing that separates "flicks overshoot 45%" from "flicks land on the number".
const RC_SMOOTHING = 40;        // Hz

// ---------------------------------------------------------------------------
// The three Betaflight mechanisms this loop was missing, and why all three
// ship INERT.
//
// gyroNoise and loopDelay are profile fields and both are 0 on every family
// (src/drone-profiles.js). The two constants below are the same decision for
// two things that have no profile field and must not grow one: a lot does not
// get to invent profile schema on its way past. They are written here at the
// value that changes nothing, with the value the bench measured beside them,
// so turning them on is one edit and not one search.
//
// The reason they are off is not caution about the code, it is caution about
// the tune: src/drone-profiles.js's PID blocks were swept by
// tools/tune-pid.mjs against a loop with no noise, no latency, no anti-gravity
// and a fixed D. Every one of these four moves the plant that sweep was run
// against. They go on together with a re-sweep, not one at a time on a whim.

// Anti-gravity. Punch the throttle and a quad drops its nose: the motors take
// milliseconds to reach the new rpm and the I term, which was holding the
// trim, is suddenly holding the wrong one. Betaflight answers by boosting I
// (and a fraction of P) for exactly as long as the throttle is moving, which
// is what the high-pass below measures.
//   0    = off, the loop as tuned, and what ships.
//   3.5  = measured by `node tools/loop-rate-bench.mjs --antigravity`: on a
//          freestyle5 with a 5 mm CoG offset, punching the throttle from 0.25
//          to 0.95 gives away 10.13 deg of pitch at gain 0, 8.95 deg at 3.5
//          (-12 %) and 8.24 deg at 6.0 (-19 %). It costs nothing at a steady
//          stick: the high-pass below reads zero and agBoost is exactly 1.
//          This is the one of the four that is a pure win, and it is off only
//          because it moves the plant tools/tune-pid.mjs swept against.
export const ANTI_GRAVITY_GAIN = 0;
const ANTI_GRAVITY_P_FRACTION = 0.35;   // how much of the I boost P also takes
const ANTI_GRAVITY_CUTOFF = 5;          // Hz, the "slow average" of the throttle

// D-max. D is the term that amplifies gyro noise, so a tune picks a D that is
// quiet at rest and is then short of D exactly where D is wanted — in a fast
// flick. Betaflight lets D rise toward a maximum when the gyro or the setpoint
// is actually moving, and fall back when it is not.
//   1.0  = off, D is the swept value at all times. This is what ships, and
//          unlike the other three it is what the bench RECOMMENDS.
//
// `node tools/loop-rate-bench.mjs --dmax` measured it and the answer was no:
// on freestyle5 at 1 kHz with gyroNoise 0.08, going from 1.0 to 1.6 slows the
// flick from 70 to 98 ms, leaves 7.3 % of rate 100 ms after the stick centres
// instead of 5.1 %, and does not move the resting motor ripple at all
// (1.03e-2 either way). That is not a surprise once stated plainly: D-max
// buys a LOWER resting D, and the resting D here is already the value
// tools/tune-pid.mjs chose against a silent gyro. The mechanism only pays
// once that sweep is re-run with the noise on and comes back with a smaller
// D. Until then raising this is a pure loss, measured.
export const D_MAX_RATIO = 1.0;
const D_MAX_SLEW_FULL = 900 * DEG;   // rad/s/s of setpoint slew that reaches D_MAX
const D_MAX_CUTOFF = 12;             // Hz, PT1 on the boost so D does not chatter

const MOTOR_IDLE = 0.055;       // Betaflight dynamic idle: props never stop, or
                                // there is nothing to recover from

// Exported (with actualRate below) because tools/geofence-measure.mjs needs to
// speak this controller's own language: its synthetic ACRO pilot aims for the
// steepest attitude self-levelling will hold and returns to the horizon at the
// rate angle mode would ask for. Copying those three into the bench would turn
// them into numbers that drift apart in silence.
export const ANGLE_MAX_TILT = 42 * DEG;
export const ANGLE_STRENGTH = 9.0;   // rad/s of rate demand per rad of angle error
const ALT_KP = 3.2, ALT_KD = 3.6;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
// clamp() alone cannot hold a boundary: every comparison against NaN is false,
// so a NaN walks through it untouched. Anything read from outside this module
// goes through here first.
const finiteOr = (v, fallback) => (Number.isFinite(v) ? v : fallback);

// First-order lowpass, the PT1 Betaflight uses everywhere.
class PT1 {
	constructor(hz) { this.k = 0; this.hz = hz; this.y = 0; this.primed = false; }
	step(x, dt) {
		if (!this.primed) { this.y = x; this.primed = true; return x; }
		const rc = 1 / (2 * Math.PI * this.hz);
		this.y += (x - this.y) * (dt / (rc + dt));
		return this.y;
	}
	reset(v = 0) { this.y = v; this.primed = false; }
}

class AxisPid {
	// filterScale raises every delay-adding cutoff (gyro, D-term, feedforward, RC
	// smoothing) for airframes whose rotational dynamics are much faster than the
	// 5" this chain was set for. A real FC does the same: micro builds run the
	// filters two to four times higher. 1 == the reference 5" chain, untouched.
	// `conditioned` turns on the gyro conditioning chain (RPM notches + dynamic
	// notch, src/gyro.js). It is null unless the airframe has gyroNoise, and
	// that is not an optimisation: a notch on a noiseless signal removes
	// nothing and costs phase, so leaving it in would be a pure handicap. The
	// filters exist because the noise does.
	constructor(gains, filterScale = 1, conditioned = false, dMax = D_MAX_RATIO) {
		this.g = gains;
		this.i = 0;
		this.prevGyro = 0;
		this.prevSetpoint = 0;
		this.setpoint = 0;
		this.gyroLpf = new PT1(GYRO_CUTOFF * filterScale);
		this.dLpf = new PT1(DTERM_CUTOFF * filterScale);
		this.ffLpf = new PT1(FF_CUTOFF * filterScale);
		const rc = RC_SMOOTHING * filterScale;
		this.rcLpf = [new PT1(rc), new PT1(rc), new PT1(rc)];
		this.relaxLpf = new PT1(RELAX_CUTOFF);
		this.notches = conditioned ? new AxisFilter() : null;
		this.dMax = dMax;
		this.dMaxLpf = dMax > 1 ? new PT1(D_MAX_CUTOFF) : null;
		this.first = true;
	}

	reset() {
		this.i = 0;
		this.first = true;
		this.gyroLpf.reset(); this.dLpf.reset(); this.ffLpf.reset();
		for (const f of this.rcLpf) f.reset();
		this.relaxLpf.reset();
		if (this.notches) this.notches.reset();
		if (this.dMaxLpf) this.dMaxLpf.reset();
	}

	// `agBoost` is anti-gravity, 1 when the throttle is steady. `rotorOmega` is
	// the four shaft speeds the RPM notches follow, or null.
	step(rawSetpoint, gyroRaw, dt, tpa, agBoost = 1, rotorOmega = null) {
		if (this.notches) gyroRaw = this.notches.step(gyroRaw, rotorOmega, dt);
		let setpoint = rawSetpoint;
		for (const f of this.rcLpf) setpoint = f.step(setpoint, dt);
		this.setpoint = setpoint;
		const gyro = this.gyroLpf.step(gyroRaw, dt);
		const error = setpoint - gyro;

		if (this.first) { this.prevGyro = gyro; this.prevSetpoint = setpoint; this.first = false; }

		const setpointSlew = (setpoint - this.prevSetpoint) / dt;

		// D on measurement, not on error: differentiating the setpoint would put
		// a spike on the motors every time the stick moves.
		const dGyro = this.dLpf.step(-(gyro - this.prevGyro) / dt, dt);
		const ff = clamp(this.ffLpf.step(setpointSlew, dt) * this.g.f, -F_LIMIT, F_LIMIT);

		const setpointHpf = Math.abs(setpoint - this.relaxLpf.step(setpoint, dt));
		const relax = clamp(1 - setpointHpf / RELAX_THRESHOLD, 0, 1);
		this.i = clamp(this.i + this.g.i * agBoost * error * dt * relax, -I_LIMIT, I_LIMIT);

		this.prevGyro = gyro;
		this.prevSetpoint = setpoint;

		// D-max: D rises toward D_MAX_RATIO while the stick is actually moving.
		// Driven by the setpoint slew rather than by |dGyro|, which is the half
		// of Betaflight's own measure that does NOT feed back on itself — a
		// boost driven by the D term it multiplies is a positive loop, and with
		// noise in the signal it is a positive loop on noise.
		let d = this.g.d;
		if (this.dMaxLpf) {
			const drive = clamp(Math.abs(setpointSlew) / D_MAX_SLEW_FULL, 0, 1);
			d *= 1 + (this.dMax - 1) * this.dMaxLpf.step(drive, dt);
		}
		const pBoost = 1 + (agBoost - 1) * ANTI_GRAVITY_P_FRACTION;
		const out = this.g.p * pBoost * error * tpa + this.i + d * dGyro * tpa + ff;
		// The filter chain is a set of running averages: feed it one NaN — a
		// stick from a broken calibration, a body state Rapier blew up on — and
		// `y += (x - y) * k` keeps it forever, so the motors stay NaN for the
		// rest of the session even after the input comes back. A real FC does
		// not survive its own sensors this way either: it resets. Costs one
		// isFinite per axis per step and never fires on a healthy frame.
		if (!Number.isFinite(out)) { this.reset(); return 0; }
		return out;
	}
}

// Betaflight's ACTUAL rates, in rad/s. The curve itself now lives in
// src/rates.js next to the spec's five families (§5); this is the rad/s
// boundary and the name tools/geofence-measure.mjs and tools/fuzz.mjs import.
// Same operations in the same order as before, so the last bit is unchanged.
export function actualRate(stick, r) {
	return actualRateDeg(stick, r) * DEG;
}

export class FlightController {
	// opts: { profile, preset, rates, mode }. A bare string is still accepted as
	// the preset for the default airframe, which is how the bench and older
	// callers use it. `rates` is a RATE_PRESETS-shaped table that overrides the
	// named preset: an individual target (PHASE 07, tools/target-build.mjs)
	// flies its owner's rates, which are that family's preset scaled, not a
	// preset.
	//
	// `mode` is the mode this machine STARTS in, acro unless a caller says
	// otherwise. It exists because a keyboard has no proportional stick: a tap
	// on an arrow key is an instant full-deflection command, which in acro is
	// 820 deg/s of roll and an unrecoverable tumble for anyone who has never
	// flown. main.js starts a keyboard-only pilot in angle for that reason, and
	// only main.js knows what is plugged in — the controller must not learn what
	// an input device is. An unknown value falls back to acro rather than
	// throwing: a bad mode is a bug elsewhere, and it must not stop a flight.
	constructor(opts = {}) {
		if (typeof opts === 'string') opts = { preset: opts };
		this.profile = opts.profile ?? DEFAULT_PROFILE;
		this.mode = MODES.includes(opts.mode) ? opts.mode : 'acro';
		// A family carries a baseline rates preset; an explicit preset wins.
		this.preset = opts.preset ?? this.profile.rates ?? 'freestyle';
		// The live table the rate setpoints are read from. Normally the named
		// preset; a target build hands over its own copy of it. Keeping the NAME
		// alongside the table is what lets the HUD and the OSD still say "race"
		// about a machine whose numbers are nobody else's.
		this.rates = opts.rates ?? RATE_PRESETS[this.preset];
		// Throttle travel shaping (§4.1, §6.2). DEFAULT_THROTTLE is inert.
		this.throttleCurve = opts.throttle ?? DEFAULT_THROTTLE;
		this.holdAltitude = null;
		this.gains = buildGains(this.profile);
		// filterScale only touches roll and pitch. Those loops are gyro-noise /
		// filter-delay limited, and a fast micro airframe needs them opened up.
		// Yaw is limited by how fast the motors can spin up and down to unbalance
		// prop-drag torque — opening its filters just lets the loop outrun the
		// motors and hunt, so yaw keeps the reference chain on every family.
		const fs = this.profile.filterScale ?? 1;
		// The sensor, the latency and the conditioning chain. All three are
		// driven by profile fields that are 0 on every family today, so all
		// three are inert: `gyro` short-circuits to the true body rates,
		// `loopDelay` returns the vector it was handed, and `conditioned` is
		// false so no notch is even constructed. See src/gyro.js.
		// Four overrides, all of them defaulting to the value that changes
		// nothing. They are constructor options and NOT new profile fields: a
		// lot does not get to invent profile schema on its way past, and the two
		// fields that do exist (gyroNoise, loopDelay) are read from the profile
		// here. The overrides are how tools/loop-rate-bench.mjs can price a
		// setting without editing src/, which is the only way a "measured, not
		// guessed" number ever gets measured.
		const noise = opts.gyroNoise ?? this.profile.gyroNoise ?? 0;
		this.gyro = new Gyro({ noise, seed: (opts.seed ?? 0x9e37) >>> 0 });
		this.loopDelay = new LoopDelay(opts.loopDelay ?? this.profile.loopDelay ?? 0);
		this.antiGravity = opts.antiGravity ?? ANTI_GRAVITY_GAIN;
		const dMax = opts.dMax ?? D_MAX_RATIO;
		// `filters` forces the conditioning chain on or off independently of the
		// noise. Left alone it follows the noise, which is the rule that matters:
		// a notch on a clean signal removes nothing and costs phase.
		const conditioned = opts.filters ?? noise > 0;
		this.pid = {
			roll: new AxisPid(this.gains.roll, fs, conditioned, dMax),
			pitch: new AxisPid(this.gains.pitch, fs, conditioned, dMax),
			yaw: new AxisPid(this.gains.yaw, 1, conditioned, dMax),
		};
		this.agLpf = new PT1(ANTI_GRAVITY_CUTOFF);
		this._mix = mixOf(this.profile);
		this.motors = [0, 0, 0, 0];
		this.axes = { roll: 0, pitch: 0, yaw: 0 };
		this.armed = true;
	}

	// Betaflight disarm (PHASE 06). Cuts the motors — the mixer already zeroes
	// everything when `!armed`. Nothing here knows what a session is. Since
	// landing disappeared (D9, 2026-09-08) the pilot has no gesture that calls
	// this: only main.js does, when the machine is lost.
	disarm() { this.armed = false; }

	arm() { this.armed = true; }

	setMode(mode) {
		this.mode = mode;
		this.holdAltitude = null;
		this.reset();
	}

	cycleMode() {
		this.setMode(MODES[(MODES.indexOf(this.mode) + 1) % MODES.length]);
		return this.mode;
	}

	setPreset(name) {
		// Cycling presets by hand drops the target's own rates: an explicit choice
		// wins over the build.
		if (RATE_PRESETS[name]) { this.preset = name; this.rates = RATE_PRESETS[name]; }
		return this.preset;
	}

	cyclePreset() {
		const keys = Object.keys(RATE_PRESETS);
		return this.setPreset(keys[(keys.indexOf(this.preset) + 1) % keys.length]);
	}

	reset() {
		for (const p of Object.values(this.pid)) p.reset();
		this.gyro.reset();
		this.loopDelay.reset();
		this.agLpf.reset();
		this.holdAltitude = null;
	}

	// sticks: {throttle 0..1, roll/pitch/yaw -1..1}
	// state:  {rotation, angularVelocity, position, velocity}, world frame
	update(rawSticks, state, dt) {
		// The contract above is enforced here rather than assumed: input.js
		// reads a gamepad and a calibration file, and neither is guaranteed to
		// hand over a number in range.
		const sticks = {
			throttle: clamp(finiteOr(rawSticks?.throttle, 0), 0, 1),
			roll: clamp(finiteOr(rawSticks?.roll, 0), -1, 1),
			pitch: clamp(finiteOr(rawSticks?.pitch, 0), -1, 1),
			yaw: clamp(finiteOr(rawSticks?.yaw, 0), -1, 1),
		};
		const q = state.rotation;
		const rates = this.rates;

		// Rate setpoints, in the body frame and in the sign convention above.
		// rateFor() dispatches on the shape of the axis entry: today's
		// { centre, max, expo } is ACTUAL, a { type, rcRate, superRate, expo }
		// is one of the spec's five families (§5). It returns deg/s, which is
		// what §5 specifies; this `* DEG` is the one place on this path where
		// the repo's rad/s convention is entered.
		let sp = {
			x: rateFor(sticks.pitch, rates.pitch) * DEG,
			y: rateFor(-sticks.yaw, rates.yaw) * DEG,
			z: rateFor(-sticks.roll, rates.roll) * DEG,
		};

		if (this.mode !== 'acro') {
			// Self-levelling feeds the same rate loop rather than adding a second
			// controller underneath it, so angle mode and acro share one tune.
			const upB = unrotate(q, 0, 1, 0);
			const wantPitch = Math.sin(sticks.pitch * ANGLE_MAX_TILT);
			const wantRoll = Math.sin(sticks.roll * ANGLE_MAX_TILT);
			// maxRateDeg() is `max` for an ACTUAL axis and the measured
			// full-stick rate for a spec family, which has no such field.
			const maxPitch = maxRateDeg(rates.pitch) * DEG;
			const maxRoll = maxRateDeg(rates.roll) * DEG;
			sp.x = clamp(ANGLE_STRENGTH * (wantPitch + upB.z), -maxPitch, maxPitch);
			sp.z = clamp(-ANGLE_STRENGTH * (wantRoll + upB.x), -maxRoll, maxRoll);
		}

		// Throttle chain, §4.1 + §6.2 (src/throttle.js). The default config is
		// the identity, so nothing moves until a lot turns the bands, the
		// MinThrottle floor or the shape curve on. Altitude hold below solves
		// for its own throttle and reads the RAW stick as its climb demand, so
		// the chain deliberately does not sit in front of it.
		let throttle = throttleChain(sticks.throttle, this.throttleCurve);
		if (this.mode === 'altitude') {
			// The held altitude is the one piece of state here that outlives a
			// frame, so it is the one that must never take a NaN: a single
			// non-finite position would otherwise hold the throttle at NaN for
			// the rest of the flight, long after the body state recovered.
			const y = finiteOr(state.position?.y, this.holdAltitude ?? 0);
			const vy = finiteOr(state.velocity?.y, 0);
			const demand = (sticks.throttle - 0.5) * 2;
			// The pack's real voltage, not its nominal one: the stick that holds
			// a hover climbs as the pack drains, and solving at 4.2 V a cell
			// would under-command by exactly the sag.
			const volts = finiteOr(state.battery?.voltage, this.profile.battery.cells * 4.2);
			const hover = hoverThrottle(this.profile, q, volts);
			if (Math.abs(demand) > 0.08 || this.holdAltitude === null) {
				this.holdAltitude = y;
				throttle = hover + demand * 0.35;
			} else {
				const a = ALT_KP * (this.holdAltitude - y) - ALT_KD * vy;
				throttle = hover * (1 + a / GRAVITY);
			}
			// hoverThrottle() reads the attitude, which can be NaN on its own.
			throttle = clamp(finiteOr(throttle, 0), 0, 1);
		}

		const w = state.angularVelocity;
		// The true body rates, and then what the gyro makes of them. With
		// gyroNoise 0 and loopDelay 0 both calls hand `wBody` straight back —
		// the same object, the same doubles.
		const wTrue = unrotate(q, w.x, w.y, w.z);
		// Four shaft speeds in rad/s, straight off Propulsion, or null. The RPM
		// notches follow them; a caller with no Propulsion (the headless benches
		// in tools/) simply has no RPM telemetry, which is a configuration a
		// real machine also flies in.
		const rotorOmega = state.rotorOmega ?? null;
		const wBody = this.loopDelay.step(this.gyro.sample(wTrue, rotorOmega, dt), dt);

		const tpa = 1 - TPA_FACTOR * clamp((throttle - TPA_BREAK) / (1 - TPA_BREAK), 0, 1);

		// Anti-gravity: how hard the throttle is moving right now, measured as
		// the throttle minus its own slow average — the same high-pass shape
		// I-term relax uses on the setpoint, and for the same reason. It stays
		// non-zero for the whole punch rather than for the instant the stick
		// moved.
		const agBoost = this.antiGravity > 0
			? 1 + this.antiGravity * Math.abs(throttle - this.agLpf.step(throttle, dt))
			: 1;

		const pitch = this.pid.pitch.step(sp.x, wBody.x, dt, tpa, agBoost, rotorOmega);
		const yaw = this.pid.yaw.step(sp.y, wBody.y, dt, tpa, agBoost, rotorOmega);
		const roll = this.pid.roll.step(sp.z, wBody.z, dt, tpa, agBoost, rotorOmega);
		this.axes = { roll, pitch, yaw };

		return { motors: this.mix(roll, pitch, yaw, throttle), throttle, axes: this.axes };
	}

	// Airmode mixer. Two things happen here that a naive `throttle + mix` misses,
	// and both are what make a quad flyable at zero throttle:
	//   1. if the axes together demand more range than the motors have, the whole
	//      mix is scaled down rather than clipped — clipping one motor would
	//      silently rotate the demanded torque axis;
	//   2. throttle is then slid to whatever keeps the scaled mix inside range,
	//      so attitude authority survives at any stick position.
	mix(roll, pitch, yaw, throttle) {
		// Altitude hold reads state.position/velocity, so a blown-up body state
		// reaches the mixer as a NaN throttle. Nothing below can recover from
		// that — clamp() lets NaN straight through — so it stops here.
		throttle = finiteOr(throttle, MOTOR_IDLE);
		const raw = this._mix.map((m) => roll * m.roll + pitch * m.pitch + yaw * m.yaw);
		let lo = Infinity, hi = -Infinity;
		for (const v of raw) { if (v < lo) lo = v; if (v > hi) hi = v; }

		const span = hi - lo;
		const room = 1 - MOTOR_IDLE;
		const scale = span > room ? room / span : 1;

		const centre = clamp(throttle, MOTOR_IDLE - lo * scale, 1 - hi * scale);
		for (let i = 0; i < 4; i++) {
			this.motors[i] = clamp(centre + raw[i] * scale, MOTOR_IDLE, 1);
		}
		if (!this.armed) this.motors.fill(0);
		return this.motors;
	}
}

// Throttle that cancels gravity at the current tilt, inverted through the
// thrust curve so it lands on the right stick position instead of assuming
// thrust is linear in throttle.
export function hoverThrottle(profile, q, volts = profile.battery.cells * 4.2) {
	const up = rotate(q, 0, 1, 0);
	// The weight to cancel is the TRIMMED weight (src/quad.js, §8.1): the trim is
	// a real world -Y force on the body, so solving for `mass * g` alone
	// under-commands by exactly the trim and an altitude hold sinks. Evaluated at
	// zero vertical speed, which is what a hover is.
	const need = (profile.mass * GRAVITY * gravityTrimFactor(profile, 0)) / Math.max(0.35, up.y);
	const perMotor = clamp(need / 4, 0, profile.maxThrustPerMotor);
	// Thrust -> rpm through the prop, rpm -> stick through the motor's own
	// torque balance (src/motor.js). This used to invert `cmd^(2*rpmCurve)`,
	// which stopped being the right curve when rpm stopped being a power law --
	// and then stopped being a closed form at all when the prop-loss factor made
	// thrust more than proportional to rpm squared. omegaForThrust() is that
	// inversion, in quad.js beside the forward law it undoes.
	const omega = omegaForThrust(profile, perMotor);
	return dutyForOmega(motorConstants(profile), omega, volts);
}

function rotate(q, x, y, z) {
	const tx = 2 * (q.y * z - q.z * y);
	const ty = 2 * (q.z * x - q.x * z);
	const tz = 2 * (q.x * y - q.y * x);
	return {
		x: x + q.w * tx + (q.y * tz - q.z * ty),
		y: y + q.w * ty + (q.z * tx - q.x * tz),
		z: z + q.w * tz + (q.x * ty - q.y * tx),
	};
}
function unrotate(q, x, y, z) {
	return rotate({ x: -q.x, y: -q.y, z: -q.z, w: q.w }, x, y, z);
}
export { rotate as rotateVec, unrotate as unrotateVec };

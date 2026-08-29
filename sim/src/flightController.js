import { mixOf } from './quad.js';
import { DEFAULT_PROFILE } from './drone-profiles.js';

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

// Betaflight "Actual Rates": centre sensitivity sets the slope around centre,
// max rate sets the stops, expo bends the curve between them. Unlike the old
// single-exponent curve, these two are independent, which is the whole reason
// the rate system was reworked upstream — you can have a calm centre and a
// violent full stick at the same time.
export const RATE_PRESETS = {
	cinematic: {
		label: 'cinéma',
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

const MOTOR_IDLE = 0.055;       // Betaflight dynamic idle: props never stop, or
                                // there is nothing to recover from

const ANGLE_MAX_TILT = 42 * DEG;
const ANGLE_STRENGTH = 9.0;     // rad/s of rate demand per rad of angle error
const ALT_KP = 3.2, ALT_KD = 3.6;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

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
	constructor(gains, filterScale = 1) {
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
		this.first = true;
	}

	reset() {
		this.i = 0;
		this.first = true;
		this.gyroLpf.reset(); this.dLpf.reset(); this.ffLpf.reset();
		for (const f of this.rcLpf) f.reset();
		this.relaxLpf.reset();
	}

	step(rawSetpoint, gyroRaw, dt, tpa) {
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
		this.i = clamp(this.i + this.g.i * error * dt * relax, -I_LIMIT, I_LIMIT);

		this.prevGyro = gyro;
		this.prevSetpoint = setpoint;

		return this.g.p * error * tpa + this.i + this.g.d * dGyro * tpa + ff;
	}
}

function actualRate(stick, r) {
	// Betaflight's ACTUAL rates, verbatim in shape.
	const rc = clamp(stick, -1, 1);
	const a = Math.abs(rc);
	const expof = r.expo * (a ** 3) + a * (1 - r.expo);
	const stickMovement = Math.max(0, r.max - r.centre);
	return Math.sign(rc) * (a * r.centre + stickMovement * expof) * DEG;
}

export class FlightController {
	// opts: { profile, preset }. A bare string is still accepted as the preset
	// for the default airframe, which is how the bench and older callers use it.
	constructor(opts = {}) {
		if (typeof opts === 'string') opts = { preset: opts };
		this.profile = opts.profile ?? DEFAULT_PROFILE;
		this.mode = 'acro';
		// A family carries a baseline rates preset; an explicit preset wins.
		this.preset = opts.preset ?? this.profile.rates ?? 'freestyle';
		this.holdAltitude = null;
		this.gains = buildGains(this.profile);
		// filterScale only touches roll and pitch. Those loops are gyro-noise /
		// filter-delay limited, and a fast micro airframe needs them opened up.
		// Yaw is limited by how fast the motors can spin up and down to unbalance
		// prop-drag torque — opening its filters just lets the loop outrun the
		// motors and hunt, so yaw keeps the reference chain on every family.
		const fs = this.profile.filterScale ?? 1;
		this.pid = {
			roll: new AxisPid(this.gains.roll, fs),
			pitch: new AxisPid(this.gains.pitch, fs),
			yaw: new AxisPid(this.gains.yaw, 1),
		};
		this._mix = mixOf(this.profile);
		this.motors = [0, 0, 0, 0];
		this.axes = { roll: 0, pitch: 0, yaw: 0 };
		this.armed = true;
	}

	// Désarmement Betaflight (PHASE 06). Coupe les moteurs — le mixer met déjà
	// tout à zéro quand `!armed`. Rien ne sait ici ce qu'est une session : c'est
	// main.js qui, après ça, regarde si le drone est posé (→ LANDED) ou en l'air
	// (→ chute → impact → CRASHED).
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
		if (RATE_PRESETS[name]) this.preset = name;
		return this.preset;
	}

	cyclePreset() {
		const keys = Object.keys(RATE_PRESETS);
		return this.setPreset(keys[(keys.indexOf(this.preset) + 1) % keys.length]);
	}

	reset() {
		for (const p of Object.values(this.pid)) p.reset();
		this.holdAltitude = null;
	}

	// sticks: {throttle 0..1, roll/pitch/yaw -1..1}
	// state:  {rotation, angularVelocity, position, velocity}, world frame
	update(sticks, state, dt) {
		const q = state.rotation;
		const rates = RATE_PRESETS[this.preset];

		// Rate setpoints, in the body frame and in the sign convention above.
		let sp = {
			x: actualRate(sticks.pitch, rates.pitch),
			y: actualRate(-sticks.yaw, rates.yaw),
			z: actualRate(-sticks.roll, rates.roll),
		};

		if (this.mode !== 'acro') {
			// Self-levelling feeds the same rate loop rather than adding a second
			// controller underneath it, so angle mode and acro share one tune.
			const upB = unrotate(q, 0, 1, 0);
			const wantPitch = Math.sin(sticks.pitch * ANGLE_MAX_TILT);
			const wantRoll = Math.sin(sticks.roll * ANGLE_MAX_TILT);
			sp.x = clamp(ANGLE_STRENGTH * (wantPitch + upB.z), -rates.pitch.max * DEG, rates.pitch.max * DEG);
			sp.z = clamp(-ANGLE_STRENGTH * (wantRoll + upB.x), -rates.roll.max * DEG, rates.roll.max * DEG);
		}

		let throttle = sticks.throttle;
		if (this.mode === 'altitude') {
			const demand = (sticks.throttle - 0.5) * 2;
			if (Math.abs(demand) > 0.08 || this.holdAltitude === null) {
				this.holdAltitude = state.position.y;
				throttle = hoverThrottle(this.profile, q) + demand * 0.35;
			} else {
				const a = ALT_KP * (this.holdAltitude - state.position.y) - ALT_KD * state.velocity.y;
				throttle = hoverThrottle(this.profile, q) * (1 + a / GRAVITY);
			}
			throttle = clamp(throttle, 0, 1);
		}

		const w = state.angularVelocity;
		const wBody = unrotate(q, w.x, w.y, w.z);

		const tpa = 1 - TPA_FACTOR * clamp((throttle - TPA_BREAK) / (1 - TPA_BREAK), 0, 1);

		const pitch = this.pid.pitch.step(sp.x, wBody.x, dt, tpa);
		const yaw = this.pid.yaw.step(sp.y, wBody.y, dt, tpa);
		const roll = this.pid.roll.step(sp.z, wBody.z, dt, tpa);
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
export function hoverThrottle(profile, q) {
	const up = rotate(q, 0, 1, 0);
	const need = (profile.mass * GRAVITY) / Math.max(0.35, up.y);
	const fraction = clamp(need / (4 * profile.maxThrustPerMotor), 0, 1);
	// T/Tmax = cmd^(2*rpmCurve)  =>  cmd = (T/Tmax)^(1/(2*rpmCurve))
	return fraction ** (1 / (2 * profile.rpmCurve));
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

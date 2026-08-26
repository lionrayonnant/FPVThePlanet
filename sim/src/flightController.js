import { DRONE, MAX_THRUST, rotateVec, unrotateVec } from './physics.js';

// Deliberately narrow interface: update(sticks, state) -> {thrust, torque}.
// Everything Betaflight-shaped lives behind it, so a SITL bridge could replace
// this file without touching the rest of the sim.
//
// Body axes follow three.js: X = right, Y = up, Z = back (forward is -Z).
// Working through the rotations that gives:
//   pitch up    = +omega.x        roll right = -omega.z        yaw right = -omega.y
// and for the world-up vector seen from the body frame:
//   sin(pitch)  = -worldUpInBody.z    sin(roll) = -worldUpInBody.x

const DEG = Math.PI / 180;
const GRAVITY = 9.81;

// Moment of inertia of the collision sphere, which is what Rapier integrates.
const INERTIA = 0.4 * DRONE.mass * DRONE.radius * DRONE.radius;

const RATES = { roll: 800 * DEG, pitch: 800 * DEG, yaw: 500 * DEG };
const EXPO = 0.3;
const TAU = 0.03;               // rate-loop time constant, stands in for PID+motors
const KP = INERTIA / TAU;
const MAX_TORQUE = 0.5;         // N*m, roughly what a 5" quad can produce
const IDLE_THROTTLE = 0.05;     // air mode: keep authority at zero stick

const ANGLE_MAX_TILT = 35 * DEG;
const ANGLE_KP = 12.0;          // rad/s of rate demand per unit of sin(angle) error
const ALT_KP = 3.0, ALT_KD = 3.0;

export const MODES = ['acro', 'angle', 'altitude'];

// Betaflight-style expo: fine control near centre, full rate at the stops.
function applyExpo(x, maxRate) {
	const a = Math.abs(x);
	return Math.sign(x) * maxRate * (EXPO * a * a * a + (1 - EXPO) * a);
}

function clampMagnitude(v, limit) {
	const m = Math.hypot(v.x, v.y, v.z);
	if (m <= limit || m === 0) return v;
	const s = limit / m;
	return { x: v.x * s, y: v.y * s, z: v.z * s };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export class FlightController {
	constructor() {
		this.mode = 'acro';
		this.holdAltitude = null;
	}

	setMode(mode) {
		this.mode = mode;
		this.holdAltitude = null;
	}

	cycleMode() {
		this.setMode(MODES[(MODES.indexOf(this.mode) + 1) % MODES.length]);
		return this.mode;
	}

	// sticks: {throttle 0..1, roll/pitch/yaw -1..1}
	// state:  {rotation, angularVelocity, position, velocity}  (world frame)
	update(sticks, state) {
		const q = state.rotation;
		const levelled = this.mode !== 'acro';

		const target = {
			x: applyExpo(sticks.pitch, RATES.pitch),
			y: applyExpo(-sticks.yaw, RATES.yaw),
			z: applyExpo(-sticks.roll, RATES.roll),
		};

		if (levelled) {
			// Self-levelling: sticks command an attitude, and the error feeds the
			// same rate loop rather than a second controller.
			const upB = unrotateVec(q, 0, 1, 0);
			const wantPitch = Math.sin(sticks.pitch * ANGLE_MAX_TILT);
			const wantRoll = Math.sin(sticks.roll * ANGLE_MAX_TILT);
			target.x = clamp(ANGLE_KP * (wantPitch + upB.z), -RATES.pitch, RATES.pitch);
			target.z = clamp(-ANGLE_KP * (wantRoll + upB.x), -RATES.roll, RATES.roll);
		}

		let throttle = sticks.throttle;
		if (this.mode === 'altitude') {
			const demand = (sticks.throttle - 0.5) * 2;
			if (Math.abs(demand) > 0.08 || this.holdAltitude === null) {
				this.holdAltitude = state.position.y;
				throttle = hoverThrottle(q) + demand * 0.4;
			} else {
				// Vertical acceleration demand -> extra thrust on top of hover.
				const a = ALT_KP * (this.holdAltitude - state.position.y) - ALT_KD * state.velocity.y;
				throttle = hoverThrottle(q) + (DRONE.mass * a) / MAX_THRUST;
			}
		}

		// Rate loop: proportional on body-rate error is enough once TAU stands in
		// for the motor response — no PID tuning rabbit hole for a POC.
		const w = state.angularVelocity;
		const wBody = unrotateVec(q, w.x, w.y, w.z);
		const torqueBody = clampMagnitude({
			x: KP * (target.x - wBody.x),
			y: KP * (target.y - wBody.y),
			z: KP * (target.z - wBody.z),
		}, MAX_TORQUE);

		return {
			thrust: clamp(throttle, IDLE_THROTTLE, 1) * MAX_THRUST,
			torque: rotateVec(q, torqueBody.x, torqueBody.y, torqueBody.z),
		};
	}
}

// Throttle that cancels gravity at the current tilt, so levelled modes do not
// sag in turns.
function hoverThrottle(q) {
	const up = rotateVec(q, 0, 1, 0);
	return (DRONE.mass * GRAVITY) / (Math.max(0.35, up.y) * MAX_THRUST);
}

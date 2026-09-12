// Turtle mode (#105). Pure state machine: no DOM, no Three, no Rapier — main.js
// feeds it once per frame and obeys what comes out, exactly like flight-end.js.
//
// Every pilot knows the gesture: the machine ends up on its back, and rather
// than walking to it you flip it over from the sticks. Betaflight does that by
// reversing the motors; this does NOT. Reversed props would mean a signed
// motors[4], a reversed-blade efficiency model in quad.js and a second mixer —
// a lot of machinery for a move that lasts half a second and is over. So the
// flip is ASSISTED: one press, and a torque puts the machine back on its feet.
//
// What keeps that honest is the cap: the torque never exceeds what this
// airframe's own motors could produce (MAX_TORQUE below). The assist is a
// shortcut through the controller, not through physics.
//
// The gesture is offered ONLY when the machine is stuck AND on its back, which
// is why this module takes `stuck` rather than measuring immobility itself:
// flight-end.js already decides what "stuck" means, for the CUT LINK reminder,
// and two answers to that question would drift apart.

// Attitude thresholds, on up.y — the world-frame Y of the body's up axis. 1 is
// upright, -1 is flat on its back.
//
// UPSIDE_DOWN at -0.2 (~102° over) rather than 0: at exactly 90° the machine is
// on its side, which is where a sphere collider leaves a lot of crashes, and
// from there a pilot still has throttle and can fly out. Offering the flip is
// only right once flying out is off the table.
//
// RIGHTED at 0.9 (~26°) is where the flip stops, not where it aims: a quad back
// within 26° of level is on its feet and the pilot has the machine again.
export const TURTLE = {
	UPSIDE_DOWN: -0.2,
	RIGHTED: 0.9,
	W_CALM: 2.0,        // rad/s — residual rotation tolerated when stopping
	FLIP_S: 0.6,        // the flip a pilot expects to see, in seconds
	TIMEOUT_S: 2.5,     // hard stop: the mode can never latch
};

// Second-order attitude loop, critically damped. FLIP_S is the settling time we
// want, and a critically damped second-order system settles to ~1% in 5.8/wn,
// hence wn = 5.8 / FLIP_S; Kp = wn^2, Kd = 2*wn (zeta = 1, no overshoot — an
// overshooting flip would tip the machine onto its other side).
const gainsFor = (flipS) => {
	const wn = 5.8 / flipS;
	return { kp: wn * wn, kd: 2 * wn };
};

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

export class Turtle {
	constructor({ tune = TURTLE } = {}) {
		this.tune = tune;
		this._gains = gainsFor(tune.FLIP_S);
		// Mutated every frame rather than rebuilt, like flight-end.js's out and
		// link.out: this runs at display rate.
		this.out = { eligible: false, active: false, torque: { x: 0, y: 0, z: 0 } };
		this.reset();
	}

	reset() {
		this._t = 0;    // seconds since the flip started
		const o = this.out;
		o.eligible = false;
		o.active = false;
		o.torque.x = o.torque.y = o.torque.z = 0;
	}

	// `up` is the body's up axis in WORLD coordinates, `angularVelocity` the
	// world-frame rate Rapier reports. `inertia` is a single roll/pitch figure:
	// the flip turns about a HORIZONTAL axis, and on every family in
	// drone-profiles.js pitch and roll inertia agree to a few percent (0.0032 vs
	// 0.0030 on the reference build), so one number costs nothing and keeps the
	// torque in the right decade. `maxTorque` is what two motors at full thrust
	// on one side of the airframe can actually make.
	update({
		dt = 0, armed = false, stuck = false, pressed = false,
		up = { x: 0, y: 1, z: 0 }, angularVelocity = { x: 0, y: 0, z: 0 },
		inertia = 0.0032, maxTorque = 1.56,
	} = {}) {
		const T = this.tune, o = this.out;
		const onItsBack = up.y < T.UPSIDE_DOWN;
		// The offer. Never while the flip is already running — the line on screen
		// is an invitation, and there is nothing left to invite.
		o.eligible = armed && stuck && onItsBack && !o.active;
		if (o.eligible && pressed) {
			o.active = true;
			o.eligible = false;
			this._t = 0;
		}
		if (!o.active) {
			o.torque.x = o.torque.y = o.torque.z = 0;
			return o;
		}
		// A flip in progress survives `stuck` going false — it is the flip
		// itself that moves the machine, and cancelling on the first degree of
		// rotation would leave it half over.
		this._t += dt;
		const righted = up.y > T.RIGHTED;
		const w = angularVelocity;
		// Yaw is left alone: the world-Y component of the rate is the pilot's
		// heading, and nothing about being on one's back makes it wrong.
		const wx = w.x, wz = w.z;
		const calm = Math.hypot(wx, wz) < T.W_CALM;
		if ((righted && calm) || this._t >= T.TIMEOUT_S || !armed) {
			o.active = false;
			o.torque.x = o.torque.y = o.torque.z = 0;
			return o;
		}

		// The error: the rotation that takes the body's up axis onto the world's.
		// cross(up, +Y) is that axis times sin(theta), and theta itself comes
		// from up.y — sin alone would stall near 180°, which is exactly where a
		// machine on its back starts.
		let ax = -up.z, az = up.x;               // cross(up, (0,1,0))
		const len = Math.hypot(ax, az);
		const theta = Math.acos(clamp(up.y, -1, 1));
		if (len < 1e-4) {
			// Dead flat on its back (or already level): the axis is degenerate.
			// Any horizontal axis gets it over from there, so we pick one rather
			// than stall on a division by zero — the first degree of rotation
			// makes the cross product well defined again and the loop takes over.
			ax = 0; az = 1;
		} else {
			ax /= len; az /= len;
		}

		const { kp, kd } = this._gains;
		const cap = maxTorque;
		o.torque.x = clamp(inertia * (kp * theta * ax - kd * wx), -cap, cap);
		o.torque.y = 0;
		o.torque.z = clamp(inertia * (kp * theta * az - kd * wz), -cap, cap);
		return o;
	}
}

// What two motors on one side of the airframe can make, in N·m — the cap the
// assist is held to. Exported so main.js states it from the live profile rather
// than from the reference build's numbers.
export const maxRollTorque = (profile) =>
	2 * profile.maxThrustPerMotor * profile.armX;

// Physical model of a 5" freestyle quad: four motors, propeller aerodynamics,
// airframe drag and a lithium pack. No Rapier in here on purpose — this is the
// part worth testing headlessly and the part that decides how the thing feels.
//
// Everything is in SI units and in the body frame used by the rest of the sim
// (X = right, Y = up, Z = back; forward is -Z).
//
// The numbers come from a 2207/2450KV on 4S with 5x4.3x3 tri-blades, which is
// the most ordinary freestyle setup there is. Where a coefficient was fitted
// rather than looked up, the observation it was fitted to is in the comment.

import { Turbulence, mulberry32 } from './wind.js';

const AIR_DENSITY = 1.225;
export const GRAVITY = 9.81;

export const QUAD = {
	mass: 0.65,                 // kg all-up, 5" frame + 4S 1300 + camera
	radius: 0.15,               // m, collision sphere — see physics.js
	armX: 0.078,                // m, motor offset from CG along each axis
	armZ: 0.078,                // (220mm diagonal frame => 0.110 m arm at 45 deg)

	// Roll and pitch inertia are close; yaw is nearly twice as much because the
	// mass sits in the horizontal plane. The old model used one sphere inertia
	// (0.0054) for all three axes, which made roll ~1.8x too sluggish and yaw
	// too eager. This asymmetry is a large part of what a quad feels like.
	inertia: { x: 0.0032, y: 0.0058, z: 0.0030 },   // pitch, yaw, roll

	propRadius: 0.0635,         // m, 5 inch
	propInertia: 4.0e-6,        // kg*m^2 per prop, tri-blade
	bladeCount: 3,              // blades per prop — sets the blade-pass frequency
	                            // the audio synthesis sings at (rpm/60 * blades)

	maxThrustPerMotor: 10.0,    // N at full throttle on a fresh 4S (~1.02 kgf)
	maxOmega: 3140,             // rad/s (~30000 rpm loaded)

	// Thrust-stand data is much flatter than the naive T ~ cmd^2: 25% throttle
	// already gives ~19% of max thrust, not 6%. That is because a loaded motor
	// is nowhere near proportional in rpm to duty cycle. Fitting omega/omegaMax
	// = cmd^0.65 reproduces the published curve within a few percent and, as a
	// side effect, puts hover at ~25% throttle where a real quad sits.
	rpmCurve: 0.65,

	tauSpinUp: 0.022,           // s, first-order motor lag accelerating
	tauSpinDown: 0.045,         // s, decelerating — only aero drag slows a prop,
	                            // which is why a stalled recovery is so hard

	torqueRatio: 0.019,         // m, prop drag torque per newton of thrust

	// Blade-element style first-order corrections, both proportional to rpm:
	// axial inflow eats thrust when climbing, and the disc drags sideways when
	// translating. The lateral one dominates a quad's drag in fast flight and
	// is why chopping throttle at speed stops decelerating you.
	kAxial: 3.0e-5,             // N per (rad/s * m/s), fitted to ~15% thrust
	                            // loss at full throttle climbing at 15 m/s
	kLateral: 5.0e-5,           // N per (rad/s * m/s) per motor

	// Cd*A in the body frame. Vertical is much larger than horizontal: a quad
	// falling flat is a plate. Terminal velocity from these: ~19 m/s flat,
	// which matches a dead quad tumbling down.
	bodyDrag: { x: 0.010, y: 0.028, z: 0.010 },
};

export const HOVER_THRUST = QUAD.mass * GRAVITY;

// Motor layout in Betaflight order: 1 rear-right, 2 front-right, 3 rear-left,
// 4 front-left. spin = +1 for counter-clockwise seen from above (a positive
// rotation about body +Y), and diagonal pairs share a direction so the drag
// torques cancel in a hover.
export const MOTORS = [
	{ x: +QUAD.armX, z: +QUAD.armZ, spin: +1 },   // rear right
	{ x: +QUAD.armX, z: -QUAD.armZ, spin: -1 },   // front right
	{ x: -QUAD.armX, z: +QUAD.armZ, spin: -1 },   // rear left
	{ x: -QUAD.armX, z: -QUAD.armZ, spin: +1 },   // front left
];

// Mixer coefficients, derived from the geometry above rather than written out,
// so moving a motor cannot silently desynchronise the controller from physics.
//   roll  right = -omega.z   ->  right motors down, left motors up
//   pitch up    = +omega.x   ->  front motors up, rear motors down
//   yaw   left  = +omega.y   ->  spin-down motors up (reaction is opposed)
export const MIX = MOTORS.map((m) => ({
	roll: m.x / QUAD.armX,
	pitch: -m.z / QUAD.armZ,
	yaw: -m.spin,
}));

const kThrust = QUAD.maxThrustPerMotor / (QUAD.maxOmega * QUAD.maxOmega);

// ---------------------------------------------------------------------------
// Battery: a 4S 1300 mAh pack. Sag under load is not a detail — a punch-out
// pulls ~100 A and drops the pack over a volt, which is exactly the "it runs
// out of top end at the end of the pack" feeling.

export class Battery {
	constructor(cells = 4, capacityMah = 1300, internalOhm = 0.010) {
		this.cells = cells;
		this.capacityMah = capacityMah;
		this.internalOhm = internalOhm;
		this.maxCurrent = 100;          // A at four motors flat out
		this.reset();
	}

	reset() {
		this.usedMah = 0;
		this.current = 0;
		this.voltage = this.openCircuit();
	}

	get soc() { return Math.max(0, 1 - this.usedMah / this.capacityMah); }

	// Per-cell open-circuit curve, flattened through the middle like a real
	// lipo: 4.2 charged, a long plateau near 3.8, then a knee below 20%.
	openCircuit() {
		const s = this.soc;
		const cell = s > 0.2
			? 3.75 + 0.45 * ((s - 0.2) / 0.8) ** 0.75
			: 3.4 + 0.35 * (s / 0.2);
		return cell * this.cells;
	}

	// `load` is the summed (omega/omegaMax)^3 of the four motors: electrical
	// power into a prop goes with the cube of rpm.
	update(load, dt) {
		this.current = this.maxCurrent * Math.min(1, load / 4);
		this.voltage = Math.max(this.cells * 3.0, this.openCircuit() - this.current * this.internalOhm);
		this.usedMah += (this.current * dt * 1000) / 3600;
		return this.voltage;
	}

	// Motor rpm tracks voltage, so a sagging pack lowers the ceiling on thrust.
	get thrustScale() {
		return this.voltage / (4.2 * this.cells);
	}
}

// ---------------------------------------------------------------------------

export class Propulsion {
	// Seeded rather than left on Math.random: the shake below is the only
	// nondeterminism in the flight model, and without a seed two runs of
	// tools/selftest.mjs differ from each other, which makes a regression
	// indistinguishable from noise.
	constructor(seed = 0x5eed) {
		this.seed = seed >>> 0;
		this._rng = mulberry32(this.seed);
		this.battery = new Battery();
		this.omega = [0, 0, 0, 0];
		this.thrust = [0, 0, 0, 0];
		this.propwash = 0;
		// Band-limited noise for the two things that shake the airframe without
		// the pilot asking: its own downwash, and the air it is flying through.
		// The wind that produces the second one is not modelled here — quad.js
		// has no world frame — it arrives as `shake` in step().
		this._wash = [new Turbulence(14, this._rng), new Turbulence(14, this._rng), new Turbulence(14, this._rng)];
		this._buffet = [new Turbulence(6, this._rng), new Turbulence(6, this._rng), new Turbulence(6, this._rng)];
		// Filled in by step(); read by the HUD and the tests.
		this.force = { x: 0, y: 0, z: 0 };
		this.torque = { x: 0, y: 0, z: 0 };
	}

	reset() {
		this.battery.reset();
		this.omega.fill(0);
		this.thrust.fill(0);
		this.propwash = 0;
		// Filter state and the noise stream too: without this a respawn lands in
		// the middle of whatever the airframe was doing when it hit the ground,
		// and no two runs of the same test are comparable.
		this._rng = mulberry32(this.seed);
		for (const t of [...this._wash, ...this._buffet]) { t.rng = this._rng; t.reset(); }
	}

	get rpm() { return this.omega.map((w) => (w * 60) / (2 * Math.PI)); }

	// motors: four commands in 0..1, straight from the mixer.
	// air:    what the airframe is flying through, all in the body frame —
	//           v      velocity through the air, m/s (NOT ground speed)
	//           omega  body rates, rad/s, used for the per-motor inflow below
	//           agl    height above whatever is directly below, m, null if unknown
	//           shake  size of the air's own fluctuation, m/s, 0 in still air
	//
	// Returns body-frame {force, torque}; the caller rotates them into the world.
	step(motors, air, dt) {
		const vBody = air.v;
		const omega = air.omega ?? ZERO_RATE;
		const agl = air.agl ?? null;
		const shake = air.shake ?? 0;
		const bat = this.battery;
		const omegaMax = QUAD.maxOmega * bat.thrustScale;

		// Descending into your own downwash: the disc is eating turbulent air it
		// already threw down, so it loses thrust and the airframe shakes. Moving
		// sideways fast enough gets you out of the column, which is why propwash
		// only bites on hard vertical stops and tight corners.
		const lateral = Math.hypot(vBody.x, vBody.z);
		const descent = -vBody.y;
		this.propwash = clamp01((descent - 2) / 6) * clamp01((8 - lateral) / 6);

		// Ground effect: the disc pushes against a surface it cannot displace, so
		// thrust rises. Roughly one rotor diameter of reach on a 5".
		const ground = agl === null ? 1 : 1 + 0.18 * Math.exp(-Math.max(0, agl - QUAD.propRadius) / 0.22);

		let load = 0, thrustTotal = 0;
		let tx = 0, ty = 0, tz = 0;
		let dragX = 0, dragZ = 0;

		for (let i = 0; i < 4; i++) {
			const m = MOTORS[i];

			// Each rotor sees its own air, not the centre of gravity's. Rolling
			// right, the left motors are climbing and the right ones descending,
			// so the left disc gets extra inflow and loses thrust while the right
			// gains it — a moment opposing the roll that no coefficient had to be
			// invented for. v_i = v + omega x r, with r = (m.x, 0, m.z).
			const vx = vBody.x + omega.y * m.z;
			const vy = vBody.y + omega.z * m.x - omega.x * m.z;
			const vz = vBody.z - omega.y * m.x;

			// Command -> steady-state rpm, then a first-order lag toward it. The
			// lag is the single biggest contributor to how a quad feels: it is
			// what separates "snappy" from "floaty", and making spin-down slower
			// than spin-up is what makes an inverted save genuinely hard.
			const target = omegaMax * Math.pow(clamp01(motors[i]), QUAD.rpmCurve);
			const tau = target > this.omega[i] ? QUAD.tauSpinUp : QUAD.tauSpinDown;
			const prev = this.omega[i];
			this.omega[i] = prev + (target - prev) * (1 - Math.exp(-dt / tau));
			const w = this.omega[i];
			const dOmega = (w - prev) / dt;

			// Thrust: static term minus what the axial inflow takes away. Clamped
			// at zero rather than allowed to go negative — a prop windmilling
			// backwards is outside anything this model claims to cover.
			let t = kThrust * w * w - QUAD.kAxial * w * vy;
			t = Math.max(0, t) * ground * (1 - 0.22 * this.propwash);
			this.thrust[i] = t;
			thrustTotal += t;

			// Roll and pitch torque come out of where the motors are, not out of
			// a coefficient: tau = sum(r x F) with F along body +Y.
			tx += -m.z * t;
			tz += m.x * t;

			// Yaw is the reaction to prop drag torque, opposed to the spin, plus
			// the reaction to spinning the prop up. That second term is small in
			// steady state and dominant in a snap — it is why yaw is crisp on a
			// quad despite yaw having the most inertia.
			ty += -m.spin * (QUAD.torqueRatio * t + QUAD.propInertia * dOmega);

			// Rotor drag: the disc resists translation in proportion to rpm. Once
			// the four discs see different air, their drag forces differ too, and
			// four different horizontal forces at four different places is a yaw
			// moment: tau_y = r_z*F_x - r_x*F_z. Under yaw rate it comes out
			// opposing the rotation, which is the aerodynamic yaw damping a real
			// quad has and this model did not.
			const dx = -QUAD.kLateral * w * vx;
			const dz = -QUAD.kLateral * w * vz;
			dragX += dx;
			dragZ += dz;
			ty += m.z * dx - m.x * dz;

			load += (w / QUAD.maxOmega) ** 3;
		}

		bat.update(load, dt);

		// Airframe drag, quadratic and anisotropic in the body frame.
		const q = 0.5 * AIR_DENSITY;
		const bx = -q * QUAD.bodyDrag.x * Math.abs(vBody.x) * vBody.x;
		const by = -q * QUAD.bodyDrag.y * Math.abs(vBody.y) * vBody.y;
		const bz = -q * QUAD.bodyDrag.z * Math.abs(vBody.z) * vBody.z;

		this.force.x = dragX + bx;
		this.force.y = thrustTotal + by;
		this.force.z = dragZ + bz;

		if (this.propwash > 0.01) {
			// Turbulent thrust across the disc is uneven, so the airframe gets
			// shaken about all three axes. 15 Hz-ish, which is where propwash
			// oscillation actually sits on video.
			const s = this.propwash * 0.05;
			tx += this._wash[0].next(dt) * s;
			ty += this._wash[1].next(dt) * s * 0.5;
			tz += this._wash[2].next(dt) * s;
		}

		if (shake > 0.05) {
			// An eddy smaller than the disc does not arrive at all four rotors at
			// once, so the same fluctuation that pushes the quad sideways also
			// twists it. The amplitude is not a taste constant: a velocity
			// difference dv across one rotor changes its thrust by kAxial*w*dv,
			// and that acts on the arm — so the torque is that product, and it
			// grows with rpm exactly like the thrust it perturbs does.
			const wMean = (this.omega[0] + this.omega[1] + this.omega[2] + this.omega[3]) / 4;
			const s = QUAD.kAxial * wMean * shake * QUAD.armZ;
			tx += this._buffet[0].next(dt) * s;
			ty += this._buffet[1].next(dt) * s * 0.4;
			tz += this._buffet[2].next(dt) * s;
		}

		this.torque.x = tx; this.torque.y = ty; this.torque.z = tz;
		return this;
	}
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

const ZERO_RATE = { x: 0, y: 0, z: 0 };

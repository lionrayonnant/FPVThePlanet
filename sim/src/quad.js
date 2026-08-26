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
// Band-limited noise, used for propwash and gusts. Two cascaded first-order
// filters on white noise give something that looks like turbulence instead of
// the per-step hash that raw Math.random() would produce.

class Turbulence {
	constructor(cutoffHz) {
		this.cutoff = cutoffHz;
		this.a = 0; this.b = 0;
	}
	next(dt) {
		const k = 1 - Math.exp(-2 * Math.PI * this.cutoff * dt);
		this.a += k * ((Math.random() * 2 - 1) - this.a);
		this.b += k * (this.a - this.b);
		return this.b * 3.2;      // the two poles cost most of the amplitude
	}
}

// ---------------------------------------------------------------------------

export class Propulsion {
	constructor() {
		this.battery = new Battery();
		this.omega = [0, 0, 0, 0];
		this.thrust = [0, 0, 0, 0];
		this.propwash = 0;
		this._wash = [new Turbulence(14), new Turbulence(14), new Turbulence(14)];
		this._gust = [new Turbulence(0.4), new Turbulence(0.4), new Turbulence(0.4)];
		this.wind = { x: 0, y: 0, z: 0 };
		this.gustStrength = 0;
		// Filled in by step(); read by the HUD and the tests.
		this.force = { x: 0, y: 0, z: 0 };
		this.torque = { x: 0, y: 0, z: 0 };
	}

	reset() {
		this.battery.reset();
		this.omega.fill(0);
		this.thrust.fill(0);
		this.propwash = 0;
	}

	get rpm() { return this.omega.map((w) => (w * 60) / (2 * Math.PI)); }

	// motors: four commands in 0..1, straight from the mixer.
	// vBody:   velocity through the air in the body frame, m/s.
	// agl:     height above whatever is directly below, m (null when unknown).
	//
	// Returns body-frame {force, torque}; the caller rotates them into the world.
	step(motors, vBody, agl, dt) {
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
			let t = kThrust * w * w - QUAD.kAxial * w * vBody.y;
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

			// Rotor drag: the disc resists translation in proportion to rpm.
			dragX -= QUAD.kLateral * w * vBody.x;
			dragZ -= QUAD.kLateral * w * vBody.z;

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

		this.torque.x = tx; this.torque.y = ty; this.torque.z = tz;
		return this;
	}

	// Wind in the world frame: a steady component plus slow gusts. Called once
	// per step by Physics; kept here so the whole air model lives in one file.
	updateWind(mean, dt) {
		const g = this.gustStrength;
		this.wind.x = mean.x + (g ? this._gust[0].next(dt) * g : 0);
		this.wind.y = mean.y + (g ? this._gust[1].next(dt) * g * 0.4 : 0);
		this.wind.z = mean.z + (g ? this._gust[2].next(dt) * g : 0);
		return this.wind;
	}
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

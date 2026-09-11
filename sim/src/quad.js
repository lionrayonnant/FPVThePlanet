// Physical model of a multirotor: four motors, propeller aerodynamics, airframe
// drag and a lithium pack. No Rapier in here on purpose — this is the part worth
// testing headlessly and the part that decides how the thing feels.
//
// Everything is in SI units and in the body frame used by the rest of the sim
// (X = right, Y = up, Z = back; forward is -Z).
//
// The airframe itself is a `profile` from src/drone-profiles.js — one of six
// families (PHASE 07). The default profile, `QUAD`, is the 5" freestyle build
// (2207/2450KV on 4S, 5x4.3x3 tri-blades) that used to be hard-coded here, and
// its numbers are byte-for-byte the same. Where a coefficient was fitted rather
// than looked up, the observation it was fitted to is in that file's comments.

import { Turbulence, mulberry32 } from './wind.js';
import { DEFAULT_PROFILE } from './drone-profiles.js';

const AIR_DENSITY = 1.225;
export const GRAVITY = 9.81;

// The default airframe. Callers that want a specific family pass its profile to
// `new Propulsion({ profile })` / the FlightController / Physics instead.
export const QUAD = DEFAULT_PROFILE;

export function hoverThrust(profile = QUAD) { return profile.mass * GRAVITY; }
export const HOVER_THRUST = hoverThrust(QUAD);
// Le manche de « gaz coupés » (PHASE 14), dérivé plutôt que choisi. La poussée
// statique d'un moteur suit omega = omegaMax * cmd^rpmCurve (voir Propulsion
// plus bas) et poussée ∝ omega², donc poussée totale(cmd) = 4 * maxThrustPerMotor
// * cmd^(2*rpmCurve). En-dessous du manche où cette poussée tombe à la moitié du
// poids, l'appareil accélère vers le bas à au moins 0,5 g : ce n'est plus du
// pilotage au ras du sol, c'est une pose en cours, quel que soit le manche
// exact que le pilote tient encore. On résout cmd pour poussée = poids / 2 :
//   cmd = ((mass * g) / (8 * maxThrustPerMotor)) ^ (1 / (2 * rpmCurve))
// (le 8 plutôt que le 4 de hoverThrust vient de ce facteur 1/2 sur le poids
// visé). Valeurs obtenues par famille : freestyle5 0,143 · race5 0,106 · cinewhoop 0,250 ·
// longrange 0,185 · heavy5 0,169 · toothpick 0,231 — toutes franchement sous
// le manche de stationnaire (hoverStick, tools/selftest.mjs) de la même
// famille.
export function idleThrottle(profile = QUAD) {
	return ((profile.mass * GRAVITY) / (8 * profile.maxThrustPerMotor)) ** (1 / (2 * profile.rpmCurve));
}

// Measured contact forces: gentle landing ~290N, 10 m/s touchdown ~1600N,
// 25 m/s into a building ~2450N. 1500 lets you land and bump walls, but calls
// slamming into something a crash.
export const CRASH_IMPULSE = 1500;

// Arrivée à plat (ventre vers le sol) : les bras et les hélices encaissent, il
// faut nettement plus pour casser. ~16 m/s de descente verticale passent.
export const CRASH_IMPULSE_FLAT = 2800;

// Un drone qui arrive à plat encaisse : bras et hélices absorbent. Nez en avant
// ou sur le dos, il casse plus facilement — le seuil suit donc l'assiette au
// moment du choc (upY proche de 1 = plat/dessus, proche de -1 = inversé).
export function crashThreshold(rotation) {
	const upY = 1 - 2 * (rotation.x * rotation.x + rotation.z * rotation.z);
	return upY > 0.4 ? CRASH_IMPULSE_FLAT : CRASH_IMPULSE;
}

// Motor layout in Betaflight order: 1 rear-right, 2 front-right, 3 rear-left,
// 4 front-left. spin = +1 for counter-clockwise seen from above (a positive
// rotation about body +Y), and diagonal pairs share a direction so the drag
// torques cancel in a hover.
export function motorsOf(profile = QUAD) {
	return [
		{ x: +profile.armX, z: +profile.armZ, spin: +1 },   // rear right
		{ x: +profile.armX, z: -profile.armZ, spin: -1 },   // front right
		{ x: -profile.armX, z: +profile.armZ, spin: -1 },   // rear left
		{ x: -profile.armX, z: -profile.armZ, spin: +1 },   // front left
	];
}

// Mixer coefficients, derived from the motor geometry rather than written out,
// so moving a motor cannot silently desynchronise the controller from physics.
//   roll  right = -omega.z   ->  right motors down, left motors up
//   pitch up    = +omega.x   ->  front motors up, rear motors down
//   yaw   left  = +omega.y   ->  spin-down motors up (reaction is opposed)
export function mixOf(profile = QUAD) {
	return motorsOf(profile).map((m) => ({
		roll: m.x / profile.armX,
		pitch: -m.z / profile.armZ,
		yaw: -m.spin,
	}));
}

export function kThrustOf(profile = QUAD) {
	return profile.maxThrustPerMotor / (profile.maxOmega * profile.maxOmega);
}

function diskAreaOf(profile) {
	return Math.PI * profile.propRadius * profile.propRadius;
}

// A rotor's local axial velocity difference dv changes its thrust by roughly
// coefficient*omega*dv (momentum-theory inflow slope). That one mechanism
// used to be measured twice under one name, `kAxial`: once for climb thrust
// loss (kInflowOf below) and once for the turbulence-buffet damping torque
// (kBuffetOf below) — two unrelated jobs sharing one dial, so rescaling it by
// disk size for one job broke the other (issue #71, commit fcfa19a).
//
// Non-dimensionalizing kAxial's old per-family values against
// sqrt(2*rho*diskArea*kThrust) — the actual inflow-slope scale from actuator
// disk theory — shows freestyle5/race5/longrange/heavy5 (propRadius 6.4-8.9
// cm, 0.55-0.92 kg) agree on the same constant (~0.169) to within 2%: the
// sim's implicit formula was already right in form, just never written down.
// Only smaller disks (cinewhoop, toothpick) need a correction, carried below
// in `inflowGain`/`buffetGain` — that missing correction, and nobody knowing
// how much more of it a ~34 g/~20 mm-prop craft would need, is why the
// prototyped 1S tinywhoop was pulled from PHASE 07.
export const INFLOW_K0 = 0.169;
const BUFFET_K0 = INFLOW_K0;

// kLateral (rotor/body drag -> yaw damping) is one job, not two, and its own
// ratio to disk area is already tight across the same four families
// (~3.6-4.1e-3); non-dimensionalizing it the same way removes its last
// "no formula" complaint without needing a split.
const LATERAL_K0 = 3.95e-3;

export function kInflowOf(profile = QUAD) {
	const base = Math.sqrt(2 * AIR_DENSITY * diskAreaOf(profile) * kThrustOf(profile));
	return INFLOW_K0 * base * (profile.inflowGain ?? 1);
}

export function kBuffetOf(profile = QUAD) {
	const base = Math.sqrt(2 * AIR_DENSITY * diskAreaOf(profile) * kThrustOf(profile));
	return BUFFET_K0 * base * (profile.buffetGain ?? 1);
}

// Fraction de la poussée d'un rotor que la turbulence de propwash déplace, à
// propwash plein. Calibrée sur le comportement historique : 0,05 N·m sur
// freestyle5 au vol stationnaire (poussée 1,594 N par moteur, bras 0,078 m)
// donne 0,05 / (1,594 × 0,078) = 0,402. Voir l'usage dans step() pour ce que
// cette mise à l'échelle corrige (issue #144).
export const PROPWASH_TORQUE_FRAC = 0.402;

export function kLateralOf(profile = QUAD) {
	return LATERAL_K0 * diskAreaOf(profile) * (profile.lateralGain ?? 1);
}

// Hover induced velocity per unit rpm: vh = omega * sqrt(kThrust / (2*rho*A)),
// straight out of momentum theory (T = 2*rho*A*vh^2 with T = kThrust*omega^2).
// Precomputed once per airframe; it is the only scale the inflow below needs.
export function vhPerOmegaOf(profile = QUAD) {
	return Math.sqrt(kThrustOf(profile) / (2 * AIR_DENSITY * diskAreaOf(profile)));
}

// Glauert's induced velocity for a rotor in EDGEWISE flight, in closed form.
//
// The disc equation v_i * sqrt(Vx^2 + v_i^2) = vh^2 is a quadratic in v_i^2, so
// there is no reason to iterate for it — and every reason not to, at 250 Hz.
// Solving x*(Vx^2 + x) = vh^4 for x = v_i^2 and taking the positive root gives
//   v_i = sqrt( (sqrt(Vx^4 + 4*vh^4) - Vx^2) / 2 )
// which loses all its significant digits once Vx >> vh, precisely the fast
// forward flight this was added for. The conjugate form below is algebraically
// identical and numerically stable everywhere:
//   v_i = vh^2 * sqrt( 2 / (sqrt(Vx^4 + 4*vh^4) + Vx^2) )
//
// `vEdge2` is the SQUARED edgewise speed, because that is what the caller
// already has and squaring it back would only cost accuracy.
export function inducedVelocity(vh, vEdge2) {
	if (vh <= 0) return 0;
	// Hover and pure vertical flight are the common case AND the one that has to
	// come back unchanged to the last bit: the formula below does return vh
	// there, but only after a square root and a divide that cost it an ulp. Say
	// it exactly instead. Anything that used to hover still hovers identically.
	if (vEdge2 <= 0) return vh;
	const vh2 = vh * vh;
	return vh2 * Math.sqrt(2 / (Math.sqrt(vEdge2 * vEdge2 + 4 * vh2 * vh2) + vEdge2));
}

// Flapback is NOT here, and that is a decision (#103).
//
// A rotor in edgewise flight develops an in-plane force as well as a thrust,
// and the disc tilts back with it. That much is already in this file: with a
// flapping angle proportional to the advance ratio, the in-plane component of
// a tilted thrust has the same shape as the rotor drag `kLateral * w * v`
// below, which was fitted to observed behaviour and therefore contains both
// lumped together.
//
// #91 added the MOMENT of it, from two places — the hub moment of a rigid
// propeller, and the lever the in-plane forces never had, the discs sitting
// above the centre of mass. Both were removed again: flown, they made the
// airframe unusable (#103). Everything they add scales with airspeed, and both
// act across pitch and roll, so a held yaw at twice cruise speed rolled the
// craft at up to 79 % of the commanded yaw rate — measured by section 4 of
// tools/aero-selftest.mjs, which is the gate that was missing when they went
// in (the #144 gate holds the airframe in STILL air, where all of this is
// identically zero).
//
// There is also a modelling question to settle before any of it comes back: a
// rigid propeller does not tilt its disc, and a flapping one does not hand a
// hub moment to its hub. Taking the flapping picture for the force and the
// rigid picture for the moment looks like the same dissymmetry counted twice.
// Re-deriving that, and re-measuring what is left, is issue #91.

// The speed an airframe settles at when it is actually being flown: where the
// drag of a 35-degree nose-down attitude balances what it can push through the
// air. Derived rather than picked, so a bench that wants to ask a family about
// forward flight asks it about ITS forward flight and not a 5-inch's.
//
//   4*kLateral*w_hover*V + 0.5*rho*bodyDrag.z*V^2 = m*g*tan(35 deg)
//
// Rotor drag is linear in V and body drag quadratic, hence the quadratic; the
// positive root is the only physical one.
export function cruiseSpeedOf(profile = QUAD) {
	const wHover = Math.sqrt((profile.mass * GRAVITY) / 4 / kThrustOf(profile));
	const a = 0.5 * AIR_DENSITY * profile.bodyDrag.z;
	const b = 4 * kLateralOf(profile) * wHover;
	const c = -profile.mass * GRAVITY * Math.tan((35 * Math.PI) / 180);
	return (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
}

// Ground-effect reach as a multiple of propRadius, fixed to reproduce
// freestyle5's measured 0.22 m reach on its 0.0635 m prop exactly, so every
// other family's reach scales off its own disk instead of freestyle5's.
const GROUND_EFFECT_REACH_RATIO = 0.22 / 0.0635;

// Compat exports for the handful of consumers that only ever want the default
// airframe (audio.js panning, tools reporting).
export const MOTORS = motorsOf(QUAD);
export const MIX = mixOf(QUAD);

// ---------------------------------------------------------------------------
// Battery: a 4S 1300 mAh pack. Sag under load is not a detail — a punch-out
// pulls ~100 A and drops the pack over a volt, which is exactly the "it runs
// out of top end at the end of the pack" feeling.

export class Battery {
	constructor(spec = QUAD.battery) {
		this.cells = spec.cells;
		this.capacityMah = spec.capacityMah;
		this.internalOhm = spec.internalOhm;
		this.maxCurrent = spec.maxCurrent;   // A at four motors flat out
		// Whether the pack actually empties. Off is the bench's BATTERY HELD
		// (PHASE 26): the charge stops draining, and NOTHING else changes —
		// sag under load is instantaneous and physical, so it stays. A held
		// pack still bends when you pull on it, it just never runs out.
		this.drain = true;
		this.reset();
	}

	// `reset()` deliberately does not touch `drain`: it is a bench setting for
	// the session, not part of the pack's state, and a respawn must not
	// silently hand the charge back to the physics.
	reset() {
		this.usedMah = 0;
		this.current = 0;
		this.voltage = this.openCircuit();
	}

	setDrain(enabled) {
		this.drain = enabled !== false;
		return this;
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
		if (this.drain) this.usedMah += (this.current * dt * 1000) / 3600;
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
	constructor({ profile = QUAD, seed = 0x5eed } = {}) {
		this.profile = profile;
		this._motors = motorsOf(profile);
		this._mix = mixOf(profile);
		this._kThrust = kThrustOf(profile);
		this._kInflow = kInflowOf(profile);
		this._kBuffet = kBuffetOf(profile);
		this._kLateral = kLateralOf(profile);
		this._vhPerOmega = vhPerOmegaOf(profile);
		this.seed = seed >>> 0;
		this._rng = mulberry32(this.seed);
		this.battery = new Battery(profile.battery);
		this.omega = [0, 0, 0, 0];
		this.thrust = [0, 0, 0, 0];
		this.propwash = 0;
		// Net rotor angular momentum about body +Y, N.m.s. Read by the tests and
		// worth having by name: it is zero for every symmetric stick input and
		// only wakes up under yaw or motor saturation.
		this.hRotor = 0;
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
		this.hRotor = 0;
		// Filter state and the noise stream too: without this a respawn lands in
		// the middle of whatever the airframe was doing when it hit the ground,
		// and no two runs of the same test are comparable.
		this._rng = mulberry32(this.seed);
		for (const t of [...this._wash, ...this._buffet]) { t.rng = this._rng; t.reset(); }
	}

	// Sets omega/thrust straight to their steady-state value for a throttle
	// command, skipping the motor-lag ramp step() normally applies — so a
	// drone that starts (or respawns) already in flight doesn't show stopped
	// props and silent audio on its first frame (PHASE 13). Ground effect and
	// axial inflow are left out on purpose: those need real airspeed/agl, and
	// the very next step() call folds them in anyway.
	primeFor(cmd) {
		const omegaMax = this.profile.maxOmega * this.battery.thrustScale;
		const w = omegaMax * Math.pow(clamp01(cmd), this.profile.rpmCurve);
		const t = Math.max(0, this._kThrust * w * w);
		for (let i = 0; i < 4; i++) {
			this.omega[i] = w;
			this.thrust[i] = t;
		}
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
		const P = this.profile;
		const omegaMax = P.maxOmega * bat.thrustScale;

		// Descending into your own downwash: the disc is eating turbulent air it
		// already threw down, so it loses thrust and the airframe shakes. Moving
		// sideways fast enough gets you out of the column, which is why propwash
		// only bites on hard vertical stops and tight corners.
		const lateral = Math.hypot(vBody.x, vBody.z);
		const descent = -vBody.y;
		this.propwash = clamp01((descent - 2) / 6) * clamp01((8 - lateral) / 6);

		// Ground effect: the disc pushes against a surface it cannot displace, so
		// thrust rises. Reach is one rotor diameter-ish, scaled off THIS profile's
		// own disk (issue #71) instead of hard-coded to freestyle5's 0.22 m: a
		// fixed reach made a whoop's tiny disk feel ground effect over a distance
		// several times its own body size, holding idle thrust — and so descent
		// rate — pinned near hover far longer than a real ~34 g airframe would.
		// The 0.18 peak gain is still global; no per-family measurement exists
		// yet for how much a duct changes it (left as follow-up, same as before).
		const groundReach = GROUND_EFFECT_REACH_RATIO * P.propRadius;
		const ground = agl === null ? 1 : 1 + 0.18 * Math.exp(-Math.max(0, agl - P.propRadius) / groundReach);

		let load = 0, thrustTotal = 0;
		let tx = 0, ty = 0, tz = 0;
		let dragX = 0, dragZ = 0;
		// Net angular momentum of the four spinning rotors, about body +Y.
		let hRotor = 0;

		for (let i = 0; i < 4; i++) {
			const m = this._motors[i];

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
			const target = omegaMax * Math.pow(clamp01(motors[i]), P.rpmCurve);
			const tau = target > this.omega[i] ? P.tauSpinUp : P.tauSpinDown;
			const prev = this.omega[i];
			this.omega[i] = prev + (target - prev) * (1 - Math.exp(-dt / tau));
			const w = this.omega[i];
			const dOmega = (w - prev) / dt;

			// Thrust: static term minus what the inflow takes away. Clamped at
			// zero rather than allowed to go negative — a prop windmilling
			// backwards is outside anything this model claims to cover.
			//
			// `dw` is the flow through the disc in excess of what a hover already
			// has, and it carries BOTH the axial term this model always had and
			// the edgewise one it never did. Writing it as one quantity is the
			// whole point: kInflow IS the actuator-disc inflow slope, so a second
			// coefficient for forward flight would be the same mechanism measured
			// twice — the mistake `kAxial` already made once (issue #71).
			//
			// The factor 2 is what makes this a generalisation rather than an
			// addition. In pure axial flight the exact momentum-theory solution
			//   v_i = -Vc/2 + sqrt(Vc^2/4 + vh^2)
			// puts the disc-normal flow at vh + Vc/2 to first order, i.e. an
			// excess of Vc/2 over hover — so the term this file has always
			// applied, -kInflow*w*Vc, is exactly -kInflow*w*(2 * excess). Keep
			// that 2 and the axial branch comes back bit for bit while the
			// edgewise branch falls out for free.
			//
			// DESCENT IS DELIBERATELY LEFT ALONE. Between -2*vh and 0 the
			// momentum theory has no solution at all — that is the vortex ring
			// state — and this file already models that regime empirically, as
			// `propwash` above. The separable form below only ever adds the
			// edgewise term, which is the one that was missing.
			const vh = w * this._vhPerOmega;
			const vEdge2 = vx * vx + vz * vz;
			const dw = vy + 2 * (inducedVelocity(vh, vEdge2) - vh);
			let t = this._kThrust * w * w - this._kInflow * w * dw;
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
			ty += -m.spin * (P.torqueRatio * t + P.propInertia * dOmega);

			// Rotor drag: the disc resists translation in proportion to rpm. Once
			// the four discs see different air, their drag forces differ too, and
			// four different horizontal forces at four different places is a yaw
			// moment: tau_y = r_z*F_x - r_x*F_z. Under yaw rate it comes out
			// opposing the rotation, which is the aerodynamic yaw damping a real
			// quad has and this model did not.
			const dx = -this._kLateral * w * vx;
			const dz = -this._kLateral * w * vz;
			dragX += dx;
			dragZ += dz;
			ty += m.z * dx - m.x * dz;


			hRotor += m.spin * P.propInertia * w;
			load += (w / P.maxOmega) ** 3;
		}

		// Gyroscopic precession of the rotor group. The rotors carry angular
		// momentum H about body +Y, and in a rotating frame that costs a torque
		// -omega x H — tilt a spinning disc and it pushes back ninety degrees
		// round.
		//
		// This is NOT the propInertia term already in the yaw sum above. Writing
		// the rotor contribution to dL/dt in the body frame gives two pieces:
		// dH/dt, the reaction to spinning a prop up, which is that yaw term; and
		// omega x H, the precession, which is this one. Complementary, not
		// redundant — one needs the rpm to be CHANGING, the other only needs it
		// to be nonzero.
		//
		//   -omega x (0, H, 0) = (H*omega.z, 0, -H*omega.x)
		//
		// so it is pure roll<->pitch and touches yaw not at all, which it must
		// not, H being along Y.
		//
		// Worth knowing what this does and does not produce. On a symmetric X,
		// sum(spin_i * omega_i) is EXACTLY zero for a pure roll command and for
		// a pure pitch command, whatever the rpm curve: the two motors handed
		// +delta carry opposite spins, and so do the two handed -delta. H is
		// nonzero only under yaw, under motor saturation, and for a drawn
		// specimen whose props do not match. So what this adds is precisely what
		// a pilot reports: yaw while rolling and the nose moves.
		//
		// It cannot destabilise anything by adding energy — tau . omega =
		// -(omega x H) . omega is identically zero, so the term does no work.
		// What it can do is be integrated badly: an explicit step amplifies a
		// rotation at H/sqrt(Ix*Iz) by sqrt(1 + (rate*dt)^2) per step. That
		// product is checked per family in tools/aero-selftest.mjs.
		this.hRotor = hRotor;
		tx += hRotor * omega.z;
		tz -= hRotor * omega.x;

		bat.update(load, dt);

		// Airframe drag, quadratic and anisotropic in the body frame.
		const q = 0.5 * AIR_DENSITY;
		const bx = -q * P.bodyDrag.x * Math.abs(vBody.x) * vBody.x;
		const by = -q * P.bodyDrag.y * Math.abs(vBody.y) * vBody.y;
		const bz = -q * P.bodyDrag.z * Math.abs(vBody.z) * vBody.z;

		this.force.x = dragX + bx;
		this.force.y = thrustTotal + by;
		this.force.z = dragZ + bz;

		if (this.propwash > 0.01) {
			// Turbulent thrust across the disc is uneven, so the airframe gets
			// shaken about all three axes. 15 Hz-ish, which is where propwash
			// oscillation actually sits on video.
			//
			// L'amplitude n'est PAS une constante de goût — même règle que le
			// buffet juste en dessous, et pour la même raison. Elle valait 0,05
			// N·m en dur, quelle que soit la machine (issue #144). Rapporté à ce
			// que les moteurs peuvent produire (poussée × bras), ça fait 40 % de
			// l'autorité d'un 5 pouces… et 596 % de celle d'un toothpick. Le
			// couple de perturbation dépassait donc SIX FOIS ce que la machine
			// pouvait opposer : aucun réglage de PID ne rattrape ça, et c'est ce
			// qui faisait diverger tangage et lacet sous un roulis tenu, à
			// l'échelle micro seulement. Mesuré : 895 °/s² d'accélération
			// parasite sur freestyle5, 50 300 °/s² sur toothpick.
			//
			// La turbulence perturbe une FRACTION de la poussée réellement
			// produite, et cette perturbation agit sur le bras : le couple est
			// donc ce produit-là. La fraction est calibrée pour rendre exactement
			// les 0,05 N·m historiques sur freestyle5 au vol stationnaire — le
			// ressenti de référence est conservé au centième, seule l'échelle
			// entre familles change.
			const s = this.propwash * PROPWASH_TORQUE_FRAC * (thrustTotal / 4) * P.armZ;
			tx += this._wash[0].next(dt) * s;
			ty += this._wash[1].next(dt) * s * 0.5;
			tz += this._wash[2].next(dt) * s;
		}

		if (shake > 0.05) {
			// An eddy smaller than the disc does not arrive at all four rotors at
			// once, so the same fluctuation that pushes the quad sideways also
			// twists it. The amplitude is not a taste constant: a velocity
			// difference dv across one rotor changes its thrust by kBuffet*w*dv,
			// and that acts on the arm — so the torque is that product, and it
			// grows with rpm exactly like the thrust it perturbs does.
			const wMean = (this.omega[0] + this.omega[1] + this.omega[2] + this.omega[3]) / 4;
			const s = this._kBuffet * wMean * shake * P.armZ;
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

// The rain, as a model: how hard it is falling right now, how much water is
// sitting on the camera's front element, how far you can see through it, and
// which way a drop on that element runs.
//
// No THREE and no DOM in here, on purpose and for the same reason as wind.js:
// this is the half that tools/selftest.mjs can check. src/rainfall.js draws the
// streaks, src/lens.js refracts through the drops, main.js wires the two.
//
// Units are the ones a forecast uses — millimetres per hour — because every
// relation below is published in them. The slider is 0..1 and MAX_RATE is the
// only place the two meet.

import { mulberry32 } from './wind.js';

// 25 mm/h is a downpour: the Met Office calls 4 mm/h heavy and 10 mm/h violent
// for a shower. Past this the model would keep working and the picture would
// stop being flyable, which is not a mode anyone wants to sit in.
export const MAX_RATE = 25;

// Median-volume drop diameter, Laws & Parsons via Marshall-Palmer:
//   D0 = 0.89 * R^0.21 mm
// Drizzle lands near 0.6 mm, a downpour near 1.7 mm. That range is small, and
// that is the point: heavy rain is mostly *more* drops, not much bigger ones.
const D0_A = 0.89, D0_B = 0.21;

// Terminal velocity, Atlas & Ulbrich:  v = 3.78 * D^0.67 m/s, D in mm.
// 0.6 mm falls at 2.7 m/s, 1.7 mm at 5.4 m/s.
const VT_A = 3.78, VT_B = 0.67;

// Liquid water content, Marshall-Palmer: LWC = 0.089 * R^0.84 g/m^3.
const LWC_A = 0.089, LWC_B = 0.84;

// Extinction coefficient of rain, per kilometre: sigma = 0.21 * R^0.74.
// Koschmieder then gives the meteorological range as 3.912 / sigma, so 5 mm/h
// leaves about 5.6 km and 25 mm/h about 1.7 km. Both are the right order for
// rain alone, which is worth saying because the naive "visibility = 1.13/R^0.63"
// that circulates would claim 150 m for the same downpour.
const EXT_A = 0.21, EXT_B = 0.74;
const KOSCHMIEDER = 3.912;

// The tile shader's fog is exp-squared, so solving 1 - exp(-(sigma*V)^2) = 0.95
// for the 5% contrast threshold gives sigma*V = 1.73: that is the conversion
// between a density in TileMaterial.js and a meteorological range in metres.
// The FOG_DENSITY main.js ships with is a range of about 2 km.
const FOG_SHAPE = 1.73;

// Meteorological range, in metres, of a tile-shader fog density, and back.
// Exported because main.js needs the round trip and issue #21 will need it too.
export const fogRange = (density) => FOG_SHAPE / density;
export const fogDensity = (rangeM) => FOG_SHAPE / rangeM;

// Rain rates are lognormally distributed — that is the standard result for a
// rain gauge, and it is also the only shape that stays positive without a clamp
// biasing the mean. exp(k*n - k^2/2) has unit mean for a unit-variance n, so
// turning `variability` up makes the weather breathe without making it rainier.
const VAR_GAIN = 0.75;
// Two bands: a spell that lasts a couple of minutes, and squalls inside it.
const TAU_SLOW = 70, TAU_FAST = 14;
const BAND_MIX = 0.65;   // weight of the slow band; the two are normalised below

// Water on the front element. Deposition is proportional to how hard it is
// raining and to how much bare glass is left; removal is the airflow blowing it
// off, which is why a quad clears its lens by flying and fogs it by hovering.
// At a standstill in a downpour that settles at 0.86 with a 5.7 s constant; at
// 15 m/s the same rain only holds 0.32.
const WET_DEPOSIT = 0.15;      // per second at full rate on dry glass
const WET_DRAIN = 0.025;       // per second, gravity and evaporation
const WET_BLOWOFF = 0.020;     // per second per m/s of airspeed

// A drop on the glass is pushed by two things and neither of them is "down the
// screen". See dropDrift() for the argument; this is the one fitted number in
// it, set so the water starts running *up* the frame at about 6 m/s forward,
// which is where it does on a car windscreen and on FPV footage.
const AIR_PUSH = 0.27;         // m/s^2 per (m/s)^2 of relative airflow
export const GRAVITY = 9.81;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// Same bounded pseudo-Gaussian as wind.js: three uniforms summed, unit variance,
// and hard-stopped at 3 sigma so a tail event cannot invent a monsoon.
function gauss(rng) {
	return (rng() * 2 - 1) + (rng() * 2 - 1) + (rng() * 2 - 1);
}

// Ornstein-Uhlenbeck, discretised exactly — the variance-preserving form, so
// the bench can step at 1/50 and the sim at 1/250 and get the same statistics.
class Ou {
	constructor(rng) { this.rng = rng; this.x = 0; }
	reset() { this.x = 0; }
	next(dt, tau) {
		const a = Math.exp(-dt / tau);
		this.x = a * this.x + Math.sqrt(1 - a * a) * gauss(this.rng);
		return this.x;
	}
}

// ---------------------------------------------------------------------------
// Presets
//
// Same shape and same reasoning as WIND_PRESETS: the numbers belong with the
// model, not with the panel. Anchored on the rates the names actually mean —
// bruine is 0.5 mm/h, pluie 5, averse 20.
export const RAIN_PRESETS = {
	sec:     { label: 'sec',     intensity: 0,    variability: 0 },
	bruine:  { label: 'bruine',  intensity: 0.02, variability: 0.3 },
	pluie:   { label: 'pluie',   intensity: 0.2,  variability: 0.5 },
	averse:  { label: 'averse',  intensity: 0.8,  variability: 0.8 },
};

// ---------------------------------------------------------------------------

export class RainField {
	// baseFogDensity is the scene's clear-air fog (main.js FOG_DENSITY). It is
	// passed in rather than duplicated here so there is one constant of truth;
	// the default only exists so the headless checks can build a bare field.
	constructor(seed = 0x7a12, baseFogDensity = 0.00085) {
		this.seed = seed >>> 0;
		this.rng = mulberry32(this.seed);
		this.baseRange = fogRange(baseFogDensity);

		this.intensity = 0;      // 0..1, the mean; MAX_RATE is what 1 means
		this.variability = 0;    // 0..1, how much it breathes

		this._slow = new Ou(this.rng);
		this._fast = new Ou(this.rng);

		// Read every frame by rainfall.js, lens.js and the HUD.
		this.rate = 0;           // 0..1, the instantaneous intensity
		this.mmPerHour = 0;
		this.wetness = 0;        // 0..1, water on the front element
		this.dropDiameter = 0;   // mm
		this.fallSpeed = 0;      // m/s, terminal
		this.dropsPerM3 = 0;
		this.fogScale = 1;       // multiplier on FOG_DENSITY, 1 when dry
		this.visibility = Infinity;  // metres, rain alone — for the debug readout
		this.reset();
	}

	// A respawn should not land in the middle of the squall that just blinded
	// you. Deterministic, so the headless checks are stable rather than merely
	// plausible.
	reset() {
		this.rng = mulberry32(this.seed);
		this._slow.rng = this.rng;
		this._fast.rng = this.rng;
		this._slow.reset();
		this._fast.reset();
		this.rate = 0;
		this.mmPerHour = 0;
		this.wetness = 0;
		this.dropDiameter = 0;
		this.fallSpeed = 0;
		this.dropsPerM3 = 0;
		this.fogScale = 1;
		this.visibility = Infinity;
	}

	// intensity 0..1 (0 is dry, 1 is MAX_RATE mm/h), variability 0..1.
	setParams({ intensity, variability } = {}) {
		if (intensity !== undefined) this.intensity = clamp01(intensity);
		if (variability !== undefined) this.variability = clamp01(variability);
		return this;
	}

	// Nothing set means nothing runs: no filters advanced, no fog touched, no
	// geometry drawn. Dry has to be bit-identical to there being no rain model
	// at all — the same promise wind.js makes for calm air, and for the same
	// reason: every existing check in tools/selftest.mjs assumes a neutral world.
	get active() { return this.intensity > 0; }

	// airspeed is physics.airspeed — the speed through the *air*, because what
	// clears the lens is the airflow over it, not the ground speed.
	update(airspeed, dt) {
		if (!this.active) {
			// Constants, not leftovers: turning the slider down has to give the
			// picture back, not leave the fog where the last shower put it. No
			// filter is advanced and no random number is drawn, so dry really is
			// the same world as one with no rain model in it.
			this.rate = 0;
			this.mmPerHour = 0;
			this.dropsPerM3 = 0;
			this.fogScale = 1;
			this.visibility = Infinity;
			// The one thing that does keep running: glass that was already wet
			// when the rain stopped still has to dry.
			if (this.wetness > 0) {
				this.wetness = Math.max(0, this.wetness
					- this.wetness * (WET_DRAIN + WET_BLOWOFF * airspeed) * dt);
				if (this.wetness < 1e-4) this.wetness = 0;
			}
			return this;
		}

		// Two bands, normalised back to unit variance so `variability` means the
		// same thing whichever timescale happens to be dominating.
		const n = (BAND_MIX * this._slow.next(dt, TAU_SLOW)
			+ (1 - BAND_MIX) * this._fast.next(dt, TAU_FAST))
			/ Math.sqrt(BAND_MIX * BAND_MIX + (1 - BAND_MIX) * (1 - BAND_MIX));
		const k = VAR_GAIN * this.variability;
		this.rate = Math.min(1, this.intensity * Math.exp(k * n - 0.5 * k * k));

		const R = this.rate * MAX_RATE;
		this.mmPerHour = R;
		this.dropDiameter = D0_A * Math.pow(R, D0_B);
		this.fallSpeed = VT_A * Math.pow(this.dropDiameter, VT_B);
		// Concentration from the water content and the drop volume. A drop of
		// D mm holds (pi/6) D^3 mm^3, i.e. 1e-3 (pi/6) D^3 grams.
		const lwc = LWC_A * Math.pow(R, LWC_B);
		this.dropsPerM3 = lwc / (1e-3 * (Math.PI / 6) * Math.pow(this.dropDiameter, 3));

		// Extinctions add, so visibilities combine as reciprocals. The result is
		// handed out as a multiplier on the fog the scene already has rather
		// than as a second fog term, which keeps one exp-squared in the tile
		// shader and leaves issue #21 a single knob to take over.
		const sigma = EXT_A * Math.pow(R, EXT_B);        // per km
		this.visibility = (KOSCHMIEDER / sigma) * 1000;  // metres
		this.fogScale = 1 + this.baseRange / this.visibility;

		this.wetness = clamp01(this.wetness
			+ (WET_DEPOSIT * this.rate * (1 - this.wetness)
				- this.wetness * (WET_DRAIN + WET_BLOWOFF * airspeed)) * dt);
		return this;
	}
}

// Where a drop sitting on the front element runs, as a specific force in the
// plane of the glass, in units of g.
//
// The naive answer is "down the screen" and it is wrong twice over. What a drop
// stuck to an accelerating vehicle feels is:
//
//   - the apparent gravity, which is exactly minus the vehicle's proper
//     acceleration. Real gravity and the pseudo-force cancel term for term, so
//     the whole thing is -(F_aero+thrust)/m and nothing else. In a hover that
//     comes out as one g downwards, which is the sanity check; in free fall the
//     drop floats, which is the other one;
//   - the airflow over the glass, which at any speed at all is the bigger of
//     the two. This is why water runs *up* a windscreen.
//
// Both inputs are already in the drone's body frame (X right, Y up, Z back —
// see quad.js): `air` is physics.airVelocity, `force` is
// physics.propulsion.force. The result is rotated by the camera uptilt, because
// the glass is tilted with the camera and not with the airframe, and comes back
// as (x right, y up) in the image.
export function dropDrift(air, force, mass, tiltRad, out = { x: 0, y: 0 }) {
	// Apparent gravity. The minus is the whole derivation.
	let fx = -force.x / mass, fy = -force.y / mass, fz = -force.z / mass;

	// The air blows over the drone at -air (air is the drone's velocity through
	// the air), and drag on a bead goes as the square of it.
	const speed = Math.hypot(air.x, air.y, air.z);
	if (speed > 1e-6) {
		const k = (AIR_PUSH * speed * speed) / speed;
		fx -= k * air.x; fy -= k * air.y; fz -= k * air.z;
	}

	// Out of the body frame and into the camera's: the camera is rotated up by
	// tiltRad about X, so a vector expressed in the body goes the other way.
	const c = Math.cos(tiltRad), s = Math.sin(tiltRad);
	out.x = fx / GRAVITY;
	out.y = (fy * c + fz * s) / GRAVITY;
	return out;
}

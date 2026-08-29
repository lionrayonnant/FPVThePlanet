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

// How far you can see through rain alone, in metres, at R mm/h. Free function
// because the world state (tools/lib/weather.mjs) has to know it without
// stepping a field: a forecast that claims 20 km of visibility under a downpour
// is a forecast that contradicts the sim it is about to drive. Dry is Infinity,
// which is what lets the callers add extinctions unconditionally.
export function rainVisibility(mmPerHour) {
	if (!(mmPerHour > 0)) return Infinity;
	return (KOSCHMIEDER / (EXT_A * Math.pow(mmPerHour, EXT_B))) * 1000;
}

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
		this.visibility = rainVisibility(R);             // metres
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

// ---------------------------------------------------------------------------
// Water on the front element, as something you can see
//
// An FPV camera has a flat protective window a few millimetres ahead of the
// lens proper, and that window is what the water actually lands on. Two of the
// camera's own numbers then decide everything about how a drop on it looks —
// and, notably, the weather decides almost none of it:
const APERTURE_MM = 1.0;    // entrance pupil; f = 2.1 mm at f/2 is about a mm
const STANDOFF_MM = 8.0;    // window to entrance pupil
const WINDOW_MM = 10.0;     // how much of the window the field looks through

// A drop that lands and beads up is wider than the drop that fell: the same
// water spread as a hemisphere instead of a sphere. Volume conservation gives
// the factor and nothing is fitted — (pi/6)d^3 = (pi/12)D^3, so D = 2^(1/3) d.
const BEAD_SPREAD = Math.cbrt(2);

// And it keeps growing, because the next drop to land on it joins it. This is
// the one number in here fitted rather than derived, and it is what makes a
// soaked lens read as a few fat blobs instead of a hundred small ones.
const MERGE_GAIN = 1.2;

// What the window holds at a given wetness. `wetness` is already the wetted
// fraction — that is what it means, since the deposition term in update() is
// proportional to the bare glass left — so the count is just that fraction of
// the window's area divided by the area one bead covers.
//
// The result is a small number, and that is the finding: you see a handful of
// drops, not a field of them, because the window is ten millimetres across.
// A procedural drop field would be solving a problem this does not have.
export function lensDrops(wetness, dropDiameterMm) {
	if (!(wetness > 0) || !(dropDiameterMm > 0)) return { count: 0, beadMm: 0 };
	const beadMm = dropDiameterMm * BEAD_SPREAD * (1 + MERGE_GAIN * wetness);
	const windowArea = Math.PI * WINDOW_MM * WINDOW_MM / 4;
	const beadArea = Math.PI * beadMm * beadMm / 4;
	return { count: (wetness * windowArea) / beadArea, beadMm };
}

// What one bead does to the picture. This is the whole reason the two failed
// attempts failed, so it is worth stating plainly.
//
// A bead sitting on the window is nowhere near focus, and "how out of focus" is
// not the question — the question is which rays it touches. Every point of the
// window is crossed by the whole cone that the entrance pupil accepts, so a
// bead of diameter D at standoff s interferes with the picture over the
// convolution of the bead with the pupil: an angular disc of diameter
// (D + A)/s, with a flat core of (D - A)/s where the bead covers the pupil
// completely and a soft skirt out to the rim where it only clips it.
//
// Three things fall straight out of that and all three were asked for:
//
//   - the footprint is *large* and barely depends on the drop's size, because
//     the aperture term is comparable to D. Millimetre of water, tens of
//     degrees of picture;
//   - a drop bigger than the pupil is opaque at its centre; one smaller than
//     the pupil never is, whatever its size, because it can only ever clip part
//     of the cone. That is "certaines presque invisibles, d'autres beaucoup
//     plus présentes", and it is geometry rather than a random opacity;
//   - the edge is soft for free, and the softness is the pupil's diameter.
//
// And the content of the disc is not an image of anything: it is every
// direction the pupil can see through that bead, averaged. Which is why the
// honest way to draw it is a very wide blur, and why refraction — a *sharp*
// image, merely displaced — could never have looked right.
export function dropFootprint(beadMm) {
	const sum = beadMm + APERTURE_MM;
	return {
		angle: sum / STANDOFF_MM,                                  // radians
		core: Math.max(0, (beadMm - APERTURE_MM) / sum),           // 0..1 of the radius
		peak: Math.min(1, (beadMm / APERTURE_MM) ** 2),            // opacity at the centre
	};
}

// A bead does not slide until the driving force beats the contact line holding
// it: rho V a > k gamma w, i.e. a threshold that goes as 1/D^2. Big drops run,
// small ones never do, and that is the whole of "la majorité restent presque
// fixes" — no random "is this one mobile" flag is needed.
//
// Anchored on what a hover has to look like: the four-millimetre beads a soaked
// lens carries hold at one g and let go as soon as you push. That puts the
// threshold at 1.6 g for four millimetres, so only a five millimetre bead creeps
// in a hover, a three millimetre one needs 2.9 g and a millimetre one is never
// going anywhere. An FPV lens is coated, and a coating is exactly what raises
// the hysteresis holding the water on it.
const PIN_G_MM2 = 26.0;

// Once it is running: viscous, so speed goes as the excess force times the
// bead's cross-section. A 3 mm bead at one g of excess runs at 20 mm/s, which
// is what water does on a windscreen.
const RUN_MM_S = 2.2;       // mm/s per mm^2 per g of excess

// The line above is a near-threshold expansion and stops meaning anything a few
// g past the break-away point: a bead pushed that hard sheds and atomises
// rather than accelerating, and what leaves the glass is already accounted for
// in RainField.wetness. So the speed is capped at crossing the frame in about a
// second, which is also as fast as anything can be followed by eye.
const MAX_RUN_UNITS = 2.0;  // position units per second

// It re-pins on the next defect it meets, roughly one bead-width along, which
// is why a running drop stutters instead of gliding. Nothing here draws a
// trail: a trail is what made the last attempt read as a scratch.
const REPIN_SPREAD = 0.35;   // how much the pinning strength varies, +/- fraction

// Long enough not to pop, short enough not to lag the rain.
const FADE_S = 0.8;

// The population is single digits, so this is a list and not a field.
const MAX_LENS_DROPS = 24;

export class LensDrops {
	constructor(seed = 0x2b17) {
		this.seed = seed >>> 0;
		this.rng = mulberry32(this.seed);
		// x, y in [-1,1] over the frame; one unit is half the window.
		this.drops = [];
		this.count = 0;
		this.target = 0;
		this.beadMm = 0;
	}

	reset() {
		this.rng = mulberry32(this.seed);
		this.drops.length = 0;
		this.count = 0;
		this.target = 0;
		this.beadMm = 0;
	}

	// wetness/dropDiameterMm come from RainField; drift is dropDrift()'s answer,
	// a specific force in the plane of the glass in units of g. dt is zero when
	// the sim is frozen, which is all it takes to stop the water dead.
	update({ wetness = 0, dropDiameterMm = 0, drift = null, dt = 0 } = {}) {
		const { count, beadMm } = lensDrops(wetness, dropDiameterMm);
		this.target = count;
		this.beadMm = beadMm;

		// Dry is inert, strictly: no drop, no filter, no random number drawn.
		// Same promise the rest of this file makes.
		if (this.drops.length === 0 && count <= 0) { this.count = 0; return this; }

		const want = Math.min(MAX_LENS_DROPS, Math.round(count));
		const live = this.drops.filter((d) => !d.dying).length;
		// The direction water is running, if it is running at all. Drops that
		// leave come back in on the upwind edge, because that is where the ones
		// being pushed across the glass come from.
		const gx = drift ? drift.x : 0, gy = drift ? drift.y : -1;
		const g = Math.hypot(gx, gy);
		for (let i = live; i < want; i++) this._spawn(beadMm, gx, gy, g);
		for (let i = want; i < live; i++) {
			// The oldest still-living drop goes: it is the one that has had the
			// longest to be blown off.
			let oldest = null;
			for (const d of this.drops) if (!d.dying && (!oldest || d.age > oldest.age)) oldest = d;
			if (oldest) oldest.dying = true;
		}

		if (dt > 0) for (const d of this.drops) this._step(d, dt, gx, gy, g);
		for (let i = this.drops.length - 1; i >= 0; i--) {
			if (this.drops[i].fade <= 0 && this.drops[i].dying) this.drops.splice(i, 1);
		}
		this.count = this.drops.length;
		return this;
	}

	_spawn(beadMm, gx, gy, g) {
		if (this.drops.length >= MAX_LENS_DROPS) return;
		// Sizes are a distribution: a lens with six identical beads on it reads
		// as a screen effect, which is the trap the last attempt fell into.
		const jitter = Math.exp(0.35 * gauss(this.rng) - 0.5 * 0.35 * 0.35);
		const drop = {
			x: this.rng() * 2 - 1,
			y: this.rng() * 2 - 1,
			bead: beadMm * jitter,
			pin: 1 + REPIN_SPREAD * (this.rng() * 2 - 1),
			slid: 0,
			age: 0,
			fade: 0,
			dying: false,
		};
		// A drop appearing mid-frame is a new drop landing, which is right; a
		// drop appearing mid-frame while the rest are visibly streaming across
		// is not, so once the water is actually running — g past what holds a
		// bead of this size — they come in from the edge it runs from instead.
		// Testing the threshold and not merely g matters: in a hover g is one
		// and only the odd bead creeps, so edge spawning there would park most
		// of the population just off frame and leave the lens far too clean.
		// Half again past the threshold, so it takes hold when the water is
		// plainly running rather than the moment the biggest bead twitches.
		if (g > 1.5 * PIN_G_MM2 / (beadMm * beadMm)) {
			const t = this.rng() * 2 - 1;
			drop.x = -gx / g * 1.1 + (-gy / g) * t;
			drop.y = -gy / g * 1.1 + (gx / g) * t;
		}
		this.drops.push(drop);
	}

	_step(d, dt, gx, gy, g) {
		d.age += dt;
		d.fade = d.dying
			? Math.max(0, d.fade - dt / FADE_S)
			: Math.min(1, d.fade + dt / FADE_S);

		if (g > 1e-4) {
			const crit = (PIN_G_MM2 / (d.bead * d.bead)) * d.pin;
			const excess = g - crit;
			if (excess > 0) {
				// mm/s on the glass; one position unit is half the window.
				const v = Math.min(MAX_RUN_UNITS,
					(RUN_MM_S * d.bead * d.bead * excess) / (WINDOW_MM / 2));
				const step = v * dt;
				d.x += (gx / g) * step;
				d.y += (gy / g) * step;
				d.slid += step;
				// Re-pinned on the next defect, about a bead-width along.
				if (d.slid > d.bead / (WINDOW_MM / 2)) {
					d.slid = 0;
					d.pin = 1 + REPIN_SPREAD * (this.rng() * 2 - 1);
				}
			}
		}
		// Off the window: blown clear, and it does not come back.
		if (Math.abs(d.x) > 1.25 || Math.abs(d.y) > 1.25) d.dying = true;
	}
}

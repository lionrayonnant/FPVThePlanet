// The fog, as a model: how far you can see right now, how much the scattered
// light is veiling the picture, and what colour the air has become.
//
// No THREE and no DOM in here, same rule and same reason as wind.js and
// rain.js: this is the half tools/selftest.mjs can check. TileMaterial.js does
// the actual extinction, loader.setFog() moves it on every chunk material,
// lens.js draws the veil, main.js wires the three.
//
// The unit a pilot thinks in is a distance — "you can see 200 m" — so that is
// what the panel shows and what this file computes. The exp-squared density the
// shader wants is derived from it, never the other way round.

import { Ou, mulberry32 } from './wind.js';
import { fogRange, fogDensity } from './rain.js';

// The thickest air the sim will make. 30 m is "brouillard très dense" in the
// WMO classes and it is already barely flyable; below that the picture stops
// being a picture and the slider stops being a choice.
export const RANGE_MIN = 30;

// Same lognormal argument as rain.js: an extinction coefficient is positive by
// construction and clamping a Gaussian would bias the mean, while
// exp(k*n - k^2/2) has unit mean for a unit-variance n. So turning `variability`
// up makes the fog come and go without quietly making it thicker.
const VAR_GAIN = 0.6;
// Fog is not a squall. It thickens over minutes, not over seconds — a bank
// drifting through is the slow band, a thinning patch inside it the fast one.
const TAU_SLOW = 120, TAU_FAST = 25;
const BAND_MIX = 0.7;    // weight of the slow band; the two are normalised below

// Veiling glare: how much of the scattered light ends up in the optics rather
// than on the subject. Tied to the slider's own log scale rather than to a
// separate curve, so "half the slider" means the same thing to the fog and to
// the veil. The strength of the effect is lens.js's business, not this file's.
const GLARE_GAIN = 1;
// How fast the air's colour leaves the clear-sky blue for the neutral grey of
// fog. 1.5 puts it fully fog-coloured at two thirds of the slider, which is
// where a bank stops looking like haze. Chosen by eye, like the rain sky.
const SKY_GAIN = 1.5;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// ---------------------------------------------------------------------------
// Presets
//
// Same shape and same reasoning as WIND_PRESETS and RAIN_PRESETS: the numbers
// belong with the model, not with the panel. Anchored on the WMO visibility
// classes rather than on round slider positions — brume is 1 to 5 km, fog is
// under 1 km by definition, and "very dense" is under 50 m. Solved backwards
// through the mapping below, which is why they are not round:
//
//   brume 1200 m, brouillard 500 m, purée de pois 50 m
//
// Fog thick enough to change how a map flies is thicker than most people
// picture: at 1200 m the far side of the scene is merely hazy, and it takes
// 500 m before a street stops showing you where it goes.
export const FOG_PRESETS = {
	clair:      { label: 'clair',      intensity: 0,     variability: 0 },
	brume:      { label: 'brume',      intensity: 0.125, variability: 0.4 },
	brouillard: { label: 'brouillard', intensity: 0.333, variability: 0.5 },
	puree:      { label: 'purée',      intensity: 0.879, variability: 0.3 },
};

// ---------------------------------------------------------------------------

export class FogField {
	// baseFogDensity is the scene's clear-air fog (main.js FOG_DENSITY), passed
	// in rather than duplicated so there is one constant of truth. The default
	// only exists so the headless checks can build a bare field.
	constructor(seed = 0x3f0c, baseFogDensity = 0.00085) {
		this.seed = seed >>> 0;
		this.rng = mulberry32(this.seed);
		this.baseDensity = baseFogDensity;
		this.baseRange = fogRange(baseFogDensity);
		// How many times thicker than clear air the far end of the slider is.
		// The mapping is geometric in the range, which is the only scale on
		// which "a bit more fog" means the same thing at 2 km and at 50 m.
		this.span = this.baseRange / RANGE_MIN;

		this.intensity = 0;      // 0..1, the mean thickness
		this.variability = 0;    // 0..1, how much it breathes

		this._slow = new Ou(this.rng);
		this._fast = new Ou(this.rng);

		// Read every frame by main.js.
		this.density = baseFogDensity;   // for the tile shader, clear air included
		this.range = this.baseRange;     // metres, meteorological range
		this.glare = 0;                  // 0..1, veiling glare for lens.js
		this.skyMix = 0;                 // 0..1, how far the air is from clear-sky blue
		this.reset();
	}

	// A respawn should not land in the middle of the bank that just swallowed
	// you. Deterministic, so the headless checks are stable rather than merely
	// plausible.
	reset() {
		this.rng = mulberry32(this.seed);
		this._slow.rng = this.rng;
		this._fast.rng = this.rng;
		this._slow.reset();
		this._fast.reset();
		this.density = this.baseDensity;
		this.range = this.baseRange;
		this.glare = 0;
		this.skyMix = 0;
	}

	// intensity 0..1 (0 is clear air, 1 is RANGE_MIN metres), variability 0..1.
	setParams({ intensity, variability } = {}) {
		if (intensity !== undefined) this.intensity = clamp01(intensity);
		if (variability !== undefined) this.variability = clamp01(variability);
		return this;
	}

	// Nothing set means nothing runs: no filter advanced, no random number
	// drawn, the density left exactly where the scene loaded it. Clear air has
	// to be bit-identical to there being no fog model at all — the promise
	// wind.js makes for calm air and rain.js for dry weather, and the reason the
	// sky pixel still comes out #9fb8cc by default.
	get active() { return this.intensity > 0; }

	// The mean range this setting asks for, before any breathing.
	rangeFor(intensity) {
		return rangeFor(intensity, this.baseDensity);
	}

	update(dt) {
		if (!this.active) {
			this.density = this.baseDensity;
			this.range = this.baseRange;
			this.glare = 0;
			this.skyMix = 0;
			return this;
		}

		// Two bands, normalised back to unit variance so `variability` means the
		// same thing whichever timescale happens to be dominating.
		const n = (BAND_MIX * this._slow.next(dt, TAU_SLOW)
			+ (1 - BAND_MIX) * this._fast.next(dt, TAU_FAST))
			/ Math.sqrt(BAND_MIX * BAND_MIX + (1 - BAND_MIX) * (1 - BAND_MIX));
		const k = VAR_GAIN * this.variability;

		// The breathing rides on the extinction the fog *adds*, not on the total
		// and not on the range: extinctions are what add, so that is the
		// quantity a multiplicative jitter can move without the clear air
		// underneath it moving too.
		const target = this.baseDensity * Math.pow(this.span, this.intensity);
		const added = (target - this.baseDensity) * Math.exp(k * n - 0.5 * k * k);
		this.density = this.baseDensity + Math.max(0, added);
		this.range = fogRange(this.density);

		// Where the slider effectively sits this frame, breathing included: the
		// inverse of the geometric mapping above. Both the veil and the colour
		// hang off it so that they never disagree with the visibility.
		const eff = clamp01(Math.log(this.density / this.baseDensity) / Math.log(this.span));
		this.glare = clamp01(GLARE_GAIN * eff);
		this.skyMix = clamp01(SKY_GAIN * eff);
		return this;
	}
}

// The mean range a slider position asks for, before any breathing. A free
// function because the panel has to label the slider without a model to step,
// and it carries the same default as rain.js's for the same reason: the caller
// that owns the scene's clear-air density passes it, the ones that only need a
// label do not have to invent one.
export function rangeFor(intensity, baseFogDensity = 0.00085) {
	const i = clamp01(intensity);
	const base = fogRange(baseFogDensity);
	return base / Math.pow(base / RANGE_MIN, i);
}

// The slider position that a visibility in metres corresponds to — the exact
// inverse of rangeFor(). The world state needs this direction: a forecast
// speaks in metres of visibility, and fog.js takes a 0..1 intensity. Anything
// clearer than the scene's clear air is 0, anything thicker than RANGE_MIN is 1.
export function intensityForRange(rangeM, baseFogDensity = 0.00085) {
	const base = fogRange(baseFogDensity);
	if (!(rangeM > 0) || rangeM >= base) return 0;
	return clamp01(Math.log(base / rangeM) / Math.log(base / RANGE_MIN));
}

// The extinction a visibility in metres contributes to the tile shader, in the
// shader's own units. Infinity gives exactly zero, which is what lets main.js
// add the rain term unconditionally.
export function extinctionOf(visibilityM) {
	return visibilityM === Infinity || !(visibilityM > 0) ? 0 : fogDensity(visibilityM);
}

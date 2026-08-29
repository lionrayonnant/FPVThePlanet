// The air the quad flies through: a wind field, in world ENU metres per second.
//
// No Rapier, no DOM, no three: this file only knows how high the drone is and
// what the geometry around it looks like as a handful of already-measured
// distances. Whoever measures them is somebody else's problem — physics.js
// casts the rays, main.js wires it up. Same split as quad.js, link.js and
// flightController.js, and the reason this can be checked in
// tools/selftest.mjs without a browser.
//
// Axis convention, because getting it wrong puts the wind in the opposite half
// of the compass and nothing complains: the world is ENU with X = east,
// Y = up and Z = SOUTH (so north is -Z), as tools/prep.mjs sets up. Directions
// follow the meteorological convention — a "wind from 270" comes from the west
// and blows towards the east — so a wind from bearing φ has the direction
// vector (-sin φ, 0, +cos φ). Check it: φ = 0, a north wind, gives (0, 0, +U),
// blowing south. φ = 270 gives (+U, 0, 0), blowing east.
//
// Wind is never one number. What a pilot feels is four things happening at
// different rates, and they need separate models because they have separate
// causes:
//
//   mean        the pressure gradient, shaped by the boundary layer. Constant.
//   wander      the layer meandering. Tens of seconds.
//   gusts       discrete parcels of faster air arriving. Seconds.
//   turbulence  the eddy cascade. Tenths of a second.
//
// Folding the last three into one low-pass filter — which is what the first
// version of this did — can only ever express "how strong", never "how often"
// or "how long", and those are exactly what makes a gust read as a gust rather
// than as a slow drift.

// ---------------------------------------------------------------------------
// Boundary layer

// Roughness length. The log law U(z) = (u*/k)·ln(z/z0) is a surface-layer
// result and z0 is the height at which it extrapolates to zero wind. The
// Davenport classes put city centres at 1-2 m, suburbs at 0.5, open farmland
// at 0.03. Scenes here are all city, but a quad spends much of its time down
// in the streets rather than over the roofs, so the low end of urban.
const Z0 = 1.0;

// Speeds are quoted at 10 m because that is the height a met station measures
// at — it is the only height at which "12 m/s" means anything shared.
const Z_REF = 10;

// The surface layer is roughly the bottom tenth of the boundary layer. Above
// this the log law is no longer a result about anything and the profile levels
// off into the gradient wind. 300 m is also the tip of the Eiffel Tower, so
// nothing in these scenes is outside the model.
const Z_TOP = 300;

// Below z0 the logarithm goes negative. Physically that is the roughness
// sublayer — down among the obstacles, where there is no profile at all, just
// slow messy air. Floor it rather than let it cross zero: 2·z0 gives
// ln2/ln10 = 30% of the 10 m wind at street level, which is about right for a
// city and is monotone and positive by construction.
const Z_FLOOR = 2 * Z0;

const LOG_REF = Math.log(Z_REF / Z0);

// Fraction of the 10 m wind found at height z. Exactly 1 at 10 m.
export function shearFactor(agl) {
	const z = Math.min(Math.max(agl, Z_FLOOR), Z_TOP);
	return Math.log(z / Z0) / LOG_REF;
}

// In the northern hemisphere friction backs the surface wind relative to the
// geostrophic flow, so climbing veers it clockwise. Twelve degrees over the
// surface layer is the textbook figure over land. Small, but it turns "the
// wind is stronger up here" into "the wind is stronger AND coming from
// somewhere else up here", which is what you actually notice on a climb-out.
const VEER_TOP = 12;

export function veer(agl) {
	const z = Math.min(Math.max(agl, Z_FLOOR), Z_TOP);
	return VEER_TOP * (z / Z_TOP);
}

// Turbulence intensity is not a taste knob, it falls out of the same
// similarity theory as the profile: σu = 2.5·u* and U = (u*/0.4)·ln(z/z0),
// so σu/U = 1/ln(z/z0). 0.43 at 10 m, 0.22 at 100 m, 0.18 at 300 m. Capped
// because it diverges as z approaches z0, and an infinite gust in a gutter is
// not a feature.
const I_MAX = 0.55;

export function turbulenceIntensity(agl) {
	const z = Math.min(Math.max(agl, Z_FLOOR), Z_TOP);
	return Math.min(I_MAX, 1 / Math.log(z / Z0));
}

// Surface-layer measurements give σu:σv:σw ≈ 2.5:1.9:1.3 u*, i.e. 1:0.78:0.52.
// MIL-F-8785C's low-altitude Dryden model agrees independently: its σu/σw is
// 1.9 at 10 m and 1.6 at 50 m, so σw/σu = 0.53-0.63. The two land on the same
// number, which is why 0.52 is here and the 0.4 the old gust model used is
// not — that one had no source.
//
// The three are generated in a WIND-ALIGNED frame (u along the wind, v across
// it, w vertical) and then rotated into ENU. That is the correlation this
// model has: turbulence is anisotropic with respect to the wind, not with
// respect to the compass. It is also why a crosswind gust does not feel like a
// headwind gust.
const SIGMA_V = 0.78;
const SIGMA_W = 0.52;

// Dryden length scales, MIL-F-8785C below 305 m — exactly this regime. h in
// metres here, the spec is in feet.
function lengthScales(agl) {
	const h = Math.min(Math.max(agl, Z_FLOOR), Z_TOP);
	const ft = h * 3.28084;
	return {
		w: h,
		u: h / Math.pow(0.177 + 0.000823 * ft, 1.2),
	};
}

// Dryden's time constant is L/V with V the airspeed — which for a hovering
// quad is zero, and the correlation time goes to infinity: the field would
// freeze solid the moment you stopped. Taylor's frozen-turbulence hypothesis
// is the fix: the eddies are carried past you by the mean wind whether you are
// moving or not. The 3 m/s floor keeps a hover in dead calm from stalling the
// filters, and the emergent "the air gets rougher the faster you fly" — the
// same eddies arriving sooner — is free.
function advection(speed, airspeed) {
	return Math.max(airspeed, speed, 3);
}

// ---------------------------------------------------------------------------
// Noise

// Seeded, because tools/selftest.mjs cannot check a property of turbulence if
// every run draws a different sequence. mulberry32: 32 bits of state, passes
// the usual smoke tests, four lines.
export function mulberry32(seed) {
	let a = seed >>> 0;
	return function () {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// Three uniforms on [-1,1] summed. Each has variance 1/3, so the sum is unit
// variance with no square root and no logarithm — and, unlike a real Gaussian,
// it is bounded at 3σ. That bound is the point: an unbounded tail is a free
// ticket to fling the quad into orbit once an hour.
function gauss(rng) {
	return (rng() * 2 - 1) + (rng() * 2 - 1) + (rng() * 2 - 1);
}

// Ornstein-Uhlenbeck, discretised exactly rather than by forward Euler:
//
//     x <- a·x + sqrt(1 - a²)·N(0,1),   a = exp(-dt/tau)
//
// Unconditionally stable, and it holds unit variance at any dt. That matters
// because the sim steps at 1/250 while the benches and the property tests step
// at whatever they like; the `1 - exp(...)` form used for the propwash shake
// does not preserve variance across a change of rate.
export class Ou {
	constructor(rng) { this.rng = rng; this.x = 0; }
	reset() { this.x = 0; }
	next(dt, tau) {
		const a = Math.exp(-dt / tau);
		this.x = a * this.x + Math.sqrt(1 - a * a) * gauss(this.rng);
		return this.x;
	}
}

const SQRT3 = Math.sqrt(3);
// Measured, not derived: the zero below adds variance back, and this takes it
// out again so the axis still leaves at unit variance. tools/selftest.mjs
// re-measures the two ratios rather than trusting this number.
const ZERO_GAIN = 0.618;

// One turbulence axis. The longitudinal axis is a single pole; the lateral and
// vertical ones carry Dryden's (1 + sqrt(3)·tau·s) zero, which is what makes a
// crosswind or vertical gust arrive sharper than a headwind one.
//
// The zero costs nothing to implement: for a first-order lag x2' = (x1-x2)/tau,
// the term sqrt(3)·tau·x2' is just sqrt(3)·(x1 - x2). No numerical derivative,
// no dt in the expression, nothing to blow up at a small step.
class DrydenAxis {
	constructor(rng, zero) { this.a = new Ou(rng); this.x2 = 0; this.zero = zero; }
	reset() { this.a.reset(); this.x2 = 0; }
	next(dt, tau) {
		const x1 = this.a.next(dt, tau);
		if (!this.zero) return x1;
		const k = 1 - Math.exp(-dt / tau);
		this.x2 += k * (x1 - this.x2);
		return (this.x2 + SQRT3 * (x1 - this.x2)) * ZERO_GAIN;
	}
}

// Band-limited noise, the cheap kind: two cascaded first-order filters on
// white noise. Kept because quad.js's propwash and buffet shake want a shape,
// not a spectrum, and do not care about variance across a change of dt.
export class Turbulence {
	constructor(cutoffHz, rng = Math.random) {
		this.cutoff = cutoffHz;
		this.rng = rng;
		this.a = 0; this.b = 0;
	}
	reset() { this.a = 0; this.b = 0; }
	next(dt) {
		const k = 1 - Math.exp(-2 * Math.PI * this.cutoff * dt);
		this.a += k * ((this.rng() * 2 - 1) - this.a);
		this.b += k * (this.a - this.b);
		return this.b * 3.2;      // the two poles cost most of the amplitude
	}
}

// ---------------------------------------------------------------------------
// The terrain probe
//
// Ten rays, cast by physics.js, aimed in a frame that follows the wind rather
// than the compass — index 0 always points upwind, so "is something sheltering
// me" is always the same question about the same ray no matter which way the
// wind is blowing.
//
//   0        upwind                      6        90 deg the other way
//   1, 7     +/- 45 deg from upwind      8        straight up
//   2, 6     +/- 90 deg (the walls)      9        straight down (the AGL)
//   3, 5     +/- 135 deg
//   4        downwind
//
// 45 degrees rather than 60 because it puts exact +/-90 pairs on the wind axis,
// which is what makes the street-canyon test symmetric.

export const PROBE_COUNT = 10;
export const PROBE_UP = 8;
export const PROBE_DOWN = 9;

// A bluff body's near wake and recirculation run one to three building heights;
// a Paris block is about 20 m. It is also the FPV scale — you feel a building
// when you are within a block of it. The down ray is long because it is doing
// a different job: it is the only source of height above ground the wind model
// has, the ground-effect ray in physics.js being capped at 6 m.
export const PROBE_RANGE = [30, 30, 30, 30, 30, 30, 30, 30, 30, 400];

// Direction of probe `i` in world space, given the unit horizontal direction
// the wind is blowing towards. Exported so that physics.js aims the rays with
// the very same function that interprets them — a probe frame that disagrees
// with itself would turn shelter into speed-up and nothing would say so.
export function probeDirection(i, dx, dz, out) {
	if (i === PROBE_UP) { out.x = 0; out.y = 1; out.z = 0; return out; }
	if (i === PROBE_DOWN) { out.x = 0; out.y = -1; out.z = 0; return out; }
	// Upwind is the reverse of where the wind is going, then i quarter-turns
	// of 45 degrees around +Y.
	const a = (i * Math.PI) / 4;
	const c = Math.cos(a), s = Math.sin(a);
	out.x = -(dx * c - dz * s);
	out.y = 0;
	out.z = -(dx * s + dz * c);
	return out;
}

// How much of the free stream a building directly upwind takes away. Measured
// near-wake velocity deficits are 60-90%; leaving 30% is deliberate, because
// the lee of a building is never still air and a model that says it is reads
// as a bug rather than as shelter.
const SHELTER_MAX = 0.70;

// A canyon aligned with the flow speeds it up: the same air through a narrower
// section. Full-scale street measurements and CFD both give 1.2-1.6x the
// above-roof speed.
const CHANNEL_GAIN = 0.45;

// Air that meets a wall and cannot go through it goes up. The wall in question
// is the one DOWNWIND of the drone — a quad hanging off a windward face has the
// face between it and where the wind is going, so it is ray 4 that finds it,
// not ray 0. Ray 0 finding something means the drone is in that something's
// lee, where the air is going down if anything. Getting this backwards puts the
// lift on the wrong side of every building and reads as the wind pushing you
// out of a wake. Both rays involved are already being cast, so this is nearly
// free — and it is dynamic soaring off a facade, which is the most satisfying
// thing on this whole list.
const UPDRAFT_GAIN = 0.35;

// Roof-level shear layers and building wakes reach I ~ 0.3-0.5 where the
// approach flow is ~0.15, so two to four times. Deep in a wake these two sum
// to about three.
const TURB_NEAR = 0.8;
const TURB_WAKE = 1.2;
const TURB_MAX = 3.5;
// And a hard ceiling on the result. The boost above is a multiplier on a
// quantity that is already 0.43 near the ground, and 0.43 x 3.5 = 1.5 would
// mean the gusting is half again as strong as the wind itself — which is not
// turbulence, it is a different weather event. Measured roof-level and wake
// intensities top out around 0.5; 0.8 leaves room above every one of them and
// still keeps the field a perturbation of a mean rather than the other way up.
const I_HARD_MAX = 0.8;

// The trimesh has no interiors, so flying inside a building shell maxes every
// ray at once. Clamp the composed multiplier so shelter and channelling can
// never multiply into something absurd.
const SPEED_MIN = 0.20;
const SPEED_MAX = 1.60;

// Smooth the derived scalars, never the raw distances. At 10-25 m/s, 0.8 s is
// 8-20 m of travel — the same length scale as the 30 m probe, so the field
// changes over the same distance as the geometry that produced it. The height
// is smoothed four times faster because it has to track a rooftop edge, which
// is an edge, while a wake is a fade.
const TERRAIN_TAU = 0.8;
const AGL_TAU = 0.25;

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
function lag(prev, target, dt, tau) { return prev + (1 - Math.exp(-dt / tau)) * (target - prev); }

// ---------------------------------------------------------------------------
// Presets
//
// Named bundles rather than one slider per coefficient, same shape and same
// reasoning as RATE_PRESETS in flightController.js: the numbers belong with
// the model, not with the panel. Anchored on the Beaufort scale, so "vent
// frais" really is force 5.
//
// Direction is deliberately not part of a preset — it is orthogonal, and
// clicking "vent fort" should not move the wind to a different street.
export const WIND_PRESETS = {
	calme:   { label: 'calme',      speed: 0,  gust: 0,    turbulence: 0 },
	brise:   { label: 'brise',      speed: 4,  gust: 0.3,  turbulence: 0.5 },
	frais:   { label: 'vent frais', speed: 9,  gust: 0.55, turbulence: 0.8 },
	tempete: { label: 'tempête',    speed: 17, gust: 0.85, turbulence: 1.2 },
};

// A gust has three properties and the issue asks for all three, but three gust
// sliders on a flight panel is three sliders nobody moves. The one knob walks a
// line through them: a gustier setting means gusts that are bigger, sharper AND
// more frequent, which is how weather actually gets worse. The full triple stays
// reachable through setParams() for anyone tuning it.
//
//   peak      fraction of the local mean added at the top of the gust
//   duration  seconds, nothing to nothing
//   rate      gusts per minute
const GUST_PEAK = [0, 0.9];
const GUST_DURATION = [6.0, 2.0];
const GUST_RATE = [0, 20];
const MAX_GUSTS = 3;      // real gusts overlap; a queue of one makes a metronome

function lerp(range, t) { return range[0] + (range[1] - range[0]) * t; }

// ---------------------------------------------------------------------------

export class WindField {
	constructor(seed = 0x117d) {
		this.seed = seed >>> 0;
		this.rng = mulberry32(this.seed);

		this.speed = 0;          // m/s at Z_REF, the number a forecast would give
		this.direction = 0;      // degrees the wind comes FROM
		this.gust = 0;           // 0..1
		this.turbulence = 0;     // multiplier on the derived intensity, 0..~2
		this.gustPeak = 0;
		this.gustDuration = lerp(GUST_DURATION, 0);
		this.gustRate = 0;

		// Two Ornstein-Uhlenbeck processes for the meander. Ten-minute wind
		// records in the spectral gap show the direction wandering by 10-20 deg
		// and the speed by 10-20%, over tens of seconds — slow enough that by the
		// time you have flown a line and come back, it has moved.
		this._wanderDir = new Ou(this.rng);
		this._wanderMag = new Ou(this.rng);

		this._turb = [
			new DrydenAxis(this.rng, false),   // u, along the wind
			new DrydenAxis(this.rng, true),    // v, across it
			new DrydenAxis(this.rng, true),    // w, vertical
		];

		this._gusts = [];
		for (let i = 0; i < MAX_GUSTS; i++) this._gusts.push({ t: 0, len: 0, amp: 0, dx: 0, dz: 0, dy: 0 });

		// What physics.js measured, smoothed. Neutral until a probe arrives, so a
		// field with nothing attached behaves like open ground.
		this.agl = Z_REF;
		this._lastAgl = Z_REF;
		this._lastY = 0;
		this.shelter = 0;
		this.channel = 0;
		this.updraft = 0;
		this.roughness = 0;

		// Where the wind is blowing towards, mean and wander only. physics.js
		// reads this to aim the rosette — see the note in update().
		this.dirH = { x: 0, z: 1 };
		this.out = { x: 0, y: 0, z: 0 };
		this.local = 0;          // local mean speed, for the HUD and the tests
		this.intensity = 0;      // local turbulence intensity, drives the buffet
		this.reset();
	}

	// A respawn should not land in the middle of the gust that just put the quad
	// into a wall. Deterministic: the same seed replays the same weather, which
	// is what makes the headless checks stable rather than merely plausible.
	reset() {
		this.rng = mulberry32(this.seed);
		this._wanderDir.rng = this.rng;
		this._wanderMag.rng = this.rng;
		this._wanderDir.reset();
		this._wanderMag.reset();
		for (const t of this._turb) { t.a.rng = this.rng; t.reset(); }
		for (const g of this._gusts) g.t = 0;
		// -1 means "no arrival drawn yet". Zero would make a gust land on the
		// very first step of every reset, which is a rhythm nobody asked for.
		this._nextGust = -1;
		this.gusts = 0;
		this.agl = Z_REF;
		this._lastAgl = Z_REF;
		this._lastY = 0;
		this.shelter = 0; this.channel = 0; this.updraft = 0; this.roughness = 0;
		this.local = 0; this.intensity = 0;
		this.out.x = 0; this.out.y = 0; this.out.z = 0;
		this._setDirH(this.direction);
	}

	_setDirH(deg) {
		const h = (deg * Math.PI) / 180;
		this.dirH.x = -Math.sin(h);
		this.dirH.z = Math.cos(h);
	}

	// speed m/s at 10 m, direction in degrees the wind comes from, gust 0..1,
	// turbulence a multiplier on the intensity the profile already implies. Any
	// of the three gust details can be given explicitly to override what the
	// gust knob would have picked.
	setParams({ speed, direction, gust, turbulence, gustPeak, gustDuration, gustRate } = {}) {
		if (speed !== undefined) this.speed = Math.max(0, speed);
		if (direction !== undefined) {
			this.direction = ((direction % 360) + 360) % 360;
			this._setDirH(this.direction);
		}
		if (gust !== undefined) {
			this.gust = clamp01(gust);
			this.gustPeak = lerp(GUST_PEAK, this.gust);
			this.gustDuration = lerp(GUST_DURATION, this.gust);
			this.gustRate = lerp(GUST_RATE, this.gust);
		}
		if (turbulence !== undefined) this.turbulence = Math.max(0, turbulence);
		if (gustPeak !== undefined) this.gustPeak = Math.max(0, gustPeak);
		if (gustDuration !== undefined) this.gustDuration = Math.max(0.1, gustDuration);
		if (gustRate !== undefined) this.gustRate = Math.max(0, gustRate);
		return this;
	}

	// Nothing set means nothing runs: no probe, no filters advanced, no vector
	// added. The wind is then strictly free for anyone who never touches the
	// sliders — the same promise link.js makes at severity zero — and it is what
	// lets the headless check assert that calm is bit-identical to no wind model
	// at all, rather than merely close to it.
	get active() { return this.speed > 0; }

	// The unobstructed mean at 10 m as a world vector: the wind a forecast would
	// give, not the local one the drone happens to be sitting in. The HUD wants
	// this one.
	get nominal() {
		// From `direction`, not from `dirH`: dirH is the live direction including
		// the wander and the veer, which is what the probe has to be aimed along,
		// while this is the forecast — the number a pilot would have been told.
		const h = (this.direction * Math.PI) / 180;
		return { x: -Math.sin(h) * this.speed, y: 0, z: Math.cos(h) * this.speed };
	}

	// `probe` is a Float32Array of PROBE_COUNT ray distances in metres, each
	// equal to its PROBE_RANGE entry when the ray hit nothing. Null skips the
	// terrain entirely, which is what the pure-model checks do.
	// Height above ground from the down ray, or dead reckoning when it misses.
	// A miss is not "400 m up": the ray also comes back empty past the edge of
	// the tile and from underneath the shell, and reading either as altitude
	// would hand the pilot the 300 m gradient wind at street level. Carrying the
	// last good height forward and tracking the climb from it is exact over flat
	// ground and degrades gently over anything else.
	_height(probe, y) {
		const d = probe[PROBE_DOWN];
		if (d < PROBE_RANGE[PROBE_DOWN]) {
			this._lastAgl = d;
			this._lastY = y;
			return d;
		}
		return Math.max(0, this._lastAgl + (y - this._lastY));
	}

	_terrain(probe, y, dt) {
		if (!probe) {
			this.agl = lag(this.agl, y, dt, AGL_TAU);
			this.shelter = lag(this.shelter, 0, dt, TERRAIN_TAU);
			this.channel = lag(this.channel, 0, dt, TERRAIN_TAU);
			this.updraft = lag(this.updraft, 0, dt, TERRAIN_TAU);
			this.roughness = lag(this.roughness, 0, dt, TERRAIN_TAU);
			return;
		}

		// Proximity as a ramp, never as a flag. Same argument as link.js: a
		// photogrammetry mesh is a surface soup, rays flicker on and off across
		// it, and a flag turns that flicker into a switch. A ramp turns it into
		// an attenuation, which is also what the air actually does.
		const c = [];
		for (let i = 0; i < 8; i++) c.push(clamp01(1 - probe[i] / PROBE_RANGE[i]));
		const cUp = clamp01(1 - probe[PROBE_UP] / PROBE_RANGE[PROBE_UP]);

		// Weighted towards straight upwind: something at 45 degrees shelters you
		// partly, something behind you not at all.
		const shelter = clamp01(0.7 * c[0] + 0.15 * (c[1] + c[7]));

		// Walls on both sides and open along the wind: a street the flow is being
		// squeezed down. Both halves are needed — walls with a wall ahead too is
		// a courtyard, which shelters rather than channels.
		const lateral = Math.min(c[2], c[6]);
		const along = Math.max(c[0], c[4]);
		const channel = lateral * (1 - along);

		// A horizontal ray only hits if there is geometry at your own altitude,
		// so "am I below the rooftop line" comes out of the geometry for free:
		// climb above a building and its shelter fades on its own.
		let nearness = 0;
		for (let i = 0; i < 8; i++) nearness = Math.max(nearness, c[i]);

		const updraft = c[4] * (1 - cUp);

		this.agl = lag(this.agl, this._height(probe, y), dt, AGL_TAU);
		this.shelter = lag(this.shelter, shelter, dt, TERRAIN_TAU);
		this.channel = lag(this.channel, channel, dt, TERRAIN_TAU);
		this.updraft = lag(this.updraft, updraft, dt, TERRAIN_TAU);
		this.roughness = lag(this.roughness, nearness, dt, TERRAIN_TAU);
	}

	// The wind at the drone, world ENU m/s. Returns a reused object — this runs
	// 250 times a second.
	//
	//   y          world height, the fallback when no probe has landed yet
	//   probe      PROBE_COUNT ray distances, or null
	//   airspeed   how fast the quad is going through the air, for the advection
	//
	// The rosette has to be aimed upwind, and upwind is what this function
	// computes — so physics.js aims it with the PREVIOUS step's `dirH`. That is
	// a 48 ms lag against a field smoothed over 800 ms, and it is deliberate:
	// closing the loop properly would make it an actual circular dependency.
	update(y, probe, airspeed, dt) {
		const o = this.out;
		if (!this.active) {
			o.x = 0; o.y = 0; o.z = 0;
			this.local = 0; this.intensity = 0;
			return o;
		}

		this._terrain(probe, y, dt);

		const height = this.agl;
		let speed = this.speed * shearFactor(height);

		// Wander: the direction swings and the strength breathes.
		const bearing = this.direction + veer(height) + this._wanderDir.next(dt, 25) * 15;
		speed *= Math.max(0, 1 + this._wanderMag.next(dt, 25) * 0.15);

		const h = (bearing * Math.PI) / 180;
		let dx = -Math.sin(h);
		let dz = Math.cos(h);
		this.dirH.x = dx; this.dirH.z = dz;

		// Terrain, in the order the air meets it, and clamped as a whole because
		// shelter and channelling both multiply.
		const mul = Math.min(SPEED_MAX, Math.max(SPEED_MIN,
			(1 - SHELTER_MAX * this.shelter) * (1 + CHANNEL_GAIN * this.channel)));
		speed *= mul;
		this.local = speed;

		o.x = dx * speed;
		o.z = dz * speed;
		// Air climbing a windward face, proportional to the horizontal speed
		// because it is that air being turned, not a separate source.
		o.y = UPDRAFT_GAIN * speed * this.updraft;

		// Discrete gusts, Poisson-distributed: the wait for the next one is
		// exponential, which is what gives irregular arrivals instead of the
		// metronome a periodic model produces. Several can overlap.
		if (this.gustRate > 0) {
			const unscheduled = this._nextGust < 0;
			if (!unscheduled) this._nextGust -= dt;
			if (this._nextGust <= 0) {
				this._nextGust = -Math.log(Math.max(1e-9, this.rng())) / (this.gustRate / 60);
				// A free slot or nothing: with three of them and gusts a few
				// seconds long, arrivals are only dropped once the rate is high
				// enough that the air is continuously gusting anyway.
				const slot = unscheduled ? null : this._gusts.find((g) => g.t === 0);
				if (slot) {
					this.gusts++;
					slot.t = 1e-9;
					// Scattered around the knob: identical lengths become a rhythm,
					// and a rhythm is something a pilot learns and stops noticing.
					slot.len = this.gustDuration * (0.6 + this.rng() * 0.8);
					slot.amp = this.gustPeak * speed * (0.6 + this.rng() * 0.8);
					// Roughly with the mean but not exactly: a gust is a parcel of
					// air from higher up and it arrives having been turned.
					const gh = h + (this.rng() * 2 - 1) * 0.35;
					slot.dx = -Math.sin(gh);
					slot.dz = Math.cos(gh);
					// It was also brought down, so part of it is vertical. The
					// share is the same σw/σu the turbulence uses.
					slot.dy = SIGMA_W * (this.rng() * 2 - 1);
				}
			}
			for (const g of this._gusts) {
				if (g.t === 0) continue;
				g.t += dt;
				if (g.t >= g.len) { g.t = 0; continue; }
				// The 1-cosine discrete gust of MIL-F-8785C: no discontinuity at
				// either end, so the quad is pushed and released rather than
				// stepped and dropped. Its half-amplitude width is exactly len/2,
				// which is what makes the duration knob measurable.
				const env = g.amp * 0.5 * (1 - Math.cos((2 * Math.PI * g.t) / g.len));
				o.x += g.dx * env;
				o.z += g.dz * env;
				o.y += g.dy * env;
			}
		}

		// Turbulence last, because it rides on whatever the flow ended up being.
		// σ = I(z)·U(z) by construction, so sheltered air is calm air and a
		// channelled jet is a rough one without either being special-cased; and
		// near geometry it is worse again — that is the roof-edge shear layer and
		// the wake, and `roughness` is the only thing standing in for a CFD run.
		this.intensity = Math.min(I_HARD_MAX, turbulenceIntensity(height)
			* Math.min(TURB_MAX, 1 + TURB_NEAR * this.roughness + TURB_WAKE * this.shelter));
		if (this.turbulence > 0) {
			const sigma = this.turbulence * this.intensity * speed;
			const L = lengthScales(height);
			const V = advection(speed, airspeed);
			const u = this._turb[0].next(dt, L.u / V) * sigma;
			const v = this._turb[1].next(dt, L.u / V) * sigma * SIGMA_V;
			o.y += this._turb[2].next(dt, L.w / V) * sigma * SIGMA_W;
			// Generated along/across the wind, then rotated into the world.
			o.x += dx * u - dz * v;
			o.z += dz * u + dx * v;
		}

		return o;
	}
}

// Compass points. English (W for west, not O): the weather panel this used to
// label is gone since PHASE 04, and its only reader now is the world's forecast
// in the Operator Terminal, whose interface text is English like the rest of
// the game (D5). One table, so the sim never disagrees with itself about which
// way the wind is coming from.
const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
	'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

export function compassPoint(deg) {
	return POINTS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

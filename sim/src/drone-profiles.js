// Drone families. `quad.js` used to hard-code one 5" freestyle build; a target
// (PHASE 07) is one of these families with its own mass, inertia, props and a
// PID tune measured against that plant.
//
// This file is DATA ONLY — no logic. Everything here is SI units and the body
// frame the rest of the sim uses (X = right, Y = up, Z = back, forward = -Z).
// Inertia is {x: pitch, y: yaw, z: roll}.
//
// The `pid` block of every family is written by `tools/tune-pid.mjs --write`,
// never by hand (see CLAUDE.md). `p`/`d` are the swept rate-loop gains; `i` is
// tied to `p` through I_TIME in flightController.js; the feedforward is derived
// at construction as I_axis / torquePerMix[axis]. `torquePerMix` is the local
// slope "one mixer unit -> this much torque near a hover", measured off the
// airframe by the same bench.
//
// Numbers that were fitted rather than looked up carry the observation in a
// comment, same rule as quad.js. Where a family only scales the reference build,
// the ratio is stated instead of a second guessed value.
//
// radius is 0.15 m for EVERY family: it is the collision sphere and camera.near
// is pinned to it (see physics.js). It is not a real airframe dimension here.

// Placeholder tune shared by every family at creation time. `tune-pid.mjs
// --write all` replaces each family's block with gains measured against that
// family's own inertia and motor lag. Until then this is the freestyle5 tune,
// which is only correct for freestyle5.
const PLACEHOLDER_PID = {
	roll:  { p: 0.062, d: 0.0014 },
	pitch: { p: 0.066, d: 0.0015 },
	yaw:   { p: 0.220, d: 0.0005 },
	torquePerMix: { roll: 2.60, pitch: 2.60, yaw: 0.60 },
};

export const PROFILES = {
	// -------------------------------------------------------------------------
	// The reference build, byte-for-byte the old QUAD constant. 2207/2450KV on
	// 4S with 5x4.3x3 tri-blades — the most ordinary freestyle setup there is.
	// If this family's feel changes, the refactor broke something.
	freestyle5: {
		family: 'freestyle5',
		label: '5" FREESTYLE',
		rates: 'freestyle',
		mass: 0.65,
		radius: 0.15,
		armX: 0.078,
		armZ: 0.078,
		inertia: { x: 0.0032, y: 0.0058, z: 0.0030 },
		propRadius: 0.0635,
		propInertia: 4.0e-6,
		bladeCount: 3,
		maxThrustPerMotor: 10.0,
		maxOmega: 3140,
		rpmCurve: 0.65,
		tauSpinUp: 0.022,
		tauSpinDown: 0.045,
		torqueRatio: 0.019,
		kAxial: 3.0e-5,
		kLateral: 5.0e-5,
		bodyDrag: { x: 0.010, y: 0.028, z: 0.010 },
		battery: { cells: 4, capacityMah: 1300, internalOhm: 0.010, maxCurrent: 100 },
		pid: {
			roll:  { p: 0.062, d: 0.0014 },
			pitch: { p: 0.066, d: 0.0015 },
			yaw:   { p: 0.220, d: 0.0005 },
			torquePerMix: { roll: 2.60, pitch: 2.60, yaw: 0.60 },
		},
	},

	// -------------------------------------------------------------------------
	// A modern 6S race build: 2207/2650KV, 5x4.9x3, no HD camera, everything
	// stripped. Lighter and stiffer than the freestyle frame (~0.55 kg), so the
	// inertias are the freestyle values scaled by roughly (0.55/0.65) on mass
	// and (0.074/0.078)^2 on arm. Much higher thrust-to-weight (~9:1), a touch
	// less prop drag per newton (thinner air load on a cleaner build).
	race5: {
		family: 'race5',
		label: '5" RACE',
		rates: 'race',
		mass: 0.55,
		radius: 0.15,
		armX: 0.074,
		armZ: 0.074,
		inertia: { x: 0.0027, y: 0.0049, z: 0.0025 },
		propRadius: 0.0635,
		propInertia: 3.6e-6,
		bladeCount: 3,
		maxThrustPerMotor: 12.5,
		maxOmega: 3560,
		rpmCurve: 0.65,
		tauSpinUp: 0.020,
		tauSpinDown: 0.042,
		torqueRatio: 0.018,
		kAxial: 3.0e-5,
		kLateral: 4.6e-5,
		bodyDrag: { x: 0.009, y: 0.025, z: 0.009 },
		battery: { cells: 6, capacityMah: 1300, internalOhm: 0.012, maxCurrent: 115 },
		pid: { ...PLACEHOLDER_PID },
	},

	// -------------------------------------------------------------------------
	// A ducted 3" cinewhoop carrying a full-size GoPro: 1404/3800KV on 4S, 3"
	// tri-blades inside ducts. The ducts are the whole character — they add
	// static thrust but they are bluff bodies, so body drag and rotor H-force
	// are 3x the open-frame values and top speed collapses. Thrust-to-weight is
	// deliberately low (~2.8:1): a cinewhoop is not meant to rocket. Yaw inertia
	// is relatively high because the duct mass sits out at radius.
	cinewhoop: {
		family: 'cinewhoop',
		label: 'CINEWHOOP',
		rates: 'cinematic',
		mass: 0.60,
		radius: 0.15,
		armX: 0.060,
		armZ: 0.060,
		inertia: { x: 0.0022, y: 0.0040, z: 0.0021 },
		propRadius: 0.0381,
		propInertia: 1.8e-6,
		bladeCount: 3,
		maxThrustPerMotor: 4.1,
		maxOmega: 4200,
		rpmCurve: 0.62,
		tauSpinUp: 0.026,
		tauSpinDown: 0.052,
		torqueRatio: 0.024,          // ducted props run at higher blade loading
		kAxial: 4.5e-5,
		kLateral: 1.0e-4,            // ducts fight translation hard
		bodyDrag: { x: 0.030, y: 0.045, z: 0.030 },
		battery: { cells: 4, capacityMah: 1100, internalOhm: 0.014, maxCurrent: 70 },
		pid: { ...PLACEHOLDER_PID },
	},

	// -------------------------------------------------------------------------
	// A 7" long-range cruiser: 2806.5/1300KV on 6S, 7x4x3, a 3000 mAh pack.
	// Heavy (~0.92 kg) with long arms, so every inertia is roughly 2.4x the
	// freestyle value. Big slow props: low maxOmega, long motor lag, and a large
	// disc that both drags sideways more and loses more thrust to axial inflow.
	// Efficient in cruise (low horizontal body drag) but a big flat plate when
	// falling.
	longrange: {
		family: 'longrange',
		label: 'LONG RANGE',
		rates: 'longrange',
		mass: 0.92,
		radius: 0.15,
		armX: 0.105,
		armZ: 0.105,
		inertia: { x: 0.0078, y: 0.0140, z: 0.0072 },
		propRadius: 0.0889,
		propInertia: 1.1e-5,
		bladeCount: 3,
		maxThrustPerMotor: 9.5,
		maxOmega: 2450,
		rpmCurve: 0.66,
		tauSpinUp: 0.032,
		tauSpinDown: 0.068,
		torqueRatio: 0.021,
		kAxial: 5.5e-5,
		kLateral: 8.0e-5,
		bodyDrag: { x: 0.012, y: 0.040, z: 0.012 },
		battery: { cells: 6, capacityMah: 3000, internalOhm: 0.010, maxCurrent: 90 },
		pid: { ...PLACEHOLDER_PID },
	},

	// -------------------------------------------------------------------------
	// A cinematic 5" hauling a naked GoPro on top: 2207/1960KV on 6S, same
	// 5x4.3x3 props as freestyle. Same frame, much more all-up weight (~0.85 kg)
	// so inertias are ~1.55x freestyle and it feels planted. Thrust-to-weight
	// around 5:1 — enough to be smooth, not enough to be violent.
	heavy5: {
		family: 'heavy5',
		label: 'HEAVY 5"',
		rates: 'cinematic',
		mass: 0.85,
		radius: 0.15,
		armX: 0.080,
		armZ: 0.080,
		inertia: { x: 0.0050, y: 0.0090, z: 0.0047 },
		propRadius: 0.0635,
		propInertia: 4.0e-6,
		bladeCount: 3,
		maxThrustPerMotor: 10.5,
		maxOmega: 3000,
		rpmCurve: 0.65,
		tauSpinUp: 0.024,
		tauSpinDown: 0.048,
		torqueRatio: 0.019,
		kAxial: 3.2e-5,
		kLateral: 5.2e-5,
		bodyDrag: { x: 0.011, y: 0.032, z: 0.011 },
		battery: { cells: 6, capacityMah: 1300, internalOhm: 0.011, maxCurrent: 100 },
		pid: { ...PLACEHOLDER_PID },
	},

	// -------------------------------------------------------------------------
	// A 1S tinywhoop, 65-75 mm: 0802/22000KV, 40 mm ducted tri-blades, ~32 g
	// all-up. Inertia is dominated by the four motor masses at a 26 mm arm
	// (4 * ~0.003 kg * 0.026^2 ~ 8e-6) plus a little frame. Tiny props spin up
	// almost instantly (8 ms). A 1S pack has a huge internal resistance, so it
	// sags dramatically under the ~8 A it can pull. Thrust-to-weight ~2:1 and
	// the mass is so low that any real wind tosses it around.
	microwhoop: {
		family: 'microwhoop',
		label: 'MICRO WHOOP',
		rates: 'micro',
		mass: 0.032,
		radius: 0.15,
		armX: 0.026,
		armZ: 0.026,
		inertia: { x: 8.0e-6, y: 1.4e-5, z: 7.5e-6 },
		propRadius: 0.0200,
		propInertia: 2.0e-8,
		bladeCount: 3,
		maxThrustPerMotor: 0.16,
		maxOmega: 5200,
		rpmCurve: 0.60,
		tauSpinUp: 0.008,
		tauSpinDown: 0.020,
		torqueRatio: 0.020,
		kAxial: 3.5e-5,
		kLateral: 6.0e-5,
		bodyDrag: { x: 0.0006, y: 0.0011, z: 0.0006 },
		battery: { cells: 1, capacityMah: 300, internalOhm: 0.080, maxCurrent: 8 },
		pid: { ...PLACEHOLDER_PID },
	},

	// -------------------------------------------------------------------------
	// A 2.5" toothpick: 1102/11000KV on 2S, bi-blade props, ~75 g. Open frame,
	// so unlike the whoop there is no duct drag — it is a scaled-down freestyle
	// quad, twitchy and quick, thrust-to-weight ~3.9:1. Bi-blade props: the
	// audio blade-pass sits an octave lower per rpm than the tri-blade families.
	toothpick: {
		family: 'toothpick',
		label: 'TOOTHPICK',
		rates: 'freestyle',
		mass: 0.075,
		radius: 0.15,
		armX: 0.038,
		armZ: 0.038,
		inertia: { x: 2.6e-5, y: 4.6e-5, z: 2.4e-5 },
		propRadius: 0.0318,
		propInertia: 2.0e-7,
		bladeCount: 2,
		maxThrustPerMotor: 0.72,
		maxOmega: 4600,
		rpmCurve: 0.62,
		tauSpinUp: 0.010,
		tauSpinDown: 0.024,
		torqueRatio: 0.018,
		kAxial: 3.0e-5,
		kLateral: 4.4e-5,
		bodyDrag: { x: 0.0018, y: 0.0050, z: 0.0018 },
		battery: { cells: 2, capacityMah: 300, internalOhm: 0.050, maxCurrent: 15 },
		pid: { ...PLACEHOLDER_PID },
	},
};

// Ordered so tools iterate the reference build first.
export const FAMILIES = [
	'freestyle5', 'race5', 'cinewhoop', 'longrange', 'heavy5', 'microwhoop', 'toothpick',
];

export const DEFAULT_FAMILY = 'freestyle5';
export const DEFAULT_PROFILE = PROFILES[DEFAULT_FAMILY];

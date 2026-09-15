// Drone families. `quad.js` used to hard-code one 5" freestyle build; a target
// (PHASE 07) is one of these families with its own mass, inertia, props and a
// PID tune measured against that plant.
//
// This file is DATA ONLY — no logic. Everything here is SI units and the body
// frame the rest of the sim uses (X = right, Y = up, Z = back, forward = -Z).
// Inertia is {x: pitch, y: yaw, z: roll}.
//
// `rpmCurve`, `tauSpinUp` and `tauSpinDown` are GONE. They were three fitted
// constants standing in for one mechanism, and src/motor.js now derives all
// three from the torque balance of the motor named in each family's comment —
// so `motor: { kv, noLoadCurrent }` replaces them, and winding resistance is
// derived from maxOmega rather than stored.
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
//
// SPEC SCHEMA (SPEC_PHYSIQUE_VOL.md). The seven fields below are carried by
// every family so the lots that port the spec's models have somewhere to put
// their settings. Each default is the value that reproduces TODAY's behaviour
// exactly, so adding them moved no number:
//
//   rateFamily       which of the five rate formulas of spec §5 this family
//                    flies: 'betaflight' (type 0), 'actual' (1), 'raceflight'
//                    (2), 'kiss' (3), 'quick' (4). 'actual' is what
//                    flightController.js:actualRate() already implements.
//   throttleBands    the three independently weighted thirds of the throttle
//                    travel of §6.2, {low, med, high}; 1/1/1 is the flat curve.
//   minThrottle      throttle floor as a fraction 0..1, §6.1's MinThrottle. 0 is
//                    today's "the stick is the command"; the spec's own presets
//                    use 0.055.
//   dragScale        multiplier on bodyDrag, §8.3's `echelle_trainee` indexed by
//                    prop diameter. 1 leaves the measured bodyDrag alone.
//   escCurrentLimit  amps one ESC will let through, PER MOTOR, on the winding
//                    current -- that is what a real ESC limits and what
//                    src/motor.js implements. Not the pack total: a value taken
//                    from `battery.maxCurrent` would be four times too large.
//                    null = uncapped, which is what src/motor.js does today.
//   dischargeCurve   which §11 discharge curve the pack follows: 'lipo'
//                    (default), 'liion', or 'legacy' for the analytic curve
//                    src/battery.js used before the spec curves landed. Lives on
//                    `battery`, beside the cells and the capacity.
//   gyroNoise        gyro noise injected into the rate loop, rad/s RMS. 0 is a
//                    perfect gyro, which is what the loop reads today.
//   loopDelay        extra control-loop latency in seconds, on top of the fixed
//                    step. 0 is today's zero-latency loop.
//
// These defaults are NOT a tune: a lot that starts using a field replaces the
// default with a measured value for that family, and says so in a comment.

// Every family's `pid` block is written by `node tools/tune-pid.mjs --write
// <family|all>`, which sweeps P/D against that family's own inertia and motor
// lag and measures torquePerMix off its mixer. The blocks below that are not
// freestyle5 start life holding the freestyle5 tune (only correct for
// freestyle5) and are correct once --write all has been run and committed.

// ---------------------------------------------------------------------------
// WHERE THE HARDWARE NUMBERS COME FROM
//
// Every family below is a bill of materials taken from the spec catalogue
// (src/spec-data/: motors.js, propellers.js, frames.js, batteries.js — part
// number, KV, mass, diameter, pitch, cells, capacity, C rating, nothing else).
// The three numbers that are NOT in the catalogue — maxOmega, maxThrustPerMotor
// and battery.maxCurrent — are derived from it by the three rules below, each
// anchored on freestyle5, which stays byte-for-byte the reference build.
//
// 1. RPM. A loaded rotor never reaches kv * volts: it settles where the prop's
//    torque meets the motor's. The reference build measures
//        maxOmega / (kv * cells * 4.0 V) = 29985 / 39200 = 0.765
//    and that droop is what every family that had no measurement of its own now
//    uses:  maxOmega = 0.765 * kv * cells * 4.0 V.  (4.0 V is the spec's cell
//    under load, §13.) heavy5 is the exception: it flies the spec's own worked
//    example — 6S, 1750 KV, 5" — for which §13 states the answer outright,
//    ~35 000 rpm, a droop of 0.833.
//
// 2. STATIC THRUST. Propeller thrust is T = C_T * rho * n^2 * D^4 with n in
//    rev/s. C_T is not free: it scales with the pitch-to-diameter ratio and,
//    sub-linearly, with blade count (each blade works in the wake of the last —
//    the BEMT solidity exponent, 0.75). Anchored on the reference build
//    (10.0 N at 29985 rpm on a 5x4.3x3, i.e. C_T = 0.1256 at p/D = 0.86):
//        C_T = 0.1460 * (pitch/D) * (blades/3)^0.75
//        T   = C_T * 1.225 * n^2 * D^4
//    Only the cinewhoop departs from it, by the +15% static augmentation a
//    shrouded rotor is worth — the ducts are the whole point of the airframe.
//
// 3. PACK CURRENT. `maxCurrent` is documented as "A at four motors flat out",
//    so it is the build's own draw, not the pack's rating:
//        I = 0.67 * 4 * maxThrustPerMotor * torqueRatio * maxOmega
//                / (cells * 4.0 V)
//    where the 0.67 is the one constant that makes the formula reproduce the
//    reference build's 100 A (it stands in for motor/ESC efficiency and for
//    torqueRatio being a ratio, not a measured shaft torque).
//
// 4. PACK RESISTANCE. `internalOhm` is cells * 2.5 mOhm * (1300 / capacityMah):
//    the reference 4S 1300 measures 2.5 mOhm a cell, and cell resistance goes
//    as 1/capacity within one chemistry and format. It is NOT applied below
//    ~1 Ah — see the toothpick, where a 420 mAh cell measures four times what
//    that extrapolation would claim.
// ---------------------------------------------------------------------------

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
		// Geometric pitch in metres (5x4.3x3, the pitch is the 4.3). src/blade-element.js turns it
		// into the blade's twist directly — atan(pitch / 2*pi*r) — so this is
		// real hardware, not a coefficient.
		propPitch: 0.1092,
		maxThrustPerMotor: 10.0,
		maxOmega: 3140,
		// The motor itself (src/motor.js). KV is the one this family's own
		// comment already names; noLoadCurrent is a 2207 at its nominal pack.
		// Winding resistance is NOT stored: motor.js derives it from maxOmega,
		// so top-end rpm stays authoritative and this block adds no fitted
		// constant.
		motor: { kv: 2450, noLoadCurrent: 1.0 },
		torqueRatio: 0.019,
		// inflowGain/buffetGain/lateralGain are corrections against
		// quad.js's disk-area formula for kInflow/kBuffet/kLateral (see
		// INFLOW_K0/LATERAL_K0 there) — 1 here means this family's disk
		// already sits on the measured big-prop constant.
		inflowGain: 1.000535,
		buffetGain: 1.000535,
		lateralGain: 0.999253,
		bodyDrag: { x: 0.010, y: 0.028, z: 0.010 },
		battery: { cells: 4, capacityMah: 1300, internalOhm: 0.010, maxCurrent: 100, dischargeCurve: 'lipo' },
		rateFamily: 'actual',
		throttleBands: { low: 1, med: 1, high: 1 },
		minThrottle: 0,
		dragScale: 1,
		escCurrentLimit: null,
		gyroNoise: 0,
		loopDelay: 0,
		pid: {
			roll:  { p: 0.062, d: 0.0014 },
			pitch: { p: 0.066, d: 0.0015 },
			yaw:   { p: 0.220, d: 0.0005 },
			torquePerMix: { roll: 2.60, pitch: 2.60, yaw: 0.60 },
		},
	},

	// -------------------------------------------------------------------------
	// A modern 6S race build, from the catalogue: frame `racer5` (180 g, no HD
	// camera), four `1900-2207` (34 g each), four `5146` race props (5x4.6x3,
	// 4 g), a `6s-1050` pack (170 g). 502 g of parts plus ~48 g of analogue
	// camera, VTX, RX and straps is the 0.55 kg below — the same ~50 g allowance
	// the reference build carries. Lighter and stiffer than the freestyle frame,
	// so the inertias are the freestyle values scaled by roughly (0.55/0.65) on
	// mass and (0.074/0.078)^2 on arm.
	//
	// 2650 KV on 6S was not a real part: no catalogue motor turns that fast on
	// six cells, and the old maxOmega sat at 0.535 of it, which is a build whose
	// KV and whose rpm describe two different motors. 1900 KV is what a 6S race
	// quad actually runs.
	//   maxOmega = 0.765 * 1900 * 6 * 4.0 V = 34 884 rpm = 3653 rad/s
	//   T = 0.1460*(4.6/5) * 1.225 * (34884/60)^2 * 0.127^4 = 14.5 N
	// 14.5 N a corner on 0.55 kg is 10.7:1, which is the class.
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
		// Geometric pitch in metres (catalogue `5146`, 5x4.6x3: 4.6 * 0.0254).
		// src/blade-element.js turns it
		// into the blade's twist directly — atan(pitch / 2*pi*r) — so this is
		// real hardware, not a coefficient.
		propPitch: 0.11684,
		maxThrustPerMotor: 14.5,
		maxOmega: 3653,
		// The motor itself (src/motor.js). KV is the one this family's own
		// comment already names; noLoadCurrent is a 2207 at its nominal pack.
		// Winding resistance is NOT stored: motor.js derives it from maxOmega,
		// so top-end rpm stays authoritative and this block adds no fitted
		// constant.
		motor: { kv: 1900, noLoadCurrent: 1.0 },
		torqueRatio: 0.018,
		inflowGain: 1.014607,
		buffetGain: 1.014607,
		lateralGain: 0.919313,
		bodyDrag: { x: 0.009, y: 0.025, z: 0.009 },
		// Catalogue `6s-1050` (170 g, 95C). internalOhm = 6 * 2.5 * 1300/1050
		// mOhm; maxCurrent is rule 3 above, 106 A — a hair over the pack's own
		// 100 A rating, which is what racing a pack at its rating means.
		battery: { cells: 6, capacityMah: 1050, internalOhm: 0.0186, maxCurrent: 106, dischargeCurve: 'lipo' },
		rateFamily: 'actual',
		throttleBands: { low: 1, med: 1, high: 1 },
		minThrottle: 0,
		dragScale: 1,
		escCurrentLimit: null,
		gyroNoise: 0,
		loopDelay: 0,
		pid: {
			roll:  { p: 0.03, d: 5.00e-4 },
			pitch: { p: 0.03, d: 5.00e-4 },
			yaw:   { p: 0.34, d: 0 },
			torquePerMix: { roll: 3.064, pitch: 3.064, yaw: 0.745 },
		},
	},

	// -------------------------------------------------------------------------
	// A ducted 3" cinewhoop carrying a full-size GoPro, from the catalogue:
	// frame `Micro3_PG` (3" whoop, 233 g), four `3800-1404` (9 g each), four
	// `3028` props (3x2.8x3, 2 g), a `4s-1300` pack (156 g). 433 g of parts plus
	// a 153 g GoPro is the 0.60 kg below.
	//   maxOmega = 0.765 * 3800 * 4 * 4.0 V = 46 512 rpm = 4871 rad/s
	//   T = 0.1460*(2.8/3) * 1.225 * (46512/60)^2 * 0.0762^4 = 3.38 N open,
	//       x1.15 for the shroud = 3.89 N
	// 3.89 N a corner on 0.60 kg is 2.6:1 — deliberately low, as before: a
	// cinewhoop is not meant to rocket. The ducts are the whole character — they
	// add static thrust but they are bluff bodies, so body drag and rotor
	// H-force are 3x the open-frame values and top speed collapses. Yaw inertia
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
		// Geometric pitch in metres (catalogue `3028`, 3x2.8x3: 2.8 * 0.0254).
		// src/blade-element.js turns it
		// into the blade's twist directly — atan(pitch / 2*pi*r) — so this is
		// real hardware, not a coefficient.
		propPitch: 0.07112,
		maxThrustPerMotor: 3.89,
		maxOmega: 4871,
		// The motor itself (src/motor.js). KV is the one this family's own
		// comment already names; noLoadCurrent is a 1404 at its nominal pack.
		// Winding resistance is NOT stored: motor.js derives it from maxOmega,
		// so top-end rpm stays authoritative and this block adds no fitted
		// constant.
		motor: { kv: 3800, noLoadCurrent: 0.5 },
		torqueRatio: 0.024,          // ducted props run at higher blade loading
		inflowGain: 2.322297,        // small disk (3.8 cm prop) needs real correction
		buffetGain: 2.322297,
		lateralGain: 1.942993,       // ducts fight translation hard
		bodyDrag: { x: 0.030, y: 0.045, z: 0.030 },
		// Catalogue `4s-1300` (156 g, 150C) — the same pack as the reference
		// build, so the same 0.010 ohm. maxCurrent is rule 3 above.
		battery: { cells: 4, capacityMah: 1300, internalOhm: 0.010, maxCurrent: 76, dischargeCurve: 'lipo' },
		rateFamily: 'actual',
		throttleBands: { low: 1, med: 1, high: 1 },
		minThrottle: 0,
		dragScale: 1,
		escCurrentLimit: null,
		gyroNoise: 0,
		loopDelay: 0,
		pid: {
			roll:  { p: 0.098, d: 1.90e-3 },
			pitch: { p: 0.098, d: 1.90e-3 },
			yaw:   { p: 0.34, d: 0 },
			torquePerMix: { roll: 1.038, pitch: 1.038, yaw: 0.415 },
		},
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
		// Geometric pitch in metres (7x4x3). src/blade-element.js turns it
		// into the blade's twist directly — atan(pitch / 2*pi*r) — so this is
		// real hardware, not a coefficient.
		propPitch: 0.1016,
		maxThrustPerMotor: 10.5,   // 2806.5 on 6S pulls well over 1 kgf a corner
		maxOmega: 2450,
		// The motor itself (src/motor.js). KV is the one this family's own
		// comment already names; noLoadCurrent is a 2806.5 at its nominal pack.
		// Winding resistance is NOT stored: motor.js derives it from maxOmega,
		// so top-end rpm stays authoritative and this block adds no fitted
		// constant.
		motor: { kv: 1300, noLoadCurrent: 1.2 },
		torqueRatio: 0.021,
		inflowGain: 0.997672,
		buffetGain: 0.997672,
		lateralGain: 0.917682,
		bodyDrag: { x: 0.012, y: 0.040, z: 0.012 },
		battery: { cells: 6, capacityMah: 3000, internalOhm: 0.010, maxCurrent: 90, dischargeCurve: 'lipo' },
		rateFamily: 'actual',
		throttleBands: { low: 1, med: 1, high: 1 },
		minThrottle: 0,
		dragScale: 1,
		escCurrentLimit: null,
		gyroNoise: 0,
		loopDelay: 0,
		pid: {
			roll:  { p: 0.084, d: 1.90e-3 },
			pitch: { p: 0.084, d: 1.90e-3 },
			yaw:   { p: 0.34, d: 0 },
			torquePerMix: { roll: 4.199, pitch: 4.199, yaw: 0.840 },
		},
	},

	// -------------------------------------------------------------------------
	// A cinematic 5" hauling a GoPro on top, from the catalogue: frame `Free5`
	// (280 g), four `1750-2306` (33 g each), four `5136` freestyle props
	// (5x3.6x3, 4 g), a `6s-1700` pack (262 g), plus a 153 g GoPro — 843 g, the
	// 0.85 kg below. Same frame as freestyle5, much more all-up weight, so
	// inertias are ~1.55x freestyle and it feels planted.
	//
	// 1960 KV on 6S was not a real part (the catalogue has no such motor, and a
	// 6S 5" does not run a 4S KV). 1750 KV on 6S is the spec's OWN worked
	// example, §13 — and §13 also states its answer, ~35 000 rpm after losses,
	// so this is the one family whose maxOmega is quoted rather than derived:
	//   maxOmega = 35 000 rpm = 3665 rad/s  (a droop of 0.833, the spec's)
	//   T = 0.1460*(3.6/5) * 1.225 * (35000/60)^2 * 0.127^4 = 11.41 N
	// 11.41 N a corner on 0.85 kg is 5.5:1 — enough to be smooth, not enough to
	// be violent, which is what this family is for. The low-pitch 5136 rather
	// than freestyle5's 5043 is part of that: a heavy cinematic build trades
	// pitch speed for smoothness.
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
		// Geometric pitch in metres (catalogue `5136`, 5x3.6x3: 3.6 * 0.0254).
		// src/blade-element.js turns it
		// into the blade's twist directly — atan(pitch / 2*pi*r) — so this is
		// real hardware, not a coefficient.
		propPitch: 0.09144,
		maxThrustPerMotor: 11.41,
		maxOmega: 3665,
		// The motor itself (src/motor.js). KV is the one this family's own
		// comment already names; noLoadCurrent is a 2306 at its nominal pack.
		// Winding resistance is NOT stored: motor.js derives it from maxOmega,
		// so top-end rpm stays authoritative and this block adds no fitted
		// constant.
		motor: { kv: 1750, noLoadCurrent: 1.0 },
		torqueRatio: 0.019,
		inflowGain: 0.995080,
		buffetGain: 0.995080,
		lateralGain: 1.039223,
		bodyDrag: { x: 0.011, y: 0.032, z: 0.011 },
		// Catalogue `6s-1700` (262 g, 100C). internalOhm = 6 * 2.5 * 1300/1700
		// mOhm; maxCurrent is rule 3 above.
		battery: { cells: 6, capacityMah: 1700, internalOhm: 0.0115, maxCurrent: 89, dischargeCurve: 'lipo' },
		rateFamily: 'actual',
		throttleBands: { low: 1, med: 1, high: 1 },
		minThrottle: 0,
		dragScale: 1,
		escCurrentLimit: null,
		gyroNoise: 0,
		loopDelay: 0,
		pid: {
			roll:  { p: 0.054, d: 1.00e-3 },
			pitch: { p: 0.054, d: 1.00e-3 },
			yaw:   { p: 0.34, d: 0 },
			torquePerMix: { roll: 3.276, pitch: 3.276, yaw: 0.778 },
		},
	},

	// -------------------------------------------------------------------------
	// The MICRO family: a 2.5" toothpick, from the catalogue: frame `KM_2-5`
	// (2.5" Kayoumini, 44 g), four `8000-1103` (5 g each), four `2521` props
	// (2.5x2.1x2, 1 g), a `2s-420` pack (22 g). That is exactly the 90 g below,
	// with no allowance left over — an AIO micro has nothing else on it. Open
	// frame, so no duct drag. The long booms and the nose-mounted cam/vtx put
	// more inertia on it than a bare 2.5" frame would (~6e-5 about roll).
	// Bi-blade props: the audio blade-pass sits an octave lower per rpm than the
	// tri-blade families.
	//
	// THIS FAMILY WAS THE WORST DATA DEFECT OF THE SIX. 11000 KV on 2S is a real
	// part, but its maxOmega sat at 0.499 of the rpm that KV implies — a machine
	// described by one motor and flown as another — and 0.68 N a corner left it
	// at 3.08:1, where a real 2.5" is 4-6:1. The 11000 KV motor is the one that
	// does not fit: at the reference droop it would turn 67 000 rpm, Mach 0.65
	// at the tip. The 8000 KV of the same 1103 is the part whose rpm and whose
	// thrust describe the same quad:
	//   maxOmega = 0.765 * 8000 * 2 * 4.0 V = 48 960 rpm = 5127 rad/s
	//   T = 0.1460*(2.1/2.5)*(2/3)^0.75 * 1.225 * (48960/60)^2 * 0.0635^4
	//     = 1.20 N  (122 gf a corner, what a 1103 on 2S is sold as)
	// 1.20 N a corner on 90 g is 5.4:1, the class.
	//
	// (A 1S 65 mm tinywhoop was prototyped too but pulled — see issue #71.
	// Splitting the old single `kAxial` into kInflowOf/kBuffetOf/kLateralOf
	// (quad.js) was necessary but not sufficient: holding a full-stick roll
	// long enough eventually makes THIS family's pitch/yaw diverge too (~2.8 s
	// in, well past the 1.2 s selftest window), and it is real rigid-body
	// physics — reproduces with every quad.js coupling term and every PID term
	// zeroed. A 34 g build hits the same wall inside ~1 s. Tracked separately,
	// not an aero-coefficient problem.)
	toothpick: {
		family: 'toothpick',
		label: 'MICRO',
		rates: 'micro',
		// The rate loop's filter chain is a 5" assumption; a 2.5" airframe's
		// rotational dynamics are twice as fast, so its filters (roll/pitch only,
		// see flightController.js) run twice as high, as a real micro build's do.
		filterScale: 2.0,
		mass: 0.090,
		radius: 0.15,
		armX: 0.038,
		armZ: 0.038,
		// x within ~2% of z: a wider pitch/roll split would make pitch the
		// intermediate axis, and a held high rate about the intermediate axis is
		// unstable on its own (tennis-racket theorem).
		inertia: { x: 5.7e-5, y: 1.3e-4, z: 5.6e-5 },
		propRadius: 0.03175,
		propInertia: 3.0e-7,
		bladeCount: 2,
		// Geometric pitch in metres (catalogue `2521`, 2.5x2.1x2: 2.1 * 0.0254).
		// src/blade-element.js turns it
		// into the blade's twist directly — atan(pitch / 2*pi*r) — so this is
		// real hardware, not a coefficient.
		propPitch: 0.05334,
		maxThrustPerMotor: 1.20,
		maxOmega: 5127,
		// The motor itself (src/motor.js). KV is the one this family's own
		// comment already names; noLoadCurrent is a 1103 at its nominal pack.
		// Winding resistance is NOT stored: motor.js derives it from maxOmega,
		// so top-end rpm stays authoritative and this block adds no fitted
		// constant.
		motor: { kv: 8000, noLoadCurrent: 0.2 },
		torqueRatio: 0.014,        // bi-blade 2.5" props: modest prop-drag torque, loose yaw
		inflowGain: 2.806033,      // small disk (3.2 cm prop) needs real correction
		buffetGain: 2.806033,
		lateralGain: 1.035958,
		bodyDrag: { x: 0.0018, y: 0.0050, z: 0.0018 },
		// Catalogue `2s-420` (22 g, 80C). internalOhm is NOT rule 4: extrapolating
		// the reference pack's 2.5 mOhm/cell down to 420 mAh would claim 7.7
		// mOhm a cell, and a 2S micro pack measures four times that. The 45 mOhm
		// here is the measurement that was already in this profile. maxCurrent is
		// rule 3 above, 29 A, inside the pack's own 34 A rating.
		battery: { cells: 2, capacityMah: 420, internalOhm: 0.045, maxCurrent: 29, dischargeCurve: 'lipo' },
		rateFamily: 'actual',
		throttleBands: { low: 1, med: 1, high: 1 },
		minThrottle: 0,
		dragScale: 1,
		escCurrentLimit: null,
		gyroNoise: 0,
		loopDelay: 0,
		pid: {
			roll:  { p: 0.08, d: 1.00e-3 },
			pitch: { p: 0.08, d: 1.00e-3 },
			yaw:   { p: 0.24, d: 5.00e-4 },
			torquePerMix: { roll: 0.162, pitch: 0.162, yaw: 0.060 },
		},
	},

	// -------------------------------------------------------------------------
	// The 7th family, deliberately NOT in FAMILIES (src/drone-profiles.js) nor
	// in TARGET_FAMILIES/FAMILY_CLASS (tools/target-model.mjs): the command
	// node of a hacked cluster, never an ordinary scan candidate, never an
	// ambient (issue #29 spec, section "swarmNode"). It is reached only by
	// generateTargetScan's swarm hack forcing a candidate's family.
	//
	// A command 6": link dome on top, two antennas, bare camera, no GoPro. From
	// the catalogue: frame `Free6` (300 g), four `1500-2807` (47 g each), four
	// `6030` props (6x3.0x3, 7 g), a `6s-1700` pack (262 g) — 778 g, plus ~170 g
	// of mesh radio gear at the mast, the 0.95 kg below. Sits between heavy5 and
	// longrange — a 6" frame (armX/armZ, propRadius) but heavier than either at
	// the mast, so it carries its momentum like longrange without longrange's
	// reach. The low-pitch 6030 rather than a 6045 is the same trade heavy5
	// makes, and is why it has no reach.
	//   maxOmega = 0.765 * 1500 * 6 * 4.0 V = 27 540 rpm = 2884 rad/s
	//   T = 0.1460*(3.0/6) * 1.225 * (27540/60)^2 * 0.1524^4 = 10.2 N  (4.4:1)
	//
	// inertia and torqueRatio are still heavy5 scaled to this mass/arm/prop,
	// linearly interpolated toward longrange where the prop is genuinely
	// bigger; inflowGain/buffetGain/lateralGain are the same heavy5<->longrange
	// interpolation, unmeasured. bodyDrag gets a small bump over that
	// interpolation for the dome and antennas. All of it is a starting point to
	// confirm at the bench, per the spec — `pid` alone is the exception: it is
	// the real measured tune from `node tools/tune-pid.mjs --write swarmNode`,
	// not a guess.
	swarmNode: {
		family: 'swarmNode',
		label: 'SWARM NODE',
		rates: 'cinematic',
		mass: 0.95,
		radius: 0.15,
		armX: 0.090,
		armZ: 0.090,
		inertia: { x: 0.0071, y: 0.0127, z: 0.0067 },
		propRadius: 0.0762,
		propInertia: 6.9e-6,
		bladeCount: 3,
		// Geometric pitch in metres (catalogue `6030`, 6x3.0x3: 3.0 * 0.0254).
		// src/blade-element.js turns it
		// into the blade's twist directly — atan(pitch / 2*pi*r) — so this is
		// real hardware, not a coefficient.
		propPitch: 0.0762,
		maxThrustPerMotor: 10.2,   // TWR ~= 4.4 at this mass
		maxOmega: 2884,
		// The motor itself (src/motor.js). KV is the one this family's own
		// comment already names; noLoadCurrent is a 2806-class at its nominal pack.
		// Winding resistance is NOT stored: motor.js derives it from maxOmega,
		// so top-end rpm stays authoritative and this block adds no fitted
		// constant.
		motor: { kv: 1500, noLoadCurrent: 1.2 },
		torqueRatio: 0.020,
		inflowGain: 0.996376,
		buffetGain: 0.996376,
		lateralGain: 0.978452,
		bodyDrag: { x: 0.012, y: 0.038, z: 0.012 },
		// Catalogue `6s-1700` (262 g, 100C) — the catalogue has no 6S 2200, and a
		// pack that is not in it is not a fact. internalOhm is rule 4,
		// maxCurrent rule 3.
		battery: { cells: 6, capacityMah: 1700, internalOhm: 0.0115, maxCurrent: 66, dischargeCurve: 'lipo' },
		rateFamily: 'actual',
		throttleBands: { low: 1, med: 1, high: 1 },
		minThrottle: 0,
		dragScale: 1,
		escCurrentLimit: null,
		gyroNoise: 0,
		loopDelay: 0,
		// Measured by `node tools/tune-pid.mjs --write swarmNode` off this
		// family's own inertia and motor lag. See CLAUDE.md — never hand-edited.
		pid: {
			roll:  { p: 0.062, d: 1.90e-3 },
			pitch: { p: 0.062, d: 1.90e-3 },
			yaw:   { p: 0.34, d: 0 },
			torquePerMix: { roll: 3.407, pitch: 3.407, yaw: 0.757 },
		},
	},
};

// Ordered so tools iterate the reference build first.
export const FAMILIES = [
	'freestyle5', 'race5', 'cinewhoop', 'longrange', 'heavy5', 'toothpick',
];

export const DEFAULT_FAMILY = 'freestyle5';
export const DEFAULT_PROFILE = PROFILES[DEFAULT_FAMILY];

// The seed a NOMINAL build wears, so every flight has a portrait (D12).
//
// A flight that draws no target — the `?family=` dev override, NOMINAL at the
// bench, `?scene=` without a scan — has no buildSeed, and the end screen used
// to lose its machine with it. This gives it one, derived from the family name
// alone: deterministic (the same family always looks the same), distinct per
// family, and never used by the physics — `flightBuild` stays null, so the
// profile flown is still the reference tune. It only feeds the picture.
//
// FNV-1a 32 bits, the same hash tools/target-build.mjs seeds its RNG with.
export function nominalBuildSeed(family) {
	let h = 0x811c9dc5;
	const s = String(family ?? DEFAULT_FAMILY);
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	// `|| 1`: a seed of 0 is falsy, and every consumer guards on truthiness.
	return (h >>> 0) || 1;
}

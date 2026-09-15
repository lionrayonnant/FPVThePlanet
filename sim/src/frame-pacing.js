// How much simulated time one rendered frame is allowed to buy, and in what
// size pieces. Pure arithmetic, no DOM and no Rapier, because the property that
// matters here — simulated time tracks wall-clock time — is a property of the
// schedule alone and is worth asserting without a browser.
//
// The rule this file exists to enforce: a frame that took longer to render must
// still advance the world by the time that really elapsed. The old loop could
// not. It ran at most MAX_STEPS_PER_FRAME steps of a fixed 1/250 s — 48 ms of
// world per frame — and threw the remainder of the accumulator away, so below
// ~21 fps the entire simulation ran in slow motion: 48 % of real time at 10
// fps, and 3 % through the 700-1700 ms streaming stalls the physics code
// documents. Gravity was the visible casualty (a drone that hangs instead of
// falling), which is why the symptom reads as a broken flight model rather
// than as a dropped frame.

// The nominal grid. Every unstalled frame steps on exactly this.
export const FIXED_STEP = 1 / 250;

// The cost cap: never more than this many physics steps in one frame, however
// far behind the clock is. This is what stops a slow frame from making the
// next frame slower still.
export const MAX_STEPS_PER_FRAME = 12;

// The accuracy floor: a stretched catch-up step never exceeds this. Together
// with MAX_STEPS_PER_FRAME it sets how much real time a single frame can
// honour — 12 * 1/60 = 200 ms, i.e. everything down to 5 fps — and past that
// the excess is dropped on purpose: replaying more than a fifth of a second of
// blind flight in one frame flies the quad into terrain it never saw.
export const MAX_CATCHUP_STEP = 1 / 60;

// The step size to use for every substep of this frame.
//
// Returns FIXED_STEP exactly whenever the backlog fits in the step budget, so
// a machine keeping up steps on the same 250 Hz grid it always did, bit for
// bit. It only stretches once the backlog cannot be paid off at 1/250 s, and
// only as far as MAX_CATCHUP_STEP.
export function catchUpStep(
	accumulator,
	fixedStep = FIXED_STEP,
	maxSteps = MAX_STEPS_PER_FRAME,
	maxCatchupStep = MAX_CATCHUP_STEP,
) {
	if (!(accumulator > maxSteps * fixedStep)) return fixedStep;
	return Math.min(accumulator / maxSteps, maxCatchupStep);
}

// The most simulated time one frame can buy. Anything the accumulator holds
// beyond this is dropped rather than carried forward.
export function maxFrameTime(
	maxSteps = MAX_STEPS_PER_FRAME,
	maxCatchupStep = MAX_CATCHUP_STEP,
) {
	return maxSteps * maxCatchupStep;
}

// ---------------------------------------------------------------------------
// Control substeps.
//
// The physics grid is 250 Hz and there is no reason to move it: Rapier's
// trimesh solve is the expensive half of a step and 250 Hz already resolves
// every rigid-body frequency this airframe has.
//
// The CONTROL loop is a different question, and src/gyro.js is what raised it.
// A gyro reports rotor vibration, and rotor vibration lives at the shaft
// frequency: measured off src/drone-profiles.js through src/quad.js, the six
// families spin their props between 214 Hz (longrange at half stick) and
// 816 Hz (toothpick at full). A 250 Hz loop has its Nyquist at 125 Hz. Not one
// of those tones is representable — every one of them folds down into the
// band as a phantom the loop then chases, and a notch placed at the true
// frequency cannot be built at all (src/gyro.js Notch.setFrequency refuses
// above 0.45 * Nyquist, which at 250 Hz means above 56 Hz).
//
// So the controller may run several times per physics step, on a zero-order
// hold of the body state — which is not an approximation of the sensor, it is
// what the sensor is: the airframe genuinely does not roll at 500 Hz, the gyro
// merely says it does. The noise is generated at the control rate, the notches
// work at the control rate, and the physics integrates the last substep's
// motor command over the whole step, exactly as an ESC holds its last DSHOT
// frame.
//
// THE DECISION, and the numbers behind it. `node tools/loop-rate-bench.mjs`
// reproduces all of them.
//
//   * where the tones are. In flight — hover stick and above — the six
//     families' fundamentals span 157 Hz (longrange at a hover) to 816 Hz
//     (toothpick at full song). A notch can be built only below 0.45 * Nyquist,
//     so the ceiling is 56 Hz at 250 Hz, 113 at 500, 225 at 1000, 450 at 2000
//     and 900 Hz at 4000. Only the last one covers every fundamental. At 250
//     and 500 Hz the notch is not weak, it is ABSENT: every centre frequency it
//     is asked for is above the ceiling and every notch refuses.
//   * the SECOND harmonics are NOT covered and this file does not pretend
//     otherwise: 2 * 816 Hz needs a 7253 Hz loop. They stay out of reach of the
//     DYNAMIC notch, which has to find its peak in a band that does not contain
//     it. The RPM filter still removes them, because it is told the rpm rather
//     than having to measure it — its second-harmonic notches are buildable
//     wherever 2 * f sits under 900 Hz, which is every family below about
//     three-quarter stick. Above that the second harmonic is simply unfiltered,
//     the way it is on a real 8 kHz machine above its own ceiling.
//   * a 500 Hz tone read back through the SDFT: 109 Hz at a 250 Hz loop,
//     126 Hz at 500, 249 Hz at 1000, 500 Hz at 2000 and at 4000. The wrong
//     answers are not noise, they are a tone the loop believes in and chases.
//   * what the chain removes, freestyle5 at a hover, measured as the RMS motion
//     of the motor command with nothing asking for any: 0.0 % at 250 Hz, 0.1 %
//     at 500, 11.3 % at 1000, 15.5 % at 2000, 19.2 % at 4000.
//   * CPU, measured and not assumed (the repo has been wrong about this
//     before): the 250 Hz loop as shipped costs 0.31 ms per simulated second;
//     4000 Hz with the notches on costs 3.69 ms, i.e. +3.38 ms/s — 0.34 % of
//     one core, 0.34 % of a 60 fps frame. Per controller update it is CHEAPER
//     than the 250 Hz row (0.92 us against 1.26): the fixed per-update work is
//     amortised and only the filters scale. Cost is not what decided this.
//
// So: 4000 Hz, sixteen controller substeps per physics step. It is the first
// rate at which the filter chain filters the machine's own vibration rather
// than an alias of it, and it costs a third of a percent of a core.
export const CONTROL_SUBSTEPS = 16;

// The rates `?loop=` will accept. Every one is a whole number of substeps of
// the 250 Hz grid — a control rate that did not divide the physics step would
// need its own accumulator, and a second accumulator is the bug this file was
// written to remove, not one to add.
export const CONTROL_RATES = [250, 500, 1000, 2000, 4000];

// `?loop=<hz>` -> substeps, or CONTROL_SUBSTEPS when the flag is absent.
// Refuses anything else rather than rounding to the nearest legal rate: a dev
// flag never quietly delivers something other than what was asked for
// (tools/dev-flags.mjs states the rule; this is the same rule).
export function parseControlRate(raw) {
	if (raw === null || raw === undefined || raw === '') return CONTROL_SUBSTEPS;
	const hz = Number(raw);
	if (!CONTROL_RATES.includes(hz)) {
		throw new Error(`?loop= expects one of ${CONTROL_RATES.join(', ')} Hz — got "${raw}"`);
	}
	return hz / (1 / FIXED_STEP);
}

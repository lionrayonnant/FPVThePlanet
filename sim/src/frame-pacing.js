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

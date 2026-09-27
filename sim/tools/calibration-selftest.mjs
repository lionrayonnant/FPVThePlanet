// Selftest of src/calibration.js (issue #277): the guided calibration state
// machine. Pure logic, no DOM, no localStorage — it is handed axis snapshots and
// a dt, and returns the next state.
//
// The sequences replayed here are REAL hardware ones:
//   - an EdgeTX radio: friction gimbal, the throttle stick HOLDS its position;
//   - a DualShock 4: self-centring stick, different axis order.
// That is exactly the pair padKind() cannot tell apart when the radio is missing
// from the brand list.
// Run: node tools/calibration-selftest.mjs
import assert from 'node:assert/strict';
import {
	beginCalibration,
	feedSample,
	skipStep,
	isSkippableStep,
	calibrationToMap,
	normalizeChannel,
	throttleFromCalibrated,
	calibrationResult,
	calProgress,
	calSummaryLines,
	CAL_PROMPTS,
	CAL_TIMING,
	padSignals,
} from '../src/calibration.js';
import { defaultMapForKind, isValidCalibration, menuButtonDown, flightModeSpec, readFlightMode } from '../src/input.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

// Replays `ms` milliseconds of a device whose axes are given by
// `axesAt(elapsedMs)`. A dt of 16 ms = one frame at 60 Hz, which is what the real
// caller does (settings.js, inside its render loop).
function feedFor(state, axesAt, ms, dt = 16) {
	for (let e = 0; e < ms; e += dt) state = feedSample(state, axesAt(e), dt);
	return state;
}

const still = (axes) => () => axes;

// Replays a whole scenario: a list of [axes, duration]. That is the closest shape
// to what a pilot does — they put the pad down, push a stick, hold it, let it go.
function play(state, steps) {
	for (const [axes, ms] of steps) state = feedFor(state, still(axes), ms);
	return state;
}

// The two menu steps and the flight-mode step skipped, which is what a
// standard-pad owner may do: buttons 0 and 1 are momentary there and menu-nav.js
// already handles them, and button 8 is the default mode button.
const skipMenu = (s) => skipStep(skipStep(skipStep(s)));

// A DualShock 4 in "standard" mapping: axis 0/1 = left stick X/Y, axis 2/3 =
// right stick X/Y. All self-centring. The Y axis reads -1 UPWARDS.
const DS4 = [
	[[0, 0, 0, 0], 1200],       // rest
	[[0, -1, 0, 0], 700],       // throttle wide open: left stick up
	[[0, 0, 0, 0], 900],        // let go — it comes back to centre
	[[1, 0, 0, 0], 700],        // yaw right: left stick to the right
	[[0, 0, 0, 0], 400],
	[[0, 0, 0, 1], 700],        // nose up: right stick pulled towards you (Y positive)
	[[0, 0, 0, 0], 400],
	[[0, 0, 1, 0], 700],        // roll right: right stick to the right
];

// An EdgeTX radio: axis 0 = roll, 1 = pitch, 2 = throttle, 3 = yaw. The throttle
// stick is a FRICTION one — it holds its position, and the pilot left it down.
const EDGETX = [
	[[0, 0, -1, 0], 1200],      // rest, throttle parked at the bottom
	[[0, 0, 1, 0], 700],        // throttle wide open
	[[0, 0, 1, 0], 900],        // let go: it STAYS up
	[[0, 0, -1, 0], 700],       // throttle at minimum
	[[0, 0, -1, 1], 700],       // yaw right
	[[0, 0, -1, 0], 400],
	[[0, -1, -1, 0], 700],      // nose up: stick pulled towards you = negative axis
	[[0, 0, -1, 0], 400],
	[[1, 0, -1, 0], 700],       // roll right
];

// --- start -------------------------------------------------------------------

t('beginCalibration: starts by measuring the REST, not by asking for a gesture', () => {
	const s = beginCalibration(4);
	assert.equal(s.phase, 'rest');
	assert.equal(s.channel, null);
	assert.ok(s.prompt.length > 0, 'a prompt must be paintable from the very first frame');
	assert.equal(s.done, false);
});

// --- rest phase --------------------------------------------------------------

t('rest: the measured centre is where the stick IS PARKED, not zero', () => {
	// A friction gimbal left mid-travel: the "centre" of that axis is 0.42.
	// Assuming it is 0 is exactly what makes a drone take off on its own.
	let s = beginCalibration(4);
	s = feedFor(s, still([0, 0, 0.42, 0]), 1500);
	assert.notEqual(s.phase, 'rest', 'the rest phase must end by itself');
	assert.equal(s.centers.length, 4);
	assert.ok(Math.abs(s.centers[2] - 0.42) < 0.01, `measured centre ${s.centers[2]}`);
});

t('rest: the deadband comes from the MEASURED noise, it is not a constant', () => {
	// An axis trembling by ±0.03 at rest must produce a wider deadband than a
	// perfectly steady one — otherwise the drone drifts at neutral.
	let quiet = beginCalibration(4);
	quiet = feedFor(quiet, still([0, 0, 0, 0]), 1500);

	let noisy = beginCalibration(4);
	noisy = feedFor(noisy, (e) => [0.03 * Math.sin(e), 0, 0, 0], 1500);

	assert.ok(noisy.deadband > quiet.deadband,
		`noisy ${noisy.deadband} should exceed quiet ${quiet.deadband}`);
	assert.ok(noisy.deadband >= 0.03, 'the deadband must at least cover the noise seen');
});

t('rest: a stick moved during the measurement restarts the measurement', () => {
	// Without this guard the "centre" is captured mid-gesture and EVERYTHING else
	// in the calibration is offset.
	let s = beginCalibration(4);
	s = feedFor(s, (e) => [e < 500 ? 0 : (e - 500) / 1000, 0, 0, 0], 1500);
	assert.equal(s.phase, 'rest', 'a moving stick does not let us leave the rest phase');
	assert.ok(s.message, 'and it says why it starts again');
});

// --- axis assignment ---------------------------------------------------------

t('a gesture assigns the axis THAT MOVED, and its direction', () => {
	let s = beginCalibration(4);
	s = play(s, DS4.slice(0, 2));
	assert.equal(s.channels.throttle.axis, 1);
	// The axis reaches -1 when "wide open" is asked for: the travel is reversed.
	assert.ok(s.channels.throttle.hi < s.channels.throttle.lo);
});

t('two axes moving together: ASK AGAIN instead of assigning at random', () => {
	// The case that makes a calibration silently wrong: the pilot pushes
	// diagonally. Before this, nobody measured anything, so nobody saw it.
	let s = beginCalibration(4);
	s = play(s, [[[0, 0, 0, 0], 1200], [[0, -0.9, -0.8, 0], 900]]);
	assert.equal(s.channel, 'throttle', 'we stay on the same prompt');
	assert.ok(!s.channels?.throttle, 'and nothing is assigned');
	assert.ok(s.message, 'and it says why');
});

t('an axis already assigned cannot serve twice', () => {
	let s = beginCalibration(4);
	// Throttle on axis 1, then axis 1 is pushed again for the yaw.
	s = play(s, [...DS4.slice(0, 3), [[0, -1, 0, 0], 900]]);
	assert.equal(s.channel, 'yaw', 'we stay on the yaw');
	assert.ok(!s.channels.yaw, 'nothing is assigned');
	assert.match(s.message, /throttle/i, 'the message names the channel that already holds that axis');
});

// --- throttle travel mode: MEASURED, no longer deduced from a brand ---------

t('self-centring throttle (DS4) -> half travel, and the floor is the neutral', () => {
	let s = beginCalibration(4);
	s = play(s, DS4.slice(0, 3));
	assert.equal(s.throttleMode, 'half');
	assert.ok(Math.abs(s.channels.throttle.lo - 0) < 0.01, `lo=${s.channels.throttle.lo}`);
	assert.ok(Math.abs(s.channels.throttle.hi + 1) < 0.01, `hi=${s.channels.throttle.hi}`);
});

t('friction throttle (radio) -> full travel, and the floor is HUNTED DOWN', () => {
	let s = beginCalibration(4);
	// After letting go the stick stayed up: this is not a self-centring stick, so
	// the floor is not the neutral — it has to be measured.
	s = play(s, EDGETX.slice(0, 3));
	assert.equal(s.throttleMode, 'full');
	assert.equal(s.channel, 'throttle', 'no moving on to the next channel without the low stop');
	assert.match(s.prompt, /down/i);

	s = play(s, EDGETX.slice(3, 4));
	assert.ok(Math.abs(s.channels.throttle.lo + 1) < 0.01, `lo=${s.channels.throttle.lo}`);
	assert.ok(Math.abs(s.channels.throttle.hi - 1) < 0.01, `hi=${s.channels.throttle.hi}`);
});

// --- full runs ---------------------------------------------------------------

t('DS4 end to end: the calibration FINDS the hand-written profile again', () => {
	// defaultMapForKind('generic') is input.js's gamepad profile, written by hand.
	// If the measurement reproduces it, the measurement is right — and it is the
	// measurement that will also work on hardware missing from the brand list.
	let s = beginCalibration(4);
	s = skipMenu(play(s, DS4));
	assert.equal(s.phase, 'done');
	assert.equal(s.done, true);
	assert.deepEqual(calibrationToMap(s), defaultMapForKind('generic'));
	assert.equal(s.throttleMode, 'half');
});

t('EdgeTX radio end to end: the same, with a full-travel throttle', () => {
	let s = beginCalibration(4);
	s = skipMenu(play(s, EDGETX));
	assert.equal(s.phase, 'done');
	assert.deepEqual(calibrationToMap(s), defaultMapForKind('radio'));
	assert.equal(s.throttleMode, 'full');
});

t('the four sticks lead into the menu steps, not straight to done', () => {
	// Measuring the two menu gestures is the END of the wizard: a radio's buttons 0
	// and 1 are switch POSITIONS, so guessing them is how a pilot ends up with no
	// reachable confirm button at all.
	const s = play(beginCalibration(4), DS4);
	assert.equal(s.phase, 'menu-confirm');
	assert.equal(s.done, false, 'nothing is persisted yet');
	assert.match(s.hint, /CONFIRM/);
	const back = skipStep(s);
	assert.equal(back.phase, 'menu-back');
	assert.match(back.hint, /GO BACK/);
});

// --- reading a calibrated axis ----------------------------------------------
//
// This is where the calibration changes something about the flight: without these
// two functions it would only be a nice screen writing one more {axis, invert}.

t('normalizeChannel: the measured neutral gives 0, the measured stop gives 1', () => {
	const cal = { axis: 2, center: 0.42, span: 0.58, invert: false };
	assert.equal(normalizeChannel(0.42, cal, 0), 0);
	assert.ok(Math.abs(normalizeChannel(1, cal, 0) - 1) < 1e-9);
});

t('normalizeChannel: a short-travel stick still reaches 100 %', () => {
	// A radio whose endpoints are not set only puts out ±0.8. With the assumption
	// "the travel is ±1", the pilot never gets their full deflection.
	const cal = { axis: 0, center: 0, span: 0.8, invert: false };
	assert.ok(Math.abs(normalizeChannel(0.8, cal, 0) - 1) < 1e-9);
	assert.ok(Math.abs(normalizeChannel(-0.8, cal, 0) + 1) < 1e-9);
});

t('normalizeChannel: clamped to ±1 past the measured stop', () => {
	const cal = { axis: 0, center: 0, span: 0.8, invert: false };
	assert.equal(normalizeChannel(1, cal, 0), 1);
	assert.equal(normalizeChannel(-1, cal, 0), -1);
});

t('normalizeChannel: an inverted axis gives +1 for the gesture asked for', () => {
	// DS4, Y axis: "up" is -1. The positive gesture must give +1.
	const cal = { axis: 1, center: 0, span: 1, invert: true };
	assert.ok(Math.abs(normalizeChannel(-1, cal, 0) - 1) < 1e-9);
});

t('normalizeChannel: the measured deadband kills neutral drift, with no step', () => {
	const cal = { axis: 0, center: 0, span: 1, invert: false };
	assert.equal(normalizeChannel(0.04, cal, 0.05), 0, 'inside the noise -> exactly 0');
	// And just past the threshold the output starts again from 0: a deadband that
	// subtracts without rescaling makes the command jump.
	assert.ok(normalizeChannel(0.051, cal, 0.05) < 0.01);
	assert.ok(Math.abs(normalizeChannel(1, cal, 0.05) - 1) < 1e-9, 'the stop stays at 1');
});

t('throttleFromCalibrated: 0 at the measured floor, 1 at the measured ceiling', () => {
	const full = { axis: 2, lo: -1, hi: 1 };
	assert.equal(throttleFromCalibrated(-1, full), 0);
	assert.equal(throttleFromCalibrated(1, full), 1);
	assert.ok(Math.abs(throttleFromCalibrated(0, full) - 0.5) < 1e-9);
});

t('throttleFromCalibrated: a self-centring throttle is at 0 when let go', () => {
	// The case that matters: stick let go = 0 % throttle, so the disarm gesture
	// (throttle < 0.08) stays reachable at rest.
	const half = { axis: 1, lo: 0, hi: -1 };
	assert.equal(throttleFromCalibrated(0, half), 0);
	assert.equal(throttleFromCalibrated(-1, half), 1);
	assert.equal(throttleFromCalibrated(0.6, half), 0, 'and pushing the wrong way gives no throttle');
});

t('throttleFromCalibrated: an offset neutral leaves no throttle at rest', () => {
	// Friction gimbal left at -0.9: with no measured floor, (v+1)/2 would give a
	// permanent 5 % throttle.
	const full = { axis: 2, lo: -0.9, hi: 0.95 };
	assert.equal(throttleFromCalibrated(-0.9, full), 0);
	assert.equal(throttleFromCalibrated(-1, full), 0, 'and below the floor we stay at 0');
});

t('end to end: the calibrated DS4 is at zero on all four channels at rest', () => {
	let s = beginCalibration(4);
	s = skipMenu(play(s, DS4));
	const axes = [0, 0, 0, 0];
	assert.equal(throttleFromCalibrated(axes[s.channels.throttle.axis], s.channels.throttle), 0);
	for (const ch of ['yaw', 'pitch', 'roll']) {
		const c = s.channels[ch];
		assert.equal(normalizeChannel(axes[c.axis], c, s.deadband), 0, ch);
	}
});

// --- what is persisted, and what is shown -----------------------------------

t('calibrationResult: keeps ONLY the measurement, not the accumulators', () => {
	let s = beginCalibration(4);
	s = skipMenu(play(s, DS4));
	const out = calibrationResult(s);
	// axisCount since #279: the axis/button border, without which a summary re-read
	// later can no longer name "btn 6".
	assert.deepEqual(Object.keys(out).sort(), ['axisCount', 'channels', 'deadband', 'throttleMode']);
	assert.deepEqual(out.channels, s.channels);
	// What goes into localStorage must survive a JSON round trip.
	assert.deepEqual(JSON.parse(JSON.stringify(out)), out);
});

t('calibrationResult: nothing to persist until it is finished', () => {
	let s = beginCalibration(4);
	s = play(s, DS4.slice(0, 2));
	assert.equal(calibrationResult(s), null);
});

t('calProgress: the pilot sees where they are, and the end is the end', () => {
	let s = beginCalibration(4);
	assert.deepEqual(calProgress(s), { step: 1, total: 9 });
	s = play(s, DS4.slice(0, 2));
	assert.deepEqual(calProgress(s), { step: 3, total: 9 }, 'letting the throttle go is a step of its own');
	s = play(s, DS4);
	assert.deepEqual(calProgress(s), { step: 7, total: 9 }, 'the sticks done, the menu steps remain');
	assert.deepEqual(calProgress(skipStep(s)), { step: 8, total: 9 });
	assert.deepEqual(calProgress(skipStep(skipStep(s))), { step: 9, total: 9 }, 'then the flight-mode step, last');
	assert.deepEqual(calProgress(skipMenu(s)), { step: 9, total: 9 });
});

t('calSummaryLines: the summary says what was MEASURED, not "ok"', () => {
	// A calibration that only announces its success is unverifiable. These lines
	// are what gets re-read when "it still does not work" — the same role as
	// padListEntries() for the device list (#162).
	let s = beginCalibration(4);
	s = skipMenu(play(s, EDGETX));
	const lines = calSummaryLines(calibrationResult(s));

	assert.equal(lines.length, 5, 'four channels + the deadband');
	assert.match(lines[0], /throttle/);
	assert.match(lines[0], /axis 2/);
	assert.match(lines[0], /full travel/, 'the measured travel mode must be readable');
	assert.match(lines[2], /pitch/);
	assert.match(lines[2], /axis 1/);
	assert.match(lines[2], /inverted/, 'so must the direction kept');
	assert.match(lines[4], /deadband/);
});

t('calSummaryLines: a short travel IS VISIBLE in the summary', () => {
	// A radio that only puts out ±0.8 is a real hardware problem. The calibration
	// catches up with it, but it must also SAY so.
	const cal = {
		channels: {
			throttle: { axis: 2, lo: -1, hi: 1 },
			yaw: { axis: 3, center: 0, span: 0.8, invert: false },
			pitch: { axis: 1, center: 0, span: 1, invert: true },
			roll: { axis: 0, center: 0, span: 1, invert: false },
		},
		deadband: 0.02,
		throttleMode: 'full',
	};
	assert.match(calSummaryLines(cal)[1], /0\.80/);
});

t('the prompts fit on one line of the panel', () => {
	// They are shown at 22 px in a narrow panel: past twenty-odd characters a
	// prompt breaks mid-sentence and is read twice. What needs explaining goes into
	// CAL_HINTS.
	for (const [key, text] of Object.entries(CAL_PROMPTS)) {
		assert.ok(text.length <= 22, `${key}: "${text}" is ${text.length} characters`);
		assert.equal(text, text.toUpperCase(), `${key}: prompts are upper case`);
	}
});

// --- a throttle filed on a trigger (issue #279) ------------------------------
//
// Measured on a Radiomaster Pocket, EdgeTX in Joystick mode, under Firefox:
//
//   id      1209-4f54-EdgeTX Radiomaster Pocket Joystick
//   mapping standard   axes=8  buttons=28
//   axis 0,1,2  seen -1.00..1.00      axis 3 to 7  seen 0.00..0.00
//   btn 6       0.997                 seen 0.00..1.00
//
// Firefox applies "standard" mapping to the radio and files its throttle stick in
// the L2 trigger slot. The throttle therefore comes out on `buttons[6].value`,
// ANALOGUE — a digital button would report exactly 1.000, never 0.997 — and the
// fourth axis stays dead.
//
// That is the assumption #277 had kept without measuring it: "a stick is on an
// axis". It made this radio's throttle structurally invisible.

// The device snapshot as the browser reports it, run through padSignals(): that
// function is as much under test as the state machine. `extra` presses one more
// button, for the menu steps below.
const pocket = (a0, a1, a2, btn6, extra = -1) => padSignals({
	axes: [a0, a1, a2, 0, 0, 0, 0, 0],
	buttons: Array.from({ length: 28 }, (_, i) => ({ value: i === 6 ? btn6 : (i === extra ? 1 : 0) })),
});

// The throttle is a friction one: it HOLDS its position, and the pilot left it
// down.
const POCKET = [
	[pocket(0, 0, 0, 0), 1200],        // rest, throttle parked at the bottom
	[pocket(0, 0, 0, 0.997), 700],     // throttle wide open — on BUTTON 6
	[pocket(0, 0, 0, 0.997), 900],     // let go: it STAYS up
	[pocket(0, 0, 0, 0), 700],         // throttle at minimum
	[pocket(0, 0, 1, 0), 700],         // yaw right
	[pocket(0, 0, 0, 0), 400],
	[pocket(0, -1, 0, 0), 700],        // nose up
	[pocket(0, 0, 0, 0), 400],
	[pocket(1, 0, 0, 0), 700],         // roll right
];

t('#279: padSignals exposes buttons on the same travel as the axes', () => {
	// A button at rest must read like a stick parked at its low stop: that is what
	// leaves the module's thresholds (all calibrated on a travel of 2) the meaning
	// they were measured with.
	const v = padSignals({ axes: [0.5, -1], buttons: [{ value: 0 }, { value: 1 }, { value: 0.5 }] });
	assert.deepEqual(v, [0.5, -1, -1, 1, 0]);
});

t('#279: the throttle on the L2 trigger is found, and named btn 6', () => {
	const s = skipMenu(play(beginCalibration(8 + 28, 8), POCKET));
	const cal = calibrationResult(s);
	assert.ok(cal, `the calibration must complete — stuck on "${s.prompt}"`);

	// 8 axes then 28 buttons: button 6 is signal 14.
	assert.equal(cal.channels.throttle.axis, 14, 'the throttle is on button 6');
	assert.equal(cal.throttleMode, 'full', 'a friction gimbal is full travel');
	assert.ok(cal.channels.throttle.hi > cal.channels.throttle.lo);

	// And the three other sticks stay on their axes.
	assert.equal(cal.channels.yaw.axis, 2);
	assert.equal(cal.channels.pitch.axis, 1);
	assert.equal(cal.channels.roll.axis, 0);

	// The summary must say "btn 6": a pilot reading "axis 14" on a device that
	// announces 8 axes believes it is a bug.
	assert.match(calSummaryLines(cal)[0], /btn 6/);
});

t('#279: a throttle calibrated on a button still gives 0 down and 1 up', () => {
	const s = skipMenu(play(beginCalibration(8 + 28, 8), POCKET));
	const cal = calibrationResult(s);
	const read = (btn6) => throttleFromCalibrated(pocket(0, 0, 0, btn6)[14], cal.channels.throttle);
	assert.ok(read(0) < 0.02, `throttle down = ${read(0)}`);
	assert.ok(read(0.997) > 0.98, `throttle up = ${read(0.997)}`);
	// The disarm gesture (throttle < 0.08) must stay reachable at rest.
	assert.ok(read(0) < 0.08);
});

t('#279: a device that reports nothing ends up SAYING so', () => {
	// A mute pad passes the rest step BETTER than a real one — zero noise, so no
	// rejection — then leaves the pilot in front of a prompt that will never
	// change. Without this guard, nothing names the problem.
	let s = beginCalibration(8 + 28, 8);
	s = feedFor(s, still(pocket(0, 0, 0, 0)), 1200);
	assert.equal(s.phase, 'channel', 'the rest passes: a mute pad is perfectly steady');
	assert.equal(s.message, null, 'nothing to report while the pilot may still be aiming');
	s = feedFor(s, still(pocket(0, 0, 0, 0)), CAL_TIMING.idleWarnMs + 200);
	assert.match(s.message ?? '', /no movement/i, 'after a long motionless wait, it has to be said');
	assert.equal(s.phase, 'channel', 'but we do not give up: the pilot can still move');
});

// --- the two menu gestures ---------------------------------------------------
//
// On a radio, buttons 0 and 1 are SWITCH POSITIONS: an inter left on one side
// reads as permanently pressed, and no momentary button that confirms anything is
// reachable. So they are measured, exactly like the sticks — a gesture is asked
// for and what moved is written down.

// A DualShock 4 with its buttons, so that the menu steps have signals that are
// not one of the four sticks. Button b of 16 becomes signal 4 + b.
const ds4 = (axes, b = -1) => padSignals({
	axes,
	buttons: Array.from({ length: 16 }, (_, i) => ({ value: i === b ? 1 : 0 })),
});

const DS4_STICKS = DS4.map(([axes, ms]) => [ds4(axes), ms]);
const zero = [0, 0, 0, 0];

// Everything released, press button `b`, hold it, release: the gesture the wizard
// asks for. The release FIRST is not decoration — a step only arms once the
// device is back at rest, so that the gesture which validated the previous step
// cannot carry through to this one.
const pressMenu = (b) => [[ds4(zero), 300], [ds4(zero, b), 700], [ds4(zero), 500]];

t('menu: the two gestures are MEASURED, in the axes-then-buttons index space', () => {
	let s = play(beginCalibration(4 + 16, 4), DS4_STICKS);
	assert.equal(s.phase, 'menu-confirm');
	s = play(s, pressMenu(4));
	assert.equal(s.phase, 'menu-back', 'confirm measured, the back gesture follows');
	assert.equal(s.menu.confirm.signal, 4 + 4, 'button 4 is signal 8');

	s = play(s, pressMenu(5));
	assert.equal(s.phase, 'mode', 'the two menu gestures lead into the flight-mode step');
	s = skipStep(s);
	assert.equal(s.phase, 'done');
	const cal = calibrationResult(s);
	assert.equal(cal.menu.confirm.signal, 8);
	assert.equal(cal.menu.back.signal, 9);
	// The two measured ends are what makes "pressed" a threshold rather than a
	// guess: a digital button travels -1 -> +1.
	assert.equal(cal.menu.confirm.center, -1);
	assert.equal(cal.menu.confirm.on, 1);
	assert.deepEqual(JSON.parse(JSON.stringify(cal)), cal, 'and it survives a JSON round trip');
});

t('menu: a signal that is a STICK is refused, with a reason', () => {
	// Taking a stick would make every cursor move validate the screen.
	let s = play(beginCalibration(4 + 16, 4), DS4_STICKS);
	s = play(s, [[ds4(zero), 300], [ds4([1, 0, 0, 0]), 900], [ds4(zero), 500]]);
	assert.equal(s.phase, 'menu-confirm', 'we stay on the same prompt');
	assert.equal(s.menu.confirm, undefined, 'and nothing is assigned');
	assert.match(s.message, /yaw|roll|pitch|throttle/, 'the message names the channel that holds it');
});

t('menu: back cannot be the same signal as confirm', () => {
	let s = play(beginCalibration(4 + 16, 4), DS4_STICKS);
	s = play(s, pressMenu(4));
	s = play(s, pressMenu(4));
	assert.equal(s.phase, 'menu-back', 'we stay on the back gesture');
	assert.equal(s.menu.back, undefined);
	assert.match(s.message, /confirm/);
});

t('menu: a gesture on an analogue TRIGGER is measured like a button', () => {
	// The #279 case applied to a menu button: a radio in standard mapping can file
	// a signal anywhere in that vector, an analogue trigger included.
	let s = play(beginCalibration(8 + 28, 8), POCKET);
	assert.equal(s.phase, 'menu-confirm');
	// Button 7 held at 1, which is signal 8 + 7 = 15.
	s = play(s, [[pocket(0, 0, 0, 0), 300], [pocket(0, 0, 0, 0, 7), 700], [pocket(0, 0, 0, 0), 500]]);
	assert.equal(s.menu.confirm.signal, 15);
	assert.equal(s.phase, 'menu-back');
});

t('menu: BOTH steps are skippable, and skipping writes nothing', () => {
	// A standard-pad owner needs neither: its buttons 0 and 1 are momentary and
	// menu-nav.js falls back to them.
	const s = skipMenu(play(beginCalibration(4 + 16, 4), DS4_STICKS));
	assert.equal(s.phase, 'done');
	const cal = calibrationResult(s);
	assert.equal(cal.menu, undefined, 'a skipped step is not a measurement');
	assert.equal(calSummaryLines(cal).length, 5, 'and the summary carries no menu line');
});

t('menu: the confirm measured alone is kept, the back skipped stays absent', () => {
	let s = play(beginCalibration(4 + 16, 4), DS4_STICKS);
	s = skipStep(play(s, pressMenu(4)));
	assert.equal(s.phase, 'mode', 'the back skipped, the flight-mode step follows');
	s = skipStep(s);
	assert.equal(s.phase, 'done');
	const cal = calibrationResult(s);
	assert.equal(cal.menu.confirm.signal, 8);
	assert.equal(cal.menu.back, undefined);
	assert.match(calSummaryLines(cal).at(-1), /menu.*confirm btn 4/);
});

t('skipStep does nothing outside the skippable steps', () => {
	// It is called by a button in the panel; anywhere else it must be inert rather
	// than jump over a stick.
	const rest = beginCalibration(4);
	assert.equal(skipStep(rest), rest);
	const sticks = play(beginCalibration(4), DS4.slice(0, 2));
	assert.equal(skipStep(sticks), sticks);
});

t('menu: what is measured is readable by menuButtonDown, pressed and released', () => {
	// The whole point of the two steps: what came out of the wizard is what
	// menu-nav.js reads back.
	let s = play(beginCalibration(4 + 16, 4), DS4_STICKS);
	s = skipStep(play(play(s, pressMenu(4)), pressMenu(5)));
	const cal = calibrationResult(s);

	assert.equal(menuButtonDown(ds4(zero, 4), cal.menu.confirm, 99), true);
	assert.equal(menuButtonDown(ds4(zero), cal.menu.confirm, 99), false);
	assert.equal(menuButtonDown(ds4(zero, 5), cal.menu.back, 99), true);
	assert.equal(menuButtonDown(ds4(zero, 5), cal.menu.confirm, 99), false,
		'one gesture does not fire the other');
});

t('menu: a calibration out of the wizard is accepted by isValidCalibration', () => {
	// The gate that stands between stored data and the motors. A `menu` field must
	// not make it refuse the flight part of the calibration.
	let s = play(beginCalibration(4 + 16, 4), DS4_STICKS);
	s = skipStep(play(play(s, pressMenu(4)), pressMenu(5)));
	assert.equal(isValidCalibration(calibrationResult(s)), true, 'with the two gestures measured');
	assert.equal(isValidCalibration(calibrationResult(skipMenu(play(beginCalibration(4), DS4)))), true,
		'and with both skipped');
});

// --- the flight-mode control -------------------------------------------------
//
// The same gesture-and-watch, plus one question the hardware answers by itself:
// does the control come BACK when let go? A pad button does (a cycle button), a
// radio switch stays (each position is a mode, Betaflight's AUX range).

// A DS4 up to the flight-mode step: sticks measured, both menu gestures skipped.
const toModeStep = () => skipStep(skipStep(play(beginCalibration(4 + 16, 4), DS4_STICKS)));

// Press button `b`, keep it `holdMs`, let go, stay at rest `restMs`.
const pressMode = (b, holdMs = 600, restMs = 1400) =>
	[[ds4(zero), 300], [ds4(zero, b), holdMs], [ds4(zero), restMs]];

// An EdgeTX radio with a fifth axis: the flight-mode switch, parked at -1.
const edgeSw = (axes, sw) => [...axes, sw];
const EDGETX_SW = EDGETX.map(([axes, ms]) => [edgeSw(axes, -1), ms]);
const toRadioModeStep = () => skipStep(skipStep(play(beginCalibration(5), EDGETX_SW)));
const radioRest = [0, 0, -1, 0];

t('mode: the step follows the two menu gestures', () => {
	const s = toModeStep();
	assert.equal(s.phase, 'mode');
	assert.match(s.hint, /FLIGHT MODE switch to ACRO/);
	assert.ok(isSkippableStep(s));
});

t('mode: a button that SPRINGS BACK is a cycle button', () => {
	const s = play(toModeStep(), pressMode(8));
	assert.equal(s.phase, 'done');
	const cal = calibrationResult(s);
	assert.deepEqual(cal.mode, { signal: 4 + 8, type: 'cycle', center: -1, on: 1 });
	assert.match(calSummaryLines(cal).at(-1), /mode\s+button btn 8/);
	assert.equal(isValidCalibration(cal), true);
});

t('mode: a quick press is still a button — the window waits for the release', () => {
	// Accepted after holdMs (400 ms) of pressure, let go 100 ms later: the
	// release window starts at acceptance and is at least releaseMinMs long.
	const s = play(toModeStep(), pressMode(8, CAL_TIMING.holdMs + 100));
	assert.equal(calibrationResult(s)?.mode?.type, 'cycle');
});

t('mode: a button let go late, but inside the window, is still a button', () => {
	// Released 700 ms after acceptance: within releaseMinMs (800 ms).
	const s = play(toModeStep(), pressMode(8, CAL_TIMING.holdMs + 700));
	assert.equal(calibrationResult(s)?.mode?.type, 'cycle');
});

t('mode: a button held PAST the window reads as a switch — the known limit', () => {
	// Nothing in the signal tells a held button from a switch: past the window
	// the machine says ANGLE, which is the pilot's cue that it misread them.
	const s = play(toModeStep(), [[ds4(zero), 300], [ds4(zero, 8), CAL_TIMING.holdMs + CAL_TIMING.releaseMinMs + 600]]);
	assert.equal(s.phase, 'mode-angle');
	assert.ok(isSkippableStep(s), 'and the way out is the skip');
});

t('mode: a switch that STAYS asks for ANGLE, and keeps both positions', () => {
	let s = play(toRadioModeStep(), [[edgeSw(radioRest, -1), 300], [edgeSw(radioRest, 1), 1800]]);
	assert.equal(s.phase, 'mode-angle', 'it stayed: a switch, the second position is asked for');
	assert.match(s.hint, /ANGLE/);
	assert.ok(isSkippableStep(s));
	s = play(s, [[edgeSw(radioRest, -1), 700]]);
	assert.equal(s.phase, 'done');
	const cal = calibrationResult(s);
	assert.deepEqual(cal.mode, { signal: 4, type: 'switch', acro: 1, angle: -1 });
	assert.match(calSummaryLines(cal).at(-1), /mode\s+switch axis 4\s+acro 1\.00 · angle -1\.00/);
	assert.equal(isValidCalibration(cal), true);
	assert.deepEqual(JSON.parse(JSON.stringify(cal)), cal);
});

t('mode: a three-position switch — ACRO in the middle, ANGLE at the far end', () => {
	let s = play(toRadioModeStep(), [[edgeSw(radioRest, -1), 300], [edgeSw(radioRest, 0), 1800]]);
	assert.equal(s.phase, 'mode-angle');
	s = play(s, [[edgeSw(radioRest, 1), 700]]);
	const m = calibrationResult(s).mode;
	assert.equal(m.type, 'switch');
	assert.ok(Math.abs(m.acro) < 1e-9 && m.angle === 1);
	// And the reader picks the nearer position, whatever the third one does.
	const spec = flightModeSpec(m, 'radio', 4);
	assert.equal(readFlightMode(edgeSw(radioRest, 0.05), spec), 'acro');
	assert.equal(readFlightMode(edgeSw(radioRest, 0.95), spec), 'angle');
});

t('mode: ANGLE on the same position as ACRO is not an answer', () => {
	let s = play(toRadioModeStep(), [[edgeSw(radioRest, -1), 300], [edgeSw(radioRest, 1), 1800]]);
	s = play(s, [[edgeSw(radioRest, 1), CAL_TIMING.idleWarnMs + 200]]);
	assert.equal(s.phase, 'mode-angle', 'still waiting for a second position');
	assert.match(s.message ?? '', /ANGLE/);
});

t('mode: a stick is refused, with a reason', () => {
	const s = play(toModeStep(), [[ds4(zero), 300], [ds4([1, 0, 0, 0]), 900], [ds4(zero), 500]]);
	assert.equal(s.phase, 'mode', 'we stay on the same prompt');
	assert.equal(s.mode, undefined);
	assert.match(s.message, /yaw|roll|pitch|throttle/);
});

t('mode: a menu gesture is refused, with a reason', () => {
	let s = play(beginCalibration(4 + 16, 4), DS4_STICKS);
	s = skipStep(play(s, pressMenu(4)));
	assert.equal(s.phase, 'mode');
	s = play(s, pressMode(4));
	assert.equal(s.phase, 'mode');
	assert.match(s.message, /confirm/);
});

t('mode: skippable at each of its phases, and a skip keeps nothing of it', () => {
	const skipped = skipStep(toModeStep());
	assert.equal(skipped.phase, 'done');
	assert.equal(calibrationResult(skipped).mode, undefined);

	const half = play(toRadioModeStep(), [[edgeSw(radioRest, -1), 300], [edgeSw(radioRest, 1), 1800]]);
	assert.equal(half.phase, 'mode-angle');
	const out = calibrationResult(skipStep(half));
	assert.equal(out.mode, undefined, 'half a switch is not a measurement');
	assert.equal(isValidCalibration(out), true);
});

t('mode: a device that never moves ends up saying why, switch included', () => {
	const s = play(toModeStep(), [[ds4(zero), CAL_TIMING.idleWarnMs + 300]]);
	assert.equal(s.phase, 'mode');
	assert.match(s.message ?? '', /already on ACRO/);
});

t('mode: the prompts of the step fit the panel', () => {
	for (const k of ['modeAcro', 'modeRelease', 'modeAngle']) assert.ok(CAL_PROMPTS[k].length <= 22, k);
});

console.log(`\n  ${n} tests OK`);

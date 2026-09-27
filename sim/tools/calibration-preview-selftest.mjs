// node tools/calibration-preview-selftest.mjs — the machine's pose during the
// calibration (issue #281). A PURE module: no DOM, no clock, so what the pilot
// SEES is checked without a browser, like the measurement itself.
//
// This selftest reads no angle: degrees belong to the view. What is checked here
// are properties — during a prompt, ONLY the channel asked for moves; during
// "hands off", nothing moves; the replay comes back to exactly zero; and the
// scale follows this pilot's radio travel.
import assert from 'node:assert/strict';
import { beginCalibration, feedSample, skipStep, CAL_TIMING } from '../src/calibration.js';
import { calibrationPose, replayPose, completedChannels, REPLAY_MS } from '../src/calibration-preview.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

const feed = (state, signals, ms, dt = 16) => {
	for (let e = 0; e < ms; e += dt) state = feedSample(state, signals, dt);
	return state;
};
const AXES = 4;
const zero = [0, 0, 0, 0];

// A state stopped on the `channel` prompt, on a radio with four centred axes. The
// previous prompts are crossed by pushing the axis each one expects.
const ORDER = [['throttle', 2], ['yaw', 3], ['pitch', 1], ['roll', 0]];
function upTo(channel, { travel = 1 } = {}) {
	let s = feed(beginCalibration(AXES), zero, CAL_TIMING.restMs + 200);
	for (const [ch, axis] of ORDER) {
		if (ch === channel) return s;
		const push = [...zero]; push[axis] = travel;
		s = feed(s, push, CAL_TIMING.holdMs + 200);
		if (ch === 'throttle') {
			// A self-centring stick: let go, it comes back — half travel, so no
			// THROTTLE — FULL DOWN prompt to cross.
			s = feed(s, zero, CAL_TIMING.releaseMinMs + CAL_TIMING.holdMs + 200);
		} else {
			s = feed(s, zero, 200);
		}
	}
	return s;
}

const moves = (pose) => Object.entries(pose).filter(([, v]) => Math.abs(v) > 1e-6).map(([k]) => k).sort();

t('HANDS OFF: the machine does not move, even with a signal far off centre', () => {
	// That is the prompt on screen. A machine flailing during "do not touch
	// anything" would tell the pilot the opposite of what is being asked.
	const s = beginCalibration(AXES);
	assert.equal(s.phase, 'rest');
	assert.deepEqual(moves(calibrationPose({ state: s, signals: [0.9, 0, 0, 0] })), []);
});

t('during a prompt, ONLY the channel asked for moves', () => {
	for (const [channel, axis] of [['yaw', 3], ['pitch', 1], ['roll', 0]]) {
		const s = upTo(channel);
		const push = [...zero]; push[axis] = 1;
		assert.deepEqual(moves(calibrationPose({ state: s, signals: push })), [channel],
			`${channel}: another channel moved`);
	}
});

t('THROTTLE: the machine climbs, and nothing else moves', () => {
	const s = upTo('throttle');
	assert.deepEqual(moves(calibrationPose({ state: s, signals: [0, 0, 1, 0] })), ['throttle']);
	assert.equal(calibrationPose({ state: s, signals: zero }).throttle, 0);
});

t('an INVERTED throttle still makes the machine climb', () => {
	// The gesture asked for is "throttle up". If the radio reports a negative axis,
	// the machine must climb anyway: at this point the direction is not measured
	// yet, and a machine going down would accuse the pilot wrongly.
	const s = upTo('throttle');
	assert.ok(calibrationPose({ state: s, signals: [0, 0, -1, 0] }).throttle > 0.9);
});

t('the scale follows THIS radio\'s travel, not an assumed one', () => {
	// A radio whose endpoints are not set only puts out 0.6. The pilot is at their
	// stop all the same: the machine must be at full deflection.
	const short = upTo('yaw', { travel: 0.6 });
	const pose = calibrationPose({ state: short, signals: [0, 0, 0, 0.6] });
	assert.ok(pose.yaw > 0.95, `short travel: yaw ${pose.yaw}`);
});

t('nothing ever leaves the bounds', () => {
	const s = upTo('roll');
	for (const v of [-3, -1, 0, 1, 3]) {
		const pose = calibrationPose({ state: s, signals: [v, 0, 0, 0] });
		for (const [k, x] of Object.entries(pose)) {
			assert.ok(Number.isFinite(x), `${k} is not finite`);
			assert.ok(x >= (k === 'throttle' ? 0 : -1) && x <= 1, `${k} = ${x}`);
		}
	}
});

t('the replay starts from zero, peaks, and comes back to EXACTLY zero', () => {
	// If it did not come back to zero, the machine would stay tilted after the
	// confirmation and the pilot would read a deflection they did not ask for.
	assert.deepEqual(moves(replayPose('roll', 0)), []);
	assert.ok(replayPose('roll', REPLAY_MS / 2).roll > 0.9);
	assert.deepEqual(moves(replayPose('roll', REPLAY_MS)), []);
	assert.deepEqual(moves(replayPose('roll', REPLAY_MS * 3)), []);
});

t('a replay in progress takes priority over the sticks', () => {
	// The pilot is still holding their stick when the confirmation starts: it is the
	// REPLAYED gesture they must see, not their own.
	const s = upTo('yaw');
	const pose = calibrationPose({ state: s, signals: [0, 0, 0, 1], replay: { channel: 'roll', elapsedMs: REPLAY_MS / 2 } });
	assert.deepEqual(moves(pose), ['roll']);
});

t('CALIBRATED: the four sticks fly the machine', () => {
	// The test bench, for free: once the measurement is over, the machine follows
	// the calibration just written.
	let s = upTo('roll');
	s = feed(s, [1, 0, 0, 0], CAL_TIMING.holdMs + 200);
	// The four sticks lead into the two menu gestures and the flight-mode control;
	// a four-axis device with no button has nothing to measure there, and the
	// pilot skips all three.
	s = skipStep(skipStep(skipStep(s)));
	assert.equal(s.phase, 'done', 'the scenario must complete');
	assert.ok(calibrationPose({ state: s, signals: [1, 0, 0, 0] }).roll > 0.9);
	assert.ok(calibrationPose({ state: s, signals: [0, 0, 1, 0] }).throttle > 0.9);
	assert.deepEqual(moves(calibrationPose({ state: s, signals: zero })), []);
});

t('with no state, the pose is neutral rather than an exception', () => {
	// The panel paints before the wizard starts.
	assert.deepEqual(moves(calibrationPose()), []);
	assert.deepEqual(moves(calibrationPose({ state: null, signals: [1, 1, 1, 1] })), []);
});

t('a channel only replays its gesture once its measurement is FINISHED', () => {
	// The throttle enters `channels` as soon as its ceiling is measured, but it is
	// still under way until its travel mode is decided. Replaying it then would move
	// the machine while the pilot is being asked to LET GO.
	let s = feed(beginCalibration(AXES), zero, CAL_TIMING.restMs + 200);
	assert.deepEqual(completedChannels(s), []);

	s = feed(s, [0, 0, 1, 0], CAL_TIMING.holdMs + 200);
	assert.equal(s.phase, 'throttle-release');
	assert.ok(s.channels.throttle, 'the ceiling is measured');
	assert.deepEqual(completedChannels(s), [], 'but the throttle is not finished');

	s = feed(s, zero, CAL_TIMING.releaseMinMs + CAL_TIMING.holdMs + 200);
	assert.deepEqual(completedChannels(s), ['throttle'], 'travel mode decided: finished');

	s = feed(s, [0, 0, 0, 1], CAL_TIMING.holdMs + 200);
	assert.deepEqual(completedChannels(s), ['throttle', 'yaw']);
});

t('completedChannels does not throw on an empty state', () => {
	assert.deepEqual(completedChannels(), []);
	assert.deepEqual(completedChannels(beginCalibration(AXES)), []);
});

console.log(`\ncalibration-preview: ${n} tests ok`);

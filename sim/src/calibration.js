// Guided calibration of a radio or a gamepad (issue #277).
//
// This module MEASURES the device where input.js GUESSES it: padKind() reads a
// USB string and deduces a fixed profile, which leaves a radio missing from the
// brand list on a wrong axis order AND a half-travel throttle. Nothing here is
// deduced from a name: one gesture is asked for at a time, and what moved is
// what gets written down.
//
// A PURE state machine: no DOM, no localStorage, no real time — it is handed a
// `pad.axes` snapshot and a `dt` in milliseconds, and returns the next state.
// That is what makes it replayable in tools/calibration-selftest.mjs, where real
// hardware sequences (EdgeTX, DualShock 4) are checked with nothing plugged in.
//
// The prompts are in English: that is the language of the game's interface (D5,
// issue #120).

// Order of the prompts. The throttle first: it is the one that decides the
// travel mode (phase 'throttle-release'), and the travel mode changes how the
// axis is read for the whole rest of the session.
export const CAL_CHANNELS = ['throttle', 'yaw', 'pitch', 'roll'];

// The two menu gestures, measured after the sticks. Same philosophy as above:
// on a radio, "button 0" is a switch POSITION — an inter left on one side reads
// as permanently pressed, and no momentary button that confirms anything is
// reachable. So the pilot is asked for the gesture and the machine watches.
export const CAL_MENU_STEPS = ['confirm', 'back'];

// The flight-mode control, measured last (see THE FLIGHT-MODE CONTROL below).
// Its phases: 'mode' (the first gesture), 'mode-release' (does it spring back?),
// 'mode-angle' (a switch's second position).
export const CAL_MODE_PHASES = ['mode', 'mode-release', 'mode-angle'];

// -----------------------------------------------------------------------------
// WHAT IS MEASURED: EVERYTHING THE DEVICE REPORTS (issue #279)
//
// A stick is not necessarily on an axis. Firefox applies `mapping: "standard"`
// to an EdgeTX radio and files its throttle stick in the L2 trigger slot: the
// throttle then comes out on `buttons[6].value`, analogue, and the fourth axis
// stays dead. Measured on a Radiomaster Pocket — `btn 6` reads 0.997 there, a
// value a DIGITAL button cannot produce.
//
// #277 already refused to deduce anything from the USB name, but kept that one
// assumption without measuring it. Here axes and buttons enter one vector and
// are treated alike.
//
// Buttons are brought onto the axis travel — rest at -1, full press at +1 — for
// two reasons: every threshold in the module (PUSH_MIN, HOLD_TOL,
// REST_MAX_SPREAD…) is calibrated on a travel of 2 and so keeps the meaning it
// was measured with; and a trigger at rest then reads exactly like a friction
// throttle stick parked at the bottom, which is what it is.
// -----------------------------------------------------------------------------

export function padSignals(pad) {
	const axes = pad?.axes ?? [];
	const buttons = pad?.buttons ?? [];
	return [...axes, ...buttons.map((b) => (b?.value ?? 0) * 2 - 1)];
}

// A pilot reading "axis 14" on a device that announces 8 axes believes it is a
// bug. The summary must name the entry the way the browser names it.
export function signalLabel(i, axisCount) {
	return i < axisCount ? `axis ${i}` : `btn ${i - axisCount}`;
}

// The gesture asked for always designates the channel's POSITIVE direction, as
// flightController expects it: throttle up, yaw right, roll right, and POSITIVE
// pitch = nose up (input.js: "stick pushed forward = nose drops", so pulled
// towards you = nose up). Asking for "pull towards you" rather than "push
// forward" avoids having to explain an inversion to the pilot.
//
// The prompt is SHORT — it is shown at 22 px in a narrow panel, and a prompt
// that breaks in the middle of a sentence is read twice. What explains it goes
// into CAL_HINTS, at body text size.
export const CAL_PROMPTS = {
	rest: 'HANDS OFF',
	throttle: 'THROTTLE — FULL UP',
	yaw: 'YAW — FULL RIGHT',
	pitch: 'PITCH — PULL BACK',
	roll: 'ROLL — FULL RIGHT',
	throttleRelease: 'THROTTLE — LET GO',
	throttleMin: 'THROTTLE — FULL DOWN',
	menuConfirm: 'MENU — CONFIRM',
	menuBack: 'MENU — GO BACK',
	modeAcro: 'FLIGHT MODE — ACRO',
	modeRelease: 'FLIGHT MODE — LET GO',
	modeAngle: 'FLIGHT MODE — ANGLE',
	done: 'CALIBRATED',
};

export const CAL_HINTS = {
	rest: 'measuring the neutral — do not touch the sticks',
	throttle: 'push it there and hold',
	yaw: 'push it there and hold',
	pitch: 'toward you — that is nose up',
	roll: 'push it there and hold',
	throttleRelease: 'let go and wait — full or half travel?',
	throttleMin: 'hold it at the bottom',
	menuConfirm: 'press the button you use to CONFIRM — or skip it',
	menuBack: 'press the button you use to GO BACK — or skip it',
	modeAcro: 'set your FLIGHT MODE switch to ACRO — or press the button you want for it',
	modeRelease: 'let go — a button springs back, a switch stays where it is',
	modeAngle: 'now set it to ANGLE',
	done: '',
};

export const CAL_TIMING = {
	// Rest window: long enough to see the noise of a Hall gimbal, short enough
	// not to feel like nothing is happening.
	restMs: 1000,
	// How long the stick has to stay at its stop for it to be written down.
	// Without the hold, a quick sweep gives an underestimated stop — and an
	// underestimated stop saturates the command before the end of the travel.
	holdMs: 400,
	// The pilot has time to let go before their rest position is read. Without
	// this delay we would read the stick still held wide open and conclude
	// "friction gimbal" on a perfectly self-centring pad.
	releaseMinMs: 800,
	// After this long with no gesture at all, the prompt says so. Long enough
	// that a pilot hunting for their stick is not accused of doing nothing, short
	// enough not to leave anyone in front of a dead screen.
	idleWarnMs: 6000,
};

// What is shown when nothing moves any more. A mute device — wrong pad selected,
// radio not in Joystick mode, stick on an input the browser does not report —
// passes the rest step BETTER than a real one: zero noise, so no rejection.
// Without this message all that is left is a prompt that never changes and
// nothing to say why (issue #279).
const IDLE_MESSAGE = 'no movement seen — wrong device, or this stick is not reported';

// The flight-mode step has one more reason to see nothing: a switch that already
// sits on ACRO cannot be moved TO ACRO. Flipping it away and back would be read
// as a button (it came back), so the honest way out is to skip and start over
// from the other position.
const MODE_IDLE_MESSAGE = 'nothing moved — switch already on ACRO? skip, set it to ANGLE, calibrate again';

// Past this amplitude during the rest window it is not noise any more: somebody
// is holding a stick. The measurement starts again.
const REST_MAX_SPREAD = 0.15;

// The measured deadband covers the noise with margin, bounded on both sides: a
// floor so a device is not believed perfect, a ceiling so the travel is not
// eaten if the user moved during the rest window.
const NOISE_MARGIN = 1.5;
const DEADBAND_MIN = 0.02;
const DEADBAND_MAX = 0.25;

// Deviation from neutral below which no gesture is considered made. In raw axis
// units, where full travel is 2.
const PUSH_MIN = 0.5;

// Tolerance for "the stick has stopped moving" and "the stick is back at
// neutral".
const HOLD_TOL = 0.1;
const RETURN_TOL = 0.2;

// The chosen axis has to clearly dominate the runner-up. A pilot pushing
// diagonally produces two comparable deviations: better to ask again than to
// assign at random a mapping they will then believe calibrated.
const AMBIGUITY_RATIO = 2;

function restState(signalCount, axisCount, message = null) {
	return {
		phase: 'rest',
		channel: null,
		prompt: CAL_PROMPTS.rest,
		hint: CAL_HINTS.rest,
		message,
		done: false,
		signalCount,
		// ONLY used for naming: past it, a signal is a button (signalLabel).
		axisCount,
		centers: null,
		deadband: 0,
		channels: {},
		throttleMode: null,
		_elapsed: 0,
		_n: 0,
		_sum: new Array(signalCount).fill(0),
		_min: new Array(signalCount).fill(Infinity),
		_max: new Array(signalCount).fill(-Infinity),
	};
}

// `signalCount` is the length of the vector padSignals() returns, `axisCount`
// the device's real axis count — the border past which a signal is a button. By
// default the two coincide: a caller passing only axes keeps the pre-#279
// behaviour.
export function beginCalibration(signalCount, axisCount = signalCount) {
	return restState(signalCount, axisCount);
}

// -----------------------------------------------------------------------------
// WHAT THE PILOT IS PUSHING
//
// The panel's bar already applied this rule by copying it. The wizard now draws
// a machine that follows the same gesture (issue #281): both must watch the SAME
// signal, otherwise the bar and the drone contradict each other.
// -----------------------------------------------------------------------------

export function strongestSignal(state, signals) {
	const centers = state?.centers;
	if (!centers) return { index: 0, dev: 0, span: PUSH_MIN, at: 0 };

	let index = 0, dev = 0;
	for (let i = 0; i < centers.length; i++) {
		const d = (signals[i] ?? 0) - centers[i];
		if (Math.abs(d) > Math.abs(dev)) { index = i; dev = d; }
	}

	// The full-travel reference is the PEAK this pilot reached themselves on this
	// signal, with PUSH_MIN as a floor. So the machine reaches full deflection
	// when they reach THEIR stop — a radio whose endpoints are not set does not
	// give a sluggish machine.
	const span = Math.max(PUSH_MIN, Math.abs(state._peaks?.[index] ?? 0), Math.abs(dev));
	return { index, dev, span, at: dev / span };
}

// -----------------------------------------------------------------------------
// REST
// -----------------------------------------------------------------------------

function feedRest(state, axes, dt) {
	const s = { ...state, _sum: [...state._sum], _min: [...state._min], _max: [...state._max] };
	s._elapsed += dt;
	s._n += 1;

	let spread = 0;
	for (let i = 0; i < s.signalCount; i++) {
		const v = axes[i] ?? 0;
		s._sum[i] += v;
		s._min[i] = Math.min(s._min[i], v);
		s._max[i] = Math.max(s._max[i], v);
		spread = Math.max(spread, s._max[i] - s._min[i]);
	}

	// A stick held during the measurement offsets the neutral, and with it
	// EVERYTHING else in the calibration: every deviation is measured against
	// that neutral.
	if (spread > REST_MAX_SPREAD) {
		return restState(s.signalCount, s.axisCount, 'stick moved — measuring neutral again');
	}

	if (s._elapsed < CAL_TIMING.restMs) return s;

	const centers = s._sum.map((sum) => sum / s._n);
	// The noise kept is the half-amplitude of the busiest axis: the deadband is
	// common to the four channels, as the constant it replaces was.
	const noise = Math.max(...s._min.map((lo, i) => (s._max[i] - lo) / 2));
	const deadband = Math.min(DEADBAND_MAX, Math.max(DEADBAND_MIN, noise * NOISE_MARGIN));

	return beginChannel({ ...s, centers, deadband }, 0);
}

// -----------------------------------------------------------------------------
// ONE CHANNEL AT A TIME
// -----------------------------------------------------------------------------

function beginChannel(state, i, message = null) {
	return {
		...state,
		phase: 'channel',
		channel: CAL_CHANNELS[i],
		prompt: CAL_PROMPTS[CAL_CHANNELS[i]],
		hint: CAL_HINTS[CAL_CHANNELS[i]],
		message,
		_channelIndex: i,
		_peaks: new Array(state.signalCount).fill(0),
		_holdMs: 0,
		_idleMs: 0,
		// Until the sticks have been seen at neutral, no gesture is accepted:
		// after a rejection they are still pushed, and without this latch we
		// would reject the same thing in a loop without the pilot doing anything.
		_armed: false,
	};
}

// Asks the current prompt again, saying why.
function retryChannel(state, message) {
	return { ...beginChannel(state, state._channelIndex), message };
}

function feedChannel(state, axes, dt) {
	const dev = state.centers.map((c, i) => (axes[i] ?? 0) - c);

	if (!state._armed) {
		const centered = dev.every((d) => Math.abs(d) < PUSH_MIN / 2);
		return centered ? { ...state, _armed: true } : state;
	}

	// Nothing seen for long enough: this is no longer "the pilot is aiming", it
	// is a device whose stick comes out nowhere. Say it without giving up — they
	// may still have another stick to try.
	const quiet = dev.every((d) => Math.abs(d) < PUSH_MIN / 2);
	const idleMs = quiet ? state._idleMs + dt : 0;
	if (quiet && idleMs >= CAL_TIMING.idleWarnMs) {
		return { ...state, _idleMs: idleMs, message: IDLE_MESSAGE };
	}

	const peaks = state._peaks.map((p, i) => (Math.abs(dev[i]) > Math.abs(p) ? dev[i] : p));

	// The candidate axis is the one with the largest peak deviation, and the
	// gesture only counts once it is HELD at that peak.
	let win = 0;
	for (let i = 1; i < peaks.length; i++) if (Math.abs(peaks[i]) > Math.abs(peaks[win])) win = i;

	const held =
		Math.abs(peaks[win]) >= PUSH_MIN &&
		Math.abs(dev[win] - peaks[win]) <= HOLD_TOL;

	const holdMs = held ? state._holdMs + dt : 0;
	const s = { ...state, _peaks: peaks, _holdMs: holdMs, _idleMs: idleMs };
	if (holdMs < CAL_TIMING.holdMs) return s;

	const second = Math.max(...peaks.map((p, i) => (i === win ? 0 : Math.abs(p))));
	if (second * AMBIGUITY_RATIO > Math.abs(peaks[win])) {
		return retryChannel(s, 'two axes moved together — release everything and try again');
	}

	const taken = CAL_CHANNELS.find((ch) => s.channels[ch]?.axis === win);
	if (taken) {
		return retryChannel(s, `axis ${win} is already ${taken} — use a different stick`);
	}

	return assignChannel(s, win, peaks[win]);
}

function assignChannel(state, axis, peak) {
	const center = state.centers[axis];

	// The throttle is not described like the other three: it has no neutral in
	// the middle, it has a floor and a ceiling. The ceiling has just been
	// measured; the floor depends on the stick's mechanics, which is what gets
	// observed next.
	if (state.channel === 'throttle') {
		return {
			...state,
			phase: 'throttle-release',
			prompt: CAL_PROMPTS.throttleRelease,
			hint: CAL_HINTS.throttleRelease,
			message: null,
			channels: { ...state.channels, throttle: { axis, lo: center, hi: center + peak } },
			_phaseMs: 0,
			_holdMs: 0,
			_lastVal: center + peak,
		};
	}

	const channels = {
		...state.channels,
		[state.channel]: { axis, center, span: Math.abs(peak), invert: peak < 0 },
	};
	const next = state._channelIndex + 1;
	if (next < CAL_CHANNELS.length) return beginChannel({ ...state, channels }, next);

	// The sticks are done; the two menu gestures follow.
	return beginMenuStep({ ...state, channels }, 0);
}

// -----------------------------------------------------------------------------
// THROTTLE TRAVEL MODE — the measurement that replaces the brand
// -----------------------------------------------------------------------------

// One question, asked of the hardware rather than of a vendor table: when the
// stick is let go, does it come back to neutral?
//   yes -> self-centring stick: half travel, floor = neutral. Otherwise letting
//          go of the pad would leave 50 % throttle and put the disarm gesture
//          out of reach at rest.
//   no  -> friction gimbal: full travel, and the floor has to be hunted down,
//          because it is NOT the neutral.
function feedThrottleRelease(state, axes, dt) {
	const v = axes[state.channels.throttle.axis] ?? 0;
	const moved = Math.abs(v - state._lastVal) > HOLD_TOL;
	const s = {
		...state,
		_phaseMs: state._phaseMs + dt,
		_holdMs: moved ? 0 : state._holdMs + dt,
		_lastVal: moved ? v : state._lastVal,
	};

	if (s._phaseMs < CAL_TIMING.releaseMinMs || s._holdMs < CAL_TIMING.holdMs) return s;

	const center = s.centers[s.channels.throttle.axis];
	if (Math.abs(s._lastVal - center) <= RETURN_TOL) {
		return beginChannel({ ...s, throttleMode: 'half' }, 1);
	}

	return {
		...s,
		phase: 'throttle-min',
		throttleMode: 'full',
		prompt: CAL_PROMPTS.throttleMin,
		hint: CAL_HINTS.throttleMin,
		_holdMs: 0,
		_lastVal: s._lastVal,
	};
}

function feedThrottleMin(state, axes, dt) {
	const { axis, hi } = state.channels.throttle;
	const v = axes[axis] ?? 0;
	const moved = Math.abs(v - state._lastVal) > HOLD_TOL;
	const s = {
		...state,
		_holdMs: moved ? 0 : state._holdMs + dt,
		_lastVal: moved ? v : state._lastVal,
	};

	// Held, and far enough from the ceiling to be the other end of the travel.
	if (s._holdMs < CAL_TIMING.holdMs || Math.abs(s._lastVal - hi) < PUSH_MIN) return s;

	const channels = { ...s.channels, throttle: { axis, lo: s._lastVal, hi } };
	return beginChannel({ ...s, channels }, 1);
}

// -----------------------------------------------------------------------------
// THE TWO MENU GESTURES
//
// Same machine as a stick channel, minus the direction: what is kept is the
// SIGNAL and its two measured ends (rest and pressed), so that "pressed" is a
// threshold halfway between them. That one formula reads a digital button
// (-1 -> +1) and a radio switch filed on an axis alike — and a switch is exactly
// what buttons 0 and 1 are on a radio, which is why nothing usable was reachable
// before.
//
// The index space is the module's own: axes THEN buttons (#279). A confirm
// "button" can therefore be any signal in that vector, an analogue trigger
// included.
//
// BOTH STEPS ARE SKIPPABLE (skipStep): a standard pad has no need of them,
// its buttons 0 and 1 are momentary and menu-nav.js falls back to those.
// -----------------------------------------------------------------------------

function beginMenuStep(state, i, message = null) {
	const which = CAL_MENU_STEPS[i];
	return {
		...state,
		phase: `menu-${which}`,
		channel: null,
		prompt: which === 'confirm' ? CAL_PROMPTS.menuConfirm : CAL_PROMPTS.menuBack,
		hint: which === 'confirm' ? CAL_HINTS.menuConfirm : CAL_HINTS.menuBack,
		message,
		menu: state.menu ?? {},
		_menuIndex: i,
		_peaks: new Array(state.signalCount).fill(0),
		_holdMs: 0,
		_idleMs: 0,
		_armed: false,
	};
}

function retryMenuStep(state, message) {
	return { ...beginMenuStep(state, state._menuIndex), message };
}

function finishCalibration(state) {
	return {
		...state,
		phase: 'done',
		channel: null,
		prompt: CAL_PROMPTS.done,
		hint: CAL_HINTS.done,
		message: null,
		done: true,
	};
}

// The steps a pilot may skip: the two menu gestures and the flight-mode control.
// Never a stick — skipping one would offer a calibration with no stick in it.
export function isSkippableStep(state) {
	const phase = String(state?.phase);
	return phase.startsWith('menu-') || CAL_MODE_PHASES.includes(phase);
}

// Explicit skip, from a button or a key in the panel. Anywhere else it is a
// no-op: the state machine decides nothing on its own here. Skipping the mode
// step half way (after the first gesture) keeps nothing of it: half a switch is
// not a measurement.
export function skipStep(state) {
	if (!state || !isSkippableStep(state)) return state;
	if (CAL_MODE_PHASES.includes(state.phase)) {
		const { mode: _dropped, ...rest } = state;
		return finishCalibration(rest);
	}
	const next = state._menuIndex + 1;
	return next < CAL_MENU_STEPS.length
		? beginMenuStep(state, next)
		: beginModeStep(state);
}

function feedMenuStep(state, signals, dt) {
	const dev = state.centers.map((c, i) => (signals[i] ?? 0) - c);

	if (!state._armed) {
		// The gesture that validated the previous step is probably still held: the
		// step only arms once everything is back at rest.
		const centered = dev.every((d) => Math.abs(d) < PUSH_MIN / 2);
		return centered ? { ...state, _armed: true } : state;
	}

	const quiet = dev.every((d) => Math.abs(d) < PUSH_MIN / 2);
	const idleMs = quiet ? state._idleMs + dt : 0;
	if (quiet && idleMs >= CAL_TIMING.idleWarnMs) {
		return { ...state, _idleMs: idleMs, message: IDLE_MESSAGE };
	}

	const peaks = state._peaks.map((p, i) => (Math.abs(dev[i]) > Math.abs(p) ? dev[i] : p));
	let win = 0;
	for (let i = 1; i < peaks.length; i++) if (Math.abs(peaks[i]) > Math.abs(peaks[win])) win = i;

	const held =
		Math.abs(peaks[win]) >= PUSH_MIN &&
		Math.abs(dev[win] - peaks[win]) <= HOLD_TOL;

	const holdMs = held ? state._holdMs + dt : 0;
	const s = { ...state, _peaks: peaks, _holdMs: holdMs, _idleMs: idleMs };
	if (holdMs < CAL_TIMING.holdMs) return s;

	// A stick is not a menu button: taking one would make every cursor move
	// validate the screen. Same rule as a channel already taken — say it, ask
	// again.
	const stick = CAL_CHANNELS.find((ch) => s.channels[ch]?.axis === win);
	if (stick) {
		return retryMenuStep(s, `that signal is ${stick} — use a button or a switch`);
	}
	const other = CAL_MENU_STEPS.find((k) => k !== CAL_MENU_STEPS[s._menuIndex] && s.menu?.[k]?.signal === win);
	if (other) {
		return retryMenuStep(s, `that one is already ${other} — use another`);
	}

	const center = s.centers[win];
	const menu = {
		...s.menu,
		[CAL_MENU_STEPS[s._menuIndex]]: { signal: win, center, on: center + peaks[win] },
	};
	const next = s._menuIndex + 1;
	return next < CAL_MENU_STEPS.length
		? beginMenuStep({ ...s, menu }, next)
		: beginModeStep({ ...s, menu });
}

// -----------------------------------------------------------------------------
// THE FLIGHT-MODE CONTROL
//
// Same philosophy again: the pilot is asked for a gesture and the machine
// watches. What it watches for is not only WHICH signal moved but HOW, because
// that is what tells the two kinds of control apart without asking:
//   - a radio switch (Betaflight's AUX channel) STAYS where it is put. Each
//     position is a mode: the pilot is asked for ACRO, then for ANGLE, and both
//     values are written down. In flight the nearest of the two wins.
//   - a pad button SPRINGS BACK when released. It can only cycle: stored like a
//     menu button, read as a rising edge.
//
// THE DECISION WINDOW is the throttle-release one, reused on purpose: at least
// CAL_TIMING.releaseMinMs (800 ms) since the gesture was accepted, and the
// signal still for CAL_TIMING.holdMs (400 ms, within HOLD_TOL). 800 ms is what
// the module already measured as "the time a pilot needs to let go" once the
// prompt changes; the extra stillness keeps a button caught mid-release from
// being read where it happens to be. Back within RETURN_TOL of its rest value it
// is a button, anywhere else it is a switch. A pilot who keeps a button pressed
// past that is read as a switch — the LET GO prompt is there to prevent it, and
// the ANGLE prompt that follows says at once that something is off.
//
// Skippable, like the menu steps: an uncalibrated pad has a default cycle
// button (input.js), and a radio without a mode switch starts in ACRO.
// -----------------------------------------------------------------------------

function beginModeStep(state, message = null) {
	return {
		...state,
		phase: 'mode',
		channel: null,
		prompt: CAL_PROMPTS.modeAcro,
		hint: CAL_HINTS.modeAcro,
		message,
		_peaks: new Array(state.signalCount).fill(0),
		_holdMs: 0,
		_idleMs: 0,
		_armed: false,
	};
}

function feedModeStep(state, signals, dt) {
	const dev = state.centers.map((c, i) => (signals[i] ?? 0) - c);
	const quiet = dev.every((d) => Math.abs(d) < PUSH_MIN / 2);

	if (!state._armed) return quiet ? { ...state, _armed: true } : state;

	const idleMs = quiet ? state._idleMs + dt : 0;
	if (quiet && idleMs >= CAL_TIMING.idleWarnMs) {
		return { ...state, _idleMs: idleMs, message: MODE_IDLE_MESSAGE };
	}

	const peaks = state._peaks.map((p, i) => (Math.abs(dev[i]) > Math.abs(p) ? dev[i] : p));
	let win = 0;
	for (let i = 1; i < peaks.length; i++) if (Math.abs(peaks[i]) > Math.abs(peaks[win])) win = i;

	const held =
		Math.abs(peaks[win]) >= PUSH_MIN &&
		Math.abs(dev[win] - peaks[win]) <= HOLD_TOL;

	const holdMs = held ? state._holdMs + dt : 0;
	const s = { ...state, _peaks: peaks, _holdMs: holdMs, _idleMs: idleMs };
	if (holdMs < CAL_TIMING.holdMs) return s;

	// A stick would change mode on every manoeuvre; a menu gesture would change
	// it on every confirm. Same refusals as the menu steps.
	const stick = CAL_CHANNELS.find((ch) => s.channels[ch]?.axis === win);
	if (stick) return beginModeStep(s, `that signal is ${stick} — use a switch or a button`);
	const menu = CAL_MENU_STEPS.find((k) => s.menu?.[k]?.signal === win);
	if (menu) return beginModeStep(s, `that one is already ${menu} — use another`);

	const on = s.centers[win] + peaks[win];
	return {
		...s,
		phase: 'mode-release',
		prompt: CAL_PROMPTS.modeRelease,
		hint: CAL_HINTS.modeRelease,
		message: null,
		_modeSignal: win,
		_modeOn: on,
		_phaseMs: 0,
		_holdMs: 0,
		_lastVal: on,
	};
}

function feedModeRelease(state, signals, dt) {
	const v = signals[state._modeSignal] ?? 0;
	const moved = Math.abs(v - state._lastVal) > HOLD_TOL;
	const s = {
		...state,
		_phaseMs: state._phaseMs + dt,
		_holdMs: moved ? 0 : state._holdMs + dt,
		_lastVal: moved ? v : state._lastVal,
	};
	if (s._phaseMs < CAL_TIMING.releaseMinMs || s._holdMs < CAL_TIMING.holdMs) return s;

	const center = s.centers[s._modeSignal];
	if (Math.abs(s._lastVal - center) <= RETURN_TOL) {
		return finishCalibration({
			...s,
			mode: { signal: s._modeSignal, type: 'cycle', center, on: s._modeOn },
		});
	}

	// It stayed: a switch. Its ACRO value is where it settled, not the peak — a
	// switch filed on an axis can overshoot on the way.
	return {
		...s,
		phase: 'mode-angle',
		prompt: CAL_PROMPTS.modeAngle,
		hint: CAL_HINTS.modeAngle,
		message: null,
		_modeAcro: s._lastVal,
		_holdMs: 0,
		_idleMs: 0,
	};
}

// Only the switch found above is watched: the pilot is moving THAT control, and
// anything else moving is noise here, not an answer.
function feedModeAngle(state, signals, dt) {
	const v = signals[state._modeSignal] ?? 0;
	const moved = Math.abs(v - state._lastVal) > HOLD_TOL;
	const far = Math.abs(v - state._modeAcro) >= PUSH_MIN;
	const s = {
		...state,
		_holdMs: moved || !far ? 0 : state._holdMs + dt,
		_idleMs: far ? 0 : state._idleMs + dt,
		_lastVal: moved ? v : state._lastVal,
	};
	if (!far && s._idleMs >= CAL_TIMING.idleWarnMs) {
		return { ...s, message: 'still on ACRO — move the same switch to ANGLE' };
	}
	if (s._holdMs < CAL_TIMING.holdMs) return s;

	return finishCalibration({
		...s,
		mode: { signal: s._modeSignal, type: 'switch', acro: s._modeAcro, angle: s._lastVal },
	});
}

// -----------------------------------------------------------------------------

export function feedSample(state, axes, dt) {
	switch (state.phase) {
		case 'rest': return feedRest(state, axes, dt);
		case 'channel': return feedChannel(state, axes, dt);
		case 'throttle-release': return feedThrottleRelease(state, axes, dt);
		case 'throttle-min': return feedThrottleMin(state, axes, dt);
		case 'menu-confirm':
		case 'menu-back': return feedMenuStep(state, axes, dt);
		case 'mode': return feedModeStep(state, axes, dt);
		case 'mode-release': return feedModeRelease(state, axes, dt);
		case 'mode-angle': return feedModeAngle(state, axes, dt);
		default: return state;
	}
}

// The {axis, invert} mapping input.js and the panel's remap table expect. The
// calibration knows more than that (neutral, travel, deadband), but it has to
// stay readable and editable by the controls that existed before it.
export function calibrationToMap(state) {
	const map = {};
	for (const ch of CAL_CHANNELS) {
		const c = state.channels[ch];
		if (!c) continue;
		map[ch] = ch === 'throttle'
			? { axis: c.axis, invert: c.hi < c.lo }
			: { axis: c.axis, invert: c.invert };
	}
	return map;
}

// -----------------------------------------------------------------------------
// READING A CALIBRATED AXIS
//
// This is where the calibration stops being a screen and becomes flight. Two of
// input.js's assumptions disappear:
//   - "the neutral is at 0" — false the moment a gimbal drifts or a friction
//     stick is parked elsewhere;
//   - "the travel is +/-1" — false on any radio whose endpoints are not set, and
//     the pilot then never gets their full deflection.
// -----------------------------------------------------------------------------

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Raw axis -> -1..1, around the MEASURED neutral and over the MEASURED travel.
// The deadband is subtracted and the remaining travel rescaled: a deadband that
// subtracts without rescaling makes the command jump as the threshold is
// crossed, and costs the same percentage of the stop.
export function normalizeChannel(v, cal, deadband) {
	if (!cal || !(cal.span > 0)) return 0;
	const signed = (cal.invert ? -1 : 1) * (v - cal.center);
	const n = clamp(signed / cal.span, -1, 1);
	if (Math.abs(n) < deadband) return 0;
	return Math.sign(n) * ((Math.abs(n) - deadband) / (1 - deadband));
}

// Raw axis -> throttle 0..1, between the MEASURED floor and ceiling. One formula
// for both stick mechanics: on a self-centring stick the floor IS the neutral,
// so letting go gives 0 — and the disarm gesture (throttle < 0.08) stays
// reachable at rest.
export function throttleFromCalibrated(v, cal) {
	if (!cal || cal.hi === cal.lo) return 0;
	return clamp((v - cal.lo) / (cal.hi - cal.lo), 0, 1);
}

// -----------------------------------------------------------------------------
// WHAT IS PERSISTED, WHAT IS SHOWN
// -----------------------------------------------------------------------------

// The machine's state drags its accumulators around (windows, peaks, timers).
// What goes into localStorage is the MEASUREMENT alone: serialisable fields, and
// nothing that would not survive a JSON round trip.
//
// `menu` is only there when at least one of the two gestures was measured: a
// pilot who skipped both writes nothing, and every calibration written before
// these two steps existed has no such field either. input.js:isValidCalibration
// therefore treats it as optional, for ever. `mode` follows the same rule: only
// when measured, and optional to every reader.
export function calibrationResult(state) {
	if (!state.done) return null;
	const { channels, deadband, throttleMode, axisCount, menu, mode } = state;
	const out = { channels, deadband, throttleMode, axisCount };
	if (menu && Object.keys(menu).length) out.menu = menu;
	if (mode) out.mode = mode;
	return out;
}

// The order of the screens, to tell the pilot where they are. The throttle
// release is a step in its own right: it is the one that decides the travel
// mode, and it asks for a gesture (letting go) the others do not.
const STEP_ORDER = [
	'rest', 'throttle', 'throttle-release', 'yaw', 'pitch', 'roll',
	'menu-confirm', 'menu-back', 'mode',
];

export function calProgress(state) {
	const total = STEP_ORDER.length;
	if (state.phase === 'done') return { step: total, total };
	// 'throttle-min' is not one more step: it is the rest of the same question —
	// where is this throttle's floor? Likewise the mode's release and second
	// position are the rest of the mode question.
	const key = state.phase === 'channel' ? state.channel
		: state.phase === 'throttle-min' ? 'throttle-release'
			: CAL_MODE_PHASES.includes(state.phase) ? 'mode'
				: state.phase;
	return { step: STEP_ORDER.indexOf(key) + 1, total };
}

// The closing summary, decided with no DOM — same role as padListEntries() for
// the device list (issue #162): this is what gets re-read when "it still does not
// work". A calibration that only announces its success is unverifiable; this one
// shows its numbers, including when they are bad (a travel of 0.80 is a radio
// problem, and it has to be visible).
export function calSummaryLines(cal) {
	const pad = (s) => s.padEnd(9, ' ');
	// A pre-#279 calibration has no axisCount: all its signals are axes, and the
	// label falls back to that.
	const where = (i) => signalLabel(i, cal.axisCount ?? Infinity);
	const lines = CAL_CHANNELS.map((name) => {
		const c = cal.channels[name];
		if (name === 'throttle') {
			const travel = cal.throttleMode === 'full' ? 'full travel' : 'half travel';
			return `${pad(name)} ${where(c.axis)}  ${travel}  ${c.lo.toFixed(2)} → ${c.hi.toFixed(2)}`;
		}
		return `${pad(name)} ${where(c.axis)}  ±${c.span.toFixed(2)}${c.invert ? '  inverted' : ''}`;
	});
	lines.push(`${pad('deadband')} ${cal.deadband.toFixed(3)}`);
	// Only when something was measured: a skipped step must not read as a
	// measurement, and menu-nav then uses buttons 0 and 1.
	const menu = CAL_MENU_STEPS
		.filter((k) => cal.menu?.[k])
		.map((k) => `${k} ${where(cal.menu[k].signal)}`);
	if (menu.length) lines.push(`${pad('menu')} ${menu.join('  ·  ')}`);
	const m = cal.mode;
	if (m?.type === 'switch') {
		lines.push(`${pad('mode')} switch ${where(m.signal)}  acro ${m.acro.toFixed(2)} · angle ${m.angle.toFixed(2)}`);
	} else if (m?.type === 'cycle') {
		lines.push(`${pad('mode')} button ${where(m.signal)}`);
	}
	return lines;
}

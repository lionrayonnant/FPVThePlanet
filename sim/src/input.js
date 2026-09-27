// Sticks are normalised to { throttle 0..1, roll/pitch/yaw -1..1 }
// regardless of whether they came from a radio or the keyboard.

import { isTextEntry } from './menu-nav.js';
import {
	CAL_CHANNELS,
	calibrationToMap,
	padSignals,
	normalizeChannel,
	throttleFromCalibrated,
} from './calibration.js';
import {
	KEY_MAP_STORAGE,
	loadKeyMap,
	actionForKey,
} from './key-map.js';

const STORAGE_KEY = 'fpvtp.gamepadMap';
// Measured calibrations, indexed PER DEVICE (issue #277). STORAGE_KEY only ever
// held one mapping for everybody: plugging in a gamepad after remapping a radio
// picked up the radio's mapping.
const CAL_STORAGE_KEY = 'fpvtp.gamepadCal';
// Default deadband, used until the device has been calibrated. A calibration
// replaces it with the noise ACTUALLY measured at rest.
const DEADBAND = 0.06;
// Fixed navigation keys, never in the key map (D13): they are forwarded to
// main.js under their own names.
const PASSTHROUGH_KEYS = ['tab', 'escape', 'enter'];
const GAMEPAD_MOVE_THRESHOLD = 0.15;

// How long a held key takes to reach full stick deflection, in seconds.
//
// A keyboard has no travel: the smallest roll command the hardware can express
// used to be an instant step to +/-1, which at the freestyle rate preset is
// 820 deg/s of roll arriving in a single frame. Nobody can fly that, and most
// people who arrive here have no radio on the desk. Ramping gives back the
// thing a stick has and a key does not — the middle of the range — simply by
// making SHORT taps small and long presses full.
//
// 150 ms is a tap: measured against the throttle integrator, which has been
// 1.2 units/s (0.83 s cut to full) since the beginning and reads as right. A
// roll axis needs to be much quicker than a throttle — it is a correction, not
// a setting — and 150 ms is about the shortest deliberate keypress a human
// makes, so a stab still gives a real fraction of the stick while a hold still
// reaches the stop. It changes nothing a gamepad does: this is the keyboard
// reader, and readGamepad() never comes through here.
//
// Symmetric on release: a spring-return gimbal does not snap to centre either.
const KEY_RAMP_S = 0.15;

// One axis of that ramp. Lands EXACTLY on the target rather than approaching it
// forever, which is what lets the mouse know the keys have finished releasing.
function rampAxis(value, target, dt) {
	if (dt <= 0) return value;
	const step = dt / KEY_RAMP_S;
	const delta = target - value;
	return Math.abs(delta) <= step ? target : value + Math.sign(delta) * step;
}

// -----------------------------------------------------------------------------
// GAMEPAD MAPPINGS
// -----------------------------------------------------------------------------

// EdgeTX radios: friction gimbals, so the left stick's whole travel is useful —
// throttle on FULL travel (see THROTTLE_MODE).
const EDGETX_MAP = {
	roll: { axis: 0, invert: false },
	pitch: { axis: 1, invert: true },
	throttle: { axis: 2, invert: false },
	yaw: { axis: 3, invert: false },
};

// -----------------------------------------------------------------------------
// SELF-CENTRING GAMEPADS (DualShock 4/DualSense, Xbox, generics)
//
// One profile only: in the browser's "standard" mapping, PlayStation and Xbox
// expose exactly the same axis layout.
//
// axis 0 = left stick X    axis 2 = right stick X
// axis 1 = left stick Y    axis 3 = right stick Y
//
// The FPV mapping wanted:
//   left  Y -> throttle (upper half only, see THROTTLE_MODE)
//   left  X -> yaw
//   right X -> roll
//   right Y -> pitch: stick pushed forward = nose drops.
//                     The axis reads -1 forward and `sticks.pitch < 0` pitches
//                     down (flightController: pitch > 0 = pitch up), so NO
//                     inversion. Same convention on the keyboard.
// -----------------------------------------------------------------------------

const GAMEPAD_MAP = {
	throttle: { axis: 1, invert: true },
	yaw: { axis: 0, invert: false },
	roll: { axis: 2, invert: false },
	pitch: { axis: 3, invert: false },
};

// How the throttle axis becomes 0..1:
//   'full': (v+1)/2 — the stick holds its position (radio).
//   'half': max(0, v) — a self-centring stick returns to 0 %, otherwise letting
//           go of the pad would leave 50 % throttle and put the disarm gesture
//           (throttle < 0.08) out of reach at rest.
export const THROTTLE_MODE = { radio: 'full', gamepad: 'half' };

// -----------------------------------------------------------------------------
// DEVICE DETECTION
// -----------------------------------------------------------------------------

// Brand names are not enough: they only cover the radios somebody thought to
// list, and an unrecognised radio falls through to 'generic', hence to
// GAMEPAD_MAP — whose four axes are in a DIFFERENT ORDER from EDGETX_MAP, with
// a half-travel throttle. The pilot does not see "badly mapped", they see "it
// does not work". Reported on a TBS Tango 2, which no word in this list caught.
//
// Hence `4f54`: the USB product id of OpenTX/EdgeTX radios — "OT" in ASCII —
// paired with vendor `1209` (pid.codes). Verified on the project's own
// hardware: the Radiomaster Pocket enumerates as 1209:4f54, and OpenTX-derived
// firmwares (including the Tango 2's FreedomTX) share that id. An id beats a
// name, exactly as 045e and 054c do below for Xbox and PlayStation.
//
// The names stay as a second line of defence, for radios that enumerate under a
// proprietary id.
//
// EVERY TOKEN ADDED BELOW IS A NAME, NOT AN ID. `4f54` stays the only
// identifier in this list because it is the only one that was seen on hardware
// here; no vendor id has been added on top of it, because an invented id would
// read as measured without being it.
//
// Brand words already cover most of the EdgeTX/OpenTX market model by model:
// `radiomaster` catches the TX12, TX16S, MT12, Zorro, Boxer and Pocket,
// `jumper` the T-Pro, T-Lite and T20, `flysky` the Noble and the Paladin,
// `betafpv` the LiteRadio, `tbs` the Mambo and the Tango. What a brand cannot
// catch is a radio whose USB string carries the MODEL alone, hence the model
// words as well.
//
// Those are kept DISCRIMINATING on purpose: a short token is how a list like
// this starts claiming game controllers. `t20` would match half the wheels and
// flight sticks on the market, `noble` and `pocket` are ordinary English words —
// none of the three is here, those radios are reached by their brand instead.
// What is here is either a coined word (`radioking`, `iflight`, `literadio`,
// `mambo`) or a model code fenced by word boundaries (`tx12`, `mt12`, `nb4`,
// `pl18`, `t-pro`, `t-lite`), which no pad id carries by accident.
const RADIO_RE =
	/4f54|edgetx|opentx|freedomtx|radiomaster|frsky|jumper|tx16|taranis|betafpv|flysky|tbs|tango|horus|boxer|zorro|commando|radioking|iflight|literadio|mambo|\btx12\b|\bmt12\b|\bnb4\b|\bpl18\b|\bt-?pro\b|\bt-?lite\b/i;

// 045e = vendor Microsoft. "xinput" covers the 360/One pads as seen through
// XInput on Windows.
const XBOX_RE =
	/xbox|xinput|045e/i;

// 054c = vendor Sony, shared by the DS4 and the DualSense. Firefox names the
// DS4 plain "Wireless Controller" — but Chrome names the Xbox pad "Xbox
// Wireless Controller", hence the order of the tests in padKind().
const PLAYSTATION_RE =
	/dualshock|dualsense|wireless controller|054c|playstation|ps[45]/i;

// 057e = vendor Nintendo (Switch Pro Controller, both Joy-Cons), 2dc8 = 8BitDo,
// whose pads speak the Switch protocol by default. NO NEW MAPPING PROFILE comes
// with this class, and that is not an oversight: in `mapping: "standard"` these
// devices expose exactly the same four axes as a DualShock and an Xbox pad, so
// defaultMapForKind() hands them GAMEPAD_MAP like everything else. The whole
// gain is a TRUE LABEL — in the SETTINGS device list and on the readiness
// screen — instead of `generic`, which reads as "unrecognised" and sends the
// pilot looking for a fix they do not need.
const NINTENDO_RE =
	/057e|2dc8|nintendo|joy-?con|switch pro|pro controller|8bitdo/i;

// 28de = vendor Valve (Steam Deck's built-in controls, Steam Controller). Same
// story as above: standard mapping, GAMEPAD_MAP, label only. A Steam Deck with
// Steam Input turned on presents itself as an Xbox pad instead, and is then
// classed 'xbox' — which is what it is behaving as, so nothing is lost.
const STEAM_RE =
	/28de|steam ?deck|steam controller|valve/i;

// Returns 'radio' | 'xbox' | 'playstation' | 'nintendo' | 'steam' | 'generic'.
// Consumers must treat this as an OPEN set: a new family is a new label, never a
// new branch elsewhere (padListEntries, readiness-model.mjs and
// throttleModeForKind all read it without enumerating it).
//
// The order matters. Radio first, because a radio can announce itself as
// "... Controller". Then Xbox before PlayStation, because of the bare "Wireless
// Controller" Firefox gives the DS4 against Chrome's "Xbox Wireless
// Controller". Nintendo and Steam come LAST of the name tests: both families
// have pads that speak another console's protocol — an 8BitDo in XInput mode
// enumerates under 045e, a Steam Deck under Steam Input looks like an Xbox pad —
// and in that mode the earlier class is the truer one. Nothing here clashes the
// other way: neither "Pro Controller" nor "Steam Deck" contains "wireless
// controller", so putting them last costs those devices nothing.
export function padKind(id) {
	const s = id || '';
	if (RADIO_RE.test(s)) return 'radio';
	if (XBOX_RE.test(s)) return 'xbox';
	if (PLAYSTATION_RE.test(s)) return 'playstation';
	if (NINTENDO_RE.test(s)) return 'nintendo';
	if (STEAM_RE.test(s)) return 'steam';
	return 'generic';
}

// The first enumerated pad is NOT the pilot's. Chrome on Linux lists every
// device the system tags ID_INPUT_JOYSTICK as soon as ANY of them has had an
// input, and keyboard/mouse receivers can be one: a Keychron Link declares 6
// axes and 16 buttons and enumerates as js0, ahead of the RadioMaster Pocket
// (reported 2026-09-27). Firefox only exposes a device after an input on IT, so
// the radio was alone there and the bug never showed. Nothing measurable tells
// such a receiver from a real unknown pad, so it is not filtered out by name —
// it is merely ranked last.
//
// For code that has no Input to ask — the screens before the operator exists,
// the intro gate. In flight, Input.getGamepad() is the authority: it adopts the
// pad that MOVES, which a keyboard receiver never does.
const PAD_RANK = (pad) => {
	const kind = padKind(pad.id);
	return kind === 'radio' ? 0 : kind === 'generic' ? 2 : 1;
};

// The most relevant enumerated pad: a radio, else a recognised pad, else an
// unknown device; enumeration order breaks ties. null when there is none.
export function bestPad(pads) {
	let best = null;
	for (const p of pads ?? []) {
		if (p && (!best || PAD_RANK(p) < PAD_RANK(best))) best = p;
	}
	return best;
}

// Whether any button of any enumerated pad is down — for a gesture that must
// answer whichever device the player is holding.
export function anyPadButtonDown(pads) {
	return (pads ?? []).some((p) => !!p?.buttons?.some((b) => b?.pressed));
}

// What the devices screen must SHOW, decided with no DOM (issue #162).
//
// `pads`: the output of listGamepads(). `activeIndex`: the index of the device
// Input is actually reading. Returns one row per device — id, deduced class
// (that class is what decides the default mapping, so it is the thing you need
// to be able to read when "it does not work"), axis and button counts, and
// whether it is active.
//
// An empty list is not "unrecognised": the Gamepad API only exposes a device
// AFTER the user has acted on it. `empty` carries that nuance so the screen can
// say it instead of leaving you to conclude.
export function padListEntries(pads, activeIndex) {
	return (pads ?? []).map((g) => ({
		index: g.index,
		id: g.id,
		kind: padKind(g.id),
		axes: g.axes,
		buttons: g.buttons,
		active: g.index === activeIndex,
		label: `${g.index === activeIndex ? '▌' : ' '} ${g.id} — ${padKind(g.id)} · ${g.axes} axes · ${g.buttons} buttons`,
	}));
}

export const PAD_LIST_EMPTY = 'nothing enumerated — move a stick or press a button on the device, '
	+ 'the browser only reveals it after an input on it';

// Said once, here, so that every screen that has to say it says the same thing:
// an unrecognised device gets the GAMEPAD profile, which is a GUESS, and the
// wizard is the way out of a guess. Shown by the CONTROLLER tab whenever
// padKind() lands on 'generic'.
export const PAD_CALIBRATE_HINT = 'unrecognised device — the channel order below is a guess; '
	+ '[ CALIBRATE ] above measures it instead';

// A controller that vanishes mid-flight used to hand the keyboard back in
// silence (a flat Bluetooth battery, a yanked cable), so the line names the
// device and says who is flying now. The id is trimmed the way the readiness
// screen trims it: a Gamepad id can be a paragraph.
export function deviceLostLine(id) {
	const name = String(id ?? '').trim().slice(0, 32).toUpperCase();
	return `CONTROLLER LOST${name ? ` — ${name}` : ''} · KEYBOARD ACTIVE`;
}

// One profile for every self-centring pad. 'nintendo' and 'steam' are
// deliberately not special-cased: in standard mapping their axis order is the
// PlayStation/Xbox one (see NINTENDO_RE).
export function defaultMapForKind(kind) {
	return structuredClone(kind === 'radio' ? EDGETX_MAP : GAMEPAD_MAP);
}

// Full travel is a statement about the HARDWARE — a friction gimbal that holds
// its position — so it stays the radio's alone, whatever families get added.
export function throttleModeForKind(kind) {
	return kind === 'radio' ? THROTTLE_MODE.radio : THROTTLE_MODE.gamepad;
}

// A -1..1 axis, inversion already undone -> throttle 0..1.
export function throttleFromAxis(v, mode) {
	const t = mode === THROTTLE_MODE.radio ? (v + 1) / 2 : v;
	return Math.max(0, Math.min(1, t));
}

export const CHANNELS = [
	'throttle',
	'yaw',
	'pitch',
	'roll',
];

// -----------------------------------------------------------------------------
// MEASURED CALIBRATION (issue #277)
//
// The calibration produced by src/calibration.js describes the device as it
// actually is: measured centre, travel and noise, observed throttle travel
// mode. It wins over `map` + `throttleMode`, which stay the path for devices
// that were never calibrated.
// -----------------------------------------------------------------------------

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function isValidCalibration(cal) {
	if (!cal || typeof cal !== 'object') return false;
	if (cal.throttleMode !== 'full' && cal.throttleMode !== 'half') return false;
	// Strictly under 1, and not negative: normalizeChannel rescales the travel
	// left over the deadband, so a stored `deadband: 1` divides by zero and the
	// stick reads NaN at full stop — a dead flight, from one bad key. The live
	// calibration never writes such a value (it clamps to DEADBAND_MIN/MAX);
	// a hand-edited or half-written entry can, and this gate is what stands
	// between that entry and the motors.
	if (!isNum(cal.deadband) || cal.deadband < 0 || cal.deadband >= 1) return false;
	// `menu` (the measured confirm/back signals) is OPTIONAL and always will be:
	// every calibration written before it existed has none, and the pilot can skip
	// those two steps. A calibration is about flying — it must never be thrown
	// away over a menu convenience, so a malformed `menu` is not fatal either: it
	// is the READER (menuButtonDown) that validates each entry and falls back to
	// buttons 0 and 1.
	if (cal.menu !== undefined && (cal.menu === null || typeof cal.menu !== 'object')) return false;
	// `mode` (the measured flight-mode control) is not even looked at here: the
	// reader (flightModeSpec) validates it and falls back, so no shape of it can
	// cost the pilot their sticks.
	const ch = cal.channels;
	if (!ch || typeof ch !== 'object') return false;
	return CAL_CHANNELS.every((name) => {
		const c = ch[name];
		if (!c || typeof c !== 'object' || !isNum(c.axis)) return false;
		return name === 'throttle'
			? isNum(c.lo) && isNum(c.hi)
			: isNum(c.center) && isNum(c.span) && typeof c.invert === 'boolean';
	});
}

// ONE device's calibration, or null. Unreadable storage falls back to null
// rather than throwing: a corrupt key must not stop the boot — same rule as
// loadMap().
export function calStoreGet(store, padId) {
	if (!store || typeof store !== 'object') return null;
	const cal = store[padId];
	return isValidCalibration(cal) ? cal : null;
}

export function calStoreSet(store, padId, cal) {
	return { ...(store && typeof store === 'object' ? store : {}), [padId]: cal };
}

// The four sticks read through the calibration. No assumptions: not "centre is
// at 0", not "travel is +/-1", not "this throttle self-centres", not "a stick is
// on an axis" (#279: `signals` carries the axes THEN the buttons, because a
// radio in "standard" mapping puts its throttle on a trigger).
export function sticksFromCalibration(signals, cal) {
	const c = cal.channels;
	const at = (name) => signals[c[name].axis] ?? 0;
	return {
		throttle: throttleFromCalibrated(at('throttle'), c.throttle),
		yaw: normalizeChannel(at('yaw'), c.yaw, cal.deadband),
		pitch: normalizeChannel(at('pitch'), c.pitch, cal.deadband),
		roll: normalizeChannel(at('roll'), c.roll, cal.deadband),
	};
}

// -----------------------------------------------------------------------------
// MENU BUTTONS (measured, issue #123 follow-up)
//
// On a radio, buttons 0 and 1 are SWITCH POSITIONS, not momentary buttons: an
// inter left on one side reads as permanently pressed, and no button that
// validates anything is reachable. So the wizard asks for the two gestures and
// watches what moves — the same philosophy as the four sticks.
//
// The index space is the module's own: axes THEN buttons (#279), because a radio
// in standard mapping can file a signal on an analogue trigger. What is stored
// is therefore a SIGNAL index plus its two measured ends, and "pressed" means
// past halfway between them — which reads a digital button (-1 -> +1) and a
// switch on an axis with the same formula.
// -----------------------------------------------------------------------------

// Rest-to-pressed travel small enough that noise alone could cross it: the
// measurement is not trusted, and the fallback takes over.
const MENU_MIN_TRAVEL = 0.4;

export function menuButtonDown(signals, spec, fallbackIndex) {
	if (spec && typeof spec === 'object' && isNum(spec.signal) && isNum(spec.center) && isNum(spec.on)) {
		const v = signals[spec.signal];
		const travel = spec.on - spec.center;
		if (!isNum(v) || Math.abs(travel) < MENU_MIN_TRAVEL) return false;
		return (v - spec.center) / travel >= 0.5;
	}
	// Nothing measured (skipped, or a calibration older than this): buttons 0 and
	// 1 of the standard gamepad, exactly as before.
	const v = signals[fallbackIndex];
	return isNum(v) && v > 0;
}

// -----------------------------------------------------------------------------
// FLIGHT-MODE CONTROL
//
// Until now only the M key changed flight mode: a pad started in ANGLE would
// have had no way back to ACRO. The wizard measures the control (calibration.js,
// THE FLIGHT-MODE CONTROL): a radio SWITCH, whose position is a mode, or a pad
// BUTTON, which cycles. Without a measurement, every class but 'radio' gets
// standard button 8 as its cycle button — Share / Create, View, −, Select, the
// one button every standard pad has and no menu uses. A radio gets no default:
// its buttons are switch positions (see MENU BUTTONS), and it starts in ACRO
// anyway, so nobody is stuck.
// -----------------------------------------------------------------------------

export const MODE_BUTTON_DEFAULT = 8;

// Button 8 as each family prints it. Anything else — 'generic' and any class
// added later — says SELECT, the name the standard mapping gives it.
const MODE_BUTTON_NAMES = { playstation: 'SHARE', xbox: 'VIEW', steam: 'VIEW', nintendo: '−' };

// The control to read, validated, or null. `mode` is the stored measurement (any
// shape: it is data from localStorage), `kind` the padKind() class or null for
// the keyboard. A malformed measurement is treated as absent, never as fatal.
export function flightModeSpec(mode, kind, axisCount) {
	if (mode && typeof mode === 'object' && isNum(mode.signal)) {
		if (mode.type === 'switch' && isNum(mode.acro) && isNum(mode.angle)
			&& Math.abs(mode.acro - mode.angle) >= MENU_MIN_TRAVEL) {
			return { type: 'switch', signal: mode.signal, acro: mode.acro, angle: mode.angle, measured: true };
		}
		if (mode.type === 'cycle' && isNum(mode.center) && isNum(mode.on)
			&& Math.abs(mode.on - mode.center) >= MENU_MIN_TRAVEL) {
			return { type: 'cycle', signal: mode.signal, center: mode.center, on: mode.on, measured: true };
		}
	}
	if (!kind || kind === 'radio' || !isNum(axisCount)) return null;
	// In the axes-then-buttons index space, a digital button rests at -1.
	return { type: 'cycle', signal: axisCount + MODE_BUTTON_DEFAULT, center: -1, on: 1, measured: false };
}

// One frame of the control: 'acro' | 'angle' for a switch (the nearer of its
// two measured positions), a boolean "held" for a cycle button, null when there
// is nothing to read.
export function readFlightMode(signals, spec) {
	if (!spec) return null;
	if (spec.type === 'switch') {
		const v = signals[spec.signal];
		if (!isNum(v)) return null;
		return Math.abs(v - spec.acro) <= Math.abs(v - spec.angle) ? 'acro' : 'angle';
	}
	return menuButtonDown(signals, spec, -1);
}

// The name the briefing and the first-flight hint print for the control, or
// null when the pad has none (an uncalibrated radio — the pilot keeps the M key).
// ONE function, so the two screens can never name different things.
export function flightModeControlName(kind, mode) {
	const spec = flightModeSpec(mode, kind, 0);
	if (!spec) return null;
	if (spec.measured) return spec.type === 'switch' ? 'MODE SWITCH' : 'MODE BUTTON';
	return MODE_BUTTON_NAMES[kind] ?? 'SELECT';
}

// The mode a flight starts in. A measured switch decides, as on a real radio.
// Otherwise a radio starts in ACRO (its pilot has proportional sticks and no
// default mode control), the keyboard (kind null) keeps ACRO by decision (see
// main.js entryCategoryCap), and every other pad starts in ANGLE — with a mode
// button it can always leave it by.
export function startFlightMode(kind, switchPosition = null) {
	if (switchPosition === 'acro' || switchPosition === 'angle') return switchPosition;
	return !kind || kind === 'radio' ? 'acro' : 'angle';
}

// What one press of a cycle BUTTON does. Not the M key's five-mode cycle: from
// ANGLE that would go through ALTITUDE and ACRO3D (props reversed, in flight)
// before reaching ACRO. The button promises ACRO / ANGLE, and from any other
// mode (reached with M) it goes back to ACRO.
export function padCycleMode(current) {
	return current === 'acro' ? 'angle' : 'acro';
}

// An "assumed" calibration built from a hand-written profile: this is what a
// manual remap becomes on a device that was never calibrated. Its travel values
// are guesses (centre 0, travel +/-1) — exactly the ones a real calibration
// replaces with measurements.
export function assumedCalibration(map, throttleMode) {
	const channels = {};
	for (const name of CAL_CHANNELS) {
		const m = map[name];
		channels[name] = name === 'throttle'
			? throttleEndpoints(m.axis, m.invert, throttleMode)
			: { axis: m.axis, center: 0, span: 1, invert: !!m.invert };
	}
	return { channels, deadband: DEADBAND, throttleMode };
}

// A manual remap applied to a calibration. The Tab panel still lets you pick
// the axis and the direction by hand: that path has to keep working ON a
// calibrated device, otherwise the "inv" box would have no effect at all.
//
// What is kept and what is thrown away: on the same axis the pilot is disputing
// a DIRECTION, not a measurement — centre and travel stay. On another axis
// nothing was ever measured, so it falls back to the guesses.
export function remapChannel(cal, channel, axis, invert) {
	const previous = cal.channels[channel];
	const sameAxis = previous?.axis === axis;

	let next;
	if (channel === 'throttle') {
		// The floor stays the floor. On a self-centring throttle that is the
		// centre: moving it would leave throttle on with the pad let go.
		next = sameAxis
			? { axis, lo: previous.lo, hi: previous.lo + (invert ? -1 : 1) * Math.abs(previous.hi - previous.lo) }
			: throttleEndpoints(axis, invert, cal.throttleMode);
	} else {
		next = sameAxis
			? { ...previous, invert: !!invert }
			: { axis, center: 0, span: 1, invert: !!invert };
	}

	return { ...cal, channels: { ...cal.channels, [channel]: next } };
}

// Floor and ceiling of a throttle whose direction is all that is known: full
// travel from stop to stop, or half travel from the centre.
function throttleEndpoints(axis, invert, throttleMode) {
	// Full travel: stop to stop, i.e. 2 axis units. Half travel: centre to one
	// stop, i.e. 1.
	const span = throttleMode === THROTTLE_MODE.radio ? 2 : 1;
	const lo = throttleMode === THROTTLE_MODE.radio ? (invert ? 1 : -1) : 0;
	return { axis, lo, hi: lo + (invert ? -span : span) };
}

// -----------------------------------------------------------------------------
// DEADZONE
// -----------------------------------------------------------------------------

function applyDeadband(v) {
	if (Math.abs(v) < DEADBAND) {
		return 0;
	}

	return (
		Math.sign(v) *
		((Math.abs(v) - DEADBAND) / (1 - DEADBAND))
	);
}

// -----------------------------------------------------------------------------
// INPUT
// -----------------------------------------------------------------------------

export class Input {
	constructor() {
		const saved = loadMap();

		this._savedMap = saved !== null;

		this.map =
			saved ??
			defaultMapForKind('generic');

		// Measured calibrations, one per device (issue #277). `calibration` is
		// the ACTIVE device's: while it is null the axes are read as before,
		// through the guessed profile.
		this._calStore = loadCalStore();
		this.calibration = null;

		// Re-evaluated when a pad is activated: a radio keeps full travel,
		// everything else goes to half travel.
		this.throttleMode = THROTTLE_MODE.gamepad;

		this.sticks = {
			throttle: 0,
			roll: 0,
			pitch: 0,
			yaw: 0,
		};

		this.gamepadIndex = null;
		this.usingGamepad = false;

		// The id of the device currently being read, kept so that its LOSS can be
		// named: once the pad is gone, navigator.getGamepads() no longer has it.
		this._activePadId = null;

		// Losing the controller in flight was silent — the keyboard simply took
		// over. This module paints nothing (no DOM here, ever): it exposes the
		// event both ways, as a callback for whoever wants to react at once and as
		// state for whoever polls. `lostDevice` is the id, or null.
		this.lostDevice = null;
		this.onDeviceLost = () => {};

		// Last state of the flight-mode cycle button, for the rising edge. null =
		// not seen yet: a button already held when reading starts fires nothing.
		this._modeHeld = null;

		this._baseline = new Map();

		// Keyboard
		this.keys = new Set();
		this.kbThrottle = 0;
		// The ramped position of the three keyboard sticks (see KEY_RAMP_S).
		// Throttle is not here: it has always been an integrator, which is a
		// stronger version of the same idea and already right.
		this.kbAxes = { roll: 0, pitch: 0, yaw: 0 };

		// Remappable bindings (D13). The map is the ONLY place a key name
		// appears from here on: nothing below compares a literal.
		this.keyMap = loadStoredKeyMap();

		// Mouse
		this.mouse = {
			x: 0,
			y: 0,
		};

		this.pointerLocked = false;

		this.onAction = () => {};

		// ---------------------------------------------------------------------
		// KEYBOARD
		// ---------------------------------------------------------------------

		window.addEventListener('keydown', (e) => {
			if (e.repeat) return;

			const k = e.key.toLowerCase();

			// A text field keeps its keys (#222): Space there is a space, not a
			// pause — main.js calls preventDefault on the action. Same rule as
			// menu-nav. Escape still goes through: it edits nothing.
			if (isTextEntry(e.target) && k !== 'escape') return;

			this.keys.add(k);

			// Bound keys are dispatched as ACTION IDS ('pause', 'photo',
			// 'benchPanel'...). Bench actions go out unconditionally — main.js
			// decides they only exist at the bench, this module knows no game
			// mode.
			const action = actionForKey(this.keyMap, k);
			if (action) {
				this.onAction(action, e);
			} else if (PASSTHROUGH_KEYS.includes(k)) {
				// Navigation, fixed and out of the map: forwarded raw.
				this.onAction(k, e);
			}

			// Space and the arrows are flight commands: stop the page from
			// scrolling.
			if (k === ' ' || k.startsWith('arrow')) {
				e.preventDefault();
			}
		});

		window.addEventListener('keyup', (e) => {
			this.keys.delete(
				e.key.toLowerCase()
			);
		});

		window.addEventListener('blur', () => {
			this.keys.clear();
		});

		// ---------------------------------------------------------------------
		// GAMEPAD CONNECTED
		// ---------------------------------------------------------------------

		window.addEventListener(
			'gamepadconnected',
			(e) => {
				const pad = e.gamepad;

				this._baseline.set(
					pad.index,
					[...pad.axes]
				);

				console.log(
					'[input] gamepad connected:',
					pad.id
				);

				console.log(
					'[input] axes:',
					[...pad.axes]
				);

				console.log(
					'[input] buttons:',
					pad.buttons.length
				);

				console.log(
					'[input] kind:',
					padKind(pad.id)
				);
			}
		);

		// ---------------------------------------------------------------------
		// GAMEPAD DISCONNECTED
		// ---------------------------------------------------------------------

		window.addEventListener(
			'gamepaddisconnected',
			(e) => {
				this._baseline.delete(
					e.gamepad.index
				);

				if (
					this.gamepadIndex ===
					e.gamepad.index
				) {
					this.gamepadIndex = null;
					this.usingGamepad = false;

					console.log(
						'[input] gamepad disconnected:',
						e.gamepad.id
					);

					this._loseDevice(e.gamepad.id);
				}
			}
		);

		// ---------------------------------------------------------------------
		// POINTER LOCK
		// ---------------------------------------------------------------------

		document.addEventListener(
			'pointerlockchange',
			() => {
				this.pointerLocked =
					document.pointerLockElement !== null;
			}
		);

		window.addEventListener(
			'mousemove',
			(e) => {
				if (!this.pointerLocked) {
					return;
				}

				this.mouse.x = Math.max(
					-1,
					Math.min(
						1,
						this.mouse.x +
							e.movementX * 0.004
					)
				);

				this.mouse.y = Math.max(
					-1,
					Math.min(
						1,
						this.mouse.y -
							e.movementY * 0.004
					)
				);
			}
		);
	}

	// ---------------------------------------------------------------------------
	// FIND ACTIVE GAMEPAD
	// ---------------------------------------------------------------------------

	getGamepad() {
		const pads =
			(navigator.getGamepads
				? navigator.getGamepads()
				: []
			).filter(Boolean);

		// Already selected
		const current = pads.find((p) => p.index === this.gamepadIndex);
		if (current) return current;

		for (const p of pads) {
			if (!this._baseline.has(p.index)) {
				this._baseline.set(p.index, [...p.axes]);
			}
		}

		// Only one pad plugged in: the movement threshold is only useful to
		// choose between several candidates ("which one moves first"). With a
		// single pad, demanding it merely prevents detection of a stick at rest
		// or too steady (a radio's Hall gimbal, say) — so adopt it directly.
		if (pads.length === 1) {
			return this._activate(pads[0]);
		}

		for (const p of pads) {
			const base = this._baseline.get(p.index);

			const moved =
				p.axes.some((v, i) => {
					const previous =
						base[i] ?? 0;

					return (
						Math.abs(
							v - previous
						) >
						GAMEPAD_MOVE_THRESHOLD
					);
				});

			if (moved) {
				return this._activate(p);
			}
		}

		return null;
	}

	// Announced ONCE per loss: the event fires, and the same disappearance seen
	// again through update() must not re-announce it. A device coming back clears
	// the state (_activate).
	_loseDevice(id) {
		const lost = id ?? this._activePadId;
		this._activePadId = null;
		// The slot is released as well, as the disconnect event does: a device that
		// comes back must be ADOPTED again — that is what re-reads its calibration
		// and clears this warning.
		this.gamepadIndex = null;
		if (!lost || this.lostDevice === lost) return;
		this.lostDevice = lost;
		this.onDeviceLost(deviceLostLine(lost), lost);
	}

	_activate(p) {
		this.gamepadIndex = p.index;
		this._activePadId = p.id;
		this.lostDevice = null;

		const kind = padKind(p.id);

		// Throttle mode always follows the hardware: it describes the stick's
		// physical travel, not a preference — a user remap has no say in it.
		this.throttleMode = throttleModeForKind(kind);

		// Automatically choose the proper map
		// unless the user has explicitly saved one.
		if (!this._savedMap) {
			this.map = defaultMapForKind(kind);
		}

		// A MEASURED calibration for THIS device wins over everything else: it
		// is the only source that guesses nothing. It also fixes the throttle
		// travel mode, which is then no longer deduced from the brand.
		this.applyCalibration(calStoreGet(this._calStore, p.id));

		console.log('[input] using gamepad:', p.id, `(${kind})`);
		console.log('[input] active map:', this.map, this.throttleMode);
		console.log('[input] calibrated:', this.calibration ? 'yes' : 'no');

		return p;
	}

	// ---------------------------------------------------------------------------
	// CALIBRATION
	// ---------------------------------------------------------------------------

	// The active device's calibration, or null to fall back to the guessed
	// profile.
	applyCalibration(cal) {
		this.calibration = cal;
		if (!cal) return;
		this.map = calibrationToMap(cal);
		this.throttleMode = cal.throttleMode;
	}

	// End of the wizard: persisted UNDER THE DEVICE ID, so that plugging in the
	// other pad does not pick this calibration up.
	setCalibration(padId, cal) {
		this._calStore = calStoreSet(this._calStore, padId, cal);
		saveCalStore(this._calStore);
		this.applyCalibration(cal);
	}

	// ---------------------------------------------------------------------------
	// MENU NAVIGATION (issue #123 follow-up)
	//
	// The menus used to read `pad.axes[0]` and `pad.axes[1]` off the FIRST
	// enumerated pad. Two bugs in one line: with a radio AND a gamepad plugged in
	// the cursor obeyed the wrong device, and on a radio in standard mapping axis
	// 1 can be the THROTTLE stick — which does not return to centre, so the cursor
	// left in one direction and never came back.
	//
	// So the direction comes from the ROLL and PITCH channels of the ACTIVE
	// device, read through the same calibrated path as the flight. Those two are
	// the only channels that self-centre on every piece of hardware, a radio
	// included (the throttle does not; yaw does, but has nothing to steer here).
	// ---------------------------------------------------------------------------

	// { x, y } in -1..1, or null when there is no device. `y` is PITCH, and its
	// sign is the flight one: -1 with the stick pushed FORWARD. menu-nav.js turns
	// that into "forward moves the cursor up".
	menuAxes() {
		const pad = this.getGamepad();
		if (!pad) return null;
		// The same two sources as readStandardGamepad(): the measurement when there
		// is one, and the guessed profile turned into a calibration otherwise. This
		// is deliberately NOT a second reading of the axes.
		const cal = this.calibration ?? assumedCalibration(this.map, this.throttleMode);
		const sticks = sticksFromCalibration(padSignals(pad), cal);
		return { x: sticks.roll, y: sticks.pitch };
	}

	// { confirm, back } as booleans for the active device, or null when there is
	// none. Measured indices when the wizard took them, buttons 0 and 1 otherwise.
	menuButtons() {
		const pad = this.getGamepad();
		if (!pad) return null;
		const signals = padSignals(pad);
		const axes = pad.axes.length;
		const menu = this.calibration?.menu;
		return {
			confirm: menuButtonDown(signals, menu?.confirm, axes + 0),
			back: menuButtonDown(signals, menu?.back, axes + 1),
		};
	}

	// ---------------------------------------------------------------------------
	// FLIGHT MODE
	// ---------------------------------------------------------------------------

	_modeSpec(pad) {
		return flightModeSpec(this.calibration?.mode, padKind(pad.id), pad.axes.length);
	}

	// 'acro' | 'angle' from a switch, every frame; 'cycle' from a button, on the
	// RISING EDGE only; null otherwise. Call it once per frame even when the
	// result is not used (paused, panel open): that is what keeps a press made
	// during a pause from firing when it ends.
	flightModeCommand() {
		const pad = this.getGamepad();
		const spec = pad ? this._modeSpec(pad) : null;
		const read = spec ? readFlightMode(padSignals(pad), spec) : null;
		if (spec?.type === 'switch') { this._modeHeld = null; return read; }
		const held = read === true;
		const edge = held && this._modeHeld === false;
		this._modeHeld = spec ? held : null;
		return edge ? 'cycle' : null;
	}

	// The mode the flight should start in, for the device plugged in now. Reads
	// the switch without touching the button's edge memory.
	startFlightMode() {
		const pad = this.getGamepad();
		if (!pad) return startFlightMode(null);
		const spec = this._modeSpec(pad);
		const pos = spec?.type === 'switch' ? readFlightMode(padSignals(pad), spec) : null;
		return startFlightMode(padKind(pad.id), pos);
	}

	// flightModeControlName() for the active device, or null (keyboard, or a
	// radio with no measured control).
	flightModeControl() {
		const pad = this.getGamepad();
		return pad ? flightModeControlName(padKind(pad.id), this.calibration?.mode) : null;
	}

	// The active device's id — the storage key for a calibration.
	activePadId() {
		return (navigator.getGamepads?.() ?? [])[this.gamepadIndex]?.id ?? null;
	}

	isCalibrated(padId = this.activePadId()) {
		return padId !== null && calStoreGet(this._calStore, padId) !== null;
	}

	// ---------------------------------------------------------------------------
	// LIST GAMEPADS
	// ---------------------------------------------------------------------------

	listGamepads() {
		return [
			...(navigator.getGamepads?.() ?? []),
		]
			.filter(Boolean)
			.map((p) => ({
				index: p.index,
				id: p.id,
				axes: p.axes.length,
				buttons: p.buttons.length,
			}));
	}

	// ---------------------------------------------------------------------------
	// MANUAL GAMEPAD SELECTION
	// ---------------------------------------------------------------------------

	selectGamepad(index) {
		this.gamepadIndex = index;

		const pad =
			(navigator.getGamepads?.() ?? [])[
				index
			];

		if (pad) {
			const kind = padKind(pad.id);

			this._activePadId = pad.id;
			this.lostDevice = null;
			this.map = defaultMapForKind(kind);
			this.throttleMode = throttleModeForKind(kind);
			this.applyCalibration(calStoreGet(this._calStore, pad.id));

			console.log(
				'[input] manually selected:',
				pad.id
			);

			console.log(
				'[input] map:',
				this.map
			);
		}
	}

	// ---------------------------------------------------------------------------
	// SAVE CUSTOM MAPPING
	// ---------------------------------------------------------------------------

	setMapping(
		channel,
		axis,
		invert
	) {
		this.map[channel] = {
			axis,
			invert,
		};

		this._savedMap = true;

		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify(this.map)
		);

		// On a calibrated device the mapping read in flight comes from the
		// calibration: without this line, changing the axis or ticking "inv"
		// would simply have no effect. The remap follows, and stays attached to
		// THIS device.
		const padId = this.activePadId();
		if (this.calibration && padId) {
			this.setCalibration(padId, remapChannel(this.calibration, channel, axis, invert));
		}
	}

	// ---------------------------------------------------------------------------
	// UPDATE
	// ---------------------------------------------------------------------------

	// `frozen` (issue #33): the simulation is frozen (pause, settings panel,
	// intro, bench) but the frame loop keeps calling update(). Without this
	// flag the keyboard throttle — an INTEGRATOR, like a real stick: it stays
	// where you leave it — climbs while you type in the panel. Typing "z" on
	// the remap page armed full throttle, and the drone shot straight up when
	// the panel closed. The gesture is not flying: it must integrate nothing.
	//
	// Only the INTEGRATION is suspended, not the reading: the pad's sticks are
	// still read (they are absolute, copying them has no side effect) and
	// `this.keys` keeps following the real keyboard state, without which a key
	// released during the freeze would stay down when it thaws.
	update(dt, { frozen = false } = {}) {
		const pad =
			this.getGamepad();

		if (
			pad &&
			this.readGamepad(pad)
		) {
			this.usingGamepad = true;
		} else {
			// The device was flying a moment ago and is not enumerated any more:
			// the keyboard is about to take over, and that has to be SAID. Firefox
			// does not always fire gamepaddisconnected on a Bluetooth pad that has
			// simply gone flat, which is why the frame loop is the second detector.
			if (this.usingGamepad && !pad) this._loseDevice(null);
			this.usingGamepad = false;
			this.readKeyboard(frozen ? 0 : dt);
		}

		return this.sticks;
	}

	// ---------------------------------------------------------------------------
	// STANDARD GAMEPAD / RADIO
	// ---------------------------------------------------------------------------

	readStandardGamepad(pad) {
		// A calibrated device: its axes are read through its own measurements —
		// centre, travel and noise taken on THIS hardware. The path below stays
		// the one for never-calibrated devices, with its guesses.
		if (this.calibration) {
			Object.assign(this.sticks, sticksFromCalibration(padSignals(pad), this.calibration));
			return true;
		}

		const raw = (channel) => {
			const m =
				this.map[channel];

			if (!m) {
				return null;
			}

			// The same index space as the calibration: the axes, then the
			// buttons (#279). A manual remap has to be able to name a trigger,
			// otherwise it cannot fix what a calibration fixes.
			const v =
				padSignals(pad)[m.axis];

			if (v === undefined) {
				return null;
			}

			return m.invert
				? -v
				: v;
		};

		const t =
			raw('throttle');

		if (t === null) {
			return false;
		}

		this.sticks.throttle =
			throttleFromAxis(
				t,
				this.throttleMode
			);

		this.sticks.yaw =
			applyDeadband(
				raw('yaw') ?? 0
			);

		this.sticks.pitch =
			applyDeadband(
				raw('pitch') ?? 0
			);

		this.sticks.roll =
			applyDeadband(
				raw('roll') ?? 0
			);

		return true;
	}

	// ---------------------------------------------------------------------------
	// GAMEPAD READER
	// ---------------------------------------------------------------------------

	// One reading path for everybody: radio, PlayStation, Xbox and generic pads
	// differ only in `this.map` and `this.throttleMode`. That is what makes the
	// Settings panel's remap effective on EVERY pad (it writes into
	// `this.map`).
	readGamepad(pad) {
		return this.readStandardGamepad(pad);
	}

	// ---------------------------------------------------------------------------
	// KEYBOARD
	// ---------------------------------------------------------------------------

	readKeyboard(dt) {
		const has = (action) =>
			this.isHeld(action);

		// Throttle
		if (has('throttleUp')) {
			this.kbThrottle +=
				dt * 1.2;
		} else if (has('throttleDown')) {
			this.kbThrottle -=
				dt * 1.2;
		}

		this.kbThrottle =
			Math.max(
				0,
				Math.min(
					1,
					this.kbThrottle
				)
			);

		let roll = 0;
		let pitch = 0;
		let yaw = 0;

		// Yaw
		if (has('yawLeft')) {
			yaw -= 1;
		}

		if (has('yawRight')) {
			yaw += 1;
		}

		// Roll
		if (has('rollLeft')) {
			roll -= 1;
		}

		if (has('rollRight')) {
			roll += 1;
		}

		// Pitch — same convention as the pad: "forward" drops the nose.
		if (has('pitchDown')) {
			pitch -= 1;
		}

		if (has('pitchUp')) {
			pitch += 1;
		}

		// Everything above is the TARGET: which way the key says to go. What the
		// machine actually gets is the ramp toward it (KEY_RAMP_S), so a tap is
		// a nudge and a hold still reaches the stop.
		this.kbAxes.roll = rampAxis(this.kbAxes.roll, roll, dt);
		this.kbAxes.pitch = rampAxis(this.kbAxes.pitch, pitch, dt);
		this.kbAxes.yaw = rampAxis(this.kbAxes.yaw, yaw, dt);

		let outRoll = this.kbAxes.roll;
		let outPitch = this.kbAxes.pitch;

		// Mouse. A deliberate exception to the convention above: the mouse is
		// not a stick you push, it is an aim. Mouse up = look up = pitch up, as
		// everywhere else.
		//
		// It takes over only once the keys have finished releasing — the ramp
		// lands exactly on zero, so this is the same "no arrow held" rule as
		// before, 150 ms later. Deliberately outside the ramp: the mouse is
		// already proportional and already self-centres (the decay below), and
		// smoothing it twice would only make aiming mushy.
		if (
			this.pointerLocked &&
			roll === 0 &&
			pitch === 0 &&
			this.kbAxes.roll === 0 &&
			this.kbAxes.pitch === 0
		) {
			outRoll = this.mouse.x;
			outPitch = this.mouse.y;

			const decay =
				Math.exp(-dt * 3.5);

			this.mouse.x *= decay;
			this.mouse.y *= decay;
		}

		this.sticks.throttle =
			this.kbThrottle;

		this.sticks.roll = outRoll;
		this.sticks.pitch = outPitch;
		this.sticks.yaw = this.kbAxes.yaw;
	}

	// ---------------------------------------------------------------------------
	// KEY MAP
	// ---------------------------------------------------------------------------

	// Settings hands over a whole map; it goes through loadKeyMap so a
	// half-built one can never leave an action unbound.
	setKeyMap(map) {
		this.keyMap = loadKeyMap(map);
		return this.keyMap;
	}

	getKeyMap() {
		return this.keyMap;
	}

	// Is any key bound to this action currently down?
	isHeld(actionId) {
		const keys = this.keyMap[actionId];
		if (!keys) return false;
		return keys.some((k) => this.keys.has(k));
	}

	// ---------------------------------------------------------------------------
	// RESET
	// ---------------------------------------------------------------------------

	resetKeyboardThrottle() {
		this.kbThrottle = 0;
		this.mouse.x = 0;
		this.mouse.y = 0;
		// A respawn must not inherit the stick the last life died holding: the
		// ramp is a position, exactly like the throttle integrator above.
		this.kbAxes.roll = 0;
		this.kbAxes.pitch = 0;
		this.kbAxes.yaw = 0;
	}
}

// -----------------------------------------------------------------------------
// LOAD SAVED MAP
// -----------------------------------------------------------------------------

// Bindings saved by the KEYBOARD tab. Same defensive rule as the calibration
// store: an unreadable key falls back to the defaults instead of breaking boot.
function loadStoredKeyMap() {
	try {
		return loadKeyMap(localStorage.getItem(KEY_MAP_STORAGE));
	} catch {
		return loadKeyMap(null);
	}
}

// Every measured calibration, all devices together. Unreadable -> {}: a corrupt
// key must not stop the sim from booting.
function loadCalStore() {
	try {
		const saved = JSON.parse(localStorage.getItem(CAL_STORAGE_KEY));
		if (saved && typeof saved === 'object') return saved;
	} catch {
		// Ignore invalid saved data.
	}
	return {};
}

function saveCalStore(store) {
	try {
		localStorage.setItem(CAL_STORAGE_KEY, JSON.stringify(store));
	} catch {
		// Full or refused storage must not break the end of the wizard: the
		// calibration stays active for the current session.
	}
}

function loadMap() {
	try {
		const saved =
			JSON.parse(
				localStorage.getItem(
					STORAGE_KEY
				)
			);

		if (
			saved &&
			CHANNELS.every(
				(channel) =>
					saved[channel] &&
					typeof saved[channel].axis ===
						'number'
			)
		) {
			return saved;
		}
	} catch {
		// Ignore invalid saved data.
	}

	return null;
}

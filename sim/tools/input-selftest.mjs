// Selftest for the pure logic of src/input.js. Almost no I/O: the exported
// helpers (pad detection, default profile, throttle axis conversion) test bare.
// The Input class itself needs `window` — the fake DOM provides it, and this is
// the ONLY place it is mounted (issue #33: the keyboard throttle is an
// integrator, and its integration has state worth checking).
// Run: node tools/input-selftest.mjs
import assert from 'node:assert/strict';
import { installFakeDom } from './lib/fake-dom.mjs';

const dom = installFakeDom();

const {
	padKind,
	bestPad,
	anyPadButtonDown,
	defaultMapForKind,
	throttleModeForKind,
	throttleFromAxis,
	THROTTLE_MODE,
	CHANNELS,
	padListEntries,
	PAD_LIST_EMPTY,
	calStoreGet,
	calStoreSet,
	isValidCalibration,
	sticksFromCalibration,
	remapChannel,
	menuButtonDown,
	deviceLostLine,
	PAD_CALIBRATE_HINT,
	flightModeSpec,
	readFlightMode,
	flightModeControlName,
	startFlightMode,
	padCycleMode,
	MODE_BUTTON_DEFAULT,
	Input,
} = await import('../src/input.js');
const { padSignals } = await import('../src/calibration.js');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

// --- padKind ----------------------------------------------------------------

t('padKind: real Xbox ids (Chrome, Firefox, XInput)', () => {
	assert.equal(padKind('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b12)'), 'xbox');
	assert.equal(padKind('045e-02fd-Xbox Wireless Controller'), 'xbox');
	assert.equal(padKind('Xbox 360 Controller (XInput STANDARD GAMEPAD)'), 'xbox');
});

t('padKind: real PlayStation ids (DS4 and DualSense)', () => {
	assert.equal(padKind('Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)'), 'playstation');
	assert.equal(padKind('054c-09cc-Wireless Controller'), 'playstation');
	assert.equal(padKind('DualSense Wireless Controller'), 'playstation');
	assert.equal(padKind('Sony DualShock 4'), 'playstation');
});

t('padKind: "Xbox Wireless Controller" does not fall through to playstation', () => {
	// PLAYSTATION_RE contains "wireless controller" (Firefox's name for the
	// DS4): without the Xbox test first, the Xbox pad landed on the wrong side.
	assert.equal(padKind('Xbox Wireless Controller'), 'xbox');
});

t('padKind: EdgeTX radios before anything else', () => {
	assert.equal(padKind('RadioMaster TX16S Joystick'), 'radio');
	assert.equal(padKind('OpenTX FrSky Taranis'), 'radio');
});

t('padKind: a radio is recognised by its USB ID, not only by its brand', () => {
	// 1209:4f54 — pid.codes / "OT" — is the shared id of OpenTX/EdgeTX radios.
	// Observed on the project's own hardware: the Radiomaster Pocket enumerates
	// this way. The two browsers format the id differently, and both must
	// pass.
	assert.equal(padKind('EdgeTX Radiomaster Pocket Joystick (Vendor: 1209 Product: 4f54)'), 'radio');
	assert.equal(padKind('1209-4f54-EdgeTX Radiomaster Pocket Joystick'), 'radio');
	// The case that motivated the fix: no brand word in the original list
	// caught a TBS Tango 2, which therefore fell to 'generic' — that is, to
	// GAMEPAD_MAP, whose axis order is different.
	assert.equal(padKind('TBS Tango 2 (Vendor: 1209 Product: 4f54)'), 'radio');
	assert.equal(padKind('TBS TANGO 2 Joystick'), 'radio');
});

t('padKind: classing a radio as generic gives WRONG axes, not a cosmetic flaw', () => {
	// Why a misclassification is experienced as "it does not work": the two
	// maps do not assign the same axes.
	const radio = defaultMapForKind('radio'), generic = defaultMapForKind('generic');
	const differing = ['throttle', 'yaw', 'roll', 'pitch'].filter((c) => radio[c].axis !== generic[c].axis);
	assert.equal(differing.length, 4, `all 4 channels must differ, ${differing.length} do`);
	assert.notEqual(throttleModeForKind('radio'), throttleModeForKind('generic'));
});

t('padKind: unknown / empty -> generic', () => {
	assert.equal(padKind('Some No-Name Pad'), 'generic');
	assert.equal(padKind(''), 'generic');
	assert.equal(padKind(undefined), 'generic');
});

t('padKind: the radios added by name, brand and model alike', () => {
	// Names only — no USB id was invented here. A radio that falls to 'generic'
	// gets GAMEPAD_MAP, whose four axes are in a different order and whose throttle
	// is half travel: the pilot experiences that as "it does not work".
	for (const id of [
		'Jumper T-Pro Joystick', 'Jumper T-Lite', 'Jumper T20 Joystick',
		'RadioMaster TX12 MKII Joystick', 'RadioMaster TX16S', 'RadioMaster MT12',
		'RadioMaster Zorro Joystick', 'RadioMaster Boxer', 'Radiomaster Pocket',
		'iFlight Commando 8', 'RadioKing TX18S', 'TBS MAMBO Joystick',
		'FlySky Noble NB4', 'NB4 Joystick', 'FlySky Paladin PL18', 'PL18 Joystick',
		'BetaFPV LiteRadio 3 Pro', 'LiteRadio 2 SE',
	]) {
		assert.equal(padKind(id), 'radio', id);
	}
});

t('padKind: the new model words do not claim a game controller', () => {
	// The reason `t20`, `noble` and `pocket` are NOT in the list: a short or
	// ordinary word is how a brand list starts catching pads. Those radios are
	// reached by their brand instead, and these ids must stay generic.
	for (const id of [
		'Some No-Name Pad', 'Thrustmaster T.16000M FCS', 'Logitech F310 Gamepad',
		'Nacon Revolution Pro', 'Generic USB Joystick', 'Hori Fighting Stick',
		'Saitek X52 Pro Flight Control System', 'T20 Racing Wheel',
		'Noble Collection Pad', 'Pocket Gamepad',
	]) {
		assert.equal(padKind(id), 'generic', id);
	}
});

t('padKind: Nintendo and 8BitDo get a label of their own', () => {
	// The point is the LABEL, not a new profile: `generic` reads as
	// "unrecognised" and sends the pilot hunting for a fix they do not need.
	assert.equal(padKind('Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)'), 'nintendo');
	assert.equal(padKind('057e-2009-Pro Controller'), 'nintendo');
	assert.equal(padKind('Joy-Con (L)'), 'nintendo');
	assert.equal(padKind('Nintendo Switch Pro Controller'), 'nintendo');
	assert.equal(padKind('8BitDo Ultimate Controller (Vendor: 2dc8 Product: 3106)'), 'nintendo');
});

t('padKind: Steam Deck and Valve get one too', () => {
	assert.equal(padKind('Steam Deck Controller (Vendor: 28de Product: 1205)'), 'steam');
	assert.equal(padKind('Valve Software Steam Controller'), 'steam');
	assert.equal(padKind('28de-1102-Steam Controller'), 'steam');
});

t('padKind: the ORDER of the tests, which is the whole difficulty', () => {
	// Radio first: a radio can announce itself as "... Controller", and a radio
	// misclassed is a radio that does not fly.
	assert.equal(padKind('RadioMaster TX16S Wireless Controller'), 'radio');
	assert.equal(padKind('EdgeTX Pro Controller'), 'radio');
	// Xbox before PlayStation, because of the bare "Wireless Controller" Firefox
	// gives the DS4.
	assert.equal(padKind('Xbox Wireless Controller'), 'xbox');
	assert.equal(padKind('Wireless Controller'), 'playstation');
	// Nintendo and Steam LAST of the name tests: an 8BitDo in XInput mode
	// enumerates under 045e and a Steam Deck under Steam Input looks like an Xbox
	// pad — in that mode the earlier class is the truer one.
	assert.equal(padKind('8BitDo Ultimate (XInput STANDARD GAMEPAD Vendor: 045e)'), 'xbox');
	assert.equal(padKind('Steam Virtual Gamepad (Vendor: 045e Product: 028e)'), 'xbox');
});

// --- profiles ---------------------------------------------------------------

t('defaultMapForKind: Xbox, PlayStation and generic share one profile', () => {
	assert.deepEqual(defaultMapForKind('xbox'), defaultMapForKind('playstation'));
	assert.deepEqual(defaultMapForKind('generic'), defaultMapForKind('playstation'));
});

t('defaultMapForKind: the radio has its own profile', () => {
	assert.notDeepEqual(defaultMapForKind('radio'), defaultMapForKind('xbox'));
	assert.equal(defaultMapForKind('radio').throttle.axis, 2);
});

t('defaultMapForKind: every channel is defined, and it is a copy', () => {
	for (const kind of ['radio', 'xbox', 'playstation', 'generic']) {
		const m = defaultMapForKind(kind);
		for (const ch of CHANNELS) {
			assert.equal(typeof m[ch].axis, 'number', `${kind}.${ch}.axis`);
			assert.equal(typeof m[ch].invert, 'boolean', `${kind}.${ch}.invert`);
		}
	}
	const a = defaultMapForKind('xbox');
	a.roll.axis = 99;
	assert.equal(defaultMapForKind('xbox').roll.axis, 2);
});

t('gamepad profile: pushing the right stick forward drops the nose', () => {
	// Axis 3 = -1 with the stick forward; with no inversion sticks.pitch goes
	// negative, and flightController treats pitch > 0 as "pitch up".
	const m = defaultMapForKind('xbox');
	assert.equal(m.pitch.axis, 3);
	const forward = m.pitch.invert ? 1 : -1;
	assert.ok(forward < 0, 'stick forward must give a negative pitch (nose down)');
});

// --- throttle ---------------------------------------------------------------

t('throttleModeForKind: half travel except on a radio', () => {
	assert.equal(throttleModeForKind('radio'), THROTTLE_MODE.radio);
	assert.equal(throttleModeForKind('xbox'), THROTTLE_MODE.gamepad);
	assert.equal(throttleModeForKind('playstation'), THROTTLE_MODE.gamepad);
	assert.equal(throttleModeForKind('generic'), THROTTLE_MODE.gamepad);
});

t('the new families change NO mapping, only the label', () => {
	// In standard mapping a Switch Pro, an 8BitDo and a Steam Deck expose exactly
	// the PlayStation/Xbox axis layout. Documented here so that nobody reads the
	// absence of a profile as an oversight.
	for (const kind of ['nintendo', 'steam']) {
		assert.deepEqual(defaultMapForKind(kind), defaultMapForKind('playstation'), kind);
		assert.equal(throttleModeForKind(kind), THROTTLE_MODE.gamepad, kind);
	}
	// Full travel is a statement about the HARDWARE — a friction gimbal holding its
	// position — so it stays the radio's alone.
	assert.equal(throttleModeForKind('radio'), THROTTLE_MODE.radio);
});

t('padListEntries: a new family reads as itself in the device list', () => {
	const rows = padListEntries([{ index: 0, id: 'Pro Controller (057e)', axes: 4, buttons: 16 }], 0);
	assert.equal(rows[0].kind, 'nintendo');
	assert.match(rows[0].label, /nintendo/);
});

t('throttleFromAxis half: a self-centring stick at rest = 0 % throttle', () => {
	// The point of the choice: at centre the pad must command no throttle,
	// otherwise the disarm gesture (throttle < 0.08) is out of reach.
	assert.equal(throttleFromAxis(0, THROTTLE_MODE.gamepad), 0);
	assert.equal(throttleFromAxis(-1, THROTTLE_MODE.gamepad), 0);
	assert.equal(throttleFromAxis(1, THROTTLE_MODE.gamepad), 1);
	assert.equal(throttleFromAxis(0.5, THROTTLE_MODE.gamepad), 0.5);
});

t('throttleFromAxis full: the radio keeps its full travel', () => {
	assert.equal(throttleFromAxis(-1, THROTTLE_MODE.radio), 0);
	assert.equal(throttleFromAxis(0, THROTTLE_MODE.radio), 0.5);
	assert.equal(throttleFromAxis(1, THROTTLE_MODE.radio), 1);
});

t('throttleFromAxis: clamped into 0..1 even on an axis that overshoots', () => {
	for (const mode of [THROTTLE_MODE.radio, THROTTLE_MODE.gamepad]) {
		assert.equal(throttleFromAxis(-3, mode), 0);
		assert.equal(throttleFromAxis(3, mode), 1);
	}
});

// --- the devices screen (issue #162) ----------------------------------------

// Brand-name detection left a TBS Tango 2 as `generic` — and that is not
// cosmetic: ALL FOUR channels differ between EDGETX_MAP and GAMEPAD_MAP, and
// the throttle mode goes from full travel to half. The pilot does not perceive
// "badly mapped", they perceive "it does not work". Detection therefore goes
// through the USB id, and a SCREEN makes name recognition incidental — that
// screen is what is tested below.

t('#162: an OpenTX/EdgeTX radio is recognised by its USB id', () => {
	// 1209:4f54 — "OT" in ASCII at pid.codes. OpenTX-derived firmwares
	// (including FreedomTX, the Tango 2's) share it.
	assert.equal(padKind('1209-4f54-RadioMaster Pocket Joystick'), 'radio');
	assert.equal(padKind('Unknown Gamepad (Vendor: 1209 Product: 4f54)'), 'radio');
	// And by name, as a second line of defence, for what does not enumerate
	// that way.
	assert.equal(padKind('TBS TANGO 2'), 'radio');
	assert.equal(padKind('FreedomTX Joystick'), 'radio');
});

t('#162: a radio does not pass itself off as a game controller', () => {
	// The heart of the report: classed `generic`, it was given GAMEPAD_MAP.
	const radio = defaultMapForKind('radio');
	const generic = defaultMapForKind('generic');
	const diff = CHANNELS.filter((c) => radio[c].axis !== generic[c].axis);
	assert.equal(diff.length, CHANNELS.length, 'all four channels really do differ between the two profiles');
	assert.notEqual(throttleModeForKind('radio'), throttleModeForKind('generic'),
		'and so does the throttle mode: full travel against half');
});

t('#162: the list shows WHAT THE BROWSER SEES, not a guess', () => {
	// listGamepads() and selectGamepad() existed and were called NOWHERE: there
	// was no screen to see what is detected, nor to choose when two devices are
	// plugged in. That is what padListEntries now decides, and what the Settings
	// panel merely paints.
	const pads = [
		{ index: 0, id: 'Xbox Wireless Controller (045e:02fd)', axes: 4, buttons: 16 },
		{ index: 1, id: 'TBS TANGO 2 (1209:4f54)', axes: 8, buttons: 0 },
	];
	const rows = padListEntries(pads, 1);
	assert.equal(rows.length, 2, 'one row per enumerated device');

	// The deduced class, which is what DECIDES the mapping: without it, "it does
	// not work" stays impossible to diagnose.
	assert.equal(rows[0].kind, 'xbox');
	assert.equal(rows[1].kind, 'radio');

	// The numbers you ask a user for when their radio does not answer.
	assert.match(rows[1].label, /8 axes/);
	assert.match(rows[1].label, /0 buttons/);
	assert.match(rows[1].label, /TBS TANGO 2/);

	// And which one is active, marked the way the menu cursor is.
	assert.equal(rows[1].active, true);
	assert.equal(rows[0].active, false);
	assert.match(rows[1].label, /^▌/);
});

t('#162: an empty enumeration SAYS SO, instead of leaving you to conclude', () => {
	// The Gamepad API only exposes a device after an action ON IT: "nothing
	// listed" is not "not recognised". A radio with no buttons at all cannot
	// satisfy that condition by moving its sticks alone.
	assert.deepEqual(padListEntries([], 0), []);
	assert.deepEqual(padListEntries(null, 0), [], 'no enumeration at all: no crash');
	assert.match(PAD_LIST_EMPTY, /only reveals it after an input/);
});

// --- calibration stored PER DEVICE (issue #277) -----------------------------
//
// The flaw this fixes: `_savedMap` was one global boolean and the mapping one
// localStorage entry. A remap made for a radio therefore stayed stuck when you
// plugged in a DualShock 4 — whose axes are in a different order AND whose
// throttle is half travel.

const RADIO_CAL = {
	channels: {
		throttle: { axis: 2, lo: -1, hi: 1 },
		yaw: { axis: 3, center: 0, span: 1, invert: false },
		pitch: { axis: 1, center: 0, span: 1, invert: true },
		roll: { axis: 0, center: 0, span: 1, invert: false },
	},
	deadband: 0.02,
	throttleMode: 'full',
};

const DS4_CAL = {
	channels: {
		throttle: { axis: 1, lo: 0, hi: -1 },
		yaw: { axis: 0, center: 0, span: 1, invert: false },
		pitch: { axis: 3, center: 0, span: 1, invert: false },
		roll: { axis: 2, center: 0, span: 1, invert: false },
	},
	deadband: 0.03,
	throttleMode: 'half',
};

t('#277: calibrating a gamepad does not touch the radio calibration', () => {
	let store = calStoreSet({}, 'EdgeTX Radiomaster Pocket', RADIO_CAL);
	store = calStoreSet(store, 'Wireless Controller (054c)', DS4_CAL);

	assert.equal(calStoreGet(store, 'EdgeTX Radiomaster Pocket').throttleMode, 'full');
	assert.equal(calStoreGet(store, 'Wireless Controller (054c)').throttleMode, 'half');
	assert.equal(calStoreGet(store, 'EdgeTX Radiomaster Pocket').channels.throttle.axis, 2);
});

t('#277: a never-calibrated device does not pick up another one\'s', () => {
	const store = calStoreSet({}, 'EdgeTX Radiomaster Pocket', RADIO_CAL);
	assert.equal(calStoreGet(store, 'Xbox Wireless Controller'), null);
});

t('#277: corrupt storage does not bring the boot down', () => {
	// Same rule as loadMap(): an unreadable key falls back to the default
	// behaviour, it does not stop the sim from booting.
	assert.equal(calStoreGet(null, 'x'), null);
	assert.equal(calStoreGet({ x: 'not an object' }, 'x'), null);
	assert.equal(calStoreGet({ x: { channels: {} } }, 'x'), null, 'four channels or nothing');
	assert.equal(calStoreGet({ x: { ...DS4_CAL, channels: { ...DS4_CAL.channels, roll: null } } }, 'x'), null);
});

t('#277: the sticks come out of the calibration, not out of guesses', () => {
	// Radio: a friction throttle parked at the bottom -> 0 % throttle, not 50 %.
	assert.deepEqual(sticksFromCalibration([0, 0, -1, 0], RADIO_CAL), {
		throttle: 0, yaw: 0, pitch: 0, roll: 0,
	});

	const full = sticksFromCalibration([0, 0, 1, 0], RADIO_CAL);
	assert.equal(full.throttle, 1);

	// DS4: stick let go -> 0 % throttle. That is what keeps the disarm gesture
	// (throttle < 0.08) reachable at rest.
	assert.equal(sticksFromCalibration([0, 0, 0, 0], DS4_CAL).throttle, 0);
	assert.equal(sticksFromCalibration([0, -1, 0, 0], DS4_CAL).throttle, 1);
});

t('#277: calibrated pitch keeps the "pulled towards you = pitch up" convention', () => {
	// flightController: pitch > 0 = pitch up. On the radio the axis reads -1
	// when the stick is pulled towards you, hence invert:true.
	assert.ok(sticksFromCalibration([0, -1, -1, 0], RADIO_CAL).pitch > 0.9);
	// On the DS4 the same gesture puts the right Y axis at +1, no inversion.
	assert.ok(sticksFromCalibration([0, 0, 0, 1], DS4_CAL).pitch > 0.9);
});

t('#277: a manual remap on the SAME axis keeps the measured travel', () => {
	// The pilot inverts pitch by hand: they are disputing a DIRECTION, not a
	// measurement. Throwing away the measured travel at that moment would take
	// back what the calibration had just given them.
	const cal = {
		...DS4_CAL,
		channels: { ...DS4_CAL.channels, pitch: { axis: 3, center: 0.05, span: 0.8, invert: false } },
	};
	const out = remapChannel(cal, 'pitch', 3, true);
	assert.equal(out.channels.pitch.span, 0.8);
	assert.equal(out.channels.pitch.center, 0.05);
	assert.equal(out.channels.pitch.invert, true);
});

t('#277: a manual remap to ANOTHER axis does not invent a measurement', () => {
	// Nothing was ever measured on axis 2 for this channel: it falls back to the
	// guesses (centre 0, travel +/-1), not to axis 3's numbers.
	const cal = {
		...DS4_CAL,
		channels: { ...DS4_CAL.channels, pitch: { axis: 3, center: 0.05, span: 0.8, invert: false } },
	};
	const out = remapChannel(cal, 'pitch', 2, false);
	assert.deepEqual(out.channels.pitch, { axis: 2, center: 0, span: 1, invert: false });
});

t('#277: inverting a half-travel throttle does NOT leave throttle on at rest', () => {
	// The dangerous case. The floor of a self-centring throttle is the centre:
	// THAT is what has to stay put when it is inverted, otherwise pad let go =
	// full throttle, and the disarm gesture becomes unreachable.
	const out = remapChannel(DS4_CAL, 'throttle', 1, false);
	assert.equal(sticksFromCalibration([0, 0, 0, 0], out).throttle, 0);
	assert.equal(sticksFromCalibration([0, 1, 0, 0], out).throttle, 1);
});

t('#279: a Pocket whose throttle is on the trigger flies correctly', () => {
	// The whole path, exactly as readStandardGamepad() takes it: the browser's
	// Gamepad object -> padSignals() -> sticksFromCalibration(). On a
	// Radiomaster Pocket that Firefox maps as "standard", the throttle comes out
	// on buttons[6].value and the fourth axis is dead — measured, see #279.
	const pocket = (roll, pitch, yaw, btn6) => ({
		axes: [roll, pitch, yaw, 0, 0, 0, 0, 0],
		buttons: Array.from({ length: 28 }, (_, i) => ({ value: i === 6 ? btn6 : 0 })),
	});
	// Button 6 becomes signal 8 + 6 = 14, travelling -1..1 like an axis.
	const cal = {
		channels: {
			throttle: { axis: 14, lo: -1, hi: 0.994 },
			yaw: { axis: 2, center: 0, span: 1, invert: false },
			pitch: { axis: 1, center: 0, span: 1, invert: true },
			roll: { axis: 0, center: 0, span: 1, invert: false },
		},
		deadband: 0.02,
		throttleMode: 'full',
		axisCount: 8,
	};

	const atRest = sticksFromCalibration(padSignals(pocket(0, 0, 0, 0)), cal);
	assert.equal(atRest.throttle, 0, 'throttle down = 0, otherwise disarm is unreachable');
	assert.equal(atRest.yaw, 0);

	const wideOpen = sticksFromCalibration(padSignals(pocket(0, 0, 0, 0.997)), cal);
	assert.ok(wideOpen.throttle > 0.99, `throttle wide open = ${wideOpen.throttle}`);

	// And a throttle on a button bleeds into none of the other three channels.
	assert.equal(wideOpen.roll, 0);
	assert.equal(wideOpen.pitch, 0);
	assert.equal(wideOpen.yaw, 0);

	const right = sticksFromCalibration(padSignals(pocket(1, 0, 0, 0)), cal);
	assert.ok(right.roll > 0.97, `roll right = ${right.roll}`);
	assert.equal(right.throttle, 0, 'moving a stick does not add throttle');
});


// --- keyboard throttle: an integrator, and what is allowed to integrate it (#33)
//
// The keyboard throttle is NOT a button: like a real stick, it stays where you
// leave it. That is deliberate, and the OSD shows it as a percentage. What was
// not deliberate is that it climbed while the simulation was frozen — typing
// "z" on the remap page armed full throttle, and the drone shot straight up
// when the panel closed.

const freshInput = () => {
	const input = new Input();
	input.keys.clear();
	input.kbThrottle = 0;
	return input;
};

// A second of holding, in 100 ms steps: the frame loop, only slower.
const holdFor = (input, key, seconds, opts) => {
	input.keys.add(key);
	for (let i = 0; i < seconds * 10; i++) input.update(0.1, opts);
	input.keys.delete(key);
};

t('#33: holding "z" raises the throttle — it is a stick, not a button', () => {
	const input = freshInput();
	holdFor(input, 'z', 0.5);
	assert.ok(input.kbThrottle > 0.5, `throttle ${input.kbThrottle} after 0.5 s`);
});

t('#33: releasing "z" LEAVES the throttle where it is — a stick does not fall back', () => {
	const input = freshInput();
	holdFor(input, 'z', 0.5);
	const held = input.kbThrottle;
	for (let i = 0; i < 20; i++) input.update(0.1);   // no key at all any more
	assert.equal(input.kbThrottle, held, 'the throttle moved with no input');
});

t('#33: "s" brings the throttle back down', () => {
	const input = freshInput();
	holdFor(input, 'z', 1);
	assert.ok(input.kbThrottle > 0.9);
	holdFor(input, 's', 1);
	assert.ok(input.kbThrottle < 0.1, `throttle ${input.kbThrottle} after a second coming down`);
});

t('#33: with the simulation frozen, "z" integrates NOTHING', () => {
	// The heart of the bug: settings panel open, the frame loop still running
	// and calling update() without saying that nothing was flying any more.
	const input = freshInput();
	holdFor(input, 'z', 2, { frozen: true });
	assert.equal(input.kbThrottle, 0, `throttle ${input.kbThrottle} armed while frozen`);
});

t('#33: freezing does not DAMAGE the throttle already set', () => {
	// Freezing does not reset: pausing mid-flight must not cut the throttle when
	// it thaws.
	const input = freshInput();
	holdFor(input, 'z', 0.5);
	const before = input.kbThrottle;
	for (let i = 0; i < 20; i++) input.update(0.1, { frozen: true });
	assert.equal(input.kbThrottle, before);
});

t('#33: once thawed, "z" integrates again', () => {
	// The guard must not lock the input into the frozen state.
	const input = freshInput();
	holdFor(input, 'z', 1, { frozen: true });
	assert.equal(input.kbThrottle, 0);
	holdFor(input, 'z', 0.5);
	assert.ok(input.kbThrottle > 0.5, `throttle ${input.kbThrottle} after the thaw`);
});

t('#33: with no option, update() integrates — the default stays flying', () => {
	const input = freshInput();
	holdFor(input, 'z', 0.5, undefined);
	assert.ok(input.kbThrottle > 0.5);
});

t('#33: a key released while frozen really is released when it thaws', () => {
	// The freeze suspends the INTEGRATION, not the keyboard tracking: otherwise
	// a key let go with the panel open would stay down when it closes.
	const input = freshInput();
	input.keys.add('z');
	for (let i = 0; i < 5; i++) input.update(0.1, { frozen: true });
	input.keys.delete('z');
	for (let i = 0; i < 5; i++) input.update(0.1);
	assert.equal(input.kbThrottle, 0, 'the throttle climbed with no key held');
});

// --- keyboard stick ramp (B4) -----------------------------------------------
//
// A keyboard has no travel. Roll, pitch and yaw used to step straight to +/-1,
// so the smallest command an arrow key could express was FULL deflection —
// 820 deg/s of roll at the freestyle preset, arriving in one frame. That is not
// a hard control scheme, it is an unflyable one, and it is what most people
// arriving on launch day have in front of them.
//
// The ramp (KEY_RAMP_S = 0.15 s) gives back the middle of the range: a tap is
// small, a hold still reaches the stop. Nothing about a gamepad changes — this
// is readKeyboard(), and readGamepad() never comes through here.

// Steps of `dt` seconds, like the frame loop but slower and exact.
const stepFor = (input, key, seconds, dt = 0.01, opts) => {
	input.keys.add(key);
	for (let i = 0; i < Math.round(seconds / dt); i++) input.update(dt, opts);
	input.keys.delete(key);
	return input.sticks;
};

t('B4: a TAP on the roll key is a nudge, not a full-deflection command', () => {
	const input = freshInput();
	// 30 ms — about the shortest keypress a human makes by accident.
	stepFor(input, 'arrowright', 0.03);
	assert.ok(input.sticks.roll > 0 && input.sticks.roll < 0.35,
		`roll ${input.sticks.roll} after a 30 ms tap — used to be 1`);
});

t('B4: a HELD key still reaches full deflection, and stays there', () => {
	const input = freshInput();
	stepFor(input, 'arrowright', 0.15);
	assert.ok(input.sticks.roll > 0.99, `roll ${input.sticks.roll} after the ramp time`);
	input.keys.add('arrowright');
	for (let i = 0; i < 50; i++) input.update(0.01);
	input.keys.delete('arrowright');
	assert.equal(input.sticks.roll, 1, 'and it does not overshoot past it');
});

t('B4: the ramp is symmetric — releasing centres over the same time', () => {
	const input = freshInput();
	stepFor(input, 'arrowright', 0.2);
	assert.equal(input.sticks.roll, 1);
	for (let i = 0; i < 7; i++) input.update(0.01);
	assert.ok(input.sticks.roll > 0 && input.sticks.roll < 1, 'on the way back, not snapped');
	for (let i = 0; i < 20; i++) input.update(0.01);
	assert.equal(input.sticks.roll, 0, 'lands exactly on centre');
});

t('B4: reversing does not jump through the middle', () => {
	const input = freshInput();
	stepFor(input, 'arrowright', 0.2);
	input.keys.add('arrowleft');
	input.update(0.01);
	assert.ok(input.sticks.roll > 0.8, `still on the right side: ${input.sticks.roll}`);
	for (let i = 0; i < 30; i++) input.update(0.01);
	input.keys.delete('arrowleft');
	assert.equal(input.sticks.roll, -1);
});

t('B4: pitch and yaw ramp too, and each axis is its own', () => {
	const input = freshInput();
	input.keys.add('arrowup');
	input.keys.add('d');
	for (let i = 0; i < 5; i++) input.update(0.01);
	assert.ok(input.sticks.pitch < 0 && input.sticks.pitch > -1, `pitch ${input.sticks.pitch}`);
	assert.ok(input.sticks.yaw > 0 && input.sticks.yaw < 1, `yaw ${input.sticks.yaw}`);
	assert.equal(input.sticks.roll, 0, 'an axis nobody touched stays at rest');
	input.keys.clear();
});

t('B4: frozen, the ramp does not creep either', () => {
	// Same rule as the throttle integrator: a keystroke typed in the settings
	// panel does not fly the machine.
	const input = freshInput();
	stepFor(input, 'arrowright', 1, 0.01, { frozen: true });
	assert.equal(input.sticks.roll, 0, `roll ${input.sticks.roll} built up while frozen`);
});

t('B4: a respawn does not inherit the stick the last life died holding', () => {
	const input = freshInput();
	stepFor(input, 'arrowright', 0.2);
	assert.equal(input.sticks.roll, 1);
	input.resetKeyboardThrottle();
	input.update(0.01);
	assert.equal(input.sticks.roll, 0);
});

t('B4: the mouse takes over once the keys have finished releasing', () => {
	const input = freshInput();
	input.pointerLocked = true;
	input.mouse.x = 0.5;
	stepFor(input, 'arrowright', 0.2);
	// Still ramping down: the keys own the axis, the mouse waits.
	input.update(0.01);
	assert.ok(input.sticks.roll > 0.5, 'the key value is still what flies');
	for (let i = 0; i < 30; i++) input.update(0.01);
	// The mouse now owns the axis: what flies is the aim as it stood at the top
	// of the frame, and it self-centres on its own decay, not on the ramp.
	const aim = input.mouse.x;
	input.update(0.01);
	assert.ok(Math.abs(input.sticks.roll - aim) < 1e-12, 'the stick IS the aim');
	assert.ok(input.mouse.x < aim, 'and the aim keeps falling back to centre');
});

// --- calibrations written by an OLDER version (backward compatibility) -------
//
// isValidCalibration() is the gate between localStorage and the motors. It must
// keep accepting everything already stored out there, which is the whole reason
// the `menu` field is optional.

t('isValidCalibration: a calibration with no `menu` field is still accepted', () => {
	// Every calibration written before the two menu steps existed looks like this.
	// Refusing it would silently take the measurement back off a pilot who has
	// already calibrated, and put the guessed profile back on their radio.
	assert.equal('menu' in RADIO_CAL, false, 'the fixture really is an old one');
	assert.equal(isValidCalibration(RADIO_CAL), true);
	assert.equal(isValidCalibration(DS4_CAL), true);
	// And it flies: the four sticks are read, nothing divides by anything missing.
	assert.deepEqual(sticksFromCalibration([0, 0, -1, 0], RADIO_CAL), {
		throttle: 0, yaw: 0, pitch: 0, roll: 0,
	});
});

t('isValidCalibration: a `menu` field does not make it refuse the flight', () => {
	const withMenu = {
		...DS4_CAL,
		menu: { confirm: { signal: 8, center: -1, on: 1 }, back: { signal: 9, center: -1, on: 1 } },
	};
	assert.equal(isValidCalibration(withMenu), true);
	// A malformed `menu` is not fatal either: it is the READER that validates each
	// entry, and a menu convenience must never ground a flight.
	assert.equal(isValidCalibration({ ...DS4_CAL, menu: {} }), true);
	assert.equal(isValidCalibration({ ...DS4_CAL, menu: { confirm: 'nonsense' } }), true);
	// But a `menu` that is not an object at all is a corrupt entry.
	assert.equal(isValidCalibration({ ...DS4_CAL, menu: 3 }), false);
});

t('isValidCalibration: the deadband gate that stands in front of the motors', () => {
	// A stored `deadband: 1` divides by zero in normalizeChannel and the stick
	// reads NaN at full stop — a dead flight from one bad key.
	assert.equal(isValidCalibration({ ...DS4_CAL, deadband: 1 }), false);
	assert.equal(isValidCalibration({ ...DS4_CAL, deadband: -0.1 }), false);
	assert.equal(isValidCalibration({ ...DS4_CAL, throttleMode: 'quarter' }), false);
	assert.equal(isValidCalibration(null), false);
});

t('menuButtonDown: with nothing measured, buttons 0 and 1, exactly as before', () => {
	// A standard pad needs no measurement. `undefined` spec -> the fallback index.
	const signals = [0, 0, 0, 0, 1, -1];      // 4 axes, then button 0 down, button 1 up
	assert.equal(menuButtonDown(signals, undefined, 4), true);
	assert.equal(menuButtonDown(signals, undefined, 5), false);
	assert.equal(menuButtonDown(signals, undefined, 99), false, 'a missing signal is not pressed');
});

t('menuButtonDown: a measurement too small to trust falls back to nothing', () => {
	// If rest and pressed are almost the same value, noise alone would cross the
	// threshold — better no button than one that fires by itself.
	const signals = [0.1, 0, 0, 0];
	assert.equal(menuButtonDown(signals, { signal: 0, center: 0, on: 0.2 }, 99), false);
});

t('menuButtonDown: a switch measured on an AXIS reads with the same formula', () => {
	// A radio in standard mapping can file a switch on an axis, and a switch left
	// on one side reads as permanently pressed — which is exactly why buttons 0 and
	// 1 were unusable there. Measured ends make the threshold explicit.
	const spec = { signal: 3, center: -1, on: 1 };
	assert.equal(menuButtonDown([0, 0, 0, 1], spec, 99), true);
	assert.equal(menuButtonDown([0, 0, 0, -1], spec, 99), false);
	assert.equal(menuButtonDown([0, 0, 0, 0.1], spec, 99), true, 'past halfway is pressed');
	assert.equal(menuButtonDown([0, 0, 0, -0.1], spec, 99), false);
});

// --- the signals the MENUS read (issue #123 follow-up) -----------------------
//
// The menus used to read axes 0 and 1 raw off the first enumerated pad. On a
// radio, axis 1 can be the throttle stick — it does not come back to centre, so
// the cursor left in one direction and stayed there. Roll and pitch, read through
// the calibrated path, are the only two channels that self-centre everywhere.

// A Gamepad as the browser reports it, plus the enumeration around it.
const mountPad = (id, axes, buttons = 4) => {
	const pad = {
		index: 0,
		id,
		axes,
		buttons: Array.from({ length: buttons }, () => ({ pressed: false, value: 0 })),
	};
	navigator.getGamepads = () => [pad];
	return pad;
};

const unmountPads = () => { navigator.getGamepads = () => []; };

t('menuAxes: a stick pushed FORWARD gives a negative y — which is "up"', () => {
	// The sign that decides everything: GAMEPAD_MAP pitch is axis 3, not inverted,
	// and the axis reads -1 forward. src/gamepad-dir.js turns y < -0.5 into 'up'.
	mountPad('Some No-Name Pad', [0, 0, 0, -1]);
	const input = freshInput();
	const axes = input.menuAxes();
	assert.ok(axes.y < -0.9, `forward = ${axes.y}, must be negative (up)`);
	assert.equal(axes.x, 0, 'and pushing pitch does not move the cursor sideways');
	unmountPads();
});

t('menuAxes: the four directions of a self-centring pad', () => {
	const pad = mountPad('Some No-Name Pad', [0, 0, 0, 0]);
	const input = freshInput();
	const read = (roll, pitch) => { pad.axes = [0, 0, roll, pitch]; return input.menuAxes(); };
	assert.ok(read(0, -1).y < -0.9, 'stick forward -> up');
	assert.ok(read(0, 1).y > 0.9, 'stick back -> down');
	assert.ok(read(-1, 0).x < -0.9, 'stick left -> left');
	assert.ok(read(1, 0).x > 0.9, 'stick right -> right');
	assert.deepEqual(read(0, 0), { x: 0, y: 0 }, 'at rest, nothing');
	unmountPads();
});

t('menuAxes: the OTHER sign convention — a radio, whose pitch is inverted', () => {
	// EDGETX_MAP puts pitch on axis 1 WITH inversion: the axis reads +1 with the
	// stick pushed forward. The menu direction must come out the same way round as
	// on the pad — forward is up on both, or half the hardware navigates backwards.
	const pad = mountPad('RadioMaster TX16S Joystick', [0, 1, -1, 0]);
	const input = freshInput();
	assert.ok(input.menuAxes().y < -0.9, 'forward (axis +1, inverted) -> up');
	pad.axes = [0, -1, -1, 0];
	assert.ok(input.menuAxes().y > 0.9, 'pulled back -> down');
	unmountPads();
});

t('menuAxes: a throttle parked at one end of its travel moves NOTHING', () => {
	// The bug in one assertion: on this radio axis 2 is the throttle, held at -1 for
	// the whole session. Reading axes 0/1 raw walked the cursor away for ever.
	const pad = mountPad('RadioMaster TX16S Joystick', [0, 0, -1, 0]);
	const input = freshInput();
	assert.deepEqual(input.menuAxes(), { x: 0, y: 0 });
	pad.axes = [0, 0, 1, 0];                  // throttle wide open
	assert.deepEqual(input.menuAxes(), { x: 0, y: 0 }, 'throttle is not a direction');
	unmountPads();
});

t('menuAxes / menuButtons: null when there is no device at all', () => {
	unmountPads();
	const input = freshInput();
	assert.equal(input.menuAxes(), null);
	assert.equal(input.menuButtons(), null);
});

t('menuButtons: buttons 0 and 1 until a calibration says otherwise', () => {
	const pad = mountPad('Some No-Name Pad', [0, 0, 0, 0], 8);
	const input = freshInput();
	assert.deepEqual(input.menuButtons(), { confirm: false, back: false });
	pad.buttons[0].value = 1;
	assert.deepEqual(input.menuButtons(), { confirm: true, back: false });
	pad.buttons[0].value = 0;
	pad.buttons[1].value = 1;
	assert.deepEqual(input.menuButtons(), { confirm: false, back: true });
	unmountPads();
});

t('menuButtons: a MEASURED pair wins over buttons 0 and 1', () => {
	// On a radio, buttons 0 and 1 are switch positions — here one of them is held
	// down for ever, and it must not confirm anything. What confirms is what the
	// wizard measured: button 4, signal 4 + 4 = 8.
	const pad = mountPad('RadioMaster TX16S Joystick', [0, 0, -1, 0], 8);
	pad.buttons[0].value = 1;                 // a switch left on one side
	const input = freshInput();
	// One read first, so the device is adopted: adopting it re-applies the STORED
	// calibration (there is none here), which would undo the one set by hand.
	input.menuButtons();
	input.applyCalibration({
		...RADIO_CAL,
		menu: { confirm: { signal: 8, center: -1, on: 1 }, back: { signal: 9, center: -1, on: 1 } },
	});
	assert.deepEqual(input.menuButtons(), { confirm: false, back: false },
		'the switch held down confirms nothing any more');
	pad.buttons[4].value = 1;
	assert.deepEqual(input.menuButtons(), { confirm: true, back: false });
	unmountPads();
});

// --- losing the controller in flight ----------------------------------------
//
// A flat Bluetooth battery mid-flight used to hand the keyboard back in silence:
// the commands simply disappeared with no explanation. input.js paints nothing —
// it names the event, and the caller (main.js -> fpvtpOsd.setInputLost) paints it.

t('deviceLostLine: names the device, and says who is flying now', () => {
	const line = deviceLostLine('Xbox Wireless Controller');
	assert.match(line, /CONTROLLER LOST/);
	assert.match(line, /XBOX WIRELESS CONTROLLER/, 'the device that went away is named');
	assert.match(line, /KEYBOARD/, 'and the fact that the keyboard has taken over');
	// A Gamepad id can be a paragraph; the HUD line cannot.
	assert.ok(deviceLostLine('x'.repeat(200)).length < 80);
	assert.match(deviceLostLine(null), /CONTROLLER LOST/, 'no id: still a warning');
});

t('a device that disappears mid-flight is announced ONCE', () => {
	mountPad('Some No-Name Pad', [0, 0, 0, 0], 8);
	const input = freshInput();
	const seen = [];
	input.onDeviceLost = (line, id) => seen.push([line, id]);

	input.update(0.016);
	assert.equal(input.usingGamepad, true, 'the pad is flying');

	unmountPads();
	input.update(0.016);
	assert.equal(input.usingGamepad, false, 'the keyboard has taken over');
	assert.equal(seen.length, 1, 'and it was said');
	assert.match(seen[0][0], /CONTROLLER LOST/);
	assert.equal(seen[0][1], 'Some No-Name Pad', 'the raw id comes along for whoever logs it');
	assert.equal(input.lostDevice, 'Some No-Name Pad', 'and the state is there for a poller');

	for (let i = 0; i < 10; i++) input.update(0.016);
	assert.equal(seen.length, 1, 'a loss is announced once, not sixty times a second');
});

t('a device that never flew is not announced when nothing is plugged in', () => {
	unmountPads();
	const input = freshInput();
	let calls = 0;
	input.onDeviceLost = () => { calls++; };
	for (let i = 0; i < 10; i++) input.update(0.016);
	assert.equal(calls, 0, 'a keyboard pilot is told nothing');
	assert.equal(input.lostDevice, null);
});

t('a device that comes back clears the warning state', () => {
	mountPad('Some No-Name Pad', [0, 0, 0, 0], 8);
	const input = freshInput();
	input.update(0.016);
	unmountPads();
	input.update(0.016);
	assert.ok(input.lostDevice);
	mountPad('Some No-Name Pad', [0, 0, 0, 0], 8);
	input.update(0.016);
	assert.equal(input.lostDevice, null, 'plugged back in: nothing is lost any more');
	unmountPads();
});

// --- the flight-mode control ------------------------------------------------
//
// Only the M key changed mode before: a pad started in ANGLE had no way back to
// ACRO. A measured switch gives the mode by its POSITION, a measured or default
// button CYCLES on its rising edge.

const SWITCH = { signal: 4, type: 'switch', acro: 1, angle: -1 };
const CYCLE = { signal: 12, type: 'cycle', center: -1, on: 1 };

t('flightModeSpec / readFlightMode: a switch reads as its nearer position', () => {
	const spec = flightModeSpec(SWITCH, 'radio', 4);
	assert.equal(spec.type, 'switch');
	assert.equal(readFlightMode([0, 0, -1, 0, 1], spec), 'acro');
	assert.equal(readFlightMode([0, 0, -1, 0, -1], spec), 'angle');
	assert.equal(readFlightMode([0, 0, -1, 0, 0.2], spec), 'acro', 'the nearer of the two wins');
	assert.equal(readFlightMode([0, 0, -1, 0], spec), null, 'a missing signal reads nothing');
});

t('flightModeSpec / readFlightMode: a measured button reads as held or not', () => {
	const spec = flightModeSpec(CYCLE, 'playstation', 4);
	assert.equal(spec.type, 'cycle');
	const sig = (v) => { const a = new Array(20).fill(-1); a[12] = v; return a; };
	assert.equal(readFlightMode(sig(1), spec), true);
	assert.equal(readFlightMode(sig(-1), spec), false);
});

t('default: button 8 is the mode button on every class but radio', () => {
	for (const kind of ['playstation', 'xbox', 'nintendo', 'steam', 'generic', 'some-new-family']) {
		const spec = flightModeSpec(undefined, kind, 4);
		assert.deepEqual(
			{ type: spec.type, signal: spec.signal },
			{ type: 'cycle', signal: 4 + MODE_BUTTON_DEFAULT },
			kind,
		);
	}
	assert.equal(flightModeSpec(undefined, 'radio', 4), null, 'a radio has no default: its buttons are switch positions');
	assert.equal(flightModeSpec(undefined, null, 4), null, 'nor has the keyboard');
});

t('a malformed measurement is treated as absent, never as fatal', () => {
	for (const bad of [null, 3, 'x', {}, { signal: 4 }, { signal: 4, type: 'switch', acro: 1 },
		{ signal: 4, type: 'switch', acro: 0.1, angle: 0.2 }, { signal: 'a', type: 'cycle', center: -1, on: 1 },
		{ signal: 4, type: 'cycle', center: -1, on: -0.9 }, { signal: 4, type: 'warp' }]) {
		// A pad falls back to its default button, a radio to nothing.
		assert.equal(flightModeSpec(bad, 'xbox', 4)?.signal, 12, JSON.stringify(bad));
		assert.equal(flightModeSpec(bad, 'radio', 4), null, JSON.stringify(bad));
		// And the calibration that carries it still flies.
		assert.equal(isValidCalibration({ ...DS4_CAL, mode: bad }), true, JSON.stringify(bad));
	}
});

t('isValidCalibration: a calibration with no `mode` field is still accepted', () => {
	assert.equal('mode' in DS4_CAL, false);
	assert.equal(isValidCalibration(DS4_CAL), true);
	assert.equal(isValidCalibration({ ...RADIO_CAL, mode: SWITCH }), true);
});

t('flightModeControlName: button 8 as each family prints it', () => {
	assert.equal(flightModeControlName('playstation'), 'SHARE');
	assert.equal(flightModeControlName('xbox'), 'VIEW');
	assert.equal(flightModeControlName('steam'), 'VIEW');
	assert.equal(flightModeControlName('nintendo'), '−');
	assert.equal(flightModeControlName('generic'), 'SELECT');
	assert.equal(flightModeControlName('some-new-family'), 'SELECT');
});

t('flightModeControlName: a measured control, and none for an uncalibrated radio', () => {
	assert.equal(flightModeControlName('radio', SWITCH), 'MODE SWITCH');
	assert.equal(flightModeControlName('radio', CYCLE), 'MODE BUTTON');
	assert.equal(flightModeControlName('playstation', CYCLE), 'MODE BUTTON');
	assert.equal(flightModeControlName('radio'), null);
	assert.equal(flightModeControlName('radio', { type: 'switch' }), null, 'malformed = absent');
	assert.equal(flightModeControlName(null), null, 'the keyboard');
});

t('startFlightMode: pad -> ANGLE, radio -> ACRO, a measured switch decides', () => {
	for (const kind of ['playstation', 'xbox', 'nintendo', 'steam', 'generic']) {
		assert.equal(startFlightMode(kind), 'angle', kind);
	}
	assert.equal(startFlightMode('radio'), 'acro');
	assert.equal(startFlightMode('radio', 'angle'), 'angle');
	assert.equal(startFlightMode('radio', 'acro'), 'acro');
	assert.equal(startFlightMode(null), 'acro', 'the keyboard is unchanged');
});

t('padCycleMode: the button toggles ACRO / ANGLE, and always leads back to ACRO', () => {
	assert.equal(padCycleMode('acro'), 'angle');
	assert.equal(padCycleMode('angle'), 'acro');
	// Not the M key's five-mode cycle: from ANGLE it would pass through ACRO3D.
	for (const m of ['altitude', 'acro3d', 'gps']) assert.equal(padCycleMode(m), 'acro', m);
});

t('Input.flightModeCommand: default button 8 fires on the RISING EDGE only', () => {
	const pad = mountPad('Xbox Wireless Controller', [0, 0, 0, 0], 17);
	const input = freshInput();
	assert.equal(input.flightModeCommand(), null);
	pad.buttons[8].value = 1;
	assert.equal(input.flightModeCommand(), 'cycle', 'pressed: one cycle');
	assert.equal(input.flightModeCommand(), null, 'held: nothing more');
	assert.equal(input.flightModeCommand(), null);
	pad.buttons[8].value = 0;
	assert.equal(input.flightModeCommand(), null, 'released: nothing');
	pad.buttons[8].value = 1;
	assert.equal(input.flightModeCommand(), 'cycle', 'pressed again: one more');
	assert.equal(input.flightModeControl(), 'VIEW');
	assert.equal(input.startFlightMode(), 'angle');
	unmountPads();
});

t('Input.flightModeCommand: a button already held when reading starts fires nothing', () => {
	const pad = mountPad('DualSense Wireless Controller', [0, 0, 0, 0], 17);
	pad.buttons[8].value = 1;
	const input = freshInput();
	assert.equal(input.flightModeCommand(), null);
	pad.buttons[8].value = 0;
	input.flightModeCommand();
	pad.buttons[8].value = 1;
	assert.equal(input.flightModeCommand(), 'cycle');
	unmountPads();
});

t('Input.flightModeCommand: an uncalibrated radio has no mode control', () => {
	const pad = mountPad('RadioMaster TX16S Joystick', [0, 0, -1, 0], 17);
	pad.buttons[8].value = 1;               // a switch position, not a button
	const input = freshInput();
	assert.equal(input.flightModeCommand(), null);
	pad.buttons[8].value = 0;
	input.flightModeCommand();
	pad.buttons[8].value = 1;
	assert.equal(input.flightModeCommand(), null, 'never a cycle');
	assert.equal(input.flightModeControl(), null);
	assert.equal(input.startFlightMode(), 'acro');
	unmountPads();
});

t('Input.flightModeCommand: a measured switch gives its position every frame', () => {
	const pad = mountPad('RadioMaster TX16S Joystick', [0, 0, -1, 0, -1], 8);
	const input = freshInput();
	input.flightModeCommand();              // adopt the device first (see menuButtons)
	input.applyCalibration({ ...RADIO_CAL, mode: SWITCH });
	assert.equal(input.flightModeCommand(), 'angle');
	assert.equal(input.flightModeCommand(), 'angle', 'a position, not an edge: said every frame');
	assert.equal(input.startFlightMode(), 'angle', 'the radio starts where its switch is');
	pad.axes[4] = 1;
	assert.equal(input.flightModeCommand(), 'acro');
	assert.equal(input.startFlightMode(), 'acro');
	assert.equal(input.flightModeControl(), 'MODE SWITCH');
	unmountPads();
});

t('Input.flightModeCommand: the keyboard alone commands nothing', () => {
	unmountPads();
	const input = freshInput();
	assert.equal(input.flightModeCommand(), null);
	assert.equal(input.flightModeControl(), null);
	assert.equal(input.startFlightMode(), 'acro');
});

t('PAD_CALIBRATE_HINT points an unrecognised device at the wizard', () => {
	// Said once, in input.js, next to PAD_LIST_EMPTY, so that every screen that has
	// to say it says the same thing.
	assert.match(PAD_CALIBRATE_HINT, /CALIBRATE/);
	assert.match(PAD_CALIBRATE_HINT, /guess/i, 'and it says what the default profile IS');
});

// The first enumerated pad is not the pilot's (reported 2026-09-27). Chrome on
// Linux lists every device tagged ID_INPUT_JOYSTICK once ANY of them has had an
// input, and a Keychron Link keyboard receiver is one: 6 axes, 16 buttons,
// enumerated as js0 ahead of a RadioMaster Pocket. Firefox exposes a device only
// after an input on IT, so there the radio was alone and everything looked right.
const gp = (index, id, pressed = []) => ({
	index, id, axes: [0, 0, 0, 0, 0, 0],
	buttons: Array.from({ length: 16 }, (_, i) => ({ pressed: !!pressed[i] })),
});
const KEYCHRON = 'Keychron  Keychron Link  (Vendor: 3434 Product: d030)';
const POCKET = 'EdgeTX Radiomaster Pocket Joystick (Vendor: 1209 Product: 4f54)';

t('bestPad: a radio wins over a keyboard receiver enumerated before it', () => {
	assert.equal(bestPad([gp(0, KEYCHRON), gp(1, POCKET)])?.id, POCKET);
	// Holes in the list are what getGamepads() really returns.
	assert.equal(bestPad([gp(0, KEYCHRON), null, gp(2, POCKET), null])?.id, POCKET);
});

t('bestPad: a recognised pad wins over an unknown device, a radio over both', () => {
	const ds4 = gp(1, 'Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)');
	assert.equal(bestPad([gp(0, KEYCHRON), ds4])?.id, ds4.id);
	assert.equal(bestPad([ds4, gp(2, POCKET)])?.id, POCKET);
});

t('bestPad: equal rank keeps the enumeration order, and nothing gives null', () => {
	assert.equal(bestPad([gp(0, KEYCHRON), gp(1, 'Unknown HID 0f0d:00c1')])?.index, 0);
	assert.equal(bestPad([]), null);
	assert.equal(bestPad([null, null]), null);
	assert.equal(bestPad(undefined), null);
});

t('anyPadButtonDown: a press on the SECOND pad counts', () => {
	assert.equal(anyPadButtonDown([gp(0, KEYCHRON), gp(1, POCKET, [true])]), true);
	assert.equal(anyPadButtonDown([gp(0, KEYCHRON), null, gp(2, POCKET)]), false);
	assert.equal(anyPadButtonDown([]), false);
	assert.equal(anyPadButtonDown(undefined), false);
});

console.log(`input-selftest: ${n} tests ok`);

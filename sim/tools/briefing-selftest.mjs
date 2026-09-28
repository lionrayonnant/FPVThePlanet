// Selftest for the pure briefing model (tools/briefing-model.mjs). No DOM, no
// storage of its own: the five screens, the two storage rules and the in-flight
// hint timing are all decided here, so they can be checked without a browser.
// Run: node tools/briefing-selftest.mjs
import assert from 'node:assert/strict';
import {
	BRIEFING_SEEN_KEY,
	FIRST_FLIGHT_KEY,
	CLEARANCE_BRIEFED_KEY,
	shouldBrief,
	markBriefed,
	shouldBriefClearance,
	markClearanceBriefed,
	markFirstFlight,
	firstFlightPending,
	briefingScreens,
	clearanceScreen,
	flightHint,
} from './briefing-model.mjs';
import { DEFAULT_KEY_MAP, keyMapRows } from '../src/key-map.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

console.log('briefing model');

// A localStorage stand-in. `broken` throws on every access, like a browser in
// private mode does — the model must never let that block a boot.
function store({ broken = false } = {}) {
	const m = new Map();
	return {
		getItem: (k) => { if (broken) throw new Error('denied'); return m.has(k) ? m.get(k) : null; },
		setItem: (k, v) => { if (broken) throw new Error('denied'); m.set(k, String(v)); },
		has: (k) => m.has(k),
	};
}

const keyRows = keyMapRows(DEFAULT_KEY_MAP);

// --- storage rules ----------------------------------------------------------

t('the storage keys are namespaced fpvtp.*', () => {
	assert.equal(BRIEFING_SEEN_KEY, 'fpvtp.briefingSeen');
	assert.equal(FIRST_FLIGHT_KEY, 'fpvtp.firstFlightDone');
	assert.equal(CLEARANCE_BRIEFED_KEY, 'fpvtp.clearanceBriefed');
});

t('shouldBriefClearance: only an operator briefed before the CLEARANCE screen', () => {
	// A new operator: the full briefing covers it, never the single screen.
	const fresh = store();
	assert.equal(shouldBriefClearance(fresh), false);
	markBriefed(fresh);
	assert.equal(shouldBriefClearance(fresh), false, 'the full briefing marks both keys');
	assert.equal(fresh.has(CLEARANCE_BRIEFED_KEY), true);
	// Briefed before the update: seen once, then never again.
	const old = store();
	old.setItem(BRIEFING_SEEN_KEY, '1');
	assert.equal(shouldBriefClearance(old), true);
	markClearanceBriefed(old);
	assert.equal(shouldBriefClearance(old), false);
	assert.equal(shouldBrief(old), false, 'the single screen does not re-arm the full briefing');
	// No store, a broken one: no.
	assert.equal(shouldBriefClearance(null), false);
	assert.equal(shouldBriefClearance(store({ broken: true })), false);
	markClearanceBriefed(store({ broken: true }));
	markClearanceBriefed(null);
});

t('shouldBrief is true while the key is absent, false once marked', () => {
	const s = store();
	assert.equal(shouldBrief(s), true);
	markBriefed(s);
	assert.equal(shouldBrief(s), false);
	assert.equal(s.has(BRIEFING_SEEN_KEY), true);
});

t('shouldBrief is false without a store, and on a broken one', () => {
	// No storage at all is not a new player: it is a browser we cannot read.
	// Briefing an existing operator on every launch would be worse than not
	// briefing at all, so the answer is no in both cases.
	assert.equal(shouldBrief(null), false);
	assert.equal(shouldBrief(undefined), false);
	assert.equal(shouldBrief(store({ broken: true })), false);
});

t('markBriefed and markFirstFlight never throw on a broken store', () => {
	markBriefed(store({ broken: true }));
	markFirstFlight(store({ broken: true }));
	markBriefed(null);
	markFirstFlight(null);
});

t('firstFlightPending is true only between the briefing and the first flight', () => {
	const s = store();
	assert.equal(firstFlightPending(s), false);   // not briefed yet
	markBriefed(s);
	assert.equal(firstFlightPending(s), true);
	markFirstFlight(s);
	assert.equal(firstFlightPending(s), false);
	assert.equal(firstFlightPending(null), false);
	assert.equal(firstFlightPending(store({ broken: true })), false);
});

// --- the five screens -------------------------------------------------------

t('five screens, in order', () => {
	const screens = briefingScreens({ input: { kind: 'keyboard' }, keyRows });
	assert.deepEqual(screens.map((s) => s.title),
		['INPUT', 'THE TERMINAL', 'A SESSION', 'CLEARANCE', 'BRIEFING COMPLETE']);
	assert.deepEqual(screens.map((s) => s.id),
		['input', 'terminal', 'session', 'clearance', 'complete']);
	for (const s of screens) {
		assert.ok(s.actions.includes('continue'), `${s.id} must be continuable`);
		for (const [label, value] of s.rows) {
			assert.equal(typeof label, 'string');
			assert.equal(typeof value, 'string');
			assert.equal(label, label.toUpperCase());
			assert.equal(value, value.toUpperCase());
		}
	}
});

t('the INPUT screen names the keyboard and lists the live key map', () => {
	const [input] = briefingScreens({ input: { kind: 'keyboard' }, keyRows });
	assert.deepEqual(input.rows[0], ['DEVICE', 'KEYBOARD']);
	assert.deepEqual(input.rows.slice(1).map((r) => r[0]), keyRows.map((r) => r.label));
	// The keys themselves come from the map, never from a copy of it.
	const throttle = input.rows.find((r) => r[0] === 'THROTTLE UP');
	assert.equal(throttle[1], keyRows[0].keys.join(' / '));
	assert.deepEqual(input.actions, ['mapKeys', 'continue']);
});

t('a rebound key shows up in the INPUT screen', () => {
	const rows = keyMapRows({ ...DEFAULT_KEY_MAP, throttleUp: ['t'] });
	const [input] = briefingScreens({ input: { kind: 'keyboard' }, keyRows: rows });
	assert.equal(input.rows.find((r) => r[0] === 'THROTTLE UP')[1], 'T');
});

t('the INPUT screen names the pad and its sticks', () => {
	const [input] = briefingScreens({
		input: { kind: 'gamepad', name: 'Xbox Wireless Controller' }, keyRows,
	});
	assert.deepEqual(input.rows[0], ['DEVICE', 'GAMEPAD XBOX WIRELESS CONTROLLER']);
	const labels = input.rows.map((r) => r[0]);
	assert.ok(labels.includes('THROTTLE / YAW'));
	assert.ok(labels.includes('PITCH / ROLL'));
	assert.equal(input.rows.find((r) => r[0] === 'THROTTLE / YAW')[1], 'LEFT STICK');
	assert.equal(input.rows.find((r) => r[0] === 'PITCH / ROLL')[1], 'RIGHT STICK');
	// A pad is calibrated, not remapped: only that action is offered.
	assert.deepEqual(input.actions, ['calibrate', 'continue']);
	// No key rows on a pad screen.
	assert.equal(labels.includes('THROTTLE UP'), false);
});

t('a nameless pad still reads as a gamepad', () => {
	const [input] = briefingScreens({ input: { kind: 'gamepad' }, keyRows });
	assert.deepEqual(input.rows[0], ['DEVICE', 'GAMEPAD']);
});

t('THE TERMINAL names the five modes and the two global keys', () => {
	const screen = briefingScreens({ input: { kind: 'keyboard' }, keyRows })[1];
	const labels = screen.rows.map((r) => r[0]);
	// The briefing is the map of the paths: a path missing from here does not
	// exist for the operator who is starting out (issue #120).
	assert.deepEqual(labels.slice(0, 5), ['FIELD', 'BENCH', 'DATA', 'JUKEBOX', 'SETTINGS']);
	assert.match(screen.rows.find((r) => r[0] === 'JUKEBOX')[1], /KEEPS PLAYING/);
	assert.equal(screen.rows.find((r) => r[0] === 'ESC')[1], 'BACK, EVERYWHERE');
	assert.equal(screen.rows.find((r) => r[0] === 'TAB')[1], 'SETTINGS, IN FLIGHT');
	assert.match(screen.rows.find((r) => r[0] === 'BENCH')[1], /NOTHING IS LOGGED/);
});

t('A SESSION spells the loop, with the keys read from the live map', () => {
	const screen = briefingScreens({ input: { kind: 'keyboard' }, keyRows })[2];
	const labels = screen.rows.map((r) => r[0]);
	assert.deepEqual(labels.slice(0, 2), ['TARGET SCAN', 'FLIGHT']);
	assert.equal(screen.rows.find((r) => r[0] === 'HOLD K')[1], 'CUT LINK');
	assert.equal(screen.rows.find((r) => r[0] === 'V')[1], 'FPV / CHASE VIEW');
	assert.equal(screen.rows.find((r) => r[0] === 'SPACE')[1], 'PAUSE');
	assert.ok(labels.includes('THE LOG'));

	// Rebound, the rows follow.
	const rows = keyMapRows({ ...DEFAULT_KEY_MAP, cutLink: ['x'], view: ['c'] });
	const moved = briefingScreens({ input: { kind: 'keyboard' }, keyRows: rows })[2];
	assert.equal(moved.rows.find((r) => r[0] === 'HOLD X')[1], 'CUT LINK');
	assert.ok(moved.rows.some((r) => r[0] === 'C'));
});

t('the screens hold together with no key rows at all', () => {
	const screens = briefingScreens({ input: { kind: 'keyboard' }, keyRows: [] });
	assert.equal(screens.length, 5);
	assert.equal(screens[2].rows.find((r) => r[0] === 'HOLD K')[1], 'CUT LINK');
});

t('briefingScreens survives being called with nothing', () => {
	const screens = briefingScreens();
	assert.equal(screens.length, 5);
	assert.deepEqual(screens[0].rows[0], ['DEVICE', 'KEYBOARD']);
});

// --- the three in-flight hints ----------------------------------------------

t('CLEARANCE: the hangar as its body, the two fact rows', () => {
	const c = briefingScreens().find((s) => s.id === 'clearance');
	assert.equal(c.hangar, true);
	assert.deepEqual(c.rows, [
		['POINTS', '1 PER TIER OF EVERY SIGNAL UPLINKED'],
		['ABOVE YOUR CLEARANCE', 'VISIBLE, ENCRYPTED, NOT CAPTURABLE'],
	]);
	assert.deepEqual(clearanceScreen(), c, 'the single screen is the same one');
	// Only that screen carries a hangar.
	assert.deepEqual(briefingScreens().filter((s) => s.hangar).map((s) => s.id), ['clearance']);
});

t('the INPUT screen names the flight-mode control', () => {
	const row = (input) => briefingScreens({ input, keyRows })[0].rows.find((r) => r[0] === 'FLIGHT MODE')?.[1];
	assert.equal(row({ kind: 'gamepad', name: 'DualSense', modeControl: 'SHARE' }), 'SHARE — ACRO / ANGLE');
	assert.equal(row({ kind: 'gamepad', name: 'Xbox', modeControl: 'VIEW' }), 'VIEW — ACRO / ANGLE');
	assert.equal(row({ kind: 'gamepad', name: 'Pro Controller', modeControl: '−' }), '− — ACRO / ANGLE');
	assert.equal(row({ kind: 'gamepad', name: 'Pad', modeControl: 'SELECT' }), 'SELECT — ACRO / ANGLE');
	assert.equal(row({ kind: 'gamepad', name: 'TX16S', modeControl: 'MODE SWITCH' }), 'MODE SWITCH — ACRO / ANGLE');
	assert.equal(row({ kind: 'gamepad', name: 'TX16S', modeControl: 'MODE BUTTON' }), 'MODE BUTTON — ACRO / ANGLE');
	// An uncalibrated radio has no control: the pilot keeps the key, read live.
	assert.equal(row({ kind: 'gamepad', name: 'TX16S', modeControl: null }), 'KEY M');
	assert.equal(row({ kind: 'gamepad', name: 'TX16S' }), 'KEY M', 'an older caller without the field');
	const rebound = keyMapRows({ ...DEFAULT_KEY_MAP, cycleMode: ['n'] });
	assert.equal(briefingScreens({ input: { kind: 'gamepad' }, keyRows: rebound })[0]
		.rows.find((r) => r[0] === 'FLIGHT MODE')[1], 'KEY N');
	// The keyboard screen already lists the key among its own rows.
	const kb = briefingScreens({ input: { kind: 'keyboard' }, keyRows })[0];
	assert.equal(kb.rows.some((r) => r[0] === 'FLIGHT MODE'), false);
});

const hint = (o) => flightHint({ firstFlight: true, bench: false, armed: true, ...o });

t('THROTTLE UP until the first take-off', () => {
	assert.equal(hint({ airborneOnce: false }), 'THROTTLE UP');
	assert.equal(hint({ airborneOnce: false, tSinceTakeoff: 0 }), 'THROTTLE UP');
});

t('[TAB] SETTINGS for six seconds after take-off, then nothing', () => {
	assert.equal(hint({ airborneOnce: true, tSinceTakeoff: 0 }), '[TAB] SETTINGS');
	assert.equal(hint({ airborneOnce: true, tSinceTakeoff: 5.9 }), '[TAB] SETTINGS');
	assert.equal(hint({ airborneOnce: true, tSinceTakeoff: 6.1 }), null);
});

t('[HOLD K] CUT LINK thirty seconds after TAKE-OFF, not after the session opened', () => {
	// V7: keyed on the session clock, a pilot who lingers in the terminal and
	// takes off at 40 s never saw this line at all.
	assert.equal(hint({ airborneOnce: true, tSinceTakeoff: 29 }), null);
	assert.equal(hint({ airborneOnce: true, tSinceTakeoff: 30.5 }), '[HOLD K] CUT LINK');
	assert.equal(hint({ airborneOnce: true, tSinceTakeoff: 35.9 }), '[HOLD K] CUT LINK');
	// Transient: it says its piece and goes.
	assert.equal(hint({ airborneOnce: true, tSinceTakeoff: 36.1 }), null);
});

t('the cut-link hint names the live key, not a hard-coded K', () => {
	// F4: the same keyOf() the session screen uses — a rebound cut key is the
	// key the line prints.
	const rows = [{ id: 'cutLink', label: 'Cut link', keys: ['J'] }];
	assert.equal(hint({ airborneOnce: true, tSinceTakeoff: 31, keyRows: rows }), '[HOLD J] CUT LINK');
	// TAB is not remappable and stays written as it is.
	assert.equal(hint({ airborneOnce: true, tSinceTakeoff: 1, keyRows: rows }), '[TAB] SETTINGS');
});

t('the flight-mode hint follows [TAB] SETTINGS, in its own window', () => {
	const h = (t, modeControl) => hint({ airborneOnce: true, tSinceTakeoff: t, modeControl });
	assert.equal(h(5.9, 'SHARE'), '[TAB] SETTINGS', 'the TAB window is untouched');
	assert.equal(h(6.1, 'SHARE'), '[SHARE] ACRO / ANGLE');
	assert.equal(h(11.9, 'VIEW'), '[VIEW] ACRO / ANGLE');
	assert.equal(h(8, '−'), '[−] ACRO / ANGLE');
	assert.equal(h(8, 'SELECT'), '[SELECT] ACRO / ANGLE');
	assert.equal(h(8, 'MODE SWITCH'), '[MODE SWITCH] ACRO / ANGLE');
	assert.equal(h(12.1, 'SHARE'), null, 'transient');
	assert.equal(h(8, null), null, 'nothing to name: nothing said');
	assert.equal(h(31, 'SHARE'), '[HOLD K] CUT LINK', 'the cut-link window is untouched');
	assert.equal(hint({ airborneOnce: false, modeControl: 'SHARE' }), 'THROTTLE UP');
	assert.equal(hint({ airborneOnce: true, tSinceTakeoff: 8, armed: false, modeControl: 'SHARE' }), null);
});

t('never at the bench, never after the first flight', () => {
	assert.equal(flightHint({ airborneOnce: false, bench: true, firstFlight: true }), null);
	assert.equal(flightHint({ airborneOnce: false, bench: false, firstFlight: false }), null);
	assert.equal(flightHint({}), null);
});

t('a disarmed drone is not told to open Settings', () => {
	// Link lost, controller disarmed: the hints stop rather than talk over the
	// end of the flight.
	assert.equal(hint({ airborneOnce: true, tSinceTakeoff: 31, armed: false }), null);
	assert.equal(hint({ airborneOnce: true, tSinceTakeoff: 1, armed: false }), null);
	// Before arming, THROTTLE UP is exactly the thing to say.
	assert.equal(hint({ airborneOnce: false, armed: false }), 'THROTTLE UP');
});

console.log(`\n${n} checks passed`);

// Selftest for the pure briefing model (tools/briefing-model.mjs). No DOM, no
// storage of its own: the four screens, the two storage rules and the in-flight
// hint timing are all decided here, so they can be checked without a browser.
// Run: node tools/briefing-selftest.mjs
import assert from 'node:assert/strict';
import {
	BRIEFING_SEEN_KEY,
	FIRST_FLIGHT_KEY,
	shouldBrief,
	markBriefed,
	markFirstFlight,
	firstFlightPending,
	briefingScreens,
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

t('the two storage keys are namespaced fpvtp.*', () => {
	assert.equal(BRIEFING_SEEN_KEY, 'fpvtp.briefingSeen');
	assert.equal(FIRST_FLIGHT_KEY, 'fpvtp.firstFlightDone');
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

// --- the four screens -------------------------------------------------------

t('four screens, in order', () => {
	const screens = briefingScreens({ input: { kind: 'keyboard' }, keyRows });
	assert.deepEqual(screens.map((s) => s.title),
		['INPUT', 'THE TERMINAL', 'A SESSION', 'BRIEFING COMPLETE']);
	assert.deepEqual(screens.map((s) => s.id),
		['input', 'terminal', 'session', 'complete']);
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

t('THE TERMINAL names the four modes and the two global keys', () => {
	const screen = briefingScreens({ input: { kind: 'keyboard' }, keyRows })[1];
	const labels = screen.rows.map((r) => r[0]);
	assert.deepEqual(labels.slice(0, 4), ['FIELD', 'BENCH', 'ARCHIVE', 'SETTINGS']);
	assert.equal(screen.rows.find((r) => r[0] === 'ESC')[1], 'BACK, EVERYWHERE');
	assert.equal(screen.rows.find((r) => r[0] === 'TAB')[1], 'SETTINGS, IN FLIGHT');
	assert.match(screen.rows.find((r) => r[0] === 'BENCH')[1], /NOTHING IS LOGGED/);
});

t('A SESSION spells the loop, with the keys read from the live map', () => {
	const screen = briefingScreens({ input: { kind: 'keyboard' }, keyRows })[2];
	const labels = screen.rows.map((r) => r[0]);
	assert.deepEqual(labels.slice(0, 3), ['TARGET SCAN', 'CONTROL VECTOR', 'FLIGHT']);
	assert.equal(screen.rows.find((r) => r[0] === 'HOLD K')[1], 'CUT THE LINK');
	assert.equal(screen.rows.find((r) => r[0] === 'V')[1], 'FPV / CHASE VIEW');
	assert.equal(screen.rows.find((r) => r[0] === 'SPACE')[1], 'PAUSE');
	assert.ok(labels.includes('THE LOG'));

	// Rebound, the rows follow.
	const rows = keyMapRows({ ...DEFAULT_KEY_MAP, cutLink: ['x'], view: ['c'] });
	const moved = briefingScreens({ input: { kind: 'keyboard' }, keyRows: rows })[2];
	assert.equal(moved.rows.find((r) => r[0] === 'HOLD X')[1], 'CUT THE LINK');
	assert.ok(moved.rows.some((r) => r[0] === 'C'));
});

t('the screens hold together with no key rows at all', () => {
	const screens = briefingScreens({ input: { kind: 'keyboard' }, keyRows: [] });
	assert.equal(screens.length, 4);
	assert.equal(screens[2].rows.find((r) => r[0] === 'HOLD K')[1], 'CUT THE LINK');
});

t('briefingScreens survives being called with nothing', () => {
	const screens = briefingScreens();
	assert.equal(screens.length, 4);
	assert.deepEqual(screens[0].rows[0], ['DEVICE', 'KEYBOARD']);
});

// --- the three in-flight hints ----------------------------------------------

const hint = (o) => flightHint({ firstFlight: true, bench: false, armed: true, ...o });

t('THROTTLE UP until the first take-off', () => {
	assert.equal(hint({ tFlight: 0, airborneOnce: false }), 'THROTTLE UP');
	assert.equal(hint({ tFlight: 12, airborneOnce: false }), 'THROTTLE UP');
});

t('[TAB] SETTINGS for six seconds after take-off, then nothing', () => {
	assert.equal(hint({ tFlight: 4, airborneOnce: true, tSinceTakeoff: 0 }), '[TAB] SETTINGS');
	assert.equal(hint({ tFlight: 9, airborneOnce: true, tSinceTakeoff: 5.9 }), '[TAB] SETTINGS');
	assert.equal(hint({ tFlight: 10, airborneOnce: true, tSinceTakeoff: 6.1 }), null);
});

t('[HOLD K] CUT LINK from thirty seconds of flight', () => {
	assert.equal(hint({ tFlight: 29, airborneOnce: true, tSinceTakeoff: 25 }), null);
	assert.equal(hint({ tFlight: 30.5, airborneOnce: true, tSinceTakeoff: 26 }), '[HOLD K] CUT LINK');
	assert.equal(hint({ tFlight: 35.9, airborneOnce: true, tSinceTakeoff: 31 }), '[HOLD K] CUT LINK');
	// Transient: it says its piece and goes.
	assert.equal(hint({ tFlight: 36.1, airborneOnce: true, tSinceTakeoff: 32 }), null);
});

t('never at the bench, never after the first flight', () => {
	assert.equal(flightHint({ tFlight: 0, airborneOnce: false, bench: true, firstFlight: true }), null);
	assert.equal(flightHint({ tFlight: 0, airborneOnce: false, bench: false, firstFlight: false }), null);
	assert.equal(flightHint({}), null);
});

t('a disarmed drone is not told to open Settings', () => {
	// Link lost, controller disarmed: the hints stop rather than talk over the
	// end of the flight.
	assert.equal(hint({ tFlight: 31, airborneOnce: true, tSinceTakeoff: 28, armed: false }), null);
	assert.equal(hint({ tFlight: 2, airborneOnce: true, tSinceTakeoff: 1, armed: false }), null);
	// Before arming, THROTTLE UP is exactly the thing to say.
	assert.equal(hint({ tFlight: 1, airborneOnce: false, armed: false }), 'THROTTLE UP');
});

console.log(`\n${n} checks passed`);

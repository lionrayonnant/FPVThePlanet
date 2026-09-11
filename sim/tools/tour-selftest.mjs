// Selftest for the pure tour model (tools/tour-model.mjs). No DOM, no storage
// of its own: the stops, the storage rules and the in-flight hint timing are
// all decided there, so they can be checked without a browser.
// Run: node tools/tour-selftest.mjs
import assert from 'node:assert/strict';
import {
	TOUR_SEEN_KEY,
	TOUR_STOPS_KEY,
	BRIEFING_SEEN_KEY,
	FIRST_FLIGHT_KEY,
	STOPS,
	PLACES,
	PLACE_SELECTORS,
	REQUIRED_STOPS,
	requiredLeft,
	tourDone,
	tourCard,
	shouldTour,
	markToured,
	loadStops,
	saveStops,
	markFirstFlight,
	firstFlightPending,
	flightHint,
} from './tour-model.mjs';
import { DEFAULT_KEY_MAP, keyMapRows } from '../src/key-map.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

console.log('tour model');

// A localStorage stand-in. `broken` throws on every access, like a browser in
// private mode does — the model must never let that block a boot.
function store({ broken = false } = {}) {
	const m = new Map();
	return {
		getItem: (k) => { if (broken) throw new Error('denied'); return m.has(k) ? m.get(k) : null; },
		setItem: (k, v) => { if (broken) throw new Error('denied'); m.set(k, String(v)); },
		has: (k) => m.has(k),
		read: (k) => m.get(k) ?? null,
	};
}

const keyRows = keyMapRows(DEFAULT_KEY_MAP);
const card = (o) => tourCard({ keyRows, ...o });

// --- the stops --------------------------------------------------------------

t('the storage keys are namespaced fpvtp.*', () => {
	assert.equal(TOUR_SEEN_KEY, 'fpvtp.tourSeen');
	assert.equal(TOUR_STOPS_KEY, 'fpvtp.tourStops');
	assert.equal(BRIEFING_SEEN_KEY, 'fpvtp.briefingSeen');
	assert.equal(FIRST_FLIGHT_KEY, 'fpvtp.firstFlightDone');
});

t('one stop per place, four of them required, in walking order', () => {
	assert.deepEqual(STOPS.map((s) => s.id), ['root', 'settings', 'field', 'scan', 'bench', 'data']);
	assert.deepEqual(REQUIRED_STOPS, ['root', 'settings', 'field', 'scan']);
	// A place with no stop would be a screen the tour goes silent on for no
	// reason; a stop with no place would never be reachable.
	assert.deepEqual([...PLACES].sort(), STOPS.map((s) => s.place).sort());
	for (const [place, sel] of PLACE_SELECTORS) {
		assert.ok(PLACES.includes(place));
		// One bare class, always: they are resolved with a plain querySelector,
		// and an id or a descendant combinator is exactly what the fake DOM of
		// tools/lib/fake-dom.mjs cannot answer.
		assert.match(sel, /^\.[\w-]+$/, `${place} selector stays simple`);
	}
});

t('SETTINGS is asked before the screen it covers', () => {
	// The panel is a layer over whatever opened it: asked last, the screen
	// underneath would answer for it and the tour would point at the wrong thing.
	assert.equal(PLACE_SELECTORS[0][0], 'settings');
	assert.ok(PLACE_SELECTORS.findIndex(([p]) => p === 'root') > PLACE_SELECTORS.findIndex(([p]) => p === 'field'));
});

t('every stop says something, in the house voice, about its own screen', () => {
	for (const s of STOPS) {
		const lines = s.lines({ input: { kind: 'keyboard' }, keyRows });
		assert.ok(lines.length >= 1 && lines.length <= 4, `${s.id}: one to four lines`);
		for (const l of lines) {
			assert.equal(typeof l, 'string');
			assert.equal(l, l.toUpperCase(), `${s.id}: "${l}" is upper case`);
			assert.ok(l.length <= 56, `${s.id}: "${l}" fits the card`);
		}
		assert.equal(s.title, s.title.toUpperCase());
		assert.equal(s.wayTo, s.wayTo.toUpperCase());
		assert.ok(Array.isArray(s.anchor));
		for (const sel of s.anchor) assert.match(sel, /^\.[\w-]+$/, `${s.id}: ${sel} stays simple`);
	}
});

t('no stop gives an order', () => {
	// The pillar, mechanically: the tour names what a thing is and what a key
	// does. "PRESS", "CLICK", "NOW", "YOU MUST" are how a tutorial talks.
	const banned = /\b(PRESS|CLICK|YOU MUST|PLEASE|NOW GO|LET'S)\b/;
	for (const s of STOPS) {
		for (const l of s.lines({ input: { kind: 'gamepad', name: 'PAD' }, keyRows })) {
			assert.doesNotMatch(l, banned, `${s.id}: "${l}"`);
		}
	}
});

// --- the card ---------------------------------------------------------------

t('nowhere the tour knows is a place it says nothing', () => {
	assert.equal(card({ place: null, seen: [] }), null);
	assert.equal(card({ place: null, seen: REQUIRED_STOPS }), null);
});

t('an unread place gives its stop, with its anchor and its number', () => {
	const c = card({ place: 'root', seen: [] });
	assert.equal(c.kind, 'stop');
	assert.equal(c.id, 'root');
	assert.equal(c.title, 'THE ROOT');
	assert.deepEqual(c.anchor, ['.bench-mode-list']);
	assert.equal(c.step, 1);
	assert.equal(c.total, 4);
	assert.equal(card({ place: 'field', seen: ['root', 'settings'] }).step, 3);
});

t('the SETTINGS stop names the device that is plugged in', () => {
	const pad = card({ place: 'settings', seen: [], input: { kind: 'gamepad', name: 'Xbox Wireless Controller' } });
	assert.match(pad.lines[0], /XBOX WIRELESS CONTROLLER/);
	assert.ok(pad.lines.some((l) => l.includes('CALIBRATE')));
	const kb = card({ place: 'settings', seen: [], input: { kind: 'keyboard' } });
	assert.match(kb.lines[0], /KEYBOARD/);
	assert.ok(kb.lines.some((l) => l.includes('W CLIMBS')), kb.lines.join(' | '));
	// A nameless pad is still a pad.
	assert.match(card({ place: 'settings', seen: [], input: { kind: 'gamepad' } }).lines[0], /GAMEPAD/);
});

t('a rebound key is the key the tour names', () => {
	const rows = keyMapRows({ ...DEFAULT_KEY_MAP, throttleUp: ['t'], cutLink: ['j'] });
	const kb = tourCard({ place: 'settings', seen: [], input: { kind: 'keyboard' }, keyRows: rows });
	assert.ok(kb.lines.some((l) => l.includes('T CLIMBS')), kb.lines.join(' | '));
	const scan = tourCard({ place: 'scan', seen: [], keyRows: rows });
	assert.ok(scan.lines.some((l) => l.includes('HOLD J')), scan.lines.join(' | '));
});

t('a place already read names what is left, once, and points nowhere', () => {
	const c = card({ place: 'root', seen: ['root'] });
	assert.equal(c.kind, 'wayTo');
	assert.equal(c.title, 'NEXT · SETTINGS');
	assert.deepEqual(c.lines, ['SETTINGS, FROM THE ROOT.']);
	assert.deepEqual(c.anchor, []);
	// It follows what is left, not what was skipped last.
	assert.equal(card({ place: 'root', seen: ['root', 'settings'] }).title, 'NEXT · FIELD');
});

t('the optional stops are said when walked into, and never waited for', () => {
	const bench = card({ place: 'bench', seen: ['root'] });
	assert.equal(bench.kind, 'stop');
	assert.ok(bench.lines.some((l) => l.includes('WHAT HAPPENS HERE DOES NOT')));
	// They do not move the counter, and they do not hold the tour open.
	assert.equal(tourDone(REQUIRED_STOPS), true);
	assert.deepEqual(requiredLeft(['root', 'bench', 'data']), ['settings', 'field', 'scan']);
});

t('the four required stops read give the last card, anywhere known', () => {
	const c = card({ place: 'root', seen: REQUIRED_STOPS });
	assert.equal(c.kind, 'done');
	assert.equal(c.title, 'TOUR COMPLETE');
	assert.ok(c.lines.some((l) => l.includes('SETTINGS / SYSTEM')));
	assert.equal(c.step, 4);
	// Reached from nowhere — the scan stop read as the flight opens — it is
	// silent: the OSD takes over.
	assert.equal(card({ place: null, seen: REQUIRED_STOPS }), null);
});

t('tourCard survives being called with nothing', () => {
	assert.equal(tourCard(), null);
	assert.equal(tourCard({ place: 'field' }).kind, 'stop');
});

// --- storage ----------------------------------------------------------------

t('shouldTour is true while the key is absent, false once marked', () => {
	const s = store();
	assert.equal(shouldTour(s), true);
	markToured(s);
	assert.equal(shouldTour(s), false);
	assert.equal(s.has(TOUR_SEEN_KEY), true);
});

t('an operator briefed under D16 is not toured', () => {
	const s = store();
	s.setItem(BRIEFING_SEEN_KEY, '1');
	assert.equal(shouldTour(s), false);
});

t('shouldTour is false without a store, and on a broken one', () => {
	assert.equal(shouldTour(null), false);
	assert.equal(shouldTour(undefined), false);
	assert.equal(shouldTour(store({ broken: true })), false);
});

t('the stops read come back, and unknown ids are dropped', () => {
	const s = store();
	assert.deepEqual(loadStops(s), []);
	saveStops(s, ['root', 'root', 'settings']);
	assert.deepEqual(loadStops(s), ['root', 'settings']);
	s.setItem(TOUR_STOPS_KEY, 'root,archive, field ');
	assert.deepEqual(loadStops(s), ['root', 'field']);
	assert.deepEqual(loadStops(null), []);
	assert.deepEqual(loadStops(store({ broken: true })), []);
});

t('nothing in the storage layer throws on a broken store', () => {
	const broken = store({ broken: true });
	markToured(broken); saveStops(broken, ['root']); markFirstFlight(broken);
	markToured(null); saveStops(null, ['root']); markFirstFlight(null);
});

t('firstFlightPending is true until the first flight ends, tour or no tour', () => {
	// It no longer asks whether the tour was offered: under D16 it did, and an
	// operator who skipped the briefing lost the three lines that mattered most.
	const s = store();
	assert.equal(firstFlightPending(s), true);
	markFirstFlight(s);
	assert.equal(firstFlightPending(s), false);
	assert.equal(firstFlightPending(null), false);
	assert.equal(firstFlightPending(store({ broken: true })), false);
});

// --- the three in-flight hints ----------------------------------------------

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
	assert.equal(hint({ airborneOnce: true, tSinceTakeoff: 29 }), null);
	assert.equal(hint({ airborneOnce: true, tSinceTakeoff: 30.5 }), '[HOLD K] CUT LINK');
	assert.equal(hint({ airborneOnce: true, tSinceTakeoff: 35.9 }), '[HOLD K] CUT LINK');
	assert.equal(hint({ airborneOnce: true, tSinceTakeoff: 36.1 }), null);
});

t('the cut-link hint names the live key, not a hard-coded K', () => {
	const rows = [{ id: 'cutLink', label: 'Cut link', keys: ['J'] }];
	assert.equal(hint({ airborneOnce: true, tSinceTakeoff: 31, keyRows: rows }), '[HOLD J] CUT LINK');
	// TAB is not remappable and stays written as it is.
	assert.equal(hint({ airborneOnce: true, tSinceTakeoff: 1, keyRows: rows }), '[TAB] SETTINGS');
});

t('never at the bench, never after the first flight', () => {
	assert.equal(flightHint({ airborneOnce: false, bench: true, firstFlight: true }), null);
	assert.equal(flightHint({ airborneOnce: false, bench: false, firstFlight: false }), null);
	assert.equal(flightHint({}), null);
});

t('a disarmed drone is not told to open Settings', () => {
	assert.equal(hint({ airborneOnce: true, tSinceTakeoff: 31, armed: false }), null);
	assert.equal(hint({ airborneOnce: true, tSinceTakeoff: 1, armed: false }), null);
	assert.equal(hint({ airborneOnce: false, armed: false }), 'THROTTLE UP');
});

console.log(`\n${n} checks passed`);

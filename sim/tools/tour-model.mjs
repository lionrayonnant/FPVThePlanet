// The tour, as data (#86). PURE: no DOM, no storage of its own, no `node:` —
// imported as-is by tools/tour-selftest.mjs and, through the Vite bundle, by
// src/tour.js, which only mounts what this file decides.
//
// It replaces the four briefing screens of D16. Those said what the game
// contained and then vanished before the operator had seen any of it: nothing
// was pointed at, and nothing was where the words had been. The tour says the
// same facts, but ON the screen they are about, pointing at the real element,
// and it follows the operator instead of being read once in a corridor.
//
// The pillar still holds (Bible, pilier 1, revised again here). Every line
// states what a thing IS or what a key DOES. Nothing waits for a gesture,
// nothing is gated, there is no CONTINUE to press: the operator walks, the tour
// walks with them. Leaving a place is what marks its stop read — the tour never
// asks for a turn it has not been given.
//
// The storage rules live here too, on the store-injected pattern of
// tools/intro-model.mjs: a browser that refuses storage must never be blocked
// by a layer it cannot dismiss for good.

export const TOUR_SEEN_KEY = 'fpvtp.tourSeen';
export const TOUR_STOPS_KEY = 'fpvtp.tourStops';
// D16's key, kept for one reason only: an operator who was briefed under the
// old screens has already been told all of this, and must not be toured on the
// first launch after an update.
export const BRIEFING_SEEN_KEY = 'fpvtp.briefingSeen';
export const FIRST_FLIGHT_KEY = 'fpvtp.firstFlightDone';

// ---------------------------------------------------------------------------
// THE STOPS
// ---------------------------------------------------------------------------
//
// One stop per PLACE, and a place is a screen the operator can actually be
// standing on. `anchor` is the element the stop is about — the layer draws a
// frame around it and nothing else; a list of selectors, first match wins, so a
// screen that renders two ways (FIELD at rest and FIELD drawing) still has
// something to point at.
//
// `required` marks the four stops that make the tour: the root, the panel where
// the sticks are set, the screen that flies, and the one between them. BENCH and
// DATA are on the way for whoever wanders in, and are not waited for.
//
// `wayTo` is what the layer says when the operator is somewhere with nothing
// left to read: where the next unread stop is, in one line.

const up = (s) => String(s ?? '').toUpperCase();

// First key bound to an action in the live map, already labelled by
// key-map.js. Falls back to the default letter so a line never reads "—" on a
// build that hands over no rows at all.
function keyOf(keyRows, id, fallback) {
	const row = (keyRows ?? []).find((r) => r.id === id);
	return up(row?.keys?.[0] || fallback);
}

// SETTINGS is the only stop whose lines depend on what is plugged in: a pad is
// calibrated, a keyboard is remapped, and telling one operator about the other's
// screen is how a tour starts being ignored.
function settingsLines({ input, keyRows }) {
	const pad = input?.kind === 'gamepad';
	const name = up(input?.name).trim();
	if (pad) {
		return [
			name ? `CONTROLLER · ${name}` : 'CONTROLLER · GAMEPAD',
			'[ CALIBRATE ] WALKS YOUR STICKS ONE BY ONE.',
			'LEFT STICK THROTTLE / YAW · RIGHT STICK PITCH / ROLL.',
			'TAB OPENS THIS PANEL IN FLIGHT · ESC CLOSES IT.',
		];
	}
	return [
		'KEYBOARD · EVERY KEY HERE CAN BE REBOUND.',
		`${keyOf(keyRows, 'throttleUp', 'W')} CLIMBS · ${keyOf(keyRows, 'view', 'V')} SWITCHES VIEW · ${keyOf(keyRows, 'pause', 'SPACE')} PAUSES.`,
		'TAB OPENS THIS PANEL IN FLIGHT · ESC CLOSES IT.',
	];
}

function scanLines({ keyRows }) {
	return [
		'THE AREA FIRST, THEN THE MACHINE.',
		'ONE SIGNAL, ONE MACHINE — YOU FLY WHAT YOU TAKE.',
		`THE LINK LASTS WHAT IT LASTS · HOLD ${keyOf(keyRows, 'cutLink', 'K')} CUTS IT.`,
	];
}

export const STOPS = [
	{
		id: 'root',
		place: 'root',
		title: 'THE ROOT',
		required: true,
		anchor: ['.bench-mode-list'],
		lines: () => [
			'FOUR WAYS IN. FIELD FLIES, BENCH COSTS NOTHING,',
			'DATA REMEMBERS, SETTINGS IS SET ONCE.',
			'UP / DOWN MOVES · ENTER OPENS · ESC COMES BACK HERE.',
		],
		wayTo: 'ESC, UNTIL THE ROOT.',
	},
	{
		id: 'settings',
		place: 'settings',
		title: 'SETTINGS',
		required: true,
		anchor: ['.terminal-tabs'],
		lines: settingsLines,
		wayTo: 'SETTINGS, FROM THE ROOT.',
	},
	{
		id: 'field',
		place: 'field',
		title: 'FIELD',
		required: true,
		anchor: ['.terminal-tabs', '.terminal-acts'],
		lines: () => [
			'THE MAP IS THE MENU · SEARCH MOVES IT.',
			'LIVE TAKES OFF FROM A PIN, ANYWHERE ON EARTH.',
			'LOCAL FLIES WHAT IS ALREADY ON DISK.',
			'[ FLY ] IS THE ONLY THING THAT TAKES OFF.',
		],
		wayTo: 'FIELD, FROM THE ROOT.',
	},
	{
		id: 'scan',
		place: 'scan',
		title: 'TARGET SCAN',
		required: true,
		anchor: ['.terminal-list'],
		lines: scanLines,
		wayTo: '[ FLY ], FROM FIELD.',
	},
	{
		id: 'bench',
		place: 'bench',
		title: 'BENCH',
		required: false,
		anchor: ['.bench-creed'],
		// The creed and the seal are already printed on this screen: a stop that
		// reads them back would be a tour talking over the thing it points at.
		lines: () => [
			'YOUR AIRFRAME, YOUR WEATHER, YOUR TIME OF DAY.',
			'THE CONFIG KEEPS — WHAT HAPPENS HERE DOES NOT.',
			'[ SPIN UP ] FLIES IT · ESC COMES BACK.',
		],
		wayTo: 'BENCH, FROM THE ROOT.',
	},
	{
		id: 'data',
		place: 'data',
		title: 'DATA',
		required: false,
		anchor: ['.data-page'],
		lines: () => [
			'FLIGHT RECORDS · TELEMETRY · OPERATOR · BUILD NOTES.',
			'WHERE YOU HAVE BEEN, AND WHAT IT COST.',
			'NOTHING HERE IS SCORED.',
		],
		wayTo: 'DATA, FROM THE ROOT.',
	},
];

// The order the layer reads places in. SETTINGS first because the panel is a
// layer over whatever screen opened it: asked last, a screen underneath would
// answer for it. The rest is deepest-first, for the same reason.
//
// One CLASS each, never an id and never a descendant combinator: these are
// resolved with a bare querySelector, on the live DOM and on the fake one of
// tools/lib/fake-dom.mjs, which answers neither. `.panel` is the settings panel
// itself rather than its #settings host — hidden is carried by the host, and
// checkVisibility() walks up to it.
export const PLACE_SELECTORS = [
	['settings', '.panel'],
	['scan', '.terminal-scan'],
	['data', '.terminal-data'],
	['bench', '.bench-config'],
	['field', '.terminal-field'],
	['root', '.bench-modes'],
];

export const PLACES = PLACE_SELECTORS.map(([id]) => id);

const stopOf = (place) => STOPS.find((s) => s.place === place) ?? null;

export const REQUIRED_STOPS = STOPS.filter((s) => s.required).map((s) => s.id);

export function requiredLeft(seen = []) {
	return REQUIRED_STOPS.filter((id) => !seen.includes(id));
}

export function tourDone(seen = []) {
	return requiredLeft(seen).length === 0;
}

// ---------------------------------------------------------------------------
// THE CARD
// ---------------------------------------------------------------------------
//
// What the layer paints, for a given place and a given history. Three shapes,
// and never more than one line of instruction in any of them:
//
//   stop      the operator is somewhere with something unread — say it
//   wayTo     the operator is somewhere already read — name what is left, once
//   done      the four required stops are read — the last word, then silence
//
// `null` means paint nothing: an unknown place (a flight, a load, a hack) is
// not a place the tour has business talking over. Completion reached from
// nowhere — the scan stop read as the flight opens — is therefore silent, which
// is exactly right: the OSD takes over from there.
export function tourCard({ place = null, seen = [], input = null, keyRows = [] } = {}) {
	// Nowhere the tour knows: a flight, a load, a hack. It says nothing there,
	// and the layer paints nothing at all.
	if (!place) return null;
	const read = Array.isArray(seen) ? seen : [];
	const left = requiredLeft(read);
	const stop = place ? stopOf(place) : null;

	if (stop && !read.includes(stop.id)) {
		return {
			kind: 'stop',
			id: stop.id,
			title: stop.title,
			lines: stop.lines({ input, keyRows }),
			anchor: stop.anchor,
			step: REQUIRED_STOPS.length - left.length + (stop.required ? 1 : 0),
			total: REQUIRED_STOPS.length,
		};
	}

	if (!left.length) {
		return {
			kind: 'done',
			id: 'done',
			title: 'TOUR COMPLETE',
			lines: [
				'SETTINGS / SYSTEM REPLAYS IT.',
				'THE REST IS FLYING.',
			],
			anchor: [],
			step: REQUIRED_STOPS.length,
			total: REQUIRED_STOPS.length,
		};
	}

	// Somewhere known but already read, or nowhere at all: the next stop is
	// named, never nagged. One line, and the way to it.
	const next = STOPS.find((s) => s.id === left[0]);
	return {
		kind: 'wayTo',
		id: `way-${next.id}`,
		title: `NEXT · ${next.title}`,
		lines: [next.wayTo],
		anchor: [],
		step: REQUIRED_STOPS.length - left.length,
		total: REQUIRED_STOPS.length,
	};
}

// ---------------------------------------------------------------------------
// STORAGE
// ---------------------------------------------------------------------------

// A missing or unreadable store answers NO. An operator who has flown for
// months and cleared their storage would rather not be toured again; a new
// player who is toured twice loses nothing but the second time. When in doubt,
// say nothing — that is the house tone.
export function shouldTour(store) {
	if (!store) return false;
	try {
		if (store.getItem(TOUR_SEEN_KEY) === '1') return false;
		// Briefed under D16: already told, in the old words. Not toured.
		return store.getItem(BRIEFING_SEEN_KEY) !== '1';
	} catch { return false; }
}

export function markToured(store) {
	try { store?.setItem(TOUR_SEEN_KEY, '1'); } catch { /* private browsing: it replays, it does not crash */ }
}

// The stops already read, as a list. Unknown ids are dropped rather than kept:
// a stop that was renamed is a stop that was never read.
export function loadStops(store) {
	try {
		const raw = store?.getItem(TOUR_STOPS_KEY);
		if (!raw) return [];
		return String(raw).split(',').map((s) => s.trim()).filter((id) => STOPS.some((s) => s.id === id));
	} catch { return []; }
}

export function saveStops(store, seen) {
	try { store?.setItem(TOUR_STOPS_KEY, [...new Set(seen)].join(',')); } catch { /* idem */ }
}

export function markFirstFlight(store) {
	try { store?.setItem(FIRST_FLIGHT_KEY, '1'); } catch { /* idem */ }
}

// The window in which the in-flight hints exist: one flight, once, ever. It no
// longer asks whether the tour was offered — under D16 it did, and an operator
// who skipped the briefing lost the three lines that mattered most.
export function firstFlightPending(store) {
	// No store at all is not a new pilot: it is a browser we cannot read, and
	// the same rule as shouldTour() applies — when in doubt, say nothing.
	if (!store) return false;
	try { return store.getItem(FIRST_FLIGHT_KEY) !== '1'; } catch { return false; }
}

// ---------------------------------------------------------------------------
// THE THREE IN-FLIGHT HINTS
// ---------------------------------------------------------------------------
//
// Where the tour ends: the layer unmounts at take-off — a panel over the FPV
// image would be exactly the assistance this game refuses — and the last three
// things worth saying are said by the OSD instead, one line at a time.

// How long each transient hint stays up, and when the link one is due.
export const HINT_HOLD_S = 6;
export const CUT_HINT_AT_S = 30;

// One line, or nothing. Called every frame by main.js and painted by the OSD
// like #fo-cut, so it must be cheap and it must be stable: the same inputs
// always give the same line.
//
// `tSinceTakeoff` is the time since the drone first left the ground — BOTH
// windows hang on it (V7): keyed on the session clock, a pilot who took off at
// 40 s never saw the cut-link line at all. `keyRows` is the live key map, so
// the line names the key this operator actually holds; TAB is not remappable
// and stays written as it is. Bench flights are not a first flight, and a
// disarmed machine is not told anything — a link that just died is not the
// moment for advice.
export function flightHint({
	armed = false, airborneOnce = false, tSinceTakeoff = 0,
	bench = false, firstFlight = false, keyRows = [],
} = {}) {
	if (bench || !firstFlight) return null;
	// Before the first take-off the only thing worth saying is where the
	// altitude comes from.
	if (!airborneOnce) return 'THROTTLE UP';
	if (!armed) return null;
	// The later line wins where the two windows overlap.
	if (tSinceTakeoff >= CUT_HINT_AT_S && tSinceTakeoff < CUT_HINT_AT_S + HINT_HOLD_S) {
		return `[HOLD ${keyOf(keyRows, 'cutLink', 'K')}] CUT LINK`;
	}
	if (tSinceTakeoff <= HINT_HOLD_S) return '[TAB] SETTINGS';
	return null;
}

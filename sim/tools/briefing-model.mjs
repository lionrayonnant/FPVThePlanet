// The briefing, as data (D16). PURE: no DOM, no localStorage of its own, no
// `node:` — imported as-is by tools/briefing-selftest.mjs and, through the Vite
// bundle, by src/briefing.js, which only mounts what this file decides.
//
// The Bible said "no tutorial" and it still does not want one: nothing here
// instructs the player. Every row states what a thing IS or DOES; none of them
// tells anyone to do it. That is the whole difference between a briefing and a
// tutorial, and it is the reason this screen is allowed to exist at all
// (revised 2026-09-08).
//
// The storage rules live here too, on the same store-injected pattern as
// tools/intro-model.mjs: a browser that refuses storage must never be blocked
// by a screen it cannot dismiss for good.

export const BRIEFING_SEEN_KEY = 'fpvtp.briefingSeen';
export const FIRST_FLIGHT_KEY = 'fpvtp.firstFlightDone';

// A missing or unreadable store answers NO. An operator who has flown for
// months and cleared their storage would rather not be briefed again; a new
// player who is briefed twice loses nothing but the second time. When in
// doubt, say nothing — that is the house tone.
export function shouldBrief(store) {
	if (!store) return false;
	try { return store.getItem(BRIEFING_SEEN_KEY) !== '1'; }
	catch { return false; }
}

export function markBriefed(store) {
	try { store?.setItem(BRIEFING_SEEN_KEY, '1'); } catch { /* private browsing: it replays, it does not crash */ }
}

export function markFirstFlight(store) {
	try { store?.setItem(FIRST_FLIGHT_KEY, '1'); } catch { /* idem */ }
}

// The window in which the in-flight hints exist: briefed, and not yet flown.
// One flight, once, ever.
export function firstFlightPending(store) {
	try {
		return store?.getItem(BRIEFING_SEEN_KEY) === '1'
			&& store?.getItem(FIRST_FLIGHT_KEY) !== '1';
	} catch { return false; }
}

// ---------------------------------------------------------------------------
// THE FOUR SCREENS
// ---------------------------------------------------------------------------

const up = (s) => String(s ?? '').toUpperCase();

// First key bound to an action in the live map, already labelled by
// key-map.js. Falls back to the default letter so the row never reads "—"
// on a build that hands over no rows at all.
function keyOf(keyRows, id, fallback) {
	const row = (keyRows ?? []).find((r) => r.id === id);
	return row?.keys?.[0] || fallback;
}

function inputScreen(input, keyRows) {
	const gamepad = input?.kind === 'gamepad';
	if (gamepad) {
		const name = up(input?.name).trim();
		return {
			id: 'input',
			title: 'INPUT',
			rows: [
				['DEVICE', name ? `GAMEPAD ${name}` : 'GAMEPAD'],
				// The mapping of input.js, said in sticks rather than axis
				// numbers — an axis number is a fact about a driver, not about
				// the hands on the radio.
				['THROTTLE / YAW', 'LEFT STICK'],
				['PITCH / ROLL', 'RIGHT STICK'],
				['STICK FORWARD', 'NOSE DOWN'],
			],
			actions: ['calibrate', 'continue'],
		};
	}
	return {
		id: 'input',
		title: 'INPUT',
		rows: [
			['DEVICE', 'KEYBOARD'],
			...(keyRows ?? []).map((r) => [up(r.label), up(r.keys.join(' / ')) || '—']),
		],
		actions: ['mapKeys', 'continue'],
	};
}

function terminalScreen() {
	return {
		id: 'terminal',
		title: 'THE TERMINAL',
		rows: [
			['FIELD', 'A DOWNLOADED AREA, OR A LIVE MAP PIN'],
			['BENCH', 'SANDBOX. NOTHING IS LOGGED'],
			['ARCHIVE', 'SESSION LOG, TARGET LOG, OPERATOR, BUILD NOTES'],
			['SETTINGS', 'CONTROLLER, KEYBOARD, AUDIO, SYSTEM'],
			['ESC', 'BACK, EVERYWHERE'],
			['TAB', 'SETTINGS, IN FLIGHT'],
		],
		actions: ['continue'],
	};
}

function sessionScreen(keyRows) {
	const cut = up(keyOf(keyRows, 'cutLink', 'K'));
	const view = up(keyOf(keyRows, 'view', 'V'));
	const pause = up(keyOf(keyRows, 'pause', 'SPACE'));
	return {
		id: 'session',
		title: 'A SESSION',
		rows: [
			['TARGET SCAN', 'THE AREA, THEN THE MACHINE'],
			['CONTROL VECTOR', 'THE ARROWS YOU REGISTERED'],
			['FLIGHT', 'THE LINK LASTS WHAT IT LASTS'],
			[`HOLD ${cut}`, 'CUT THE LINK'],
			[view, 'FPV / CHASE VIEW'],
			[pause, 'PAUSE'],
			['THE LOG', 'KEEPS WHAT HAPPENED'],
		],
		actions: ['continue'],
	};
}

function completeScreen() {
	return {
		id: 'complete',
		title: 'BRIEFING COMPLETE',
		rows: [
			['SETTINGS / SYSTEM', 'REPLAYS THIS BRIEFING'],
		],
		actions: ['continue'],
	};
}

// `input` = { kind: 'gamepad' | 'keyboard', name }, `keyRows` = keyMapRows() of
// the LIVE map (src/key-map.js) — never a copy, so a rebound key is right here
// the moment it is rebound.
export function briefingScreens({ input = null, keyRows = [] } = {}) {
	return [
		inputScreen(input, keyRows),
		terminalScreen(),
		sessionScreen(keyRows),
		completeScreen(),
	];
}

// ---------------------------------------------------------------------------
// THE THREE IN-FLIGHT HINTS
// ---------------------------------------------------------------------------

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
		return `[HOLD ${up(keyOf(keyRows, 'cutLink', 'K'))}] CUT LINK`;
	}
	if (tSinceTakeoff <= HINT_HOLD_S) return '[TAB] SETTINGS';
	return null;
}

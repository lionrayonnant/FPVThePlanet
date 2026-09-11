// The tour (#86). A layer that walks the interface WITH the operator, mounted
// on #ui once and alive across every screen — it is not a screen itself and it
// never owns the game: no modal, no gate, no CONTINUE to press.
//
// It replaces the four briefing screens of D16, which stated what the game
// contained before the operator had seen any of it. Here the words land on the
// screen they are about, a frame is drawn around the real element, and leaving
// a place is what marks its stop read.
//
// What is SAID is decided by tools/tour-model.mjs; this file only finds where
// the operator is standing, paints the card and follows.
//
// Where it lives in the loop:
//   mounted   right after the operator is registered (main.js), or replayed
//             from SETTINGS / SYSTEM
//   silent    anywhere it does not know — a flight, a load, a hack
//   gone      once the four required stops are read, or on [ H ] / [ DISMISS ]
import { button, keyHints } from './terminal.js';
import { isTextEntry } from './menu-nav.js';
import {
	PLACE_SELECTORS, tourCard, tourDone, loadStops, saveStops, markToured,
} from '../tools/tour-model.mjs';

// The poll. The tour has no way to be told that a screen was mounted — every
// screen in this game builds its own tree and answers to nobody — so it looks,
// at the cadence menu-nav.js already polls the gamepad at. Cheap: one
// querySelector per known place, and a rect read only while a card is up.
const POLL_MS = 150;

// A stop the operator crossed in less time than this was not read, and is not
// marked. FIELD on the way to a flight is a place one stays in; FIELD traversed
// in half a second on the way back from ALL TERRAIN is not.
const READ_MS = 2500;

// How long TOUR COMPLETE stays up before the layer takes itself away.
const DONE_HOLD_MS = 7000;

// The key that ends it. Not Escape — Escape means BACK everywhere in this game
// (D15) and the tour has no business taking it. `h` is bound to nothing in
// key-map.js. Known limit: a pad-only operator has no key for this; the tour
// ends on its own at the fourth stop, and [ DISMISS ] is clickable.
const DISMISS_KEY = 'h';

const shown = (el) => !!el && el.isConnected && (el.checkVisibility?.() ?? !el.hidden);

// `store` is the localStorage the stops are remembered in (injected: a private
// window that refuses it must still get the tour, it simply forgets).
//
// `input` and `keyRows` may be values or functions, and are read on EVERY tick:
// the SETTINGS stop then names the pad that is plugged in now, and a key
// rebound in the very panel the card points at changes the card while the
// operator watches. `restart` is the replay — a walk already walked must start
// from nothing, or it would open on its own last word.
//
// `silent()` is asked before anything else and answers one question: is a
// flight running. The Settings panel is one of the stops AND is reachable with
// TAB in the air, so without it a tour still walking would come back up over
// the FPV image the moment the panel opened there.
//
// `onEnd` fires once, however the tour ended. `pollMs` and `now` are test seams
// — the selftest has neither the patience for READ_MS nor a clock to wait on.
export function runTour(root, {
	store = null, input = null, keyRows = [], restart = false, silent = () => false,
	pollMs = POLL_MS, onEnd = null, now = () => Date.now(),
} = {}) {
	const live = (v) => (typeof v === 'function' ? v() : v);
	let seen = restart ? [] : loadStops(store);
	if (restart) saveStops(store, seen);
	let ended = false;

	const layer = document.createElement('div');
	layer.className = 'tour';

	// The frame around the element the card is about. A sibling of the card, not
	// a child: it travels to wherever the anchor is, the card does not move.
	const spot = document.createElement('div');
	spot.className = 'tour-spot';
	spot.hidden = true;
	spot.setAttribute('aria-hidden', 'true');

	// A BAND along the bottom of the window, not a card floating over the middle
	// of a screen: the interface makes room for it (body.tour-on) instead of
	// being covered by it. Three parts on one row — which stop, what it says,
	// how to end it — stacking under 1100 px like every other two-column layout
	// in this game.
	const card = document.createElement('aside');
	card.className = 'tour-card';
	// Announced rather than focused: the tour must never steal the cursor from
	// the screen the operator is using.
	card.setAttribute('role', 'status');
	card.setAttribute('aria-live', 'polite');

	const head = document.createElement('div');
	head.className = 'tour-head';
	const step = document.createElement('pre');
	step.className = 'tour-step';
	const title = document.createElement('pre');
	title.className = 'tour-title';
	head.append(step, title);
	const lines = document.createElement('pre');
	lines.className = 'tour-lines';
	const acts = document.createElement('div');
	acts.className = 'tour-acts';
	acts.appendChild(button('DISMISS', () => end(), 'terminal-cta'));
	acts.appendChild(keyHints([[DISMISS_KEY.toUpperCase(), 'DISMISS THE TOUR']]));
	card.append(head, lines, acts);

	layer.append(spot, card);
	root.appendChild(layer);
	// The band is reserved on the document, not on the layer: every screen under
	// it grows a bottom padding, so nothing the tour talks about ends up hidden
	// behind the tour. Taken back on end().
	document.body?.classList?.add('tour-on');

	// --- where we are ---------------------------------------------------------

	// The first known place whose screen is really on screen. PLACE_SELECTORS is
	// ordered deepest-first: the Settings panel is a layer over whatever opened
	// it, so it is asked before the screen underneath can answer for it.
	function currentPlace() {
		for (const [place, sel] of PLACE_SELECTORS) {
			const el = root.querySelector(sel);
			if (shown(el)) return { place, el };
		}
		return { place: null, el: null };
	}

	// Inside the place's own element, in order — never a descendant selector, so
	// the resolution holds on the fake DOM too. Nothing matching is not a bug:
	// the whole screen is then what the card is about.
	function anchorOf(placeEl, selectors) {
		for (const sel of selectors ?? []) {
			const el = placeEl?.querySelector(sel);
			if (shown(el)) return el;
		}
		return placeEl;
	}

	// --- painting -------------------------------------------------------------

	let shownId = null;      // which card is on screen
	let shownSig = null;     // and its text, so a rebound key redraws it
	let shownStop = null;    // the stop it belongs to, when it is one
	let shownAt = 0;         // when it went up, for READ_MS
	let doneAt = 0;          // when TOUR COMPLETE went up, for DONE_HOLD_MS

	function paint(c) {
		// The card is NEW — its timers restart — only when the card itself
		// changes. Text that changes underneath (a pad plugged in, a key
		// rebound in the panel this very card points at) redraws without
		// resetting how long the operator has been standing here.
		if (c.id !== shownId) {
			shownId = c.id;
			shownStop = c.kind === 'stop' ? c.id : null;
			shownAt = now();
			if (c.kind === 'done') doneAt = shownAt;
		}
		const sig = `${c.id}\u0000${c.title}\u0000${c.lines.join('\n')}`;
		if (sig === shownSig) return;
		shownSig = sig;
		step.textContent = `TOUR ${Math.min(c.step, c.total)}/${c.total}`;
		title.textContent = c.title;
		lines.textContent = c.lines.join('\n');
		card.dataset.kind = c.kind;
	}

	// The frame follows the anchor's box in viewport coordinates — the layer is
	// fixed, so no scroll offset enters the arithmetic. A DOM without
	// getBoundingClientRect (the selftest's) simply gets no frame, and the card
	// still says everything that matters.
	function frame(el) {
		const r = el?.getBoundingClientRect?.();
		if (!r || !(r.width > 0) || !(r.height > 0)) { spot.hidden = true; return; }
		spot.hidden = false;
		spot.style.transform = `translate(${Math.round(r.left)}px, ${Math.round(r.top)}px)`;
		spot.style.width = `${Math.round(r.width)}px`;
		spot.style.height = `${Math.round(r.height)}px`;
	}

	// --- the walk -------------------------------------------------------------

	let lastPlace = null;

	function markRead(id) {
		if (!id || seen.includes(id)) return;
		seen = [...seen, id];
		saveStops(store, seen);
	}

	function tick() {
		if (ended) return;
		const { place, el } = silent() ? { place: null, el: null } : currentPlace();

		// Left the place the card was about: that stop is read, provided it was
		// up long enough to have been.
		if (place !== lastPlace) {
			if (shownStop && now() - shownAt >= READ_MS) markRead(shownStop);
			lastPlace = place;
			shownId = null;
			shownSig = null;
			shownStop = null;
		}

		const c = tourCard({ place, seen, input: live(input), keyRows: live(keyRows) });
		if (!c) {
			// Nowhere the tour knows. It says nothing — and if the walk finished
			// on the way out (the scan stop read as the flight opens), it ends
			// here, silently, leaving the air to the OSD hints.
			layer.hidden = true;
			spot.hidden = true;
			// Silent means gone, band included: a flight owes the tour nothing.
			document.body?.classList?.remove('tour-on');
			if (tourDone(seen)) end();
			return;
		}

		layer.hidden = false;
		document.body?.classList?.add('tour-on');
		paint(c);
		frame(c.anchor.length ? anchorOf(el, c.anchor) : null);

		// The last word does not linger.
		if (c.kind === 'done' && now() - doneAt >= DONE_HOLD_MS) end();
	}

	// --- ending ---------------------------------------------------------------

	function end() {
		if (ended) return;
		ended = true;
		clearInterval(poll);
		window.removeEventListener('keydown', onKey);
		window.removeEventListener('resize', tick);
		layer.remove();
		document.body?.classList?.remove('tour-on');
		// Dismissed or walked through, it has been offered: it does not come
		// back on its own. SETTINGS / SYSTEM replays it.
		markToured(store);
		saveStops(store, seen);
		onEnd?.();
	}

	function onKey(e) {
		if (e.repeat || e.defaultPrevented) return;
		// The scanner's search field owns its letters.
		if (isTextEntry(e.target)) return;
		if (String(e.key).toLowerCase() !== DISMISS_KEY) return;
		end();
	}

	window.addEventListener('keydown', onKey);
	window.addEventListener('resize', tick);
	const poll = setInterval(tick, pollMs);
	tick();

	return {
		el: layer,
		// Ends the tour for good, as [ DISMISS ] does. main.js has no reason to
		// call it today — the layer goes quiet by itself wherever it does not
		// belong — but a caller that needs the DOM clean has one way to say so.
		end,
		// Test seam and nothing more: the poll is what drives this in the game.
		tick,
	};
}

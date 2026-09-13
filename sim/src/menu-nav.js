// Keyboard and gamepad navigation of the menus (issue #123). It generalises the
// convention that had been written twice independently (session-log.js,
// target-scan.js): up/down move a cursor, left/right adjust or change filter,
// Enter activates, Escape/Backspace goes back up. The cursor IS the browser's
// native focus (element.focus()): Tab, mouse, keyboard and pad all tell the same
// story, and the ▌ marker (painted by style.css on :focus) can never disagree
// with the element that is actually active. This module touches no style.
//
// A screen subscribes EXPLICITLY through menuNav(). Two contexts never do,
// because the arrows mean something else there: some of bootstrap.js's screens,
// where the direction IS the data being entered — they lay down a blockNav() to
// make the screens still mounted underneath inert — and the flight (input.js),
// where it is a command.
// Events whose target is a text field are left alone (except Escape): the
// scanner's search stays editable.
import { readGamepadDir } from './gamepad-dir.js';

// ---------- pure logic (covered by tools/menu-nav-selftest.mjs) ----------

// The next index in a circular list. With no current element (focus lost after
// a re-render) we enter by the edge the movement comes from.
export function nextIndex(length, current, delta) {
	if (!length) return -1;
	if (current < 0) return delta > 0 ? 0 : length - 1;
	return (current + delta + length) % length;
}

// The next value of an <input type=range>: one clamped step in the direction
// asked for — the pad adjusts a slider exactly as the native arrows do.
export function stepValue({ value, min, max, step }, dir) {
	const s = Number.isFinite(step) && step > 0 ? step : 1;
	const lo = Number.isFinite(min) ? min : 0;
	const hi = Number.isFinite(max) ? max : 100;
	const next = value + (dir === 'right' ? s : -s);
	return Math.min(hi, Math.max(lo, next));
}

// The keys of a field you type into belong to it (issue #123: without this rule
// the scanner's search becomes uneditable). A range or a checkbox is not text
// entry.
export function isTextEntryKind(tag, type) {
	if (tag === 'TEXTAREA') return true;
	if (tag !== 'INPUT') return false;
	return !['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file'].includes(type);
}

export function isTextEntry(el) {
	return !!el && isTextEntryKind(el.tagName, String(el.type ?? '').toLowerCase());
}

// ---------- the stack of screens ----------

// The active nav is the topmost one on the stack whose screen is still visible:
// a panel opened on top (Settings over the Home, a record over its list) takes
// over without the screen underneath having to unsubscribe — it is enough that
// the one underneath is hidden, or was mounted earlier.
const stack = [];

const isShown = (el) => el.isConnected && (el.checkVisibility?.() ?? true);

// A screen REMOVED from the DOM without its detach() having been called used to
// leave its gamepad poll and its key listener behind (issue #210): the stack is
// module-level, so every screen crossed in a session added an 80 ms timer and a
// `back` that could still be triggered from a dead screen. `isShown` alone
// cannot conclude death: a list HIDDEN behind its record (target-scan) is
// invisible but very much alive, and must take over again on the way back.
// `isConnected` draws exactly that line — hidden stays connected, removed does
// not. The `seen` flag avoids killing a nav created just before its screen is
// inserted into the document: it is set at mount (the common case) and
// refreshed on every sweep (the case of a screen subscribed then inserted).
// Setting it ONLY on the sweep was not enough — a screen removed before the
// first tick would never have been seen alive, so never collected.
function isDead(entry) {
	if (entry.container.isConnected) { entry.seen = true; return false; }
	return !!entry.seen;
}

// A lazy sweep: every path that consults the stack pays for it, and no separate
// housekeeping timer is needed.
function reap() {
	for (let i = stack.length - 1; i >= 0; i--) {
		if (isDead(stack[i])) stack[i].release?.();
	}
}

function topNav() {
	reap();
	for (let i = stack.length - 1; i >= 0; i--) {
		if (isShown(stack[i].container)) return stack[i];
	}
	return null;
}

// Makes every nav inert while an unsubscribed screen (the CONTROL VECTOR
// capture, the ritual) is mounted on top. Returns the function that releases
// the stack.
export function blockNav(container) {
	const entry = { container, blocker: true, seen: !!container.isConnected };
	entry.release = () => {
		const i = stack.indexOf(entry);
		if (i >= 0) stack.splice(i, 1);
	};
	stack.push(entry);
	return entry.release;
}

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), '
	+ 'select:not(:disabled), textarea:not(:disabled)';

const KEY_TO_DIR = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

// Standard gamepad buttons: 0 = A/south (activate), 1 = B/east (go back up) —
// the same as everywhere else on the Standard Gamepad.
const PAD_CONFIRM = 0;
const PAD_BACK = 1;
const PAD_POLL_MS = 80; // the same cadence as bootstrap.js

// `container`: the screen's root element (usually s.el). Options:
// - back    : Escape / Backspace / B button — go back up one screen.
// - onDir   : left/right when the focus is not on an adjustable control — for
//             the SESSION LOG's filters. Returns true if the direction is
//             consumed; otherwise left/right navigate like up/down.
// - focusFirst : put the cursor on the first element at mount (the default).
//             Turn it off when the screen places its own focus (scanner).
// - gamepad : wire the pad up (the default). Turn it off when the sticks
//             already mean something else — the Settings panel opened IN
//             FLIGHT, where they fly the drone and would move the cursor and
//             the sliders on every gesture.
export function menuNav(container, { back = null, onDir = null, focusFirst = true, gamepad = true } = {}) {
	const nav = { container, seen: !!container.isConnected };

	const focusables = () => [...container.querySelectorAll(FOCUSABLE)].filter(isShown);

	const focused = () => {
		const el = document.activeElement;
		return el && container.contains(el) ? el : null;
	};

	const focusAt = (i) => { focusables()[i]?.focus(); };

	const move = (delta) => {
		const els = focusables();
		const i = nextIndex(els.length, els.indexOf(document.activeElement), delta);
		if (i >= 0) els[i].focus();
	};

	// left/right: adjust the focused control when it is one (slider, select),
	// otherwise the screen decides (filters), otherwise navigate (issue #123).
	const adjust = (el, dir) => {
		if (!el) return false;
		if (el.matches('input[type="range"]')) {
			const next = stepValue({
				value: Number(el.value), min: Number(el.min), max: Number(el.max), step: Number(el.step),
			}, dir);
			if (next !== Number(el.value)) {
				el.value = String(next);
				// The same event as the mouse gesture: the existing oninput handlers
				// (settings.js) persist and re-emit without knowing we exist.
				el.dispatchEvent(new Event('input', { bubbles: true }));
			}
			return true;
		}
		if (el.matches('select')) {
			const i = el.selectedIndex + (dir === 'right' ? 1 : -1);
			if (i >= 0 && i < el.options.length) {
				el.selectedIndex = i;
				el.dispatchEvent(new Event('change', { bubbles: true }));
			}
			return true;
		}
		return false;
	};

	const handleDir = (dir) => {
		if (dir === 'up' || dir === 'down') { move(dir === 'down' ? 1 : -1); return; }
		if (adjust(focused(), dir)) return;
		if (onDir?.(dir)) return;
		move(dir === 'right' ? 1 : -1);
	};

	// The cursor IS native focus — so a click that lands beside a button (the
	// screen's background, a title, a line of text) makes it DISAPPEAR: the
	// browser blurs, nothing carries the ▌ marker any more, and Enter activates
	// nothing. It then took an arrow to bring it back — at the top of the list,
	// not where it was — or Escape to leave the screen and come back. The
	// gamepad poll already had its answer ("cursor lost: A puts it back first");
	// the keyboard and the mouse had none.
	//
	// So the focus is PUT BACK where it was, rather than blocking `mousedown`:
	// preventing the default would indeed keep the focus, but it would also kill
	// mouse selection — and things here are selected by hand (a payment address,
	// a log line), to the point that the COPY button's own fallback reads
	// "SELECT IT BY HAND".
	//
	// TWO triggers, because one browser is not enough to prove a focus fix.
	// `focusout` alone works in Chrome, where the focus moves once, on
	// mousedown. Firefox blurs on mousedown AND settles the focus again when the
	// click completes: the restore, deferred by one turn, landed between the two
	// and the click undid it. The `click` listener runs after the whole mouse
	// sequence, so it is the one that holds there. Both are idempotent — when
	// the focus is already somewhere inside the screen they do nothing at all.
	//
	// `lastFocused` is fed by focusin rather than read off the event, because
	// the click that loses the cursor carries no memory of where it was.
	let lastFocused = null;
	const onFocusIn = (e) => { lastFocused = e.target; };

	// Deferred by one turn: `document.activeElement` is only up to date AFTER
	// the event. If the focus landed somewhere else inside the screen (another
	// button, a field), or if another nav took over in the meantime, we touch
	// nothing.
	const restore = (hint = null) => setTimeout(() => {
		if (topNav() !== nav) return;
		const now = document.activeElement;
		if (now && now !== document.body && container.contains(now)) return;
		// Leaving a text field is an intention: the cursor is not sent back into
		// it, nor into another one — on FIELD the search is the FIRST control of
		// the screen, so "go back to the top" would have put it right back. The
		// cursor restarts from the first control you can press.
		const el = hint ?? lastFocused;
		if (el && !isTextEntry(el) && isShown(el) && container.contains(el)) { el.focus(); return; }
		const els = focusables();
		(els.find((e) => !isTextEntry(e)) ?? els[0])?.focus();
	}, 0);

	const onFocusOut = (e) => { if (topNav() === nav) restore(e.target); };
	// Every screen that subscribes is full-frame (`.bootstrap`, fixed inset 0),
	// so a click that lands on nothing still lands in here.
	const onClick = () => { if (topNav() === nav) restore(); };

	const onKey = (e) => {
		if (topNav() !== nav) return;
		if (isTextEntry(e.target)) {
			// Escape still leaves the screen: it edits nothing. Everything else
			// (arrows, Backspace, Enter) belongs to the field.
			if (e.key === 'Escape' && back) { e.preventDefault(); back(); }
			return;
		}
		const dir = KEY_TO_DIR[e.key];
		if (dir) { e.preventDefault(); handleDir(dir); return; }
		if ((e.key === 'Escape' || e.key === 'Backspace') && back) { e.preventDefault(); back(); }
		// Enter is not handled here: a focused button receives it natively.
	};

	// Pad: the same directions as the keyboard (readGamepadDir), plus A to
	// activate the focused element and B to go back up. Rising edge only, and
	// the initial state is "held": the button that validated the previous screen
	// must not carry through to this one.
	let padPrev = null;
	const padHeld = { [PAD_CONFIRM]: true, [PAD_BACK]: true };
	const padPoll = !gamepad ? 0 : setInterval(() => {
		if (topNav() !== nav) { padPrev = null; return; }
		const d = readGamepadDir(padPrev);
		if (d && d !== '__hold') { padPrev = d; handleDir(d); }
		else if (!d) padPrev = null;

		const pad = (navigator.getGamepads?.() ?? []).find(Boolean);
		for (const b of [PAD_CONFIRM, PAD_BACK]) {
			const down = !!pad?.buttons[b]?.pressed;
			if (down && !padHeld[b]) {
				if (b === PAD_BACK) back?.();
				else {
					const el = focused();
					if (el) el.click?.();
					else focusAt(0); // cursor lost: A puts it back first
				}
			}
			padHeld[b] = down;
		}
	}, PAD_POLL_MS);

	nav.focusAt = focusAt;
	// `release` is the name the stack knows (reap), `detach` the one the screens
	// call: one and the same function, idempotent.
	nav.detach = nav.release = () => {
		clearInterval(padPoll);
		window.removeEventListener('keydown', onKey);
		container.removeEventListener('focusout', onFocusOut);
		container.removeEventListener('focusin', onFocusIn);
		container.removeEventListener('click', onClick);
		const i = stack.indexOf(nav);
		if (i >= 0) stack.splice(i, 1);
	};

	window.addEventListener('keydown', onKey);
	// focusin/focusout bubble (unlike focus/blur): a single pair of listeners on
	// the screen covers every control it has, including the ones a re-render
	// creates later.
	container.addEventListener('focusin', onFocusIn);
	container.addEventListener('focusout', onFocusOut);
	container.addEventListener('click', onClick);
	stack.push(nav);
	if (focusFirst) focusAt(0);
	return nav;
}

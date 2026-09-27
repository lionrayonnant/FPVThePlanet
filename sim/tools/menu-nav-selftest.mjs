// Selftest of src/menu-nav.js (issue #123). Most of it is pure logic with no
// I/O. The end of the file also covers the LIFECYCLE of the nav stack on the
// fake DOM (issue #210): that is where a screen removed without detach() left
// an 80 ms gamepad poll behind it.
// Run: node tools/menu-nav-selftest.mjs
import assert from 'node:assert/strict';
import { nextIndex, stepValue, isTextEntry, isTextEntryKind } from '../src/menu-nav.js';
import { readGamepadDir } from '../src/gamepad-dir.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

// --- nextIndex --------------------------------------------------------------

t('nextIndex: circles both ways', () => {
	assert.equal(nextIndex(3, 0, 1), 1);
	assert.equal(nextIndex(3, 2, 1), 0);
	assert.equal(nextIndex(3, 0, -1), 2);
});

t('nextIndex: with no current focus, enter by the edge the movement comes from', () => {
	assert.equal(nextIndex(4, -1, 1), 0);
	assert.equal(nextIndex(4, -1, -1), 3);
});

t('nextIndex: an empty list -> -1 (nothing to focus)', () => {
	assert.equal(nextIndex(0, -1, 1), -1);
	assert.equal(nextIndex(0, 0, -1), -1);
});

// --- stepValue --------------------------------------------------------------

t('stepValue: one step in the direction asked for', () => {
	assert.equal(stepValue({ value: 50, min: 0, max: 100, step: 1 }, 'right'), 51);
	assert.equal(stepValue({ value: 50, min: 0, max: 100, step: 1 }, 'left'), 49);
});

t('stepValue: clamped at both ends of the slider', () => {
	assert.equal(stepValue({ value: 100, min: 0, max: 100, step: 1 }, 'right'), 100);
	assert.equal(stepValue({ value: 0, min: 0, max: 100, step: 1 }, 'left'), 0);
});

t('stepValue: a fractional step is honoured (shutter 0.5)', () => {
	assert.equal(stepValue({ value: 8, min: 0, max: 20, step: 0.5 }, 'right'), 8.5);
});

t('stepValue: missing attributes (NaN) -> a step of 1 over 0..100', () => {
	assert.equal(stepValue({ value: 99.5, min: NaN, max: NaN, step: NaN }, 'right'), 100);
	assert.equal(stepValue({ value: 0.5, min: NaN, max: NaN, step: NaN }, 'left'), 0);
});

// --- readGamepadDir, now pure ------------------------------------------------
//
// It used to call navigator.getGamepads() itself and read `pad.axes[0..1]` off
// the FIRST enumerated pad. Two bugs in one line: with a radio AND a gamepad
// plugged in the cursor obeyed the wrong device, and on a radio in standard
// mapping axis 1 can be the THROTTLE stick — which does not come back to centre,
// so the cursor left in one direction and stayed there.
//
// It is now handed { x, y }: roll and pitch, the only two channels that
// self-centre on every device, read through the same calibrated path as the
// flight.

t('readGamepadDir: the four directions, and the SIGN of each one', () => {
	// The convention, written down because this is exactly the kind of detail that
	// ends up backwards: pitch is -1 with the stick pushed FORWARD, and forward
	// moves the cursor UP.
	assert.equal(readGamepadDir(null, { x: 0, y: -1 }), 'up');
	assert.equal(readGamepadDir(null, { x: 0, y: 1 }), 'down');
	assert.equal(readGamepadDir(null, { x: -1, y: 0 }), 'left');
	assert.equal(readGamepadDir(null, { x: 1, y: 0 }), 'right');
});

t('readGamepadDir: a stick just off centre moves nothing', () => {
	assert.equal(readGamepadDir(null, { x: 0.4, y: -0.4 }), null);
	assert.equal(readGamepadDir(null, { x: 0, y: 0 }), null);
	assert.equal(readGamepadDir(null, null), null, 'no signals at all: nothing');
});

t('readGamepadDir: a held stick gives __hold, and the return to centre resets it', () => {
	// Without the anti-repeat, a stick held off centre would spam the same
	// direction at every 80 ms poll.
	assert.equal(readGamepadDir('up', { x: 0, y: -1 }), '__hold');
	assert.equal(readGamepadDir('up', { x: 0, y: 0 }), null);
	assert.equal(readGamepadDir('up', { x: 0, y: 1 }), 'down', 'the other way is a new direction');
});

t('readGamepadDir: the D-pad still works exactly as before', () => {
	const dpad = (i) => Array.from({ length: 16 }, (_, k) => ({ pressed: k === i }));
	assert.equal(readGamepadDir(null, { x: 0, y: 0 }, dpad(12)), 'up');
	assert.equal(readGamepadDir(null, { x: 0, y: 0 }, dpad(13)), 'down');
	assert.equal(readGamepadDir(null, { x: 0, y: 0 }, dpad(14)), 'left');
	assert.equal(readGamepadDir(null, { x: 0, y: 0 }, dpad(15)), 'right');
	assert.equal(readGamepadDir('up', { x: 0, y: 0 }, dpad(12)), '__hold');
});

t('readGamepadDir: it calls no navigator — that is what makes it testable', () => {
	// The proof rather than the claim: with the enumeration throwing, the function
	// still answers.
	const saved = navigator.getGamepads;
	navigator.getGamepads = () => { throw new Error('readGamepadDir touched the navigator'); };
	try {
		assert.equal(readGamepadDir(null, { x: 1, y: 0 }), 'right');
	} finally {
		navigator.getGamepads = saved;
	}
});

// --- isTextEntry ------------------------------------------------------------

t('isTextEntryKind: the fields you type into keep their keys', () => {
	// The scanner's search (type=search), the operator name (type=text) and the
	// post-flight note (textarea) must stay editable (issue #123).
	assert.equal(isTextEntryKind('INPUT', 'search'), true);
	assert.equal(isTextEntryKind('INPUT', 'text'), true);
	assert.equal(isTextEntryKind('TEXTAREA', 'textarea'), true);
});

t('isTextEntryKind: a slider, a checkbox and a button are not text entry', () => {
	// A focused range must be adjustable with left/right in Settings, not
	// swallow the whole navigation.
	assert.equal(isTextEntryKind('INPUT', 'range'), false);
	assert.equal(isTextEntryKind('INPUT', 'checkbox'), false);
	assert.equal(isTextEntryKind('BUTTON', 'button'), false);
	assert.equal(isTextEntryKind('SELECT', 'select-one'), false);
});

t('isTextEntry: no target -> false', () => {
	assert.equal(isTextEntry(null), false);
	assert.equal(isTextEntry(undefined), false);
});

// --- the stack's lifecycle (issue #210) --------------------------------------

// These need a DOM: they are mounted after the pure tests so that those stay
// readable without a harness.
const { installFakeDom } = await import('./lib/fake-dom.mjs');
const dom = installFakeDom();
const { menuNav, setMenuInput } = await import('../src/menu-nav.js');

// The polls are counted by intercepting setInterval/clearInterval rather than
// by asking process._getActiveHandles(): that one no longer reports timers on
// Node 26, and the test "passed" by measuring zero everywhere.
const live = new Set();
const realSet = globalThis.setInterval;
const realClear = globalThis.clearInterval;
globalThis.setInterval = (...a) => { const id = realSet(...a); live.add(id); return id; };
globalThis.clearInterval = (id) => { live.delete(id); return realClear(id); };
const timers = () => live.size;

const ta = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await ta('a screen REMOVED from the DOM without detach() keeps no poll', async () => {
	// The #210 case: the screen is replaced (reset / replaceChildren) instead of
	// being closed. Nobody calls detach(), and the setInterval used to survive —
	// enough to block a whole selftest run.
	const before = timers();
	const el = document.createElement('div');
	dom.root.appendChild(el);
	el.appendChild(document.createElement('button'));
	menuNav(el);
	assert.equal(timers(), before + 1, 'the poll is open at mount');

	dom.root.replaceChildren();          // the screen leaves without unsubscribing
	await sleep(200);                    // the poll collects itself
	assert.equal(timers(), before, 'no poll left behind a dead screen');
});

await ta('a screen only HIDDEN keeps its poll (the list under its record)', async () => {
	// The distinction that makes #210 non-trivial: target-scan.js hides its list
	// behind the record (display:none) and takes it back on the way out. Hidden
	// is not dead — confusing it with a removal would cut navigation at BACK.
	const before = timers();
	const el = document.createElement('div');
	dom.root.appendChild(el);
	el.appendChild(document.createElement('button'));
	const nav = menuNav(el);
	el.style.display = 'none';
	await sleep(200);
	assert.equal(timers(), before + 1, 'the hidden list is still subscribed');
	nav.detach();
	assert.equal(timers(), before, 'and detach() releases it normally');
	dom.root.replaceChildren();
});

// --- the cursor lost to a click ----------------------------------------------

await ta('the cursor comes back where it was when a click lands beside it', async () => {
	// The cursor IS native focus: a click on the screen's background makes it
	// disappear, and Enter activates nothing any more. It took an arrow (which
	// restarted from the top) or Escape to leave the screen and come back.
	const el = document.createElement('div');
	dom.root.appendChild(el);
	const a = document.createElement('button');
	const b = document.createElement('button');
	el.append(a, b);
	const nav = menuNav(el);
	b.focus();

	b.blur();                                   // the click lands on the scenery
	assert.equal(document.activeElement, null, 'the focus really is lost');
	el.dispatchEvent({ type: 'focusout', target: b });
	await sleep(0);

	assert.equal(document.activeElement, b, 'the cursor is put back where it was');
	nav.detach();
	dom.root.replaceChildren();
});

await ta('a click alone puts the cursor back, without a focusout to help', async () => {
	// Chrome moves the focus once, on mousedown, so focusout is enough there.
	// Firefox blurs on mousedown AND settles the focus again when the click
	// completes — the deferred restore landed between the two and the click
	// undid it. This is the trigger that holds in that order: nothing but the
	// click, and the cursor still comes back.
	const el = document.createElement('div');
	dom.root.appendChild(el);
	const a = document.createElement('button');
	const b = document.createElement('button');
	el.append(a, b);
	const nav = menuNav(el);
	b.focus();
	// focusin is what remembers the cursor: the click carries no memory of it.
	el.dispatchEvent({ type: 'focusin', target: b });

	b.blur();
	el.dispatchEvent({ type: 'click', target: el, preventDefault() {} });
	await sleep(0);

	assert.equal(document.activeElement, b, 'the cursor is back on the same control');
	nav.detach();
	dom.root.replaceChildren();
});

await ta('leaving a text field does not send the cursor back into it', async () => {
	// Leaving a field is an intention, not an accident: the cursor restarts from
	// the first control rather than being forced back into the typing.
	const el = document.createElement('div');
	dom.root.appendChild(el);
	// The field FIRST, like FIELD's search: "go back to the top" would have been
	// enough to put it back, and the test would have proved nothing.
	const input = document.createElement('input');
	input.type = 'text';
	const btn = document.createElement('button');
	el.append(input, btn);
	const nav = menuNav(el);
	input.focus();

	input.blur();
	el.dispatchEvent({ type: 'focusout', target: input });
	await sleep(0);

	assert.equal(document.activeElement, btn, 'the cursor restarts from the first control');
	nav.detach();
	dom.root.replaceChildren();
});

// --- WHICH controller the menus obey, and WHICH signals they read ------------
//
// Both bugs lived in the poll: `navigator.getGamepads().find(Boolean)` (the first
// enumerated device, never the one the pilot chose in SETTINGS > CONTROLS) and
// `pad.axes[0..1]` (raw axes, which on a radio can be the throttle stick).
//
// The fix is an injection at module level — menuNav() is called from some thirty
// places with no Input to hand — and the rule that matters here is that NOTHING
// CHANGES until something is injected.

// A gamepad as the browser reports it.
const fakePad = (index, axes, buttons = 16) => ({
	index,
	id: `pad ${index}`,
	axes,
	buttons: Array.from({ length: buttons }, () => ({ pressed: false, value: 0 })),
});

// Only what menu-nav asks of an Input: which device is active, the two menu
// channels, and the two menu buttons.
const fakeInput = (gamepadIndex, axes, buttons = { confirm: false, back: false }) => ({
	gamepadIndex,
	menuAxes: () => axes,
	menuButtons: () => buttons,
});

function screen(count = 3) {
	const el = document.createElement('div');
	dom.root.appendChild(el);
	const buttons = [];
	for (let i = 0; i < count; i++) {
		const b = document.createElement('button');
		b.dataset.i = String(i);
		el.appendChild(b);
		buttons.push(b);
	}
	return { el, buttons };
}

const pollOnce = () => sleep(PAD_POLL_WAIT);
const PAD_POLL_WAIT = 160;   // two 80 ms polls, so one direction always lands

await ta('with nothing injected, the behaviour is EXACTLY the one before: pad 0, axes 0/1', async () => {
	// The compatibility rule: the selftests, and the intro gate which has its own
	// probe, must not change because this injection exists.
	navigator.getGamepads = () => [fakePad(0, [0, 1, 0, 0])];   // axis 1 pushed down
	const { el, buttons } = screen();
	const nav = menuNav(el);
	assert.equal(document.activeElement, buttons[0]);
	await pollOnce();
	assert.equal(document.activeElement, buttons[1], 'the raw axes still drive the cursor');
	nav.detach();
	dom.root.replaceChildren();
});

await ta('injected, the menus obey the ACTIVE device, not the first enumerated one', async () => {
	// A radio AND a gamepad plugged in: pad 0 has its throttle stick parked at one
	// end (axis 1 = -1 for ever), pad 1 is the one the pilot selected. Reading pad 0
	// raw would send the cursor up and never let it come back.
	navigator.getGamepads = () => [fakePad(0, [0, -1, 0, 0]), fakePad(1, [0, 0, 0, 0])];
	setMenuInput(fakeInput(1, { x: 0, y: 1 }));       // pitch pulled back on pad 1
	const { el, buttons } = screen();
	const nav = menuNav(el);
	await pollOnce();
	assert.equal(document.activeElement, buttons[1], 'down, as the ACTIVE device says');
	nav.detach();
	setMenuInput(null);
	dom.root.replaceChildren();
});

await ta('injected, a stick parked off centre does not run the cursor away', async () => {
	// The radio case in one assertion: the throttle is at one end of its travel for
	// the whole session, and the menu reads roll/pitch, which are at rest.
	navigator.getGamepads = () => [fakePad(0, [0, -1, 1, 0])];
	setMenuInput(fakeInput(0, { x: 0, y: 0 }));
	const { el, buttons } = screen();
	const nav = menuNav(el);
	await sleep(300);
	assert.equal(document.activeElement, buttons[0], 'the cursor has not moved at all');
	nav.detach();
	setMenuInput(null);
	dom.root.replaceChildren();
});

await ta('the measured confirm / back are used, on a rising edge', async () => {
	// On a radio, buttons 0 and 1 are switch POSITIONS: the wizard measures the two
	// gestures instead, and Input hands back their state.
	navigator.getGamepads = () => [fakePad(0, [0, 0, 0, 0])];
	const state = { confirm: false, back: false };
	setMenuInput(fakeInput(0, { x: 0, y: 0 }, state));
	const { el, buttons } = screen();
	let backs = 0;
	let clicks = 0;
	buttons[0].addEventListener('click', () => { clicks++; });
	const nav = menuNav(el, { back: () => { backs++; } });

	// One poll at rest first: the initial state is "held", so nothing fires until
	// the gesture has been seen released (see the next test).
	await pollOnce();
	state.confirm = true;
	await pollOnce();
	assert.equal(clicks, 1, 'the measured confirm presses the focused control');
	await pollOnce();
	assert.equal(clicks, 1, 'and a held gesture does not repeat');

	state.confirm = false;
	state.back = true;
	await pollOnce();
	assert.equal(backs, 1, 'and the measured back goes back up');

	nav.detach();
	setMenuInput(null);
	dom.root.replaceChildren();
});

await ta('a gesture already held at mount does not cross into the new screen', async () => {
	// The initial state is "held": the switch that validated the previous screen
	// must not validate this one on the first poll.
	navigator.getGamepads = () => [fakePad(0, [0, 0, 0, 0])];
	setMenuInput(fakeInput(0, { x: 0, y: 0 }, { confirm: true, back: false }));
	const { el, buttons } = screen();
	let clicks = 0;
	buttons[0].addEventListener('click', () => { clicks++; });
	const nav = menuNav(el);
	await pollOnce();
	assert.equal(clicks, 0, 'a gesture held since before the screen fires nothing');
	nav.detach();
	setMenuInput(null);
	dom.root.replaceChildren();
});

await ta('with no measurement, confirm / back fall back to buttons 0 and 1', async () => {
	// A standard pad needs no measurement: its buttons 0 and 1 are momentary. With
	// nothing injected, menu-nav reads them straight off the pad, as it always did.
	const pad = fakePad(0, [0, 0, 0, 0]);
	navigator.getGamepads = () => [pad];
	const { el, buttons } = screen();
	let clicks = 0;
	buttons[0].addEventListener('click', () => { clicks++; });
	let backs = 0;
	const nav = menuNav(el, { back: () => { backs++; } });

	await pollOnce();               // the released state seen once, as above
	pad.buttons[0].pressed = true;
	await pollOnce();
	assert.equal(clicks, 1, 'button 0 activates');
	pad.buttons[0].pressed = false;
	pad.buttons[1].pressed = true;
	await pollOnce();
	assert.equal(backs, 1, 'button 1 goes back up');

	nav.detach();
	dom.root.replaceChildren();
});

await ta('gamepad: false stays inert — the settings panel opened IN FLIGHT', async () => {
	// A deliberate exception: there the sticks fly the drone, and every gesture
	// would move the cursor and the sliders.
	navigator.getGamepads = () => [fakePad(0, [1, 1, 0, 0])];
	setMenuInput(fakeInput(0, { x: 1, y: 1 }, { confirm: true, back: true }));
	const before = timers();
	const { el, buttons } = screen();
	let backs = 0;
	let clicks = 0;
	buttons[0].addEventListener('click', () => { clicks++; });
	const nav = menuNav(el, { back: () => { backs++; }, gamepad: false });
	assert.equal(timers(), before, 'no poll is even opened');
	await sleep(300);
	assert.equal(document.activeElement, buttons[0], 'the cursor has not moved');
	assert.equal(clicks, 0);
	assert.equal(backs, 0);
	nav.detach();
	setMenuInput(null);
	dom.root.replaceChildren();
	navigator.getGamepads = () => [];
});

globalThis.setInterval = realSet;
globalThis.clearInterval = realClear;
dom.restore();

console.log(`menu-nav-selftest: ${n} tests ok`);

// Selftest of src/menu-nav.js (issue #123). Most of it is pure logic with no
// I/O. The end of the file also covers the LIFECYCLE of the nav stack on the
// fake DOM (issue #210): that is where a screen removed without detach() left
// an 80 ms gamepad poll behind it.
// Run: node tools/menu-nav-selftest.mjs
import assert from 'node:assert/strict';
import { nextIndex, stepValue, isTextEntry, isTextEntryKind } from '../src/menu-nav.js';

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
const { menuNav } = await import('../src/menu-nav.js');

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

globalThis.setInterval = realSet;
globalThis.clearInterval = realClear;
dom.restore();

console.log(`menu-nav-selftest: ${n} tests ok`);

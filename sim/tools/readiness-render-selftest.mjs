// node tools/readiness-render-selftest.mjs — the RECOMMENDED screen, on the
// fake DOM of tools/lib/fake-dom.mjs.
//
// Same intention as briefing-render-selftest.mjs: what is checked is the TREE
// and the WIRING — which pictograms are lit, the two lines of text, what the two
// buttons do, that the all-clear readout takes itself away, that a live gamepad
// lights its pictogram — never the look, which is judged by eye.
import assert from 'node:assert/strict';
import { installFakeDom } from './lib/fake-dom.mjs';

const dom = installFakeDom({ raf: true });

// Live interval count. menu-nav.js polls the gamepad every 80 ms, and this
// screen runs a poll of its own; both are cleared on the way out. A nav or a
// probe attached to a screen that was already removed can never be reaped, so a
// leak shows up here as a timer nobody ever clears. Wrapped on the globals
// rather than on the fake DOM: this is Node's timer, not the browser's.
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const timers = new Set();
globalThis.setInterval = (fn, ms) => {
	const id = realSetInterval(fn, ms);
	timers.add(id);
	return id;
};
globalThis.clearInterval = (id) => { timers.delete(id); realClearInterval(id); };
const liveTimers = () => timers.size;

const { runReadiness } = await import('../src/readiness.js');
const { READINESS_SEEN_KEY } = await import('./readiness-model.mjs');

let n = 0;
const ta = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); };

console.log('readiness render');

// The screen mounts in one go, but the reveal watcher and the close() animation
// are macrotasks: a test lets the loop breathe before it looks.
const settle = async (turns = 80) => {
	for (let i = 0; i < turns; i++) await new Promise((r) => setTimeout(r, 0));
};

const UA_CHROME = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const UA_FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0';

const pad = (id, pressed = []) => ({
	id, index: 0, axes: [0, 0, 0, 0],
	buttons: Array.from({ length: 4 }, (_, i) => ({ pressed: !!pressed[i] })),
});

// A navigator stand-in whose gamepad list can change mid-screen — the whole
// point of the live probe.
function fakeNav(ua, pads = []) {
	const state = { pads };
	return {
		nav: { userAgent: ua, userAgentData: null, getGamepads: () => state.pads },
		plug: (p) => { state.pads = [p]; },
	};
}

function store({ broken = false } = {}) {
	const m = new Map();
	return {
		getItem: (k) => { if (broken) throw new Error('denied'); return m.has(k) ? m.get(k) : null; },
		setItem: (k, v) => { if (broken) throw new Error('denied'); m.set(k, String(v)); },
		has: (k) => m.has(k),
	};
}

function mount({ ua = UA_FIREFOX, pads = [], autoMs = 300, pollMs = 1, st = store() } = {}) {
	dom.root.replaceChildren();
	const root = document.createElement('div');
	root.id = 'ui';
	dom.root.appendChild(root);
	const { nav, plug } = fakeNav(ua, pads);
	let done = false;
	const promise = runReadiness(root, { nav, store: st, autoMs, pollMs })
		.then(() => { done = true; });
	return {
		root, promise, plug, store: st,
		isDone: () => done,
		screens: () => root.querySelectorAll('.readiness'),
		text: () => root.textContent,
		buttons: () => root.querySelectorAll('button'),
		btn: (label) => root.querySelectorAll('button').find((b) => b.textContent === `[ ${label} ]`),
		icons: () => root.querySelectorAll('.readiness-item').map((f) => f.dataset.icon),
		lit: () => root.querySelectorAll('[data-lit="true"]').map((f) => f.dataset.icon),
		hint: () => {
			const h = root.querySelector('.readiness-hint');
			return h && !h.hidden ? h.textContent : '';
		},
	};
}

await ta('nothing detected: three dim pictograms, one hint, two buttons', async () => {
	const m = mount();   // Firefox, nothing enumerated
	await settle();
	assert.equal(m.screens().length, 1, 'exactly one screen');
	assert.match(m.text(), /RECOMMENDED/);
	assert.deepEqual(m.icons(), ['radio', 'gamepad', 'chrome']);
	assert.match(m.text(), /FPV RADIO/);
	assert.match(m.text(), /DUALSHOCK/);
	assert.match(m.text(), /CHROME/);
	assert.ok(m.root.querySelector('.readiness-or'), 'an OR between radio and pad');
	assert.deepEqual(m.lit(), [], 'Firefox and no pad: everything dim');
	// Each pictogram is an inline SVG, so its colour comes from the page.
	for (const f of m.root.querySelectorAll('.readiness-item')) {
		assert.ok(f.querySelector('svg'), `${f.dataset.icon}: an svg`);
		assert.ok(f.querySelector('path').attributes.d.length > 0, `${f.dataset.icon}: a drawing`);
	}
	// The honest line, which is the reason the screen exists — and the only one.
	assert.equal(m.hint(), 'MOVE A STICK TO DETECT IT');
	assert.doesNotMatch(m.text(), /\/\/ [a-z]+:/, 'no crew remarks');
	assert.doesNotMatch(m.text(), /\.\.\.\./, 'no dotted rows');
	assert.ok(m.btn('CONTINUE'), 'a CONTINUE button');
	assert.ok(m.btn("DON'T SHOW AGAIN"), "a DON'T SHOW AGAIN button");
	assert.equal(m.buttons().length, 2, 'and no third answer');
	// It waits: nothing dismisses a screen that has something to say.
	await settle(20);
	assert.equal(m.isDone(), false);
	assert.equal(m.screens().length, 1);
	m.btn('CONTINUE').click();
	await m.promise;
});

await ta('Chromium and no pad: CHROME lit, the pad dim, still waiting', async () => {
	const m = mount({ ua: UA_CHROME });
	await settle();
	assert.deepEqual(m.lit(), ['chrome']);
	assert.equal(m.hint(), 'MOVE A STICK TO DETECT IT');
	assert.equal(m.buttons().length, 2);
	m.btn('CONTINUE').click();
	await m.promise;
});

await ta('CONTINUE unmounts and writes nothing', async () => {
	const m = mount();
	await settle();
	m.btn('CONTINUE').click();
	await m.promise;
	assert.equal(m.screens().length, 0, 'nothing is left mounted');
	assert.equal(m.isDone(), true);
	assert.equal(m.store.has(READINESS_SEEN_KEY), false, 'CONTINUE is not a dismissal');
});

await ta("DON'T SHOW AGAIN writes the key", async () => {
	const m = mount();
	await settle();
	m.btn("DON'T SHOW AGAIN").click();
	await m.promise;
	assert.equal(m.screens().length, 0);
	assert.equal(m.store.getItem(READINESS_SEEN_KEY), '1');
});

await ta('a store that throws does not stop the screen from closing', async () => {
	const m = mount({ st: store({ broken: true }) });
	await settle();
	m.btn("DON'T SHOW AGAIN").click();
	await m.promise;
	assert.equal(m.screens().length, 0);
	assert.equal(m.isDone(), true);
});

await ta('an all-clear setup: pad and CHROME lit, no text, no button, gone on its own', async () => {
	const m = mount({ ua: UA_CHROME, pads: [pad('Xbox Wireless Controller')], autoMs: 300 });
	await settle();
	assert.equal(m.screens().length, 1);
	assert.deepEqual(m.lit(), ['gamepad', 'chrome']);
	assert.equal(m.hint(), '', 'nothing to say');
	assert.equal(m.buttons().length, 0, 'a readout asks nothing');
	await m.promise;
	assert.equal(m.screens().length, 0, 'it unmounted on its own');
	assert.equal(m.isDone(), true);
});

await ta('a keyboard receiver enumerated first does not hide the radio (Chrome, 2026-09-27)', async () => {
	// Chrome on Linux: js0 is a Keychron Link receiver (a joystick interface, 6
	// axes, 16 buttons), js1 the RadioMaster Pocket. Reading the first pad lit
	// DUALSHOCK and said UNKNOWN DEVICE; Firefox showed the radio alone.
	const keychron = { ...pad('Keychron  Keychron Link  (Vendor: 3434 Product: d030)'), index: 0 };
	const pocket = { ...pad('EdgeTX Radiomaster Pocket Joystick (Vendor: 1209 Product: 4f54)'), index: 1 };
	const m = mount({ ua: UA_CHROME, pads: [keychron, pocket], autoMs: 60_000 });
	await settle();
	assert.deepEqual(m.lit(), ['radio', 'chrome']);
	assert.doesNotMatch(m.text(), /UNKNOWN DEVICE/);
	dom.key('Escape');
	await m.promise;
});

await ta('a key clears the all-clear readout before its delay is up', async () => {
	// autoMs long enough that only the keypress can be what closed it.
	const m = mount({ ua: UA_CHROME, pads: [pad('FrSky Taranis X9D')], autoMs: 60_000 });
	await settle();
	assert.equal(m.screens().length, 1);
	assert.deepEqual(m.lit(), ['radio', 'chrome'], 'a radio lights the radio, not the pad');
	assert.equal(m.isDone(), false);
	dom.key('Escape');
	await m.promise;
	assert.equal(m.screens().length, 0);
	assert.equal(m.isDone(), true);
	// The listener left with the screen: a later key mounts nothing back.
	dom.key('a');
	await settle(10);
	assert.equal(m.screens().length, 0);
});

await ta('a gamepad button clears it too', async () => {
	const p = pad('Xbox Wireless Controller');
	const m = mount({ ua: UA_CHROME, pads: [p], autoMs: 60_000, pollMs: 1 });
	await settle();
	assert.equal(m.isDone(), false);
	p.buttons[1].pressed = true;   // A press is not an event: it is polled.
	await m.promise;
	assert.equal(m.screens().length, 0);
});

await ta('an unrecognised device lights the pad but waits, with CALIBRATE named', async () => {
	// A device IS there — but its mapping is a guess, and the one line that
	// says where that is settled has to be readable. So the screen waits on
	// CONTINUE instead of taking itself away.
	const m = mount({ ua: UA_CHROME, pads: [pad('Unknown HID 0f0d:00c1')], autoMs: 300 });
	await settle();
	assert.deepEqual(m.lit(), ['gamepad', 'chrome']);
	assert.equal(m.hint(), 'UNKNOWN DEVICE · SETTINGS > CONTROLLER > CALIBRATE');
	assert.doesNotMatch(m.text(), /MOVE A STICK/);
	assert.equal(m.buttons().length, 2);
	m.buttons()[0].click();
	await m.promise;
	assert.equal(m.screens().length, 0);
});

await ta('a pad that appears WHILE the screen is up lights and the hint goes', async () => {
	// The false negative the screen is built around: the browser reveals a
	// device only after an input on it, so the dim pad has to be able to light.
	const m = mount({ ua: UA_CHROME, pads: [], autoMs: 60_000, pollMs: 1 });
	await settle();
	assert.deepEqual(m.lit(), ['chrome']);
	assert.equal(m.hint(), 'MOVE A STICK TO DETECT IT');
	assert.equal(m.buttons().length, 2, 'it was waiting');
	m.plug(pad('FrSky Taranis X9D'));
	await new Promise((r) => setTimeout(r, 10));
	await settle(20);
	assert.deepEqual(m.lit(), ['radio', 'chrome'], 'the radio lit');
	assert.equal(m.hint(), '', 'MOVE A STICK went away');
	assert.doesNotMatch(m.text(), /MOVE A STICK/);
	// Nothing left to answer: the buttons go, and the readout behaves like any
	// all-clear one — a key takes it away before its delay.
	assert.equal(m.buttons().length, 0);
	assert.equal(m.isDone(), false);
	dom.key('a');
	await m.promise;
	assert.equal(m.screens().length, 0);
});

await ta('a live all-clear still takes itself away after its delay', async () => {
	const m = mount({ ua: UA_CHROME, pads: [], autoMs: 300, pollMs: 1 });
	await settle();
	m.plug(pad('Xbox Wireless Controller'));
	await m.promise;
	assert.equal(m.screens().length, 0);
	assert.equal(m.isDone(), true);
});

await ta('a pad appearing on a warned BROWSER leaves the buttons in place', async () => {
	// Firefox is still Firefox: one pictogram lighting does not make the screen
	// an all-clear readout.
	const m = mount({ ua: UA_FIREFOX, pads: [], autoMs: 300, pollMs: 1 });
	await settle();
	m.plug(pad('Xbox Wireless Controller'));
	await new Promise((r) => setTimeout(r, 10));
	await settle(20);
	assert.deepEqual(m.lit(), ['gamepad']);
	assert.equal(m.hint(), '');
	assert.equal(m.buttons().length, 2, 'it still waits on an answer');
	assert.equal(m.isDone(), false);
	m.btn('CONTINUE').click();
	await m.promise;
});

// Every run detaches its nav and clears its probe; anything left here would keep
// Node alive on its own, so the count is asserted rather than merely cleaned up.
await ta('no readiness run left a timer behind', async () => {
	await settle();
	assert.equal(liveTimers(), 0);
});

console.log(`\n${n} checks passed`);
globalThis.setInterval = realSetInterval;
globalThis.clearInterval = realClearInterval;
dom.restore();

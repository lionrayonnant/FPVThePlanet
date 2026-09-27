// node tools/readiness-render-selftest.mjs — the RECOMMENDED SETUP screen, on
// the fake DOM of tools/lib/fake-dom.mjs.
//
// Same intention as briefing-render-selftest.mjs: what is checked is the TREE
// and the WIRING — what is mounted, what the two buttons do, that the all-clear
// readout takes itself away, that a live gamepad rewrites the INPUT row — never
// the look, which is judged by eye.
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

// The reveal is a chain of awaited timeouts, one per line. At interval 0 they
// are still macrotasks, so a test has to let the loop breathe before it looks.
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
	const promise = runReadiness(root, { nav, store: st, interval: 0, autoMs, pollMs })
		.then(() => { done = true; });
	return {
		root, promise, plug, store: st,
		isDone: () => done,
		screens: () => root.querySelectorAll('.readiness'),
		text: () => root.textContent,
		buttons: () => root.querySelectorAll('button'),
		btn: (label) => root.querySelectorAll('button').find((b) => b.textContent === `[ ${label} ]`),
	};
}

await ta('a warned setup mounts one screen, its two rows and its two buttons', async () => {
	const m = mount();   // Firefox, nothing enumerated
	await settle();
	assert.equal(m.screens().length, 1, 'exactly one screen');
	assert.match(m.text(), /RECOMMENDED SETUP/);
	assert.match(m.text(), /BROWSER/);
	assert.match(m.text(), /FIREFOX/);
	assert.match(m.text(), /NOT DETECTED YET/);
	// The honest line, which is the reason the screen exists.
	assert.match(m.text(), /MOVE A STICK/);
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

await ta('an all-clear setup gets no button and takes itself away', async () => {
	const m = mount({ ua: UA_CHROME, pads: [pad('Xbox Wireless Controller')], autoMs: 300 });
	await settle();
	assert.equal(m.screens().length, 1);
	assert.match(m.text(), /XBOX/);
	assert.equal(m.buttons().length, 0, 'a readout asks nothing');
	await m.promise;
	assert.equal(m.screens().length, 0, 'it unmounted on its own');
	assert.equal(m.isDone(), true);
});

await ta('a key clears the all-clear readout before its delay is up', async () => {
	// autoMs long enough that only the keypress can be what closed it.
	const m = mount({ ua: UA_CHROME, pads: [pad('FrSky Taranis X9D')], autoMs: 60_000 });
	await settle();
	assert.equal(m.screens().length, 1);
	assert.match(m.text(), /RADIO/);
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

await ta('an unrecognised device waits, with CALIBRATE named', async () => {
	// A device IS there, so nothing is recommended — but its mapping is a guess,
	// and the one line that says where that is settled has to be readable. So
	// the screen waits on CONTINUE instead of taking itself away.
	const m = mount({ ua: UA_CHROME, pads: [pad('Unknown HID 0f0d:00c1')], autoMs: 300 });
	await settle();
	assert.match(m.text(), /UNRECOGNISED/);
	assert.match(m.text(), /CALIBRATE/);
	assert.doesNotMatch(m.text(), /DUALSHOCK/, 'no shopping list for someone holding a pad');
	assert.equal(m.buttons().length, 2);
	m.buttons()[0].click();
	await m.promise;
	assert.equal(m.screens().length, 0);
});

await ta('a pad that appears WHILE the screen is up rewrites the INPUT row', async () => {
	// The false negative the screen is built around: the browser reveals a
	// device only after an input on it, so the warning has to be able to
	// withdraw itself.
	const m = mount({ ua: UA_CHROME, pads: [], autoMs: 300, pollMs: 1 });
	await settle();
	assert.match(m.text(), /NOT DETECTED YET/);
	assert.equal(m.buttons().length, 2, 'it was waiting');
	m.plug(pad('FrSky Taranis X9D'));
	// One poll tick, then the reveal's own settling.
	await new Promise((r) => setTimeout(r, 10));
	await settle(20);
	assert.doesNotMatch(m.text(), /NOT DETECTED YET/, 'the warning withdrew itself');
	assert.match(m.text(), /FRSKY TARANIS X9D/);
	assert.match(m.text(), /RADIO/);
	// Nothing left to answer: the buttons go and the readout takes itself away.
	await m.promise;
	assert.equal(m.screens().length, 0);
	assert.equal(m.isDone(), true);
});

await ta('a pad appearing on a warned BROWSER leaves the buttons in place', async () => {
	// Firefox is still Firefox: one verdict withdrawing does not make the screen
	// an all-clear readout.
	const m = mount({ ua: UA_FIREFOX, pads: [], autoMs: 300, pollMs: 1 });
	await settle();
	m.plug(pad('Xbox Wireless Controller'));
	await new Promise((r) => setTimeout(r, 10));
	await settle(20);
	assert.match(m.text(), /XBOX/);
	assert.match(m.text(), /CHROMIUM/);
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

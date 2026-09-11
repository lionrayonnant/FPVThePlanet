// node tools/briefing-render-selftest.mjs — the briefing screens (D16), on the
// fake DOM of tools/lib/fake-dom.mjs.
//
// Same intention as terminal-render-selftest.mjs: what is checked is the TREE
// and the WIRING — which screen is mounted, what its buttons do, what Escape
// does — never the look, which is judged by eye.
import assert from 'node:assert/strict';
import { installFakeDom } from './lib/fake-dom.mjs';

const dom = installFakeDom({ raf: true });

// Live interval count. menu-nav.js polls the gamepad every 80 ms and clears it
// on detach(); a nav attached to a screen that was already removed can never be
// reaped, so a leak shows up here as a timer nobody ever clears. Wrapped on the
// globals rather than on the fake DOM: this is Node's timer, not the browser's.
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

const { runBriefing } = await import('../src/briefing.js');
const { DEFAULT_KEY_MAP, keyMapRows } = await import('../src/key-map.js');

let n = 0;
const ta = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); };

console.log('briefing render');

// The reveal is a chain of awaited timeouts, one per line. At interval 0 they
// are still macrotasks, so a test has to let the loop breathe before it looks.
const settle = async (turns = 80) => {
	for (let i = 0; i < turns; i++) await new Promise((r) => setTimeout(r, 0));
};

const keyRows = keyMapRows(DEFAULT_KEY_MAP);

function mount({ kind = 'keyboard', name = '', interval = 0, settingsOpen = false } = {}) {
	dom.root.replaceChildren();
	const root = document.createElement('div');
	root.id = 'ui';
	dom.root.appendChild(root);
	const opened = [];
	let done = false;
	const promise = runBriefing(root, {
		input: { kind, name },
		keyRows,
		openSettings: async (tab) => { opened.push(tab); },
		isSettingsOpen: () => settingsOpen,
		interval,
	}).then(() => { done = true; });
	return {
		root, opened, promise,
		isDone: () => done,
		screens: () => root.querySelectorAll('.briefing'),
		text: () => root.textContent,
		btn: (label) => root.querySelectorAll('button').find((b) => b.textContent === `[ ${label} ]`),
		hints: () => root.querySelectorAll('.terminal-keys'),
	};
}

await ta('the first screen is INPUT, with CONTINUE and the ESC hint', async () => {
	const m = mount();
	await settle();
	assert.equal(m.screens().length, 1, 'exactly one briefing screen at a time');
	assert.match(m.text(), /INPUT/);
	assert.ok(m.btn('CONTINUE'), 'a CONTINUE button');
	assert.equal(m.hints().length, 1);
	assert.equal(m.hints()[0].textContent, '[ESC] SKIP BRIEFING');
	assert.equal(m.isDone(), false);
	dom.key('Escape');
	await settle(10);
});

await ta('a keyboard gets MAP KEYS and its live key map', async () => {
	const m = mount({ kind: 'keyboard' });
	await settle();
	assert.match(m.text(), /THROTTLE UP/);
	assert.ok(m.btn('MAP KEYS'));
	assert.equal(m.btn('CALIBRATE'), undefined);
	m.btn('MAP KEYS').click();
	await settle(10);
	assert.deepEqual(m.opened, ['keyboard']);
	// The briefing is still there behind the panel it opened.
	assert.equal(m.screens().length, 1);
	assert.equal(m.isDone(), false);
	dom.key('Escape');
	await settle(10);
});

await ta('a pad gets CALIBRATE and the CONTROLLER tab', async () => {
	const m = mount({ kind: 'gamepad', name: 'Xbox Wireless Controller' });
	await settle();
	assert.match(m.text(), /GAMEPAD XBOX WIRELESS CONTROLLER/);
	assert.ok(m.btn('CALIBRATE'));
	assert.equal(m.btn('MAP KEYS'), undefined);
	m.btn('CALIBRATE').click();
	await settle(10);
	assert.deepEqual(m.opened, ['controller']);
	dom.key('Escape');
	await settle(10);
});

await ta('CONTINUE walks the four screens, then resolves and unmounts', async () => {
	const m = mount();
	const titles = [];
	for (let i = 0; i < 4; i++) {
		await settle();
		titles.push(m.screens()[0]?.textContent ?? '');
		m.btn('CONTINUE').click();
		await settle(10);
	}
	await m.promise;
	assert.match(titles[0], /INPUT/);
	assert.match(titles[1], /THE TERMINAL/);
	assert.match(titles[2], /A SESSION/);
	assert.match(titles[3], /BRIEFING COMPLETE/);
	assert.match(titles[1], /BACK, EVERYWHERE/);
	assert.match(titles[2], /CUT THE LINK/);
	assert.equal(m.screens().length, 0, 'nothing is left mounted');
	assert.equal(m.isDone(), true);
});

await ta('Escape skips the whole briefing, from any screen', async () => {
	const m = mount();
	await settle();
	m.btn('CONTINUE').click();
	await settle();
	assert.match(m.screens()[0].textContent, /THE TERMINAL/);
	dom.key('Escape');
	await m.promise;
	assert.equal(m.screens().length, 0);
	assert.equal(m.isDone(), true);
	// The listener is gone with the screen: a later Escape brings nothing back
	// and mounts nothing new.
	dom.key('Escape');
	await settle(10);
	assert.equal(m.screens().length, 0);
});

await ta('Escape DURING the reveal leaves no screen and no live nav', async () => {
	// The race the fix is about: the skip resolves while revealLines() is still
	// printing. Whatever finishes second must not build buttons, and must not
	// attach a nav — a window listener and an 80 ms poll — to a container that
	// has already been removed, which nothing can ever reap.
	const before = liveTimers();
	const m = mount({ interval: 6 });
	await new Promise((r) => setTimeout(r, 1));
	assert.equal(m.screens().length, 1, 'still printing');
	dom.key('Escape');
	await m.promise;
	assert.equal(m.screens().length, 0);
	assert.equal(m.isDone(), true);
	// Let the abandoned reveal run to its end: it must build nothing.
	await settle();
	assert.equal(m.screens().length, 0, 'nothing was mounted after the skip');
	assert.equal(m.root.querySelectorAll('button').length, 0, 'no button was built');
	assert.equal(liveTimers(), before, 'no nav left polling');
});

await ta('Escape belongs to the panel while it is open, not to the briefing', async () => {
	// F1: both listeners are on `window`, and menu-nav only preventDefaults —
	// so without the guard one Escape closes the panel the briefing opened AND
	// skips the briefing underneath it.
	const m = mount({ settingsOpen: true });
	await settle();
	assert.equal(m.screens().length, 1);
	dom.key('Escape');
	await settle(10);
	assert.equal(m.isDone(), false, 'the briefing survives the panel closing');
	assert.equal(m.screens().length, 1, 'its screen is still mounted');
	// Cleanup: the panel is closed now, so Escape is the briefing's again.
	m.btn('CONTINUE').click();
	await settle();
	m.btn('CONTINUE').click();
	await settle();
	m.btn('CONTINUE').click();
	await settle();
	m.btn('CONTINUE').click();
	await m.promise;
});

await ta('a run with no openSettings still walks through', async () => {
	dom.root.replaceChildren();
	const root = document.createElement('div');
	dom.root.appendChild(root);
	const p = runBriefing(root, { input: { kind: 'keyboard' }, keyRows, interval: 0 });
	await settle();
	root.querySelectorAll('button').find((b) => b.textContent === '[ MAP KEYS ]').click();
	await settle(10);
	assert.equal(root.querySelectorAll('.briefing').length, 1);
	dom.key('Escape');
	await p;
	assert.equal(root.querySelectorAll('.briefing').length, 0);
});

// Every walked-through run detaches its nav; anything left here would keep Node
// alive on its own, so the count is asserted rather than merely cleaned up.
await ta('no briefing run left a timer behind', async () => {
	await settle();
	assert.equal(liveTimers(), 0);
});

console.log(`\n${n} checks passed`);
globalThis.setInterval = realSetInterval;
globalThis.clearInterval = realClearInterval;
dom.restore();

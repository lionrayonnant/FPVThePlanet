// node tools/tour-render-selftest.mjs — the tour layer (#86), on the fake DOM
// of tools/lib/fake-dom.mjs.
//
// Same intention as briefing-render-selftest.mjs, which it replaces: what is
// checked is the TREE and the WIRING — what the card says where, what marks a
// stop read, what ends the layer and what it leaves behind — never the look,
// which is judged by eye.
import assert from 'node:assert/strict';
import { installFakeDom } from './lib/fake-dom.mjs';

const dom = installFakeDom();

// Live interval count. The tour polls the DOM and clears the poll on end(); a
// layer that was removed without ending would leave a timer nobody can ever
// reap, and that shows up here.
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const timers = new Set();
globalThis.setInterval = (fn, ms) => { const id = realSetInterval(fn, ms); timers.add(id); return id; };
globalThis.clearInterval = (id) => { timers.delete(id); realClearInterval(id); };
const liveTimers = () => timers.size;

const { runTour } = await import('../src/tour.js');
const { TOUR_SEEN_KEY, TOUR_STOPS_KEY, REQUIRED_STOPS } = await import('./tour-model.mjs');
const { DEFAULT_KEY_MAP, keyMapRows } = await import('../src/key-map.js');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

console.log('tour render');

const keyRows = keyMapRows(DEFAULT_KEY_MAP);

// The screens the tour walks, reduced to what it looks for: a class, and the
// element it points at inside it. Nothing else of those screens matters here.
const SCREENS = {
	root: ['bench-modes', 'bench-mode-list'],
	field: ['terminal-field', 'terminal-tabs'],
	scan: ['terminal-scan', 'terminal-list'],
	bench: ['bench-config', 'bench-creed'],
	data: ['terminal-data', 'data-page'],
};

function mount({ seen = null, toured = false, input = { kind: 'keyboard' }, restart = false } = {}) {
	dom.root.replaceChildren();
	dom.localStorage.clear();
	if (seen) dom.localStorage.setItem(TOUR_STOPS_KEY, seen.join(','));
	if (toured) dom.localStorage.setItem(TOUR_SEEN_KEY, '1');
	const ui = document.createElement('div');
	ui.id = 'ui';
	dom.root.appendChild(ui);

	// The Settings panel is built once and hidden, exactly as settings.js does:
	// it is always in the document, and only `hidden` says whether it is a place.
	const host = document.createElement('div');
	host.setAttribute('id', 'settings');
	host.hidden = true;
	const panel = document.createElement('div');
	panel.className = 'panel';
	const tabs = document.createElement('div');
	tabs.className = 'terminal-tabs';
	panel.appendChild(tabs);
	host.appendChild(panel);
	ui.appendChild(host);

	let clock = 0;
	let ended = 0;
	let flying = false;
	const tour = runTour(ui, {
		store: dom.localStorage, input, keyRows, restart,
		silent: () => flying,
		pollMs: 1e6, now: () => clock, onEnd: () => { ended++; },
	});

	let screen = null;
	const go = (place, { hold = 9000 } = {}) => {
		screen?.remove();
		screen = null;
		host.hidden = place !== 'settings';
		if (SCREENS[place]) {
			const [cls, child] = SCREENS[place];
			screen = document.createElement('div');
			screen.className = `bootstrap terminal ${cls}`;
			const inner = document.createElement('div');
			inner.className = child;
			screen.appendChild(inner);
			ui.appendChild(screen);
		}
		tour.tick();
		clock += hold;   // time spent standing there, before the next move
	};

	const card = () => ui.querySelector('.tour-card');
	return {
		ui, tour, go,
		fly: (on) => { flying = on; tour.tick(); },
		endCount: () => ended,
		layer: () => ui.querySelector('.tour'),
		hidden: () => ui.querySelector('.tour')?.hidden ?? true,
		title: () => card()?.querySelector('.tour-title')?.textContent ?? null,
		step: () => card()?.querySelector('.tour-step')?.textContent ?? null,
		lines: () => card()?.querySelector('.tour-lines')?.textContent ?? null,
		kind: () => card()?.dataset.kind ?? null,
		dismiss: () => ui.querySelectorAll('button').find((b) => b.textContent === '[ DISMISS ]'),
		stops: () => (dom.localStorage.getItem(TOUR_STOPS_KEY) ?? '').split(',').filter(Boolean),
		toured: () => dom.localStorage.getItem(TOUR_SEEN_KEY),
	};
}

t('the layer mounts once, over everything, and says nothing before a place', () => {
	const before = liveTimers();
	const m = mount();
	assert.equal(m.ui.querySelectorAll('.tour').length, 1);
	// Nowhere known yet: mounted, and silent.
	assert.equal(m.hidden(), true);
	assert.equal(liveTimers(), before + 1, 'one poll, and one only');
	m.tour.end();
	assert.equal(liveTimers(), before, 'the poll is reaped with the layer');
	assert.equal(m.layer(), null);
});

t('each place gives its own card, numbered against the four required stops', () => {
	const m = mount();
	m.go('root');
	assert.equal(m.hidden(), false);
	assert.equal(m.title(), 'THE ROOT');
	assert.equal(m.step(), 'TOUR 1/4');
	assert.equal(m.kind(), 'stop');
	m.go('field');
	assert.equal(m.title(), 'FIELD');
	assert.equal(m.step(), 'TOUR 2/4');
	assert.match(m.lines(), /\[ FLY \] IS THE ONLY THING THAT TAKES OFF\./);
	m.tour.end();
});

t('the Settings panel answers for the screen it covers', () => {
	const m = mount({ input: { kind: 'gamepad', name: 'EdgeTX' } });
	m.go('root');
	// The panel opens OVER the root: both are in the document, the panel wins.
	m.go('settings');
	assert.equal(m.title(), 'SETTINGS');
	assert.match(m.lines(), /EDGETX/);
	m.tour.end();
});

t('leaving a place is what marks its stop read', () => {
	const m = mount();
	m.go('root');
	assert.deepEqual(m.stops(), [], 'standing there marks nothing');
	m.go('field');
	assert.deepEqual(m.stops(), ['root'], 'left it, read it');
	m.go('root');
	// Read: the card stops being the stop and names what is left instead.
	assert.equal(m.kind(), 'wayTo');
	assert.equal(m.title(), 'NEXT · SETTINGS');
	m.tour.end();
});

t('a place crossed in half a second was not read', () => {
	const m = mount();
	m.go('field', { hold: 400 });
	m.go('root');
	assert.deepEqual(m.stops(), [], 'nothing was read in 400 ms');
	// And it is still the stop when the operator comes back.
	m.go('field');
	assert.equal(m.kind(), 'stop');
	m.tour.end();
});

t('an optional stop is said, and never holds the tour open', () => {
	const m = mount({ seen: ['root', 'settings', 'field'] });
	m.go('bench');
	assert.equal(m.title(), 'BENCH');
	assert.match(m.lines(), /WHAT HAPPENS HERE DOES NOT/);
	m.go('data');
	assert.equal(m.title(), 'DATA');
	assert.deepEqual(m.stops(), ['root', 'settings', 'field', 'bench']);
	m.tour.end();
});

t('nowhere known: the layer goes quiet rather than talking over a flight', () => {
	const m = mount({ seen: ['root', 'settings'] });
	m.go('field');
	assert.equal(m.hidden(), false);
	m.go('flight');   // no screen at all: a flight, a load, a hack
	assert.equal(m.hidden(), true);
	assert.equal(m.endCount(), 0, 'quiet, not over: FIELD was the third stop');
	m.tour.end();
});

t('the walk ends itself the moment the last stop is read, silently', () => {
	const m = mount({ seen: ['root', 'settings', 'field'] });
	m.go('scan');
	assert.equal(m.title(), 'TARGET SCAN');
	// The flight opens: the scan stop is read on the way out, the tour is done
	// and takes itself away without a word — the OSD hints take over.
	m.go('flight');
	assert.equal(m.endCount(), 1);
	assert.equal(m.layer(), null);
	assert.equal(m.toured(), '1');
	assert.deepEqual(m.stops(), REQUIRED_STOPS);
});

t('the last word is shown when the walk ends somewhere known, then goes', () => {
	const m = mount({ seen: ['root', 'settings', 'field'] });
	m.go('scan');
	m.go('root');            // back to the root, the four stops read
	assert.equal(m.kind(), 'done');
	assert.equal(m.title(), 'TOUR COMPLETE');
	assert.equal(m.endCount(), 0, 'it stays up long enough to be read');
	m.tour.tick();           // the clock has moved past the hold by now
	assert.equal(m.endCount(), 1);
	assert.equal(m.layer(), null);
});

t('[ DISMISS ] ends it for good', () => {
	const m = mount();
	m.go('root');
	m.dismiss().click();
	assert.equal(m.layer(), null);
	assert.equal(m.toured(), '1', 'offered is offered: it does not come back');
	assert.equal(m.endCount(), 1);
	// A second end changes nothing.
	m.tour.end();
	assert.equal(m.endCount(), 1);
});

t('H dismisses, and the scanner keeps its letters', () => {
	const m = mount();
	m.go('root');
	const field = document.createElement('input');
	field.type = 'text';
	dom.key('h', field);
	assert.ok(m.layer(), 'an H typed in a search field is an H');
	dom.key('H');
	assert.equal(m.layer(), null);
	assert.equal(m.toured(), '1');
});

t('a tour already walked does not walk again', async () => {
	// The layer itself has no opinion: main.js asks shouldTour() first. What is
	// checked here is that the stops it left behind are what come back.
	const m = mount({ seen: ['root', 'settings'] });
	m.go('field');
	m.go('root');
	assert.deepEqual(m.stops(), ['root', 'settings', 'field']);
	m.tour.end();
	const again = mount({ seen: m.stops() });
	again.go('root');
	assert.equal(again.kind(), 'wayTo');
	assert.equal(again.title(), 'NEXT · TARGET SCAN');
	again.tour.end();
});

t('a replay walks again, from the first stop', () => {
	// Everything read, and the tour marked as offered: without `restart` the
	// layer would open on its own last word and take itself away seven seconds
	// later. [ REPLAY TOUR ] means walk it again.
	const m = mount({ seen: REQUIRED_STOPS, toured: true, restart: true });
	m.go('root');
	assert.equal(m.kind(), 'stop');
	assert.equal(m.title(), 'THE ROOT');
	assert.equal(m.step(), 'TOUR 1/4');
	assert.deepEqual(m.stops(), [], 'the stops start from nothing again');
	m.tour.end();
});

t('the card follows the hardware: a pad plugged in mid-walk is the pad it names', () => {
	// `input` is read on every tick, not captured at mount: this is also what
	// makes a key rebound IN the panel show up on the card pointing at it.
	let device = { kind: 'keyboard' };
	const m = mount({ input: () => device });
	m.go('settings');
	assert.match(m.lines(), /KEYBOARD/);
	device = { kind: 'gamepad', name: 'EdgeTX' };
	m.tour.tick();
	assert.match(m.lines(), /EDGETX/);
	// Standing still: the redraw must not restart the clock, or a stop read
	// under the operator's eyes would never be marked.
	m.go('root');
	assert.deepEqual(m.stops(), ['settings']);
	m.tour.end();
});

t('a flight silences the tour, panel or no panel', () => {
	// TAB opens Settings over a running flight, and SETTINGS is a stop: without
	// the flight guard the band would come back up over the FPV image.
	const m = mount({ seen: ['root'] });
	m.fly(true);
	m.go('settings');
	assert.equal(m.hidden(), true);
	assert.equal(m.endCount(), 0, 'silenced, not spent: SETTINGS is still unread');
	m.fly(false);
	assert.equal(m.hidden(), false);
	assert.equal(m.title(), 'SETTINGS');
	m.tour.end();
});

t('nothing is left behind: no layer, no timer, no listener', () => {
	const before = liveTimers();
	const m = mount();
	m.go('root');
	m.tour.end();
	assert.equal(liveTimers(), before);
	assert.equal(m.ui.querySelectorAll('.tour').length, 0);
	// The key listener is gone with it: this must not throw or resurrect it.
	dom.key('H');
	assert.equal(m.ui.querySelectorAll('.tour').length, 0);
});

console.log(`\n${n} checks passed`);

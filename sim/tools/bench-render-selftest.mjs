// Selftest of the bench SCREENS (PHASE 26), mounted on the fake DOM of
// tools/lib/fake-dom.mjs. Same intent as ui-audio-render-selftest.mjs: what is
// checked is the TREE and the WIRING — which controls exist, what they carry,
// and what happens when they are operated. Appearance is judged by eye, not
// here.
//
// Run: node tools/bench-render-selftest.mjs

import assert from 'node:assert/strict';
import { installFakeDom } from './lib/fake-dom.mjs';

// The fake DOM has to exist BEFORE the screen modules are imported: menu-nav.js
// subscribes to window on load, and terminal.js touches document.
const dom = installFakeDom();
const { selectOperationMode, runBench, loadBenchConfig, loadLastMode } = await import('../src/bench.js');
const { MODE_SELECT, BENCH_SEAL, BENCH_STORAGE_KEY, normalizeBenchConfig } = await import('./bench-model.mjs');
const { FAMILIES, PROFILES } = await import('../src/drone-profiles.js');
const { PARAM_GROUPS, PARAMS } = await import('./bench-airframe.mjs');
const { radio } = await import('../src/radio.js');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };
const ta = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); };

const reset = () => { dom.storage.clear(); dom.root.replaceChildren(); dom.setActive(null); };

// How many timers are still armed. The root's RTC stream (issue #243) sets one
// per tick, and a screen that leaves without calling its stop() lets them beat
// on a detached node. The count is RELATIVE (before/after): other modules arm
// timers too, and they are not the ones being watched.
const _live = new Set();
const _setTimeout = globalThis.setTimeout;
const _clearTimeout = globalThis.clearTimeout;
globalThis.setTimeout = (fn, ms, ...rest) => {
	const id = _setTimeout((...a) => { _live.delete(id); return fn(...a); }, ms, ...rest);
	_live.add(id);
	return id;
};
globalThis.clearTimeout = (id) => { _live.delete(id); return _clearTimeout(id); };
const timersAlive = () => _live.size;

// The button whose label contains `label`. CTAs render as "[ X ]".
const btn = (label) => dom.root.querySelectorAll('button').find((b) => b.textContent.includes(label));
const rowOf = (key) => dom.root.querySelector(`[data-bench-key="${key}"]`);
// The whole row (label + control + value) that holds this control.
const lineOf = (key) => { let e = rowOf(key); while (e && !e.classList.contains('bench-row')) e = e.parent; return e; };

// ---------------------------------------------------------------------------
// SELECT OPERATION MODE

await ta('mode select: the five ways, with what each of them costs', async () => {
	reset();
	const p = selectOperationMode(dom.root, { last: 'field' });
	const text = dom.root.textContent;
	assert.ok(text.includes(MODE_SELECT.title), 'the title');
	// D3/D6: the ORDER is the message — fly, then the bench, then what is cold,
	// then what is listened to, then the settings. DATA, JUKEBOX and SETTINGS
	// are no longer links buried in a FIELD tab.
	const ctas = dom.root.querySelectorAll('.bench-mode').map((w) => w.querySelector('button').textContent);
	assert.deepEqual(ctas, ['[ FIELD ]', '[ BENCH ]', '[ DATA ]', '[ JUKEBOX ]', '[ SETTINGS ]']);
	for (const m of ['field', 'bench', 'data', 'jukebox', 'settings']) {
		for (const l of MODE_SELECT[m].lines) assert.ok(text.includes(l), `"${l}" is shown`);
	}
	btn('FIELD').click();
	assert.equal(await p, 'field');
});

await ta('mode select: DATA and SETTINGS render like the other two', async () => {
	reset();
	let p = selectOperationMode(dom.root, { last: 'field' });
	btn('DATA').click();
	assert.equal(await p, 'data');

	reset();
	p = selectOperationMode(dom.root, { last: 'field' });
	btn('SETTINGS').click();
	assert.equal(await p, 'settings');
});

await ta('mode select: the cursor lands on the last mode used', async () => {
	reset();
	// A FIELD player must pay one keystroke per launch, not one choice.
	let p = selectOperationMode(dom.root, { last: 'field' });
	assert.ok(dom.active?.textContent.includes('FIELD'), `cursor on FIELD, not "${dom.active?.textContent}"`);
	btn('FIELD').click();
	await p;

	reset();
	p = selectOperationMode(dom.root, { last: 'bench' });
	assert.ok(dom.active?.textContent.includes('BENCH'), `cursor on BENCH, not "${dom.active?.textContent}"`);
	btn('BENCH').click();
	assert.equal(await p, 'bench');

	// `fpvtp.mode` remembers ALL the ways (D3): coming back to read a log must
	// cost no more than coming back to fly.
	reset();
	p = selectOperationMode(dom.root, { last: 'data' });
	assert.ok(dom.active?.textContent.includes('DATA'), `cursor on DATA, not "${dom.active?.textContent}"`);
	btn('DATA').click();
	await p;
	assert.equal(loadLastMode(), 'data', 'and the way remembered is indeed DATA');
});

// Issue #26: ARCHIVE became DATA. An operator who left the game on ARCHIVE
// finds their cursor on DATA — it is the same tab under its real name, not a
// vanished way that would drop them back on FIELD.
t('mode select: an `fpvtp.mode` left on ARCHIVE falls back to DATA', () => {
	reset();
	dom.storage.set('fpvtp.mode', 'archive');
	assert.equal(loadLastMode(), 'data');
	dom.storage.set('fpvtp.mode', 'anything at all');
	assert.equal(loadLastMode(), 'field', 'and an unknown value still falls back to FIELD');
});

await ta('mode select: the choice is remembered for the next launch', async () => {
	reset();
	const p = selectOperationMode(dom.root, { last: 'field' });
	btn('BENCH').click();
	await p;
	assert.equal(loadLastMode(), 'bench');
});

await ta('mode select: the screen is taken down behind it', async () => {
	reset();
	const p = selectOperationMode(dom.root, { last: 'field' });
	btn('FIELD').click();
	await p;
	assert.equal(dom.root.children.length, 0, 'nothing is left in #ui');
});

await ta('mode select: identity is written above the choice', async () => {
	reset();
	// Bible §48: "OPERATOR // NEO" then SELECT OPERATION MODE. The root says
	// first who you are. It stays mountable with no operator (?scene= does not
	// always load one): the line disappears, the screen does not break.
	const p = selectOperationMode(dom.root, { last: 'field', operatorName: 'neo' });
	const who = dom.root.querySelector('.bench-operator');
	assert.ok(who, 'the operator line');
	assert.equal(who.textContent, 'OPERATOR // NEO', 'in capitals, like the Home');
	btn('FIELD').click();
	await p;

	reset();
	const p2 = selectOperationMode(dom.root, { last: 'field' });
	assert.equal(dom.root.querySelector('.bench-operator'), null, 'no empty line without an operator');
	btn('FIELD').click();
	await p2;
});

await ta('mode select: two columns, the RTC to the right of the ways', async () => {
	reset();
	// Issue #243: the root is the ONLY screen still carrying an RTC block.
	// Checked here and not by eye alone, because the stream's first tick is
	// several seconds out: an RTC that had never been mounted would go unnoticed
	// on the bench and on screen for all that time.
	const p = selectOperationMode(dom.root, { last: 'field' });
	const left = dom.root.querySelector('.terminal-left');
	const right = dom.root.querySelector('.terminal-right');
	assert.ok(left, 'the column of ways');
	assert.ok(right, 'the RTC column');
	// The ways are on the LEFT, the RTC on the RIGHT: that is the whole of #243.
	assert.ok(left.querySelector('.bench-mode'), 'the ways are in the left column');
	assert.equal(right.querySelector('.bench-mode'), null, 'and not in the right one');
	assert.ok(right.querySelector('.sc-rtc'), 'the RTC is in the right column');
	btn('FIELD').click();
	assert.equal(await p, 'field');
});

await ta('mode select: the RTC stream is stopped when a choice is made', async () => {
	reset();
	// A timer that outlives its screen replays a tick on a detached node at every
	// subsequent launch. `mount()` returns a stop() FOR that, and pick() has to
	// call it the way it calls nav.detach().
	const before = timersAlive();
	const p = selectOperationMode(dom.root, { last: 'field' });
	assert.ok(timersAlive() > before, 'the stream did arm a timer');
	btn('FIELD').click();
	await p;
	assert.equal(timersAlive(), before, 'and nothing is left after the choice');
});

// ---------------------------------------------------------------------------
// The bench screen

const SCENES = [{ slug: 'paristest', name: 'paristest' }, { slug: 'tour-eiffel', name: 'Tour Eiffel' }];

await ta('bench: every row is mounted and readable', async () => {
	reset();
	const p = runBench(dom.root, { scenes: SCENES });
	for (const key of ['family', 'base', 'detail', 'terrain', 'entry', 'fence', 'time', 'wind', 'gust', 'dir', 'rain', 'fog', 'cloud', 'link', 'battery']) {
		assert.ok(rowOf(key), `the ${key} row exists`);
	}
	const text = dom.root.textContent;
	assert.ok(text.includes(BENCH_SEAL), 'the seal is shown');
	assert.ok(!/undefined|NaN|\[object/.test(text), `no technical leak on screen:\n${text}`);
	btn('SPIN UP').click();
	await p;
});

await ta('bench: every row has its leader and its value column', async () => {
	reset();
	const p = runBench(dom.root, { scenes: SCENES });
	const rows = dom.root.querySelectorAll('.bench-row');
	assert.ok(rows.length >= 14, `at least 14 rows, saw ${rows.length}`);
	for (const r of rows) {
		const label = r.querySelectorAll('.bench-label');
		const lead = r.querySelectorAll('.bench-leader');
		const val = r.querySelectorAll('.bench-value');
		// The four columns are always there, even empty: that is what aligns the
		// values from one end to the other. A row that skips its value leaves a
		// hole, and the eye loses the column.
		assert.equal(label.length, 1, `one label on "${r.textContent}"`);
		assert.equal(lead.length, 1, `one leader on "${r.textContent}"`);
		assert.equal(val.length, 1, `one value on "${r.textContent}"`);
	}
	btn('SPIN UP').click();
	await p;
});

await ta('bench: each of the three wind sliders says what it sets', async () => {
	reset();
	const p = runBench(dom.root, { scenes: SCENES });
	// Bible §48's mock sums the wind up on one line, but there are three
	// sliders: each has to carry its reading, or it is set blind.
	for (const key of ['wind', 'gust', 'dir']) {
		const v = lineOf(key).querySelector('.bench-value');
		assert.ok(v.textContent.trim().length, `the ${key} row shows its value`);
	}
	btn('SPIN UP').click();
	await p;
});

await ta('bench: the title and the creed are two distinct blocks', async () => {
	reset();
	const p = runBench(dom.root, { scenes: SCENES });
	const title = dom.root.querySelector('.bench-title');
	const creed = dom.root.querySelector('.bench-creed');
	assert.ok(title && title.textContent.includes('BENCH'), 'the title');
	// Apart because they do not speak at the same level: the creed is not a
	// second title line, it is what the bench says about itself.
	assert.ok(creed, 'the creed has its own block');
	for (const term of ['NO TARGET', 'NO LINK', 'NO HACK', 'NO LOSS']) {
		assert.ok(creed.textContent.includes(term), `the creed carries "${term}"`);
	}
	assert.ok(!title.textContent.includes('NO TARGET'), 'the creed is not in the title');
	btn('SPIN UP').click();
	await p;
});

await ta('bench: the cursor lands on SPIN UP', async () => {
	reset();
	const p = runBench(dom.root, { scenes: SCENES });
	// That is what you come for when you reopen the bench without changing
	// anything.
	assert.equal(dom.active?.dataset.benchKey, 'spin');
	btn('SPIN UP').click();
	await p;
});

await ta('bench: changing the airframe updates the screen AND the config returned', async () => {
	reset();
	const p = runBench(dom.root, { scenes: SCENES });
	const sel = rowOf('family');
	sel.value = 'race5';
	sel.onchange();
	assert.ok(lineOf('family').textContent.includes(PROFILES.race5.label), 'the label follows');
	btn('SPIN UP').click();
	const cfg = await p;
	assert.equal(cfg.airframe.family, 'race5');
});

await ta('bench: a slider writes a value, and the value reads back', async () => {
	reset();
	const p = runBench(dom.root, { scenes: SCENES });
	const wind = rowOf('wind');
	wind.value = '12';
	wind.oninput();
	assert.ok(lineOf('wind').textContent.includes('12.0 m/s'), `the row says the wind — "${lineOf('wind').textContent}"`);
	const time = rowOf('time');
	time.value = String(6 * 60 + 30);
	time.oninput();
	assert.ok(lineOf('time').textContent.includes('06:30'), `the row says the time — "${lineOf('time').textContent}"`);
	btn('SPIN UP').click();
	const cfg = await p;
	assert.equal(cfg.weather.windSpeed, 12);
	assert.equal(cfg.timeMin, 390);
});

await ta('bench: the cursor survives the re-render the setting triggers', async () => {
	reset();
	const p = runBench(dom.root, { scenes: SCENES });
	rowOf('rain').focus();
	const before = dom.active.dataset.benchKey;
	rowOf('rain').value = '9';
	rowOf('rain').oninput();
	// Without carrying it over, setting the rain would throw the cursor back to
	// the top of the screen at every notch — the bench would become unusable
	// from the keyboard.
	assert.equal(dom.active?.dataset.benchKey, before, 'the cursor stayed on RAIN');
	btn('SPIN UP').click();
	await p;
});

await ta('bench: INDIVIDUAL draws a seed, ROLL draws another', async () => {
	reset();
	const p = runBench(dom.root, { scenes: SCENES });
	assert.equal(loadBenchConfig().airframe.seed, null, 'NOMINAL to start with');
	assert.ok(!rowOf('roll'), 'no ROLL while it is NOMINAL');
	const sel = rowOf('base');
	sel.value = 'INDIVIDUAL';
	sel.onchange();
	const first = loadBenchConfig().airframe.seed;
	assert.ok(first, 'a seed was drawn');
	assert.ok(rowOf('roll'), 'ROLL has appeared');
	rowOf('roll').click();
	assert.notEqual(loadBenchConfig().airframe.seed, first, 'ROLL draws another');
	btn('SPIN UP').click();
	await p;
});

// ---------------------------------------------------------------------------
// The airframe screen (issue #159)

// The airframe screen is mounted OVER the bench, which stays in the tree
// hidden: both carry `data-bench-key`, so the airframe's controls have to be
// looked up inside its own screen or the bench's `family` row answers first.
const air = () => dom.root.querySelector('.bench-airframe');
const airRow = (key) => air().querySelector(`[data-bench-key="${key}"]`);
const airLine = (key) => { let e = airRow(key); while (e && !e.classList.contains('bench-row')) e = e.parent; return e; };
// Same reason for the buttons: the bench underneath has a BACK of its own, and
// it is the one that would answer first.
const airBtn = (label) => air().querySelectorAll('button').find((b) => b.textContent.includes(label));
const openAir = async () => { btn('PARAMETERS').click(); await Promise.resolve(); };
const closeAir = async () => { airBtn('BACK').click(); await Promise.resolve(); };

await ta('airframe: the whole parameter table is mounted, and reads', async () => {
	reset();
	const p = runBench(dom.root, { scenes: SCENES });
	await openAir();
	assert.ok(air(), 'the airframe screen is mounted');
	// One row per parameter of the catalogue that is not hidden by the rate
	// parameterisation: the bench exists to be exact, so nothing is left out.
	for (const p2 of PARAM_GROUPS.flatMap((g) => g.params)) {
		if (p2.shape === 'spec') continue;   // ACTUAL is the default shape
		assert.ok(airRow(p2.key), `the ${p2.key} row exists`);
	}
	const text = air().textContent;
	assert.ok(!/undefined|NaN|\[object/.test(text), 'no technical leak on screen');
	await closeAir();
	btn('SPIN UP').click();
	await p;
});

await ta('airframe: a typed parameter reaches the config, and clears again', async () => {
	reset();
	const p = runBench(dom.root, { scenes: SCENES });
	await openAir();
	const mass = airRow('mass');
	assert.equal(Number(mass.value), 0.65, 'the field opens on the base value');
	mass.value = '0.82';
	mass.onchange();
	assert.equal(loadBenchConfig().airframe.overrides.mass, 0.82);
	// The marker is what tells a typed value from one the base produced.
	assert.ok(airLine('mass').textContent.includes('·'), 'the row is marked');
	assert.ok(airRow('reset.mass'), 'and it can be reset alone');
	airRow('reset.mass').click();
	assert.equal(loadBenchConfig().airframe.overrides.mass, undefined, 'RESET clears it');
	// Emptying the field is the same gesture, and it is the one that makes the
	// screen reversible from the keyboard alone.
	airRow('mass').value = '0.9';
	airRow('mass').onchange();
	airRow('mass').value = '';
	airRow('mass').onchange();
	assert.equal(loadBenchConfig().airframe.overrides.mass, undefined);
	await closeAir();
	btn('SPIN UP').click();
	const cfg = await p;
	assert.deepEqual(cfg.airframe.overrides, {});
});

await ta('airframe: the cursor stays on the screen being typed into', async () => {
	reset();
	const p = runBench(dom.root, { scenes: SCENES });
	await openAir();
	airRow('gyroNoise').focus();
	airRow('gyroNoise').value = '0.3';
	airRow('gyroNoise').onchange();
	// Each change re-renders the bench UNDERNEATH as well (it holds the config).
	// Its own cursor restore must not reach up and take focus back mid-typing.
	assert.equal(dom.active?.dataset.benchKey, 'gyroNoise');
	assert.ok(air().querySelector('[data-bench-key="gyroNoise"]') === dom.active, 'and on the airframe screen, not the bench');
	await closeAir();
	btn('SPIN UP').click();
	await p;
});

await ta('airframe: an absurd value is brought back, never refused', async () => {
	reset();
	const p = runBench(dom.root, { scenes: SCENES });
	await openAir();
	for (const [key, typed] of [['mass', '999'], ['motor.kv', '-40'], ['battery.cells', '3.7']]) {
		airRow(key).value = typed;
		airRow(key).onchange();
	}
	const o = loadBenchConfig().airframe.overrides;
	assert.equal(o.mass, PARAMS.get('mass').max, 'clamped to the ceiling');
	assert.equal(o['motor.kv'], PARAMS.get('motor.kv').min, 'clamped to the floor');
	assert.equal(o['battery.cells'], 4, 'an integer parameter is rounded');
	await closeAir();
	btn('SPIN UP').click();
	await p;
});

await ta('airframe: CUSTOM shows the bill of materials and what it adds up to', async () => {
	reset();
	const p = runBench(dom.root, { scenes: SCENES });
	await openAir();
	assert.ok(!airRow('part.frame'), 'no parts while the base is NOMINAL');
	const base = airRow('base');
	base.value = 'CUSTOM';
	base.onchange();
	for (const key of ['frame', 'motor', 'prop', 'blades', 'battery', 'camera']) {
		assert.ok(airRow(`part.${key}`), `the ${key} row exists`);
	}
	// The consequence, while the parts are being chosen — not two screens away.
	const readout = air().querySelector('.bench-readout');
	assert.ok(readout && /T:W|: 1/.test(readout.textContent.replace('THRUST', '')), 'thrust to weight is displayed');
	// A part number that does not fit says so, and forbids nothing.
	const prop = airRow('part.prop');
	prop.value = '7055';
	prop.onchange();
	assert.match(air().textContent, /RATED/, 'the fitment window is reported');
	await closeAir();
	btn('SPIN UP').click();
	const cfg = await p;
	assert.equal(cfg.airframe.base, 'CUSTOM');
	assert.equal(cfg.airframe.parts.prop, '7055');
});

await ta('airframe: the in-flight panel applies a parameter without waiting', async () => {
	reset();
	const seen = [];
	const p = runBench(dom.root, { scenes: SCENES, live: true, onChange: (c) => seen.push(c) });
	await openAir();
	airRow('gyroNoise').value = '0.4';
	airRow('gyroNoise').onchange();
	// A setting has to behave the same before and during the flight, otherwise
	// the bench lies about what it sets.
	assert.equal(seen.at(-1).airframe.overrides.gyroNoise, 0.4);
	await closeAir();
	btn('RESUME').click();
	await p;
});

// ---------------------------------------------------------------------------
// The radio over a flight (issue #159, second half)

// A library, and a radio that answers without Web Audio. The screen is a VIEW
// onto src/radio.js and owns no playback, so what is checked is exactly that:
// which gesture reaches which call, and with what programme.
const LIBRARY = [
	{ id: 'menu-1aec9db0', pool: 'menu', durS: 84, bpm: 120 },
	{ id: 'race5-22ffaa01', pool: 'race5', durS: 131, bpm: 174 },
	{ id: 'race5-33bbcc02', pool: 'race5', durS: 97, bpm: 168 },
];
const stubRadio = () => {
	const calls = [];
	radio.library = LIBRARY;
	radio.index = -1;
	radio.owns = false;
	radio._ready = Promise.resolve(LIBRARY);
	radio.playAt = async (i, list = null) => {
		if (list) radio.library = list;
		radio.index = i;
		radio.owns = true;
		calls.push(['playAt', i, radio.library.map((t) => t.id)]);
	};
	radio.next = async () => { calls.push(['next']); };
	radio.prev = async () => { calls.push(['prev']); };
	radio.toggle = async () => { calls.push(['toggle']); };
	Object.defineProperty(radio, 'playing', { configurable: true, get: () => radio.owns });
	return calls;
};

await ta('in-flight panel: the radio is there, and only in flight', async () => {
	reset();
	// Before take-off there is a JUKEBOX one screen up; in flight there is
	// nothing, and that is the gap this fills.
	let p = runBench(dom.root, { scenes: SCENES });
	assert.ok(!rowOf('play'), 'no transport on the pre-flight bench');
	btn('SPIN UP').click();
	await p;

	reset();
	radio.library = [];
	radio._ready = Promise.resolve([]);
	p = runBench(dom.root, { scenes: SCENES, live: true });
	// With no library the row says so rather than offering dead buttons.
	assert.match(dom.root.textContent, /NO MUSIC LIBRARY/);
	assert.ok(!rowOf('play'), 'and no transport either');
	btn('RESUME').click();
	await p;
});

await ta('in-flight panel: the track can be changed without landing', async () => {
	reset();
	const calls = stubRadio();
	const p = runBench(dom.root, { scenes: SCENES, live: true });
	for (const key of ['pool', 'track', 'prev', 'play', 'next']) {
		assert.ok(rowOf(key), `the ${key} control exists`);
	}
	// Picking a track takes the antenna on the DISPLAYED list, which becomes
	// the programme — the jukebox's own rule.
	const track = rowOf('track');
	track.value = '1';
	track.onchange();
	await Promise.resolve();
	assert.deepEqual(calls.at(-1), ['playAt', 1, LIBRARY.map((t) => t.id)]);
	// Filtering narrows the programme to that pool.
	const pool = rowOf('pool');
	pool.value = 'race5';
	pool.onchange();
	rowOf('track').value = '0';
	rowOf('track').onchange();
	await Promise.resolve();
	assert.deepEqual(calls.at(-1), ['playAt', 0, ['race5-22ffaa01', 'race5-33bbcc02']],
		'the race5 pool became the programme');
	rowOf('next').click();
	rowOf('prev').click();
	await Promise.resolve();
	assert.deepEqual(calls.slice(-2), [['next'], ['prev']]);
	btn('RESUME').click();
	await p;
});

await ta('in-flight panel: the first PLAY starts the programme, it resumes nothing', async () => {
	reset();
	const calls = stubRadio();
	radio.owns = false;
	const p = runBench(dom.root, { scenes: SCENES, live: true });
	// toggle() on a radio that never took the antenna has nothing to resume.
	rowOf('play').click();
	await Promise.resolve();
	assert.equal(calls.at(-1)[0], 'playAt', 'the first press starts the programme');
	// Once it owns the antenna, the same button is a real toggle.
	rowOf('play').click();
	await Promise.resolve();
	assert.deepEqual(calls.at(-1), ['toggle']);
	btn('RESUME').click();
	await p;
});

await ta('bench: the config persists from one opening to the next', async () => {
	reset();
	let p = runBench(dom.root, { scenes: SCENES });
	rowOf('cloud').value = '80';
	rowOf('cloud').oninput();
	const sel = rowOf('entry');
	sel.value = 'HOLY_SHIT';
	sel.onchange();
	btn('SPIN UP').click();
	await p;

	// Reopened: what was set is still there. Setting a dozen controls again on
	// every launch would be exactly the frustration the bench removes.
	p = runBench(dom.root, { scenes: SCENES });
	assert.equal(rowOf('cloud').value, '80');
	assert.equal(rowOf('entry').value, 'HOLY_SHIT');
	btn('SPIN UP').click();
	const cfg = await p;
	assert.equal(cfg.weather.cloudPct, 80);
	assert.equal(cfg.entry, 'HOLY_SHIT');
});

await ta('bench: nothing written says a flight took place', async () => {
	reset();
	const p = runBench(dom.root, { scenes: SCENES });
	rowOf('wind').value = '7';
	rowOf('wind').oninput();
	btn('SPIN UP').click();
	await p;
	// The watertightness invariant, at the level of what actually touches disk.
	assert.deepEqual([...dom.storage.keys()].sort(), [BENCH_STORAGE_KEY].sort(),
		`the bench writes only its config — found ${[...dom.storage.keys()]}`);
	const raw = dom.storage.get(BENCH_STORAGE_KEY);
	for (const forbidden of ['session', 'photo', 'randomart', 'result', 'landed', 'crashed']) {
		assert.ok(!raw.toLowerCase().includes(forbidden), `"${forbidden}" has no business there`);
	}
});

await ta('bench: BACK goes back up without flying anything', async () => {
	reset();
	const p = runBench(dom.root, { scenes: SCENES });
	btn('BACK').click();
	assert.equal(await p, null);
	assert.equal(dom.root.children.length, 0, 'the screen is taken down');
});

await ta('bench: Escape goes back up too', async () => {
	reset();
	const p = runBench(dom.root, { scenes: SCENES });
	dom.key('Escape');
	assert.equal(await p, null);
});

// ---------------------------------------------------------------------------
// With no terrain, and with a terrain that has gone

await ta('bench: an empty cache falls back to free flight rather than a refusal', async () => {
	reset();
	const p = runBench(dom.root, { scenes: [] });
	// The bench must never open on a wall: with no terrain on disk it offers
	// what works anyway.
	assert.equal(rowOf('terrain').value, 'live');
	assert.ok(rowOf('lat') && rowOf('lon'), 'the coordinates are editable');
	assert.ok(!btn('SPIN UP').disabled, 'and it can take off');
	btn('SPIN UP').click();
	const cfg = await p;
	assert.equal(cfg.terrain.kind, 'live');
});

await ta('bench: a terrain gone from disk is reported, not suffered', async () => {
	reset();
	dom.storage.set(BENCH_STORAGE_KEY, JSON.stringify(normalizeBenchConfig({
		terrain: { kind: 'cached', slug: 'disparue' },
	})));
	const p = runBench(dom.root, { scenes: SCENES });
	// The missing slug is replaced by the first scene present: inform without
	// blocking, and above all do not open on a dead button.
	assert.equal(rowOf('terrain').value, `cached:${SCENES[0].slug}`);
	assert.ok(!btn('SPIN UP').disabled);
	btn('SPIN UP').click();
	await p;
});

await ta('bench: in free flight, an ENTRY with no effect is announced on screen', async () => {
	reset();
	const p = runBench(dom.root, { scenes: [] });   // empty cache -> free flight
	assert.equal(rowOf('terrain').value, 'live');
	const sel = rowOf('entry');
	sel.value = 'HOLY_SHIT';
	sel.onchange();
	// Without this warning the operator would believe they were dropping in on
	// HOLY SHIT and would leave from the ground never understanding why.
	assert.match(dom.root.textContent, /IGNORED IN LIVE FLIGHT/);
	// But it stays a warning: it takes off all the same.
	assert.ok(!btn('SPIN UP').disabled);
	sel.value = 'IDLE';
	sel.onchange();
	assert.ok(!/IGNORED IN LIVE FLIGHT/.test(dom.root.textContent), 'IDLE has nothing to announce');
	btn('SPIN UP').click();
	await p;
});

await ta('bench: FENCE OFF warns that the terrain stops at the edge', async () => {
	reset();
	const p = runBench(dom.root, { scenes: SCENES });
	const sel = rowOf('fence');
	sel.value = 'off';
	sel.onchange();
	assert.match(dom.root.textContent, /TERRAIN ENDS AT THE EDGE/,
		'the consequence reads BEFORE take-off, not out in the void');
	// But it forbids nothing: the bench informs, it does not lock.
	assert.ok(!btn('SPIN UP').disabled);
	btn('SPIN UP').click();
	await p;
});

// ---------------------------------------------------------------------------
// The in-flight panel

await ta('in-flight panel: every change leaves at once', async () => {
	reset();
	const seen = [];
	const p = runBench(dom.root, { scenes: SCENES, live: true, onChange: (c) => seen.push(c) });
	rowOf('wind').value = '15';
	rowOf('wind').oninput();
	rowOf('cloud').value = '50';
	rowOf('cloud').oninput();
	assert.equal(seen.length, 2, 'two changes, two applications');
	assert.equal(seen[1].weather.windSpeed, 15);
	assert.equal(seen[1].weather.cloudPct, 50);
	btn('RESUME').click();
	await p;
});

await ta('in-flight panel: no terrain, and RESUME instead of SPIN UP', async () => {
	reset();
	const p = runBench(dom.root, { scenes: SCENES, live: true });
	// Changing terrain would mean reloading the scene, so leaving the flight.
	// Showing it greyed out would be worse than not showing it.
	assert.ok(!rowOf('terrain'), 'the TERRAIN row is absent');
	assert.ok(!btn('BACK'), 'and BACK too: there is no going back up from a flight');
	assert.ok(btn('RESUME'), 'the CTA resumes the flight');
	// The airframe, though, stays settable hot.
	assert.ok(rowOf('family'), 'the airframe stays settable');
	btn('RESUME').click();
	await p;
});

await ta('in-flight panel: Escape resumes the flight, it cancels nothing', async () => {
	reset();
	const p = runBench(dom.root, { scenes: SCENES, live: true });
	rowOf('rain').value = '4';
	rowOf('rain').oninput();
	dom.key('Escape');
	const cfg = await p;
	// Everything has already been applied as it went: Escape cannot "cancel",
	// and returning null would lose the caller's config.
	assert.ok(cfg, 'a config is returned');
	assert.equal(cfg.weather.rateMmH, 4);
});

await ta('in-flight panel: RESET BENCH starts again from the defaults and applies it', async () => {
	reset();
	const seen = [];
	let p = runBench(dom.root, { scenes: SCENES, live: true, onChange: (c) => seen.push(c) });
	rowOf('wind').value = '20';
	rowOf('wind').oninput();
	btn('RESET BENCH').click();
	assert.equal(seen.at(-1).weather.windSpeed, 0, 'the reset is applied, not merely displayed');
	btn('RESUME').click();
	await p;
});

// ---------------------------------------------------------------------------
// Robustness

await ta('bench: a corrupt config on disk does not stop it opening', async () => {
	reset();
	dom.storage.set(BENCH_STORAGE_KEY, '{ this is not json');
	const p = runBench(dom.root, { scenes: SCENES });
	assert.ok(rowOf('spin'), 'the screen is mounted all the same');
	assert.ok(!btn('SPIN UP').disabled, 'and it takes off');
	btn('SPIN UP').click();
	const cfg = await p;
	assert.ok(FAMILIES.includes(cfg.airframe.family));
});

dom.restore();
console.log(`\n${n} tests bench-render OK`);

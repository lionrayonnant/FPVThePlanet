// Selftest of the hangar (issue #185, Signals lot 3): the pure rows and lines
// (tools/hangar-model.mjs), then src/hangar.js mounted on the fake DOM — no
// WebGL there, so what is checked is the tree it degrades to and that
// destroy() stops everything. Run: node tools/hangar-selftest.mjs
import assert from 'node:assert/strict';
import {
	HANGAR_LABELS, BAR_CELLS, hangarRows, progressLine, progressParts, tiersLine, scrambleLabel,
} from './hangar-model.mjs';
import { STEPS } from './signal-clearance-model.mjs';
import { withResolved, fromStored } from './signal-store-model.mjs';
import { installFakeDom } from './lib/fake-dom.mjs';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); };

// Exactly `points` worth of tier-1 entries (1 point each).
function storeWith(points) {
	let s = fromStored(null);
	for (let i = 0; i < points; i++) {
		s = withResolved(s, `wd:Q${i + 1}`, {
			at: i, name: 'X', lat: 0, lon: 0, tier: 1,
			family: 'freestyle5', holdS: 5, distM: 100, sessionId: null, photo: null,
		});
	}
	return s;
}

const openIds = (rows) => rows.flatMap((r) => r.machines.filter((m) => m.open).map((m) => m.id));

await t('rows: four groups, the seven machines in ladder order, one row', async () => {
	const rows = hangarRows(storeWith(0));
	assert.deepEqual(rows.map((r) => r.level), [0, 1, 2, 3]);
	assert.deepEqual(rows.flatMap((r) => r.machines.map((m) => m.id)),
		['freestyle5', 'cinewhoop', 'toothpick', 'race5', 'longrange', 'heavy5', 'swarm']);
	assert.deepEqual(rows.flatMap((r) => r.machines.map((m) => m.label)),
		['5" FREESTYLE', 'CINEWHOOP', 'TOOTHPICK', '5" RACE', 'LONG RANGE', 'HEAVY 5"', 'SWARM']);
	assert.deepEqual(rows.map((r) => r.cost), STEPS);
});

await t('rows at clearance 0 / 1 / 2 / 3 open exactly the ladder', async () => {
	assert.deepEqual(openIds(hangarRows(storeWith(0))), ['freestyle5']);
	assert.deepEqual(openIds(hangarRows(storeWith(6))), ['freestyle5', 'cinewhoop', 'toothpick']);
	assert.deepEqual(openIds(hangarRows(storeWith(18))),
		['freestyle5', 'cinewhoop', 'toothpick', 'race5', 'longrange', 'heavy5']);
	assert.equal(openIds(hangarRows(storeWith(36))).length, 7);
});

await t('group marks: [+] when open, the cost in points when not', async () => {
	const rows = hangarRows(storeWith(9));
	assert.deepEqual(rows.map((r) => r.mark), ['[+]', '[+]', '18 PTS', '36 PTS']);
});

await t('locked names are scrambled, open names are plain', async () => {
	const rows = hangarRows(storeWith(0));
	assert.equal(rows[0].machines[0].shown, '5" FREESTYLE');
	const race = rows[2].machines[0];
	assert.notEqual(race.shown, race.label);
	assert.equal(race.shown.length, race.label.length);
	assert.equal(race.shown, scrambleLabel(race.label, 'race5'));
});

await t('justOpened: only the machines of the step passed in, and only once reached', async () => {
	const rows = hangarRows(storeWith(18), 2);
	const just = rows.flatMap((r) => r.machines.filter((m) => m.justOpened).map((m) => m.id));
	assert.deepEqual(just, ['race5', 'longrange', 'heavy5']);
	assert.deepEqual(hangarRows(storeWith(18)).flatMap((r) => r.machines.filter((m) => m.justOpened)), []);
	// A reveal above the store's clearance is not a reveal: nothing is open there.
	assert.deepEqual(hangarRows(storeWith(6), 2).flatMap((r) => r.machines.filter((m) => m.justOpened)), []);
	// Level 0 is never crossed.
	assert.deepEqual(hangarRows(storeWith(0), 0).flatMap((r) => r.machines.filter((m) => m.justOpened)), []);
	assert.deepEqual(hangarRows(storeWith(36), 3).flatMap((r) => r.machines.filter((m) => m.justOpened).map((m) => m.id)), ['swarm']);
});

await t('progress: a 12-cell bar over the current step, at its boundaries', async () => {
	assert.equal(BAR_CELLS, 12);
	assert.equal(progressLine(storeWith(0)), `${'░'.repeat(12)}  0/6 TO CLEARANCE 1`);
	assert.equal(progressLine(storeWith(5)), `${'▓'.repeat(10)}${'░'.repeat(2)}  5/6 TO CLEARANCE 1`);
	// A step reached empties the bar again: it measures the NEXT step.
	assert.equal(progressLine(storeWith(6)), `${'░'.repeat(12)}  6/18 TO CLEARANCE 2`);
	assert.equal(progressLine(storeWith(9)), `${'▓'.repeat(3)}${'░'.repeat(9)}  9/18 TO CLEARANCE 2`);
	assert.equal(progressLine(storeWith(35)), `${'▓'.repeat(11)}${'░'}  35/36 TO CLEARANCE 3`);
	assert.equal(progressLine(storeWith(36)), 'CLEARANCE 3 · MAX');
	assert.equal(progressLine(storeWith(50)), 'CLEARANCE 3 · MAX');
	assert.equal(progressLine(null), `${'░'.repeat(12)}  0/6 TO CLEARANCE 1`);
});

await t('progress: the scanner header\'s narrower bar, same formula', async () => {
	assert.equal(progressParts(storeWith(9), { cells: 9 }).bar, `${'▓'.repeat(2)}${'░'.repeat(7)}`);
	assert.equal(progressParts(storeWith(5), { cells: 9 }).bar, `${'▓'.repeat(7)}${'░'.repeat(2)}`);
	assert.equal(progressParts(storeWith(0), { cells: 9 }).bar, '░'.repeat(9));
	assert.equal(progressParts(storeWith(36), { cells: 9 }).bar, null);
	assert.equal(progressParts(storeWith(9)).bar.length, BAR_CELLS);
});

await t('tiers: the open ones, then the first closed one and where it opens', async () => {
	assert.equal(tiersLine(storeWith(0)), 'SIGNALS   TIER I   TIER II AT CLEARANCE 1');
	assert.equal(tiersLine(storeWith(9)), 'SIGNALS   TIER I · TIER II   TIER III AT CLEARANCE 2');
	assert.equal(tiersLine(storeWith(18)), 'SIGNALS   TIER I · TIER II · TIER III');
	assert.equal(tiersLine(storeWith(40)), 'SIGNALS   TIER I · TIER II · TIER III');
});

await t('scrambleLabel: stable per seed, spaces kept, glyphs only', async () => {
	assert.equal(scrambleLabel('LONG RANGE', 'longrange'), scrambleLabel('LONG RANGE', 'longrange'));
	assert.notEqual(scrambleLabel('LONG RANGE', 'longrange'), scrambleLabel('LONG RANGE', 'heavy5'));
	assert.equal(scrambleLabel('LONG RANGE', 'x')[4], ' ');
	assert.match(scrambleLabel(HANGAR_LABELS.heavy5, 3), /^[░▒▓█ ]+$/);
	assert.equal(scrambleLabel('AB', 5), scrambleLabel('AB', 5));
});

// --- the component, on the fake DOM (no WebGL: labels only)

const dom = installFakeDom({ raf: true });
const { mountHangar, progressNode, tiersNode } = await import('../src/hangar.js');

await t('mount: one group per level, a slot per machine, names as text', async () => {
	const host = document.createElement('div');
	dom.root.appendChild(host);
	const h = mountHangar(host, { store: storeWith(9), createRenderer: () => { throw new Error('no WebGL'); } });
	const groups = host.querySelectorAll('.hangar-grp');
	assert.equal(groups.length, 4);
	assert.match(groups[0].textContent, /CLEARANCE 0\[\+\]/);
	assert.match(groups[2].textContent, /CLEARANCE 218 PTS/);
	const names = host.querySelectorAll('.hangar-n').map((e) => e.textContent);
	assert.equal(names.length, 7);
	assert.deepEqual(names.slice(0, 3), ['5" FREESTYLE', 'CINEWHOOP', 'TOOTHPICK']);
	assert.notEqual(names[3], '5" RACE');
	h.destroy();
	assert.equal(host.children.length, 0, 'destroy() empties the host');
});

await t('reveal: the opened machines are marked, the rest are not', async () => {
	const host = document.createElement('div');
	dom.root.appendChild(host);
	const h = mountHangar(host, { store: storeWith(6), reveal: 1, compact: true, createRenderer: () => null });
	const ms = host.querySelectorAll('.hangar-m');
	assert.deepEqual(ms.map((m) => m.dataset.state),
		['open', 'reveal', 'reveal', 'locked', 'locked', 'locked', 'locked']);
	assert.ok(host.querySelector('.hangar').classList.contains('hangar-compact'));
	h.destroy();
});

await t('destroy() stops the loop; a detached hangar stops itself', async () => {
	const host = document.createElement('div');
	dom.root.appendChild(host);
	const h = mountHangar(host, { store: storeWith(0), createRenderer: () => null });
	dom.tick(16); dom.tick(16);
	h.destroy();
	const before = dom.window.__rafCount;
	dom.tick(16); dom.tick(16);
	assert.equal(dom.window.__rafCount, before, 'no frame after destroy()');
	// Detached without destroy(): the next frame frees it.
	const host2 = document.createElement('div');
	dom.root.appendChild(host2);
	const h2 = mountHangar(host2, { store: storeWith(0), createRenderer: () => null });
	dom.tick(16);
	host2.remove();
	dom.tick(16);
	assert.equal(h2.destroyed, true);
	const after = dom.window.__rafCount;
	dom.tick(16);
	assert.equal(dom.window.__rafCount, after);
});

await t('a hangar attached late (after 5 s) is not freed; one on screen then dropped is', async () => {
	// The end screen builds its hangar before the line holding it types out.
	// The wall clock is pushed 10 s ahead while it waits detached.
	const realNow = performance.now.bind(performance);
	let skew = 0;
	const nowDesc = Object.getOwnPropertyDescriptor(performance, 'now');
	Object.defineProperty(performance, 'now', { value: () => realNow() + skew, configurable: true, writable: true });
	try {
		const host = document.createElement('div');
		const h = mountHangar(host, { store: storeWith(6), reveal: 1, createRenderer: () => null });
		dom.tick(16);                  // detached: pauses, polls
		skew = 10_000;
		await new Promise((r) => setTimeout(r, 300));   // the poll re-schedules a frame
		dom.tick(10_000);
		assert.equal(h.destroyed, false, 'still waiting for its host');
		dom.root.appendChild(host);
		await new Promise((r) => setTimeout(r, 300));
		dom.tick(16);
		assert.equal(h.destroyed, false, 'attached late, alive');
		assert.equal(host.querySelectorAll('.hangar-m').length, 7);
		host.remove();
		dom.tick(16);
		assert.equal(h.destroyed, true, 'seen, then dropped: freed');
	} finally {
		if (nowDesc) Object.defineProperty(performance, 'now', nowDesc);
		else delete performance.now;
	}
});

await t('the loop paints at ~30 fps, whatever the display rate', async () => {
	// One renderer.clear() per painted frame.
	let paints = 0;
	const fake = () => ({
		domElement: Object.assign(document.createElement('canvas'), {
			getBoundingClientRect: () => ({ left: 0, top: 0, width: 700, height: 130 }),
		}),
		setPixelRatio() {}, getPixelRatio: () => 1, setSize() {}, clear() { paints++; },
		setScissorTest() {}, setViewport() {}, setScissor() {},
		render() {}, dispose() {}, forceContextLoss() {},
	});
	const host = document.createElement('div');
	dom.root.appendChild(host);
	const h = mountHangar(host, { store: storeWith(0), createRenderer: fake });
	// The fake DOM lays nothing out: give the row a size so a frame paints.
	const wrap = host.querySelector('.hangar-wrap');
	Object.defineProperty(wrap, 'clientWidth', { value: 700, configurable: true });
	Object.defineProperty(wrap, 'clientHeight', { value: 130, configurable: true });
	for (const st of host.querySelectorAll('.hangar-stage')) st.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0 });
	dom.tick(16);
	assert.equal(paints, 1, 'the first frame paints');
	paints = 0;
	for (let i = 0; i < 60; i++) dom.tick(1000 / 60);    // 1 s at 60 Hz
	const at60 = paints;
	paints = 0;
	for (let i = 0; i < 144; i++) dom.tick(1000 / 144);  // 1 s at 144 Hz
	const at144 = paints;
	h.destroy();
	assert.ok(at60 >= 28 && at60 <= 31, `60 Hz: ${at60} paints/s`);
	assert.ok(at144 >= 26 && at144 <= 31, `144 Hz: ${at144} paints/s`);
});

await t('destroy() disposes the ONE renderer and releases its context at once', async () => {
	// A renderer that records rather than draws — enough for the first frame
	// to build every slot's mesh through it.
	const made = [];
	const fake = () => {
		const r = {
			domElement: document.createElement('canvas'),
			disposed: 0, lost: 0, renders: 0,
			setPixelRatio() {}, getPixelRatio: () => 1, setSize() {}, clear() {},
			setScissorTest() {}, setViewport() {}, setScissor() {},
			render() { r.renders++; },
			dispose() { r.disposed++; },
			forceContextLoss() { r.lost++; },
		};
		made.push(r);
		return r;
	};
	const host = document.createElement('div');
	dom.root.appendChild(host);
	const h = mountHangar(host, { store: storeWith(9), createRenderer: fake });
	dom.tick(16); dom.tick(16);
	assert.equal(made.length, 1, 'one context for the whole row');
	h.destroy();
	assert.equal(made[0].disposed, 1);
	assert.equal(made[0].lost, 1, 'dispose() alone leaves the context to the GC');
	h.destroy();
	assert.equal(made[0].lost, 1, 'twice is harmless');
});

await t('the two lines: the bar in its own span, the closed tier in its own span', async () => {
	const p = progressNode(storeWith(9));
	assert.match(p.textContent, /▓▓▓░{9}  9\/18 TO CLEARANCE 2/);
	assert.equal(p.querySelector('.hangar-bar').textContent, `${'▓'.repeat(3)}${'░'.repeat(9)}`);
	const tl = tiersNode(storeWith(9));
	assert.equal(tl.textContent, 'SIGNALS   TIER I · TIER II   TIER III AT CLEARANCE 2');
	assert.equal(tl.querySelector('.hangar-tier-locked').textContent, 'TIER III AT CLEARANCE 2');
	assert.equal(progressNode(storeWith(40)).textContent, 'CLEARANCE 3 · MAX');
});

dom.restore();
console.log(`\n${n} tests hangar OK`);

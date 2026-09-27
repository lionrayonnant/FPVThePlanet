// Selftest of the signal anchors (issue #185, spec §1: "height is found in
// flight"). The ground probe is a function of (x, z): no Rapier.
// Run: node tools/signal-anchor-selftest.mjs
import assert from 'node:assert/strict';
import { SignalAnchors, RING_M, ABOVE_M, RETRY_S, PROBE_RANGE_M } from '../src/signal-anchor.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

const toLocal = (lat, lon) => ({ x: lon * 1000, z: -lat * 1000 });
const sig = (id, lat, lon) => ({ id, lat, lon });
const settle = (a, s) => { for (let i = 0; i < s * 20; i++) a.update(0.05); };

t('no hit yet: no anchor; the tile streams in: the anchor appears and rises', () => {
	let streamed = false;
	const a = new SignalAnchors({ toLocal, ground: () => (streamed ? 40 : null) });
	a.set([sig('a', 0, 0)]);
	settle(a, 2);
	assert.equal(a.pos('a'), null);
	streamed = true;
	settle(a, 3);
	const p = a.pos('a');
	assert.ok(p && Math.abs(p.y - (40 + ABOVE_M)) < 0.5, JSON.stringify(p));
});

t('the highest sample of the ring wins: the spire, not the courtyard', () => {
	// A spire 5 m east of the centre, inside RING_M.
	const ground = (x, z) => (Math.hypot(x - 5, z) < RING_M * 0.6 ? 80 : 10);
	const a = new SignalAnchors({ toLocal, ground });
	a.set([sig('a', 0, 0)]);
	settle(a, 3);
	assert.ok(Math.abs(a.pos('a').y - (80 + ABOVE_M)) < 0.5);
});

t('set() again keeps a resolved anchor as it is; a new signal starts unresolved', () => {
	const a = new SignalAnchors({ toLocal, ground: () => 30 });
	a.set([sig('a', 0, 0)]);
	settle(a, 2);
	const before = a.pos('a');
	assert.ok(before);
	a.set([sig('a', 0, 0), sig('b', 0.001, 0)]);
	assert.deepEqual(a.pos('a'), before);
	assert.equal(a.pos('b'), null);
	a.set([sig('b', 0.001, 0)]);
	assert.equal(a.pos('a'), null, 'a dropped id is gone');
});

t('x and z come from toLocal', () => {
	const a = new SignalAnchors({ toLocal, ground: () => 0 });
	a.set([sig('a', 0.001, 0.002)]);
	settle(a, 1);
	assert.deepEqual([a.pos('a').x, a.pos('a').z], [2, -1]);
});

t('probing is budgeted and retried no faster than RETRY_S', () => {
	let calls = 0;
	const a = new SignalAnchors({ toLocal, ground: () => { calls++; return null; } });
	a.set(Array.from({ length: 20 }, (_, i) => sig(`s${i}`, i, i)));
	a.update(0.05);
	assert.ok(calls <= 4 * 9, `first frame: ${calls} probes`);
	calls = 0;
	for (let i = 0; i < 20; i++) a.update(0.05); // 1 s
	// 20 anchors, each at most once per RETRY_S, 9 samples each
	assert.ok(calls <= Math.ceil(1 / RETRY_S + 1) * 20 * 9, String(calls));
});

t('a higher mesh later raises the anchor; a lower one never lowers it', () => {
	let h = 20;
	const a = new SignalAnchors({ toLocal, ground: () => h });
	a.set([sig('a', 0, 0)]);
	settle(a, 2);
	h = 60;
	settle(a, 7);
	assert.ok(a.pos('a').y > 60);
	h = 5;
	settle(a, 7);
	assert.ok(a.pos('a').y > 60);
});

t('set() replaces the list; unknown ids read null', () => {
	const a = new SignalAnchors({ toLocal, ground: () => 1 });
	a.set([sig('a', 0, 0)]);
	settle(a, 1);
	a.set([sig('b', 0, 0)]);
	assert.equal(a.pos('a'), null);
	assert.equal(a.pos('nope'), null);
});

t('only anchors within PROBE_RANGE_M of the camera are probed', () => {
	const probed = new Set();
	// 'far' sits 2 km east (toLocal: x = lon * 1000).
	const a = new SignalAnchors({ toLocal, ground: (x) => { probed.add(x > 1000 ? 'far' : 'near'); return 10; } });
	a.set([sig('near', 0, 0), sig('far', 0, 2)]);
	for (let i = 0; i < 40; i++) a.update(0.05, { x: 0, z: 0 });
	assert.equal(PROBE_RANGE_M, 500);
	assert.ok(a.pos('near'));
	assert.equal(a.pos('far'), null);
	assert.ok(!probed.has('far'), 'no probe out of range');
	for (let i = 0; i < 40; i++) a.update(0.05, { x: 1700, z: 0 });
	assert.ok(a.pos('far'), 'probed once the camera comes within range');
});

console.log(`signal-anchor: ${n} ok`);

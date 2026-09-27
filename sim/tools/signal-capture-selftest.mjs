// Selftest of the capture state machine (issue #185, spec §3). No DOM, no
// THREE, no Rapier: synthetic camera poses and a clock advanced by hand.
// Run: node tools/signal-capture-selftest.mjs
import assert from 'node:assert/strict';
import { SignalCapture, CONE_DEG, HOLD_S, DRAIN_RATE, RANGE_M, SHOW_M } from '../src/signal-capture.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

// Camera at the origin looking north (-Z is north in local ENU: Z = south).
const camAt = (x = 0, y = 0, z = 0, fx = 0, fy = 0, fz = -1) => ({ x, y, z, fx, fy, fz });
const target = (id, pos, tier = 1, resolved = false) => ({ id, tier, pos, resolved });
const run = (sc, seconds, args, step = 0.05) => {
	let last = null;
	for (let s = 0; s < seconds - 1e-9; s += step) {
		sc.update({ dt: step, ...args });
		if (sc.out.uplinked) last = sc.out.uplinked;
	}
	return last;
};
const row = (sc, id) => sc.out.rows.find((r) => r.id === id);

t('constants from the spec', () => {
	assert.equal(CONE_DEG, 12);
	assert.equal(HOLD_S, 6);
	assert.equal(DRAIN_RATE, 1 / 3);
	assert.deepEqual(RANGE_M[1], [30, 250]);
	assert.equal(SHOW_M, 400);
});

t('held dead ahead for 6 s in FPV with a clear line: UPLINKED once, then resolved', () => {
	const sc = new SignalCapture();
	sc.setTargets([target('a', { x: 0, y: 0, z: -100 })]);
	const args = { cam: camAt(), fpv: true, los: () => true };
	assert.equal(run(sc, HOLD_S - 0.2, args), null);
	assert.equal(row(sc, 'a').state, 'capturing');
	assert.equal(run(sc, 0.4, args), 'a');
	assert.equal(row(sc, 'a').state, 'resolved');
	sc.update({ dt: 0.05, ...args });
	assert.equal(sc.out.uplinked, null, 'consume-once');
	assert.equal(run(sc, 10, args), null, 'never twice');
});

t('outside the cone, too close, too far, or hidden: never captured', () => {
	const args = { cam: camAt(), fpv: true, los: () => true };
	const off = new SignalCapture();
	// 13° to the east at 100 m
	off.setTargets([target('a', { x: Math.tan(13 * Math.PI / 180) * 100, y: 0, z: -100 })]);
	assert.equal(run(off, 10, args), null);
	assert.equal(row(off, 'a').state, 'near');
	const close = new SignalCapture();
	close.setTargets([target('a', { x: 0, y: 0, z: -20 })]);
	assert.equal(run(close, 10, args), null);
	const far = new SignalCapture();
	far.setTargets([target('a', { x: 0, y: 0, z: -300 })]);
	assert.equal(run(far, 10, args), null);
	assert.equal(row(far, 'a').state, 'near', 'shown at 300 m, not capturable');
	const hidden = new SignalCapture();
	hidden.setTargets([target('a', { x: 0, y: 0, z: -500 })]);
	sc_update(hidden, args);
	assert.equal(row(hidden, 'a').state, 'hidden');
});
function sc_update(sc, args) { sc.update({ dt: 0.05, ...args }); }

t('tier III reaches farther', () => {
	const sc = new SignalCapture();
	sc.setTargets([target('peak', { x: 0, y: 0, z: -400 }, 3)]);
	assert.equal(run(sc, HOLD_S + 0.2, { cam: camAt(), fpv: true, los: () => true }), 'peak');
});

t('chase view or a blocked line: the gauge does not rise, and drains slowly', () => {
	const sc = new SignalCapture();
	sc.setTargets([target('a', { x: 0, y: 0, z: -100 })]);
	run(sc, 3, { cam: camAt(), fpv: true, los: () => true });
	const g = row(sc, 'a').gauge;
	assert.ok(Math.abs(g - 0.5) < 0.02, String(g));
	run(sc, 3, { cam: camAt(), fpv: false, los: () => true });
	assert.equal(row(sc, 'a').state, 'held');
	assert.ok(Math.abs(row(sc, 'a').gauge - (0.5 - 3 * DRAIN_RATE / HOLD_S)) < 0.02);
	run(sc, 1, { cam: camAt(), fpv: true, los: () => false });
	assert.ok(row(sc, 'a').gauge < 0.34);
});

t('a bad pass costs seconds, not the capture (cumulative hold)', () => {
	const sc = new SignalCapture();
	sc.setTargets([target('a', { x: 0, y: 0, z: -100 })]);
	const on = { cam: camAt(), fpv: true, los: () => true };
	const away = { cam: camAt(0, 0, 0, 1, 0, 0), fpv: true, los: () => true };
	run(sc, 4, on);
	run(sc, 1.5, away);
	// 4 s held, 0.5 s lost: 2.5 s more is not enough, 2.6 s... is.
	assert.equal(run(sc, 2.4, on), null);
	assert.equal(run(sc, 0.3, on), 'a');
});

t('frozen (dt 0): nothing moves, uplinked still drains', () => {
	const sc = new SignalCapture();
	sc.setTargets([target('a', { x: 0, y: 0, z: -100 })]);
	const args = { cam: camAt(), fpv: true, los: () => true };
	run(sc, HOLD_S + 0.1, args);
	sc.setTargets([target('a', { x: 0, y: 0, z: -100 }, 1, true), target('b', { x: 0, y: 0, z: -120 })]);
	run(sc, 2, args);
	const g = row(sc, 'b').gauge;
	sc.update({ dt: 0, ...args });
	assert.equal(row(sc, 'b').gauge, g);
});

t('the focus is the target nearest the axis, los asked only for it, no flicker', () => {
	const sc = new SignalCapture();
	sc.setTargets([
		target('left', { x: -Math.tan(5 * Math.PI / 180) * 100, y: 0, z: -100 }),
		target('right', { x: Math.tan(4 * Math.PI / 180) * 100, y: 0, z: -100 }),
	]);
	const asked = [];
	sc.update({ dt: 0.05, cam: camAt(), fpv: true, los: (tg) => { asked.push(tg.id); return true; } });
	assert.equal(sc.out.focus, 'right');
	assert.deepEqual(asked, ['right']);
	// Turn 1.5° left: left is now at 3.5°, right at 5.5° — the focus holds for FOCUS_SWITCH_S.
	const yaw = -1.5 * Math.PI / 180;
	const turned = camAt(0, 0, 0, Math.sin(yaw), 0, -Math.cos(yaw));
	sc.update({ dt: 0.2, cam: turned, fpv: true, los: () => true });
	assert.equal(sc.out.focus, 'right');
	run(sc, 0.5, { cam: turned, fpv: true, los: () => true });
	assert.equal(sc.out.focus, 'left');
});

t('setTargets keeps the gauges of ids still present, drops the others', () => {
	const sc = new SignalCapture();
	sc.setTargets([target('a', { x: 0, y: 0, z: -100 })]);
	run(sc, 3, { cam: camAt(), fpv: true, los: () => true });
	sc.setTargets([target('a', { x: 0, y: 0, z: -100 }), target('b', null)]);
	sc.update({ dt: 0.05, cam: camAt(), fpv: false, los: () => true });
	assert.ok(row(sc, 'a').gauge > 0.45);
	assert.equal(row(sc, 'b').state, 'hidden', 'no anchor yet');
});

t('markResolved: a signal resolved elsewhere stops at once', () => {
	const sc = new SignalCapture();
	sc.setTargets([target('a', { x: 0, y: 0, z: -100 })]);
	sc.markResolved('a');
	assert.equal(run(sc, 10, { cam: camAt(), fpv: true, los: () => true }), null);
	assert.equal(row(sc, 'a').state, 'resolved');
});

t('a resolved signal beyond SHOW_M is hidden; within it, resolved', () => {
	const sc = new SignalCapture();
	sc.setTargets([target('far', { x: 0, y: 0, z: -1200 }, 1, true), target('near', { x: 0, y: 0, z: -100 }, 1, true)]);
	sc.update({ dt: 0.05, cam: camAt(), fpv: true, los: () => true });
	assert.equal(row(sc, 'far').state, 'hidden');
	assert.equal(row(sc, 'near').state, 'resolved');
});

console.log(`signal-capture: ${n} ok`);

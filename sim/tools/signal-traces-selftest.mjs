// Selftest of src/signal-traces.js (issue #185 lot 4): which signal gets the
// one trace, probe → build → validate within the ray budget, the follower to
// the end, the fallback to the hold after 3 attempts, the re-validation and
// lift after a collider flush, the drop when the drone leaves. A fake world
// (analytic rays), a fake line.
// Run: node tools/signal-traces-selftest.mjs
import assert from 'node:assert/strict';
import { SignalTraces, TRACE_RANGE_M, DROP_RANGE_M, UNDER_NEAR_M, PROBE_RAYS, VALIDATE_RAYS, RETRY_S, SWITCH_GAIN_M, SWITCH_S, PICK_S } from '../src/signal-traces.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

// Ground plane + axis-aligned solid boxes; counts rays.
class World {
	constructor({ boxes = [], miss = false } = {}) {
		this.boxes = boxes;
		this.miss = miss;
		this.rays = 0;
		this._r = { blocked: false, span: 0 };
		this.groundBelow = (x, y, z, max = 500) => {
			this.rays++;
			if (this.miss) return null;
			let best = y >= 0 ? 0 : -Infinity;
			for (const b of this.boxes) if (this.inBox(b, x, z) && b.y1 <= y) best = Math.max(best, b.y1);
			return best === -Infinity || y - best > max ? null : best;
		};
		this.rayUp = (x, y, z, max = 500) => {
			this.rays++;
			if (this.coarse) return null; // LIVE far away: no underside yet
			let best = Infinity;
			for (const b of this.boxes) if (this.inBox(b, x, z) && b.y0 >= y) best = Math.min(best, b.y0);
			return best === Infinity || best - y > max ? null : best;
		};
		this.obstructionBetween = (ax, ay, az, bx, by, bz) => {
			this.rays++;
			const r = this._r;
			r.blocked = false;
			const d = Math.hypot(bx - ax, by - ay, bz - az);
			const steps = Math.max(1, Math.ceil(d / 0.25));
			for (let i = 0; i <= steps && !r.blocked; i++) {
				const u = i / steps;
				r.blocked = this.solid(ax + (bx - ax) * u, ay + (by - ay) * u, az + (bz - az) * u);
			}
			return r;
		};
	}
	inBox(b, x, z) { return x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1; }
	solid(x, y, z) {
		if (y < 0) return true;
		for (const b of this.boxes) if (this.inBox(b, x, z) && y >= b.y0 && y <= b.y1) return true;
		return false;
	}
}

class FakeLine {
	constructor() { this.shown = 0; this.hidden = 0; this.trace = null; this.progress = null; }
	show(trace) { this.shown++; this.trace = trace; }
	setProgress(p, state, fade) { this.progress = { p, state, fade }; }
	hide() { this.hidden++; this.trace = null; }
}

// A 100 m tower at the origin (20 × 20 m); its anchor sits 3 m over the top.
const tower = () => ({ x0: -10, x1: 10, z0: -10, z1: 10, y0: 0, y1: 100 });
const sig = (id, tier = 2, extra = {}) => ({ id, tier, kind: 'TOWER', heightM: 100, lat: 0, lon: 0, ...extra });
const anchors = { 'wd:Q1': { x: 0, y: 103, z: 0 }, 'wd:Q2': { x: 600, y: 103, z: 0 }, 'wd:Q3': { x: 150, y: 20, z: 0 }, 'wd:Q4': { x: 0, y: 17, z: 0 } };

function setup({ world = new World({ boxes: [tower()] }), signals = [sig('wd:Q1')], open = () => true, at = anchors } = {}) {
	const line = new FakeLine();
	const tr = new SignalTraces({
		groundBelow: world.groundBelow, rayUp: world.rayUp, obstructionBetween: world.obstructionBetween,
		anchorOf: (id) => (at[id] ? { ...at[id] } : null), line,
	});
	return { tr, line, world, signals, open };
}

// Steps until the trace is laid (or gave up); the rays of each frame are counted.
function settle(ctx, pos, frames = 200) {
	let maxRays = 0;
	for (let i = 0; i < frames; i++) {
		const before = ctx.world.rays;
		ctx.tr.update({ dt: 1 / 60, followDt: 1 / 60, pos, signals: ctx.signals, isOpen: ctx.open });
		maxRays = Math.max(maxRays, ctx.world.rays - before);
		if (ctx.tr.trace || ctx.tr.out.failed) break;
	}
	return maxRays;
}

const pointOf = (trace, i) => ({ x: trace.points[3 * i], y: trace.points[3 * i + 1], z: trace.points[3 * i + 2] });

t('picks the nearest open signal of any tier within 300 m, never encrypted, resolved or far', () => {
	const pos = { x: 200, y: 30, z: 0 };
	const cases = [
		[[sig('wd:Q1', 1)], 'wd:Q1'],
		[[sig('wd:Q1', 0)], null],                    // no tier: no trace
		[[sig('wd:Q1', 3), sig('wd:Q3', 1)], 'wd:Q3'], // tier I at 50 m beats tier III at 200 m
		[[sig('wd:Q1', 2, { encrypted: true })], null],
		[[sig('wd:Q2')], null],                        // 400 m away
		[[sig('wd:Q1'), sig('wd:Q3', 3)], 'wd:Q3'],     // 50 m beats 200 m
		[[sig('wd:Q1')], 'wd:Q1'],
	];
	for (const [signals, want] of cases) {
		const ctx = setup({ signals });
		ctx.tr.update({ dt: 1 / 60, pos, signals, isOpen: () => true });
		assert.equal(ctx.tr.id, want, JSON.stringify(signals.map((s) => s.id)));
	}
	const ctx = setup({ open: (id) => id !== 'wd:Q1' });
	ctx.tr.update({ dt: 1 / 60, pos, signals: ctx.signals, isOpen: ctx.open });
	assert.equal(ctx.tr.id, null, 'resolved');
	assert.equal(TRACE_RANGE_M, 300);
});

t('probe → build → validate: a spiral laid clear of the tower, ≤ 40 rays in every frame', () => {
	const ctx = setup();
	const maxRays = settle(ctx, { x: 200, y: 30, z: 0 });
	assert.ok(ctx.tr.trace, 'laid');
	assert.equal(ctx.tr.shape, 'spiral');
	assert.equal(ctx.line.shown, 1);
	assert.equal(ctx.line.trace, ctx.tr.trace);
	assert.ok(maxRays <= 40 && maxRays <= Math.max(PROBE_RAYS, VALIDATE_RAYS + 2), `max ${maxRays} rays/frame`);
	const P = ctx.tr.trace.points;
	for (let i = 0; i < P.length / 3; i++) assert.ok(!ctx.world.solid(P[3 * i], P[3 * i + 1], P[3 * i + 2]), `point ${i} inside`);
	assert.ok(pointOf(ctx.tr.trace, 0).x > 0, 'the entry faces the drone (east)');
});

t('a bridge with no deck seen from afar is probed again from 150 m, then laid under', () => {
	// A deck along z; from 250 m, LIVE has no underside yet (coarse).
	const world = new World({ boxes: [{ x0: -5, x1: 5, z0: -150, z1: 150, y0: 12, y1: 14 }] });
	world.coarse = true;
	const ctx = setup({ world, signals: [sig('wd:Q4', 3, { kind: 'BRIDGE', heightM: null })] });
	settle(ctx, { x: 250, y: 30, z: 0 }, 120);
	assert.equal(ctx.tr.trace, null, 'no orbit laid from afar');
	assert.equal(ctx.tr.active.phase, 'near');
	world.coarse = false; // refined on the way in
	settle(ctx, { x: 200, y: 30, z: 0 }, 60);
	assert.equal(ctx.tr.active.phase, 'near', 'still beyond 150 m');
	const maxRays = settle(ctx, { x: UNDER_NEAR_M - 10, y: 30, z: 0 }, 400);
	assert.ok(ctx.tr.trace, 'laid');
	assert.equal(ctx.tr.shape, 'under');
	assert.ok(maxRays <= 40, `max ${maxRays} rays/frame`);
	// Once only: seen near and still no deck, it settles for the orbit.
	const w2 = new World({ boxes: [{ x0: -5, x1: 5, z0: -150, z1: 150, y0: 12, y1: 14 }] });
	w2.coarse = true;
	const c2 = setup({ world: w2, signals: [sig('wd:Q4', 3, { kind: 'BRIDGE', heightM: null })] });
	settle(c2, { x: 250, y: 30, z: 0 }, 120);
	settle(c2, { x: 100, y: 30, z: 0 }, 400);
	assert.equal(c2.tr.shape, 'orbit');
});

t('flown to the end: done with the shape and the seconds on it, the line gone', () => {
	const ctx = setup();
	settle(ctx, { x: 200, y: 30, z: 0 });
	const trace = ctx.tr.trace;
	const N = trace.points.length / 3;
	let done = null;
	for (let i = 0; i < N && !done; i++) {
		ctx.tr.update({ dt: 0.25, followDt: 0.25, pos: pointOf(trace, i), signals: ctx.signals, isOpen: ctx.open });
		if (i === 3) assert.equal(ctx.line.progress.state, 'on');
		done = ctx.tr.out.done;
		if (done) {
			assert.equal(ctx.tr.out.doneShape, 'spiral');
			assert.ok(Math.abs(ctx.tr.out.doneS - 0.25 * i) < 1e-6, `elapsed ${ctx.tr.out.doneS}`);
		}
	}
	assert.equal(done, 'wd:Q1');
	assert.equal(ctx.tr.id, null);
	assert.ok(ctx.line.hidden >= 1);
	// Uplinked now: not picked again.
	ctx.open = () => false;
	ctx.tr.update({ dt: 1, pos: { x: 200, y: 30, z: 0 }, signals: ctx.signals, isOpen: ctx.open });
	assert.equal(ctx.tr.id, null);
});

t('followDt = 0 (disarmed) freezes the follower, not the generation', () => {
	const ctx = setup();
	for (let i = 0; i < 100 && !ctx.tr.trace; i++) {
		ctx.tr.update({ dt: 1 / 60, followDt: 0, pos: { x: 200, y: 30, z: 0 }, signals: ctx.signals, isOpen: ctx.open });
	}
	assert.ok(ctx.tr.trace);
	ctx.tr.update({ dt: 1 / 60, followDt: 0, pos: pointOf(ctx.tr.trace, 0), signals: ctx.signals, isOpen: ctx.open });
	assert.equal(ctx.tr.follower.out.state, 'waiting');
});

t('a partial profile retries after RETRY_S; 3 attempts and the signal falls back to the hold', () => {
	const world = new World({ boxes: [tower()], miss: true });
	const ctx = setup({ world });
	let failed = null, frames = 0;
	for (; frames < 60 * 10 && !failed; frames++) {
		ctx.tr.update({ dt: 1 / 60, pos: { x: 200, y: 30, z: 0 }, signals: ctx.signals, isOpen: ctx.open });
		failed = ctx.tr.out.failed;
	}
	assert.equal(failed, 'wd:Q1');
	assert.ok(frames / 60 >= 2 * RETRY_S - 0.05, `gave up after ${frames} frames`);
	assert.ok(ctx.tr.failed.has('wd:Q1'));
	assert.equal(ctx.line.shown, 0);
	for (let i = 0; i < 60; i++) ctx.tr.update({ dt: 1 / 60, pos: { x: 200, y: 30, z: 0 }, signals: ctx.signals, isOpen: ctx.open });
	assert.equal(ctx.tr.id, null, 'never picked again this flight');
	ctx.tr.reset();
	assert.equal(ctx.tr.failed.size, 0, 'a new flight tries again');
});

t('every attempt blocked: the signal falls back to the hold', () => {
	// A slab over the whole neighbourhood from 105 m up, taller than the probe's
	// start (a down ray born inside it sees nothing): the top of every trace is in it.
	const world = new World({ boxes: [tower(), { x0: -500, x1: 500, z0: -500, z1: 500, y0: 105, y1: 1000 }] });
	const ctx = setup({ world });
	const maxRays = settle(ctx, { x: 200, y: 30, z: 0 }, 400);
	assert.equal(ctx.tr.out.failed, 'wd:Q1');
	assert.ok(maxRays <= 40, `${maxRays} rays/frame`);
});

t('a collider flush: a block ahead lifts the unflown part over it, the flown part stays', () => {
	const ctx = setup();
	settle(ctx, { x: 200, y: 30, z: 0 });
	const trace = ctx.tr.trace;
	const N = trace.points.length / 3;
	// Fly the first quarter.
	const q = Math.floor(N / 4);
	for (let i = 0; i <= q; i++) ctx.tr.update({ dt: 0.2, pos: pointOf(trace, i), signals: ctx.signals, isOpen: ctx.open });
	const flownIdx = ctx.tr.follower.out.index;
	const flown = trace.points.slice(0, 3 * (flownIdx + 1));
	// A block appears around a point well ahead (a refined LOD): 8 m tall under it.
	const k = Math.floor(N * 0.7), b = pointOf(trace, k);
	ctx.world.boxes.push({ x0: b.x - 3, x1: b.x + 3, z0: b.z - 3, z1: b.z + 3, y0: 0, y1: b.y + 4 });
	const shown = ctx.line.shown;
	ctx.tr.collidersChanged();
	let maxRays = 0;
	for (let i = 0; i < 60 && ctx.tr.active.revalidate; i++) {
		const before = ctx.world.rays;
		ctx.tr.update({ dt: 1 / 60, followDt: 0, pos: pointOf(trace, q), signals: ctx.signals, isOpen: ctx.open });
		maxRays = Math.max(maxRays, ctx.world.rays - before);
	}
	assert.equal(ctx.tr.active.revalidate, false, 'clear again');
	assert.ok(ctx.tr.active.lifts >= 1);
	assert.ok(ctx.line.shown > shown, 'the line is rebuilt from the lifted trace');
	assert.ok(trace.points[3 * k + 1] >= b.y + 4 + 6 - 1e-3, `lifted to ${trace.points[3 * k + 1]}`);
	assert.deepEqual(trace.points.slice(0, 3 * (flownIdx + 1)), flown, 'the flown part never moves');
	assert.ok(maxRays <= VALIDATE_RAYS + 2, `${maxRays} rays/frame`);
});

t('left behind before the gate: dropped past 450 m, not failed; picked again on return', () => {
	const ctx = setup();
	settle(ctx, { x: 200, y: 30, z: 0 });
	ctx.tr.update({ dt: 1 / 60, pos: { x: DROP_RANGE_M + 10, y: 30, z: 0 }, signals: ctx.signals, isOpen: ctx.open });
	assert.equal(ctx.tr.out.dropped, 'wd:Q1');
	assert.equal(ctx.tr.id, null);
	assert.equal(ctx.tr.failed.size, 0);
	settle(ctx, { x: 200, y: 30, z: 0 });
	assert.ok(ctx.tr.trace, 'laid again');
});

t('reset: the line is hidden and nothing is kept', () => {
	const ctx = setup();
	settle(ctx, { x: 200, y: 30, z: 0 });
	ctx.tr.reset();
	assert.equal(ctx.tr.id, null);
	assert.equal(ctx.tr.trace, null);
	assert.ok(ctx.line.hidden >= 1);
});

t('the active signal resolved or encrypted meanwhile: dropped, out.dropped', () => {
	for (const make of [
		(ctx) => { ctx.open = () => false; },
		(ctx) => { ctx.signals[0].encrypted = true; },
	]) {
		const ctx = setup({ signals: [sig('wd:Q1')] });
		settle(ctx, { x: 200, y: 30, z: 0 });
		assert.ok(ctx.tr.trace);
		make(ctx);
		ctx.tr.update({ dt: 1 / 60, pos: { x: 200, y: 30, z: 0 }, signals: ctx.signals, isOpen: ctx.open });
		assert.equal(ctx.tr.out.dropped, 'wd:Q1');
		assert.equal(ctx.tr.id, null);
		assert.equal(ctx.tr.failed.size, 0, 'dropped, not failed');
		assert.ok(ctx.line.hidden >= 1);
	}
});

t('stop (crash, link dead): the trace is dropped, the hold fallbacks are kept', () => {
	const ctx = setup();
	settle(ctx, { x: 200, y: 30, z: 0 });
	ctx.tr.failed.add('wd:Q9');
	ctx.tr.stop();
	assert.equal(ctx.tr.id, null);
	assert.ok(ctx.line.hidden >= 1);
	assert.ok(ctx.tr.failed.has('wd:Q9'), 'still on the hold');
	ctx.tr.reset();
	assert.equal(ctx.tr.failed.size, 0);
});

t('a collider flush mid-validation restarts the validation', () => {
	const ctx = setup();
	const pos = { x: 200, y: 30, z: 0 };
	for (let i = 0; i < 200 && ctx.tr.active?.phase !== 'validate'; i++) {
		ctx.tr.update({ dt: 1 / 60, pos, signals: ctx.signals, isOpen: ctx.open });
	}
	assert.equal(ctx.tr.active.phase, 'validate');
	ctx.tr.update({ dt: 1 / 60, pos, signals: ctx.signals, isOpen: ctx.open });
	assert.equal(ctx.tr.active.phase, 'validate', 'more than one frame of validation');
	assert.ok(ctx.tr.probe._vCursor > 0, 'validation under way');
	ctx.tr.collidersChanged();
	assert.equal(ctx.tr.probe._vCursor, 0, 'restarted');
	assert.equal(ctx.tr.active.phase, 'validate');
	settle(ctx, pos);
	assert.ok(ctx.tr.trace, 'laid after the restart');
});

t('tier I: a half-turn orbit laid with the 15 m tolerance', () => {
	// A 20 m chapel (20 × 20 m): an orbit, level, half a turn.
	const world = new World({ boxes: [{ x0: -10, x1: 10, z0: -10, z1: 10, y0: 0, y1: 20 }] });
	const ctx = setup({ world, signals: [sig('wd:Q5', 1, { kind: 'CHAPEL', heightM: 20 })], at: { 'wd:Q5': { x: 0, y: 23, z: 0 } } });
	const maxRays = settle(ctx, { x: 200, y: 30, z: 0 });
	assert.ok(ctx.tr.trace, 'laid');
	assert.equal(ctx.tr.shape, 'orbit');
	assert.equal(ctx.tr.trace.tolerance, 15);
	assert.equal(ctx.tr.follower.tolerance, 15);
	const P = ctx.tr.trace.points, m = P.length / 3;
	for (let i = 0; i < m; i++) assert.ok(Math.abs(P[3 * i + 1] - P[1]) < 1e-3, 'level');
	const R = Math.hypot(P[0], P[2]);
	assert.ok(Math.abs(ctx.tr.trace.length - Math.PI * R) < 3, `half a turn: ${ctx.tr.trace.length} vs π·${R.toFixed(1)}`);
	assert.ok(maxRays <= 40, `max ${maxRays} rays/frame`);
});

t('switching: a trace not entered gives way only to a place 100 m nearer for 2 s', () => {
	// Two chapels 250 m apart on the X axis; the drone starts near A.
	const box = (cx) => ({ x0: cx - 10, x1: cx + 10, z0: -10, z1: 10, y0: 0, y1: 20 });
	const world = new World({ boxes: [box(0), box(250)] });
	const at = { A: { x: 0, y: 23, z: 0 }, B: { x: 250, y: 23, z: 0 } };
	const signals = [sig('A', 1, { kind: 'CHAPEL', heightM: 20 }), sig('B', 1, { kind: 'CHAPEL', heightM: 20 })];
	const ctx = setup({ world, signals, at });
	settle(ctx, { x: 60, y: 30, z: 60 });
	assert.equal(ctx.tr.id, 'A');
	assert.ok(ctx.tr.trace);
	const dropped = [];
	const run = (pos, s) => {
		const ids = new Set();
		for (let i = 0; i < Math.round(s * 60); i++) {
			ctx.tr.update({ dt: 1 / 60, followDt: 1 / 60, pos, signals, isOpen: () => true });
			if (ctx.tr.out.dropped) dropped.push(ctx.tr.out.dropped);
			ids.add(ctx.tr.id);
		}
		return ids;
	};
	// Midway (B only 40 m nearer): A stays, however long.
	assert.deepEqual([...run({ x: 145, y: 30, z: 60 }, 10)], ['A']);
	// B 150 m nearer: not before SWITCH_S…
	assert.deepEqual([...run({ x: 200, y: 30, z: 60 }, SWITCH_S - 2 * PICK_S)], ['A']);
	// …then B, and it keeps it while the drone wanders back to midway.
	run({ x: 200, y: 30, z: 60 }, 2 * PICK_S + PICK_S + 0.1);
	assert.equal(ctx.tr.id, 'B');
	assert.deepEqual(dropped, ['A'], 'the capture is told A has no trace any more');
	assert.ok(!ctx.tr.failed.has('A'), 'A is not failed: it may be laid again later');
	settle(ctx, { x: 200, y: 30, z: 60 });
	assert.ok(ctx.tr.trace, 'B laid');
	const back = run({ x: 110, y: 30, z: 60 }, 10);
	assert.deepEqual([...back], ['B'], 'no bounce back at midway');
	assert.equal(SWITCH_GAIN_M, 100);
	// Entered: never switched away, even with the other one right there.
	const f = ctx.tr.follower;
	const P = ctx.tr.trace.points;
	f.update({ dt: 1 / 60, pos: { x: P[0], y: P[1], z: P[2] } });
	assert.notEqual(f.out.state, 'waiting');
	assert.deepEqual([...run({ x: 20, y: 30, z: 0 }, 5)], ['B']);
});

console.log(`signal-traces: ${n} ok`);

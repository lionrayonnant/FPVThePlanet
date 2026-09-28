// Selftest of src/trace-probe.js (issue #185): the polar profile, the bridge
// axis, incremental validation, the lift, the per-call ray budget, and probe →
// buildTrace → validate on a fake world (a box building, a bridge deck over
// water, a cone peak). No Rapier: the rays are analytic.
// Run: node tools/trace-probe-selftest.mjs
import assert from 'node:assert/strict';
import {
	TraceProbe, RINGS_M, ANGLES, VALIDATE_CLEAR, VALIDATE_PENDING, LIFT_BLEND_M,
	liftTrace, liftStart, liftBlend,
} from '../src/trace-probe.js';
import { buildTrace } from './trace-model.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} ${a} vs ${b}`);
const GRID = 1 + (RINGS_M.length - 1) * ANGLES;

// ---------------------------------------------------------------- fake world
// Ground plane, axis-aligned boxes (shells: a ray starting inside hits the
// face ahead) and cones. Counts every call; `miss(x, z)` blanks a region (the
// edge of the streamed window).
class World {
	constructor({ ground = 0, boxes = [], cones = [], miss = null } = {}) {
		Object.assign(this, { ground, boxes, cones, miss });
		this.calls = { down: 0, up: 0, obs: 0 };
		this._r = { blocked: false, span: 0 };
		this.groundBelow = this.groundBelow.bind(this);
		this.rayUp = this.rayUp.bind(this);
		this.obstructionBetween = this.obstructionBetween.bind(this);
	}
	coneH(c, x, z) {
		const r = Math.hypot(x - c.x, z - c.z);
		return r < c.R ? c.base + (c.apex - c.base) * (1 - r / c.R) : -Infinity;
	}
	inBox(b, x, z) { return x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1; }
	groundBelow(x, y, z, max = 500) {
		this.calls.down++;
		if (this.miss?.(x, z)) return null;
		let best = this.ground <= y ? this.ground : -Infinity;
		for (const b of this.boxes) {
			if (!this.inBox(b, x, z)) continue;
			if (b.y1 <= y) best = Math.max(best, b.y1);
			else if (b.y0 <= y) best = Math.max(best, b.y0);
		}
		for (const c of this.cones) { const h = this.coneH(c, x, z); if (h <= y) best = Math.max(best, h); }
		return best === -Infinity || y - best > max ? null : best;
	}
	rayUp(x, y, z, max = 500) {
		this.calls.up++;
		if (this.miss?.(x, z)) return null;
		let best = this.ground >= y ? this.ground : Infinity;
		for (const b of this.boxes) {
			if (!this.inBox(b, x, z)) continue;
			if (b.y0 >= y) best = Math.min(best, b.y0);
			else if (b.y1 > y) best = Math.min(best, b.y1);
		}
		for (const c of this.cones) { const h = this.coneH(c, x, z); if (h > y) best = Math.min(best, h); }
		return best === Infinity || best - y > max ? null : best;
	}
	solid(x, y, z) {
		if (y < this.ground) return true;
		for (const b of this.boxes) if (this.inBox(b, x, z) && y >= b.y0 && y <= b.y1) return true;
		for (const c of this.cones) if (y < this.coneH(c, x, z)) return true;
		return false;
	}
	obstructionBetween(ax, ay, az, bx, by, bz) {
		this.calls.obs++;
		const r = this._r;
		r.blocked = false; r.span = 0;
		const d = Math.hypot(bx - ax, by - ay, bz - az);
		const steps = Math.max(1, Math.ceil(d / 0.1));
		for (let i = 0; i <= steps; i++) {
			const u = i / steps;
			if (this.solid(ax + (bx - ax) * u, ay + (by - ay) * u, az + (bz - az) * u)) { r.blocked = true; break; }
		}
		return r;
	}
	total() { return this.calls.down + this.calls.up + this.calls.obs; }
}

const box = (x0, x1, z0, z1, y0, y1) => ({ x0, x1, z0, z1, y0, y1 });
const building = () => new World({ boxes: [box(-15, 15, -15, 15, 0, 40)] });
const bridge = (extra = []) => new World({ boxes: [box(-150, 150, -5, 5, 12, 14), ...extra] });
const peak = () => new World({ cones: [{ x: 0, z: 0, R: 150, base: 0, apex: 200 }] });

// Runs a probe to completion; checks no call exceeds the budget.
function probe(world, anchor, { axis = false, budget = 24 } = {}) {
	const p = new TraceProbe({ ...world, groundBelow: world.groundBelow, rayUp: world.rayUp, obstructionBetween: world.obstructionBetween, raysPerFrame: budget });
	p.start(anchor, { axis });
	let profile = null, frames = 0;
	while (!profile && frames < 100) {
		const before = world.total();
		profile = p.step();
		assert.ok(world.total() - before <= budget, `frame ${frames}: ${world.total() - before} rays > ${budget}`);
		frames++;
	}
	assert.ok(profile, 'the probe never completed');
	return { profile, frames, probe: p };
}

function firstBlocked(world, trace, from = 0) {
	const P = trace.points;
	for (let i = from; i < P.length / 3 - 1; i++) {
		if (world.obstructionBetween(P[3 * i], P[3 * i + 1], P[3 * i + 2], P[3 * i + 3], P[3 * i + 4], P[3 * i + 5]).blocked) return i;
	}
	return -1;
}

function validateAll(p, trace, from = 0, budget = 24) {
	let r = VALIDATE_PENDING, frames = 0;
	while (r === VALIDATE_PENDING && frames < 1000) { r = p.validate(trace, from, budget); frames++; }
	return r;
}

const B_ANCHOR = { x: 0, y: 43, z: 0 };
const BR_ANCHOR = { x: 0, y: 17, z: 0 };
const PK_ANCHOR = { x: 0, y: 203, z: 0 };
const APPROACH = { x: 200, z: 30 };

// --------------------------------------------------------------------- tests
t('profile of a box building: rings, heights per the grid convention, ground, top', () => {
	const w = building();
	const { profile, frames } = probe(w, B_ANCHOR);
	assert.deepEqual(profile.rings.map((r) => r.r), RINGS_M);
	assert.equal(profile.rings[0].heights.length, 1);
	for (const ring of profile.rings.slice(1)) assert.equal(ring.heights.length, ANGLES);
	assert.equal(profile.rings[0].heights[0], 40);
	assert.ok(profile.rings[1].heights.every((h) => h === 40), 'r = 10 is all roof');
	// r = 20: only the diagonals (14.1, 14.1) fall inside the 30 m box.
	const r20 = [...profile.rings[2].heights];
	r20.forEach((h, k) => assert.equal(h, k % 4 === 2 ? 40 : 0, `r=20 k=${k}`));
	for (const ring of profile.rings.slice(3)) assert.ok(ring.heights.every((h) => h === 0));
	assert.equal(profile.ground, 0);
	assert.equal(profile.top, 40);
	assert.equal(profile.partial, false);
	assert.equal(profile.misses, 0);
	assert.equal(profile.rays, GRID);
	assert.equal(profile.axis, undefined);
	assert.equal(frames, Math.ceil(GRID / 24));
	assert.equal(w.calls.up + w.calls.obs, 0, 'no axis asked: down rays only');
});

t('the angle convention: θ = 2πk/n at (x + r·cos θ, z + r·sin θ)', () => {
	// A wall only south-east of the anchor (+x, +z): k = 2 of 16 at r = 35.
	const w = new World({ boxes: [box(20, 30, 20, 30, 0, 10)] });
	const { profile } = probe(w, { x: 0, y: 20, z: 0 });
	assert.equal(profile.rings[3].heights[2], 10);
	assert.equal(profile.rings[3].heights[14], 0);
});

t('bridge: the deck gives an axis along it, underside, floor, surface, centre', () => {
	const w = bridge();
	const { profile } = probe(w, BR_ANCHOR, { axis: true });
	const ax = profile.axis;
	assert.ok(ax, 'no axis found');
	near(Math.abs(ax.dx), 1, 1e-6, 'dx'); near(ax.dz, 0, 1e-6, 'dz');
	near(ax.deckY, 12, 1e-9, 'deckY'); near(ax.underY, 0, 1e-9, 'underY'); near(ax.topY, 14, 1e-9, 'topY');
	near(ax.cz, 0, 0.5, 'cz'); assert.ok(Math.abs(ax.cx) < 10, `cx ${ax.cx}`);
	assert.ok(w.calls.up === 1, 'one rayUp');
});

t('bridge: a diagonal deck gives a diagonal axis', () => {
	// A deck along x = z, as a staircase of boxes.
	const boxes = [];
	for (let s = -120; s < 120; s += 2) boxes.push(box(s - 4, s + 4, s - 4, s + 4, 12, 14));
	const w = new World({ boxes });
	const { profile } = probe(w, BR_ANCHOR, { axis: true });
	assert.ok(profile.axis, 'no axis found');
	near(Math.abs(profile.axis.dx), Math.SQRT1_2, 0.05);
	assert.ok(profile.axis.dx * profile.axis.dz > 0, 'along x = z');
});

t('bridge with a pier at the centre: the shifted pass is open, the axis stays', () => {
	const w = bridge([box(-2, 2, -6, 6, 0, 12)]);
	const { profile } = probe(w, BR_ANCHOR, { axis: true });
	assert.ok(profile.axis, 'no axis found');
	assert.equal(w.calls.obs, 2, 'centre blocked, +8 m open');
});

t('no axis on a plain building (a blob), nor on a long walled one', () => {
	const w1 = building();
	assert.equal(probe(w1, B_ANCHOR, { axis: true }).profile.axis, undefined);
	assert.equal(w1.calls.up, 0, 'a blob costs no axis rays');
	const w2 = new World({ boxes: [box(-100, 100, -6, 6, 0, 30)] });
	const { profile } = probe(w2, { x: 0, y: 33, z: 0 }, { axis: true });
	assert.equal(profile.axis, undefined);
	assert.equal(w2.calls.obs, 3, 'all three passes walled');
	// A deck too low to fly under (under 6 m).
	const w3 = new World({ boxes: [box(-150, 150, -5, 5, 5, 7)] });
	assert.equal(probe(w3, { x: 0, y: 10, z: 0 }, { axis: true }).profile.axis, undefined);
	// 6 m, Pont Mirabeau's gap in the mesh: an axis.
	const w4 = new World({ boxes: [box(-150, 150, -5, 5, 6, 8)] });
	const ax4 = probe(w4, { x: 0, y: 11, z: 0 }, { axis: true }).profile.axis;
	assert.ok(ax4, 'no axis over a 6 m gap');
	near(ax4.deckY - ax4.underY, 6, 1e-9, 'clearance');
});

t('window edge: misses read NaN; a few are fine, too many flag the profile partial', () => {
	const few = probe(new World({ boxes: [box(-15, 15, -15, 15, 0, 40)], miss: (x) => x > 60 }), B_ANCHOR).profile;
	assert.ok(few.misses > 0 && few.misses <= GRID / 4, `misses ${few.misses}`);
	assert.equal(few.partial, false);
	assert.ok(Number.isNaN(few.rings[5].heights[0]), 'east of the edge: NaN');
	assert.equal(few.ground, 0); assert.equal(few.top, 40);
	const half = probe(new World({ miss: (x) => x > 0 }), B_ANCHOR).profile;
	assert.equal(half.partial, true);
	const centre = probe(new World({ miss: (x, z) => Math.hypot(x, z) < 1 }), B_ANCHOR).profile;
	assert.equal(centre.partial, true, 'the centre itself missed');
	const none = probe(new World({ miss: () => true }), B_ANCHOR, { axis: true }).profile;
	assert.equal(none.partial, true);
	assert.ok(Number.isNaN(none.ground) && Number.isNaN(none.top));
	assert.equal(none.axis, undefined);
	assert.equal(buildTrace({ signal: { id: 'wd:Q1', kind: 'TOWER' }, anchor: B_ANCHOR, profile: none, tier: 2, approach: APPROACH }), null,
		'nothing probed: no trace, T5 falls back');
});

t('budget: every step() stays within raysPerFrame, the axis rays included', () => {
	for (const budget of [1, 5, 10, 24, 40]) {
		const w = bridge();
		const { frames } = probe(w, BR_ANCHOR, { axis: true, budget });
		assert.equal(frames, Math.ceil(w.total() / budget), `budget ${budget}: ${frames} frames for ${w.total()} rays`);
	}
	const w = bridge();
	const { probe: p } = probe(w, BR_ANCHOR, { axis: true });
	const before = w.total();
	p.step(); p.step();
	assert.equal(w.total(), before, 'a finished probe casts nothing more');
});

const orbitOn = (world) => {
	const { profile } = probe(world, B_ANCHOR);
	return buildTrace({ signal: { id: 'wd:Q7', kind: 'CASTLE' }, anchor: B_ANCHOR, profile, tier: 3, approach: APPROACH });
};

t('validate: finds the first blocked segment, incrementally, within the budget', () => {
	const w = building();
	const trace = orbitOn(w);
	assert.ok(trace && trace.shape === 'orbit');
	const p = new TraceProbe({ ...w, raysPerFrame: 7 });
	assert.equal(validateAll(p, trace), VALIDATE_CLEAR);
	// 3 m blocks on the path around points 30 and 70.
	const P = trace.points;
	for (const c of [3 * 30, 3 * 70]) w.boxes.push(box(P[c] - 1.5, P[c] + 1.5, P[c + 2] - 1.5, P[c + 2] + 1.5, P[c + 1] - 1.5, P[c + 1] + 1.5));
	const expect = firstBlocked(w, trace);
	assert.ok(expect >= 28 && expect <= 30, `brute ${expect}`);
	let r = VALIDATE_PENDING, calls = 0;
	while (r === VALIDATE_PENDING) {
		const before = w.calls.obs;
		r = p.validate(trace, 0);
		assert.ok(w.calls.obs - before <= 7, 'over budget');
		calls++;
	}
	assert.equal(r, expect);
	assert.equal(calls, Math.ceil((expect + 1) / 7));
	// From past the block: the next block. A definite answer ends the job,
	// the next call starts afresh.
	const again = firstBlocked(w, trace, expect + 3);
	assert.ok(again >= 68 && again <= 70, `again ${again}`);
	assert.equal(validateAll(p, trace, expect + 3), again);
	assert.equal(validateAll(p, trace, again + 3), firstBlocked(w, trace, again + 3));
	assert.equal(validateAll(p, trace, 0), expect);
});

t('validate: the cursor jumps ahead with fromIndex, and restarts on a new trace', () => {
	const w = building();
	const trace = orbitOn(w);
	const p = new TraceProbe({ ...w, raysPerFrame: 5 });
	assert.equal(p.validate(trace, 0), VALIDATE_PENDING);
	const before = w.calls.obs;
	assert.equal(p.validate(trace, 40), VALIDATE_PENDING);
	const other = { ...trace };
	w.calls.obs = 0;
	const segs = trace.points.length / 3 - 1;
	assert.equal(validateAll(p, other, 0, 1000), VALIDATE_CLEAR);
	assert.equal(w.calls.obs, segs, 'a new trace is validated from its start');
	assert.ok(before > 0);
});

t('resetValidation: after a collider flush the cursor restarts from fromIndex', () => {
	const w = building();
	const trace = orbitOn(w);
	const p = new TraceProbe({ ...w, raysPerFrame: 10 });
	const q = new TraceProbe({ ...w, raysPerFrame: 10 });
	for (const x of [p, q]) {
		assert.equal(x.validate(trace, 0), VALIDATE_PENDING);
		assert.equal(x.validate(trace, 0), VALIDATE_PENDING); // the cursor is at 20
	}
	// The flush refines a collider behind the cursor, ahead of the drone.
	const P = trace.points, c = 3 * 8;
	w.boxes.push(box(P[c] - 1.5, P[c] + 1.5, P[c + 2] - 1.5, P[c + 2] + 1.5, P[c + 1] - 1.5, P[c + 1] + 1.5));
	const expect = firstBlocked(w, trace, 2);
	assert.ok(expect >= 6 && expect <= 8, `brute ${expect}`);
	// Without the reset the job carries on from 20 and misses it.
	assert.equal(validateAll(q, trace, 2), VALIDATE_CLEAR, 'the case under test');
	p.resetValidation();
	assert.equal(validateAll(p, trace, 2), expect);
});

t('lift: the flown part is kept, a 30 m smoothstep blend, then + dy; cum and length recomputed', () => {
	const w = building();
	const trace = orbitOn(w);
	const P0 = Float32Array.from(trace.points), cum0 = Float32Array.from(trace.cum);
	const from = 20;
	const p = new TraceProbe({ ...w });
	p.lift(trace, from, 10);
	const m = trace.cum.length;
	for (let i = 0; i <= from; i++) {
		for (let c = 0; c < 3; c++) assert.equal(trace.points[3 * i + c], P0[3 * i + c], `point ${i} moved`);
		assert.equal(trace.cum[i], cum0[i], `cum ${i} changed`);
	}
	let prev = 0;
	for (let i = from; i < m; i++) {
		const dy = trace.points[3 * i + 1] - P0[3 * i + 1];
		assert.equal(trace.points[3 * i], P0[3 * i]); assert.equal(trace.points[3 * i + 2], P0[3 * i + 2]);
		assert.ok(dy >= prev - 1e-4 && dy <= 10 + 1e-4, `lift not monotone at ${i}: ${dy}`);
		if (cum0[i] - cum0[from] >= LIFT_BLEND_M) near(dy, 10, 1e-4, `full lift at ${i}`);
		prev = dy;
	}
	let acc = 0;
	for (let i = 1; i < m; i++) {
		const P = trace.points;
		acc += Math.hypot(P[3 * i] - P[3 * i - 3], P[3 * i + 1] - P[3 * i - 2], P[3 * i + 2] - P[3 * i - 1]);
		near(trace.cum[i], acc, 1e-3, `cum ${i}`);
	}
	assert.equal(trace.length, trace.cum[m - 1]);
	assert.ok(trace.length > cum0[m - 1], 'the climb adds length');
	// dy = 0 changes nothing.
	liftTrace(trace, 0, 0);
	assert.equal(trace.length, trace.cum[m - 1], 'dy = 0 is a no-op');
});

t('liftStart: 30 m before the block, never into the flown part', () => {
	const trace = orbitOn(building());
	const i = liftStart(trace, 40, 0);
	assert.ok(trace.cum[40] - trace.cum[i] >= LIFT_BLEND_M && trace.cum[40] - trace.cum[i + 1] < LIFT_BLEND_M);
	assert.equal(liftStart(trace, 40, 35), 35);
	assert.equal(liftStart(trace, 5, 0), 0);
});

t('lift with the blocked index: a block close to the drone still gets the full lift', () => {
	const w = building();
	const trace = orbitOn(w);
	const P0 = Float32Array.from(trace.points);
	const blocked = 25, min = 20; // the drone is 10 m before the block
	const from = liftStart(trace, blocked, min);
	assert.equal(from, min);
	const blend = liftBlend(trace, from, blocked);
	near(blend, trace.cum[blocked] - trace.cum[from], 1e-4, 'blend ends at the block');
	const p = new TraceProbe({ ...w });
	p.lift(trace, from, 8, blocked);
	near(trace.points[3 * blocked + 1] - P0[3 * blocked + 1], 8, 1e-4, 'full dy at the block');
	near(trace.points[3 * from + 1], P0[3 * from + 1], 0, 'the start does not move');
	for (let i = blocked; i < trace.cum.length; i++) near(trace.points[3 * i + 1] - P0[3 * i + 1], 8, 1e-4, `point ${i}`);
	// Without it, the 30 m default only clears part of it there.
	const t2 = orbitOn(w), Q0 = Float32Array.from(t2.points);
	p.lift(t2, from, 8);
	assert.ok(t2.points[3 * blocked + 1] - Q0[3 * blocked + 1] < 6, 'the case under test');
	// Far enough away, the blend is the 30 m default; at the block itself, a step.
	assert.equal(liftBlend(trace, liftStart(trace, 60, 0), 60), LIFT_BLEND_M);
	assert.ok(liftBlend(trace, 25, 25) > 0);
});

t('lift then validate: a blocked orbit clears once lifted over the block', () => {
	const w = building();
	const trace = orbitOn(w);
	const P = trace.points, c = 3 * 50;
	w.boxes.push(box(P[c] - 2, P[c] + 2, P[c + 2] - 2, P[c + 2] + 2, 0, P[c + 1] + 3));
	const p = new TraceProbe({ ...w });
	const hit = validateAll(p, trace, 10);
	assert.ok(hit >= 45 && hit <= 50, `hit ${hit}`);
	p.lift(trace, liftStart(trace, hit, 10), 8, hit);
	assert.equal(validateAll(p, trace, 10), VALIDATE_CLEAR);
});

// ------------------------------------------------------------- end to end
function e2e(world, anchor, signal, tier, axis = false) {
	const { profile } = probe(world, anchor, { axis });
	const trace = buildTrace({ signal, anchor, profile, tier, approach: APPROACH });
	assert.ok(trace, `${signal.kind} tier ${tier}: no trace`);
	const p = new TraceProbe({ ...world });
	const r = validateAll(p, trace);
	assert.equal(r, VALIDATE_CLEAR, `${signal.kind} tier ${tier} ${trace.shape}: blocked at ${r}`);
	return { trace, profile };
}

t('end to end: orbit and spiral around the building, validated clear', () => {
	for (const tier of [2, 3]) {
		assert.equal(e2e(building(), B_ANCHOR, { id: 'wd:Q7', kind: 'CASTLE' }, tier).trace.shape, 'orbit');
		const { trace } = e2e(building(), B_ANCHOR, { id: 'wd:Q9', kind: 'TOWER' }, tier);
		assert.equal(trace.shape, 'spiral');
		assert.ok(trace.points[trace.points.length - 2] >= 50 - 1e-3, 'ends 10 m over the roof');
	}
});

t('end to end: the under-pass of the bridge, validated clear, under the deck', () => {
	for (const tier of [2, 3]) {
		const { trace } = e2e(bridge(), BR_ANCHOR, { id: 'wd:Q11', kind: 'BRIDGE' }, tier, true);
		assert.equal(trace.shape, 'under');
		// The pass crosses z = 0 (the deck line) at mid-clearance, 6 m.
		let crossed = false;
		const P = trace.points;
		for (let i = 0; i < P.length / 3 - 1 && !crossed; i++) {
			if (Math.sign(P[3 * i + 2]) !== Math.sign(P[3 * i + 5])) { near(P[3 * i + 1], 6, 1e-3, 'pass height'); crossed = true; }
		}
		assert.ok(crossed, 'the pass never crosses the deck');
	}
	// Without the axis (not asked), the bridge is an orbit.
	assert.equal(e2e(bridge(), BR_ANCHOR, { id: 'wd:Q11', kind: 'BRIDGE' }, 2, false).trace.shape, 'orbit');
});

t('end to end: the dive down the peak, validated clear, 10 m above the slope', () => {
	for (const tier of [2, 3]) {
		const w = peak();
		const { trace } = e2e(w, PK_ANCHOR, { id: 'wd:Q13', kind: 'PEAK' }, tier);
		assert.equal(trace.shape, 'dive');
		const P = trace.points;
		assert.ok(P[1] >= 240 - 1e-3, 'starts 40 m above the summit');
		for (let i = 0; i < P.length / 3; i++) {
			const h = w.coneH(w.cones[0], P[3 * i], P[3 * i + 2]);
			assert.ok(P[3 * i + 1] - h >= 10 - 0.05, `point ${i} ${P[3 * i + 1] - h} m over the slope`);
		}
	}
});

console.log(`trace-probe: ${n} ok`);

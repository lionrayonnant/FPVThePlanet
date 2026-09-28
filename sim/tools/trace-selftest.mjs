// Selftest of the trace model (issue #185, spec 2026-09-28-signals-traces-design):
// shape choice, seeds, each shape's geometry from a synthetic profile, the
// follower and photo scoring. No DOM, no THREE, no Rapier.
// Run: node tools/trace-selftest.mjs
import assert from 'node:assert/strict';
import {
	shapeOf, seedOf, turnDir, buildTrace, surfaceAt, TraceFollower, photoScore,
	SPACING_M, TOLERANCE_M, WINDOW_M, OFF_RESET_S, FADE_S, PHOTO_CONE_DEG,
} from './trace-model.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

const RINGS = [0, 10, 20, 35, 55, 80];
const N = 16;
// A profile from a height function of (x, z) around the anchor, on the shared grid convention.
const profileOf = (anchor, hFn, extra = {}) => {
	const rings = RINGS.map((r) => {
		const heights = new Float32Array(N);
		for (let k = 0; k < N; k++) {
			const th = (k / N) * 2 * Math.PI;
			heights[k] = hFn(anchor.x + r * Math.cos(th), anchor.z + r * Math.sin(th));
		}
		return { r, heights };
	});
	let ground = Infinity, top = -Infinity;
	for (const ring of rings) for (const h of ring.heights) { ground = Math.min(ground, h); top = Math.max(top, h); }
	return { rings, ground, top, ...extra };
};

const pt = (tr, i) => ({ x: tr.points[3 * i], y: tr.points[3 * i + 1], z: tr.points[3 * i + 2] });
const count = (tr) => tr.points.length / 3;
const dist = (a, b) => Math.hypot(a.x - b.x, (a.y ?? 0) - (b.y ?? 0), a.z - b.z);
const hdist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const spacingOk = (tr) => {
	for (let i = 1; i < count(tr); i++) {
		const d = tr.cum[i] - tr.cum[i - 1];
		assert.ok(d > SPACING_M * 0.5 && d < SPACING_M * 1.5, `spacing ${d} at ${i}`);
	}
	assert.equal(tr.cum[0], 0);
	assert.ok(Math.abs(tr.cum[count(tr) - 1] - tr.length) < 1e-3);
};
// The entry is the trace point horizontally nearest the approach.
const entryNearest = (tr, approach) => {
	const d0 = hdist(pt(tr, 0), approach);
	for (let i = 1; i < count(tr); i++) assert.ok(hdist(pt(tr, i), approach) >= d0 - 0.5, `point ${i} nearer than the entry`);
};

const sig = (kind, heightM = null, id = 'wd:Q42') => ({ id, kind, heightM });

// ------------------------------------------------------------------ shapes
t('shapeOf follows the spec table', () => {
	for (const k of ['TOWER', 'LIGHTHOUSE']) assert.equal(shapeOf(sig(k)), 'spiral', k);
	for (const k of ['BRIDGE', 'ARCH']) assert.equal(shapeOf(sig(k)), 'under', k);
	for (const k of ['PEAK', 'VOLCANO', 'WATERFALL', 'CLIFF', 'DAM']) assert.equal(shapeOf(sig(k)), 'dive', k);
	for (const k of ['CATHEDRAL', 'CASTLE', 'ATTRACTION', 'VIEWPOINT', 'LANDMARK', 'ROCK', 'GEYSER']) assert.equal(shapeOf(sig(k)), 'orbit', k);
	assert.equal(shapeOf(sig('CATHEDRAL', 51)), 'spiral', 'a built kind taller than 50 m');
	assert.equal(shapeOf(sig('CATHEDRAL', 50)), 'orbit', '50 m is not taller than 50 m');
	for (const k of ['ROCK', 'STONE', 'CAVE ENTRANCE', 'GEYSER', 'HOT SPRING']) assert.equal(shapeOf(sig(k, 200)), 'orbit', `natural ${k} never spirals`);
	assert.equal(shapeOf(sig('DAM', 200)), 'dive', 'a dam dives whatever its height');
	assert.equal(shapeOf(sig('BRIDGE', 200)), 'under');
	assert.equal(shapeOf({}), 'orbit');
});

t('seeds: stable, in [0,1), spread; turn direction ±1 and both occur', () => {
	assert.equal(seedOf('wd:Q243'), seedOf('wd:Q243'));
	assert.equal(turnDir('wd:Q243'), turnDir('wd:Q243'));
	const seeds = new Set(), dirs = new Set();
	for (let i = 1; i <= 200; i++) {
		const s = seedOf(`wd:Q${i}`);
		assert.ok(s >= 0 && s < 1);
		seeds.add(Math.floor(s * 10));
		dirs.add(turnDir(`wd:Q${i}`));
	}
	assert.equal(seeds.size, 10, 'every decile hit');
	assert.deepEqual([...dirs].sort(), [-1, 1]);
});

// ------------------------------------------------------------------ geometry
// A 100 m tower (2 m wide) on flat ground at 0; the anchor sits 3 m above its top.
const towerAnchor = { x: 500, y: 103, z: -200 };
const towerH = (x, z) => (Math.hypot(x - 500, z + 200) < 2 ? 100 : 0);
const towerProfile = profileOf(towerAnchor, towerH);

t('orbit: ring at anchor + 6 m, radius outline + 12 m; half a level turn (II), a 1.5-turn helix rising 8 m a turn (III)', () => {
	const approach = { x: 500, z: 100 }; // due south
	for (const tier of [2, 3]) {
		const tr = buildTrace({ signal: sig('CATHEDRAL'), anchor: towerAnchor, profile: towerProfile, tier, approach });
		assert.equal(tr.shape, 'orbit');
		assert.equal(tr.id, 'wd:Q42');
		assert.equal(tr.tolerance, TOLERANCE_M[tier]);
		spacingOk(tr);
		const arc = tier === 2 ? Math.PI : 3 * Math.PI;
		const rise = tier === 2 ? 0 : 12;
		assert.ok(Math.abs(tr.length - Math.hypot(arc * 12, rise)) < 1, `length ${tr.length}`);
		for (let i = 0; i < count(tr); i++) {
			const p = pt(tr, i);
			if (tier === 2) assert.ok(Math.abs(p.y - 109) < 1e-3);
			else if (i > 0) assert.ok(p.y >= pt(tr, i - 1).y - 1e-4, 'monotonic climb');
			assert.ok(Math.abs(hdist(p, towerAnchor) - 12) < 0.1);
		}
		assert.ok(Math.abs(pt(tr, 0).y - 109) < 1e-3);
		assert.ok(Math.abs(pt(tr, count(tr) - 1).y - (109 + rise)) < 1e-3);
		const e = pt(tr, 0);
		assert.ok(Math.abs(e.x - 500) < 0.1 && Math.abs(e.z - (-188)) < 0.1, 'entry on the drone side');
	}
});

t('orbit: each attempt is 8 m wider and 6 m higher; the turn follows the seed', () => {
	const approach = { x: 900, z: -200 };
	const a0 = buildTrace({ signal: sig('CATHEDRAL'), anchor: towerAnchor, profile: towerProfile, tier: 2, approach });
	const a2 = buildTrace({ signal: sig('CATHEDRAL'), anchor: towerAnchor, profile: towerProfile, tier: 2, approach, attempt: 2 });
	assert.ok(Math.abs(hdist(pt(a2, 0), towerAnchor) - 28) < 0.1);
	assert.ok(Math.abs(pt(a2, 0).y - pt(a0, 0).y - 12) < 1e-3);
	// Turn direction: the sign of the cross product of the first step.
	const turnOf = (id) => {
		const tr = buildTrace({ signal: sig('CATHEDRAL', null, id), anchor: towerAnchor, profile: towerProfile, tier: 2, approach });
		const p0 = pt(tr, 0), p1 = pt(tr, 1);
		return Math.sign((p0.x - 500) * (p1.z + 200) - (p0.z + 200) * (p1.x - 500));
	};
	for (const id of ['wd:Q1', 'wd:Q2', 'wd:Q3', 'wd:Q4']) assert.equal(turnOf(id), turnDir(id), id);
});

t('orbit III never overlays itself: points more than 20 m apart along it stay 2 × tolerance apart', () => {
	for (const attempt of [0, 2]) {
		const tr = buildTrace({ signal: sig('CATHEDRAL'), anchor: towerAnchor, profile: towerProfile, tier: 3, approach: { x: 500, z: 100 }, attempt });
		const min = 2 * tr.tolerance;
		for (let i = 0; i < count(tr); i++) {
			for (let j = i + 1; j < count(tr); j++) {
				if (tr.cum[j] - tr.cum[i] <= 20) continue;
				assert.ok(dist(pt(tr, i), pt(tr, j)) > min, `points ${i} and ${j}: ${dist(pt(tr, i), pt(tr, j))} m`);
			}
		}
	}
});

t('orbit: the outline is the widest ring within 8 m of the top', () => {
	// A 40 m wide block (radius 20 m ring reaches the top), a low annex at 35 m.
	const a = { x: 0, y: 63, z: 0 };
	const p = profileOf(a, (x, z) => (Math.hypot(x, z) <= 21 ? 60 : Math.hypot(x, z) <= 36 ? 20 : 0));
	const tr = buildTrace({ signal: sig('CASTLE'), anchor: a, profile: p, tier: 2, approach: { x: 0, z: 300 } });
	assert.ok(Math.abs(hdist(pt(tr, 0), a) - 32) < 0.1, `radius ${hdist(pt(tr, 0), a)}`);
});

t('orbit: a hill in one sector does not widen it, and it clears the surface at its radius', () => {
	// A castle 30 m high out to 21 m; east of it a taller block from 25 m to
	// 40 m (40 m high), then a hill rising to 150 m at the edge of the grid.
	const a = { x: 0, y: 33, z: 0 };
	const h = (x, z) => {
		const r = Math.hypot(x, z);
		if (r <= 21) return 30;
		if (x > 0 && Math.abs(z) < x * 0.6) return r <= 40 ? 40 : Math.max(0, (r - 45) * 4);
		return 0;
	};
	const p = profileOf(a, h);
	assert.ok(p.top > 100, 'the grid-wide top is the hill');
	for (const tier of [2, 3]) {
		const tr = buildTrace({ signal: sig('CASTLE'), anchor: a, profile: p, tier, approach: { x: 0, z: 300 } });
		const R = hdist(pt(tr, 0), a);
		assert.ok(Math.abs(R - 32) < 0.1, `radius ${R}: the castle's 20 m ring + 12 m`);
		let minY = Infinity;
		for (let i = 0; i < count(tr); i++) {
			const q = pt(tr, i);
			minY = Math.min(minY, q.y);
			assert.ok(q.y >= surfaceAt(p, a, q.x, q.z) + 6 - 1e-3, `point ${i} at ${q.y} under the surface + 6 m`);
		}
		assert.ok(minY > a.y + 6, 'raised over the taller block at its radius');
	}
});

t('orbit: a low landmark on flat ground keeps a tight ring', () => {
	// A 5 m statue on a 3 m plinth: the ground rings are not the landmark.
	const a = { x: 0, y: 8, z: 0 };
	const p = profileOf(a, (x, z) => (Math.hypot(x, z) < 3 ? 5 : 0));
	const tr = buildTrace({ signal: sig('ATTRACTION'), anchor: a, profile: p, tier: 2, approach: { x: 0, z: 300 } });
	assert.ok(Math.abs(hdist(pt(tr, 0), a) - 12) < 0.1, `radius ${hdist(pt(tr, 0), a)}`);
});

t('a partial profile builds no trace', () => {
	assert.ok(buildTrace({ signal: sig('TOWER'), anchor: towerAnchor, profile: towerProfile, tier: 2, approach: { x: 0, z: 0 } }));
	assert.equal(buildTrace({ signal: sig('TOWER'), anchor: towerAnchor, profile: { ...towerProfile, partial: true }, tier: 2, approach: { x: 0, z: 0 } }), null);
});

// Spiral invariants: climbs monotonically, never steeper than 30°, never
// under 6 m above the probed surface, never widening with height.
const spiralOk = (tr, a, p) => {
	for (let i = 1; i < count(tr); i++) {
		const q = pt(tr, i - 1), r = pt(tr, i);
		const rise = r.y - q.y, run = Math.hypot(r.x - q.x, r.z - q.z);
		assert.ok(rise >= -1e-3, `monotone climb at ${i}`);
		assert.ok(rise <= Math.tan(Math.PI / 6) * run + 0.05, `climb ${(Math.atan2(rise, run) * 180 / Math.PI).toFixed(1)}° at ${i}`);
		assert.ok(hdist(r, a) <= hdist(q, a) + 0.05, `radius grows at ${i}: ${hdist(q, a)} → ${hdist(r, a)}`);
	}
	for (let i = 0; i < count(tr); i++) {
		const q = pt(tr, i);
		assert.ok(q.y >= surfaceAt(p, a, q.x, q.z) + 6 - 0.05, `point ${i} ${q.y} under the surface + 6`);
	}
};
const noOverlay = (tr) => {
	const min = 2 * tr.tolerance;
	for (let i = 0; i < count(tr); i++) {
		for (let j = i + 1; j < count(tr); j++) {
			if (tr.cum[j] - tr.cum[i] <= 20) continue;
			assert.ok(dist(pt(tr, i), pt(tr, j)) > min, `points ${i} and ${j}: ${dist(pt(tr, i), pt(tr, j))} m`);
		}
	}
};

t('spiral: rises from ground + 15 m to top + 10 m, 12 m around a thin tower, 30° at most, entry facing the drone', () => {
	const approach = { x: 100, z: -500 };
	const lens = {};
	for (const tier of [2, 3]) {
		const tr = buildTrace({ signal: sig('TOWER'), anchor: towerAnchor, profile: towerProfile, tier, approach });
		assert.equal(tr.shape, 'spiral');
		spacingOk(tr);
		spiralOk(tr, towerAnchor, towerProfile);
		assert.ok(Math.abs(pt(tr, 0).y - 15) < 0.1, `start ${pt(tr, 0).y}`);
		assert.ok(Math.abs(pt(tr, count(tr) - 1).y - 110) < 0.1, `end ${pt(tr, count(tr) - 1).y}`);
		for (let i = 0; i < count(tr); i++) assert.ok(Math.abs(hdist(pt(tr, i), towerAnchor) - 12) < 0.1);
		entryNearest(tr, approach);
		lens[tier] = tr.length;
		if (tier === 3) noOverlay(tr);
	}
	// 95 m of climb at 12 m: tier II needs 2.18 turns to stay at 30° (190 m), tier III makes 1.5 × as many.
	assert.ok(Math.abs(lens[2] - 190) < 1.5, `II length ${lens[2]}`);
	const horiz3 = 1.5 * 95 / Math.tan(Math.PI / 6);
	assert.ok(Math.abs(lens[3] - Math.hypot(horiz3, 95)) < 1.5, `III length ${lens[3]}`);
});

t('spiral: a conical tower is wrapped from its foot to above its top, the radius shrinking with height', () => {
	// A 150 m cone, 68 m across at the base; the anchor 3 m over its tip.
	const a = { x: 0, y: 153, z: 0 };
	const h = (x, z) => Math.max(0, 150 - 2.2 * Math.hypot(x, z));
	const p = profileOf(a, h);
	for (const tier of [2, 3]) {
		for (const attempt of [0, 2]) {
			const tr = buildTrace({ signal: sig('TOWER'), anchor: a, profile: p, tier, approach: { x: 300, z: 0 }, attempt });
			spacingOk(tr);
			spiralOk(tr, a, p);
			const s = pt(tr, 0), e = pt(tr, count(tr) - 1);
			assert.ok(s.y <= 15 + 6 * attempt + 12, `starts near the ground: ${s.y}`);
			assert.ok(Math.abs(e.y - (160 + 6 * attempt)) < 0.1, `ends 10 m over the top: ${e.y}`);
			const rs = hdist(s, a), re = hdist(e, a);
			assert.ok(rs >= Math.min(80, 55 + 12 + 8 * attempt) - 0.1 && rs <= 80 + 0.1, `wraps the foot: ${rs}`);
			assert.ok(Math.abs(re - (12 + 8 * attempt)) < 0.1, `hugs the tip: ${re}`);
			if (tier === 3) noOverlay(tr);
		}
	}
});

t('spiral: widens around a podium, never under 6 m above it', () => {
	// A 40 m podium out to 15 m, a 120 m spire at the centre.
	const a = { x: 0, y: 123, z: 0 };
	const p = profileOf(a, (x, z) => { const r = Math.hypot(x, z); return r < 2 ? 120 : r <= 15 ? 40 : 0; });
	const tr = buildTrace({ signal: sig('TOWER'), anchor: a, profile: p, tier: 2, approach: { x: 200, z: 0 } });
	spiralOk(tr, a, p);
	assert.ok(Math.abs(hdist(pt(tr, 0), a) - 22) < 0.1, `the podium's 10 m ring + 12 m: ${hdist(pt(tr, 0), a)}`);
	assert.ok(Math.abs(hdist(pt(tr, count(tr) - 1), a) - 12) < 0.1);
});

// A bridge: deck along X, underside at 30 m, surface at 33 m, water at 0.
const bridgeAnchor = { x: 0, y: 36, z: 0 };
const bridgeH = (x, z) => (Math.abs(z) < 6 ? 33 : 0);
const axis = { dx: 1, dz: 0, deckY: 30, underY: 0, topY: 33 };

t('under: a pass across the deck at mid-clearance, 40 m each side, entry on the drone side', () => {
	const p = profileOf(bridgeAnchor, bridgeH, { axis });
	const approach = { x: 20, z: 250 }; // south of the deck
	const tr = buildTrace({ signal: sig('BRIDGE'), anchor: bridgeAnchor, profile: p, tier: 2, approach });
	assert.equal(tr.shape, 'under');
	spacingOk(tr);
	assert.ok(Math.abs(tr.length - 80) < 0.5, `length ${tr.length}`);
	for (let i = 0; i < count(tr); i++) {
		assert.ok(Math.abs(pt(tr, i).y - 15) < 1e-3);
		assert.ok(Math.abs(pt(tr, i).x) < 1e-3, 'perpendicular to the deck');
	}
	assert.ok(Math.abs(pt(tr, 0).z - 40) < 1e-3, 'entry south, where the drone is');
	assert.ok(Math.abs(pt(tr, count(tr) - 1).z + 40) < 1e-3);
});

t('under III: pass, climb out over the deck, back over it, return pass drifted along the deck', () => {
	const p = profileOf(bridgeAnchor, bridgeH, { axis });
	const tr = buildTrace({ signal: sig('BRIDGE'), anchor: bridgeAnchor, profile: p, tier: 3, approach: { x: 0, z: -300 } });
	assert.equal(tr.shape, 'under');
	spacingOk(tr);
	let over = 0, maxY = -Infinity;
	for (let i = 0; i < count(tr); i++) {
		const q = pt(tr, i);
		maxY = Math.max(maxY, q.y);
		if (Math.abs(q.z) < 6) {
			// Over the deck: never inside it.
			assert.ok(q.y < 30 - 1 || q.y > 33 + 1, `point ${i} inside the deck at y ${q.y}`);
			if (q.y > 33) over++;
		}
	}
	assert.ok(over > 0, 'a pass over the deck');
	assert.ok(Math.abs(maxY - 43) < 0.2, `over at deck surface + 10 m, ${maxY}`);
	const e = pt(tr, count(tr) - 1);
	assert.ok(Math.abs(e.y - 15) < 1e-3 && Math.abs(e.x - 12) < 0.1 && Math.abs(e.z - 40) < 0.1, `return pass end ${JSON.stringify(e)}`);
	assert.ok(pt(tr, 0).z < 0, 'entry north, where the drone is');
	assert.ok(tr.length > 240 && tr.length < 360, `length ${tr.length}`);
});

t('under without an axis, or with less than 8 m of clearance, is an orbit', () => {
	const noAxis = profileOf(bridgeAnchor, bridgeH);
	assert.equal(buildTrace({ signal: sig('BRIDGE'), anchor: bridgeAnchor, profile: noAxis, tier: 3, approach: { x: 0, z: 100 } }).shape, 'orbit');
	const low = profileOf(bridgeAnchor, bridgeH, { axis: { ...axis, deckY: 7.9 } });
	assert.equal(buildTrace({ signal: sig('ARCH'), anchor: bridgeAnchor, profile: low, tier: 2, approach: { x: 0, z: 100 } }).shape, 'orbit');
});

// A peak: 300 m at the centre, falling 2 m/m everywhere and 3 m/m towards the east.
const peakAnchor = { x: 0, y: 303, z: 0 };
const peakH = (x, z) => { const r = Math.hypot(x, z); const c = r > 0 ? x / r : 0; return Math.max(0, 300 - r * (2 + Math.max(0, c))); };
const peakProfile = profileOf(peakAnchor, peakH);

t('dive: from top + 40 m on the drone side, down the steepest face, 10 m above the surface', () => {
	const approach = { x: -50, z: -400 };
	for (const tier of [2, 3]) {
		const tr = buildTrace({ signal: sig('PEAK'), anchor: peakAnchor, profile: peakProfile, tier, approach });
		assert.equal(tr.shape, 'dive');
		spacingOk(tr);
		assert.ok(Math.abs(tr.length - (tier === 2 ? 60 : 160)) < 1.5, `length ${tr.length}`);
		assert.ok(Math.abs(pt(tr, 0).y - (peakProfile.top + 40)) < 1e-3, 'start 40 m above the top');
		const e0 = pt(tr, 0);
		assert.ok((e0.x - 0) * approach.x + (e0.z - 0) * approach.z > 0, 'entry on the drone side');
		for (let i = 0; i < count(tr); i++) {
			const q = pt(tr, i);
			assert.ok(q.y >= surfaceAt(peakProfile, peakAnchor, q.x, q.z) + 10 - 0.5, `point ${i} too low`);
		}
		const last = pt(tr, count(tr) - 1);
		assert.ok(last.x > pt(tr, 0).x + (tier === 2 ? 3 : 30), 'went east, the steepest face');
		assert.ok(last.y < pt(tr, 0).y - 40, 'descended');
	}
});

t('dive: a higher ridge in the grid is not the summit', () => {
	// The peak (300 m) plus a 360 m ridge 70 m west of it.
	const h = (x, z) => Math.max(peakH(x, z), x < -60 ? 360 : 0);
	const p = profileOf(peakAnchor, h);
	assert.ok(p.top >= 360);
	const tr = buildTrace({ signal: sig('PEAK'), anchor: peakAnchor, profile: p, tier: 2, approach: { x: 0, z: -400 } });
	const e0 = pt(tr, 0);
	assert.ok(Math.abs(e0.y - 340) < 1e-3, `start ${e0.y}: 40 m over the peak, not the ridge`);
	assert.ok(hdist(e0, peakAnchor) < 12, 'starts over the peak');
	for (let i = 0; i < count(tr); i++) {
		const q = pt(tr, i);
		assert.ok(q.y >= surfaceAt(p, peakAnchor, q.x, q.z) + 10 - 0.5, `point ${i} too low`);
	}
});

t('dive: with enough path, it ends 10 m above the lowest probed point', () => {
	// A 40 m cliff: the path has room to reach the bottom.
	const a = { x: 0, y: 43, z: 0 };
	const p = profileOf(a, (x) => (x < 5 ? 40 : 0));
	const tr = buildTrace({ signal: sig('CLIFF'), anchor: a, profile: p, tier: 3, approach: { x: -300, z: 0 } });
	const last = pt(tr, count(tr) - 1);
	assert.ok(Math.abs(last.y - 10) < 0.6, `end ${last.y}`);
	assert.ok(tr.length <= 160 + 1);
});

t('buildTrace: tier I, no profile or a bad anchor gives null; deterministic', () => {
	const args = { signal: sig('TOWER'), anchor: towerAnchor, profile: towerProfile, tier: 2, approach: { x: 0, z: 0 } };
	assert.equal(buildTrace({ ...args, tier: 1 }), null);
	assert.equal(buildTrace({ ...args, profile: null }), null);
	assert.equal(buildTrace({ ...args, anchor: { x: NaN, y: 0, z: 0 } }), null);
	assert.deepEqual(buildTrace(args), buildTrace(args));
	// No approach: the seed chooses the entry, still deterministic.
	assert.deepEqual(buildTrace({ ...args, approach: null }).points, buildTrace({ ...args, approach: null }).points);
});

// ------------------------------------------------------------------ follower
// A straight 100 m trace along +X at y = 10.
const line = (() => {
	const segs = 50, points = new Float32Array((segs + 1) * 3), cum = new Float32Array(segs + 1);
	for (let i = 0; i <= segs; i++) { points[3 * i] = 2 * i; points[3 * i + 1] = 10; cum[i] = 2 * i; }
	return { id: 'wd:Q1', shape: 'orbit', points, cum, length: 100, tolerance: 5 };
})();
const fly = (f, from, to, speed = 10, lateral = 0, dt = 0.05) => {
	const dir = Math.sign(to - from) || 1;
	let s;
	for (let x = from; dir > 0 ? x <= to : x >= to; x += dir * speed * dt) s = f.update({ dt, pos: { x, y: 10, z: lateral } });
	return s;
};

t('follower: waiting until the gate, then on, progress follows the drone', () => {
	const f = new TraceFollower({ trace: line, tolerance: 5 });
	assert.equal(f.update({ dt: 0.05, pos: { x: -20, y: 10, z: 0 } }).state, 'waiting');
	assert.equal(f.update({ dt: 0.05, pos: { x: 30, y: 10, z: 0 } }).state, 'waiting', 'mid-trace is not the gate');
	assert.equal(f.out.progress01, 0);
	const s = fly(f, 0, 40, 10, 3);
	assert.equal(s.state, 'on');
	assert.ok(Math.abs(s.flownM - 40) < 1, `flown ${s.flownM}`);
	assert.ok(Math.abs(s.progress01 - 0.4) < 0.01);
});

t('follower: no skip-ahead beyond the 15 m window, and no going back', () => {
	const f = new TraceFollower({ trace: line, tolerance: 5 });
	fly(f, 0, 20);
	const s = f.update({ dt: 0.05, pos: { x: 60, y: 10, z: 0 } });
	assert.equal(s.state, 'off', 'a point 40 m ahead is outside the window');
	assert.ok(Math.abs(s.flownM - 20) < 0.6);
	const s2 = f.update({ dt: 0.05, pos: { x: 20 + WINDOW_M - 1, y: 10, z: 0 } });
	assert.equal(s2.state, 'on', 'inside the window');
	assert.ok(Math.abs(s2.flownM - (20 + WINDOW_M - 1)) < 0.6);
	const s3 = f.update({ dt: 0.05, pos: { x: 5, y: 10, z: 0 } });
	assert.equal(s3.state, 'off', 'behind the progress is off');
	assert.ok(s3.flownM >= 20 + WINDOW_M - 1.6);
});

t('follower: off pauses; back within 10 s resumes where it left', () => {
	const f = new TraceFollower({ trace: line, tolerance: 5 });
	fly(f, 0, 30);
	let s;
	for (let i = 0; i < 9.5 / 0.05; i++) s = f.update({ dt: 0.05, pos: { x: 30, y: 10, z: 20 } });
	assert.equal(s.state, 'off');
	assert.ok(s.offS > 9 && s.offS < 10);
	assert.equal(s.fade01, 0);
	const flown = s.flownM;
	s = f.update({ dt: 0.05, pos: { x: 31, y: 10, z: 1 } });
	assert.equal(s.state, 'on');
	assert.equal(s.offS, 0);
	assert.ok(s.flownM >= flown);
});

t('follower: 10 s off, the flown part fades over 2 s, then back to the gate', () => {
	const f = new TraceFollower({ trace: line, tolerance: 5 });
	fly(f, 0, 30);
	const off = { x: 30, y: 10, z: 20 };
	let s;
	for (let i = 0; i < (OFF_RESET_S + FADE_S / 2) / 0.05; i++) s = f.update({ dt: 0.05, pos: off });
	assert.equal(s.state, 'off');
	assert.ok(s.fade01 > 0.4 && s.fade01 < 0.6, `fade ${s.fade01}`);
	assert.ok(s.progress01 > 0.25, 'progress kept while it fades');
	// Coming back during the fade does not save it.
	s = f.update({ dt: 0.05, pos: { x: 30, y: 10, z: 0 } });
	assert.ok(s.fade01 > 0.5);
	for (let i = 0; i < FADE_S / 0.05; i++) s = f.update({ dt: 0.05, pos: off });
	assert.equal(s.state, 'waiting');
	assert.equal(s.progress01, 0);
	assert.equal(s.fade01, 0);
	assert.equal(s.offS, 0);
	s = f.update({ dt: 0.05, pos: { x: 30, y: 10, z: 0 } });
	assert.equal(s.state, 'waiting', 'must re-enter through the gate');
	assert.equal(f.update({ dt: 0.05, pos: { x: 1, y: 10, z: 0 } }).state, 'on');
});

t('follower: done at 99.5 % and sticky; dt = 0 freezes', () => {
	const f = new TraceFollower({ trace: line, tolerance: 5 });
	fly(f, 0, 50);
	const before = { ...f.out };
	const frozen = f.update({ dt: 0, pos: { x: 500, y: 500, z: 500 } });
	assert.deepEqual({ ...frozen }, before, 'dt = 0 changes nothing');
	for (let i = 0; i < 200; i++) f.update({ dt: 0, pos: { x: 500, y: 0, z: 0 } });
	assert.equal(f.out.offS, before.offS);
	const s = fly(f, 50, 99.6);
	assert.equal(s.state, 'done');
	assert.equal(s.progress01, 1);
	assert.equal(f.update({ dt: 0.05, pos: { x: 500, y: 0, z: 0 } }).state, 'done');
});

t('follower: a NaN position neither opens the gate nor moves the progress', () => {
	const f = new TraceFollower({ trace: line, tolerance: 5 });
	assert.equal(f.update({ dt: 0.05, pos: { x: NaN, y: 10, z: 0 } }).state, 'waiting');
	fly(f, 0, 20);
	const before = { ...f.out };
	for (const bad of [{ x: NaN, y: 10, z: 0 }, { x: 20, y: NaN, z: 0 }, { x: 20, y: 10, z: Infinity }]) {
		assert.deepEqual({ ...f.update({ dt: 0.05, pos: bad }) }, before);
	}
});

t('follower: out.index is the segment the progress is on', () => {
	const f = new TraceFollower({ trace: line, tolerance: 5 });
	assert.equal(f.out.index, 0);
	fly(f, 0, 21);
	assert.equal(f.out.index, Math.floor(f.out.flownM / 2));
	assert.ok(f.out.index >= 10);
	f.reset();
	assert.equal(f.out.index, 0);
});

t('follower: reuses its output object, and the tolerance defaults to the trace', () => {
	const f = new TraceFollower({ trace: line });
	assert.equal(f.tolerance, 5);
	const a = f.update({ dt: 0.05, pos: { x: 0, y: 10, z: 0 } });
	const b = f.update({ dt: 0.05, pos: { x: 2, y: 10, z: 0 } });
	assert.equal(a, b);
});

t('follower on a built spiral: flying it point by point completes it', () => {
	const tr = buildTrace({ signal: sig('TOWER'), anchor: towerAnchor, profile: towerProfile, tier: 3, approach: { x: 500, z: 100 } });
	const f = new TraceFollower({ trace: tr, tolerance: tr.tolerance });
	let s;
	for (let i = 0; i < count(tr); i++) s = f.update({ dt: 0.1, pos: pt(tr, i) });
	assert.equal(s.state, 'done');
	assert.ok(s.elapsedS > 0);
});

// ------------------------------------------------------------------ photo
t('photoScore: 1 at the centre, 0 at the edge of the 35° cone, null outside or hidden', () => {
	assert.equal(PHOTO_CONE_DEG, 35);
	assert.equal(photoScore({ angleDeg: 0, los: true }), 1);
	assert.ok(Math.abs(photoScore({ angleDeg: 17.5, los: true }) - 0.5) < 1e-9);
	assert.equal(photoScore({ angleDeg: 35, los: true }), 0);
	assert.equal(photoScore({ angleDeg: 35.1, los: true }), null);
	assert.equal(photoScore({ angleDeg: 0, los: false }), null);
	assert.equal(photoScore({ angleDeg: NaN, los: true }), null);
});

console.log(`trace: ${n} ok`);

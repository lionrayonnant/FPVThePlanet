// node tools/ambient-selftest.mjs
//
// The PURE model of the ambient drones (issue #250): set, routines, curves,
// bubble, anchors, validation against stub rays, attitude. No Three, no
// Rapier — the rays are injected functions, as in
// tools/entry-state-selftest.mjs.

import {
	rngFrom, ambientSet, ROUTINES, lateralAccelMax, routineFor,
	MAX_DRONES, G, TURN_MARGIN, TILT_MAX_DEG,
	curveLocal, curveHeights, curveAt, derive, SAMPLES, HEIGHT_SAMPLES,
	R_SPAWN, R_LEAVE, bubbleFor, insideBounds, outOfView, pickAnchor, validateCurve, AmbientModel,
	attitudeFrom, tiltOf, clampTilt,
	SWARM_UNIT_FAMILY, SWARM_UNIT_BUILD_FAMILY,
} from '../src/ambient.js';
import { generateTargetScan, TARGET_FAMILIES } from './target-model.mjs';
import { targetBuild } from './target-build.mjs';

let failures = 0;
function check(label, ok, detail) {
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures++;
}

console.log('ambient: the set');
{
	// swarmChance 0 on both sides: a scan descriptor with no swarm key (a v2
	// session, a dev scan) replays with no swarm, which is what this compares.
	const scan = { seed: 'set-a', count: 5, index: 2 };
	const set = ambientSet(scan);
	const full = generateTargetScan({ seed: 'set-a', count: 5, swarmChance: 0 }).candidates;
	check('n = count - 1', set.length === 4, `${set.length}`);
	check('the taken one is absent', set.every((d) => d.i !== 2));
	check('families = those of the candidates not taken',
		set.every((d) => d.family === full[d.i]._family));
	check('buildSeed = seed::i', set.every((d) => d.buildSeed === `set-a::${d.i}`));
	check('mode = the real video mode', set.every((d) => d.mode === full[d.i]._videoHint));
	check('same scan -> same set',
		JSON.stringify(ambientSet(scan)) === JSON.stringify(set));
	check('count 2 -> 1 ambient', ambientSet({ seed: 'z', count: 2, index: 0 }).length === 1);
	check('never more than MAX_DRONES', ambientSet({ seed: 'z', count: 5, index: 0 }).length <= MAX_DRONES);
}

console.log('\nambient: families follow clearance (issue #185)');
{
	// `families` travels with the scan (issue #185), exactly like the swarm
	// keys just above: the ambients not taken must be drawn from the SAME
	// pool as the flight, not from whatever clearance the operator holds
	// when the sky is regenerated (e.g. after uplinking a signal mid-flight).
	const pool = ['freestyle5', 'cinewhoop', 'toothpick'];
	const scan = { seed: 'set-pool', count: 5, index: 2, families: pool };
	const set = ambientSet(scan);
	check('ambients are drawn from the given pool',
		set.every((d) => pool.includes(d.family) || d.family === SWARM_UNIT_FAMILY));
	const full = generateTargetScan({ seed: 'set-pool', count: 5, swarmChance: 0, families: pool }).candidates;
	check('the set matches a scan regenerated with the same pool',
		set.every((d) => d.family === full[d.i]._family));
	// Absent (older session, dev scan): the full pool, exactly like swarmChance
	// falling back to 0 above — no family a pre-clearance scan never had.
	check('no families key -> full pool, no throw',
		ambientSet({ seed: 'set-nopool', count: 5, index: 2 }).length === 4);
}

console.log('\nambient: the cluster left behind (issue #29)');
{
	// The player took another signal: the cluster stays in the sky, but as A
	// SINGLE unit on an ordinary routine, not as a flock of twelve.
	const scan = { seed: 'swarm-amb', count: 4, index: 1, swarmAt: 0, swarmChance: 1 };
	const set = ambientSet(scan);
	const left = set.find((d) => d.i === 0);
	check('the cluster not taken becomes a swarmUnit', left?.family === SWARM_UNIT_FAMILY, left?.family);
	check('it borrows an existing airframe for its BUILD (no PROFILES entry)',
		left?.buildFamily === SWARM_UNIT_BUILD_FAMILY, left?.buildFamily);
	// Its silhouette, though, is its own now that the recipe exists
	// (src/drone-shape.js, RECIPE_PROFILES): this is the only place where the
	// build's airframe and the mesh's diverge.
	check('but it carries ITS OWN silhouette', left?.shapeFamily === SWARM_UNIT_FAMILY, left?.shapeFamily);
	check('that airframe really builds',
		!!targetBuild({ seed: left.buildSeed, family: left.buildFamily }).profile);
	check('the other ambients keep their family',
		set.filter((d) => d.i !== 0).every((d) => d.family === d.buildFamily));
	// And when IT is the one taken, no unit is left in the sky.
	const taken = ambientSet({ ...scan, index: 0 });
	check('cluster taken -> no ambient swarmUnit',
		taken.every((d) => d.family !== SWARM_UNIT_FAMILY));
	// Without the keys (v2 session, dev scan), no cluster is reinvented.
	check('scan with no swarm key -> no swarmUnit',
		ambientSet({ seed: 'swarm-amb', count: 4, index: 1 }).every((d) => d.family !== SWARM_UNIT_FAMILY));
}

console.log('\nambient: routines');
{
	check('one routine per family', TARGET_FAMILIES.every((f) => ROUTINES[f]));
	// The cluster left behind (issue #29): ONE unit, on an ordinary routine —
	// a fast low orbit, not a flock in the distance.
	check('a routine for swarmUnit', !!ROUTINES[SWARM_UNIT_FAMILY]);
	check('a_max(twr=2) = g·√3', Math.abs(lateralAccelMax(2) - G * Math.sqrt(3)) < 1e-9);
	check('a_max(twr≤1) = 0', lateralAccelMax(1) === 0 && lateralAccelMax(0.5) === 0);

	for (const family of TARGET_FAMILIES) {
		const build = targetBuild({ seed: `r::${family}`, family });
		const r = routineFor({ family, twr: build.spec.twr, rand: rngFrom(`rt::${family}`) });
		const spec = ROUTINES[family];
		check(`${family}: speed within range`, r.speed >= spec.speed[0] - 1e-9 && r.speed <= spec.speed[1] + 1e-9, `${r.speed.toFixed(1)}`);
		check(`${family}: radius within range`, r.radius >= spec.radius[0] && r.radius <= spec.radius[1]);
		check(`${family}: AGL within range`, r.agl >= spec.agl[0] && r.agl <= spec.agl[1]);
		check(`${family}: v²/r ≤ 0.6·a_max`, r.speed * r.speed / r.radius <= TURN_MARGIN * lateralAccelMax(build.spec.twr) + 1e-9,
			`${(r.speed * r.speed / r.radius).toFixed(1)} vs ${(TURN_MARGIN * lateralAccelMax(build.spec.twr)).toFixed(1)}`);
		check(`${family}: v²/r ≤ g·tan(TILT_MAX)`, r.speed * r.speed / r.radius <= G * Math.tan(TILT_MAX_DEG * Math.PI / 180) + 1e-9,
			`${(r.speed * r.speed / r.radius).toFixed(1)} vs ${(G * Math.tan(TILT_MAX_DEG * Math.PI / 180)).toFixed(1)}`);
		check(`${family}: period > 0`, r.period > 0);
	}
	const a = routineFor({ family: 'race5', twr: 8, rand: rngFrom('same') });
	const b = routineFor({ family: 'race5', twr: 8, rand: rngFrom('same') });
	check('same seed → same routine', JSON.stringify(a) === JSON.stringify(b));
	check('the micro has jitter', routineFor({ family: 'toothpick', twr: 3, rand: rngFrom('j') }).jitter.length === 3);
	check('the cinewhoop has none', routineFor({ family: 'cinewhoop', twr: 2.8, rand: rngFrom('j') }).jitter.length === 0);
	// A low TWR brings the speed down: at twr 1.5 on a 15 m radius, v ≤ √(0.6·g·√1.25·15)
	const slow = routineFor({ family: 'race5', twr: 1.5, rand: rngFrom('slow') });
	check('low TWR caps the speed', slow.speed * slow.speed / slow.radius <= TURN_MARGIN * lateralAccelMax(1.5) + 1e-9);
	const veryLowTWR = routineFor({ family: 'race5', twr: 1.01, rand: rngFrom('twr-1.01') });
	check('twr 1.01: invariant v²/r ≤ 0.6·a_max holds', veryLowTWR.speed * veryLowTWR.speed / veryLowTWR.radius <= TURN_MARGIN * lateralAccelMax(1.01) + 1e-9);
}

console.log('\nambient: curves');
{
	const out = { x: 0, y: 0, z: 0 };
	const anchor = { x: 100, y: 0, z: -50 };
	const flat = { groundBelow: () => 20 };
	for (const family of TARGET_FAMILIES) {
		const r = routineFor({ family, twr: 6, rand: rngFrom(`c::${family}`) });
		// Closed: p(0) = p(period).
		curveLocal(r, 0, out); const p0 = { ...out };
		curveLocal(r, r.period, out);
		check(`${family}: closed curve`, Math.hypot(out.x - p0.x, out.y - p0.y, out.z - p0.z) < 1e-6);
		// Radius respected (jitter aside: ±0.9 m max for 3 sines of 0.3).
		let maxR = 0;
		for (let i = 0; i < 200; i++) { curveLocal(r, r.period * i / 200, out); maxR = Math.max(maxR, Math.hypot(out.x, out.z)); }
		const bound = r.kind === 'cruise' ? r.leg / 2 + r.radius : r.kind === 'eight' ? 2 * r.radius : r.radius;
		check(`${family}: horizontal radius ≤ bound`, maxR <= bound + 1.0, `${maxR.toFixed(1)} vs ${bound.toFixed(1)}`);
		// Heights: flat ground at 20 → curve at 20 + agl everywhere (± vertical sine).
		const heights = new Float64Array(HEIGHT_SAMPLES);
		check(`${family}: heights computed`, curveHeights(r, anchor, flat.groundBelow, heights));
		check(`${family}: height = ground + agl`, Array.from(heights).every((h) => Math.abs(h - (20 + r.agl)) < 1e-9));
		curveAt(r, anchor, heights, r.period * 0.37, out);
		check(`${family}: curveAt above the ground`, out.y >= 20 + r.aglMin - r.vertical - 1e-9);
		// Derived speed ≈ drawn speed (within 10 %: the eights and the jitter distort it).
		const pos = { x: 0, y: 0, z: 0 }, vel = { x: 0, y: 0, z: 0 }, acc = { x: 0, y: 0, z: 0 };
		let vAvg = 0; const N = 100;
		for (let i = 0; i < N; i++) { derive(r, anchor, heights, r.period * i / N, 1 / 60, pos, vel, acc); vAvg += Math.hypot(vel.x, vel.z) / N; }
		check(`${family}: derived |v| ≈ speed`, Math.abs(vAvg - r.speed) / r.speed < 0.12, `${vAvg.toFixed(1)} vs ${r.speed.toFixed(1)}`);
		check(`${family}: finite acceleration`, Number.isFinite(acc.x) && Number.isFinite(acc.y) && Number.isFinite(acc.z));
	}
	// The eight reparameterised by arc length (arc[], 64 chords) must not spike
	// in acceleration at each node, nor depend on the refresh rate (the
	// derivation's dt, not the game loop's dt — DERIVE_H is fixed).
	{
		const flatGround = () => 0;
		const anchor0 = { x: 0, y: 0, z: 0 };
		for (const [family] of [['freestyle5'], ['heavy5']]) {
			const r = routineFor({ family, twr: 6, rand: rngFrom('v') });
			const heights = new Float64Array(HEIGHT_SAMPLES);
			curveHeights(r, anchor0, flatGround, heights);
			const pos = { x: 0, y: 0, z: 0 }, vel = { x: 0, y: 0, z: 0 }, acc = { x: 0, y: 0, z: 0 };
			const scan = (h) => {
				let maxA = 0;
				for (let i = 0; i < 600; i++) {
					derive(r, anchor0, heights, r.period * i / 600, h, pos, vel, acc);
					maxA = Math.max(maxA, Math.hypot(acc.x, acc.y, acc.z));
				}
				return maxA;
			};
			const a60 = scan(1 / 60), a240 = scan(1 / 240);
			check(`${family}: acceleration without chord spikes`, a60 <= 3 * G, `${a60.toFixed(1)} vs 3G=${(3 * G).toFixed(1)}`);
			check(`${family}: acceleration independent of the step`, Math.abs(a240 - a60) / a60 < 0.25, `${a60.toFixed(1)} (1/60) vs ${a240.toFixed(1)} (1/240)`);
		}
	}
	// A missing ground makes the heights fail.
	const r = routineFor({ family: 'race5', twr: 6, rand: rngFrom('hole') });
	const heights = new Float64Array(HEIGHT_SAMPLES);
	check('null ground → false', curveHeights(r, anchor, (x) => (x > 100 ? null : 0), heights) === false);
	// The relief is followed: sloping ground → different heights at both ends.
	const slope = (x) => x * 0.1;
	curveHeights(r, anchor, slope, heights);
	check('the relief is followed', Math.max(...heights) - Math.min(...heights) > 1);
}

console.log('\nambient: bubble, anchors, validation');
{
	const bigRect = { bbox: { min: [-2000, 0, -2000], max: [2000, 200, 2000] }, corridor: { hold: 24 } };
	const smallRect = { bbox: { min: [-90, 0, -90], max: [90, 100, 90] }, corridor: { hold: 10 } };
	const live = { center: { x: 0, z: 0 }, trusted: 180 };
	const noLive = { center: null, trusted: 180 };
	const player = { x: 0, y: 30, z: 0 };
	const cam = { fx: 0, fy: 0, fz: -1 };   // looks towards −Z (north)
	const flat = (x, z) => 0;
	const rays = { groundBelow: () => 0, obstructionBetween: () => ({ blocked: false, span: 0 }) };
	const wallRays = { groundBelow: () => 0, obstructionBetween: (ax, ay, az, bx) => ({ blocked: bx > 50, span: bx > 50 ? 6 : 0 }) };

	const b = bubbleFor(bigRect, player);
	check('large map: nominal ring', b.rMin === R_SPAWN[0] && b.rMax === R_SPAWN[1] && b.rLeave === R_LEAVE);
	const s = bubbleFor(smallRect, player);
	check('small map: tightened ring', s.rMax === 80 && s.rMin <= s.rMax);
	check('small map: never leaves', s.rLeave === Infinity);
	const l = bubbleFor(live, player);
	check('live: rMax = trusted radius', l.rMax === 180 && l.rLeave === 250);

	check('outOfView: behind', outOfView(0, 100, 0, cam, 120) === true);
	check('outOfView: ahead', outOfView(0, -100, 0, cam, 120) === false);
	check('outOfView: on the edge + margin', outOfView(Math.sin(70 * Math.PI / 180) * 100, -Math.cos(70 * Math.PI / 180) * 100, 0, cam, 120) === false);
	check('outOfView: beyond the margin', outOfView(Math.sin(80 * Math.PI / 180) * 100, -Math.cos(80 * Math.PI / 180) * 100, 0, cam, 120) === true);

	check('insideBounds rect: inside', insideBounds(bigRect, 0, 0, 10, 30));
	check('insideBounds rect: edge', !insideBounds(bigRect, 1990, 0, 10, 30));
	check('insideBounds rect: below the floor', !insideBounds(bigRect, 0, 0, 2, 30));
	check('insideBounds live: inside', insideBounds(live, 100, 0, 10, 30));
	check('insideBounds live: outside', !insideBounds(live, 170, 0, 10, 30));
	check('insideBounds live with no centre: never', !insideBounds(noLive, 0, 0, 10, 30));

	// 200 anchors drawn: all in the ring, out of view or > 220 m, inside the fence.
	const rand = rngFrom('anchors');
	let ok = 0, n = 0;
	for (let i = 0; i < 200; i++) {
		const a = pickAnchor({ rand, player, cam, fovDeg: 120, bounds: bigRect, radius: 20, rays, top: 250, span: 400, agl: 10 });
		if (!a) continue;
		n++;
		const d = Math.hypot(a.x - player.x, a.z - player.z);
		const inRing = d >= R_SPAWN[0] - 1e-9 && d <= R_SPAWN[1] + 1e-9;
		// At FLIGHT height (y + agl), like pickAnchor: an anchor on the ground
		// would be judged hidden for a reason it will never live.
		const hidden = outOfView(a.x - player.x, a.z - player.z, (a.y + 10) - player.y, cam, 120) || d >= 220;
		if (inRect(a) && inRing && hidden) ok++;
	}
	function inRect(a) { return insideBounds(bigRect, a.x, a.z, a.y + 10, 20); }
	// E[n]: P(d<220)=100/130≈0.769, P(visible)=150°/360°≈0.417 (fovDeg=120, margin=15)
	// ⇒ P(reject)≈0.320 ⇒ E[n]≈136, σ=√(200·0.68·0.32)≈6.6. A broken outOfView (sign
	// of fz) rejects almost everything: n drops to ≤ 46. Threshold at 110, well under E[n]-σ.
	check('200 anchors: all compliant', n > 110 && ok === n, `${ok}/${n}`);
	check('no ground → no anchor', pickAnchor({ rand, player, cam, fovDeg: 120, bounds: bigRect, radius: 20, rays: { ...rays, groundBelow: () => null }, top: 250, span: 400, agl: 10 }) === null);

	// Validation: flat → ok; wall → rejected; ground too high under a point → rejected.
	const r = routineFor({ family: 'freestyle5', twr: 6, rand: rngFrom('v') });
	const heights = new Float64Array(HEIGHT_SAMPLES);
	check('curve over flat ground: valid', validateCurve({ routine: r, anchor: { x: 0, y: 0, z: 0 }, rays, heights, top: 250, span: 400 }));
	check('curve against a wall: rejected', !validateCurve({ routine: r, anchor: { x: 40, y: 0, z: 0 }, rays: wallRays, heights, top: 250, span: 400 }));
	const bump = { groundBelow: (x) => (x > 10 ? 200 : 0), obstructionBetween: () => ({ blocked: false, span: 0 }) };
	check('curve with a point under the relief: rejected', !validateCurve({ routine: r, anchor: { x: 0, y: 0, z: 0 }, rays: bump, heights, top: 250, span: 400 }));
	// A grazed roof (span ≤ 2) passes.
	const roof = { groundBelow: () => 0, obstructionBetween: () => ({ blocked: true, span: 1.5 }) };
	check('grazed roof: accepted', validateCurve({ routine: r, anchor: { x: 0, y: 0, z: 0 }, rays: roof, heights, top: 250, span: 400 }));

	// THE failure mode of `havre` (Task 9 report): a building BETWEEN two
	// nodes of the coarse grid. The 'v' eight above passes x = 7.51 then
	// x = 14.08 at the 16th nodes; the window 9 < x < 12 therefore contains
	// NO coarse node, but two fine nodes (x = 10.31 and 11.29). A 30 m
	// building standing there was invisible to 16 rays and is seen by 64.
	// No segment cuts it either: the curve passes 14 m above the flat ground
	// and 16 m ABOVE the roof — the wall rule cannot see anything.
	const _o = { x: 0, y: 0, z: 0 };
	const inWindow = (x) => x > 9 && x < 12;
	let coarseHits = 0, fineHits = 0;
	for (let i = 0; i < SAMPLES; i++) { curveLocal(r, r.period * i / SAMPLES, _o); if (inWindow(_o.x)) coarseHits++; }
	for (let i = 0; i < HEIGHT_SAMPLES; i++) { curveLocal(r, r.period * i / HEIGHT_SAMPLES, _o); if (inWindow(_o.x)) fineHits++; }
	check('premise: the bump falls between two coarse nodes, on fine nodes',
		coarseHits === 0 && fineHits > 0, `${coarseHits} node(s)/${SAMPLES} vs ${fineHits} node(s)/${HEIGHT_SAMPLES}`);
	const hidden = { groundBelow: (x) => (inWindow(x) ? 30 : 0), obstructionBetween: () => ({ blocked: false, span: 0 }) };
	check('building hidden between two coarse nodes: rejected',
		!validateCurve({ routine: r, anchor: { x: 0, y: 0, z: 0 }, rays: hidden, heights, top: 250, span: 400 }));

	// The floor is judged while the profile is cast (early exit). Reference:
	// the whole profile first, then the floor, then the walls — the verdict
	// must be identical on every family over bumpy, holed and walled ground,
	// and a curve that fails on the floor must stop casting there.
	const reference = (routine, anchor, rs, h) => {
		if (!curveHeights(routine, anchor, (x, z) => rs.groundBelow(x, 250, z, 400), h)) return false;
		const p = { x: 0, y: 0, z: 0 }, q = { x: 0, y: 0, z: 0 };
		for (let i = 0; i < HEIGHT_SAMPLES; i++) {
			curveAt(routine, anchor, h, routine.period * i / HEIGHT_SAMPLES, p);
			const g = Math.max(h[i], h[(i + 1) % HEIGHT_SAMPLES]) - routine.agl;
			if (p.y - g < routine.aglMin) return false;
		}
		for (let i = 0; i < SAMPLES; i++) {
			curveAt(routine, anchor, h, routine.period * i / SAMPLES, p);
			curveAt(routine, anchor, h, routine.period * (i + 1) / SAMPLES, q);
			const o = rs.obstructionBetween(p.x, p.y, p.z, q.x, q.y, q.z);
			if (o.blocked && o.span > 2) return false;
		}
		return true;
	};
	const rnd = rngFrom('early-exit');
	let same = 0, total = 0, accepted = 0, rejected = 0;
	for (const family of TARGET_FAMILIES) {
		for (let n = 0; n < 60; n++) {
			const rr = routineFor({ family, twr: 6, rand: rngFrom(`ee::${family}::${n}`) });
			const bx = (rnd() - 0.5) * 200, bz = (rnd() - 0.5) * 200, bh = rnd() * 40, bw = 3 + rnd() * 30;
			const kind = n % 4;   // 0 flat + block, 1 slope + block + hole, 2 slope + block, 3 slope + wall
			const g = (x, z) => {
				if (kind === 1 && x > 300) return null;
				const inB = Math.abs(x - bx) < bw && Math.abs(z - bz) < bw;
				return (kind === 0 ? 0 : 0.05 * x) + (inB && kind !== 3 ? bh : 0);
			};
			const rs = {
				groundBelow: (x, _t, z) => g(x, z),
				obstructionBetween: (ax, ay, az, bx2) => (kind === 3 && bx2 > bx ? { blocked: true, span: 5 } : { blocked: false, span: 0 }),
			};
			const anchor = { x: (rnd() - 0.5) * 60, y: 0, z: (rnd() - 0.5) * 60 };
			const a = validateCurve({ routine: rr, anchor, rays: rs, heights: new Float64Array(HEIGHT_SAMPLES), top: 250, span: 400 });
			const b = reference(rr, anchor, rs, new Float64Array(HEIGHT_SAMPLES));
			total++; if (a === b) same++; if (b) accepted++; else rejected++;
		}
	}
	check('early exit: same verdict as the full profile', same === total && accepted > 0 && rejected > 0,
		`${same}/${total} (${accepted} accepted, ${rejected} rejected)`);
	const stats = { raysCast: 0 };
	const cliff = { groundBelow: () => (stats.raysCast > 2 ? 200 : 0), obstructionBetween: () => ({ blocked: false, span: 0 }) };
	check('early exit: rejected on the floor',
		!validateCurve({ routine: r, anchor: { x: 0, y: 0, z: 0 }, rays: cliff, heights, top: 250, span: 400, stats }));
	check('early exit: the profile stops at the failing node', stats.raysCast < 8, `${stats.raysCast} rays of ${HEIGHT_SAMPLES}`);
}

console.log('\nambient: model');
{
	// min[1] = -50: the flat-ground stub at 0 stands 50 m above the floor, like
	// a real map whose bbox.min[1] is its lowest mesh vertex.
	const bigRect = { bbox: { min: [-2000, -50, -2000], max: [2000, 200, 2000] }, corridor: { hold: 24 } };
	const rays = { groundBelow: () => 0, obstructionBetween: () => ({ blocked: false, span: 0 }) };
	const scan = { seed: 'model-a', count: 5, index: 0 };
	const set = ambientSet(scan);
	const builds = set.map((d) => targetBuild({ seed: d.buildSeed, family: d.family }));
	const mk = () => new AmbientModel({ set, builds, bounds: bigRect, seed: scan.seed });
	const cam = { fx: 0, fy: 0, fz: -1 };
	const wind = { x: 0, y: 0, z: 0 };
	const player = { x: 0, y: 30, z: 0 };
	const frame = (m, p, dt = 1 / 60) => m.update({ dt, player: p, cam, fovDeg: 120, rays, top: 250, span: 400, wind });

	const m = mk();
	check('empty at the start', m.count === 0);
	frame(m, player);
	check('one birth per frame', m.count === 1);
	for (let i = 0; i < 3; i++) frame(m, player);
	check('four after four frames', m.count === 4, `${m.count}`);
	frame(m, player);
	check('never more than the set', m.count === 4);
	check('families = set', m.families.join() === set.map((d) => d.family).join());

	// Determinism.
	const m2 = mk();
	for (let i = 0; i < 4; i++) frame(m2, player);
	check('same seed → same anchors', Array.from(m.anchors).every((v, i) => v === m2.anchors[i]));

	// dt 0: nothing moves, nothing is born.
	const before = Array.from(m.pos);
	m.update({ dt: 0, player, cam, fovDeg: 120, rays, top: 250, span: 400, wind });
	check('dt 0: still', Array.from(m.pos).every((v, i) => v === before[i]));

	// Zero allocation: same references.
	const refs = [m.pos, m.vel, m.acc, m.quat, m.anchors];
	for (let i = 0; i < 1000; i++) frame(m, player);
	check('update does not allocate', refs.every((r, i) => r === [m.pos, m.vel, m.acc, m.quat, m.anchors][i]));
	check('finite positions', Array.from(m.pos).every(Number.isFinite));

	// Relocation: player moved by 400 m → every anchor is reborn.
	const far = { x: 400, y: 30, z: 0 };
	const anchorsBefore = Array.from(m.anchors);
	for (let i = 0; i < 5; i++) frame(m, far);
	check('400 m: all relocated', m.stats.relocations >= 4, `${m.stats.relocations}`);
	check('400 m: new anchors in the ring around the player',
		[0, 1, 2, 3].every((k) => { const d = Math.hypot(m.anchors[3 * k] - far.x, m.anchors[3 * k + 2] - far.z); return d >= R_SPAWN[0] && d <= R_SPAWN[1]; }));
	check('400 m: different anchors', anchorsBefore.some((v, i) => v !== m.anchors[i]));
	// 60 m: none.
	const before60 = m.stats.relocations;
	for (let i = 0; i < 5; i++) frame(m, { x: 460, y: 30, z: 0 });
	check('60 m: no relocation', m.stats.relocations === before60);

	// Small map: everything inside, never leaves.
	// Same reason as above: the flat ground at 0 must stay above the floor.
	const small = { bbox: { min: [-90, -50, -90], max: [90, 100, 90] }, corridor: { hold: 10 } };
	const ms = new AmbientModel({ set, builds, bounds: small, seed: 's' });
	for (let i = 0; i < 6; i++) frame(ms, player);
	check('small map: drones are born', ms.count >= 1);
	for (let i = 0; i < 60; i++) frame(ms, { x: 80, y: 30, z: 80 });
	check('small map: never leaves', ms.stats.relocations === 0);
	check('small map: positions inside the fence', [...Array(ms.count).keys()].every((k) => Math.abs(ms.pos[3 * k]) < 90 && Math.abs(ms.pos[3 * k + 2]) < 90));

	// An IMPOSSIBLE slot no longer blocks the others. On this same small map
	// (half-side 90, hold 10), a long range asks for `leg/2 + radius = 320 m`
	// of margin: it can NEVER be born here. Before the cursor rotation,
	// spawnOne() always restarted from slot 0 — a long range at the head froze
	// the whole sky behind it, forever (0/4 measured on `paristest`).
	{
		// The seed is SEARCHED for rather than copied: the family table can
		// move, the invariant wanted is "the first candidate not taken is a
		// long range, and it is the only one".
		let found = null;
		for (let i = 0; i < 200 && !found; i++) {
			const sc = { seed: `cursor${i}`, count: 5, index: 0 };
			const st = ambientSet(sc);
			if (st.length >= 2 && st[0].family === 'longrange' && !st.slice(1).some((d) => d.family === 'longrange')) {
				found = { scan: sc, set: st };
			}
		}
		check('seed with a long range at the head found', found !== null, found && `${found.scan.seed} : ${found.set.map((d) => d.family).join(',')}`);
		if (found) {
			const bs = found.set.map((d) => targetBuild({ seed: d.buildSeed, family: d.family }));
			const mc = new AmbientModel({ set: found.set, builds: bs, bounds: small, seed: found.scan.seed });
			for (let i = 0; i < 12; i++) frame(mc, player);
			check('impossible slot: the others are born anyway',
				mc.count >= 1 && mc.count === found.set.length - 1, `${mc.count}/${found.set.length - 1}`);
			check('impossible slot: it is indeed the long range that is missing', mc.alive[0] === 0);
			check('impossible slot: the failures are counted', mc.stats.spawnFailures > 0, `${mc.stats.spawnFailures}`);
			// … and it no longer costs RAYS either. The HORIZONTAL fence is
			// decided BEFORE the ground ray: a long range asking for 320 m of
			// margin on a map that offers 80 is rejected without casting a
			// single ray. Before the reordering, it was 3 full-mesh rays per
			// frame — 180 per second, forever.
			//
			// Bound at 3 rays/s: the impossible slot costs 0, and nothing else
			// tries to be born (the three others are flying). The watchdog
			// (10 consecutive failures → 1 s pause) bounds anyway a slot that
			// would fail AFTER its ray at ~10 rays/s, very far from the 180
			// of before.
			for (let i = 0; i < 60; i++) frame(mc, player);   // 1 s: steady state
			const raysAt1s = mc.stats.raysCast;
			for (let i = 0; i < 600; i++) frame(mc, player);  // 10 s more
			const perSecond = (mc.stats.raysCast - raysAt1s) / 10;
			check('impossible slot: ≤ 3 rays/s in steady state', perSecond <= 3, `${perSecond.toFixed(1)} rays/s`);
			check('impossible slot: the others still fly', mc.count === found.set.length - 1, `${mc.count}`);
		}
	}

	// No ground (live not loaded): nothing is born, failures counted, no exception.
	const mh = new AmbientModel({ set, builds, bounds: { center: { x: 0, z: 0 }, trusted: 180 }, seed: 'h' });
	for (let i = 0; i < 20; i++) mh.update({ dt: 1 / 60, player, cam, fovDeg: 120, rays: { ...rays, groundBelow: () => null }, top: 250, span: 400, wind });
	check('no ground: no birth', mh.count === 0 && mh.stats.spawnFailures > 0);
	check('rays counted', mh.stats.raysCast > 0);

	// reset: starts again from zero around the player.
	m.reset();
	check('reset: empty', m.count === 0);
}

console.log('\nambient: attitude');
{
	const q = new Float64Array(4);
	const still = { ax: 0, ay: 0, az: 0, vx: 0, vy: 0, vz: 0, wind: { x: 0, y: 0, z: 0 }, drag: { x: 0.01, y: 0.028, z: 0.01 }, mass: 0.65, yawX: 0, yawZ: -1 };
	attitudeFrom(still, q, 0);
	check('still: level', tiltOf(q, 0) < 1e-6);
	check('still: unit quaternion', Math.abs(Math.hypot(q[0], q[1], q[2], q[3]) - 1) < 1e-9);
	// Lateral acceleration g → 45°.
	attitudeFrom({ ...still, ax: G }, q, 0);
	check('a = g → 45°', Math.abs(tiltOf(q, 0) - Math.PI / 4) < 1e-6, `${(tiltOf(q, 0) * 180 / Math.PI).toFixed(1)}°`);
	// Headwind at 10 m/s: leaning into the wind (drag), so tilt > 0 even when still.
	attitudeFrom({ ...still, wind: { x: 10, y: 0, z: 0 } }, q, 0);
	check('wind: leaning', tiltOf(q, 0) > 0.01);
	// The nose follows the yaw: yaw towards +X → the body's −Z axis points to +X.
	attitudeFrom({ ...still, yawX: 1, yawZ: 0 }, q, 0);
	const fx = 2 * (q[0] * q[2] + q[3] * q[1]);   // X component of R·(0,0,-1)… (see impl)
	check('yaw: nose towards +X', Math.abs(fx - 1) < 1e-6 || Math.abs(fx + 1) < 1e-6);

	// The tilt ceiling itself: the requested thrust is folded back onto the
	// TILT_MAX_DEG cone, whatever the requested acceleration.
	attitudeFrom({ ...still, ax: 100 * G }, q, 0);
	check('huge lateral a → capped at TILT_MAX', Math.abs(tiltOf(q, 0) - TILT_MAX_DEG * Math.PI / 180) < 1e-9,
		`${(tiltOf(q, 0) * 180 / Math.PI).toFixed(1)}°`);
	// The case that broke everything: a downward VERTICAL acceleration
	// stronger than g flips the thrust below the horizon. It is the eight's
	// sine, the loop's tilted plane, the micro's jitter — nothing in v²/r bounds it.
	attitudeFrom({ ...still, ay: -3 * G, ax: G }, q, 0);
	check('vertical a below −g → still ≤ TILT_MAX', tiltOf(q, 0) <= TILT_MAX_DEG * Math.PI / 180 + 1e-9,
		`${(tiltOf(q, 0) * 180 / Math.PI).toFixed(1)}°`);
	check('vertical a below −g → unit quaternion', Math.abs(Math.hypot(q[0], q[1], q[2], q[3]) - 1) < 1e-9);
	// Thrust exactly straight down: no horizontal direction to keep, level
	// out rather than divide by zero.
	attitudeFrom({ ...still, ay: -3 * G }, q, 0);
	check('thrust straight down → level, no NaN', tiltOf(q, 0) < 1e-9 && Number.isFinite(q[3]));

	// clampTilt: the safety net on the RENDERED quaternion (the smoothing's
	// nlerp leaves the cone even between two targets that are inside it).
	{
		// 120° roll about X: q = (sin60, 0, 0, cos60).
		const r = new Float64Array([Math.sin(Math.PI / 3), 0, 0, Math.cos(Math.PI / 3)]);
		check('clampTilt: premise at 120°', Math.abs(tiltOf(r, 0) - 2 * Math.PI / 3) < 1e-9, `${(tiltOf(r, 0) * 180 / Math.PI).toFixed(1)}°`);
		check('clampTilt: folds back and says so', clampTilt(r, 0) === true);
		check('clampTilt: exactly on the cone', Math.abs(tiltOf(r, 0) - TILT_MAX_DEG * Math.PI / 180) < 1e-9, `${(tiltOf(r, 0) * 180 / Math.PI).toFixed(1)}°`);
		check('clampTilt: unit quaternion', Math.abs(Math.hypot(r[0], r[1], r[2], r[3]) - 1) < 1e-9);
		// Already inside the cone: touches nothing, and says so.
		attitudeFrom({ ...still, ax: G }, q, 0);
		const before = Array.from(q);
		check('clampTilt: at 45°, touches nothing', clampTilt(q, 0) === false && Array.from(q).every((v, i) => v === before[i]));
	}

	// On the curves, a SWEEP per family: 50 seeds, 600 frames each. A single
	// seed proved nothing — it drew a radius and a speed, not the family. At
	// 50 the extreme cases show: this sweep is what measured 157° on a
	// toothpick and 110° on a race5 when the ceiling only bounded the LATERAL
	// acceleration (v²/r), the figures' vertical going straight through.
	//
	// min[1] = −50: the flat ground at 0 stands above the fence's floor,
	// otherwise a micro at 1 m AGL would never be born (FLOOR_MARGIN_M).
	const bigRect = { bbox: { min: [-4000, -50, -4000], max: [4000, 200, 4000] }, corridor: { hold: 24 } };
	const rays = { groundBelow: () => 0, obstructionBetween: () => ({ blocked: false, span: 0 }) };
	const cam = { fx: 0, fy: 0, fz: -1 }, player = { x: 0, y: 30, z: 0 }, wind = { x: 0, y: 0, z: 0 };
	const SEEDS = 50, FRAMES = 600, WARMUP = 10;
	// swarmUnit (issue #29) is swept like the others: it is never piloted,
	// but it FLIES, and an invalid routine would show there just the same.
	for (const family of [...TARGET_FAMILIES, SWARM_UNIT_FAMILY]) {
		const buildFamily = family === SWARM_UNIT_FAMILY ? SWARM_UNIT_BUILD_FAMILY : family;
		let maxTilt = 0, sumTilt = 0, n = 0, born = 0;
		for (let i = 0; i < SEEDS; i++) {
			// A set of ONE SINGLE drone of the family: the sweep exercises the
			// family, not a scan's candidate table.
			const buildSeed = `sweep::${family}::${i}`;
			const set = [{ i: 0, id: 'x', family, buildFamily, buildSeed, rssiDbm: -60, mode: 'analog' }];
			const builds = [targetBuild({ seed: buildSeed, family: buildFamily })];
			const m = new AmbientModel({ set, builds, bounds: bigRect, seed: buildSeed });
			for (let f = 0; f < FRAMES; f++) {
				m.update({ dt: 1 / 60, player, cam, fovDeg: 120, rays, top: 250, span: 400, wind });
				if (f < WARMUP || !m.alive[0]) continue;
				const t = tiltOf(m.quat, 0);
				maxTilt = Math.max(maxTilt, t); sumTilt += t; n++;
			}
			if (m.alive[0]) born++;
		}
		const maxDeg = maxTilt * 180 / Math.PI, meanDeg = n ? sumTilt / n * 180 / Math.PI : 0;
		check(`${family}: ${born}/${SEEDS} seeds fly`, born > SEEDS / 2, `${born}`);
		check(`${family}: max tilt ≤ 75° over ${SEEDS} seeds`, maxDeg <= 75 + 1e-9, `${maxDeg.toFixed(1)}°`);
		if (family === 'race5') check('race5: laid over (> 35° on average)', meanDeg > 35, `${meanDeg.toFixed(1)}°`);
		if (family === 'cinewhoop') check('cinewhoop: level (< 12°)', meanDeg < 12, `${meanDeg.toFixed(1)}°`);
	}
}

console.log(`\n${failures ? `${failures} FAIL` : 'all PASS'}`);
process.exit(failures ? 1 : 0);

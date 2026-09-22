// Checks for src/entry-state.js that need no scene/physics — the category
// draw only. The scene-dependent parts (sampleCandidate, geometrySafe,
// rolloutSafe, generateEntryState) are checked in tools/selftest.mjs, which
// already loads a real Physics instance for a real scene.
//
//   node tools/entry-state-selftest.mjs

import fs from 'node:fs';
import path from 'node:path';
import { SCENES_DIR } from './lib/paths.mjs';
import {
	CATEGORIES, WEIGHTS, rngFrom, pickCategory, occupancyOf, sampleCandidate,
	resolveCategory, capCategory, fallbackCandidate, generateEntryState, insetRect, RANGES,
} from '../src/entry-state.js';
import { Geofence } from '../src/geofence.js';
import { PROFILES } from '../src/drone-profiles.js';

let failures = 0;
function check(label, ok, detail) {
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures++;
}

console.log('entry-state: category draw');

check('weights sum to 100', WEIGHTS.reduce((a, b) => a + b, 0) === 100);
check('one weight per category', WEIGHTS.length === CATEGORIES.length);

{
	const rand = rngFrom('same-seed');
	const rand2 = rngFrom('same-seed');
	const seq1 = [rand(), rand(), rand()];
	const seq2 = [rand2(), rand2(), rand2()];
	check('same seed reproduces the same draw sequence', seq1.every((v, i) => v === seq2[i]));
}

{
	const rand = rngFrom('distribution-check');
	const counts = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
	const N = 20000;
	for (let i = 0; i < N; i++) counts[pickCategory(rand)]++;
	for (let i = 0; i < CATEGORIES.length; i++) {
		const cat = CATEGORIES[i];
		const pct = (counts[cat] / N) * 100;
		check(`${cat} lands within ±3 points of ${WEIGHTS[i]}%`, Math.abs(pct - WEIGHTS[i]) <= 3,
			`measured ${pct.toFixed(1)}%`);
	}
}

// ---------------------------------------------------------------- occupancy
//
// The draw used to pick a point anywhere in the manifest bbox and give up when
// there was no ground under it. A scene traced with a polygon (issue #30) only
// fills a fraction of its bbox, so most draws fell into the void: measured 315
// misses out of 400 on a river corridor, against 0/400 on a rectangular scene.
//
// A stub physics is enough here: occupancy only ever asks "is there ground at
// (x, z)". No Rapier, no scene.
const BBOX = { min: [-500, 0, -500], max: [500, 100, 500] };
const manifestOf = (bbox) => ({ bbox, spawn: { x: 0, y: 10, z: 0 } });

// Ground everywhere: the full scene every existing map already is.
const solidPhysics = { groundBelow: () => 0 };
// Ground only in a 60 m band along the x = z diagonal: a corridor.
const corridorPhysics = { groundBelow: (x, _y, z) => (Math.abs(x - z) < 30 ? 0 : null) };

console.log('\nentry-state: occupancy');

const solid = occupancyOf(solidPhysics, manifestOf(BBOX));
check('a solid scene occupies every cell', solid.cells.length === solid.cols * solid.rows,
	`${solid.cells.length}/${solid.cols * solid.rows}`);

const corridor = occupancyOf(corridorPhysics, manifestOf(BBOX));
check('a corridor occupies a fraction of its cells', corridor.cells.length < corridor.cols * corridor.rows / 3,
	`${corridor.cells.length}/${corridor.cols * corridor.rows}`);
check('a corridor still occupies something', corridor.cells.length > 0);

// Cells are ~25 m, the width of a slippy tile at zoom 20 — fine enough to
// follow a corridor, coarse enough that the sweep stays a few thousand rays.
check('cell size is about a slippy tile', corridor.cellSize > 15 && corridor.cellSize <= 30,
	`${corridor.cellSize.toFixed(1)} m`);

// The sweep is the expensive part, so it must happen once per physics world.
check('occupancy is cached per physics instance', occupancyOf(corridorPhysics, manifestOf(BBOX)) === corridor);

// A scene with no ground at all must not wedge the draw: it degrades to the
// whole bbox rather than to an empty cell list.
const voidGrid = occupancyOf({ groundBelow: () => null }, manifestOf(BBOX));
check('a scene with no ground falls back to the whole bbox', voidGrid.cells.length > 0);

console.log('\nentry-state: the draw lands on ground');

// What matters is not that an isolated draw always succeeds — it is that
// generateEntryState(), which retries 20 times before falling back to a resting
// spawn, practically never has to fall back. So the draw is measured AGAINST A
// CONTROL: the old behaviour, uniform in the bbox.
const missRate = (phys, draw) => {
	const rand = rngFrom('draw-check');
	let miss = 0;
	for (let i = 0; i < 400; i++) if (!draw(CATEGORIES[i % CATEGORIES.length], phys, rand)) miss++;
	return miss / 400;
};
const withGrid = (cat, phys, rand) => sampleCandidate(cat, manifestOf(BBOX), phys, rand);
// The control: exactly what sampleCandidate used to do, a random point in the
// footprint.
const uniformInBbox = (cat, phys, rand) => {
	const x = BBOX.min[0] + 10 + rand() * (BBOX.max[0] - BBOX.min[0] - 20);
	const z = BBOX.min[2] + 10 + rand() * (BBOX.max[2] - BBOX.min[2] - 20);
	return phys.groundBelow(x, 0, z) === null ? null : {};
};

check('solid: the draw never misses', missRate(solidPhysics, withGrid) === 0);

const before = missRate(corridorPhysics, uniformInBbox);
const after = missRate(corridorPhysics, withGrid);
check('corridor: the draw misses far less than drawing in the bbox',
	after < before / 3,
	`${(before * 100).toFixed(0)}% → ${(after * 100).toFixed(0)}%`);

// And the consequence that motivated all of it: generateEntryState()'s fallback
// holds out for 20 attempts, so a miss rate of p gives p^20 of sessions starting
// at a standstill instead of arriving in flight.
const fallback = (p) => p ** 20;
check('corridor: fallback to a resting spawn becomes negligible',
	fallback(after) < 1e-6 && fallback(before) > 1e-3,
	`${(fallback(before) * 100).toFixed(2)}% → ${(fallback(after) * 100).toExponential(1)}%`);

// ------------------------------------------------- bench overrides (PHASE 26)
//
// The bench asks for a category, or for the ground. Everything here must leave
// the FIELD draw exactly as it was — that is the whole point of checking it.

// ------------------------------------------------------- the keyboard ceiling
//
// B4. Bible §20 hands you a machine already in flight and 3 % of the time that
// means HOLY_SHIT: 25-40 m/s, up to 80 degrees of bank, a metre and a half off
// the deck. With a proportional stick in your hands that is the intended shock.
// With four arrow keys — which is what most people arriving on launch day have
// — it is a crash you were never given the means to avoid.
//
// So main.js caps the DRAW for a keyboard-only pilot, and passes nothing at all
// when a pad is present. Nothing about the gamepad experience changes.

console.log('\nentry-state: the keyboard ceiling on the draw');

{
	check('the categories are ordered gentlest first', CATEGORIES[0] === 'COMFORTABLE'
		&& CATEGORIES[CATEGORIES.length - 1] === 'HOLY_SHIT');
	// The ceiling main.js actually uses. ACTIVE and not COMFORTABLE: angle mode
	// plus a ramped stick makes 18 m/s at 25 degrees a flight, not a fall, and
	// a keyboard pilot should still meet the variety the game is about.
	const capped = CATEGORIES.map((c) => capCategory(c, 'ACTIVE'));
	check('nothing above ACTIVE survives the cap', capped.every((c) => CATEGORIES.indexOf(c) <= CATEGORIES.indexOf('ACTIVE')),
		capped.join(' '));
	check('and what was already gentle is left alone', capCategory('COMFORTABLE', 'ACTIVE') === 'COMFORTABLE');
	check('the cap is what it says: ACTIVE tops out at 18 m/s, not 40', RANGES.ACTIVE.speedMs[1] === 18
		&& RANGES.HOLY_SHIT.speedMs[1] === 40);
	check('and at 25 degrees of bank, not 80', RANGES.ACTIVE.tiltDeg[1] === 25 && RANGES.HOLY_SHIT.tiltDeg[1] === 80);
}

{
	// No ceiling (a gamepad) leaves the draw exactly as it was, weight for
	// weight — this is the property the whole change hangs on.
	for (const junk of [null, undefined, '', 'COMFY', 0, {}]) {
		check(`no ceiling (${JSON.stringify(junk)}) changes nothing`,
			CATEGORIES.every((c) => capCategory(c, junk) === c));
	}
	check('an unknown category is passed through rather than clamped to nonsense',
		capCategory('IDLE', 'ACTIVE') === 'IDLE');
}

{
	// The cap must not disturb the random stream: a capped run and an uncapped
	// run consume the same draws for the same seed, so the sampling that
	// follows is identical. That is what keeps FIELD-on-a-gamepad bit for bit
	// what it always was.
	const a = rngFrom('cap-seed');
	const b = rngFrom('cap-seed');
	const raw = Array.from({ length: 200 }, () => resolveCategory(null, a));
	const capped = Array.from({ length: 200 }, () => capCategory(resolveCategory(null, b), 'ACTIVE'));
	check('the capped stream is the same draw, only ceilinged',
		raw.every((c, i) => capped[i] === capCategory(c, 'ACTIVE')));
	check('and the cap actually bit on that stream',
		raw.some((c) => CATEGORIES.indexOf(c) > CATEGORIES.indexOf('ACTIVE')));
}

{
	// generateEntryState wiring, on a stub Physics that accepts every candidate:
	// the two safety nets are already checked against a real scene in
	// tools/selftest.mjs, so here they are simply told to pass and what is under
	// test is WHICH CATEGORY comes out.
	const manifest = manifestOf(BBOX);
	const accepting = () => ({
		groundBelow: () => 0,
		obstructionBetween: () => ({ blocked: false, span: 0 }),
		applyEntryState() {},
		world: { timestep: 1 / 250 },
		rotation: { x: 0, y: 0, z: 0, w: 1 },
		angularVelocity: { x: 0, y: 0, z: 0 },
		position: { x: 0, y: 20, z: 0 },
		velocity: { x: 0, y: 0, z: 0 },
		// rolloutSafe builds a real FlightController from this and steps it; an
		// impact of 0 is "nothing was hit", which is what a stub scene is.
		profile: PROFILES.freestyle5,
		step: () => 0,
	});
	// 200 draws is enough that HOLY_SHIT (3 %) would appear several times.
	const seeds = Array.from({ length: 200 }, (_, i) => `cap-wire-${i}`);
	const uncapped = seeds.map((seed) => generateEntryState({ physics: accepting(), manifest, seed }).category);
	const capped = seeds.map((seed) => generateEntryState({ physics: accepting(), manifest, seed, maxCategory: 'ACTIVE' }).category);
	check('without a ceiling the hairy categories still come up',
		uncapped.some((c) => CATEGORIES.indexOf(c) > CATEGORIES.indexOf('ACTIVE')),
		uncapped.filter((c) => CATEGORIES.indexOf(c) > CATEGORIES.indexOf('ACTIVE')).length + ' of 200');
	check('with the ceiling, none of them do',
		capped.every((c) => CATEGORIES.indexOf(c) <= CATEGORIES.indexOf('ACTIVE')));
	check('and the gentle draws are the SAME draws, seed for seed',
		uncapped.every((c, i) => capped[i] === capCategory(c, 'ACTIVE')));
	// A forced category is a REQUEST, not a draw: asking for HOLY_SHIT at the
	// bench is the whole reason that control exists, and a ceiling must not
	// quietly overrule it.
	const forced = generateEntryState({ physics: accepting(), manifest, seed: 'f', category: 'HOLY_SHIT', maxCategory: 'COMFORTABLE' });
	check('a forced category is never capped', forced.category === 'HOLY_SHIT', forced.category);
	const idle = generateEntryState({ physics: accepting(), manifest, seed: 'x', idle: true, maxCategory: 'COMFORTABLE' });
	check('IDLE is still IDLE with a ceiling set', idle.category === 'IDLE');
}

console.log('\nentry-state: bench overrides');

{
	// Forcing does what it says, for every category.
	for (const cat of CATEGORIES) {
		check(`forcing ${cat} returns ${cat}`, resolveCategory(cat, rngFrom('x')) === cat);
	}
	// And anything that isn't a category falls back to the draw rather than
	// throwing or returning undefined — a bad value must not stop a flight.
	for (const junk of [null, undefined, '', 'IDLE', 'COMFY', 0, 42, {}, []]) {
		const got = resolveCategory(junk, rngFrom('x'));
		check(`a non-category (${JSON.stringify(junk)}) falls back to the draw`, CATEGORIES.includes(got));
	}
}

{
	// The FIELD path is untouched, seed for seed: no forced category means the
	// exact same sequence as before this parameter existed.
	const a = rngFrom('field-seed');
	const b = rngFrom('field-seed');
	const seqA = Array.from({ length: 50 }, () => pickCategory(a));
	const seqB = Array.from({ length: 50 }, () => resolveCategory(null, b));
	check('no override reproduces the weighted draw exactly', seqA.every((v, i) => v === seqB[i]));
}

{
	// IDLE ON GROUND: manifest.spawn, at rest, no draw at all. Checked with a
	// stub physics because that branch touches nothing else — which is itself
	// the property worth pinning down.
	const manifest = manifestOf(BBOX);
	let applied = null;
	let sampled = 0;
	const physics = {
		applyEntryState: (c) => { applied = c; },
		groundBelow: () => { sampled++; return 0; },
	};
	const got = generateEntryState({ physics, manifest, seed: 'ignored', idle: true });

	check('idle spawns at manifest.spawn', got.position.x === manifest.spawn.x
		&& got.position.y === manifest.spawn.y && got.position.z === manifest.spawn.z);
	check('idle spawns at rest', got.linvel.x === 0 && got.linvel.y === 0 && got.linvel.z === 0
		&& got.angvel.x === 0 && got.angvel.y === 0 && got.angvel.z === 0);
	check('idle spawns level', got.quaternion.w === 1
		&& got.quaternion.x === 0 && got.quaternion.y === 0 && got.quaternion.z === 0);
	check('idle is named IDLE, not COMFORTABLE', got.category === 'IDLE');
	check('idle draws nothing at all', sampled === 0);
	check('idle still pushes the state into physics', applied === got);
	// The fallback keeps its own name: it is what FIELD lands on after twenty
	// failed draws, and that is a COMFORTABLE entry, not an operator's choice.
	check('the shared fallback is still COMFORTABLE for FIELD',
		fallbackCandidate(manifest).category === 'COMFORTABLE');
	// And it hands out a copy, not the manifest's own spawn object.
	check('the fallback copies the spawn rather than aliasing it',
		fallbackCandidate(manifest).position !== manifest.spawn);
}

// --- issue #149: the FALLBACK is no longer born inside the fence -------------

console.log('\nentry-state: the fallback point against the fence (#149)');

// A point's fence zone, as the OSD would read it on the first step.
const zoneAt = (bbox, p) => new Geofence(bbox).update(p).zone;

{
	// A map whose spawn sits RIGHT on the edge: the shape of the flaw measured
	// on parcdesprinces, bastille and triomphe, where manifest.spawn fell in
	// HOLD or CAUTION while a successful draw was already constrained.
	const bbox = { min: [-140, 0, -150], max: [140, 60, 150] };
	const manifest = { bbox, spawn: { x: 128, y: 10, z: 0 } };
	check('control: that spawn really is INSIDE the fence',
		zoneAt(bbox, manifest.spawn) !== 'NOMINAL', zoneAt(bbox, manifest.spawn));

	const at = fallbackCandidate(manifest).position;
	check('the fallback is brought back into the NOMINAL zone', zoneAt(bbox, at) === 'NOMINAL', zoneAt(bbox, at));

	const r = insetRect(manifest);
	check('the fallback is STRICTLY inside the inset, not sitting on its edge',
		at.x > r.x0 && at.x < r.x1 && at.z > r.z0 && at.z < r.z1);

	check('manifest.spawn itself has not moved (it is the ground station)',
		manifest.spawn.x === 128 && manifest.spawn.z === 0);
}

{
	// A spawn already in the middle must not be moved for nothing: otherwise the
	// 22 maps that were fine would change entry point.
	const bbox = { min: [-140, 0, -150], max: [140, 60, 150] };
	const manifest = { bbox, spawn: { x: 3, y: 12, z: -4 } };
	const at = fallbackCandidate(manifest).position;
	check('a spawn already NOMINAL is left exactly where it is',
		at.x === 3 && at.y === 12 && at.z === -4);
}

{
	// Moved horizontally, the point must be PUT BACK DOWN on the ground that is
	// there: keeping the old y would put it inside a building or under the
	// terrain.
	const bbox = { min: [-140, 0, -150], max: [140, 60, 150] };
	const manifest = { bbox, spawn: { x: 135, y: 10, z: 0 } };
	const physics = { groundBelow: () => 25 };   // a roof 25 m below the target point
	const at = fallbackCandidate(manifest, physics).position;
	check('the moved fallback is put back above the real ground', at.y > 25, `y=${at.y}`);
	check('and it keeps a usable ground clearance', at.y - 25 >= 2, `agl=${at.y - 25}`);
}

{
	// A degenerate bbox (the bench: no map) must produce neither a reversed
	// inset nor a NaN.
	const bbox = { min: [0, 0, 0], max: [0, 0, 0] };
	const manifest = { bbox, spawn: { x: 0, y: 1, z: 0 } };
	const r = insetRect(manifest);
	check('degenerate bbox: the inset does not cross over', r.x0 <= r.x1 && r.z0 <= r.z1);
	const at = fallbackCandidate(manifest).position;
	check('degenerate bbox: the fallback stays a finite point',
		Number.isFinite(at.x) && Number.isFinite(at.y) && Number.isFinite(at.z));
}

{
	// And on the manifests ACTUALLY installed: that is the issue's measurement.
	// What follows depends on no particular scene — it checks what is there.
	// SCENES_DIR, not a second spelling of `public/scenes`: on a machine where
	// FPVTP_DATA_DIR points the scenes elsewhere, re-deriving the path here
	// means measuring a directory the game does not read.
	const scenesDir = SCENES_DIR;
	const slugs = fs.existsSync(scenesDir)
		? fs.readdirSync(scenesDir).filter((d) => fs.existsSync(path.join(scenesDir, d, 'manifest.json')))
		: [];
	if (!slugs.length) {
		console.log('  SKIP  no scene installed: nothing to measure here');
	} else {
		const bad = [];
		for (const slug of slugs) {
			const m = JSON.parse(fs.readFileSync(path.join(scenesDir, slug, 'manifest.json'), 'utf8'));
			if (!m.bbox || !m.spawn) continue;
			const z = zoneAt(m.bbox, fallbackCandidate(m).position);
			if (z !== 'NOMINAL') bad.push(`${slug}:${z}`);
		}
		check(`all ${slugs.length} installed scene(s) fall back into NOMINAL`,
			bad.length === 0, bad.join(', '));
	}
}

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);

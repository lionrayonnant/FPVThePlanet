// Checks for src/entry-state.js that need no scene/physics — the category
// draw only. The scene-dependent parts (sampleCandidate, geometrySafe,
// rolloutSafe, generateEntryState) are checked in tools/selftest.mjs, which
// already loads a real Physics instance for a real scene.
//
//   node tools/entry-state-selftest.mjs

import {
	CATEGORIES, WEIGHTS, rngFrom, pickCategory, occupancyOf, sampleCandidate,
	resolveCategory, fallbackCandidate, generateEntryState,
} from '../src/entry-state.js';

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

// Cells are ~25 m, the width of a Flyover tile at zoom 20 — fine enough to
// follow a corridor, coarse enough that the sweep stays a few thousand rays.
check('cell size is about a Flyover tile', corridor.cellSize > 15 && corridor.cellSize <= 30,
	`${corridor.cellSize.toFixed(1)} m`);

// The sweep is the expensive part, so it must happen once per physics world.
check('occupancy is cached per physics instance', occupancyOf(corridorPhysics, manifestOf(BBOX)) === corridor);

// A scene with no ground at all must not wedge the draw: it degrades to the
// whole bbox rather than to an empty cell list.
const voidGrid = occupancyOf({ groundBelow: () => null }, manifestOf(BBOX));
check('a scene with no ground falls back to the whole bbox', voidGrid.cells.length > 0);

console.log('\nentry-state: the draw lands on ground');

// Ce qui compte n'est pas qu'un tirage isolé réussisse toujours — c'est que
// generateEntryState(), qui retente 20 fois avant de se rabattre sur un spawn
// au repos, n'ait pratiquement jamais à se rabattre. On mesure donc le tirage
// CONTRE UN TÉMOIN : l'ancien comportement, uniforme dans la bbox.
const missRate = (phys, draw) => {
	const rand = rngFrom('draw-check');
	let miss = 0;
	for (let i = 0; i < 400; i++) if (!draw(CATEGORIES[i % CATEGORIES.length], phys, rand)) miss++;
	return miss / 400;
};
const withGrid = (cat, phys, rand) => sampleCandidate(cat, manifestOf(BBOX), phys, rand);
// Témoin : exactement ce que faisait sampleCandidate avant, un point au hasard
// dans l'emprise.
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

// Et la conséquence qui motivait tout : le repli de generateEntryState() tient
// 20 tentatives, donc un taux d'échec p donne p^20 de sessions démarrant à
// l'arrêt au lieu d'arriver en vol.
const fallback = (p) => p ** 20;
check('corridor: fallback to a resting spawn becomes negligible',
	fallback(after) < 1e-6 && fallback(before) > 1e-3,
	`${(fallback(before) * 100).toFixed(2)}% → ${(fallback(after) * 100).toExponential(1)}%`);

// ------------------------------------------------- bench overrides (PHASE 26)
//
// The bench asks for a category, or for the ground. Everything here must leave
// the FIELD draw exactly as it was — that is the whole point of checking it.

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

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);

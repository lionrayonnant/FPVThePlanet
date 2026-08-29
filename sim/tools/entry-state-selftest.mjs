// Checks for src/entry-state.js that need no scene/physics — the category
// draw only. The scene-dependent parts (sampleCandidate, geometrySafe,
// rolloutSafe, generateEntryState) are checked in tools/selftest.mjs, which
// already loads a real Physics instance for a real scene.
//
//   node tools/entry-state-selftest.mjs

import { CATEGORIES, WEIGHTS, rngFrom, pickCategory, occupancyOf, sampleCandidate } from '../src/entry-state.js';

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

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);

// Checks for src/entry-state.js that need no scene/physics — the category
// draw only. The scene-dependent parts (sampleCandidate, geometrySafe,
// rolloutSafe, generateEntryState) are checked in tools/selftest.mjs, which
// already loads a real Physics instance for a real scene.
//
//   node tools/entry-state-selftest.mjs

import { CATEGORIES, WEIGHTS, rngFrom, pickCategory } from '../src/entry-state.js';

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

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);

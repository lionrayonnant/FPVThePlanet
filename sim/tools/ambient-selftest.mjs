// node tools/ambient-selftest.mjs
//
// Le modèle PUR des drones ambiants (issue #250) : ensemble, routines,
// courbes, bulle, ancres, validation à rayons stubs, attitude. Rien de Three,
// rien de Rapier — les rayons sont des fonctions injectées, comme dans
// tools/entry-state-selftest.mjs.

import {
	rngFrom, ambientSet, ROUTINES, lateralAccelMax, routineFor,
	MAX_DRONES, G, TURN_MARGIN,
} from '../src/ambient.js';
import { generateTargetScan, TARGET_FAMILIES } from './target-model.mjs';
import { targetBuild } from './target-build.mjs';

let failures = 0;
function check(label, ok, detail) {
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures++;
}

console.log('ambient: ensemble');
{
	const scan = { seed: 'set-a', count: 5, index: 2 };
	const set = ambientSet(scan);
	const full = generateTargetScan({ seed: 'set-a', count: 5 }).candidates;
	check('n = count - 1', set.length === 4, `${set.length}`);
	check('le pris est absent', set.every((d) => d.i !== 2));
	check('familles = celles des candidats non pris',
		set.every((d) => d.family === full[d.i]._family));
	check('buildSeed = seed::i', set.every((d) => d.buildSeed === `set-a::${d.i}`));
	check('mode = le vrai mode vidéo', set.every((d) => d.mode === full[d.i]._videoHint));
	check('même scan → même ensemble',
		JSON.stringify(ambientSet(scan)) === JSON.stringify(set));
	check('count 2 → 1 ambiant', ambientSet({ seed: 'z', count: 2, index: 0 }).length === 1);
	check('jamais plus de MAX_DRONES', ambientSet({ seed: 'z', count: 5, index: 0 }).length <= MAX_DRONES);
}

console.log('\nambient: routines');
{
	check('une routine par famille', TARGET_FAMILIES.every((f) => ROUTINES[f]));
	check('a_max(twr=2) = g·√3', Math.abs(lateralAccelMax(2) - G * Math.sqrt(3)) < 1e-9);
	check('a_max(twr≤1) = 0', lateralAccelMax(1) === 0 && lateralAccelMax(0.5) === 0);

	for (const family of TARGET_FAMILIES) {
		const build = targetBuild({ seed: `r::${family}`, family });
		const r = routineFor({ family, twr: build.spec.twr, rand: rngFrom(`rt::${family}`) });
		const spec = ROUTINES[family];
		check(`${family}: vitesse dans la plage`, r.speed >= spec.speed[0] - 1e-9 && r.speed <= spec.speed[1] + 1e-9, `${r.speed.toFixed(1)}`);
		check(`${family}: rayon dans la plage`, r.radius >= spec.radius[0] && r.radius <= spec.radius[1]);
		check(`${family}: AGL dans la plage`, r.agl >= spec.agl[0] && r.agl <= spec.agl[1]);
		check(`${family}: v²/r ≤ 0,6·a_max`, r.speed * r.speed / r.radius <= TURN_MARGIN * lateralAccelMax(build.spec.twr) + 1e-9,
			`${(r.speed * r.speed / r.radius).toFixed(1)} vs ${(TURN_MARGIN * lateralAccelMax(build.spec.twr)).toFixed(1)}`);
		check(`${family}: période > 0`, r.period > 0);
	}
	const a = routineFor({ family: 'race5', twr: 8, rand: rngFrom('same') });
	const b = routineFor({ family: 'race5', twr: 8, rand: rngFrom('same') });
	check('même graine → même routine', JSON.stringify(a) === JSON.stringify(b));
	check('le micro a du jitter', routineFor({ family: 'toothpick', twr: 3, rand: rngFrom('j') }).jitter.length === 3);
	check('le cinewhoop n\'en a pas', routineFor({ family: 'cinewhoop', twr: 2.8, rand: rngFrom('j') }).jitter.length === 0);
	// Un TWR faible ramène la vitesse : à twr 1,5 sur 15 m de rayon, v ≤ √(0,6·g·√1,25·15)
	const slow = routineFor({ family: 'race5', twr: 1.5, rand: rngFrom('slow') });
	check('TWR faible plafonne la vitesse', slow.speed * slow.speed / slow.radius <= TURN_MARGIN * lateralAccelMax(1.5) + 1e-9);
	const veryLowTWR = routineFor({ family: 'race5', twr: 1.01, rand: rngFrom('twr-1.01') });
	check('twr 1.01: invariant v²/r ≤ 0,6·a_max tient', veryLowTWR.speed * veryLowTWR.speed / veryLowTWR.radius <= TURN_MARGIN * lateralAccelMax(1.01) + 1e-9);
}

console.log(`\n${failures ? `${failures} FAIL` : 'all PASS'}`);
process.exit(failures ? 1 : 0);

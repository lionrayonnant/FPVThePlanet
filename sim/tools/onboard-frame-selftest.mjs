// node tools/onboard-frame-selftest.mjs — ce que les hélices occupent
// réellement dans le champ (issue #264). Rasterisation pure, aucun GPU.
import { propCoverage } from './prop-coverage.mjs';
import { shapeOf } from '../src/drone-shape.js';
import { targetBuild } from './target-build.mjs';
import { targetCamera } from './target-camera.mjs';
import { FAMILIES } from '../src/drone-profiles.js';

let failures = 0;
function check(label, ok, detail) {
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures++;
}
const at = (family, seed, over) => {
	const build = targetBuild({ seed, family });
	const camera = targetCamera({ seed, family });
	return propCoverage({ shape: shapeOf({ profile: build.profile, build, camera }), camera, ...over });
};

console.log('onboard-frame');

// 1. L'instrument lui-même, sur des cas dont la réponse est connue d'avance.
{
	const c0 = at('freestyle5', 'probe-freestyle5-0', { mountY: 0 });
	check('objectif exactement dans le plan d\'hélice : couverture nulle', c0.area === 0, `${(100 * c0.area).toFixed(2)} %`);

	const below = at('freestyle5', 'probe-freestyle5-0', { mountY: -0.008 });
	const above = at('freestyle5', 'probe-freestyle5-0', { mountY: +0.008 });
	check('sous le plan : les hélices montent plus haut qu\'au-dessus',
		below.top > above.top, `${(100 * below.top).toFixed(0)} % vs ${(100 * above.top).toFixed(0)} %`);
	check('les deux couvrent quelque chose', below.area > 0 && above.area > 0);

	// Monotonie : plus l'objectif s'éloigne du plan, plus il en voit.
	const far = at('freestyle5', 'probe-freestyle5-0', { mountY: +0.010 });
	check('couverture croissante avec l\'écart au plan', far.area > above.area,
		`${(100 * above.area).toFixed(1)} % → ${(100 * far.area).toFixed(1)} %`);
}

// 2. Déterminisme.
{
	const a = at('race5', 'det', {}), b = at('race5', 'det', {});
	check('même build → même mesure', a.area === b.area && a.top === b.top);
}

// 3. La borne DA, garantie par construction (spec §« La borne DA, chiffrée »).
//    Elle porte sur la recette TELLE QU'ELLE EST — aucun montage passé en
//    surcharge : ce qu'on mesure ici, c'est le bloc MOUNT que
//    tools/tune-mount.mjs a écrit dans src/drone-shape.js. Un mount qui dérive
//    casse en rouge.
//
//    La hauteur atteinte est bornée à 50 % au pire et à 45 % en MÉDIANE, et non
//    à 45 % partout comme l'écrivait la spec : le plan d'hélice a un horizon, à
//    (1 − tan(uptilt) / tan(champ/2)) / 2 de la hauteur du cadre, soit 50 %
//    pour une caméra plate. Les hélices vivent dans ce plan — aucune hauteur
//    d'objectif ne les fait passer sous cet horizon. Les 45 % étaient une mesure
//    faite sur une graine par famille, promue en règle sur tout le domaine ; sur
//    une caméra normale ils tiennent, et c'est la médiane qui l'affirme. La
//    borne qui protège vraiment l'image reste la couverture ≤ 8 %.
const MAX_AREA = 0.08;      // 8 % de l'image
const MAX_TOP = 0.50;       // au pire : l'horizon du plan d'hélice, rien de plus
const MAX_MEDIAN_TOP = 0.45;   // sur une caméra normale : le tiers bas
for (const family of FAMILIES) {
	let worstArea = 0, worstTop = 0, worstSeed = '';
	const tops = [];
	for (let i = 0; i < 300; i++) {
		const seed = `probe-${family}-${i}`;
		const c = at(family, seed, {});
		if (c.area > worstArea) { worstArea = c.area; worstSeed = seed; }
		if (c.top > worstTop) worstTop = c.top;
		tops.push(c.top);
	}
	tops.sort((a, b) => a - b);
	const median = tops[tops.length >> 1];
	check(`${family} : couverture \u2264 8 % de l'image`, worstArea <= MAX_AREA,
		`${(100 * worstArea).toFixed(1)} % au pire (${worstSeed})`);
	check(`${family} : rien au-dessus de 50 % de la hauteur`, worstTop <= MAX_TOP,
		`${(100 * worstTop).toFixed(0)} % au pire`);
	check(`${family} : hauteur m\u00e9diane \u2264 45 %`, median <= MAX_MEDIAN_TOP,
		`${(100 * median).toFixed(0)} % en m\u00e9diane`);
}

console.log(`\n${failures ? `${failures} FAIL` : 'all PASS'}`);
process.exit(failures ? 1 : 0);

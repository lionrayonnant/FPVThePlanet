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

// --- DÉBUT DU BLOC 3 — remplacé par les assertions de borne DA (tâche 3) -----
// 3. L'état des lieux, consigné : la recette d'aujourd'hui est HORS borne.
//    Ce bloc n'affirme rien, il documente le point de départ de la tâche 3.
for (const family of FAMILIES) {
	const c = at(family, `probe-${family}-0`, {});
	console.log(`  ..    ${family} aujourd'hui : ${(100 * c.area).toFixed(1)} % de l'image, jusqu'à ${(100 * c.top).toFixed(0)} % de la hauteur`);
}
// --- FIN DU BLOC 3 ----------------------------------------------------------

console.log(`\n${failures ? `${failures} FAIL` : 'all PASS'}`);
process.exit(failures ? 1 : 0);

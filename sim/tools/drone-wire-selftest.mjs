// node tools/drone-wire-selftest.mjs — le portrait fil de fer (issue #264).
// Module PUR : aucun Three, aucun DOM, donc le portrait de l'archive se
// vérifie sans navigateur.
//
// Ce selftest ne connaît AUCUNE coordonnée : la recette bouge (le bloc MOUNT
// est mesuré, les familles se règlent), la projection non. On teste donc des
// PROPRIÉTÉS — combien de segments par primitive, les bornes de la boîte, le
// déterminisme, l'invariance d'échelle, le fait que la vue tourne — jamais un
// nombre lu dans drone-shape.js.
import { wireOf, CIRCLE_STEPS } from '../src/drone-wire.js';
import { shapeOf } from '../src/drone-shape.js';
import { targetBuild } from './target-build.mjs';
import { targetCamera } from './target-camera.mjs';
import { FAMILIES } from '../src/drone-profiles.js';

let failures = 0;
function check(label, ok, detail) {
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures++;
}
const portrait = (family, seed = `wire::${family}`) => {
	const build = targetBuild({ seed, family });
	return shapeOf({ profile: build.profile, build, camera: targetCamera({ seed, family }), detail: 'portrait' });
};
const VIEW = { yawDeg: 35, pitchDeg: 20 };

console.log('drone-wire');

for (const family of FAMILIES) {
	const w = wireOf(portrait(family), VIEW);
	const n = w.segments.length / 4;
	check(`${family}: des segments, et pas trop`, n > 60 && n < 4000, `${n}`);
	check(`${family}: tout tient dans la boîte`, Array.from(w.segments).every((v) => v >= -1 && v <= 1));
	check(`${family}: une profondeur par segment`, w.depth.length === n);
	check(`${family}: profondeurs normalisées`, Array.from(w.depth).every((v) => v >= 0 && v <= 1));
	check(`${family}: le portrait n'est pas dégénéré`,
		Math.max(...w.segments) - Math.min(...w.segments) > 0.5);
}

check('même graine → mêmes segments',
	JSON.stringify(Array.from(wireOf(portrait('race5', 'same'), VIEW).segments))
	=== JSON.stringify(Array.from(wireOf(portrait('race5', 'same'), VIEW).segments)));

// Les six familles doivent se DISTINGUER : c'est tout l'intérêt d'une
// collection. Deux portraits identiques voudraient dire que la recette ne
// varie pas assez pour qu'on reconnaisse une machine.
{
	const sigs = FAMILIES.map((f) => wireOf(portrait(f), VIEW).segments.length);
	const pairs = [];
	for (let i = 0; i < FAMILIES.length; i++) {
		for (let j = i + 1; j < FAMILIES.length; j++) {
			const a = wireOf(portrait(FAMILIES[i]), VIEW).segments;
			const b = wireOf(portrait(FAMILIES[j]), VIEW).segments;
			const same = a.length === b.length && a.every((v, k) => Math.abs(v - b[k]) < 1e-6);
			if (same) pairs.push(`${FAMILIES[i]}/${FAMILIES[j]}`);
		}
	}
	check('les six familles se distinguent deux à deux', pairs.length === 0, pairs.join(' '));
	check('les comptes de segments varient', new Set(sigs).size > 1);
}

// Deux vues différentes donnent deux projections différentes.
check('la vue tourne vraiment',
	wireOf(portrait('freestyle5'), { yawDeg: 0, pitchDeg: 20 }).segments[0]
	!== wireOf(portrait('freestyle5'), { yawDeg: 90, pitchDeg: 20 }).segments[0]);

// Une recette absente ne casse pas : l'archive affiche simplement rien.
{
	const w = wireOf(null, VIEW);
	check('recette absente : zéro segment, pas d\'exception', w.segments.length === 0);
	check('recette vide : zéro segment', wireOf({ parts: [] }, VIEW).segments.length === 0);
}

// ————— Les propriétés de la dérivation d'arêtes —————
// Le contrat annoncé par le plan et par la spec : une boîte donne 12 arêtes,
// un cylindre (et un conduit) deux cercles plus ses génératrices, un disque un
// cercle, un point rien. C'est ce qui remplace la liste d'arêtes qu'on n'écrit
// pas dans la recette — donc c'est ce qu'il faut tenir.
{
	const perKind = { box: 12, cylinder: 2 * CIRCLE_STEPS + CIRCLE_STEPS / 4, disc: CIRCLE_STEPS, point: 0 };
	perKind.ring = perKind.cylinder;
	let ok = true, detail = '';
	for (const family of FAMILIES) {
		const shape = portrait(family);
		const want = shape.parts.reduce((n, p) => n + (perKind[p.kind] ?? 0), 0);
		const got = wireOf(shape, VIEW).segments.length / 4;
		if (got !== want) { ok = false; detail += ` ${family}:${got}≠${want}`; }
	}
	check('chaque primitive rend exactement ses arêtes', ok, detail.trim());
	check('la LED ne se dessine pas',
		wireOf({ parts: [{ kind: 'point', role: 'led', at: [0, 0, 0], size: [0.004] }], boundingRadius: 1 }, VIEW)
			.segments.length === 0);
	check('une primitive inconnue est ignorée, pas fatale',
		wireOf({ parts: [{ kind: 'torus', role: 'x', at: [0, 0, 0], size: [1] }], boundingRadius: 1 }, VIEW)
			.segments.length === 0);
}

// L'échelle : la normalisation se fait sur boundingRadius, donc deux machines
// homothétiques donnent LE MÊME portrait. C'est ce qui fait qu'un toothpick
// n'a pas la taille d'un heavy5 dans le cadre : c'est le rapport à son propre
// rayon qui compte, pas un recadrage sur l'étendue mesurée.
{
	const cube = (s) => ({ parts: [{ kind: 'box', role: 'plate', at: [s, 0, -s], size: [s, s, s] }], boundingRadius: 4 * s });
	const a = wireOf(cube(1), VIEW).segments;
	const b = wireOf(cube(0.25), VIEW).segments;
	check('la normalisation garde les proportions',
		a.length === b.length && Array.from(a).every((v, i) => Math.abs(v - b[i]) < 1e-6));
}

// La profondeur : normalisée sur l'étendue vue. Elle ne touche pas exactement
// 0 et 1 — c'est la MOYENNE des deux bouts d'un segment, et l'arête la plus
// avancée a toujours un peu d'épaisseur — mais elle doit balayer presque tout
// l'intervalle, sinon l'atténuation ne se verrait pas.
{
	const d = Array.from(wireOf(portrait('freestyle5'), VIEW).depth);
	check('la profondeur balaie tout l\'intervalle',
		Math.min(...d) < 0.05 && Math.max(...d) > 0.95,
		`${Math.min(...d).toFixed(3)}..${Math.max(...d).toFixed(3)}`);
	// Une barre alignée sur l'axe de vue (lacet 0, tangage 0 → l'axe est +Z,
	// et le nez du corps est en −Z, donc devant). Ses douze arêtes se rangent
	// en trois groupes : la face avant à 0, la face arrière à 1, les quatre
	// longerons à mi-chemin. C'est le sens de `depth` : 0 = le plus près.
	const bar = { parts: [{ kind: 'box', role: 'plate', at: [0, 0, 0], size: [0.01, 0.01, 1] }], boundingRadius: 1 };
	const d2 = Array.from(wireOf(bar, { yawDeg: 0, pitchDeg: 0 }).depth);
	const near = d2.filter((v) => v < 1e-6).length;
	const far = d2.filter((v) => v > 1 - 1e-6).length;
	const mid = d2.filter((v) => Math.abs(v - 0.5) < 1e-6).length;
	check('l\'avant est à 0, l\'arrière à 1, les longerons au milieu',
		near === 4 && far === 4 && mid === 4, `${near}/${mid}/${far}`);
}

// Tout est fini : un NaN passerait les bornes sans qu'on le voie et sortirait
// dans le SVG en `d="M NaN"` — un portrait vide sans message d'erreur.
{
	const w = wireOf(portrait('cinewhoop'), VIEW);
	check('aucune coordonnée NaN',
		Array.from(w.segments).every(Number.isFinite) && Array.from(w.depth).every(Number.isFinite));
	check('vue par défaut : le portrait sort quand même', wireOf(portrait('cinewhoop')).segments.length > 0);
}

console.log(`\n${failures ? `${failures} FAIL` : 'all PASS'}`);
process.exit(failures ? 1 : 0);

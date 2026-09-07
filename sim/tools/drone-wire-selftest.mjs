// node tools/drone-wire-selftest.mjs — le portrait fil de fer (issue #264).
// Module PUR : aucun Three, aucun DOM, donc le portrait de l'archive se
// vérifie sans navigateur.
//
// Ce selftest ne connaît AUCUNE coordonnée : la recette bouge (le bloc MOUNT
// est mesuré, les familles se règlent), la projection non. On teste donc des
// PROPRIÉTÉS — combien de segments par primitive, les bornes de la boîte, le
// déterminisme, l'invariance d'échelle, le fait que la vue tourne — jamais un
// nombre lu dans drone-shape.js.
import { wireOf, CIRCLE_STEPS, circleSteps } from '../src/drone-wire.js';
import { shapeOf, BLADE_STATIONS } from '../src/drone-shape.js';
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
// un cylindre (et un conduit) deux cercles plus ses génératrices — un petit
// cylindre a moitié moins de côtés mais toujours quatre génératrices (#283) —,
// un disque un cercle, une pale son
// contour (deux bords par station, plus l'emplanture et le bout), un point
// rien. C'est ce qui remplace la liste d'arêtes qu'on n'écrit pas dans la
// recette — donc c'est ce qu'il faut tenir.
{
	const perKind = (p, R) => {
		switch (p.kind) {
			case 'box': return 12;
			case 'cylinder': case 'ring': { const n = circleSteps(p.size[0], R); return 2 * n + 4; }
			case 'disc': return circleSteps(p.size[0], R);
			case 'blade': return 2 * BLADE_STATIONS + 2;
			default: return 0;
		}
	};
	check('un petit cercle a moins de côtés qu\'un grand', circleSteps(0.01, 1) < circleSteps(0.5, 1) && circleSteps(0.5, 1) === CIRCLE_STEPS);
	let ok = true, detail = '';
	for (const family of FAMILIES) {
		const shape = portrait(family);
		const want = shape.parts.reduce((n, p) => n + perKind(p, shape.boundingRadius), 0);
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

// --- attitude de la MACHINE (issue #281) -------------------------------------
//
// Jusqu'ici wireOf() ne savait qu'orbiter la caméra autour d'un objet immobile.
// L'assistant de calibrage a besoin de l'inverse : une caméra fixe et une
// machine qui s'incline, cabre et lace avec le manche que le pilote tient.
//
// Ces tests ne lisent aucune coordonnée : ils vérifient des propriétés — une
// attitude nulle ne change RIEN, une attitude non nulle change quelque chose,
// un roulis fait basculer la gauche et la droite en sens opposés, et rien ne
// sort des bornes ni ne devient NaN.
{
	const shape = portrait('freestyle5');
	const base = wireOf(shape, VIEW);

	// Le contrat qui protège le portrait d'archive : il n'a pas d'attitude, et il
	// doit continuer à rendre exactement ce qu'il rendait.
	const zero = wireOf(shape, { ...VIEW, roll: 0, pitch: 0, yaw: 0 });
	check('attitude nulle : sortie identique au portrait d\'archive',
		Array.from(zero.segments).every((v, i) => v === base.segments[i])
		&& Array.from(zero.depth).every((v, i) => v === base.depth[i]));

	const rolled = wireOf(shape, { ...VIEW, roll: 30 });
	check('un roulis change le dessin', Array.from(rolled.segments).some((v, i) => v !== base.segments[i]));
	check('un roulis garde le même nombre de segments', rolled.segments.length === base.segments.length);

	// Un roulis à droite doit DESCENDRE ce qui est à droite et MONTER ce qui est
	// à gauche. Mesuré sur une barre transversale, pour ne dépendre d'aucune
	// recette : vue de face, sans orbite, l'effet est sans ambiguïté.
	const barre = { parts: [{ kind: 'box', role: 'plate', at: [0, 0, 0], size: [2, 0.01, 0.01] }], boundingRadius: 1 };
	const flat = wireOf(barre, { yawDeg: 0, pitchDeg: 0 });
	const bank = wireOf(barre, { yawDeg: 0, pitchDeg: 0, roll: 25 });
	const hauteurA = (w, cote) => {
		let somme = 0, n = 0;
		for (let i = 0; i < w.segments.length; i += 4) {
			for (const k of [0, 2]) {
				const x = w.segments[i + k], y = w.segments[i + k + 1];
				if (Math.sign(x) === cote && Math.abs(x) > 0.5) { somme += y; n++; }
			}
		}
		return n ? somme / n : 0;
	};
	check('à plat, les deux bouts de la barre sont à la même hauteur',
		Math.abs(hauteurA(flat, 1) - hauteurA(flat, -1)) < 1e-6);
	check('roulis à droite : le bout droit descend, le gauche monte',
		hauteurA(bank, 1) < -1e-3 && hauteurA(bank, -1) > 1e-3,
		`droite ${hauteurA(bank, 1).toFixed(3)} / gauche ${hauteurA(bank, -1).toFixed(3)}`);

	// Un cabré doit lever le nez. Le nez est en -Z (drone-mesh.js monte la caméra
	// vers l'avant), vu de dessus sans orbite ni tangage de caméra.
	const fleche = { parts: [{ kind: 'box', role: 'plate', at: [0, 0, -0.9], size: [0.01, 0.01, 0.2] }], boundingRadius: 1 };
	const nez = (w) => { let m = 0, n = 0; for (let i = 0; i < w.segments.length; i += 4) { m += w.segments[i + 1] + w.segments[i + 3]; n += 2; } return m / n; };
	check('cabrer lève le nez', nez(wireOf(fleche, { yawDeg: 0, pitchDeg: 0, pitch: 25 })) > nez(wireOf(fleche, { yawDeg: 0, pitchDeg: 0 })));

	const tout = wireOf(shape, { ...VIEW, roll: 20, pitch: -15, yaw: 40 });
	check('attitude complète : rien ne sort des bornes',
		Array.from(tout.segments).every((v) => v >= -1 && v <= 1));
	check('attitude complète : aucune coordonnée NaN',
		Array.from(tout.segments).every(Number.isFinite) && Array.from(tout.depth).every(Number.isFinite));
}

console.log(`\n${failures ? `${failures} FAIL` : 'all PASS'}`);
process.exit(failures ? 1 : 0);

// node tools/tune-mount.mjs [--write] [--verbose] [famille|all]
//
// Mesure et ÉCRIT le bloc MOUNT de src/drone-shape.js — la hauteur de
// l'objectif au-dessus du plan d'hélice, par famille.
//
// Même contrat que tools/tune-pid.mjs : ce bloc n'est JAMAIS modifié à la
// main. La raison est mesurée, pas esthétique — voir la spec :
//   · objectif SOUS le plan d'hélice : le disque passe au-dessus de l'oeil et
//     couvre 10 à 29 % de l'image, jusqu'aux trois quarts de la hauteur ;
//   · objectif exactement DANS le plan : couverture nulle, le disque est par
//     la tranche (singularité de la primitive, pas du réglage) ;
//   · objectif AU-DESSUS : les hélices redescendent dans le bas du cadre.
// Un chiffre unique fixé à la main serait faux pour au moins une famille : à
// dy = +3 mm, cinq familles tiennent les 8 % de couverture et le toothpick est
// à 14,3 %.
//
// ─── La règle de recherche ──────────────────────────────────────────────────
//
// 1. l'AVANCÉE est FIGÉE à −0,55·armZ, l'avancée de la recette d'origine,
//    c'est-à-dire le bord avant de la plaque : l'objectif ne sort jamais du
//    châssis. Un objectif en porte-à-faux devant les hélices tiendrait mieux la
//    borne de hauteur, mais ce ne serait plus une machine crédible en free cam
//    ni au portrait. Le champ `z` reste nommé et écrit ici — il n'est
//    simplement plus cherché ;
// 2. la HAUTEUR est la PLUS GRANDE qui tienne la couverture ≤ 8 % de l'image,
//    sur toute l'enveloppe de caméra que targetCamera() peut tirer pour la
//    famille. « La plus grande » parce que monter fait DESCENDRE les hélices
//    dans le cadre : on prend donc tout ce que la borne d'aire autorise, et on
//    en voit le plus possible. Une vue embarquée où l'on ne voit rien ne dit
//    rien.
//
// ─── Pourquoi la borne de hauteur du selftest est à 50 % et non à 45 % ──────
//
// Le plan d'hélice a un HORIZON, et cet horizon est à
//
//   (1 − tan(uptilt) / tan(champ/2)) / 2   de la hauteur du cadre,
//
// soit 50 % pour une caméra plate. Les hélices vivent dans ce plan : aucune
// hauteur d'objectif ne les fait passer sous cet horizon, elle ne fait que les
// en écarter. Les 45 % de la spec étaient une mesure juste — mais faite sur UNE
// graine par famille, puis promue en règle sur tout le domaine : sur toute
// l'étendue d'uptilt, le pire tirage est la caméra plate à champ large, et il
// monte à 45-48 %. Le selftest garde donc les 45 % sur la MÉDIANE (le tiers bas
// sur une caméra normale, ce que la DA voulait dire) et borne le pire cas à
// 50 %. La borne qui protège vraiment l'image reste la couverture ≤ 8 %.
import { readFileSync, writeFileSync } from 'node:fs';
import { propCoverage } from './prop-coverage.mjs';
import { shapeOf } from '../src/drone-shape.js';
import { targetBuild } from './target-build.mjs';
import { targetCamera, CAMERA_FAMILIES } from './target-camera.mjs';
import { FAMILIES, PROFILES } from '../src/drone-profiles.js';

// La borne d'aire elle-même. Ce nombre est celui du selftest
// (tools/onboard-frame-selftest.mjs) : il ne se règle pas ici.
const MAX_AREA = 0.08;

// Pas et plafond de la recherche, en mètres. 0,2 mm est aussi la résolution à
// laquelle le bloc est écrit (4 décimales), pour que ce qui est mesuré soit
// exactement ce qui est écrit.
const Y_STEP = 0.0002;
const Y_COARSE = 0.001;
const Y_MAX = 0.030;

// Deux résolutions : la grossière encadre, la fine tranche.
const SCAN = { n: 4, grid: 120 };
const FINE = { n: 15, grid: 200 };
const SEEDS = 300;

const q4 = (v) => Math.round(v * 1e4) / 1e4;

// L'enveloppe de caméra, balayée et non tirée. targetCamera() ne fait varier
// que trois choses qui comptent pour la sonde — l'uptilt, le champ et le
// format — et la borne doit tenir sur TOUTE leur étendue, pas sur celles qu'un
// tirage a bien voulu sortir.
function envelope(family, n) {
	const t = CAMERA_FAMILIES[family] ?? CAMERA_FAMILIES.freestyle5;
	const out = [];
	const step = (r, i) => (n === 1 ? r[0] : r[0] + (r[1] - r[0]) * i / (n - 1));
	for (const name of new Set(t.aspects)) {
		for (let i = 0; i < n; i++) {
			for (let j = 0; j < n; j++) {
				out.push({ uptiltDeg: step(t.uptiltDeg, i), fovDeg: step(t.fovDeg, j), aspect: name === '4:3' ? 4 / 3 : 16 / 9 });
			}
		}
	}
	return out;
}

// Les caméras des 300 graines du selftest. L'enveloppe les couvre déjà pour le
// pire cas, mais ce sont elles qui portent la MÉDIANE : elles sont tirées comme
// le client les tire, l'enveloppe est un quadrillage uniforme.
function seedCameras(family) {
	const out = [];
	for (let i = 0; i < SEEDS; i++) out.push(targetCamera({ seed: `probe-${family}-${i}`, family }));
	return out;
}

// UN exemplaire suffit à porter la géométrie : propRadius, bladeCount, armX et
// armZ sont des INVARIANTS de famille (tools/target-build.mjs), et la sonde ne
// lit rien d'autre de la recette que les disques et l'oeil — lequel est passé
// en surcharge. Un tirage de build ne peut donc pas déplacer la mesure.
function shapeFor(family) {
	const seed = `mount::${family}`;
	const build = targetBuild({ seed, family });
	return shapeOf({ profile: build.profile, build, camera: targetCamera({ seed, family }) });
}

// Le pire cas sur un jeu de caméras.
function worst(shape, cams, y, z, grid) {
	let area = 0, top = 0, cam = null;
	for (const camera of cams) {
		const c = propCoverage({ shape, camera, mountY: y, mountZ: z, grid });
		if (c.area > area) { area = c.area; cam = camera; }
		if (c.top > top) top = c.top;
	}
	return { area, top, cam };
}

// La hauteur atteinte sur une caméra NORMALE : la médiane des 300 tirages.
function medianTop(shape, cams, y, z, grid) {
	const tops = cams.map((camera) => propCoverage({ shape, camera, mountY: y, mountZ: z, grid }).top).sort((a, b) => a - b);
	return tops[tops.length >> 1];
}

function search(family, verbose) {
	const shape = shapeFor(family);
	const scan = envelope(family, SCAN.n);
	const seeds = seedCameras(family);
	const fine = [...envelope(family, FINE.n), ...seeds];
	// L'avancée n'est pas cherchée : c'est le bord avant de la plaque.
	const z = q4(-0.55 * PROFILES[family].armZ);
	const trail = [];

	// 1. Encadrement au millimètre sur l'enveloppe grossière.
	let bracket = 0;
	for (let y = Y_COARSE; y <= Y_MAX + 1e-12; y += Y_COARSE) {
		const m = worst(shape, scan, q4(y), z, SCAN.grid);
		if (verbose) trail.push(`  y = ${(1000 * y).toFixed(1)} mm  →  ${(100 * m.area).toFixed(1)} % / ${(100 * m.top).toFixed(0)} %`);
		if (m.area > MAX_AREA) break;
		bracket = y;
	}

	// 2. Pas fin sur l'enveloppe fine ET sur les graines du selftest, depuis un
	//    millimètre sous l'encadrement : la sonde grossière sous-estime un peu
	//    la couverture, la fine peut donc casser plus tôt.
	let keep = null;
	const from = Math.max(Y_STEP, bracket - Y_COARSE + Y_STEP);
	for (let y = from; y <= bracket + Y_COARSE + 1e-12; y += Y_STEP) {
		const m = worst(shape, fine, q4(y), z, FINE.grid);
		if (m.area > MAX_AREA) break;
		keep = { y: q4(y), ...m };
	}
	if (!keep) return { family, y: null, z, trail };
	return { family, y: keep.y, z, area: keep.area, top: keep.top, cam: keep.cam, median: medianTop(shape, seeds, keep.y, z, FINE.grid), trail };
}

const argv = process.argv.slice(2);
const write = argv.includes('--write');
const verbose = argv.includes('--verbose');
const only = argv.find((a) => !a.startsWith('--'));
const families = !only || only === 'all' ? FAMILIES : [only];

const found = {};
let missing = 0;
console.log('famille        y      aire pire   hauteur méd   hauteur pire');
for (const family of families) {
	const b = search(family, verbose);
	if (verbose) console.log(`${family} :\n${b.trail.join('\n')}`);
	if (b.y === null) {
		// C'est un résultat, pas une panne : la géométrie de cette famille dit
		// quelque chose que la borne ignore. Ne pas baisser la borne ici.
		missing++;
		console.log(`${family.padEnd(11)}    AUCUNE hauteur ne tient la couverture ≤ ${100 * MAX_AREA} %`);
		continue;
	}
	found[family] = b;
	console.log(`${family.padEnd(11)} ${(1000 * b.y).toFixed(1)} mm   ${(100 * b.area).toFixed(1)} %       ${(100 * b.median).toFixed(0)} %          ${(100 * b.top).toFixed(0)} %`);
	if (verbose && b.cam) console.log(`            pire caméra : uptilt ${b.cam.uptiltDeg.toFixed(1)}°, champ ${b.cam.fovDeg.toFixed(0)}°, format ${b.cam.aspect.toFixed(2)}`);
}

if (missing) {
	console.log(`\n${missing} famille(s) hors borne — ne rien écrire.`);
	process.exit(1);
}

if (write) {
	const path = new URL('../src/drone-shape.js', import.meta.url);
	const src = readFileSync(path, 'utf8');
	const body = FAMILIES.map((f) => {
		const b = found[f];
		if (!b) throw new Error(`${f} non mesurée : relancer avec "all" pour écrire`);
		return `\t${f}: { y: ${b.y.toFixed(4)}, z: ${b.z.toFixed(4)} },`;
	}).join('\n');
	// On teste la PRÉSENCE du bloc, pas le fait que le texte ait changé :
	// relancer l'outil sur un bloc déjà à jour est le cas normal, pas une panne.
	const block = /export const MOUNT = \{[\s\S]*?\n\};/;
	if (!block.test(src)) throw new Error('bloc MOUNT introuvable dans src/drone-shape.js');
	const next = src.replace(block, `export const MOUNT = {\n${body}\n};`);
	writeFileSync(path, next);
	console.log(next === src ? '\nMOUNT inchangé dans src/drone-shape.js' : '\nMOUNT écrit dans src/drone-shape.js');
}

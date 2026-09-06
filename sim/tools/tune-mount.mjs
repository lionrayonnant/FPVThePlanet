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
// Deux leviers, et chacun se mesure avec son propre instrument.
//
// 1. l'AVANCÉE est FIGÉE au bord avant de la plaque (−0,55·armZ) : l'objectif
//    ne sort jamais du châssis. Le champ `z` reste nommé et écrit ici, il n'est
//    pas cherché.
//
//    Ç'a été essayé, et mesuré, et écarté. Sur les familles carénées l'objectif
//    est posé dans le créneau entre les deux conduits avant et les regarde de
//    l'intérieur : le maillage embarqué occupe 33 % de l'image sur le cinewhoop
//    (38 % sur le toothpick), dont 19 à 25 points de conduit. Avancer l'objectif
//    jusqu'à la lèvre avant du carénage fait bien tomber ce chiffre à 10 % —
//    mais les HÉLICES disparaissent avec (couverture des disques 0,7 %,
//    médiane nulle). Or les hélices dans le champ sont le sujet de cette issue.
//    On ne casse pas la fonction pour tenir un nombre : le carénage reste dans
//    le cadre, et c'est la signature de ces familles ;
// 2. la HAUTEUR est la PLUS GRANDE qui tienne la couverture des DISQUES ≤ 8 %,
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
import { lensCoverage, trianglesOf } from './lens-coverage.mjs';
import { shapeOf, propPlaneY } from '../src/drone-shape.js';
import { buildDroneMesh } from '../src/drone-mesh.js';
import { targetBuild } from './target-build.mjs';
import { targetCamera, CAMERA_FAMILIES } from './target-camera.mjs';
import { FAMILIES, PROFILES } from '../src/drone-profiles.js';

// Les deux bornes. Ces nombres sont ceux des selftests
// (tools/onboard-frame-selftest.mjs et tools/onboard-drone-selftest.mjs) : ils
// ne se règlent pas ici.
//
// MAX_AREA porte sur les DISQUES seuls, et c'est lui qui commande la hauteur :
// le disque est la seule pièce dont la place à l'image dépend du montage.
//
// Ce que la machine occupe VRAIMENT est une autre grandeur, mesurée par
// tools/lens-coverage.mjs et seulement RAPPORTÉE ici — aucun réglage ne la
// commande, elle est ce que la famille est. La première version de cette issue
// annonçait « ≤ 8 % de l'image » : c'était la mesure des disques, promue en
// mesure de tout. La vraie va de 8 % (long range) à 38 % (toothpick). Les
// bornes par famille sont écrites, mesurées, dans
// tools/onboard-drone-selftest.mjs.
const MAX_AREA = 0.08;
// Et la hauteur atteinte, la troisième borne : rien au-dessus de la moitié du
// cadre au pire tirage (l'horizon du plan d'hélice — voir plus haut).
const MAX_TOP = 0.50;

// Pas et plafond de la recherche, en mètres. 0,2 mm est aussi la résolution à
// laquelle le bloc est écrit (4 décimales), pour que ce qui est mesuré soit
// exactement ce qui est écrit.
const Y_STEP = 0.0002;
const Y_COARSE = 0.001;
const Y_MAX = 0.030;

// Deux résolutions : la grossière encadre, la fine tranche.
// La sonde d'objectif est chère (un rayon par pixel contre tous les triangles) :
// on cherche sur les coins de l'enveloppe caméra, on vérifie finement à la fin.
const LENS_SCAN = { n: 2, grid: 32 };
const LENS_FINE = { grid: 56 };
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

// Les triangles du niveau `onboard`, dans le repère du corps. Ce niveau ne
// porte que les rotors, donc il ne dépend PAS du montage : une seule
// construction sert à tous les montages essayés.
function lensGeometryFor(family) {
	const seed = `mount::${family}`;
	const build = targetBuild({ seed, family });
	const camera = targetCamera({ seed, family });
	const mesh = buildDroneMesh(shapeOf({ profile: build.profile, build, camera, detail: 'onboard' }),
		{ colors: { frame: 0x333333, metal: 0x888888, prop: 0xcccccc, led: 0xffffff } });
	const tri = trianglesOf(mesh);
	mesh.dispose();
	return tri;
}

// Le pire cas de ce que l'objectif voit, sur un jeu de caméras.
function worstLens(tri, cams, y, z, grid) {
	let area = 0, top = 0;
	for (const c of cams) {
		const r = lensCoverage({ triangles: tri, eye: [0, y, z], uptiltDeg: c.uptiltDeg, fovDeg: c.fovDeg, aspect: c.aspect, grid });
		if (r.area > area) area = r.area;
		if (r.top > top) top = r.top;
	}
	return { area, top };
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

// La hauteur : celle qui rend les hélices LE PLUS PRÉSENTES sans dépasser la
// borne des disques. Formulée ainsi et non « la plus grande », parce que la
// relation entre hauteur et couverture s'inverse selon l'avancée : au bord de
// la plaque, monter fait grossir les disques (le maximum admissible est donc la
// plus grande hauteur) ; une fois l'objectif avancé devant les hélices, monter
// les fait fuir et la plus grande hauteur donnerait une vue où l'on ne voit
// plus rien. « Le plus présentes sous la borne » dit la même chose dans le
// premier cas et la bonne chose dans le second.
function searchY(shape, scan, fine, z, verbose, trail) {
	// 1. Balayage grossier : on retient tous les paliers admissibles, classés
	//    par ce qu'ils montrent.
	const cand = [];
	for (let y = Y_COARSE / 2; y <= Y_MAX + 1e-12; y += Y_COARSE / 2) {
		const m = worst(shape, scan, q4(y), z, SCAN.grid);
		if (verbose) trail.push(`  y = ${(1000 * y).toFixed(1)} mm  →  ${(100 * m.area).toFixed(1)} % / ${(100 * m.top).toFixed(0)} %`);
		if (m.area <= MAX_AREA && m.top <= MAX_TOP) cand.push({ y: q4(y), area: m.area });
	}
	cand.sort((a, b) => b.area - a.area);
	// 2. Vérification fine, du plus généreux au plus sage : la sonde grossière
	//    sous-estime un peu, le meilleur palier grossier peut donc casser.
	for (const c of cand.slice(0, 12)) {
		const m = worst(shape, fine, c.y, z, FINE.grid);
		if (m.area <= MAX_AREA && m.top <= MAX_TOP) return { y: c.y, ...m };
	}
	return null;
}

function search(family, verbose) {
	const shape = shapeFor(family);
	const tri = lensGeometryFor(family);
	const scan = envelope(family, SCAN.n);
	const seeds = seedCameras(family);
	const fine = [...envelope(family, FINE.n), ...seeds];
	const lensCams = envelope(family, LENS_SCAN.n);
	const plate = q4(-0.55 * PROFILES[family].armZ);
	const trail = [];

	// La hauteur se cherche, l'avancée non (voir l'en-tête). Ce que la machine
	// occupe est ensuite mesuré et rapporté, jamais optimisé.
	const z = plate;
	const keep = searchY(shape, scan, fine, z, verbose, trail);
	if (!keep) return { family, y: null, z, trail };

	const lens = worstLens(tri, [...lensCams, ...seeds], propPlaneY + keep.y, z, LENS_FINE.grid);
	return {
		family, y: keep.y, z, area: keep.area, top: keep.top, cam: keep.cam,
		median: medianTop(shape, seeds, keep.y, z, FINE.grid),
		lens: lens.area,
		trail,
	};
}

const argv = process.argv.slice(2);
const write = argv.includes('--write');
const verbose = argv.includes('--verbose');
const only = argv.find((a) => !a.startsWith('--'));
const families = !only || only === 'all' ? FAMILIES : [only];

const found = {};
let missing = 0;
console.log('famille        y      disques    hauteur méd   hauteur pire   la machine occupe');
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
	console.log(`${family.padEnd(11)} ${(1000 * b.y).toFixed(1)} mm   ${(100 * b.area).toFixed(1)} %       ${(100 * b.median).toFixed(0)} %          ${(100 * b.top).toFixed(0)} %          ${(100 * b.lens).toFixed(0)} %`);
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

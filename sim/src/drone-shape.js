// La recette d'un quad (issue #250) — PURE : une liste de primitives en mètres
// dans le repère du corps (nez −Z, haut +Y), que src/drone-mesh.js assemble.
// Aucune dimension n'est inventée : elles viennent des INVARIANTS par famille
// (propRadius, armX/armZ, bladeCount — tools/target-build.mjs) et de ce que le
// build sait varier (masse, cellules) ; la caméra vient de targetCamera().
//
// Rôles : plate arm motor prop duct camera battery gopro antenna led,
// plus blade, bell et tape (dès `onboard`), hub, stack, cage, mount, strap,
// ledbar, rail, goprolens et sticker (`portrait` seulement).
//
// Le CHÂSSIS varie par build (issue #285, `build.frame`) aux niveaux `onboard`
// et `portrait` : le patron dit d'où partent les bras et quelle plaque les
// porte. La silhouette des ambiants ne le lit pas — elle est gelée.
//
// Trois niveaux de détail (issue #264) : `silhouette` (le défaut, ce que
// voient les ambiants — inchangé), `onboard` (les hélices sont à 8 cm de
// l'objectif : elles gagnent leurs pales) et `portrait` (le fil de fer du
// crash et la free cam, vus de près : cloches et moyeux, stack, cage de
// caméra, fixations d'antenne — issue #283).

import { PROFILES } from './drone-profiles.js';
import { SWARM_UNIT } from './swarm.js';
import { motorsOf } from './quad.js';
import { armStart, plateOf } from '../tools/target-frame.mjs';

const box = (role, at, size, extra = {}) => ({ kind: 'box', role, at, size, ...extra });
const cyl = (role, at, r, h, extra = {}) => ({ kind: 'cylinder', role, at, size: [r, h], ...extra });

// Les étages de la demi-sphère du dôme. Trois : au-delà, on paie des triangles
// pour un objet qui se lit à trente mètres.
const DOME_SLABS = 3;

const DUCTED = new Set(['cinewhoop', 'toothpick', 'swarmUnit']);

// Families whose airframe is a MICRO: thin arms, no camera cage. A 3" recon
// unit is built like a toothpick, not like a 5" freestyle.
const MICRO = new Set(['toothpick', 'swarmUnit']);

// Rotor plane height above the body centre, in metres, so the camera and the
// blades hang off a name instead of copying 0.020 around.
//
// It lived in quad.js for as long as the flight model needed it as a lever
// (#91); with those moments removed (#103) the physics has no opinion on where
// the discs are, so the number comes home to the drawing that uses it.
export const propPlaneY = 0.020;

// Le montage de l'objectif : sa hauteur AU-DESSUS du plan d'hélice et son
// avancée depuis le centre, en mètres.
// ÉCRIT PAR `node tools/tune-mount.mjs --write`, jamais à la main — voir
// l'en-tête de cet outil pour la mesure qui l'impose. L'avancée y est figée au
// bord avant de la plaque (−0,55·armZ) : l'objectif ne sort pas du châssis.
// Seule la hauteur est cherchée, et c'est la plus grande que la borne de
// couverture autorise.
export const MOUNT = {
	freestyle5: { y: 0.0030, z: -0.0429 },
	race5: { y: 0.0020, z: -0.0407 },
	cinewhoop: { y: 0.0060, z: -0.0330 },
	longrange: { y: 0.0040, z: -0.0577 },
	heavy5: { y: 0.0040, z: -0.0440 },
	toothpick: { y: 0.0015, z: -0.0209 },
};

// Les trois niveaux de détail. Un niveau inconnu lève : une faute de frappe ne
// doit pas retomber en douce sur la silhouette.
const DETAILS = new Set(['silhouette', 'onboard', 'portrait']);

// Le donneur de HAUTEUR d'objectif d'une famille que tune-mount.mjs ne sonde
// pas — l'outil boucle sur FAMILIES, et l'essaim (issue #29) n'y est pas. Son
// AVANCÉE, elle, n'est pas empruntée : elle se recalcule par la règle que
// l'outil applique lui-même, le bord avant de la plaque (−0,55·armZ).
const MOUNT_DONOR = { swarmNode: 'heavy5', swarmUnit: 'toothpick' };

// La position de l'oeil dans le repère du corps : c'est le montage mesuré, et
// c'est la SEULE définition. La recette y pose son boîtier de caméra, la vue
// embarquée y pose son objectif, la sonde de couverture l'y trouve — les trois
// doivent lire le même point, sinon la borne DA ne veut plus rien dire.
export function eyeOf(profile) {
	const mount = MOUNT[profile.family];
	if (mount) return [0, propPlaneY + mount.y, mount.z];
	const donor = MOUNT[MOUNT_DONOR[profile.family]] ?? MOUNT.freestyle5;
	return [0, propPlaneY + donor.y, -0.55 * profile.armZ];
}

// Les profils qui n'existent QUE pour la recette (issue #29) : une machine
// peut exister pour l'oeil sans exister pour le banc. `swarmUnit` n'est pas
// dans PROFILES — elle n'est jamais pilotée, donc elle n'a ni PID ni tune —
// mais shapeOf() prend un profil et non un nom de famille, donc il suffit de
// lui en tendre un. Les dimensions viennent de SWARM_UNIT (src/swarm.js), la
// seule définition ; `cells` remplace le pack du build, que cette machine
// n'a pas (voir shapeOf).
export const RECIPE_PROFILES = {
	swarmUnit: {
		family: SWARM_UNIT.family,
		mass: SWARM_UNIT.mass,
		armX: SWARM_UNIT.armX,
		armZ: SWARM_UNIT.armZ,
		propRadius: SWARM_UNIT.propRadius,
		bladeCount: SWARM_UNIT.bladeCount,
		cells: 3,
	},
};

// Le planform d'une pale (issue #283) : les stations d'emplanture en bout,
// chacune avec son bord d'attaque et son bord de fuite, en coordonnées LOCALES
// de la part `blade` — l'origine sur l'axe du moteur, la pale le long de +Z, la
// corde le long de X, le pas par rotation autour de +Z. C'est la SEULE
// description de la pale : src/drone-mesh.js en tend une bande de triangles,
// src/drone-wire.js en trace le contour. Deux vues d'un même objet.
//
// Ce n'est pas un profil mesuré sur une hélice de marque : c'est ce qui se lit
// comme une pale et pas comme une planche. Une corde qui s'élargit vers 45 %
// du rayon puis s'effile en un bout arrondi, un léger sabre vers l'arrière au
// bout, et un pas qui décroît de l'emplanture au bout — c'est le vrillage
// d'une hélice réelle, et c'est lui qui donne du relief au fil de fer.
//
// Le sens : `spin` +1 tourne dans le sens direct autour de +Y (vu de dessus,
// anti-horaire), ce qui envoie +Z vers +X — le bord d'attaque est donc en +X
// pour spin +1, en −X pour spin −1, et le sabre part à l'opposé.
export const BLADE_STATIONS = 6;
export function bladeOutline(part) {
	const R = part.size[0];
	const cMax = part.size[1];
	const spin = part.spin || 1;
	const r0 = 0.16 * R;                       // le moyeu, sous la pale
	const le = [], te = [];
	for (let i = 0; i <= BLADE_STATIONS; i++) {
		const t = i / BLADE_STATIONS;
		const z = r0 + (R - r0) * t;
		// Corde : large au milieu, effilée au bout (arrondi en racine carrée).
		const chord = cMax * (0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, t * 1.15))) * Math.sqrt(1 - t ** 4);
		const sweep = -spin * 0.12 * R * t * t;   // le sabre, vers l'arrière
		const pitch = 0.38 - 0.22 * t;            // rad : plus de pas à l'emplanture
		const c = Math.cos(pitch), sn = Math.sin(pitch);
		for (const [arr, sign] of [[le, +spin], [te, -spin]]) {
			const x = sweep + sign * chord / 2;
			// Le pas : rotation de la corde autour de l'axe de la pale (+Z).
			arr.push([x * c, x * sn, z]);
		}
	}
	return { le, te };
}

export function shapeOf({ profile, build, camera, detail = 'silhouette' }) {
	if (!DETAILS.has(detail)) throw new Error(`niveau de détail inconnu : ${detail}`);
	const onboard = detail !== 'silhouette';
	const portrait = detail === 'portrait';
	// La vue embarquée ne montre QUE les quatre rotors. Un objectif ne filme pas
	// son propre boîtier — la part `camera` est centrée sur l'oeil, elle
	// couvrirait tout le cadre — ni le pack, la GoPro et les antennes, qui vivent
	// derrière lui. Ce n'est pas une optimisation : c'est ce qu'une caméra FPV
	// voit. La règle se teste, et le test est « le centre du cadre reste libre »
	// (tools/onboard-drone-selftest.mjs).
	const lensView = detail === 'onboard';
	const { family, armX, armZ, propRadius, bladeCount, mass } = profile;
	const parts = [];
	const heavy = family === 'heavy5';
	const micro = MICRO.has(family);

	// Le châssis de l'exemplaire (issue #285) : la silhouette ne le lit pas.
	const frame = onboard ? build.frame ?? null : null;
	const plateT = heavy ? 0.010 : 0.006;
	// Plaque centrale — celle du patron dès `onboard`.
	if (!lensView) {
		if (frame) {
			const pl = plateOf(frame, profile);
			parts.push(box('plate', [0, 0, pl.shift], [pl.width, plateT, pl.length]));
			// Le corps long d'un H : le rail qui relie les deux bouts.
			if (frame.pattern === 'h') parts.push(box('rail', [0, 0, 0], [0.020, plateT, 1.30 * armZ]));
		} else {
			parts.push(box('plate', [0, 0, 0], [0.8 * armX, plateT, 1.1 * armZ]));
		}
	}

	// Bras, moteurs, hélices, conduits. L'ordre et le sens viennent de
	// motorsOf() — la MÊME table que le mixeur (quad.js:65-77) — et pas d'une
	// boucle de signes. Même argument que celui déjà écrit dans quad.js pour
	// mixOf() : une hélice qu'on déplace ne peut pas désynchroniser
	// silencieusement l'image de la physique. C'est ce qui fait que le lacet,
	// le roulis et le tangage se LISENT dans les deux hélices du champ.
	const armR = micro ? 0.005 : 0.008;
	const armW = armR * (frame?.armK ?? 1);
	const motors = motorsOf(profile);
	for (let k = 0; k < motors.length; k++) {
		const { x: mx, z: mz, spin } = motors[k];
		// D'où part le bras : le centre (silhouette, patron `x`), ou ce que le
		// patron du châssis dit. Il arrive TOUJOURS au moteur.
		const [sx, , sz] = frame ? armStart(frame, motors[k], profile) : [0, 0, 0];
		const dx = mx - sx, dz = mz - sz;
		const len = Math.hypot(dx, dz);
		const rotY = Math.atan2(dx, dz);
		parts.push(box('arm', [(mx + sx) / 2, 0, (mz + sz) / 2], [armW, armR, len], { rotY, motor: k }));
		// Le ruban du propriétaire (issue #285) au bout du bras, côté moteur :
		// un manchon de couleur, visible dans le champ — les bouts de bras y
		// sont. Dès `onboard`, comme le bras.
		if (onboard && build.livery?.owner?.tape) {
			const t = 0.78;
			parts.push(box('tape', [sx + dx * t, 0, sz + dz * t], [armW + 0.002, armR + 0.002, 0.014], { rotY, motor: k }));
		}
		parts.push(cyl('motor', [mx, 0.006 + 0.006, mz], 0.18 * propRadius, 0.012, { motor: k }));
		parts.push({ kind: 'disc', role: 'prop', at: [mx, propPlaneY, mz], size: [propRadius], blades: bladeCount, motor: k, spin });
		if (DUCTED.has(family)) parts.push({ kind: 'ring', role: 'duct', at: [mx, 0.012, mz], size: [1.12 * propRadius, 0.5 * propRadius], motor: k });
	}

	// Les pales, seulement à partir du niveau `onboard`. Vues de 8 cm, un
	// disque plat ne tient pas : il est soit invisible (par la tranche), soit
	// envahissant — la singularité est dans la primitive. Le disque reste quand
	// même : c'est l'enveloppe que le shader fond en flou quand le régime monte,
	// et c'est sur elle que porte la borne DA (tools/prop-coverage.mjs). Les
	// pales S'AJOUTENT au disque, elles ne le remplacent jamais.
	//
	// Une pale est une primitive à part entière (issue #283) : son contour est
	// bladeOutline(), son `at` est l'axe du moteur, `rotY` son azimut. Le pas
	// est DANS le contour, station par station — il n'est plus un rotZ
	// uniforme, qui faisait de la pale une planche inclinée.
	if (onboard) {
		const chord = 0.24 * propRadius;          // corde maximale d'une hélice de course
		for (let k = 0; k < motors.length; k++) {
			const m = motors[k];
			for (let b = 0; b < bladeCount; b++) {
				const ang = (2 * Math.PI * b) / bladeCount;
				parts.push({ kind: 'blade', role: 'blade', at: [m.x, propPlaneY, m.z], size: [propRadius, chord], rotY: ang, motor: k, spin: m.spin });
			}
		}
	}

	// La cloche : la partie tournante du moteur, un peu plus large que son
	// pied, et dont le dessus PORTE l'hélice — son sommet est le plan
	// d'hélice. Avant #283 elle traversait le disque et dépassait au-dessus,
	// ce qu'aucun moteur ne fait. Dès `onboard` (#286) : c'est la pièce de
	// livrée la plus proche de l'objectif, et elle vit SOUS le plan d'hélice —
	// la borne de hauteur ne la voit pas, contrairement au moyeu.
	if (onboard) {
		for (let k = 0; k < motors.length; k++) {
			const m = motors[k];
			parts.push(cyl('bell', [m.x, propPlaneY - 0.004, m.z], 0.205 * propRadius, 0.008, { motor: k }));
		}
	}

	// Ce qui ne se voit que de près, et qui distingue deux machines.
	if (portrait) {
		for (let k = 0; k < motors.length; k++) {
			const m = motors[k];
			// Le moyeu : l'écrou et le pied de pale, posés sur le disque. C'est
			// lui qui ferme le centre de l'hélice, que les pales laissent vide.
			// `portrait` seulement : dans le champ, il monterait au-dessus de
			// l'oeil du toothpick (objectif à 1,5 mm du plan d'hélice) et
			// crèverait la borne « moitié haute du cadre libre ».
			parts.push(cyl('hub', [m.x, propPlaneY + 0.003, m.z], 0.09 * propRadius, 0.006, { motor: k }));
		}
		// Le stack (FC + ESC), SOUS la plaque : sur le dessus il vivrait dans
		// la batterie, qui y est déjà posée — invisible en 3D, du bruit en fil
		// de fer.
		parts.push(box('stack', [0, -0.003 - 0.005, 0], [0.030, 0.010, 0.030]));
		// La cage de caméra : deux flasques de part et d'autre de l'objectif,
		// de la plaque au-dessus du boîtier. C'est la signature d'un châssis
		// freestyle ; un micro n'en a pas (il vole sous une canopée), un
		// cinewhoop non plus (ses conduits font le tour).
		if (!micro && !DUCTED.has(family)) {
			const eye = eyeOf(profile);
			const top = eye[1] + (0.0095 + 0.004) * (frame?.cageK ?? 1);
			for (const sx of [-1, 1]) {
				parts.push(box('cage', [sx * 0.0135, (0.003 + top) / 2, eye[2]], [0.002, top - 0.003, 0.028]));
			}
		}
	}

	// Caméra FPV, à l'avant, inclinée du uptilt. Sa HAUTEUR n'est pas libre :
	// elle se compte depuis le PLAN D'HÉLICE, parce que c'est cet écart — et lui
	// seul — qui décide de ce que la vue embarquée montre. Elle est mesurée par
	// tools/tune-mount.mjs (bloc MOUNT ci-dessus).
	if (!lensView) parts.push(box('camera', eyeOf(profile), [0.019, 0.019, 0.010], { rotX: camera.uptiltDeg * Math.PI / 180 }));

	// Le pack de l'exemplaire, ou celui de la recette quand la machine n'a pas
	// d'exemplaire du tout (issue #29 : swarmUnit emprunte un build, pas une
	// batterie). Aucune famille de PROFILES ne porte `cells` à la racine.
	const cells = profile.cells ?? build.spec.cells;
	// Batterie sur le dessus : 20 mm par cellule.
	if (!lensView) parts.push(box('battery', [0, 0.008 + 0.0125, 0], [0.035, 0.025, 0.020 * cells]));
	// Sa sangle, qui fait le tour du pack (#284, `portrait`) : une bande à
	// peine plus large que lui, au milieu de sa longueur.
	if (portrait) parts.push(box('strap', [0, 0.008 + 0.0125, 0], [0.037, 0.027, 0.020]));
	// Le numéro du propriétaire (issue #285), collé sur le dessus du pack,
	// derrière la sangle. Trois chiffres dessinés par le shader.
	if (portrait && build.livery?.owner?.number) {
		parts.push(box('sticker', [0, 0.008 + 0.025 + 0.0006, 0.010 + 0.007 * cells], [0.024, 0.0012, 0.014]));
	}

	// Le dôme de liaison du nœud d'essaim (issue #29), posé sur le pack : c'est
	// LA pièce qui le distingue d'un 6" ordinaire, et la seule que la nuée voie
	// de loin. Une demi-sphère basse résolution, empilée en cylindres — le
	// maillage ne connaît pas la sphère et ne change pas (spec « Le maillage »),
	// et le fil de fer sait déjà tracer un cylindre. Rôle inconnu de
	// MATERIAL_OF : il sort en carbone, ce qu'un radome est.
	if (!lensView && family === 'swarmNode') {
		const domeR = 0.030, domeH = 0.022, base = 0.008 + 0.025;
		for (let i = 0; i < DOME_SLABS; i++) {
			const h = domeH / DOME_SLABS;
			const t = (i + 0.5) / DOME_SLABS;                 // hauteur relative du milieu de l'étage
			parts.push(cyl('dome', [0, base + (i + 0.5) * h, 0], domeR * Math.sqrt(1 - t * t), h));
		}
	}

	// GoPro : toujours sur le cinewhoop ; sur un freestyle/heavy lourd.
	// heavyBuild compare la masse de l'exemplaire à la masse NOMINALE de la
	// famille (PROFILES[family].mass), pas à la masse du build lui-même — voir
	// la NOTE du brief : build.variation est l'amplitude de tirage, pas le
	// ratio de masse tiré.
	// `PROFILES[family]` est absent des familles recette-seule (swarmUnit) : elles
	// n'ont pas de nominal auquel se comparer, donc aucun exemplaire n'est lourd.
	const heavyBuild = mass > 1.05 * (PROFILES[family]?.mass ?? Infinity);
	if (!lensView && (family === 'cinewhoop' || ((family === 'freestyle5' || heavy) && heavyBuild))) {
		parts.push(box('gopro', [0, 0.008 + 0.025 + 0.0125, -0.35 * armZ], [0.040, 0.025, 0.030]));
		// De près, une GoPro a un objectif (issue #285) : un cylindre sombre
		// qui sort de la face avant, décalé vers le haut et un côté comme sur
		// la vraie. Un boîtier sans lui est une brique.
		if (portrait) parts.push(cyl('goprolens', [-0.010, 0.008 + 0.025 + 0.0125 + 0.004, -0.35 * armZ - 0.015 - 0.004], 0.0065, 0.008, { rotX: Math.PI / 2 }));
	}

	// Antennes à l'arrière ; deux sur le long range.
	const nAnt = lensView ? 0 : (family === 'longrange' || family === 'swarmNode') ? 2 : 1;
	for (let i = 0; i < nAnt; i++) {
		const x = nAnt === 2 ? (i === 0 ? -0.02 : 0.02) : 0;
		parts.push(cyl('antenna', [x, 0.03, 0.5 * armZ], 0.0015, 0.060, { rotX: -Math.PI / 6 }));
		// Sa fixation, au pied du brin : le support TPU vissé au bord arrière
		// de la plaque (`portrait` seulement — invisible de plus loin).
		if (portrait) parts.push(box('mount', [x, 0.006, 0.5 * armZ + 0.010], [0.008, 0.012, 0.012], { rotX: -Math.PI / 6 }));
	}

	// LED à l'arrière.
	// L'unité d'essaim porte une LED FORTE (issue #29) : c'est sa seule lumière,
	// et c'est elle qui fait lire douze machines comme une formation. Le
	// billboard tire sa taille écran de `uMinPx` (src/drone-mesh.js) et non de
	// cette dimension — celle-ci dit l'intention, swarm-drones.js la sert.
	if (!lensView) parts.push({ kind: 'point', role: 'led', at: [0, 0.004, 0.55 * armZ], size: [family === 'swarmUnit' ? 0.007 : 0.004] });
	// La barre de LED sur le bord arrière de la plaque (#284, `portrait`) :
	// de près, le point qui strobe ne suffit pas, on voit le bandeau.
	if (portrait) parts.push(box('ledbar', [0, 0, 0.55 * armZ + 0.002], [0.024, 0.005, 0.004]));

	const boundingRadius = Math.hypot(armX, armZ) + (DUCTED.has(family) ? 1.12 : 1) * propRadius + 0.02;
	return { family, parts, boundingRadius };
}

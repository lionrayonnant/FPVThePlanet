// La recette d'un quad (issue #250) — PURE : une liste de primitives en mètres
// dans le repère du corps (nez −Z, haut +Y), que src/drone-mesh.js assemble.
// Aucune dimension n'est inventée : elles viennent des INVARIANTS par famille
// (propRadius, armX/armZ, bladeCount — tools/target-build.mjs) et de ce que le
// build sait varier (masse, cellules) ; la caméra vient de targetCamera().
//
// Rôles : plate arm motor prop duct camera battery gopro antenna led,
// plus blade (dès `onboard`), bell et stack (`portrait` seulement).
//
// Trois niveaux de détail (issue #264) : `silhouette` (le défaut, ce que
// voient les ambiants — inchangé), `onboard` (les hélices sont à 8 cm de
// l'objectif : elles gagnent leurs pales) et `portrait` (le fil de fer du
// crash, vu de près et à l'arrêt : cloches moteur et stack).

import { PROFILES } from './drone-profiles.js';
import { motorsOf } from './quad.js';

const box = (role, at, size, extra = {}) => ({ kind: 'box', role, at, size, ...extra });
const cyl = (role, at, r, h, extra = {}) => ({ kind: 'cylinder', role, at, size: [r, h], ...extra });

const DUCTED = new Set(['cinewhoop', 'toothpick']);

// Hauteur du plan d'hélice au-dessus du centre du corps, en mètres. Nommée
// pour que la caméra et les pales s'y accrochent au lieu de recopier 0,020.
export const propPlaneY = 0.020;

// Le montage de l'objectif : sa hauteur AU-DESSUS du plan d'hélice et son
// avancée depuis le centre, en mètres.
// ÉCRIT PAR `node tools/tune-mount.mjs --write`, jamais à la main — voir
// l'en-tête de cet outil pour la mesure qui l'impose. L'avancée y est figée au
// bord avant de la plaque (−0,55·armZ) : l'objectif ne sort pas du châssis.
// Seule la hauteur est cherchée, et c'est la plus grande que la borne de
// couverture autorise.
export const MOUNT = {
	freestyle5: { y: 0.0032, z: -0.0429 },
	race5: { y: 0.0020, z: -0.0407 },
	cinewhoop: { y: 0.0062, z: -0.0330 },
	longrange: { y: 0.0040, z: -0.0577 },
	heavy5: { y: 0.0042, z: -0.0440 },
	toothpick: { y: 0.0016, z: -0.0209 },
};

// Les trois niveaux de détail. Un niveau inconnu lève : une faute de frappe ne
// doit pas retomber en douce sur la silhouette.
const DETAILS = new Set(['silhouette', 'onboard', 'portrait']);

// La position de l'oeil dans le repère du corps : c'est le montage mesuré, et
// c'est la SEULE définition. La recette y pose son boîtier de caméra, la vue
// embarquée y pose son objectif, la sonde de couverture l'y trouve — les trois
// doivent lire le même point, sinon la borne DA ne veut plus rien dire.
export function eyeOf(profile) {
	const mount = MOUNT[profile.family] ?? MOUNT.freestyle5;
	return [0, propPlaneY + mount.y, mount.z];
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
	const micro = family === 'toothpick';

	// Plaque centrale.
	if (!lensView) parts.push(box('plate', [0, 0, 0], [0.8 * armX, heavy ? 0.010 : 0.006, 1.1 * armZ]));

	// Bras, moteurs, hélices, conduits. L'ordre et le sens viennent de
	// motorsOf() — la MÊME table que le mixeur (quad.js:65-77) — et pas d'une
	// boucle de signes. Même argument que celui déjà écrit dans quad.js pour
	// mixOf() : une hélice qu'on déplace ne peut pas désynchroniser
	// silencieusement l'image de la physique. C'est ce qui fait que le lacet,
	// le roulis et le tangage se LISENT dans les deux hélices du champ.
	const armR = micro ? 0.005 : 0.008;
	const motors = motorsOf(profile);
	for (let k = 0; k < motors.length; k++) {
		const { x: mx, z: mz, spin } = motors[k];
		const len = Math.hypot(mx, mz);
		parts.push(box('arm', [mx / 2, 0, mz / 2], [armR, armR, len], { rotY: Math.atan2(mx, mz), motor: k }));
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
	if (onboard) {
		const chord = 0.20 * propRadius;          // corde typique d'une hélice de course
		const thick = 0.0015;
		for (let k = 0; k < motors.length; k++) {
			const m = motors[k];
			for (let b = 0; b < bladeCount; b++) {
				const ang = (2 * Math.PI * b) / bladeCount;
				// La pale part du moyeu vers l'extérieur : une boîte allongée,
				// vrillée du pas, tournée de son angle autour de l'axe du moteur.
				parts.push(box('blade',
					[m.x + 0.5 * propRadius * Math.sin(ang), propPlaneY, m.z + 0.5 * propRadius * Math.cos(ang)],
					[chord, thick, propRadius],
					{ rotY: ang, rotZ: m.spin * 0.20, motor: k, spin: m.spin }));
			}
		}
	}

	// Ce qui ne se voit que de près, et qui distingue deux machines.
	if (portrait) {
		for (let k = 0; k < motors.length; k++) {
			const m = motors[k];
			parts.push(cyl('bell', [m.x, 0.006 + 0.014, m.z], 0.21 * propRadius, 0.016, { motor: k }));
		}
		parts.push(box('stack', [0, 0.006 + 0.008, 0], [0.030, 0.014, 0.030]));
	}

	// Caméra FPV, à l'avant, inclinée du uptilt. Sa HAUTEUR n'est pas libre :
	// elle se compte depuis le PLAN D'HÉLICE, parce que c'est cet écart — et lui
	// seul — qui décide de ce que la vue embarquée montre. Elle est mesurée par
	// tools/tune-mount.mjs (bloc MOUNT ci-dessus).
	if (!lensView) parts.push(box('camera', eyeOf(profile), [0.019, 0.019, 0.010], { rotX: camera.uptiltDeg * Math.PI / 180 }));

	// Batterie sur le dessus : 20 mm par cellule.
	const cells = build.spec.cells;
	if (!lensView) parts.push(box('battery', [0, 0.008 + 0.0125, 0], [0.035, 0.025, 0.020 * cells]));

	// GoPro : toujours sur le cinewhoop ; sur un freestyle/heavy lourd.
	// heavyBuild compare la masse de l'exemplaire à la masse NOMINALE de la
	// famille (PROFILES[family].mass), pas à la masse du build lui-même — voir
	// la NOTE du brief : build.variation est l'amplitude de tirage, pas le
	// ratio de masse tiré.
	const heavyBuild = mass > 1.05 * PROFILES[family].mass;
	if (!lensView && (family === 'cinewhoop' || ((family === 'freestyle5' || heavy) && heavyBuild))) {
		parts.push(box('gopro', [0, 0.008 + 0.025 + 0.0125, -0.35 * armZ], [0.040, 0.025, 0.030]));
	}

	// Antennes à l'arrière ; deux sur le long range.
	const nAnt = lensView ? 0 : family === 'longrange' ? 2 : 1;
	for (let i = 0; i < nAnt; i++) {
		const x = nAnt === 2 ? (i === 0 ? -0.02 : 0.02) : 0;
		parts.push(cyl('antenna', [x, 0.03, 0.5 * armZ], 0.0015, 0.060, { rotX: -Math.PI / 6 }));
	}

	// LED à l'arrière.
	if (!lensView) parts.push({ kind: 'point', role: 'led', at: [0, 0.004, 0.55 * armZ], size: [0.004] });

	const boundingRadius = Math.hypot(armX, armZ) + (DUCTED.has(family) ? 1.12 : 1) * propRadius + 0.02;
	return { family, parts, boundingRadius };
}

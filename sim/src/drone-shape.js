// La recette d'un quad (issue #250) — PURE : une liste de primitives en mètres
// dans le repère du corps (nez −Z, haut +Y), que src/drone-mesh.js assemble.
// Aucune dimension n'est inventée : elles viennent des INVARIANTS par famille
// (propRadius, armX/armZ, bladeCount — tools/target-build.mjs) et de ce que le
// build sait varier (masse, cellules) ; la caméra vient de targetCamera().
//
// Rôles : plate arm motor prop duct camera battery gopro antenna led.

import { PROFILES } from './drone-profiles.js';
import { motorsOf } from './quad.js';

const box = (role, at, size, extra = {}) => ({ kind: 'box', role, at, size, ...extra });
const cyl = (role, at, r, h, extra = {}) => ({ kind: 'cylinder', role, at, size: [r, h], ...extra });

const DUCTED = new Set(['cinewhoop', 'toothpick']);

// Hauteur du plan d'hélice au-dessus du centre du corps, en mètres. Nommée
// pour que la caméra et les pales s'y accrochent au lieu de recopier 0,020.
export const propPlaneY = 0.020;

export function shapeOf({ profile, build, camera }) {
	const { family, armX, armZ, propRadius, bladeCount, mass } = profile;
	const parts = [];
	const heavy = family === 'heavy5';
	const micro = family === 'toothpick';

	// Plaque centrale.
	parts.push(box('plate', [0, 0, 0], [0.8 * armX, heavy ? 0.010 : 0.006, 1.1 * armZ]));

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

	// Caméra FPV, à l'avant, inclinée du uptilt.
	parts.push(box('camera', [0, 0.012, -0.55 * armZ], [0.019, 0.019, 0.010], { rotX: camera.uptiltDeg * Math.PI / 180 }));

	// Batterie sur le dessus : 20 mm par cellule.
	const cells = build.spec.cells;
	parts.push(box('battery', [0, 0.008 + 0.0125, 0], [0.035, 0.025, 0.020 * cells]));

	// GoPro : toujours sur le cinewhoop ; sur un freestyle/heavy lourd.
	// heavyBuild compare la masse de l'exemplaire à la masse NOMINALE de la
	// famille (PROFILES[family].mass), pas à la masse du build lui-même — voir
	// la NOTE du brief : build.variation est l'amplitude de tirage, pas le
	// ratio de masse tiré.
	const heavyBuild = mass > 1.05 * PROFILES[family].mass;
	if (family === 'cinewhoop' || ((family === 'freestyle5' || heavy) && heavyBuild)) {
		parts.push(box('gopro', [0, 0.008 + 0.025 + 0.0125, -0.35 * armZ], [0.040, 0.025, 0.030]));
	}

	// Antennes à l'arrière ; deux sur le long range.
	const nAnt = family === 'longrange' ? 2 : 1;
	for (let i = 0; i < nAnt; i++) {
		const x = nAnt === 2 ? (i === 0 ? -0.02 : 0.02) : 0;
		parts.push(cyl('antenna', [x, 0.03, 0.5 * armZ], 0.0015, 0.060, { rotX: -Math.PI / 6 }));
	}

	// LED à l'arrière.
	parts.push({ kind: 'point', role: 'led', at: [0, 0.004, 0.55 * armZ], size: [0.004] });

	const boundingRadius = Math.hypot(armX, armZ) + (DUCTED.has(family) ? 1.12 : 1) * propRadius + 0.02;
	return { family, parts, boundingRadius };
}

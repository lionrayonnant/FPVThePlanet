// Drones ambiants (issue #250) — le modèle PUR. Ni Three, ni Rapier, ni DOM :
// les rayons sont des fonctions injectées ({ groundBelow, obstructionBetween }
// duck-typé comme src/entry-state.js), le rendu vit dans src/drone-mesh.js et
// le son dans src/ambient-audio.js.
//
// Ce fichier tient : l'ensemble (qui vole), les routines (comment chaque
// famille vole), les courbes (où), la bulle (autour de qui), les ancres et
// leur validation, l'attitude (comment le corps se tient). Tout est
// déterministe sur la graine du scan, et update() n'alloue rien.

import { generateTargetScan } from '../tools/target-model.mjs';

export const G = 9.81;
export const MAX_DRONES = 4;
// v²/r ≤ TURN_MARGIN · a_max : un quad ne vire pas en butée de poussée.
export const TURN_MARGIN = 0.6;

// Hash FNV-1a d'une chaîne → graine 32 bits, puis xorshift (même idiome que
// tools/target-model.mjs, src/entry-state.js et src/link.js).
export function rngFrom(seed) {
	let h = 0x811c9dc5;
	const s = String(seed);
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	let x = h >>> 0 || 1;
	return () => {
		x ^= x << 13; x >>>= 0;
		x ^= x >> 17;
		x ^= x << 5; x >>>= 0;
		return x / 4294967296;
	};
}

const lerp = (rand, [a, b]) => a + rand() * (b - a);

// Les candidats non pris, avec la graine d'exemplaire que resolveTarget()
// leur aurait donnée. Pur et déterministe : le même scan rend le même ciel.
export function ambientSet(scan) {
	const { candidates } = generateTargetScan({ seed: scan.seed, count: scan.count });
	const out = [];
	for (let i = 0; i < candidates.length; i++) {
		if (i === scan.index) continue;
		const c = candidates[i];
		out.push({
			i, id: c.id, family: c._family,
			buildSeed: `${scan.seed}::${i}`,
			rssiDbm: c.rssiDbm, mode: c._videoHint,
		});
		if (out.length === MAX_DRONES) break;
	}
	return out;
}

// Une routine par famille. Plages choisies à l'oreille de pilote, comme
// RANGES de l'entry state ; c'est le filet (validation) qui rend chaque
// tirage juste, pas la plage. `radius` du long range = rayon du demi-tour.
export const ROUTINES = {
	race5: { kind: 'loop', agl: [3, 10], speed: [15, 22], radius: [12, 20] },
	freestyle5: { kind: 'eight', agl: [10, 40], speed: [12, 18], radius: [18, 28], vertical: 8 },
	heavy5: { kind: 'eight', agl: [10, 30], speed: [9, 14], radius: [22, 30], vertical: 0 },
	cinewhoop: { kind: 'orbit', agl: [15, 30], speed: [3, 6], radius: [10, 25], faceAnchor: true },
	longrange: { kind: 'cruise', agl: [60, 120], speed: [18, 26], radius: [120, 120], leg: 400 },
	toothpick: { kind: 'orbit', agl: [1, 5], speed: [2, 5], radius: [4, 8], jitter: true },
};

// Accélération latérale maximale d'un quad de rapport poussée/poids twr :
// la poussée doit d'abord porter le poids, le reste vire.
export function lateralAccelMax(twr) {
	return twr > 1 ? G * Math.sqrt(twr * twr - 1) : 0;
}

export function routineFor({ family, twr, rand }) {
	const spec = ROUTINES[family];
	if (!spec) throw new Error(`famille sans routine : ${family}`);
	const radius = lerp(rand, spec.radius);
	const agl = lerp(rand, spec.agl);
	let speed = lerp(rand, spec.speed);
	// Le TWR borne le virage — le seul point où le build change la routine.
	const vMax = Math.sqrt(TURN_MARGIN * lateralAccelMax(twr) * radius);
	if (speed > vMax) speed = Math.max(spec.speed[0] * 0.5, vMax);
	const dir = rand() < 0.5 ? -1 : 1;
	const phase = rand() * Math.PI * 2;
	// Plan de la boucle du race : incliné de 10 à 35° pour que la boucle ne
	// soit pas un cercle plat — un race prend de la hauteur en sortie de virage.
	const tiltPlane = spec.kind === 'loop' ? (10 + rand() * 25) * Math.PI / 180 : 0;
	const jitter = spec.jitter
		? [0.7, 1.3, 2.1].map((hz) => ({ amp: 0.3, hz, phase: rand() * Math.PI * 2 }))
		: [];
	let period;
	if (spec.kind === 'cruise') period = (2 * spec.leg + Math.PI * radius) / speed;
	else if (spec.kind === 'eight') period = 2 * (2 * Math.PI * radius) / speed;
	else period = (2 * Math.PI * radius) / speed;
	return {
		kind: spec.kind, family, aglMin: spec.agl[0], agl, speed, radius, dir, phase,
		tiltPlane, vertical: spec.vertical ?? 0, leg: spec.leg ?? 0,
		faceAnchor: !!spec.faceAnchor, jitter, period,
	};
}

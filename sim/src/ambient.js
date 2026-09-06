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
	// Le TWR borne le virage.
	const vMax = Math.sqrt(TURN_MARGIN * lateralAccelMax(twr) * radius);
	if (speed > vMax) speed = vMax;
	const dir = rand() < 0.5 ? -1 : 1;
	const phase = rand() * Math.PI * 2;
	// Plan de la boucle du race : incliné de 10 à 35° pour que la boucle ne
	// soit pas un cercle plat — un race prend de la hauteur en sortie de virage.
	const tiltPlane = spec.kind === 'loop' ? (10 + rand() * 25) * Math.PI / 180 : 0;
	// Lemniscate de Gerono (huit) : pas à vitesse constante en w — on reparamètre
	// par abscisse curviligne. 64 segments, longueurs cumulées dans arc[1..64],
	// arc[0] = 0 ; la période est la vraie longueur du parcours / speed (et non
	// l'approximation "deux tours de cercle") pour que |v| ≈ speed tienne.
	let arc = null;
	if (spec.kind === 'eight') {
		arc = new Float64Array(65);
		let px = 2 * radius, pz = 0;
		for (let k = 1; k <= 64; k++) {
			const w = (Math.PI * 2 * k) / 64;
			const x = 2 * radius * Math.cos(w), z = radius * Math.sin(2 * w);
			arc[k] = arc[k - 1] + Math.hypot(x - px, z - pz);
			px = x; pz = z;
		}
	}
	let period;
	if (spec.kind === 'cruise') period = (2 * spec.leg + Math.PI * radius) / speed;
	else if (spec.kind === 'eight') period = arc[64] / speed;
	else period = (2 * Math.PI * radius) / speed;
	// Jitter du micro : les fréquences nominales (Hz) sont arrondies au nombre
	// entier d'harmoniques le plus proche sur la période de la routine, sinon
	// curveLocal(0) ≠ curveLocal(period) (le jitter ne boucle pas avec le reste).
	// amp à 0,15 (et non 0,3) : à 0,3, la dérivée du jitter (jusqu'à 2,1 Hz)
	// dépasse à elle seule 12 % de la vitesse nominale d'un micro lent —
	// le budget de rayon (±0,9 m annoncé au test) reste très large à 0,15.
	const jitter = spec.jitter
		? [0.7, 1.3, 2.1].map((hz) => ({
			amp: 0.15,
			nx: Math.max(1, Math.round(hz * period)),
			nz: Math.max(1, Math.round(hz * period * 0.7)),
			phase: rand() * Math.PI * 2,
		}))
		: [];
	return {
		kind: spec.kind, family, aglMin: spec.agl[0], agl, speed, radius, dir, phase,
		tiltPlane, vertical: spec.vertical ?? 0, leg: spec.leg ?? 0,
		faceAnchor: !!spec.faceAnchor, jitter, period, arc,
	};
}

export const SAMPLES = 16;
const TWO_PI = Math.PI * 2;

// Offset par rapport à l'ancre, à l'instant t, dans le plan de la routine.
// `y` est l'offset VERTICAL de la figure seule (plan incliné du race, sinus
// du huit, jitter du micro) — l'AGL et le relief sont ajoutés par curveAt().
// Non négatif pour le loop et le huit : la figure grimpe hors du virage,
// elle ne plonge jamais sous l'AGL tiré pour la routine.
export function curveLocal(r, t, out) {
	const u = (t / r.period) * TWO_PI * r.dir + r.phase;
	switch (r.kind) {
		case 'loop': {
			out.x = r.radius * Math.cos(u);
			out.z = r.radius * Math.sin(u);
			// Plan incliné : la hauteur suit une des deux composantes, jamais négative —
			// le race grimpe hors du virage, il ne plonge pas sous son AGL.
			out.y = Math.sin(r.tiltPlane) * r.radius * (1 + Math.sin(u));
			break;
		}
		case 'orbit': {
			out.x = r.radius * Math.cos(u);
			out.z = r.radius * Math.sin(u);
			out.y = 0;
			break;
		}
		case 'eight': {
			// Lemniscate de Gerono, deux lobes de rayon ~r, reparamétrée par
			// abscisse curviligne (r.arc, précalculée dans routineFor) pour une
			// vitesse constante : w n'avance pas linéairement avec t, mais avec
			// la longueur déjà parcourue, retrouvée par interpolation dans arc[].
			const frac = (((t / r.period) * r.dir + r.phase / (Math.PI * 2)) % 1 + 1) % 1;
			const target = frac * r.arc[64];
			let k = 0;
			while (k < 64 && r.arc[k + 1] < target) k++;
			if (k >= 64) k = 63;
			const segLen = r.arc[k + 1] - r.arc[k];
			const a = segLen > 1e-9 ? (target - r.arc[k]) / segLen : 0;
			const w = (Math.PI * 2 * (k + a)) / 64;
			out.x = 2 * r.radius * Math.cos(w);
			out.z = r.radius * Math.sin(2 * w);
			// Jamais négatif, même raison que le loop.
			out.y = r.vertical * (1 + Math.sin(w * 2 + 1));
			break;
		}
		case 'cruise': {
			// Stade : deux segments de `leg`, deux demi-tours de rayon `radius`.
			const L = r.leg, R = r.radius;
			const total = 2 * L + Math.PI * R;
			let s = ((t * r.speed * r.dir) % total + total) % total;
			out.y = 0;
			if (s < L) { out.x = -L / 2 + s; out.z = -R / 2; }
			else if (s < L + Math.PI * R / 2) {
				// Demi-tour de rayon R/2 : a va de 0 à π sur tout le budget d'arc
				// (piR/2), donc da/ds = 2/R, pas 1/R.
				const a = 2 * (s - L) / R;
				out.x = L / 2 + R / 2 * Math.sin(a); out.z = -R / 2 + R / 2 * (1 - Math.cos(a));
			} else if (s < 2 * L + Math.PI * R / 2) { s -= L + Math.PI * R / 2; out.x = L / 2 - s; out.z = R / 2; }
			else {
				const a = 2 * (s - 2 * L - Math.PI * R / 2) / R;
				out.x = -L / 2 - R / 2 * Math.sin(a); out.z = R / 2 - R / 2 * (1 - Math.cos(a));
			}
			break;
		}
		default: throw new Error(`routine inconnue : ${r.kind}`);
	}
	for (let k = 0; k < r.jitter.length; k++) {
		const j = r.jitter[k];
		// Harmoniques entières de la période (j.nx, j.nz précalculées dans
		// routineFor) : le jitter boucle exactement avec le reste de la figure.
		const ux = (t / r.period) * TWO_PI * j.nx + j.phase;
		const uz = (t / r.period) * TWO_PI * j.nz + j.phase;
		const s = Math.sin(ux);
		out.x += j.amp * s; out.z += j.amp * Math.cos(uz); out.y += j.amp * 0.5 * s;
	}
	return out;
}

const _c = { x: 0, y: 0, z: 0 };

// Hauteur absolue de la courbe à chacun des SAMPLES échantillons : sol + agl.
// `groundBelow(x, z)` rend la hauteur du sol ou null (pas de terrain).
export function curveHeights(r, anchor, groundBelow, heights) {
	for (let i = 0; i < SAMPLES; i++) {
		curveLocal(r, r.period * i / SAMPLES, _c);
		const g = groundBelow(anchor.x + _c.x, anchor.z + _c.z);
		if (g == null) return false;
		heights[i] = g + r.agl;
	}
	return true;
}

// Position absolue : XZ de la courbe, Y interpolé entre les hauteurs
// échantillonnées (le micro épouse le relief) plus l'offset de la figure.
export function curveAt(r, anchor, heights, t, out) {
	curveLocal(r, t, out);
	const f = ((t / r.period) % 1 + 1) % 1 * SAMPLES;
	const i = Math.floor(f) % SAMPLES, j = (i + 1) % SAMPLES, a = f - Math.floor(f);
	const y = heights[i] * (1 - a) + heights[j] * a;
	out.x += anchor.x; out.z += anchor.z; out.y += y;
	return out;
}

const _pm = { x: 0, y: 0, z: 0 }, _pp = { x: 0, y: 0, z: 0 };

// Position, vitesse et accélération par différences centrées de pas h.
export function derive(r, anchor, heights, t, h, pos, vel, acc) {
	curveAt(r, anchor, heights, t, pos);
	curveAt(r, anchor, heights, t - h, _pm);
	curveAt(r, anchor, heights, t + h, _pp);
	vel.x = (_pp.x - _pm.x) / (2 * h); vel.y = (_pp.y - _pm.y) / (2 * h); vel.z = (_pp.z - _pm.z) / (2 * h);
	acc.x = (_pp.x - 2 * pos.x + _pm.x) / (h * h);
	acc.y = (_pp.y - 2 * pos.y + _pm.y) / (h * h);
	acc.z = (_pp.z - 2 * pos.z + _pm.z) / (h * h);
}

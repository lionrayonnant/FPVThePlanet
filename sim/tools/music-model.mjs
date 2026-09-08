// Modèle de l'arc musical (issue #122). Logique pure : AUCUNE Web Audio,
// AUCUN DOM, AUCUN `node:`. Importé tel quel par le selftest et, via un bundle
// Vite, par src/music.js. Le rendu vit là-bas.
//
// L'arc tient dans UN scalaire, `intensity` ∈ [0,1] :
//
//   terminal ──MENU──┐
//                    ├─ HACK (0.12, « la musique de la pièce d'à côté »)
//                    │      └─ le rituel duck
//                    ├─ DROP (1.0, en 0.4 s — la décharge)
//                    └─ vol : flightIntensity(télémétrie)
//
// La musique ne nomme jamais le drone. Au HACK la famille est déjà connue du
// code mais l'écran ne la révèle pas : la musique est le premier indice
// sensoriel. « You don't read the drone. You feel it. »

import { rngFrom } from './target-build.mjs';
import { MUSIC_POOLS } from './music-prompts.mjs';

export const MUSIC_SCHEMA_VERSION = 1;
export { MUSIC_POOLS };

const POOL_SET = new Set(MUSIC_POOLS);

// --- intensité --------------------------------------------------------------

// Deux paramètres seulement — un filtre et un gain — pour que la calibration à
// l'oreille reste faisable. Un troisième axe (un shelf, une réverbe) rendrait
// le réglage impossible à tenir dans la tête.
//
// Le filtre porte l'essentiel de l'effet : à k=0 il ne reste que le bas du
// spectre, exactement ce qu'on entend d'une musique à travers une cloison. Le
// gain seul ne donnerait qu'une musique « moins forte », pas « ailleurs ».
export const INTENSITY = {
	cutoffHz: [380, 19000],  // interpolé en log : l'oreille entend les octaves
	gainDb: [-20, 0],        // interpolé en dB, converti en linéaire à la sortie
};

const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/** k ∈ [0,1] → { cutoffHz, gain } ; gain est LINÉAIRE, prêt pour un AudioParam. */
export function intensityParams(k) {
	const t = clamp01(k);
	const [c0, c1] = INTENSITY.cutoffHz;
	const [g0, g1] = INTENSITY.gainDb;
	const cutoffHz = c0 * Math.pow(c1 / c0, t);
	const gainDb = g0 + (g1 - g0) * t;
	return { cutoffHz, gain: Math.pow(10, gainDb / 20) };
}

// Les paliers de l'arc. MENU est au-dessus de HACK : le terminal est un lieu où
// l'on est assis, le hack est une écoute volée.
export const PHASE_INTENSITY = {
	MENU: 0.55,
	// Relevé de 0,12 à 0,28 (retour terrain, 2026-09-06) : à 0,12 le hack et le
	// rituel du Control Vector qui le duck encore ne s'entendaient plus du
	// tout — « la pièce d'à côté » avait fini porte fermée. À 0,28 la coupure
	// (voir intensityParams) reste sous 1,2 kHz, donc toujours filtrée et
	// nettement en retrait du MENU : la musique reste ailleurs, mais on sait
	// qu'elle joue.
	HACK: 0.28,
	DROP: 1.0,
	// Le vol ne descend JAMAIS en dessous. Relevé de 0,30 à 0,62 après écoute :
	// en FPV on coupe les gaz sans arrêt — punch, chop, dive, coast — et à 0,30
	// la musique tombait à -14 dB derrière une coupure à 1,2 kHz, c'est-à-dire
	// qu'elle disparaissait à chaque geste normal de pilotage.
	//
	// Le plancher n'annule pas l'arc, il le déplace : de 0,62 à 1,0 la coupure
	// va encore de 4,1 à 19 kHz et le gain de -7,6 à 0 dB. Ce qui change, c'est
	// que le bas de la plage est désormais « la musique respire » et non « la
	// musique s'en va ».
	FLOOR: 0.62,
};

// Durées de transition, en millisecondes.
export const FADE = {
	menuToHack: 1500,  // le morceau de menu s'efface pendant que celui du drone entre
	drop: 400,         // la décharge : court, mais pas un clic
	kill: 30,          // le crash : coupe nette, juste assez longue pour ne pas claquer
};

// Le rituel a sa propre partition synthétisée (Bible §36) et c'est elle qui doit
// culminer, pas la musique.
// Relevé de 0,25 à 0,55 avec HACK (2026-09-06) : le duck du rituel s'empilait
// sur un HACK déjà très sourd (-17,6 dB × 0,25 ≈ -30 dB cumulés, en dessous du
// bruit de fond d'un casque). Le rituel doit toujours dominer sa propre
// partition synthétisée, pas disparaître dans le silence : 0,55 laisse le
// hack reculer nettement (-5 dB de plus) sans l'éteindre.
export const DUCK = { ritual: 0.55, ms: 250 };

// NON CALIBRÉ. Ces trois valeurs sont un point de départ raisonné, PAS une
// mesure, et le dépôt exige que les seuils soient mesurés.
//
// Ce qui a été tenté et pourquoi ça a échoué : un vol scripté en boucle ouverte
// (manches figés par window.__sim.setInput) ne produit pas des vitesses
// représentatives — sans boucle de pilotage le drone tombe ou dérive, et le
// relevé obtenu (k entre 0,62 et 0,96 sur 450 frames) mesurait la chute libre,
// pas le vol. Calibrer là-dessus aurait été pire que de ne pas calibrer.
//
// À FAIRE, manche en main, pendant la séance d'écoute (même session, même
// critère d'acceptation). Coller dans la console pendant un vol normal :
//
//   const s=[]; const t=setInterval(()=>{const v=__sim.physics.velocity;
//     s.push([+Math.hypot(v.x,v.y,v.z).toFixed(1), +__sim.music.intensity.toFixed(2)]);},100);
//   // ... voler 60 s : stationnaire, cruise, rush, virages, proximité ...
//   clearInterval(t); console.log(JSON.stringify(s));
//
// Puis fixer speedRefMs pour que k passe réellement du plancher au plein sur la
// plage de vitesses effectivement pilotées — ni collé à FLOOR, ni saturé à 1.
export const FLIGHT = {
	speedRefMs: 25,      // vitesse au-delà de laquelle la vitesse ne pousse plus
	// Le poids du manche est passé de 0,40 à 0,25, celui de la vitesse de 0,60
	// à 0,75. Raison mesurée : le manche est NERVEUX, la vitesse a de
	// l'inertie. À 0,40, couper les gaz retirait 0,28 d'intensité d'un seul
	// coup, alors que le drone continue de filer — la musique plongeait sur un
	// geste qui ne change rien à ce que le pilote ressent.
	wThrottle: 0.25,     // ce que le joueur FAIT
	wSpeed: 0.75,        // ce que le joueur SUBIT — c'est ça qu'on ressent
};

// Lissage ASYMÉTRIQUE de l'intensité, en secondes. Monter vite, redescendre
// lentement : c'est le second remède aux coupures de gaz, et le plus important.
//
// Une coupure dure une demi-seconde ; une vraie accalmie dure dix secondes. Avec
// une constante unique, les deux se ressemblent. Avec une descente lente, le
// chop ne descend presque pas — la musique n'a pas le temps — tandis qu'un vol
// qui se calme vraiment finit par redescendre. C'est le principe d'un détecteur
// d'enveloppe, et il encode musicalement la différence entre un geste et une
// intention.
export const INTENSITY_TAU = {
	rise: 0.25,
	fall: 1.80,
};

/**
 * Télémétrie → intensité. Pure, sans état et sans dt : le lissage est fait par
 * src/music.js avec setTargetAtTime, donc indépendant du frame rate.
 * Désarmé, on retombe au plancher : la musique attend avec le joueur.
 */
export function flightIntensity({ throttle = 0, speedMs = 0, armed = true } = {}) {
	if (!armed) return PHASE_INTENSITY.FLOOR;
	const thr = clamp01(throttle);
	const spd = clamp01(Math.max(0, Number.isFinite(speedMs) ? speedMs : 0) / FLIGHT.speedRefMs);
	const drive = clamp01(FLIGHT.wThrottle * thr + FLIGHT.wSpeed * spd);
	return PHASE_INTENSITY.FLOOR + (1 - PHASE_INTENSITY.FLOOR) * drive;
}

// --- sélection --------------------------------------------------------------

// Combien de morceaux récemment joués sont exclus du tirage. Assez pour qu'une
// soirée ne répète pas, assez peu pour ne pas vider un pool de 10.
export const RECENT_LIMIT = 12;

/**
 * Tire un morceau. Pur et déterministe : la même (pool, seed) rend toujours le
 * même morceau à `recent` égal — donc reprendre une session, c'est reprendre ce
 * drone ET sa musique.
 *
 * `recent` (ids des derniers joués) est écarté tant qu'il reste du choix ; s'il
 * couvre tout le pool on rejoue plutôt que de rendre le silence.
 *
 * @returns {object|null} l'entrée du manifeste, ou null si le pool est vide.
 */
export function pickTrack(manifest, pool, seed, recent = []) {
	const all = (manifest?.tracks ?? []).filter((t) => t.pool === pool);
	if (!all.length) return null;

	const excluded = new Set(recent);
	const fresh = all.filter((t) => !excluded.has(t.id));
	const from = fresh.length ? fresh : all;

	const rand = rngFrom(`${seed}::track::${pool}`);
	return from[Math.floor(rand() * from.length)];
}

/** Met à jour la liste des derniers joués, plus récent en tête, bornée. */
export function pushRecent(recent, id) {
	if (!id) return recent.slice(0, RECENT_LIMIT);
	return [id, ...recent.filter((x) => x !== id)].slice(0, RECENT_LIMIT);
}

// --- manifeste --------------------------------------------------------------

const REQUIRED = ['id', 'pool', 'file', 'durS', 'bpm'];

/**
 * Valide public/music.json. Rend la liste des problèmes ; vide = valide.
 * Appelé par le selftest et par music-review avant écriture : un manifeste
 * cassé rendrait le jeu muet sans rien dire.
 */
export function validateManifest(json) {
	const problems = [];
	if (!json || typeof json !== 'object') return ['manifeste absent ou non-objet'];
	if (json.schemaVersion !== MUSIC_SCHEMA_VERSION) {
		problems.push(`schemaVersion attendu ${MUSIC_SCHEMA_VERSION}, reçu ${json.schemaVersion}`);
	}
	if (!Array.isArray(json.tracks)) return [...problems, 'tracks n\'est pas un tableau'];

	const ids = new Set();
	const files = new Set();
	for (const [i, t] of json.tracks.entries()) {
		const where = `tracks[${i}]`;
		for (const key of REQUIRED) {
			if (t?.[key] === undefined || t[key] === null) problems.push(`${where} : ${key} manquant`);
		}
		if (t?.pool !== undefined && !POOL_SET.has(t.pool)) problems.push(`${where} : pool inconnu « ${t.pool} »`);
		if (typeof t?.durS === 'number' && !(t.durS > 0)) problems.push(`${where} : durS doit être > 0`);
		if (t?.id !== undefined) {
			if (ids.has(t.id)) problems.push(`${where} : id dupliqué « ${t.id} »`);
			ids.add(t.id);
		}
		if (t?.file !== undefined) {
			if (files.has(t.file)) problems.push(`${where} : file dupliqué « ${t.file} »`);
			files.add(t.file);
		}
	}
	return problems;
}

/** Le pool d'un drone. La famille EST le pool : pas de table de correspondance. */
export function poolForFamily(family) {
	return POOL_SET.has(family) && family !== 'menu' ? family : null;
}

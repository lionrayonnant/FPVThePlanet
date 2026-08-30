// Modèle de l'acoustique du lieu (issue #122, audio spatial). Logique pure :
// AUCUNE Web Audio, AUCUN DOM, AUCUN `node:`. Le rendu vit dans src/space.js.
//
// Ce qu'on cherche, et ce qu'on ne cherche PAS.
//
// En FPV le drone EST la caméra : les moteurs sont solidaires de la tête, à la
// même place à chaque instant. Les spatialiser en binaural ne dirait donc rien
// — un HRTF sur une source immobile par rapport à l'auditeur est un HRTF qui ne
// bouge jamais. Ce qui change quand on vole, c'est ce que le MONDE RENVOIE :
// le mur qu'on rase claque, le pont qu'on passe dessous se referme, la montée
// ouvre le ciel et tout s'assèche. C'est ça, la sensation de proximité, et
// c'est le cœur du FPV.
//
// D'où : pas de panner, mais une acoustique — retard, quantité et couleur des
// réflexions, pilotés par la géométrie réelle.
//
// La grandeur qui porte tout est le PRÉ-DELAY. Le temps d'aller-retour du son
// jusqu'à la surface la plus proche est une mesure physique, pas un réglage :
//
//     à  1 m d'un mur →   6 ms      (une claque, collée au son direct)
//     à  5 m          →  29 ms
//     à 20 m          → 117 ms      (un écho franc, détaché)
//
// C'est cet écart-là qu'on entend en rasant une façade, bien plus que « il y a
// plus de réverbe ». Un réglage de wet seul ne le rendrait jamais.

// Vitesse du son dans l'air à 15 °C, en m/s. Non négociable : c'est elle qui
// fait du pré-delay une mesure et non un goût.
export const SPEED_OF_SOUND = 340;

// Reprises de src/wind.js : la rosace de sondage est partagée, donc ses bornes
// aussi. Les huit rayons horizontaux portent à 30 m, ce qui est l'échelle FPV
// (« on sent un immeuble quand on est à un pâté de maisons »).
export const PROBE_H_COUNT = 8;
export const PROBE_UP = 8;
export const PROBE_DOWN = 9;
export const PROBE_H_RANGE = 30;
export const PROBE_UP_RANGE = 30;

export const REVERB = {
	// Bornes du pré-delay. Le plancher n'est pas nul : à moins d'un mètre, une
	// réflexion arrive dans la même milliseconde que le son direct et se lit
	// comme un filtrage en peigne, pas comme un lieu.
	preDelayS: [0.004, 0.140],
	// Quantité de réflexions. Ciel ouvert n'est pas zéro — il reste le sol.
	wet: [0.06, 0.62],
	// Amortissement des réflexions. Une surface proche renvoie brillant, un
	// grand volume mange les aigus au fil des rebonds.
	dampHz: [1400, 7000],
	// Durée de la queue. Suit la TAILLE du lieu, pas son degré de fermeture :
	// une cathédrale ouverte résonne plus longtemps qu'un placard fermé.
	decayS: [0.18, 2.2],
	// Au-delà, on considère qu'il n'y a plus de lieu du tout.
	openM: 30,
};

const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

// Interpolation BORNÉE à ses extrémités. Le bornage n'est pas superflu : en
// virgule flottante, lerp(0.06, 0.62, 1) rend 0.6200000000000001, et un
// AudioParam qui reçoit une valeur juste au-dessus de sa borne annoncée est
// exactement le genre de dépassement qui ne se voit qu'une fois en production.
const lerp = (a, b, t) => {
	const v = a + (b - a) * clamp01(t);
	const lo = Math.min(a, b), hi = Math.max(a, b);
	return v < lo ? lo : v > hi ? hi : v;
};

/**
 * Rosace de sondage → description acoustique du lieu.
 *
 * `probe` est le Float32Array de PROBE_COUNT distances que physics.probeWind()
 * a DÉJÀ lancées pour le vent, une fois par pas de physique. On les relit, on
 * n'en lance aucune : l'acoustique du lieu ne coûte pas un rayon de plus.
 *
 * Le rayon du bas est traité à part. Il porte à 400 m et sert d'altimètre au
 * modèle de vent ; le compter comme une paroi ferait d'un vol à 200 m au-dessus
 * d'un champ un endroit « fermé vers le bas ».
 */
export function acoustics(probe) {
	if (!probe || probe.length < PROBE_DOWN + 1) {
		return { nearestM: REVERB.openM, meanM: REVERB.openM, enclosure: 0, heightM: REVERB.openM };
	}

	let nearest = REVERB.openM;
	let sum = 0;
	for (let i = 0; i < PROBE_H_COUNT; i++) {
		const d = Number.isFinite(probe[i]) ? Math.min(probe[i], PROBE_H_RANGE) : PROBE_H_RANGE;
		if (d < nearest) nearest = d;
		sum += d;
	}

	// Le plafond compte comme une paroi — passer sous un pont doit s'entendre.
	const up = Number.isFinite(probe[PROBE_UP]) ? Math.min(probe[PROBE_UP], PROBE_UP_RANGE) : PROBE_UP_RANGE;
	if (up < nearest) nearest = up;

	// Le sol est toujours là, mais sa distance est bornée : au-delà de la
	// portée horizontale il ne renvoie plus rien d'utile à cette échelle.
	const heightM = Number.isFinite(probe[PROBE_DOWN]) ? probe[PROBE_DOWN] : REVERB.openM;
	const ground = Math.min(Math.max(heightM, 0), REVERB.openM);
	if (ground < nearest) nearest = ground;

	// Fermeture : moyenne des huit rayons horizontaux plus le plafond,
	// normalisée et inversée. 0 = plein ciel, 1 = boîte.
	const meanM = (sum + up) / (PROBE_H_COUNT + 1);
	const enclosure = clamp01(1 - meanM / REVERB.openM);

	return { nearestM: Math.max(nearest, 0.15), meanM, enclosure, heightM };
}

/**
 * Description du lieu → réglages de la réverbération. Pur, borné, sans état :
 * le lissage temporel est fait par src/space.js avec setTargetAtTime, donc
 * indépendant du frame rate.
 */
export function reverbParams({ nearestM = REVERB.openM, meanM = REVERB.openM, enclosure = 0 } = {}) {
	const near = Number.isFinite(nearestM) ? Math.max(nearestM, 0.15) : REVERB.openM;

	// LA mesure : aller-retour jusqu'à la surface la plus proche.
	const preDelayS = Math.min(
		Math.max((2 * near) / SPEED_OF_SOUND, REVERB.preDelayS[0]),
		REVERB.preDelayS[1],
	);

	const e = clamp01(enclosure);
	const wet = lerp(REVERB.wet[0], REVERB.wet[1], e);

	// Amortissement : proche et dur = brillant, vaste = sourd. On prend la
	// distance MOYENNE et pas la plus proche, parce que la couleur de la queue
	// vient du volume entier, pas de la paroi la plus près.
	const openness = clamp01((Number.isFinite(meanM) ? meanM : REVERB.openM) / REVERB.openM);
	const dampHz = lerp(REVERB.dampHz[1], REVERB.dampHz[0], openness);

	// Durée : suit la taille du lieu. Un vol en plein ciel garde une queue
	// courte parce qu'il n'y a rien pour la soutenir.
	const decayS = lerp(REVERB.decayS[0], REVERB.decayS[1], e * (0.35 + 0.65 * openness));

	return { preDelayS, wet, dampHz, decayS };
}

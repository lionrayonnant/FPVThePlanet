// Modèle du langage sonore d'interface (PHASE 18, Bible §34-36). Logique pure :
// AUCUNE Web Audio, AUCUN DOM, AUCUN `node:`. Importé tel quel par le selftest
// et, via un bundle Vite, par src/ui-audio.js. Le rendu vit là-bas.
//
// Règle de la phase, et raison d'être de ce fichier :
//   An event that doesn't need to be heard doesn't need a sound.

// Le vocabulaire est CLOS. Ces sept entrées sont tout ce que l'interface a le
// droit de faire entendre. Il n'y a pas de son de clic, de survol, de
// navigation, d'ouverture d'écran, de sélection ni de validation — c'est la
// forme exécutable de « le système ne bipe pas à chaque clic » (Bible §34), et
// tools/ui-audio-selftest.mjs balaie src/ pour le faire respecter.
export const UI_EVENTS = [
	'BOOT',            // SYSTEM — la signature de démarrage, une fois par chargement
	'TERRAIN_READY',   // SYSTEM — la scène est chargée et jouable
	'TARGET_FOUND',    // SYSTEM — une cible est confirmée au TARGET SCAN
	'ERROR',           // SYSTEM — accusé de réception d'une erreur, jamais une punition
	'LINK_LOST',       // LINK
	'LINK_RESTORED',   // LINK
	'RITUAL',          // RITUAL — la culmination, cf. scoreFor()
];

export const UI_FAMILY = {
	BOOT: 'SYSTEM',
	TERRAIN_READY: 'SYSTEM',
	TARGET_FOUND: 'SYSTEM',
	ERROR: 'SYSTEM',
	LINK_LOST: 'LINK',
	LINK_RESTORED: 'LINK',
	RITUAL: 'RITUAL',
};

// --- signature de boot ------------------------------------------------------

// `tututuuut tuuuuu-tuu` (Bible §35). Les hauteurs ne sont pas inventées : un
// ESC fait chanter la bobine du moteur en la commutant, et la séquence de
// démarrage classique est un triolet ascendant do-mi-sol puis une
// confirmation. Ce qui porte l'identité est le RYTHME — court, court, tenu ·
// tenu, court — plus encore que les hauteurs.
//
// Jouée UNIQUEMENT au boot FPVTP!, une fois par chargement de page. Ni à
// l'entrée en vol, ni au respawn : « pas comme motif omniprésent », et « le
// crash n'en reprend pas le motif ». À l'entry state le drone est déjà en
// l'air, il n'y a aucun armement à sonoriser.
export const BOOT_SIGNATURE = [
	{ atMs: 0, freq: 1046.50, durS: 0.070 },   // tu
	{ atMs: 110, freq: 1318.51, durS: 0.070 },   // tu
	{ atMs: 220, freq: 1567.98, durS: 0.220 },   // tuuut
	// 180 ms de silence : le seul vrai blanc du motif
	{ atMs: 620, freq: 1318.51, durS: 0.320 },   // tuuuuu
	{ atMs: 980, freq: 1046.50, durS: 0.110 },   // tuu
];

// --- hystérésis du lien -----------------------------------------------------

// Les deux seuils ne sont pas choisis ici : ils sont REPRIS de src/link.js, qui
// les a déjà calibrés pour ce problème exact. LINK_LOST_AT est son BLACKOUT_Q
// (l'écran est effectivement mort) et LINK_BACK_AT son COOLDOWN_FLOOR_Q, dégagé
// de FREEZE_LEAVE (0,28) — donc l'image ne peut plus geler au moment où on
// annonce le retour. L'annonce encadre la panne visible au lieu de la doubler.
export const LINK_LOST_AT = 0.10;
export const LINK_BACK_AT = 0.30;

// Temps de garde entre deux annonces. L'hystérésis seule ne suffit pas : une
// traversée franche et répétée de TOUTE la bande — ce qui arrive en slalomant
// entre deux immeubles — passerait les deux seuils à chaque aller-retour et
// deviendrait une mitraillette.
export const LINK_MIN_GAP_S = 3.0;

export function newLinkState() {
	return { lost: false, sinceS: LINK_MIN_GAP_S };
}

// Mute `state` et rend l'annonce à jouer, ou null. Aucune variable de module :
// deux exécutions de la même trace donnent la même chose, ce qui rend le
// selftest rejouable.
export function linkEvent(quality, dtS, state) {
	state.sinceS += dtS;
	if (state.sinceS < LINK_MIN_GAP_S) return null;
	if (!state.lost && quality < LINK_LOST_AT) {
		state.lost = true;
		state.sinceS = 0;
		return 'LINK_LOST';
	}
	if (state.lost && quality > LINK_BACK_AT) {
		state.lost = false;
		state.sinceS = 0;
		return 'LINK_RESTORED';
	}
	return null;
}

// --- partitions de rituel (Bible §36) ---------------------------------------

// Les voix. Vocabulaire DÉCORATIF : ce sont des enveloppes et des fréquences,
// rien qui encode une procédure — même règle de sécurité qu'en PHASE 09/10.
// `blast` est le souffle large bande de l'explosion finale : là où `impact`
// est un grave qui frappe, `blast` est le bruit qui l'accompagne — les deux
// couches de la même détonation (Bible §36).
export const VOICES = ['click', 'pulse', 'bass', 'glitch', 'sweep', 'stab', 'impact', 'tone', 'blast'];

// Les voix dont l'enveloppe est fixée par le rendu et non par la partition : un
// click dure ce que dure un click, à V1 comme à V4. Les autres s'étirent avec
// la variante, ce qui fait qu'un V4 respire au lieu d'être un V1 clairsemé.
export const PERCUSSIVE = ['click', 'glitch', 'stab'];

// Six séquences écrites à la main, une par famille — pas une grammaire
// pondérée. Les identités reprennent le vocabulaire visuel déjà en place dans
// src/hack-grammars.js, pour qu'une famille se reconnaisse à l'œil et à
// l'oreille de la même manière.
//
// `at` et `dur` sont en unités NORMALISÉES 0..1 : c'est ce qui évite d'écrire
// vingt-quatre partitions. scoreFor() les met à l'échelle de la variante.
// Aucune n'est une chanson : pas de mesure régulière, pas de tonalité, pas de
// boucle.
//
// La seconde moitié de chaque partition est la même anatomie pour les six
// familles — montée qui s'accélère (deux `sweep`), détonation en couches
// (`impact` grave + `blast` large bande, simultanés), puis des « shrapnels »
// (`click`/`glitch`, au choix de la famille pour garder son timbre) qui
// partent APRÈS l'impact avec un `pan` (-1..1) qui couvre tout le champ
// stéréo : l'explosion « part dans tous les sens » (issue #107). La première
// moitié, elle, reste l'identité de famille écrite en PHASE 18 — inchangée.
export const RITUAL_SCORES = {
	// paquets — rafales de clicks staccato, groupées irrégulièrement
	'COMMAND INJECTION': [
		{ at: 0.00, voice: 'click', freq: 4200 },
		{ at: 0.03, voice: 'click', freq: 3800 },
		{ at: 0.06, voice: 'click', freq: 4400 },
		{ at: 0.16, voice: 'click', freq: 3600 },
		{ at: 0.19, voice: 'click', freq: 4100 },
		{ at: 0.28, voice: 'click', freq: 4600 },
		{ at: 0.31, voice: 'click', freq: 3900 },
		{ at: 0.34, voice: 'click', freq: 4300 },
		{ at: 0.37, voice: 'click', freq: 4000 },
		{ at: 0.50, voice: 'pulse', freq: 90, dur: 0.10 },
		{ at: 0.58, voice: 'click', freq: 4500 },
		{ at: 0.61, voice: 'click', freq: 4200 },
		{ at: 0.64, voice: 'click', freq: 3700 },
		{ at: 0.74, voice: 'stab', freq: 1400 },
		{ at: 0.78, voice: 'sweep', freq: 220, to: 1800, dur: 0.09 },
		{ at: 0.85, voice: 'sweep', freq: 900, to: 3200, dur: 0.05 },
		{ at: 0.90, voice: 'impact', freq: 50, dur: 0.09, gain: 1.3 },
		{ at: 0.90, voice: 'blast', freq: 1600, dur: 0.16 },
		{ at: 0.92, voice: 'click', freq: 4700, pan: -0.9 },
		{ at: 0.95, voice: 'click', freq: 4300, pan: 0.8 },
		{ at: 0.97, voice: 'click', freq: 3900, pan: -0.5 },
		{ at: 0.99, voice: 'click', freq: 4500, pan: 0.6 },
	],
	// porteuse — un ton qu'on plie, puis qu'on capture
	'LINK HIJACK': [
		{ at: 0.00, voice: 'tone', freq: 880, dur: 0.30 },
		{ at: 0.22, voice: 'bass', freq: 55, dur: 0.40 },
		{ at: 0.34, voice: 'tone', freq: 880, to: 660, dur: 0.28 },
		{ at: 0.50, voice: 'glitch', freq: 1200 },
		{ at: 0.56, voice: 'tone', freq: 660, to: 1320, dur: 0.22 },
		{ at: 0.70, voice: 'pulse', freq: 70, dur: 0.09 },
		{ at: 0.78, voice: 'sweep', freq: 300, to: 2200, dur: 0.10 },
		{ at: 0.85, voice: 'sweep', freq: 1000, to: 3400, dur: 0.05 },
		{ at: 0.90, voice: 'impact', freq: 46, dur: 0.09, gain: 1.3 },
		{ at: 0.90, voice: 'blast', freq: 1400, dur: 0.16 },
		{ at: 0.92, voice: 'glitch', freq: 2000, pan: -0.8 },
		{ at: 0.95, voice: 'click', freq: 4200, pan: 0.7 },
		{ at: 0.97, voice: 'glitch', freq: 1600, pan: -0.4 },
		{ at: 0.99, voice: 'click', freq: 3800, pan: 0.9 },
	],
	// oscilloscope — pulses modulés, wobble de filtre
	'TELEMETRY SPOOF': [
		{ at: 0.00, voice: 'pulse', freq: 120, dur: 0.09 },
		{ at: 0.10, voice: 'pulse', freq: 105, dur: 0.09 },
		{ at: 0.20, voice: 'pulse', freq: 135, dur: 0.09 },
		{ at: 0.30, voice: 'bass', freq: 62, dur: 0.26 },
		{ at: 0.38, voice: 'pulse', freq: 95, dur: 0.07 },
		{ at: 0.46, voice: 'pulse', freq: 150, dur: 0.07 },
		{ at: 0.55, voice: 'glitch', freq: 900 },
		{ at: 0.62, voice: 'pulse', freq: 110, dur: 0.06 },
		{ at: 0.68, voice: 'pulse', freq: 175, dur: 0.06 },
		{ at: 0.78, voice: 'sweep', freq: 260, to: 1600, dur: 0.10 },
		{ at: 0.85, voice: 'sweep', freq: 950, to: 3000, dur: 0.05 },
		{ at: 0.90, voice: 'impact', freq: 49, dur: 0.09, gain: 1.3 },
		{ at: 0.90, voice: 'blast', freq: 1500, dur: 0.16 },
		{ at: 0.92, voice: 'click', freq: 4400, pan: 0.85 },
		{ at: 0.94, voice: 'glitch', freq: 1100, pan: -0.7 },
		{ at: 0.96, voice: 'click', freq: 3600, pan: 0.5 },
		{ at: 0.99, voice: 'glitch', freq: 900, pan: -0.3 },
	],
	// position — paire désaccordée qui dérive, battement qui s'élargit
	'GNSS SPOOF': [
		{ at: 0.00, voice: 'tone', freq: 440, dur: 0.50 },
		{ at: 0.02, voice: 'tone', freq: 443, dur: 0.48 },
		{ at: 0.34, voice: 'tone', freq: 440, dur: 0.40 },
		{ at: 0.36, voice: 'tone', freq: 451, dur: 0.38 },
		{ at: 0.58, voice: 'bass', freq: 48, dur: 0.30 },
		{ at: 0.66, voice: 'tone', freq: 440, dur: 0.26 },
		{ at: 0.68, voice: 'tone', freq: 468, dur: 0.24 },
		{ at: 0.80, voice: 'sweep', freq: 200, to: 1400, dur: 0.10 },
		{ at: 0.87, voice: 'sweep', freq: 850, to: 2800, dur: 0.05 },
		{ at: 0.90, voice: 'impact', freq: 42, dur: 0.09, gain: 1.3 },
		{ at: 0.90, voice: 'blast', freq: 1300, dur: 0.16 },
		{ at: 0.92, voice: 'glitch', freq: 1300, pan: 0.9 },
		{ at: 0.94, voice: 'click', freq: 4100, pan: -0.6 },
		{ at: 0.97, voice: 'glitch', freq: 900, pan: 0.4 },
		{ at: 0.99, voice: 'click', freq: 3700, pan: -0.85 },
	],
	// nœuds — clicks en cascade, densité croissante
	'NETWORK TAKEOVER': [
		{ at: 0.00, voice: 'click', freq: 2600 },
		{ at: 0.14, voice: 'click', freq: 2900 },
		{ at: 0.18, voice: 'click', freq: 3100 },
		{ at: 0.30, voice: 'click', freq: 3300 },
		{ at: 0.33, voice: 'click', freq: 2800 },
		{ at: 0.36, voice: 'click', freq: 3500 },
		{ at: 0.46, voice: 'pulse', freq: 80, dur: 0.10 },
		{ at: 0.52, voice: 'click', freq: 3700 },
		{ at: 0.54, voice: 'click', freq: 3200 },
		{ at: 0.56, voice: 'click', freq: 3900 },
		{ at: 0.58, voice: 'click', freq: 3400 },
		{ at: 0.60, voice: 'click', freq: 4100 },
		{ at: 0.70, voice: 'bass', freq: 44, dur: 0.30 },
		{ at: 0.78, voice: 'sweep', freq: 180, to: 2000, dur: 0.10 },
		{ at: 0.85, voice: 'sweep', freq: 800, to: 3100, dur: 0.05 },
		{ at: 0.90, voice: 'impact', freq: 38, dur: 0.09, gain: 1.3 },
		{ at: 0.90, voice: 'blast', freq: 1700, dur: 0.16 },
		{ at: 0.92, voice: 'click', freq: 4800, pan: -0.7 },
		{ at: 0.94, voice: 'click', freq: 4400, pan: 0.9 },
		{ at: 0.96, voice: 'click', freq: 4000, pan: -0.4 },
		{ at: 0.99, voice: 'click', freq: 4600, pan: 0.6 },
	],
	// mémoire — blocs glitchés, puis une écriture qui claque
	'FIRMWARE OVERRIDE': [
		{ at: 0.00, voice: 'glitch', freq: 1500 },
		{ at: 0.14, voice: 'glitch', freq: 1100 },
		{ at: 0.24, voice: 'bass', freq: 38, dur: 0.34 },
		{ at: 0.34, voice: 'glitch', freq: 1800 },
		{ at: 0.48, voice: 'glitch', freq: 700 },
		{ at: 0.52, voice: 'glitch', freq: 2100 },
		{ at: 0.62, voice: 'stab', freq: 1900 },
		{ at: 0.70, voice: 'glitch', freq: 1300 },
		{ at: 0.80, voice: 'sweep', freq: 150, to: 2400, dur: 0.09 },
		{ at: 0.87, voice: 'sweep', freq: 750, to: 2900, dur: 0.05 },
		{ at: 0.90, voice: 'impact', freq: 34, dur: 0.09, gain: 1.3 },
		{ at: 0.90, voice: 'blast', freq: 1200, dur: 0.16 },
		{ at: 0.92, voice: 'glitch', freq: 2000, pan: 0.8 },
		{ at: 0.94, voice: 'glitch', freq: 1500, pan: -0.9 },
		{ at: 0.97, voice: 'glitch', freq: 1000, pan: 0.5 },
		{ at: 0.99, voice: 'glitch', freq: 700, pan: -0.6 },
	],
};

// Durée d'enveloppe des voix percussives, en secondes. Fixe : un click ne
// s'étire pas parce que la variante est plus longue.
const PERCUSSIVE_DUR_S = { click: 0.02, glitch: 0.09, stab: 0.14 };

// Met une partition à l'échelle de la variante (V1≈1000 ms … V4≈4000 ms, cf.
// tools/ritual-model.mjs). La variante change la durée et l'étalement, jamais
// la suite de voix — c'est exactement ce que demande la Bible §36.
export function scoreFor(hackType, variantMs) {
	const score = RITUAL_SCORES[hackType];
	if (!score) return [];
	return score.map((ev) => ({
		atMs: ev.at * variantMs,
		durS: PERCUSSIVE.includes(ev.voice)
			? PERCUSSIVE_DUR_S[ev.voice]
			: (ev.dur ?? 0.1) * (variantMs / 1000),
		voice: ev.voice,
		freq: ev.freq,
		to: ev.to,
		gain: ev.gain,
		pan: ev.pan,
	}));
}

// --- tension du rituel (Bible §36 : la saisie doit se sentir monter) -------

// Le mapping vit ici, pas dans le rendu, précisément pour rester testable
// sans Web Audio : le rendu ne fait que lire ces bornes et les interpoler
// linéairement sur k (progression 0..1 de la saisie du vecteur).
export const RITUAL_TENSION = {
	fMin: 220,      // Hz — bande filtrée au repos (k=0)
	fMax: 2600,     // Hz — bord de rupture juste avant la dernière flèche
	rateMin: 2,     // Hz — pulsation lente en début de saisie
	rateMax: 9,     // Hz — pulsation qui s'affole juste avant la complétion
	gain: 0.22,     // niveau plein à k=1 : un riser prépare, il ne doit jamais couvrir la détonation qui suit
	tau: 0.05,      // lissage à la montée : une flèche juste doit se sentir tout de suite
	fallTau: 0.09,  // lissage à la chute : ~270 ms (3τ), audible — pas un mute sec
};

// Pure : les trois paramètres du riser pour une progression k. C'est tout ce
// que le rendu lui demande, et c'est ce qui rend le mapping testable pour sa
// monotonie sans monter le moindre AudioContext.
export function ritualTensionParams(k) {
	const c = Math.min(Math.max(k, 0), 1);
	return {
		freq: RITUAL_TENSION.fMin + (RITUAL_TENSION.fMax - RITUAL_TENSION.fMin) * c,
		rate: RITUAL_TENSION.rateMin + (RITUAL_TENSION.rateMax - RITUAL_TENSION.rateMin) * c,
		gain: RITUAL_TENSION.gain * c,
	};
}

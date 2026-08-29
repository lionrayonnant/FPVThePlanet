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

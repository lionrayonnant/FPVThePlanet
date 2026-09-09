// Modèle du langage sonore d'interface (PHASE 18, Bible §34-36). Logique pure :
// AUCUNE Web Audio, AUCUN DOM, AUCUN `node:`. Importé tel quel par le selftest
// et, via un bundle Vite, par src/ui-audio.js. Le rendu vit là-bas.
//
// Règle de la phase, et raison d'être de ce fichier :
//   An event that doesn't need to be heard doesn't need a sound.

// Le vocabulaire est CLOS. Ces huit entrées sont tout ce que l'interface a le
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
	'INTRO',           // SYSTEM — le cracktro au lancement (issue #106), cf. INTRO_SCORE
];

export const UI_FAMILY = {
	BOOT: 'SYSTEM',
	TERRAIN_READY: 'SYSTEM',
	TARGET_FOUND: 'SYSTEM',
	ERROR: 'SYSTEM',
	LINK_LOST: 'LINK',
	LINK_RESTORED: 'LINK',
	INTRO: 'SYSTEM',
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


// --- tension du rituel (Bible §36 : la saisie doit se sentir monter) -------


// --- partition de l'intro (issue #106) --------------------------------------

// Durée de la partition, en ms : PILE reveal + plasma (tools/intro-model.mjs),
// pour que la dernière note tombe au moment exact où l'écran entre en
// résolution et où BOOT_SIGNATURE prend le relais. Les deux fichiers restent
// indépendants (aucun import croisé) ; intro-selftest.mjs vérifie l'accord.
export const INTRO_SCORE_MS = 5500;

// Arpège chiptune/IDM qui MONTE vers do-mi-sol — les trois premières hauteurs
// de BOOT_SIGNATURE, deux octaves plus bas. L'intro ne joue pas une mélodie
// quelconque qui s'arrête : elle prépare littéralement l'oreille aux hauteurs
// sur lesquelles la signature de boot va conclure, si bien que la coupure se
// sent comme une RÉSOLUTION et non comme un simple cut.
const ARP_NOTES = [261.63, 329.63, 392.00, 523.25]; // C4 E4 G4 C5
const BASS_NOTE = 65.41;                            // C2 — fondamentale tenue en dessous
const STEP_MS = 125;                                // huitième de note, ~120 bpm
const TAIL_MS = 250;                                // réservé à la montée finale (sweep + stab)

// Écrite une fois, sans famille : l'intro ne dépend d'aucun hackType, elle joue
// identiquement à chaque chargement de page.
function buildIntroScore() {
	const score = [];
	const stepsTotal = Math.floor((INTRO_SCORE_MS - TAIL_MS) / STEP_MS);
	for (let i = 0; i < stepsTotal; i++) {
		const atMs = i * STEP_MS;
		// L'arpège, une note par pas : boucle sur do-mi-sol-do.
		score.push({ atMs, voice: 'tone', freq: ARP_NOTES[i % ARP_NOTES.length], durS: 0.09 });
		// La pulsation grave, un pas sur deux : le socle rythmique.
		if (i % 2 === 0) score.push({ atMs, voice: 'bass', freq: BASS_NOTE, durS: 0.10 });
		// Un click décalé tous les 4 pas : la texture IDM, panoramisée pour ne
		// pas rester plate au centre comme le reste du langage sonore d'interface.
		if (i % 4 === 2) {
			score.push({
				atMs: atMs + STEP_MS / 2, voice: 'click', freq: 5200, durS: 0.02,
				pan: (Math.floor(i / 4) % 2 === 0) ? -0.4 : 0.4,
			});
		}
	}
	const sweepAt = stepsTotal * STEP_MS;
	// La montée finale : même grammaire que la détonation des rituels (une
	// paire de sweeps qui s'accélère juste avant l'impact) mais une octave plus
	// calme — ici on prépare une note, pas une explosion. Le sweep vise
	// exactement la première hauteur de BOOT_SIGNATURE (do), le stab tient sa
	// troisième (sol, la note longue du triolet).
	score.push({ atMs: sweepAt, voice: 'sweep', freq: 440, to: BOOT_SIGNATURE[0].freq, durS: 0.18 });
	score.push({ atMs: sweepAt + 90, voice: 'stab', freq: BOOT_SIGNATURE[2].freq, durS: 0.12 });
	return score.sort((a, b) => a.atMs - b.atMs);
}

export const INTRO_SCORE = buildIntroScore();

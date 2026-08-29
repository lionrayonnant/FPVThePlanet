// Helpers purs de l'écran de hack (PHASE 09). Logique pure, AUCUNE dépendance
// DOM/Three — importée par le selftest et, via un bundle Vite, par src/hack.js.
// Le rendu et les motifs animés vivent dans src/hack.js ; ici, uniquement ce
// qui se teste sans navigateur.
import { HACK_TYPES } from './target-model.mjs';

export { HACK_TYPES };

// Verdict de fin de séquence, verbatim Bible §18. Le log automatique = cette
// ligne et rien d'autre après les étapes. AUCUNE commande, aucun paramètre :
// c'est une mise en scène, pas une procédure (spec PHASE 09, règle de sécurité).
export const HACK_OVERRIDE = 'MANUAL OVERRIDE REQUIRED';

// Tête et queue fixes de la séquence automatique (Bible §18).
const HACK_LEAD = { label: 'AUTOMATED BYPASS', verdict: 'OK', dwellMs: 1200 };
const HACK_TAIL = { label: 'CONTROL CHANNEL', verdict: 'READY', dwellMs: 1100 };

// Deux beats par famille. VOCABULAIRE de la grammaire visuelle uniquement
// (paquets, porteuse, oscilloscope, position, nœuds, mémoire) — aucune
// revendication de protocole, aucune étape reproductible. Le selftest vérifie
// que chaque token appartient à une liste blanche d'ambiance.
const HACK_BEATS = {
	'COMMAND INJECTION': [
		{ label: 'PACKET WINDOW', verdict: 'OPEN', dwellMs: 850 },
		{ label: 'SEQUENCE ALIGNED', verdict: 'SET', dwellMs: 850 },
	],
	'LINK HIJACK': [
		{ label: 'CARRIER LOCK', verdict: 'HELD', dwellMs: 850 },
		{ label: 'TIMING SYNC', verdict: 'SET', dwellMs: 850 },
	],
	'TELEMETRY SPOOF': [
		{ label: 'STREAM CAPTURE', verdict: 'LIVE', dwellMs: 850 },
		{ label: 'TRACE SHAPED', verdict: 'SET', dwellMs: 850 },
	],
	'GNSS SPOOF': [
		{ label: 'SOLUTION FORCED', verdict: 'SET', dwellMs: 850 },
		{ label: 'POSITION HELD', verdict: 'HELD', dwellMs: 850 },
	],
	'NETWORK TAKEOVER': [
		{ label: 'ROUTE MAPPED', verdict: 'SET', dwellMs: 850 },
		{ label: 'NODES HELD', verdict: 'HELD', dwellMs: 850 },
	],
	'FIRMWARE OVERRIDE': [
		{ label: 'REGION MAPPED', verdict: 'SET', dwellMs: 850 },
		{ label: 'IMAGE STAGED', verdict: 'SET', dwellMs: 850 },
	],
};

// Liste blanche : tout mot d'un label ou d'un verdict doit en faire partie.
// Garde-fou de sûreté ET garde-fou de dérive — un mot hors liste = échec du
// selftest, à relire avant de l'ajouter ici.
export const HACK_VOCAB = new Set([
	'AUTOMATED', 'BYPASS', 'CONTROL', 'CHANNEL', 'MANUAL', 'OVERRIDE', 'REQUIRED',
	'PACKET', 'WINDOW', 'SEQUENCE', 'ALIGNED', 'CARRIER', 'LOCK', 'TIMING', 'SYNC',
	'STREAM', 'CAPTURE', 'TRACE', 'SHAPED', 'SOLUTION', 'FORCED', 'POSITION', 'HELD',
	'ROUTE', 'MAPPED', 'NODES', 'REGION', 'IMAGE', 'STAGED',
	'OK', 'READY', 'OPEN', 'SET', 'LIVE',
]);

// La séquence scriptée pour un type de hack : tête + 2 beats de famille + queue.
// Un type inconnu ne reçoit que tête + queue.
export function hackSequence(hackType) {
	return [HACK_LEAD, ...(HACK_BEATS[hackType] ?? []), HACK_TAIL];
}

// Durée totale des dwells d'une séquence (hors respirations entre étapes).
export function hackSequenceMs(hackType) {
	return hackSequence(hackType).reduce((s, step) => s + step.dwellMs, 0);
}

export const HACK_STEP_GAP_MS = 180; // respiration entre deux étapes
export const HACK_HOLD_MS = 500;     // battement avant l'état d'attente
export const HACK_LOCK_MS = 600;     // durée de la culmination du motif

// 'gnss-spoof' | 'GNSS_SPOOF' | 'gnss spoof' -> 'GNSS SPOOF' ; sinon null.
// Utilisé par le hook debug ?hack= de main.js.
export function normalizeHackType(input) {
	if (typeof input !== 'string') return null;
	const norm = input.trim().toUpperCase().replace(/[\s_-]+/g, ' ');
	return HACK_TYPES.includes(norm) ? norm : null;
}

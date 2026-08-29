// Helpers purs de l'écran de hack (PHASE 09). Logique pure, AUCUNE dépendance
// DOM/Three — importée par le selftest et, via un bundle Vite, par src/hack.js.
// Le rendu et les motifs animés vivent dans src/hack.js ; ici, uniquement ce
// qui se teste sans navigateur.
import { HACK_TYPES } from './target-model.mjs';

export { HACK_TYPES };

// Log automatique de la phase d'analyse, verbatim Bible §18. Deux lignes fixes,
// une ligne vide, la sommation. AUCUNE commande, aucun paramètre : c'est une
// mise en scène, pas une procédure (spec PHASE 09, règle de sécurité).
export const HACK_LOG_LINES = [
	'AUTOMATED BYPASS ........ OK',
	'CONTROL CHANNEL ......... READY',
	'',
	'MANUAL OVERRIDE REQUIRED',
];

// 'gnss-spoof' | 'GNSS_SPOOF' | 'gnss spoof' -> 'GNSS SPOOF' ; sinon null.
// Utilisé par le hook debug ?hack= de main.js.
export function normalizeHackType(input) {
	if (typeof input !== 'string') return null;
	const norm = input.trim().toUpperCase().replace(/[\s_-]+/g, ' ');
	return HACK_TYPES.includes(norm) ? norm : null;
}

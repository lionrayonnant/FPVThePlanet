// Rappel doux au bord de la fenêtre de streaming rocktree (#168, #170).
// Même forme que pushOf() dans geofence.js (rampe de 0 à A_MAX), mais
// circulaire autour d'un centre qui suit le drone plutôt que rectangulaire
// autour d'une bbox de scène fixe : geofence.js retient une carte pré-cuite
// à ses bords, celui-ci retient le drone à l'intérieur de ce qui est
// réellement chargé en ce moment.
import { A_MAX } from './geofence.js';

// CHOISI, pas mesuré — même statut que HYST_M dans geofence.js et pour la
// même raison : la largeur de rampe la plus sûre dépend de ce que le vol
// réel produit comme dépassement au bord du rayon adaptatif, qu'on ne
// connaît pas encore. À revoir une fois qu'on observe le comportement réel
// en vol.
export const RAMP_M = 20;

export function push(distanceFromCenter, trustedRadius) {
	if (distanceFromCenter <= trustedRadius) return 0;
	if (distanceFromCenter >= trustedRadius + RAMP_M) return A_MAX;
	return A_MAX * (distanceFromCenter - trustedRadius) / RAMP_M;
}

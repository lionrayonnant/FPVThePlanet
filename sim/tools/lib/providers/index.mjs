// Registre des fournisseurs de photogrammétrie (issue #18). Apple Flyover a été
// retiré (2026-09-07) : le jeton et l'outil Go qu'il demandait n'existent plus
// dans ce dépôt. Google Earth reste inscrit et par défaut ; le contrat par
// fournisseur (id/label/attribution/tileDirPath/plan/probe/fetch) tient toujours
// pour un futur fournisseur, mais il n'y en a qu'un aujourd'hui.
import * as googleEarth from './google-earth.mjs';

export const DEFAULT_PROVIDER_ID = 'google-earth';

export const PROVIDERS = { [googleEarth.id]: googleEarth };

export function list() { return Object.values(PROVIDERS); }

export function get(id) {
	const p = PROVIDERS[id];
	if (!p) throw new Error(`fournisseur inconnu : ${id} (connus : ${Object.keys(PROVIDERS).join(', ')})`);
	return p;
}

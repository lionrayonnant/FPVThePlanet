// Registre des fournisseurs de photogrammétrie. L'ordre de priorité de l'issue
// #18 est : Google > Flyover > reality meshes ouverts. Tant que Flyover est seul
// inscrit, il est le défaut.
import * as flyover from './flyover.mjs';

export const DEFAULT_PROVIDER_ID = 'flyover';

export const PROVIDERS = { [flyover.id]: flyover };

export function list() { return Object.values(PROVIDERS); }

export function get(id) {
	const p = PROVIDERS[id];
	if (!p) throw new Error(`fournisseur inconnu : ${id} (connus : ${Object.keys(PROVIDERS).join(', ')})`);
	return p;
}

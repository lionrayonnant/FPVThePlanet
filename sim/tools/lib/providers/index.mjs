// Registre des fournisseurs de photogrammétrie. L'ordre de priorité de l'issue
// #18 est : Google > Flyover > reality meshes ouverts. Les deux premiers sont
// inscrits ; Google est le défaut (design #18, « devient le fournisseur par
// défaut une fois le Stage 3 livré »).
import * as flyover from './flyover.mjs';
import * as googleEarth from './google-earth.mjs';

export const DEFAULT_PROVIDER_ID = 'google-earth';

export const PROVIDERS = { [flyover.id]: flyover, [googleEarth.id]: googleEarth };

export function list() { return Object.values(PROVIDERS); }

export function get(id) {
	const p = PROVIDERS[id];
	if (!p) throw new Error(`fournisseur inconnu : ${id} (connus : ${Object.keys(PROVIDERS).join(', ')})`);
	return p;
}

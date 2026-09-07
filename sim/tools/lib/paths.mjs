// Un seul module résout le répertoire de données en chemins concrets.
//
//   <data>/
//     scenes/<slug>/        ← SCENES_DIR
//     scenes.json           ← SCENES_JSON
//     operator-state/       ← OPERATOR_DIR
//     cache/google-earth/   ← GOOGLE_CACHE_DIR
//
// Sans FPVTP_DATA_DIR, ce sont EXACTEMENT les chemins du dépôt en dev
// (public/scenes, public/scenes.json, operator-state/, .cache/) : `npm run dev`
// ne change pas de comportement.
//
// La variable est lue à l'import, et les modules qui en dérivent leurs
// constantes (add-map-core, providers/google-earth, server/api) le font à leur
// propre chargement : qui veut changer de répertoire doit poser la variable
// AVANT le premier import de l'un d'eux. C'est ce que fait server/index.mjs, et
// c'est déjà le contrat de FPV_OPERATOR_DIR dans les selftests.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

// tools/lib/paths.mjs est deux dossiers sous sim/ : trois dirname() pour
// remonter (un pour le nom de fichier, deux pour les dossiers).
export const SIM_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

export function resolvePaths(dataDir) {
	const root = dataDir ? path.resolve(dataDir) : null;
	return {
		DATA_DIR: root ?? SIM_ROOT,
		SCENES_DIR: root ? path.join(root, 'scenes') : path.join(SIM_ROOT, 'public/scenes'),
		SCENES_JSON: root ? path.join(root, 'scenes.json') : path.join(SIM_ROOT, 'public/scenes.json'),
		// FPV_OPERATOR_DIR ne redirige que l'état opérateur, jamais les scènes :
		// les selftests s'en servent pour sandboxer leurs écritures sans avoir à
		// recopier un terrain.
		OPERATOR_DIR: process.env.FPV_OPERATOR_DIR
			? path.resolve(process.env.FPV_OPERATOR_DIR)
			: (root ? path.join(root, 'operator-state') : path.join(SIM_ROOT, 'operator-state')),
		GOOGLE_CACHE_DIR: root ? path.join(root, 'cache/google-earth') : path.join(SIM_ROOT, '.cache/google-earth'),
	};
}

export const paths = resolvePaths(process.env.FPVTP_DATA_DIR);

export const { DATA_DIR, SCENES_DIR, SCENES_JSON, OPERATOR_DIR, GOOGLE_CACHE_DIR } = paths;

// Assemblage du contexte de dialogue (PHASE 21). Ce module pré-extrait les
// valeurs de l'état vivant ; le formatage scalaire appartient à la table des
// slots de catalog.mjs. Seule exception : ce que le modèle météo est seul à
// savoir phraser (headline, visibilité) est déjà mis en mots ici, parce que
// catalog.mjs n'a pas accès à cette logique. Règle commune aux deux cas : ce
// qui n'est pas connu vaut `null`, ce qui rend simplement inéligibles les
// entrées qui en dépendaient. Un contexte pauvre appauvrit la conversation,
// il ne la casse pas.
import { today, headline, formatVisibility } from '../tools/lib/weather.mjs';
import { PROFILES } from './drone-profiles.js';
import { getOperator } from './operator.js';

// Même lecture que src/bootstrap.js:35. Silencieuse : sur un navigateur qui
// masque l'extension, on n'a pas de GPU, et c'est tout.
let machine = null;
export function machineContext() {
	if (machine) return machine;
	let gpu = null;
	try {
		const gl = document.createElement('canvas').getContext('webgl');
		const ext = gl?.getExtension('WEBGL_debug_renderer_info');
		gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
	} catch { gpu = null; }
	const display = typeof window !== 'undefined' && window.screen
		? `${window.screen.width} × ${window.screen.height}` : null;
	machine = { gpu, display };
	return machine;
}

export function weatherContext(snapshot) {
	const day = today(snapshot);
	if (!day) return {};
	return {
		summary: headline(day),
		windMs: day.windSpeed,
		// Pas de pluie -> null : les répliques sur la pluie ne sortent que
		// quand il pleut vraiment. C'est le mécanisme d'éligibilité qui fait
		// le travail d'un `if`, sans qu'aucune entrée n'ait à le savoir.
		rain: day.rateMmH >= 0.05 ? `${day.rateMmH.toFixed(1)} mm/h` : null,
		visibility: formatVisibility(day.visibilityM),
	};
}

export function targetContext(candidate, hackType = null) {
	// hackType ne dépend pas de candidate : hack.js:62 monte TARGET_ANALYSIS
	// avec candidate: null (aucun candidat n'est disponible à cet écran) mais
	// un hackType réel. Si on retournait {} ici, {hack_type} ne résoudrait
	// jamais dans le seul événement qui l'utilise — voir issue #58 finding 2.
	if (!candidate) return { hackType };
	return {
		video: candidate.mode && candidate.mode !== 'UNKNOWN' ? candidate.mode : null,
		rssiDbm: candidate.rssiDbm ?? null,
		hackType,
	};
}

export function droneContext(family) {
	const p = PROFILES[family];
	return p ? { label: p.label } : {};
}

const operatorContext = () => {
	const op = getOperator();
	return op ? { name: op.name } : {};
};

export function acquisitionContext({ name, tiles, pipeline } = {}) {
	// Vérifié dans tools/map-api-plugin.mjs (émetteur de l'évènement SSE `stat`,
	// ensemble ACCUMULATED) et tools/scanner-model.mjs (pipelineStats, qui
	// affiche déjà les trois) : `pipeline` ne porte pas de total nommé `bytes`,
	// mais chunkBytes et textureBytes sont des compteurs accumulés et
	// collisionBytes une valeur ponctuelle valide — leur somme EST le total.
	// Avant le premier évènement `stat`, aucun des trois n'existe encore : ici
	// seulement, `null`, comme `tiles` juste au-dessus.
	const b = pipeline ?? {};
	const hasBytes = b.chunkBytes != null || b.textureBytes != null || b.collisionBytes != null;
	const totalBytes = (b.chunkBytes ?? 0) + (b.textureBytes ?? 0) + (b.collisionBytes ?? 0);
	return {
		operator: operatorContext(),
		machine: machineContext(),
		area: { name: name ?? null },
		terrain: {
			tiles: Number.isFinite(tiles) && tiles > 0 ? tiles : null,
			megabytes: hasBytes ? totalBytes / 1e6 : null,
		},
	};
}

// Fin de session : POST-FLIGHT (SESSION_COMPLETE) et LAST SESSION (CRASH).
// Ni météo ni cible : au moment où ces deux écrans parlent, la première n'est
// plus vraie et la seconde n'existe plus. Ce qui n'est pas connu vaut `null`,
// et les entrées qui en dépendaient deviennent simplement inéligibles.
export function sessionContext({ area, family } = {}) {
	return {
		operator: operatorContext(),
		machine: machineContext(),
		area: { name: area ?? null },
		drone: droneContext(family),
	};
}

export function scanContext({ scan, weather, candidate, hackType, family } = {}) {
	return {
		operator: operatorContext(),
		machine: machineContext(),
		weather: weatherContext(weather),
		scan: { count: scan?.candidates?.length ?? null },
		target: targetContext(candidate, hackType),
		drone: droneContext(family),
	};
}

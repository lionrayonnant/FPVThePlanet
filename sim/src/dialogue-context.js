// Assemblage du contexte de dialogue (PHASE 21). Ce module ne FORMATE rien —
// le formatage appartient à la table des slots de catalog.mjs. Il ne fait que
// pré-extraire les valeurs de l'état vivant, avec une règle : ce qui n'est pas
// connu vaut `null`, ce qui rend simplement inéligibles les entrées qui en
// dépendaient. Un contexte pauvre appauvrit la conversation, il ne la casse pas.
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
	if (!candidate) return {};
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
	return {
		operator: operatorContext(),
		machine: machineContext(),
		area: { name: name ?? null },
		terrain: {
			tiles: Number.isFinite(tiles) && tiles > 0 ? tiles : null,
			// Vérifié dans tools/map-api-plugin.mjs (émetteur de l'évènement SSE
			// `stat`) et tools/scanner-model.mjs (consommateur) : `pipeline` ne
			// porte jamais de total en octets, seulement des compteurs séparés
			// (chunkBytes, textureBytes, collisionBytes). Aucun total fiable à
			// additionner ici sans deviner — donc `null`, ce qui rend {terrain_mb}
			// simplement inéligible. C'est un comportement correct, pas un manque.
			megabytes: null,
		},
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

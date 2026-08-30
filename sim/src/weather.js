// La météo, côté client (PHASE 04).
//
// Elle n'est PAS un réglage : il n'y a ni slider, ni preset, ni valeur
// persistée dans localStorage. Le monde décide, on lit. Ce fichier ne fait que
// deux choses : demander au serveur le snapshot d'une zone, et le traduire en
// paramètres pour wind.js / rain.js / fog.js, qui ne changent pas.
//
// Le modèle lui-même vit dans ../tools/lib/weather.mjs, importable des deux
// côtés — c'est ce qui permet au repli hors ligne d'être exactement la même
// génération que celle du serveur, et donc de rester cohérent.

import * as model from '../tools/lib/weather.mjs';
import { getOperator } from './operator.js';

export const {
	toSimParams, formatForecast, headline, today, dayRows,
	confidenceBar, windLabel, compass, formatVisibility, zoneKey, dayKey,
	conditionsBlock, conditionsLine, severity,
} = model;

// Mémoire de l'onglet : rejouer LOCAL TERRAIN ne doit pas retaper le serveur
// une fois par ligne. Le serveur a son propre cache (le world state), celui-ci
// évite simplement l'aller-retour.
const cache = new Map();

// Le repli quand il n'y a pas de serveur de dev du tout (build statique) ou
// qu'il ne répond pas. Déterministe sur (zone, jour), donc deux appels
// rapprochés donnent le même temps — la même promesse que côté serveur.
function offlineSnapshot(lat, lon) {
	const day = model.dayKey();
	return model.makeSnapshot({
		lat, lon, day, source: 'procedural',
		days: model.proceduralForecast({ lat, lon, day }),
	});
}

// Rend toujours un snapshot : la météo est du décor, elle n'a pas le droit
// d'empêcher un vol de démarrer.
export async function worldWeather({ lat, lon }) {
	if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
	const key = model.zoneKey(lat, lon);
	const day = model.dayKey();
	const hit = cache.get(key);
	if (hit && hit.day === day) return hit;

	let snapshot = null;
	const op = getOperator();
	if (op) {
		try {
			const r = await fetch(`/__operator/${op.id}/weather?lat=${lat}&lon=${lon}`);
			if (r.ok) snapshot = (await r.json()).snapshot;
		} catch { /* hors ligne : on tombe sur le procédural */ }
	}
	if (!snapshot?.days?.length) snapshot = offlineSnapshot(lat, lon);
	cache.set(key, snapshot);
	return snapshot;
}

// Écrit les paramètres du jour dans les quatre modèles. Aucun d'eux n'est
// réimplémenté ici : on ne fait que poser leurs entrées.
export function applyWeather(snapshot, { physics, rain, fog, cloud, sun } = {}) {
	const d = model.today(snapshot);
	if (!d) return null;
	const p = model.toSimParams(d);
	physics?.setWeather(p.wind);
	rain?.setParams(p.rain);
	fog?.setParams(p.fog);
	cloud?.setParams(p.cloud);
	sun?.setWeather(p.sun);
	return p;
}

// Le monde neutre : ce que tools/selftest.mjs suppose, et ce sur quoi on se
// rabat quand la zone n'a pas de coordonnées connues.
export const CALM = {
	wind: { speed: 0, direction: 0, gust: 0, turbulence: 0.5 },
	rain: { intensity: 0, variability: 0.5 },
	fog: { intensity: 0, variability: 0.5 },
	cloud: { cover: 0, variability: 0.5 },
	// Ciel dégagé, air clair : le soleil n'est pas neutralisé pour autant, il
	// est simplement au-dessus d'une zone sans météo connue.
	sun: { cloudPct: 0, visibilityM: 25000 },
};

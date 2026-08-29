// Acquisition et cache de la météo du monde (PHASE 04), côté serveur.
//
// Le modèle (tools/lib/weather.mjs) ne sait rien du réseau ni du disque ; ce
// fichier est la seule chose qui appelle Open-Meteo, et il est appelé par
// tools/map-api-plugin.mjs. Aucune clé, aucun secret : l'API est publique et
// l'URL ne contient que lat/lon.
//
// L'ordre de résolution est ce qui fait tenir le critère d'acceptation « deux
// acquisitions rapprochées sur Tokyo donnent la même météo » :
//
//   1. le snapshot du jour déjà en world state — on le relit, on ne retire pas ;
//   2. sinon Open-Meteo ;
//   3. sinon le dernier snapshot connu, re-daté et annoncé comme périmé ;
//   4. sinon la génération procédurale, déterministe sur (zone, jour).

import {
	openMeteoUrl, fromOpenMeteo, makeSnapshot, proceduralForecast,
	restale, zoneKey, dayKey, FORECAST_DAYS,
} from './lib/weather.mjs';

// Court : la météo n'a pas le droit de faire attendre l'écran de terrain. Au
// pire on part sur le repli, qui est bon.
const TIMEOUT_MS = 6000;
// Un snapshot du jour n'est jamais re-téléchargé, mais un repli l'est : on
// laisse une chance au réseau de revenir sans pour autant marteler l'API.
const RETRY_FALLBACK_MS = 15 * 60 * 1000;
// Une installation locale n'a pas vocation à collectionner les zones. Au-delà,
// on évince les plus anciennes — le world state est un fichier JSON qu'on
// réécrit en entier à chaque PATCH.
const MAX_ZONES = 64;

export async function fetchOpenMeteo(lat, lon, { fetchImpl, timeoutMs = TIMEOUT_MS, days = FORECAST_DAYS } = {}) {
	const f = fetchImpl ?? globalThis.fetch;
	if (typeof f !== 'function') throw new Error('fetch indisponible');
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await f(openMeteoUrl(lat, lon, days), { signal: ctrl.signal });
		if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
		return fromOpenMeteo(await res.json(), { days });
	} finally {
		clearTimeout(timer);
	}
}

function evict(weather) {
	const keys = Object.keys(weather);
	if (keys.length <= MAX_ZONES) return weather;
	keys.sort((a, b) => String(weather[a].fetchedAt).localeCompare(String(weather[b].fetchedAt)));
	for (const k of keys.slice(0, keys.length - MAX_ZONES)) delete weather[k];
	return weather;
}

// Rend { snapshot, changed }. `changed` dit à l'appelant s'il faut réécrire
// l'état opérateur — un jour déjà connu ne provoque aucune écriture disque.
export async function resolveWeather(worldState, { lat, lon, day = dayKey(), now = Date.now(), fetchImpl, onWarn } = {}) {
	const key = zoneKey(lat, lon);
	const weather = worldState.weather ?? (worldState.weather = {});
	const cached = weather[key] ?? null;

	// 1. Déjà connu pour ce jour. Un repli vieux de plus d'un quart d'heure
	//    laisse retenter le réseau ; un vrai relevé, jamais.
	if (cached && cached.day === day) {
		const stale = cached.source !== 'open-meteo'
			&& now - Date.parse(cached.fetchedAt ?? 0) > RETRY_FALLBACK_MS;
		if (!stale) return { snapshot: cached, changed: false };
	}

	// 2. Open-Meteo.
	try {
		const days = await fetchOpenMeteo(lat, lon, { fetchImpl });
		// L'API date ses jours dans le fuseau de la zone : c'est SA date du jour
		// qui fait foi, pas l'horloge du serveur.
		const snapshot = makeSnapshot({ lat, lon, day: days[0]?.date ?? day, source: 'open-meteo', days });
		weather[key] = snapshot;
		evict(weather);
		return { snapshot, changed: true };
	} catch (e) {
		onWarn?.(e);
	}

	// 3. Le dernier snapshot connu, re-daté honnêtement.
	if (cached) {
		const kept = restale(cached, day);
		if (kept) {
			weather[key] = kept;
			return { snapshot: kept, changed: kept !== cached };
		}
	}

	// 4. Procédural. Déterministe sur (zone, jour) : le relancer ne rejoue rien.
	const snapshot = makeSnapshot({
		lat, lon, day, source: 'procedural',
		days: proceduralForecast({ lat, lon, day }),
	});
	weather[key] = snapshot;
	evict(weather);
	return { snapshot, changed: true };
}

export { MAX_ZONES, RETRY_FALLBACK_MS };

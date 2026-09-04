// Modèle météo du monde persistant (PHASE 04).
//
// Aucune E/S, aucun DOM, aucun `node:` — le fichier est importable tel quel par
// le navigateur (src/weather.js) et par Node (le plugin de dev, le selftest),
// même règle que ./tiles.mjs.
//
// Ce module NE réimplémente pas le vent, la pluie ni le brouillard : il produit
// un *bulletin* par zone et par jour, puis le traduit en paramètres pour
// src/wind.js, src/rain.js et src/fog.js, qui restent la couche de rendu. Les
// constantes physiques (MAX_RATE, la portée d'air clair, la visibilité sous la
// pluie) sont importées de ces modèles plutôt que recopiées ici.

import { mulberry32, compassPoint } from '../../src/wind.js';
import { MAX_RATE, rainVisibility } from '../../src/rain.js';
import { rangeFor, intensityForRange, RANGE_MIN } from '../../src/fog.js';

export const FORECAST_DAYS = 7;

// Précision de la clé de zone : 0,01° ≈ 1,1 km. Deux acquisitions dessinées à
// la main sur le même quartier doivent tomber sur la même météo ; deux villes
// distinctes ne doivent jamais partager la sienne.
export const ZONE_PRECISION = 2;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v) => clamp(v, 0, 1);

export function zoneKey(lat, lon) {
	if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('zone invalide');
	const la = lat.toFixed(ZONE_PRECISION);
	// -0.00 et 0.00 sont la même zone.
	const lo = (((lon + 180) % 360 + 360) % 360 - 180).toFixed(ZONE_PRECISION);
	return `${Number(la).toFixed(ZONE_PRECISION)},${Number(lo).toFixed(ZONE_PRECISION)}`;
}

// Jour civil *local*, pas UTC : le joueur change de jour quand son horloge le
// dit, et c'est aussi la convention d'Open-Meteo avec timezone=auto.
export function dayKey(date = new Date()) {
	const d = date instanceof Date ? date : new Date(date);
	const p = (n) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Numéro de jour absolu, pour que la prévision soit ancrée sur le calendrier et
// non sur le moment où on la demande : le « +1 » d'aujourd'hui et le « TODAY »
// de demain sont tirés du même nombre, donc identiques.
export function dayIndex(day) {
	const [y, m, d] = String(day).split('-').map(Number);
	return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

export function dayAfter(day, n) {
	const [y, m, d] = String(day).split('-').map(Number);
	const t = new Date(Date.UTC(y, m - 1, d + n));
	const p = (v) => String(v).padStart(2, '0');
	return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`;
}

// FNV-1a 32 bits. Une fonction de hachage, pas un générateur : c'est mulberry32
// (src/wind.js) qui fait la suite, pour n'avoir qu'un seul PRNG dans le projet.
export function hash32(str) {
	let h = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

const hash01 = (str) => mulberry32(hash32(str))();

// ---------------------------------------------------------------------------
// Régimes
//
// Les libellés sont ceux affichés au joueur, donc en anglais (D5). L'ordre du
// tableau n'a aucune valeur : la séquence d'une zone sort de la génération, pas
// d'un cycle fixe — c'est exactement ce que la Bible §5 demande.

export const REGIMES = [
	'CLEAR', 'CLOUD', 'OVERCAST', 'MIST', 'FOG',
	'LIGHT RAIN', 'RAIN', 'HEAVY RAIN', 'WINDY', 'GALE', 'STORM',
];

// Seuils. Le vent est en m/s à 10 m, la visibilité en mètres, la pluie en mm/h
// (le débit instantané moyen de la journée, pas le cumul).
const WIND_BREEZY = 6, WIND_STRONG = 9, WIND_GALE = 17;
const GUST_GALE = 25;
const VIS_FOG = 1000, VIS_MIST = 5000;
// Classes de la Met Office : bruine sous 0,2 mm/h, pluie modérée à partir de
// 2, forte à partir de 10. Ce sont les seuils publiés, pas des chiffres ronds
// choisis pour bien tomber sur les régimes.
const RATE_LIGHT = 0.2, RATE_RAIN = 2.0, RATE_HEAVY = 10;
const CLOUD_OVERCAST = 85, CLOUD_CLOUDY = 40;

export function classify({ windSpeed = 0, windGust = 0, rateMmH = 0, visibilityM = Infinity, cloudPct = 0 }) {
	if (windSpeed >= WIND_GALE || windGust >= GUST_GALE) return rateMmH >= RATE_RAIN ? 'STORM' : 'GALE';
	if (visibilityM < VIS_FOG && rateMmH < RATE_RAIN) return 'FOG';
	if (rateMmH >= RATE_HEAVY) return 'HEAVY RAIN';
	if (rateMmH >= RATE_RAIN) return 'RAIN';
	if (rateMmH >= RATE_LIGHT) return 'LIGHT RAIN';
	if (visibilityM < VIS_MIST) return 'MIST';
	if (windSpeed >= WIND_STRONG) return 'WINDY';
	if (cloudPct >= CLOUD_OVERCAST) return 'OVERCAST';
	if (cloudPct >= CLOUD_CLOUDY) return 'CLOUD';
	return 'CLEAR';
}

export function windLabel(speed) {
	if (speed < 1) return 'CALM';
	if (speed < WIND_BREEZY) return 'LOW WIND';
	if (speed < WIND_STRONG) return 'MODERATE WIND';
	if (speed < WIND_GALE) return 'STRONG WIND';
	return 'GALE WIND';
}

// La rose des vents vit dans wind.js : une seule table, pas deux qui pourraient
// diverger.
export { compassPoint as compass };

// ---------------------------------------------------------------------------
// Garde-fous
//
// Une API publique et un générateur produisent tous les deux des combinaisons
// qu'on ne peut pas voler ou qui n'existent pas dans l'atmosphère. On corrige
// ici, une seule fois, avant que quoi que ce soit ne les classe ou ne les
// envoie aux modèles.

// Au-delà de 8 m/s, le brassage mécanique décolle le brouillard en stratus :
// « purée de pois + tempête » est une combinaison que le générateur peut sortir
// et que l'atmosphère ne produit pas.
const FOG_WIND_LIMIT = 8;
const FOG_WIND_FLOOR = 1500;
// Facteur de rafale : sous 1 elle n'est pas une rafale, au-delà de 3 c'est une
// erreur de saisie. Les valeurs mesurées vivent entre 1,2 et 2,5 en plaine.
const GUST_MIN = 1.0, GUST_MAX = 3.0;

export function sanitize(day) {
	const d = { ...day };

	d.windSpeed = clamp(Number(d.windSpeed) || 0, 0, 40);
	d.windGust = clamp(Number(d.windGust) || 0, 0, 60);
	d.windDir = ((Math.round(Number(d.windDir) || 0) % 360) + 360) % 360;
	d.rateMmH = clamp(Number(d.rateMmH) || 0, 0, 60);
	d.precipMm = clamp(Number(d.precipMm) || 0, 0, 400);
	d.cloudPct = clamp(Number(d.cloudPct) || 0, 0, 100);
	d.visibilityM = Number.isFinite(d.visibilityM) ? clamp(d.visibilityM, 30, 60000) : 60000;

	// Une rafale est plus forte que le vent moyen, et pas trois fois plus.
	d.windGust = clamp(d.windGust, d.windSpeed * GUST_MIN, d.windSpeed * GUST_MAX);

	// Le vent chasse le brouillard — sauf celui que la pluie fabrique, qui est
	// de l'eau en suspension et pas une inversion.
	if (d.windSpeed >= FOG_WIND_LIMIT && d.rateMmH < RATE_LIGHT) {
		d.visibilityM = Math.max(d.visibilityM, FOG_WIND_FLOOR);
	}
	// Il ne pleut pas sous un ciel bleu.
	if (d.rateMmH >= RATE_LIGHT) d.cloudPct = Math.max(d.cloudPct, 70);
	// La pluie a sa propre extinction : la visibilité ne peut pas être meilleure
	// que ce que le débit impose (rain.js est la source de cette relation).
	if (d.rateMmH > 0) d.visibilityM = Math.min(d.visibilityM, rainVisibility(d.rateMmH));
	// Et un ciel bouché n'est pas dégagé.
	if (d.visibilityM < VIS_FOG) d.cloudPct = Math.max(d.cloudPct, 60);

	d.regime = classify(d);
	return d;
}

// ---------------------------------------------------------------------------
// Génération procédurale
//
// Le repli hors ligne, et la seule source dans un build sans serveur de dev.
// Deux exigences qui se contredisent en apparence :
//
//   - la météo évolue de jour en jour, sans sauter au hasard ;
//   - le « +1 » d'aujourd'hui doit être le « TODAY » de demain.
//
// D'où un bruit de valeur indexé sur le jour absolu et lissé sur ses voisins :
// chaque jour est calculable seul, mais dépend de ses deux voisins, donc la
// série est continue et la prévision ne se contredit jamais le lendemain.

function channel(zone, d, name) { return hash01(`${zone}|${d}|${name}`); }

function smooth(zone, d, name) {
	return 0.25 * channel(zone, d - 1, name)
		+ 0.5 * channel(zone, d, name)
		+ 0.25 * channel(zone, d + 1, name);
}

// Le lissage transforme trois uniformes en une variable quasi normale de moyenne
// 0,5 et d'écart-type sqrt(0.375/12) = 0,1768. La ré-étaler avec une droite et
// un clamp — le réflexe — collerait 7 % des jours sur la borne, ce qui donnait
// une tempête par semaine à Tokyo. On repasse donc par la fonction de
// répartition normale, qui rend une VRAIE uniforme sur (0,1) : les lois de
// vent, de pluie et de brouillard peuvent alors être calibrées sur leurs
// fréquences réelles, ce qui est le seul moyen que « rare » veuille dire rare.
const SMOOTH_SD = Math.sqrt(0.375 / 12);

// Abramowitz & Stegun 7.1.26, erreur < 1,5e-7. Suffisant : on s'en sert pour
// tirer une météo, pas pour un calcul de structure.
function erf(x) {
	const sign = x < 0 ? -1 : 1;
	const t = 1 / (1 + 0.3275911 * Math.abs(x));
	const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
		- 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
	return sign * y;
}

function uniform(zone, d, name) {
	const v = (smooth(zone, d, name) - 0.5) / SMOOTH_SD;
	return clamp(0.5 * (1 + erf(v / Math.SQRT2)), 1e-4, 1 - 1e-4);
}

// Climatologie de la zone : ce qui ne change pas d'un jour à l'autre. C'est
// elle qui fait qu'une zone n'a pas la même séquence qu'une autre — Tokyo et
// Reims ne tirent pas dans la même distribution, pas seulement dans le même
// désordre.
export function climate(lat, lon) {
	const z = zoneKey(lat, lon);
	const polar = clamp01(Math.abs(lat) / 60);
	return {
		zone: z,
		windiness: clamp01(0.25 + 0.45 * hash01(`${z}|clim-wind`) + 0.30 * polar),
		wetness: clamp01(0.20 + 0.60 * hash01(`${z}|clim-wet`)),
		fogginess: clamp01(0.15 + 0.65 * hash01(`${z}|clim-fog`)),
		baseDir: hash01(`${z}|clim-dir`) * 360,
	};
}

// Vent : Weibull de forme 2 (Rayleigh), qui est la loi que suivent réellement
// les vitesses de vent. L'échelle A porte le climat de la zone. Avec A = 6,5 :
// médiane 5,4 m/s, 90e centile 9,9, et 17 m/s (coup de vent) une fois sur mille.
const WEIBULL_A = [3.5, 9.0];
// Il pleut environ un jour sur trois sous un climat tempéré, et le brouillard
// est un phénomène rare même là où il est fréquent.
const RAIN_DAYS = [0.15, 0.50];
const FOG_DAYS = [0.02, 0.18];

const lerp = (r, t) => r[0] + (r[1] - r[0]) * t;

export function proceduralDay(lat, lon, day) {
	const c = climate(lat, lon);
	const d = dayIndex(day);
	const z = c.zone;

	// --- vent
	const A = lerp(WEIBULL_A, c.windiness);
	const windSpeed = A * Math.sqrt(-Math.log(1 - uniform(z, d, 'wind')));
	// Facteur de rafale : 1,3 à 2,2, et d'autant plus faible que le vent est
	// fort — c'est la rafale qui rattrape la moyenne, pas l'inverse.
	const gustFactor = 1.25 + 0.85 * uniform(z, d, 'gust') * (1 - 0.35 * clamp01(windSpeed / 15));

	// --- pluie
	const rainThreshold = 1 - lerp(RAIN_DAYS, c.wetness);
	const uRain = uniform(z, d, 'moist');
	const q = uRain > rainThreshold ? (uRain - rainThreshold) / (1 - rainThreshold) : 0;
	// Cumul exponentiel : beaucoup de journées à 2 mm, quelques-unes à 30.
	const precipMm = q > 0 ? 12 * (0.5 + c.wetness) * -Math.log(1 - 0.98 * q) : 0;
	// Étalé sur combien d'heures — c'est CE nombre qui fait la différence entre
	// une averse et un crachin, et rain.js raisonne en mm/h, pas en mm/jour.
	const precipHours = precipMm > 0 ? 0.5 + 14 * uniform(z, d, 'spread') : 0;
	const rateMmH = precipHours > 0 ? precipMm / precipHours : 0;

	// --- brouillard
	const fogThreshold = 1 - lerp(FOG_DAYS, c.fogginess);
	const uFog = uniform(z, d, 'fog');
	const fogAmount = uFog > fogThreshold ? (uFog - fogThreshold) / (1 - fogThreshold) : 0;
	const visibilityM = fogAmount > 0 ? 25000 * Math.pow(0.004, fogAmount) : 25000;

	// --- couverture
	const cloudPct = 100 * clamp01(0.10 + 0.90 * uniform(z, d, 'cloud') + 0.35 * q + 0.20 * (c.wetness - 0.5));

	return sanitize({
		date: day,
		windSpeed,
		windGust: windSpeed * gustFactor,
		windDir: (c.baseDir + (uniform(z, d, 'dir') - 0.5) * 200 + 360) % 360,
		precipMm,
		rateMmH,
		visibilityM,
		cloudPct,
	});
}

export function proceduralForecast({ lat, lon, day = dayKey(), days = FORECAST_DAYS }) {
	return Array.from({ length: days }, (_, i) => proceduralDay(lat, lon, dayAfter(day, i)));
}

// ---------------------------------------------------------------------------
// Open-Meteo
//
// Pas de clé, pas de secret : l'URL est publique et se construit ici pour que
// le selftest puisse la vérifier sans réseau.

export const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';

export function openMeteoUrl(lat, lon, days = FORECAST_DAYS) {
	const q = new URLSearchParams({
		latitude: lat.toFixed(4),
		longitude: lon.toFixed(4),
		daily: [
			'weather_code', 'precipitation_sum', 'precipitation_hours',
			'wind_speed_10m_max', 'wind_gusts_10m_max', 'wind_direction_10m_dominant',
		].join(','),
		hourly: 'visibility,cloud_cover',
		wind_speed_unit: 'ms',
		timezone: 'auto',
		forecast_days: String(days),
	});
	return `${OPEN_METEO_URL}?${q}`;
}

// Moyenne des heures d'un jour donné, en ignorant les trous. `null` si la série
// est absente : Open-Meteo ne sert pas `visibility` pour tous les modèles, et
// une valeur inventée serait pire qu'une valeur dérivée du code météo.
function dailyMean(hourly, key, dayStr) {
	const times = hourly?.time;
	const vals = hourly?.[key];
	if (!Array.isArray(times) || !Array.isArray(vals)) return null;
	let sum = 0, n = 0;
	for (let i = 0; i < times.length; i++) {
		if (!String(times[i]).startsWith(dayStr)) continue;
		const v = vals[i];
		if (Number.isFinite(v)) { sum += v; n++; }
	}
	return n > 0 ? sum / n : null;
}

// Codes WMO → ce qu'ils impliquent quand la série horaire manque. On ne s'en
// sert que pour combler, jamais pour écraser une mesure.
const WMO_FOG = new Set([45, 48]);
const WMO_CLEAR = new Set([0, 1]);
const WMO_OVERCAST = new Set([3, 45, 48]);

export function fromOpenMeteo(payload, { days = FORECAST_DAYS } = {}) {
	const d = payload?.daily;
	if (!d || !Array.isArray(d.time) || d.time.length === 0) throw new Error('réponse Open-Meteo inexploitable');
	const n = Math.min(days, d.time.length);
	const out = [];
	for (let i = 0; i < n; i++) {
		const date = d.time[i];
		const code = Number(d.weather_code?.[i] ?? 0);
		const precipMm = Number(d.precipitation_sum?.[i] ?? 0) || 0;
		const hours = Number(d.precipitation_hours?.[i] ?? 0) || 0;
		const rateMmH = precipMm > 0 ? precipMm / Math.max(1, hours) : 0;

		let visibilityM = dailyMean(payload.hourly, 'visibility', date);
		if (visibilityM === null) {
			// Repli : le code météo dit s'il y a du brouillard, la pluie fait le
			// reste via sanitize().
			visibilityM = WMO_FOG.has(code) ? 400 : WMO_CLEAR.has(code) ? 30000 : 15000;
		}
		let cloudPct = dailyMean(payload.hourly, 'cloud_cover', date);
		if (cloudPct === null) cloudPct = WMO_CLEAR.has(code) ? 15 : WMO_OVERCAST.has(code) ? 95 : 60;

		out.push(sanitize({
			date,
			windSpeed: Number(d.wind_speed_10m_max?.[i] ?? 0) || 0,
			windGust: Number(d.wind_gusts_10m_max?.[i] ?? 0) || 0,
			windDir: Number(d.wind_direction_10m_dominant?.[i] ?? 0) || 0,
			precipMm,
			rateMmH,
			visibilityM,
			cloudPct,
		}));
	}
	return out;
}

// ---------------------------------------------------------------------------
// Snapshot

export const SOURCES = ['open-meteo', 'stale', 'procedural'];

// La confiance décroît avec l'échéance, et part de plus bas quand le bulletin
// n'est pas mesuré : une prévision inventée ne doit pas s'annoncer aussi sûre
// qu'un relevé.
const CONFIDENCE_BASE = { 'open-meteo': 0.96, stale: 0.72, procedural: 0.58 };

export function confidence(source, offset) {
	return clamp01((CONFIDENCE_BASE[source] ?? 0.5) - 0.075 * Math.max(0, offset));
}

export function makeSnapshot({ lat, lon, day = dayKey(), source, days }) {
	return {
		zone: zoneKey(lat, lon),
		lat, lon, day, source,
		fetchedAt: new Date().toISOString(),
		days: days.map((e, i) => ({ ...e, confidence: confidence(source, i) })),
	};
}

// Un snapshot périmé reste utile : c'est le repli « dernier snapshot connu ».
// On le re-date, on décale la fenêtre sur le jour courant et on abaisse la
// confiance — ce qui reste honnête, contrairement à le servir tel quel.
export function restale(snapshot, day = dayKey()) {
	const shift = dayIndex(day) - dayIndex(snapshot.day);
	if (shift <= 0) return snapshot;
	const days = snapshot.days.slice(shift);
	if (days.length === 0) return null;
	return {
		...snapshot,
		day,
		source: 'stale',
		days: days.map((e, i) => ({ ...e, confidence: confidence('stale', i) })),
	};
}

export function today(snapshot) {
	return snapshot?.days?.[0] ?? null;
}

// ---------------------------------------------------------------------------
// Traduction vers les modèles existants
//
// C'est le seul endroit où le monde parle à wind.js / rain.js / fog.js. Les
// trois modèles ne changent pas : on écrit leurs paramètres, on ne réimplémente
// rien.

// Averse ou pluie continue : la variabilité de rain.js dit « de combien ça va
// et vient ». Une averse de convection bat beaucoup, une pluie d'occlusion non.
function rainVariability(day) {
	if (day.rateMmH <= 0) return 0.5;
	// Beaucoup d'eau en peu d'heures = averses ; peu d'eau étalée = crachin.
	const burst = clamp01(day.rateMmH / 8);
	return clamp01(0.30 + 0.55 * burst);
}

export function toSimParams(day) {
	return simParamsOf(sanitize(day));
}

// La traduction seule, sur un bulletin DÉJÀ passé par sanitize().
//
// Séparée de toSimParams() pour le banc (PHASE 26) : sanitize() n'est pas
// qu'un clamp, c'est un jeu de règles de cohérence physique — le vent chasse
// le brouillard, il ne pleut pas sous un ciel bleu. Ces règles sont justes
// pour un bulletin, et fausses pour un banc, où l'opérateur a le droit de
// demander une averse sous un ciel dégagé et de la voir arriver.
//
// Le banc appelle donc simParamsOf() directement, avec ses propres bornes.
// Ce qu'il PARTAGE est la traduction elle-même : à 12 m/s le banc et le monde
// écrivent exactement les mêmes paramètres dans wind.js/rain.js/fog.js, donc
// ils volent pareil. C'est tout l'intérêt de ne pas s'en fabriquer une
// deuxième.
export function simParamsOf(d) {
	// Vent. rain.js/fog.js sont en 0..1, wind.js est en unités physiques : la
	// vitesse part telle quelle, seule la rafale est convertie en « knob ».
	const speed = clamp(d.windSpeed, 0, 25);
	// wind.js pose GUST_PEAK = [0, 0.9] : le knob 1 ajoute 90 % de la moyenne
	// locale au sommet de la rafale. Le facteur de rafale se traduit donc
	// directement, sans constante inventée — c'est l'inverse exact du modèle.
	// Au-delà d'un facteur 1,9 le knob sature, et c'est une limite de wind.js
	// et non de la traduction : par vent quasi nul, un facteur de rafale de 3 est
	// courant et sature ici sans conséquence, 90 % de 1,4 m/s restant du calme.
	const gustFactor = speed > 0.5 ? d.windGust / speed : 1;
	const gust = clamp01((gustFactor - 1) / 0.9);
	// Turbulence : mécanique (le vent lui-même) plus convective (l'averse). Le
	// brouillard est au contraire le signe d'une couche stable, donc il la coupe.
	const stable = d.visibilityM < VIS_MIST ? 0.45 : 1;
	const turbulence = clamp(stable * (0.35 + 0.75 * (speed / WIND_GALE) + 0.35 * clamp01(d.rateMmH / 10)), 0, 2);

	// Pluie. rateMmH est déjà le débit instantané moyen ; MAX_RATE est ce que
	// « 1 » veut dire dans rain.js.
	const rainIntensity = clamp01(d.rateMmH / MAX_RATE);

	// Brouillard. rain.js ajoute déjà sa propre extinction par-dessus, donc on
	// ne donne à fog.js que la visibilité de l'air *hors* pluie — sinon la même
	// averse compterait deux fois.
	const airVis = d.rateMmH > 0
		? 1 / Math.max(1e-9, 1 / d.visibilityM - 1 / rainVisibility(d.rateMmH))
		: d.visibilityM;
	const fogIntensity = clamp01(intensityForRange(airVis));
	// La visibilité ne descend jamais sous RANGE_MIN dans fog.js ; la variabilité
	// d'une nappe est plus forte quand elle est mince (elle se déchire).
	const fogVariability = fogIntensity > 0 ? clamp01(0.65 - 0.35 * fogIntensity) : 0.5;

	// Nuages. cloudPct est déjà produit, déjà borné et déjà rendu cohérent avec
	// la pluie et la visibilité par sanitize() ; il n'y a rien à modéliser ici,
	// seulement à convertir en fraction.
	const cover = clamp01(d.cloudPct / 100);
	// Un ciel épars s'agite — les cumulus se forment et se dissipent à vue —
	// tandis qu'un couvercle de stratus est une couche stable qui ne bouge
	// presque plus. Même forme et même raison que fogVariability juste au-dessus.
	const cloudVariability = cover > 0 ? clamp01(0.7 - 0.45 * cover) : 0.5;

	return {
		wind: { speed, direction: d.windDir, gust, turbulence },
		rain: { intensity: rainIntensity, variability: rainVariability(d) },
		fog: { intensity: fogIntensity, variability: fogVariability },
		cloud: { cover, variability: cloudVariability },
		// Le soleil (#23) prend la couverture telle quelle, et la MÊME visibilité
		// hors pluie que fog.js : c'est l'extinction de l'air, et l'averse a déjà
		// la sienne. Lui passer la visibilité totale ferait compter deux fois la
		// même pluie — une fois dans le brouillard, une fois sur le disque.
		sun: { cloudPct: d.cloudPct, visibilityM: airVis },
	};
}

// ---------------------------------------------------------------------------
// Rendu texte (terminal)

const BAR_CELLS = 12;
export function confidenceBar(c, cells = BAR_CELLS) {
	// Plancher, pas arrondi : une barre pleine doit vouloir dire « certain », et
	// aucune prévision ne l'est.
	const on = Math.floor(clamp01(c) * cells);
	return '█'.repeat(on) + '░'.repeat(cells - on);
}

export function headline(day) {
	return `${day.regime} / ${windLabel(day.windSpeed)}`;
}

export function formatVisibility(m) {
	if (!Number.isFinite(m)) return '—';
	return m >= 10000 ? `${(m / 1000).toFixed(0)} km`
		: m >= 1000 ? `${(m / 1000).toFixed(1)} km`
		: `${Math.round(m / 10) * 10} m`;
}

export function dayRows(snapshot) {
	return snapshot.days.map((d, i) => ({
		when: i === 0 ? 'TODAY' : `+${i}`,
		date: d.date,
		headline: headline(d),
		confidence: d.confidence,
	}));
}

// Le bloc affiché par le terminal. Régime, vent, visibilité, pluie, brouillard,
// confiance — les six champs que la Bible §5 demande.
export function formatForecast(snapshot, { title = '' } = {}) {
	const t = today(snapshot);
	if (!t) return 'NO FORECAST';
	const fogRange = rangeFor(toSimParams(t).fog.intensity);
	const lines = [];
	if (title) lines.push(title.toUpperCase(), '');
	lines.push(`${snapshot.day} · ${snapshot.source.toUpperCase()}`, '');
	for (const r of dayRows(snapshot)) lines.push(`${r.when.padEnd(6)} ${r.headline}`);
	lines.push('',
		`WIND   ${t.windSpeed.toFixed(1)} m/s  G ${t.windGust.toFixed(1)}  ${compassPoint(t.windDir)}`,
		`VIS    ${formatVisibility(t.visibilityM)}`,
		`RAIN   ${t.rateMmH < 0.05 ? 'NONE' : `${t.rateMmH.toFixed(1)} mm/h`}`,
		`FOG    ${fogRange >= rangeFor(0) - 1 ? 'NONE' : formatVisibility(fogRange)}`,
		'',
		`CONFIDENCE ${confidenceBar(t.confidence)}`);
	return lines.join('\n');
}

// Les régimes où un vol devient une mauvaise idée : la Bible §14 veut que le
// pilote y pense AVANT de voler, pas en découvrant la première rafale.
const MARGINAL = new Set(['WINDY', 'GALE', 'STORM', 'HEAVY RAIN', 'RAIN', 'FOG']);

// PHASE 19 (issue #56) — de quoi graduer la ligne météo de la Home. Retour
// utilisateur du 2026-08-29 : « au lancement d'un vol on ne pense pas aux
// conditions ». La Bible §38 n'autorise une couleur fonctionnelle que si elle
// transmet une information : ici l'information est « est-ce que ça change ma
// décision de voler ». Le classement est donc celui du pilote, pas celui du
// météorologue — OVERCAST est laid mais se vole, MIST se vole mal.
//
//   nominal   rien à signaler, la ligne reste en encre neutre
//   watch     ça se pilote, mais le vent ou l'eau se sentent
//   marginal  vol dégradé : la visibilité ou le vent travaillent contre le drone
//   nogo      on ne sort pas
//
// Chaque entrée de REGIMES a la sienne, et aucun régime de MARGINAL n'est
// classé sous `marginal` : weather-selftest.mjs vérifie les deux.
const SEVERITY = {
	CLEAR: 'nominal', CLOUD: 'nominal', OVERCAST: 'nominal',
	MIST: 'watch', 'LIGHT RAIN': 'watch',
	FOG: 'marginal', RAIN: 'marginal', 'HEAVY RAIN': 'marginal', WINDY: 'marginal',
	GALE: 'nogo', STORM: 'nogo',
};

export function severity(day) {
	if (!day) return 'nominal';
	const base = SEVERITY[day.regime] ?? 'nominal';
	// Un ciel calme au-dessus d'un vent déjà soutenu reste une information : la
	// force du vent décide autant que le régime, et `classify` ne bascule sur
	// WINDY qu'à 9 m/s alors que ça se sent dès 6.
	if (base === 'nominal' && day.windSpeed >= WIND_BREEZY) return 'watch';
	return base;
}

// Le bloc CONDITIONS rendu au TARGET SCAN (issue #76). Trois lignes — vent
// (force + direction + label), pluie, visibilité — précédées d'une alerte quand
// le régime du jour est marginal. `null` si pas de snapshot : on n'invente pas
// de météo.
export function conditionsBlock(snapshot) {
	const t = today(snapshot);
	if (!t) return null;
	const lines = ['CONDITIONS', ''];
	if (MARGINAL.has(t.regime)) lines.push('>>> MARGINAL CONDITIONS', '');
	lines.push(
		`WIND         ${t.windSpeed.toFixed(1)} m/s  ${compassPoint(t.windDir)}   ${windLabel(t.windSpeed)}`,
		`RAIN         ${t.rateMmH < 0.05 ? 'NONE' : `${t.rateMmH.toFixed(1)} mm/h`}`,
		`VISIBILITY   ${formatVisibility(t.visibilityM)}`,
	);
	return lines;
}

// Le rappel d'une ligne, en pied de fiche cible : la dernière chose lue avant
// CONFIRM. `null` si pas de snapshot.
export function conditionsLine(snapshot) {
	const t = today(snapshot);
	if (!t) return null;
	const parts = [windLabel(t.windSpeed)];
	if (t.rateMmH >= 0.05) parts.push('RAIN');
	parts.push(`VIS ${formatVisibility(t.visibilityM)}`);
	return `${MARGINAL.has(t.regime) ? '>>> ' : ''}${parts.join(' · ')}`;
}

export { RANGE_MIN, MAX_RATE };

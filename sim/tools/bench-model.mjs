// Logique pure du BENCH (PHASE 26). Aucune E/S, aucun DOM, aucun localStorage :
// importable par src/bench.js côté navigateur et par le selftest.
//
// ---------------------------------------------------------------------------
// Ce qu'est le banc, et pourquoi il a le droit d'exister dans cette fiction
//
// FPVTP! est un outil de reverse engineering écrit par des hackers hardware, et
// un tel outil a toujours un banc : le montage local sur lequel on teste la
// chaîne d'interception contre une cible synthétique avant de la pointer sur
// une vraie. On ne débugge pas son stack sur une cible qu'on peut griller.
//
//   NO TARGET       il n'y a personne au bout — un modèle, pas une machine
//   NO LINK         le flux revient de ta propre installation
//   NO HACK         on ne s'introduit pas dans son propre banc
//   NO LOSS         rien de distant n'existe, donc rien ne peut être perdu
//   NOTHING LOGGED  rien ne s'est passé dans le monde, donc rien n'est écrit
//
// Les cinq lignes sont la même phrase. C'est simultanément la fiction et la
// règle technique, et c'est ce qui empêche le banc d'être une dérogation :
// « The world persists. The machine doesn't. » tient toujours, puisqu'au banc
// il n'y a ni monde ni machine — il y a un modèle.
//
// ---------------------------------------------------------------------------
// La règle de normalisation
//
// normalize() RAMÈNE, elle ne REJETTE jamais. Une valeur hors bornes est
// bornée, une valeur absurde retombe sur son défaut, une config corrompue
// redevient une config valide. Le banc est l'endroit sans frustration : il n'a
// pas le droit de refuser d'ouvrir parce qu'une clé lui déplaît.
//
// Et il n'applique PAS les règles de cohérence météo de sanitize() (le vent
// chasse le brouillard, il ne pleut pas sous un ciel bleu). Elles sont justes
// pour un bulletin et fausses pour un banc : ici, demander une averse sous un
// ciel dégagé est une demande légitime, et elle doit arriver.

import { simParamsOf } from './lib/weather.mjs';

export const BENCH_VERSION = 1;

// Les deux modes du jeu. FIELD est la boucle de la Bible ; BENCH est le banc.
export const MODES = ['field', 'bench'];

// Copie de l'écran de choix. En anglais (D5), et vérifiée par le selftest :
// c'est la première chose que voit un opérateur après son nom, et elle doit
// dire ce que chaque voie coûte, pas ce qu'elle offre.
export const MODE_SELECT = {
	title: 'SELECT OPERATION MODE',
	field: {
		label: 'FIELD',
		lines: ['acquire terrain · find a signal', 'take a machine that is not yours'],
	},
	bench: {
		label: 'BENCH',
		lines: ['your airframe · your conditions', 'nothing to lose'],
	},
};

// Les quatre lignes que le banc affiche sur lui-même, et la cinquième qui est
// la promesse d'étanchéité. Le selftest vérifie qu'elles sont toujours là :
// si un jour le banc écrit quelque chose, cette ligne devient un mensonge.
export const BENCH_CREED = ['NO TARGET', 'NO LINK', 'NO HACK', 'NO LOSS'];
export const BENCH_SEAL = 'NOTHING HERE IS LOGGED.';

export const ENTRY_MODES = ['IDLE', 'COMFORTABLE', 'ACTIVE', 'CHALLENGING', 'HOLY_SHIT'];
export const LINK_MODES = ['LOOPBACK', 'SIMULATED'];
export const BATTERY_MODES = ['REAL', 'HELD'];
export const TERRAIN_KINDS = ['cached', 'live'];

// Bornes. Larges à dessein — le banc n'est pas un bulletin, il doit pouvoir
// aller jusqu'aux extrêmes que le monde ne produirait jamais deux jours de
// suite. Les plafonds sont ceux des modèles eux-mêmes, pas des goûts :
// wind.js sature au-delà de 25 m/s, rain.js au-delà de 60 mm/h, et fog.js ne
// descend pas sous 30 m de visibilité.
export const LIMITS = {
	windSpeed:   { min: 0, max: 25,    step: 0.5 },
	gustFactor:  { min: 1, max: 3,     step: 0.1 },
	windDir:     { min: 0, max: 359,   step: 5 },
	rateMmH:     { min: 0, max: 60,    step: 0.5 },
	visibilityM: { min: 30, max: 25000, step: 100 },
	cloudPct:    { min: 0, max: 100,   step: 5 },
	timeMin:     { min: 0, max: 1439,  step: 15 },
	lat:         { min: -90, max: 90 },
	lon:         { min: -180, max: 180 },
};

export const BENCH_DEFAULTS = Object.freeze({
	version: BENCH_VERSION,
	airframe: { family: 'freestyle5', seed: null },
	terrain: { kind: 'cached', slug: null, lat: 48.8584, lon: 2.2945 },
	entry: 'IDLE',
	fence: true,
	timeMin: 14 * 60 + 30,
	weather: {
		windSpeed: 0,
		gustFactor: 1,
		windDir: 0,
		rateMmH: 0,
		visibilityM: 25000,
		cloudPct: 0,
	},
	link: 'LOOPBACK',
	battery: 'REAL',
});

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// Un nombre, ou le défaut. `Number(null)` vaut 0 et `Number('')` aussi : on
// passe par Number.isFinite APRÈS la conversion pour que null/''/undefined
// retombent tous sur le défaut plutôt que sur zéro.
function num(v, fallback, limit) {
	const n = typeof v === 'number' ? v : Number(v);
	if (v === null || v === undefined || v === '' || !Number.isFinite(n)) return fallback;
	return limit ? clamp(n, limit.min, limit.max) : n;
}

function oneOf(v, allowed, fallback) {
	return allowed.includes(v) ? v : fallback;
}

// Ramène n'importe quoi à une config jouable. Ne lève jamais.
export function normalizeBenchConfig(raw, { families = null } = {}) {
	const d = BENCH_DEFAULTS;
	const r = (raw && typeof raw === 'object') ? raw : {};
	const w = (r.weather && typeof r.weather === 'object') ? r.weather : {};
	const a = (r.airframe && typeof r.airframe === 'object') ? r.airframe : {};
	const t = (r.terrain && typeof r.terrain === 'object') ? r.terrain : {};

	// `families` est la liste réelle importée de drone-profiles.js quand
	// l'appelant l'a sous la main. Le modèle ne l'importe pas lui-même : il
	// resterait juste de savoir qu'une famille est une chaîne, et le selftest
	// pourrait alors mentir sur une famille supprimée.
	const family = families
		? oneOf(a.family, families, families.includes(d.airframe.family) ? d.airframe.family : families[0])
		: (typeof a.family === 'string' && a.family ? a.family : d.airframe.family);

	return {
		version: BENCH_VERSION,
		airframe: {
			family,
			// null = profil NOMINAL de la famille (celui du banc tune-pid).
			// Une chaîne = un exemplaire tiré, comme une vraie cible.
			seed: typeof a.seed === 'string' && a.seed ? a.seed : null,
		},
		terrain: {
			kind: oneOf(t.kind, TERRAIN_KINDS, d.terrain.kind),
			slug: typeof t.slug === 'string' && t.slug ? t.slug : null,
			lat: num(t.lat, d.terrain.lat, LIMITS.lat),
			lon: num(t.lon, d.terrain.lon, LIMITS.lon),
		},
		entry: oneOf(r.entry, ENTRY_MODES, d.entry),
		fence: typeof r.fence === 'boolean' ? r.fence : d.fence,
		timeMin: Math.round(num(r.timeMin, d.timeMin, LIMITS.timeMin)),
		weather: {
			windSpeed: num(w.windSpeed, d.weather.windSpeed, LIMITS.windSpeed),
			gustFactor: num(w.gustFactor, d.weather.gustFactor, LIMITS.gustFactor),
			windDir: Math.round(num(w.windDir, d.weather.windDir, LIMITS.windDir)),
			rateMmH: num(w.rateMmH, d.weather.rateMmH, LIMITS.rateMmH),
			visibilityM: num(w.visibilityM, d.weather.visibilityM, LIMITS.visibilityM),
			cloudPct: num(w.cloudPct, d.weather.cloudPct, LIMITS.cloudPct),
		},
		link: oneOf(r.link, LINK_MODES, d.link),
		battery: oneOf(r.battery, BATTERY_MODES, d.battery),
	};
}

// ---------------------------------------------------------------------------
// Traduction vers le reste du moteur
//
// Rien n'est réimplémenté ici. Chaque fonction produit la forme qu'un système
// existant consomme déjà, et c'est tout.

// Les paramètres de wind.js / rain.js / fog.js / cloud.js / sun.js.
//
// Passe par simParamsOf() — la MÊME traduction que le monde — mais sans le
// sanitize() qui la précède en mode FIELD. Conséquence voulue : à 12 m/s le
// banc et le monde écrivent exactement les mêmes nombres, donc ils volent
// pareil ; mais le banc peut demander de la pluie sous un ciel dégagé, et
// l'obtenir.
export function benchSimParams(config) {
	const c = normalizeBenchConfig(config);
	const w = c.weather;
	return simParamsOf({
		windSpeed: w.windSpeed,
		windGust: w.windSpeed * w.gustFactor,
		windDir: w.windDir,
		rateMmH: w.rateMmH,
		cloudPct: w.cloudPct,
		visibilityM: w.visibilityM,
	});
}

// L'argument de generateEntryState(). `IDLE` n'est pas une catégorie de la
// Bible §20 : c'est le repli au sol, celui que le générateur utilise déjà
// quand il n'a rien trouvé. Le banc le demande explicitement.
export function benchEntryRequest(config) {
	const c = normalizeBenchConfig(config);
	return c.entry === 'IDLE' ? { idle: true } : { category: c.entry };
}

// L'instant du soleil. `timeMin` est une heure locale du jour courant : le
// banc règle une heure, pas une date — on veut « 6 h du matin », pas « le 12
// mars 2003 ». Le chemin de sun.js est celui de OPTS.date, inchangé.
export function benchDate(config, now = new Date()) {
	const c = normalizeBenchConfig(config);
	const d = new Date(now.getTime());
	d.setHours(Math.floor(c.timeMin / 60), c.timeMin % 60, 0, 0);
	return d;
}

// ---------------------------------------------------------------------------
// Rendu texte de l'écran (le DOM n'en est qu'un habillage)

export function formatClock(timeMin) {
	const m = Math.round(clamp(Number(timeMin) || 0, 0, 1439));
	return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function formatVis(m) {
	return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

// Les lignes du banc, dans l'ordre d'affichage. `value` est ce qui se lit à
// droite ; `key` est ce que l'UI utilise pour savoir quoi éditer.
export function benchRows(config, { familyLabel = (f) => f } = {}) {
	const c = normalizeBenchConfig(config);
	const w = c.weather;
	return [
		{ key: 'family',  label: 'AIRFRAME', value: familyLabel(c.airframe.family) },
		{ key: 'seed',    label: 'BUILD',    value: c.airframe.seed ? `SEED ${c.airframe.seed}` : 'NOMINAL' },
		{ key: 'terrain', label: 'TERRAIN',
			value: c.terrain.kind === 'live'
				? `LIVE ${c.terrain.lat.toFixed(4)}, ${c.terrain.lon.toFixed(4)}`
				: (c.terrain.slug ? c.terrain.slug.toUpperCase() : 'NONE') },
		{ key: 'entry',   label: 'ENTRY',    value: c.entry === 'IDLE' ? 'IDLE ON GROUND' : c.entry.replace('_', ' ') },
		{ key: 'fence',   label: 'FENCE',    value: c.fence ? 'ON' : 'OFF' },
		{ key: 'time',    label: 'TIME',     value: formatClock(c.timeMin) },
		{ key: 'wind',    label: 'WIND',
			value: `${w.windSpeed.toFixed(1)} m/s  ${String(w.windDir).padStart(3, '0')}°  ×${w.gustFactor.toFixed(1)}` },
		{ key: 'rain',    label: 'RAIN',     value: `${w.rateMmH.toFixed(1)} mm/h` },
		{ key: 'fog',     label: 'FOG',      value: `VIS ${formatVis(w.visibilityM)}` },
		{ key: 'cloud',   label: 'CLOUD',    value: `${Math.round(w.cloudPct)} %` },
		{ key: 'link',    label: 'LINK',     value: c.link },
		{ key: 'battery', label: 'BATTERY',  value: c.battery },
	];
}

// Le banc ne peut pas décoller sans terrain. C'est la SEULE chose qu'il
// refuse, et il le dit plutôt que de griser un bouton sans expliquer.
export function benchBlockers(config, { scenes = [] } = {}) {
	const c = normalizeBenchConfig(config);
	const out = [];
	if (c.terrain.kind === 'cached') {
		if (!c.terrain.slug) out.push('NO LOCAL TERRAIN — ACQUIRE ONE IN FIELD, OR SWITCH TO LIVE');
		else if (scenes.length && !scenes.some((s) => s.slug === c.terrain.slug)) {
			out.push(`TERRAIN ${c.terrain.slug.toUpperCase()} IS NO LONGER ON DISK`);
		}
	}
	// Fence coupée sur une scène pré-cuite : ce n'est pas un bug, c'est la
	// vérité des données. Le terrain s'arrête au bord du rectangle acquis, et
	// ça doit se lire AVANT le vol plutôt que se découvrir dans le vide.
	if (!c.fence && c.terrain.kind === 'cached') out.push('FENCE OFF — TERRAIN ENDS AT THE EDGE OF THE ACQUIRED AREA');
	return out;
}

// ---------------------------------------------------------------------------
// Persistance : sérialisation pure. La lecture/écriture localStorage vit dans
// src/bench.js — le modèle n'a pas d'E/S.
//
// La CONFIG du banc persiste, ce qui s'y est PASSÉ non. Ce n'est pas une
// entorse à « rien n'est écrit » : reposer douze réglages à chaque lancement
// serait exactement la frustration que le banc supprime. Rien de ce qui est
// stocké ici ne dit qu'un vol a eu lieu.
export const BENCH_STORAGE_KEY = 'fpvmaps.bench';

export function serializeBenchConfig(config) {
	return JSON.stringify(normalizeBenchConfig(config));
}

export function parseBenchConfig(text, opts) {
	try {
		return normalizeBenchConfig(JSON.parse(text), opts);
	} catch {
		// Config illisible : on repart des défauts, sans rien dire. Le banc
		// n'a pas d'écran d'erreur, il a un état de départ.
		return normalizeBenchConfig(null, opts);
	}
}
